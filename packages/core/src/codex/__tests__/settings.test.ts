import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCodexSettings, updateCodexSettings, validateCodexSettingsPatch } from '../settings.js';
import { DEFAULT_AGENT_SETTINGS } from '../../runtime/settings.js';

const roots: string[] = [];
async function root() { const value = await mkdtemp(join(tmpdir(), 'inkos-settings-test-')); roots.push(value); return value; }
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
describe('Codex settings', () => {
  it('defaults without reading legacy provider files', async () => {
    const dir = await root();
    await writeFile(join(dir, '.env'), 'OPENAI_API_KEY=never-read-me');
    expect(await readCodexSettings(dir)).toEqual({ model: 'gpt-6.1-sol', reasoningEffort: 'ultra', serviceTier: 'priority' });
  });
  it('atomically saves only allowed settings and serializes patches', async () => {
    const dir = await root();
    await Promise.all([updateCodexSettings(dir, { model: 'codex-test' }), updateCodexSettings(dir, { reasoningEffort: 'high' })]);
    expect(await readCodexSettings(dir)).toEqual({ model: 'codex-test', reasoningEffort: 'high', serviceTier: 'priority' });
    await updateCodexSettings(dir, { model: null });
    expect(await readCodexSettings(dir)).not.toHaveProperty('model');
    expect(JSON.parse(await readFile(join(dir, '.inkos', 'agent-config.json'), 'utf8')).harnessPreferences.codex.model).toBeNull();
    await updateCodexSettings(dir, { reasoningEffort: 'medium', serviceTier: 'default' });
    expect(await readCodexSettings(dir)).toEqual({ reasoningEffort: 'medium', serviceTier: 'default' });
    expect(await readFile(join(dir, '.inkos', 'agent-config.json'), 'utf8')).not.toContain('apiKey');
  });
  it('keeps explicitly saved model, effort and standard speed instead of replacing them with new defaults', async () => {
    const dir = await root();
    await mkdir(join(dir, '.inkos'));
    await writeFile(join(dir, '.inkos', 'codex-config.json'), JSON.stringify({ model: 'saved-model', reasoningEffort: 'low', serviceTier: 'default' }));
    expect(await readCodexSettings(dir)).toEqual({ model: 'saved-model', reasoningEffort: 'low', serviceTier: 'default' });
  });
  it('writes only the new settings file when no legacy file exists', async () => {
    const dir = await root();
    await updateCodexSettings(dir, { model: 'saved-model', reasoningEffort: 'low', serviceTier: 'default' });
    expect(JSON.parse(await readFile(join(dir, '.inkos', 'agent-config.json'), 'utf8')).harnessPreferences.codex).toEqual({ model: 'saved-model', effort: 'low', speed: 'default' });
    await expect(readFile(join(dir, '.inkos', 'codex-config.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('preserves every byte of an existing legacy file while saving Codex preferences', async () => {
    const dir = await root(); await mkdir(join(dir, '.inkos'));
    const path = join(dir, '.inkos', 'codex-config.json');
    const original = Buffer.from('{\r\n  "model": "saved-model", "reasoningEffort": "low", "serviceTier": "default"\r\n}\r\n\r\n');
    await writeFile(path, original);
    await updateCodexSettings(dir, { model: null, reasoningEffort: 'high' });
    expect(await readFile(path)).toEqual(original);
    expect(await readCodexSettings(dir)).toEqual({ reasoningEffort: 'high', serviceTier: 'default' });
    expect(JSON.parse(await readFile(join(dir, '.inkos', 'agent-config.json'), 'utf8')).harnessPreferences.codex).toEqual({ model: null, effort: 'high', speed: 'default' });
  });
  it.each([
    { model: 'saved-model', reasoningEffort: 'low', serviceTier: 'default' },
    { model: null, reasoningEffort: 'high', serviceTier: 'priority' },
  ] as const)('keeps the legacy model/effort/tier DTO equivalent after creating the new file (%j)', async legacy => {
    const dir = await root(); await mkdir(join(dir, '.inkos'));
    const path = join(dir, '.inkos', 'codex-config.json'); await writeFile(path, JSON.stringify(legacy));
    const expected = { ...(legacy.model === null ? {} : { model: legacy.model }), reasoningEffort: legacy.reasoningEffort, serviceTier: legacy.serviceTier };
    expect(await readCodexSettings(dir)).toEqual(expected);
    expect(await updateCodexSettings(dir, {})).toEqual(expected);
    expect(await readCodexSettings(dir)).toEqual(expected);
    expect(JSON.parse(await readFile(join(dir, '.inkos', 'agent-config.json'), 'utf8')).harnessPreferences.codex.model).toBe(legacy.model);
    await writeFile(path, '{invalid old file now ignored');
    expect(await readCodexSettings(dir)).toEqual(expected);
  });
  it.each(['{bad JSON', JSON.stringify({ ...DEFAULT_AGENT_SETTINGS, schemaVersion: 99 })])('does not fall back to a valid legacy file when the new file is invalid (%s)', async raw => {
    const dir = await root(); await mkdir(join(dir, '.inkos'));
    const legacyPath = join(dir, '.inkos', 'codex-config.json');
    const legacy = '{"model":"saved-model","reasoningEffort":"low","serviceTier":"default"}\n'; await writeFile(legacyPath, legacy);
    const path = join(dir, '.inkos', 'agent-config.json'); await writeFile(path, raw);
    await expect(readCodexSettings(dir)).rejects.toThrow('Cannot read agent settings');
    await expect(updateCodexSettings(dir, { model: 'test' })).rejects.toThrow('Cannot read agent settings');
    expect(await readFile(path, 'utf8')).toBe(raw);
    expect(await readFile(legacyPath, 'utf8')).toBe(legacy);
  });
  it('rejects secret/provider keys, malformed values, and corrupted existing files', async () => {
    expect(() => validateCodexSettingsPatch({ apiKey: 'secret' })).toThrow('Only model');
    expect(() => validateCodexSettingsPatch({ reasoningEffort: 'invented' })).toThrow();
    expect(() => validateCodexSettingsPatch({ reasoningEffort: ['high'] })).toThrow();
    expect(() => validateCodexSettingsPatch({ serviceTier: null })).toThrow();
    const dir = await root(); await mkdir(join(dir, '.inkos')); await writeFile(join(dir, '.inkos', 'codex-config.json'), '{bad');
    await expect(updateCodexSettings(dir, { model: 'test' })).rejects.toThrow('Cannot read Codex settings');
  });
});
