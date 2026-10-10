import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { withBookLockGuard } from '../state/book-lock-guard.js';
import {
  AgentSettingsSchema, HarnessPreferencesSchema, RuntimeIdSchema, RuntimeRevisionSchema,
  type AgentSettings, type HarnessCapabilityCatalog, type HarnessId, type HarnessPreferences,
} from './contracts.js';
import { validateHarnessPreferences } from './capabilities.js';

export const AGENT_CONFIG_FILE = 'agent-config.json';
const LEGACY_CODEX_CONFIG_FILE = 'codex-config.json';
const LegacyEffortSchema = z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const LegacyCodexPatchSchema = z.object({
  model: RuntimeIdSchema.nullable().optional(),
  reasoningEffort: LegacyEffortSchema.optional(),
  serviceTier: RuntimeIdSchema.optional(),
}).strict();

export const DEFAULT_AGENT_SETTINGS: Readonly<AgentSettings> = Object.freeze({
  schemaVersion: 1,
  revision: 0,
  selectedHarnessId: 'codex',
  modelConnectionRef: null,
  harnessPreferences: Object.freeze({
    codex: Object.freeze({ model: 'gpt-6.1-sol', effort: 'ultra', speed: 'priority' }),
    pi: Object.freeze({ model: null, effort: null, speed: null }),
  }),
});

const PreferencesPatchSchema = HarnessPreferencesSchema.partial();
export const AgentSettingsPatchSchema = z.object({
  selectedHarnessId: AgentSettingsSchema.shape.selectedHarnessId.optional(),
  modelConnectionRef: AgentSettingsSchema.shape.modelConnectionRef.optional(),
  harnessPreferences: z.object({
    codex: PreferencesPatchSchema.optional(),
    pi: PreferencesPatchSchema.optional(),
  }).strict().optional(),
}).strict();
export type AgentSettingsPatch = z.infer<typeof AgentSettingsPatchSchema>;
export interface UpdateAgentSettingsOptions {
  expectedRevision: number;
  catalogs?: Partial<Record<HarnessId, HarnessCapabilityCatalog>>;
}

export class AgentSettingsConflictError extends Error {
  readonly code = 'AGENT_SETTINGS_REVISION_CONFLICT';
  constructor(readonly expectedRevision: number, readonly actualRevision: number) {
    super(`Agent settings revision conflict: expected ${expectedRevision}, found ${actualRevision}`);
  }
}

export function parseAgentSettings(value: unknown): AgentSettings {
  if (value && typeof value === 'object' && 'schemaVersion' in value && value.schemaVersion !== 1) {
    throw new Error('Unsupported agent settings schema version');
  }
  return AgentSettingsSchema.parse(value);
}

function readOptional(path: string): string | undefined {
  try { return readFileSync(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function readSnapshot(projectRoot: string): AgentSettings {
  const directory = join(projectRoot, '.inkos');
  let raw: string | undefined;
  try { raw = readOptional(join(directory, AGENT_CONFIG_FILE)); }
  catch (error) { throw new Error('Cannot read agent settings', { cause: error }); }
  if (raw !== undefined) {
    // A present but invalid new file must never fall back to legacy settings.
    try { return parseAgentSettings(JSON.parse(raw)); }
    catch (error) { throw new Error('Cannot read agent settings: expected a valid supported .inkos/agent-config.json', { cause: error }); }
  }
  const settings = AgentSettingsSchema.parse(DEFAULT_AGENT_SETTINGS);
  try {
    const legacy = readOptional(join(directory, LEGACY_CODEX_CONFIG_FILE));
    if (legacy === undefined) return settings;
    const patch = LegacyCodexPatchSchema.parse(JSON.parse(legacy));
    settings.harnessPreferences.codex = mergeLegacyPreferences(settings.harnessPreferences.codex, patch);
    return settings;
  } catch (error) {
    throw new Error('Cannot read Codex settings: expected a valid .inkos/codex-config.json', { cause: error });
  }
}

/** Reads only agent-config.json, or maps codex-config.json if the new file is absent. Never writes. */
export async function readAgentSettings(projectRoot: string): Promise<AgentSettings> {
  return readSnapshot(projectRoot);
}

function mergeLegacyPreferences(current: HarnessPreferences, patch: z.infer<typeof LegacyCodexPatchSchema>): HarnessPreferences {
  return {
    model: patch.model === undefined ? current.model : patch.model,
    effort: patch.reasoningEffort ?? current.effort,
    speed: patch.serviceTier ?? current.speed,
  };
}

function mergePreferences(current: HarnessPreferences, patch: z.infer<typeof PreferencesPatchSchema> = {}): HarnessPreferences {
  return {
    model: patch.model === undefined ? current.model : patch.model,
    effort: patch.effort === undefined ? current.effort : patch.effort,
    speed: patch.speed === undefined ? current.speed : patch.speed,
  };
}

function commitSettings(projectRoot: string, expectedRevision: number | undefined, transform: (current: AgentSettings) => AgentSettings): AgentSettings {
  const directory = join(projectRoot, '.inkos');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const canonical = realpathSync(directory);
  // Reuse the existing SQLite file guard. The callback is short and fully synchronous;
  // the kernel releases the mutex on process exit, without PID/stale-lock guesses.
  return withBookLockGuard(join(canonical, AGENT_CONFIG_FILE), () => {
    const current = readSnapshot(projectRoot);
    if (expectedRevision !== undefined && expectedRevision !== current.revision) {
      throw new AgentSettingsConflictError(expectedRevision, current.revision);
    }
    const next = parseAgentSettings({ ...transform(current), revision: current.revision + 1 });
    const temporary = join(canonical, `agent-config.${randomUUID()}.tmp`);
    try {
      const file = openSync(temporary, 'wx', 0o600);
      try { writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`); fsyncSync(file); }
      finally { closeSync(file); }
      // Readers see the complete previous or next JSON, including both configuration sections.
      renameSync(temporary, join(canonical, AGENT_CONFIG_FILE));
      if (process.platform !== 'win32') {
        const dir = openSync(canonical, 'r');
        try { fsyncSync(dir); } finally { closeSync(dir); }
      }
      return next;
    } finally { rmSync(temporary, { force: true }); }
  });
}

/** CAS save. Explicit overrides must be checked against that harness's observed catalog.
 * A harness change clears the connection. Bind the target owner's reference in a later
 * save; a config patch cannot prove authentication ownership across harnesses.
 */
export async function updateAgentSettings(projectRoot: string, value: unknown, options: UpdateAgentSettingsOptions): Promise<AgentSettings> {
  const patch = AgentSettingsPatchSchema.parse(value);
  const expectedRevision = RuntimeRevisionSchema.parse(options.expectedRevision);
  return commitSettings(projectRoot, expectedRevision, current => {
    const selectedHarnessId = patch.selectedHarnessId ?? current.selectedHarnessId;
    const harnessChanged = selectedHarnessId !== current.selectedHarnessId;
    if (harnessChanged && patch.modelConnectionRef !== undefined && patch.modelConnectionRef !== null) {
      throw Object.assign(new Error('Changing harness must clear modelConnectionRef; bind a connection after selecting the target harness'), {
        code: 'AGENT_SETTINGS_CONNECTION_REBIND_REQUIRED',
      });
    }
    const next: AgentSettings = {
      ...current,
      selectedHarnessId,
      modelConnectionRef: harnessChanged ? null : (patch.modelConnectionRef === undefined ? current.modelConnectionRef : patch.modelConnectionRef),
      harnessPreferences: {
        codex: mergePreferences(current.harnessPreferences.codex, patch.harnessPreferences?.codex),
        pi: mergePreferences(current.harnessPreferences.pi, patch.harnessPreferences?.pi),
      },
    };
    const touched = new Set<HarnessId>();
    for (const id of ['codex', 'pi'] as const) {
      if (patch.harnessPreferences?.[id] !== undefined) touched.add(id);
    }
    if (patch.selectedHarnessId !== undefined && patch.selectedHarnessId !== current.selectedHarnessId) touched.add(patch.selectedHarnessId);
    for (const id of touched) validateHarnessPreferences(id, next.harnessPreferences[id], options.catalogs?.[id]);
    return next;
  });
}

/** Compatibility-only path. Real legacy account callers validate Codex's live model/list first.
 * It cannot change the connection, selected harness or Pi preferences, and never writes legacy JSON.
 * Kept separate from the new catalog-validated API to avoid recursive compatibility calls.
 */
export async function updateLegacyCodexPreferences(projectRoot: string, value: unknown): Promise<HarnessPreferences> {
  const patch = LegacyCodexPatchSchema.parse(value);
  const next = commitSettings(projectRoot, undefined, current => {
    const codex = mergeLegacyPreferences(current.harnessPreferences.codex, patch);
    // The old non-nullable DTO cannot represent native effort/speed or new effort IDs.
    LegacyEffortSchema.parse(codex.effort);
    RuntimeIdSchema.parse(codex.speed);
    return { ...current, harnessPreferences: { ...current.harnessPreferences, codex } };
  });
  return next.harnessPreferences.codex;
}
