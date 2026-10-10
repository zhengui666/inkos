import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readCodexSettings, updateCodexSettings } from '../../codex/settings.js';
import { AgentSettingsSchema } from '../contracts.js';
import { AGENT_CONFIG_FILE, DEFAULT_AGENT_SETTINGS, parseAgentSettings, readAgentSettings, updateAgentSettings } from '../settings.js';
import { catalog } from './fixtures.js';

const roots: string[] = [], children: ChildProcess[] = [];
async function root() {
  const directory = await mkdtemp(join(tmpdir(), 'inkos-runtime-settings-')); roots.push(directory); return directory;
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
}
afterEach(async () => {
  await Promise.all(children.splice(0).map(stop));
  await Promise.all(roots.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

interface WorkerOutcome { status: 'saved' | 'error'; revision?: number; code?: string; writes?: number; }
function worker(projectRoot: string, patch: unknown, expectedRevision: number, loop = false, pauseBeforeRename = false) {
  const sourceRoot = new URL('../../', import.meta.url).href;
  const child = spawn(process.execPath, ['--experimental-transform-types', '--input-type=module', '-e', `
    import {registerHooks,syncBuiltinESMExports} from 'node:module';
    import fs from 'node:fs';
    const sourceRoot=${JSON.stringify(sourceRoot)};
    registerHooks({resolve(specifier,context,next){return next(context.parentURL?.startsWith(sourceRoot)&&specifier.startsWith('.')&&specifier.endsWith('.js')?specifier.slice(0,-3)+'.ts':specifier,context);}});
    const {readAgentSettings,updateAgentSettings}=await import(sourceRoot+'runtime/settings.ts');
    const {catalog}=await import(sourceRoot+'runtime/__tests__/fixtures.ts');
    if(${pauseBeforeRename}) {
      const rename=fs.renameSync;
      fs.renameSync=(from,to)=>{
        if(String(to).endsWith('/agent-config.json')) {
          process.send({type:'staged'});
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,30000);
        }
        return rename(from,to);
      };
      syncBuiltinESMExports();
    }
    process.send({type:'ready'}); await new Promise(done=>process.once('message',done));
    const projectRoot=${JSON.stringify(projectRoot)},patch=${JSON.stringify(patch)};
    try {
      let revision=${expectedRevision},writes=0;
      while(writes<${loop ? 25 : 1}) {
        if(${loop}) revision=(await readAgentSettings(projectRoot)).revision;
        try {revision=(await updateAgentSettings(projectRoot,patch,{expectedRevision:revision,catalogs:{codex:catalog('codex'),pi:catalog('pi')}})).revision;writes++;}
        catch(error){if(${loop}&&error.code==='AGENT_SETTINGS_REVISION_CONFLICT')continue;throw error;}
      }
      process.send({type:'result',status:'saved',revision,writes});
    } catch(error) {process.send({type:'result',status:'error',code:error.code,message:error.message});}
    process.disconnect();
  `], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  children.push(child);
  let stderr = '', readyResolve!: () => void, readyReject!: (error: Error) => void;
  let doneResolve!: (result: WorkerOutcome) => void, doneReject!: (error: Error) => void, stagedResolve!: () => void, completed = false;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const done = new Promise<WorkerOutcome>((resolve, reject) => { doneResolve = resolve; doneReject = reject; });
  const staged = new Promise<void>(resolve => { stagedResolve = resolve; });
  void done.catch(() => undefined);
  child.stderr!.on('data', chunk => { stderr += chunk; });
  child.on('message', (message: { type: string } & WorkerOutcome) => {
    if (message.type === 'ready') readyResolve();
    else if (message.type === 'staged') stagedResolve();
    else if (message.type === 'result') { completed = true; doneResolve(message); }
  });
  child.on('error', error => { readyReject(error); doneReject(error); });
  child.on('exit', code => { if (!completed) { const error = new Error(`Settings worker exited (${code}): ${stderr}`); readyReject(error); doneReject(error); } });
  return { child, ready, done, staged, start() { child.send('start'); } };
}

describe('neutral local agent settings', () => {
  it('keeps current Codex defaults and Pi native defaults when no configuration exists, without writing', async () => {
    const directory = await root(); await writeFile(join(directory, '.env'), 'OPENAI_API_KEY=synthetic-never-read');
    expect(await readAgentSettings(directory)).toEqual(DEFAULT_AGENT_SETTINGS);
    expect(await readCodexSettings(directory)).toEqual({ model: 'gpt-6.1-sol', reasoningEffort: 'ultra', serviceTier: 'priority' });
    expect(await readdir(directory)).toEqual(['.env']);
    const copy = await readAgentSettings(directory); copy.harnessPreferences.pi.model = 'changed';
    expect((await readAgentSettings(directory)).harnessPreferences.pi.model).toBeNull();
  });

  it('maps legacy model:null read-only and preserves every legacy byte after a new save', async () => {
    const directory = await root(); await mkdir(join(directory, '.inkos'));
    const legacy = '{\n  "serviceTier": "default", "model": null, "reasoningEffort": "low"\n}\n\n';
    const legacyPath = join(directory, '.inkos', 'codex-config.json'); await writeFile(legacyPath, legacy);
    const initial = await readAgentSettings(directory);
    expect(initial.harnessPreferences.codex).toEqual({ model: null, effort: 'low', speed: 'default' });
    expect(await readdir(join(directory, '.inkos'))).toEqual(['codex-config.json']);
    expect(await readCodexSettings(directory)).toEqual({ reasoningEffort: 'low', serviceTier: 'default' });
    const saved = await updateAgentSettings(directory, { selectedHarnessId: 'pi', modelConnectionRef: 'opaque-connection' }, { expectedRevision: 0 });
    expect(saved.revision).toBe(1); expect(saved.harnessPreferences.codex.model).toBeNull();
    expect(await readFile(legacyPath, 'utf8')).toBe(legacy);
    expect(JSON.parse(await readFile(join(directory, '.inkos', AGENT_CONFIG_FILE), 'utf8'))).toEqual(saved);
    await writeFile(legacyPath, '{invalid now ignored');
    expect(await readAgentSettings(directory)).toEqual(saved);
  });

  it('maps partial legacy settings with unchanged historical defaults', async () => {
    const directory = await root(); await mkdir(join(directory, '.inkos'));
    await writeFile(join(directory, '.inkos', 'codex-config.json'), '{"reasoningEffort":"high"}');
    expect((await readAgentSettings(directory)).harnessPreferences.codex).toEqual({ model: 'gpt-6.1-sol', effort: 'high', speed: 'priority' });
  });

  it.each(['{bad JSON', JSON.stringify({ ...DEFAULT_AGENT_SETTINGS, schemaVersion: 99 })])('rejects a present invalid new file without falling back or overwriting it (%s)', async raw => {
    const directory = await root(); await mkdir(join(directory, '.inkos'));
    await writeFile(join(directory, '.inkos', 'codex-config.json'), '{}');
    const path = join(directory, '.inkos', AGENT_CONFIG_FILE); await writeFile(path, raw);
    await expect(readAgentSettings(directory)).rejects.toThrow('Cannot read agent settings');
    await expect(readCodexSettings(directory)).rejects.toThrow('Cannot read agent settings');
    await expect(updateAgentSettings(directory, { selectedHarnessId: 'pi' }, { expectedRevision: 0 })).rejects.toThrow('Cannot read agent settings');
    await expect(updateCodexSettings(directory, { model: 'test' })).rejects.toThrow('Cannot read agent settings');
    expect(await readFile(path, 'utf8')).toBe(raw);
  });

  it('requires a known schema, a safe revision and exactly the credential-free fields', () => {
    expect(() => parseAgentSettings({ ...DEFAULT_AGENT_SETTINGS, schemaVersion: 2 })).toThrow('Unsupported');
    for (const patch of [{ schemaVersion: undefined }, { revision: -1 }, { revision: 0.5 }, { revision: Number.MAX_SAFE_INTEGER + 1 }, { selectedHarnessId: 'other' }, { authGeneration: 3 }, { apiKey: 'synthetic-secret' }, { accessToken: 'synthetic-secret' }]) {
      expect(() => parseAgentSettings({ ...DEFAULT_AGENT_SETTINGS, ...patch })).toThrow();
    }
    expect(() => AgentSettingsSchema.parse({ ...DEFAULT_AGENT_SETTINGS, harnessPreferences: { ...DEFAULT_AGENT_SETTINGS.harnessPreferences, pi: { ...DEFAULT_AGENT_SETTINGS.harnessPreferences.pi, token: 'synthetic-secret' } } })).toThrow();
  });

  it('saves an unready Pi with native defaults without requiring capabilities or changing Codex preferences', async () => {
    const directory = await root();
    const saved = await updateAgentSettings(directory, { selectedHarnessId: 'pi', modelConnectionRef: 'opaque-pi' }, { expectedRevision: 0 });
    expect(saved.selectedHarnessId).toBe('pi'); expect(saved.harnessPreferences.pi).toEqual({ model: null, effort: null, speed: null });
    expect(saved.harnessPreferences.codex).toEqual(DEFAULT_AGENT_SETTINGS.harnessPreferences.codex);
  });

  it('validates concrete overrides against the matching model-specific capability directory', async () => {
    const directory = await root();
    const patch = { selectedHarnessId: 'pi', harnessPreferences: { pi: { model: 'pi-native-model', effort: 'ultra', speed: 'priority' } } };
    await expect(updateAgentSettings(directory, patch, { expectedRevision: 0 })).rejects.toThrow('require');
    await expect(updateAgentSettings(directory, patch, { expectedRevision: 0, catalogs: { pi: catalog('codex') } })).rejects.toThrow('different harness');
    await expect(updateAgentSettings(directory, { harnessPreferences: { pi: { effort: 'invented' } } }, { expectedRevision: 0, catalogs: { pi: catalog('pi') } })).rejects.toThrow('Unsupported effort');
    const saved = await updateAgentSettings(directory, patch, { expectedRevision: 0, catalogs: { pi: catalog('pi') } });
    expect(saved.harnessPreferences.pi).toEqual(patch.harnessPreferences.pi);
  });

  it('preserves both saved engines preferences across switches and partial patches', async () => {
    const directory = await root();
    const first = await updateAgentSettings(directory, { selectedHarnessId: 'pi', harnessPreferences: {
      codex: { model: null, effort: 'low', speed: 'default' }, pi: { model: 'pi-native-model', effort: 'ultra', speed: 'priority' },
    } }, { expectedRevision: 0, catalogs: { codex: catalog('codex'), pi: catalog('pi') } });
    const next = await updateAgentSettings(directory, { selectedHarnessId: 'codex' }, { expectedRevision: 1, catalogs: { codex: catalog('codex') } });
    expect(next.harnessPreferences).toEqual(first.harnessPreferences);
    const final = await updateAgentSettings(directory, { selectedHarnessId: 'pi', harnessPreferences: { pi: { speed: 'default' } } }, { expectedRevision: 2, catalogs: { pi: catalog('pi') } });
    expect(final.harnessPreferences.codex).toEqual(first.harnessPreferences.codex);
    expect(final.harnessPreferences.pi).toEqual({ model: 'pi-native-model', effort: 'ultra', speed: 'default' });
  });

  it('keeps the legacy bridge confined to Codex and stores model:null only in the new file', async () => {
    const directory = await root(); await mkdir(join(directory, '.inkos'));
    const legacyPath = join(directory, '.inkos', 'codex-config.json'), legacy = '{"model":null}\n'; await writeFile(legacyPath, legacy);
    await updateAgentSettings(directory, { selectedHarnessId: 'pi', modelConnectionRef: 'opaque-pi' }, { expectedRevision: 0 });
    await Promise.all([updateCodexSettings(directory, { reasoningEffort: 'high' }), updateCodexSettings(directory, { serviceTier: 'default' })]);
    expect(await readCodexSettings(directory)).toEqual({ reasoningEffort: 'high', serviceTier: 'default' });
    const saved = await readAgentSettings(directory);
    expect(saved).toMatchObject({ revision: 3, selectedHarnessId: 'pi', modelConnectionRef: 'opaque-pi' });
    expect(saved.harnessPreferences.pi).toEqual({ model: null, effort: null, speed: null });
    expect(saved.harnessPreferences.codex.model).toBeNull(); expect(await readFile(legacyPath, 'utf8')).toBe(legacy);
    const disk = await readFile(join(directory, '.inkos', AGENT_CONFIG_FILE), 'utf8'); expect(disk).not.toMatch(/apiKey|accessToken|refreshToken|synthetic-secret/);
  });

  it('does not guess effort or speed when the old DTO cannot represent saved Codex native defaults', async () => {
    const directory = await root();
    await updateAgentSettings(directory, { harnessPreferences: { codex: { model: null, effort: null, speed: null } } }, { expectedRevision: 0 });
    await expect(readCodexSettings(directory)).rejects.toThrow('explicit supported effort and speed');
    await expect(updateCodexSettings(directory, { model: null })).rejects.toThrow();
    expect((await readAgentSettings(directory)).revision).toBe(1);
    await expect(updateCodexSettings(directory, { reasoningEffort: 'high', serviceTier: 'default' })).resolves.toEqual({ reasoningEffort: 'high', serviceTier: 'default' });
    expect((await readAgentSettings(directory)).harnessPreferences.codex.model).toBeNull();
  });

  it('rejects secrets in legacy files and new patches without copying or exposing credential contents', async () => {
    const directory = await root(); await mkdir(join(directory, '.inkos'));
    const legacy = '{"model":"saved","auth":{"accessToken":"synthetic-secret"}}';
    await writeFile(join(directory, '.inkos', 'codex-config.json'), legacy);
    await expect(readAgentSettings(directory)).rejects.toThrow('Cannot read Codex settings');
    await expect(updateAgentSettings(directory, { selectedHarnessId: 'pi' }, { expectedRevision: 0 })).rejects.toThrow('Cannot read Codex settings');
    expect(await readFile(join(directory, '.inkos', 'codex-config.json'), 'utf8')).toBe(legacy);
    await expect(updateAgentSettings(directory, { accessToken: 'synthetic-secret' }, { expectedRevision: 0 })).rejects.toThrow();
    await expect(readFile(join(directory, '.inkos', AGENT_CONFIG_FILE))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects stale CAS revisions without losing or partially saving either section', async () => {
    const directory = await root(); const saved = await updateAgentSettings(directory, { selectedHarnessId: 'pi', modelConnectionRef: 'winner' }, { expectedRevision: 0 });
    const path = join(directory, '.inkos', AGENT_CONFIG_FILE), bytes = await readFile(path, 'utf8');
    await expect(updateAgentSettings(directory, { modelConnectionRef: 'loser', harnessPreferences: { pi: { effort: 'low' } } }, { expectedRevision: 0, catalogs: { pi: catalog('pi') } })).rejects.toMatchObject({ code: 'AGENT_SETTINGS_REVISION_CONFLICT', expectedRevision: 0, actualRevision: 1 });
    expect(await readAgentSettings(directory)).toEqual(saved); expect(await readFile(path, 'utf8')).toBe(bytes);
  });

  it('serializes same-process CAS writers so exactly one wins the same revision', async () => {
    const directory = await root();
    const results = await Promise.allSettled(['first', 'second'].map(modelConnectionRef => updateAgentSettings(directory, { selectedHarnessId: 'pi', modelConnectionRef }, { expectedRevision: 0 })));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect((await readAgentSettings(directory)).revision).toBe(1);
  });

  it('arbitrates the same expected revision across independent OS processes', async () => {
    const directory = await root();
    const first = worker(directory, { selectedHarnessId: 'pi', modelConnectionRef: 'first' }, 0);
    const second = worker(directory, { selectedHarnessId: 'pi', modelConnectionRef: 'second' }, 0);
    await Promise.all([first.ready, second.ready]); first.start(); second.start();
    const results = await Promise.all([first.done, second.done]);
    expect(results.filter(result => result.status === 'saved')).toHaveLength(1);
    expect(results.filter(result => result.code === 'AGENT_SETTINGS_REVISION_CONFLICT')).toHaveLength(1);
    const saved = await readAgentSettings(directory); expect(saved.revision).toBe(1); expect(['first', 'second']).toContain(saved.modelConnectionRef);
  });

  it('preserves the prior complete snapshot and releases the mutex after a writer dies before atomic replacement', async () => {
    const directory = await root();
    const prior = await updateAgentSettings(directory, { modelConnectionRef: 'codex' }, { expectedRevision: 0 });
    const path = join(directory, '.inkos', AGENT_CONFIG_FILE), bytes = await readFile(path, 'utf8');
    const writer = worker(directory, { selectedHarnessId: 'pi', modelConnectionRef: 'pi' }, 1, false, true);
    await writer.ready; writer.start(); await writer.staged;
    expect(await readFile(path, 'utf8')).toBe(bytes); await stop(writer.child);
    expect(await readAgentSettings(directory)).toEqual(prior);
    const recovered = await updateAgentSettings(directory, { selectedHarnessId: 'pi', modelConnectionRef: 'pi' }, { expectedRevision: 1 });
    expect(recovered.revision).toBe(2); expect(recovered.modelConnectionRef).toBe(recovered.selectedHarnessId);
  });

  it('keeps both configuration sections atomic while competing processes perform CAS retries', async () => {
    const directory = await root();
    await updateAgentSettings(directory, { modelConnectionRef: 'codex' }, { expectedRevision: 0 });
    const first = worker(directory, { selectedHarnessId: 'pi', modelConnectionRef: 'pi' }, 1, true);
    const second = worker(directory, { selectedHarnessId: 'codex', modelConnectionRef: 'codex' }, 1, true);
    await Promise.all([first.ready, second.ready]); first.start(); second.start();
    let finished = false; const resultsPromise = Promise.all([first.done, second.done]).then(results => { finished = true; return results; });
    let observations = 0;
    do {
      const snapshot = parseAgentSettings(JSON.parse(await readFile(join(directory, '.inkos', AGENT_CONFIG_FILE), 'utf8')));
      expect(snapshot.modelConnectionRef).toBe(snapshot.selectedHarnessId); observations++;
    } while (!finished);
    expect(observations).toBeGreaterThan(0);
    expect(await resultsPromise).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'saved', writes: 25 })]));
    expect((await resultsPromise).every(result => result.status === 'saved')).toBe(true);
    expect((await readAgentSettings(directory)).revision).toBe(51);
    expect((await readdir(join(directory, '.inkos'))).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });
});
