import { readAgentSettings, updateLegacyCodexPreferences } from '../runtime/settings.js';
import type { HarnessPreferences } from '../runtime/contracts.js';
import type { CodexSettings, CodexReasoningEffort } from './types.js';

export type { CodexSettings, CodexReasoningEffort } from './types.js';
export type CodexSettingsPatch = Partial<Omit<CodexSettings, 'model'>> & { model?: string | null };
export const DEFAULT_CODEX_SETTINGS: Readonly<CodexSettings> = Object.freeze({
  model: 'gpt-6.1-sol', reasoningEffort: 'ultra', serviceTier: 'priority',
});
const efforts = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const allowed = new Set(['model', 'reasoningEffort', 'serviceTier']);

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
  return toCodexSettings((await readAgentSettings(projectRoot)).harnessPreferences.codex);
}

function toCodexSettings(preferences: HarnessPreferences): CodexSettings {
  if (preferences.effort === null || preferences.speed === null || !efforts.has(preferences.effort)) {
    throw new Error('Codex compatibility settings require explicit supported effort and speed');
  }
  return {
    ...(preferences.model === null ? {} : { model: preferences.model }),
    reasoningEffort: preferences.effort as CodexReasoningEffort,
    serviceTier: preferences.speed,
  };
}

export async function updateCodexSettings(projectRoot: string, value: unknown): Promise<CodexSettings> {
  const patch = validateCodexSettingsPatch(value);
  return toCodexSettings(await updateLegacyCodexPreferences(projectRoot, patch));
}
