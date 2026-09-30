import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCodexSettings, updateCodexSettings, validateCodexSettingsPatch } from '../settings.js';

const roots: string[] = [];
async function root() { const value = await mkdtemp(join(tmpdir(), 'inkos-settings-test-')); roots.push(value); return value; }
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
describe('Codex settings', () => {
  it('defaults without reading legacy provider files', async () => {
    const dir = await root();
    await writeFile(join(dir, '.env'), 'OPENAI_API_KEY=never-read-me');
    expect(await readCodexSettings(dir)).toEqual({ reasoningEffort: 'medium', serviceTier: 'default' });
  });
  it('atomically saves only allowed settings and serializes patches', async () => {
    const dir = await root();
    await Promise.all([updateCodexSettings(dir, { model: 'codex-test' }), updateCodexSettings(dir, { reasoningEffort: 'high' })]);
    expect(await readCodexSettings(dir)).toEqual({ model: 'codex-test', reasoningEffort: 'high', serviceTier: 'default' });
    await updateCodexSettings(dir, { model: null });
    expect(await readCodexSettings(dir)).not.toHaveProperty('model');
    expect(await readFile(join(dir, '.inkos', 'codex-config.json'), 'utf8')).not.toContain('apiKey');
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
