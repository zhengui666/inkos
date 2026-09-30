import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CodexSettings, CodexReasoningEffort } from './types.js';

export type { CodexSettings, CodexReasoningEffort } from './types.js';
export type CodexSettingsPatch = Partial<Omit<CodexSettings, 'model'>> & { model?: string | null };
export const DEFAULT_CODEX_SETTINGS: Readonly<CodexSettings> = Object.freeze({
  reasoningEffort: 'medium', serviceTier: 'default',
});
const efforts = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const allowed = new Set(['model', 'reasoningEffort', 'serviceTier']);
const pendingWrites = new Map<string, Promise<unknown>>();

export function validateCodexSettingsPatch(value: unknown): CodexSettingsPatch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Codex settings must be an object');
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !allowed.has(key))) {
    throw new Error('Only model, reasoningEffort, and serviceTier are supported Codex settings');
  }
  for (const key of ['model', 'serviceTier']) {
    const val = input[key];
    if (key === 'model' && val === null) continue;
    if (val !== undefined && (typeof val !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(val))) {
      throw new Error(`Invalid Codex ${key}`);
    }
  }
  if (input.reasoningEffort !== undefined && (typeof input.reasoningEffort !== 'string' || !efforts.has(input.reasoningEffort))) {
    throw new Error('Invalid Codex reasoning effort');
  }
  return input as CodexSettingsPatch;
}

export async function readCodexSettings(projectRoot: string): Promise<CodexSettings> {
  try {
    const raw: unknown = JSON.parse(await readFile(join(projectRoot, '.inkos', 'codex-config.json'), 'utf8'));
    const patch = validateCodexSettingsPatch(raw);
    return mergeSettings({ ...DEFAULT_CODEX_SETTINGS }, patch);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...DEFAULT_CODEX_SETTINGS };
    throw new Error('Cannot read Codex settings: expected a valid .inkos/codex-config.json', { cause: error });
  }
}

function mergeSettings(current: CodexSettings, patch: CodexSettingsPatch): CodexSettings {
  const result = { ...current };
  if (patch.model === null) delete result.model;
  else if (patch.model !== undefined) result.model = patch.model;
  if (patch.reasoningEffort !== undefined) result.reasoningEffort = patch.reasoningEffort;
  if (patch.serviceTier !== undefined) result.serviceTier = patch.serviceTier;
  return result;
}

export async function updateCodexSettings(projectRoot: string, value: unknown): Promise<CodexSettings> {
  const patch = validateCodexSettingsPatch(value);
  const root = resolve(projectRoot);
  const previous = pendingWrites.get(root) ?? Promise.resolve();
  // Serialize in-process read/modify/write operations and retain a valid file on interruption.
  const next = previous.catch(() => undefined).then(async () => {
    const settings = mergeSettings(await readCodexSettings(root), patch);
    const dir = join(root, '.inkos');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const temp = join(dir, `codex-config.${randomUUID()}.tmp`);
    try {
      await writeFile(temp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      await rename(temp, join(dir, 'codex-config.json'));
      return settings;
    } finally {
      await rm(temp, { force: true });
    }
  });
  pendingWrites.set(root, next);
  try { return await next; }
  finally { if (pendingWrites.get(root) === next) pendingWrites.delete(root); }
}
