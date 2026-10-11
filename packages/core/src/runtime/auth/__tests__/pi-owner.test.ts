import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, access } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PiAuthenticationOwner } from '../pi-owner.js';
import { createPiRuntimeContext } from '../../adapters/pi/runtime-context.js';
import { loadPiNativeAuthStorage } from '../pi-native-store-compat.js';
import type { PiCredentialStore } from '../pi-native-store-compat.js';

const directorySyncFault = vi.hoisted(() => ({ inject: undefined as (() => void) | undefined }));
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, fsyncSync(fd: number) {
    if (actual.fstatSync(fd).isDirectory()) directorySyncFault.inject?.();
    return actual.fsyncSync(fd);
  } };
});
vi.mock('../pi-native-store-compat.js', async () => {
  const { createRequire } = await import('node:module');
  return createRequire(import.meta.url)('../pi-native-store-compat.ts');
});
const dirs: string[] = [];
const oauth = (suffix = 'first', expires = Date.now() + 3_600_000) => ({ type: 'oauth' as const, access: `synthetic-access-${suffix}`, refresh: `synthetic-refresh-${suffix}`, expires });
function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(value: unknown = { openai: oauth() }, missing = false) {
  const dir = await mkdtemp(join(tmpdir(), 'inkos-pi-owner-')); dirs.push(dir);
  const project = join(dir, 'project'), agentDir = join(dir, 'agent'); await mkdir(project);
  if (!missing) { await mkdir(agentDir); await writeFile(join(agentDir, 'auth.json'), JSON.stringify(value)); }
  vi.stubEnv('PI_CODING_AGENT_DIR', agentDir);
  const owner = await PiAuthenticationOwner.create(project);
  const recordPath = join(agentDir, 'inkos-connection.json'), authPath = join(agentDir, 'auth.json');
  const record = async () => JSON.parse(await readFile(recordPath, 'utf8'));
  const admit = async () => { const admission = await owner.admit(); const target = { harnessId: 'pi' as const, authContextRef: admission.authContextRef,
    connectionRef: admission.connection.connectionRef, authGeneration: admission.authGeneration }; return { admission, target, lease: owner.lease(target) }; };
  return { dir, project, agentDir, authPath, recordPath, owner, record, admit };
}
async function runtime(f: Awaited<ReturnType<typeof fixture>>, lease: ReturnType<PiAuthenticationOwner['lease']>) {
  return (await createPiRuntimeContext({ ...f.owner.scope, credentials: lease.credentials, resolveAuth: lease.resolveAuth })).modelRuntime as ModelRuntime;
}
let network: ReturnType<typeof vi.fn>;
beforeEach(() => { network = vi.fn(async () => { throw new Error('Network forbidden'); }); vi.stubGlobal('fetch', network); });
afterEach(async () => { directorySyncFault.inject = undefined; expect(network).not.toHaveBeenCalled(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

describe('Pi credential-continuity execution owner with official storage', () => {
  it.each(['same-target', 'higher-generation', 'new-pending', 'different-ref'] as const)('review metadata rename then directory fsync EIO preserves %s fencing authority', async mode => {
    const f = await fixture({ openai: oauth('expired', 1) }), { lease, target } = await f.admit(), real = await runtime(f, lease);
    const sibling = f.owner.lease(target), before = await f.record();
    const savingFailure = Object.assign(new Error('Metadata directory fsync failed after rename'), { code: 'EIO' });
    let injected = 0, replacement: typeof before | undefined;
    directorySyncFault.inject = () => {
      const visible = JSON.parse(readFileSync(f.recordPath, 'utf8'));
      if (injected || visible.localState !== 'ready' || visible.pendingRefresh || visible.credentialRef === before.credentialRef) return;
      injected += 1;
      if (mode !== 'same-target') {
        replacement = mode === 'higher-generation' ? { ...visible, authGeneration: target.authGeneration + 1 }
          : mode === 'new-pending' ? { ...visible, pendingRefresh: { operationId: 'replacement-refresh', authGeneration: target.authGeneration } }
          : { ...visible, credentialRef: 'a'.repeat(64) };
        writeFileSync(f.recordPath, JSON.stringify(replacement) + '\n');
      }
      throw savingFailure;
    };
    real.getProvider('openai')!.auth.oauth!.refresh = async () => oauth('rotated');
    real.getProvider('openai')!.auth.oauth!.toAuth = async value => ({ apiKey: value.access });
    const failure = await real.getAuth('openai').catch(error => error);
    expect(injected).toBe(1);
    expect(failure).toMatchObject({ code: 'RUNTIME_AUTH_REVOKED', cause: savingFailure });
    await expect(lease.guard()).rejects.toBe(failure); await expect(lease.drain()).rejects.toBe(failure);
    if (mode === 'same-target') {
      await expect(sibling.guard()).rejects.toMatchObject({ code: 'RUNTIME_AUTH_REVOKED' });
      expect(await f.record()).toMatchObject({ localState: 'unknown', authGeneration: target.authGeneration + 1 });
      expect((await f.record()).pendingRefresh).toBeUndefined();
    } else {
      expect(await f.record()).toEqual(replacement);
      if (mode === 'higher-generation') {
        await expect(sibling.guard()).rejects.toMatchObject({ code: 'RUNTIME_AUTH_REVOKED' });
        await f.owner.lease({ ...target, authGeneration: target.authGeneration + 1 }).guard();
        expect(await f.record()).toEqual(replacement);
      }
    }
  });
  it.each(['EIO', 'invalid', 'missing'] as const)('review final verification %s fences before clearing its refresh ticket', async mode => {
    const f = await fixture({ openai: oauth('expired', 1) }), { lease, target } = await f.admit(), real = await runtime(f, lease);
    const native = (f.owner as unknown as { native: PiCredentialStore }).native;
    const modify = native.modify.bind(native), read = native.read.bind(native); let final = false;
    vi.spyOn(native, 'modify').mockImplementation(async (...args) => { const value = await modify(...args); final = true; return value; });
    vi.spyOn(native, 'read').mockImplementation(async (...args) => {
      if (final) { final = false; if (mode === 'missing') return undefined; if (mode === 'invalid') throw new Error('Bad raw OAuth'); throw Object.assign(new Error('One-off raw EIO'), { code: 'EIO' }); }
      return read(...args);
    });
    real.getProvider('openai')!.auth.oauth!.refresh = async () => oauth('rotated');
    real.getProvider('openai')!.auth.oauth!.toAuth = async value => ({ apiKey: value.access });
    const failure = await real.getAuth('openai').catch(error => error);
    expect(failure).toMatchObject({ code: 'RUNTIME_AUTH_REVOKED' });
    expect(await f.record()).toMatchObject({ localState: 'unknown', authGeneration: target.authGeneration + 1 });
    await expect(lease.guard()).rejects.toBe(failure);
    await writeFile(f.authPath, JSON.stringify({ openai: oauth('expired', 1) }));
    await expect(lease.guard()).rejects.toBe(failure); await expect(lease.drain()).rejects.toBe(failure);
  });
  it('review second execution raw failure remains revoked after the credential becomes readable', async () => {
    const f = await fixture(), { lease, target } = await f.admit();
    const native = (f.owner as unknown as { native: PiCredentialStore }).native, read = native.read.bind(native); let calls = 0;
    vi.spyOn(native, 'read').mockImplementation(async (...args) => { if (++calls === 2) throw Object.assign(new Error('Second raw read EIO'), { code: 'EIO' }); return read(...args); });
    const failure = await lease.credentials.read('openai').catch(error => error);
    expect(failure).toMatchObject({ code: 'RUNTIME_AUTH_REVOKED' });
    expect(await f.record()).toMatchObject({ localState: 'unknown', authGeneration: target.authGeneration + 1 });
    await expect(lease.guard()).rejects.toBe(failure);
  });
  it('review second raw uncertainty waits for registered native work instead of fencing its refresh', async () => {
    const f = await fixture({ openai: oauth('expired', 1) }), { lease, target } = await f.admit(), real = await runtime(f, lease);
    const native = (f.owner as unknown as { native: PiCredentialStore }).native, read = native.read.bind(native);
    const observed = deferred(), releaseRead = deferred(), entered = deferred(), releaseRefresh = deferred(); let reads = 0;
    vi.spyOn(native, 'read').mockImplementation(async (...args) => {
      if (++reads === 2) { observed.resolve(); await releaseRead.promise; throw new Error('Raw read overlapped a controlled save'); } return read(...args);
    });
    const reading = lease.credentials.read('openai').catch(error => error); await observed.promise;
    real.getProvider('openai')!.auth.oauth!.refresh = async () => { entered.resolve(); await releaseRefresh.promise; return oauth('rotated'); };
    real.getProvider('openai')!.auth.oauth!.toAuth = async value => ({ apiKey: value.access });
    const auth = real.getAuth('openai').catch(error => error); await entered.promise; releaseRead.resolve(); releaseRefresh.resolve();
    const value = await reading; await auth; expect(value?.access).toBe('synthetic-access-rotated');
    expect(await f.record()).toMatchObject({ localState: 'ready', authGeneration: target.authGeneration }); await lease.guard();
  });
  it('review caller cancellation during a second raw read is not external credential replacement', async () => {
    const f = await fixture(), { lease, target } = await f.admit(), controller = new AbortController();
    const native = (f.owner as unknown as { native: PiCredentialStore }).native, read = native.read.bind(native);
    const entered = deferred(), release = deferred(); let reads = 0;
    vi.spyOn(native, 'read').mockImplementation(async (...args) => { if (++reads === 2) { entered.resolve(); await release.promise; throw new Error('Cancelled raw observation'); } return read(...args); });
    const result = lease.credentials.read('openai', { signal: controller.signal }).catch(error => error);
    await entered.promise; const cancelled = new DOMException('Caller cancelled', 'AbortError'); controller.abort(cancelled); release.resolve();
    expect(await result).toBe(cancelled); expect(await f.record()).toMatchObject({ localState: 'ready', authGeneration: target.authGeneration }); await lease.guard();
  });
  it.each(['success', 'failure'] as const)('review late refresh %s cannot modify a replacement generation', async mode => {
    const f = await fixture({ openai: oauth('expired', 1) }), { lease, target } = await f.admit(), real = await runtime(f, lease);
    const entered = deferred(), release = deferred();
    real.getProvider('openai')!.auth.oauth!.refresh = async () => { entered.resolve(); await release.promise; if (mode === 'failure') throw new Error('Late refresh failed'); return oauth('late'); };
    const result = real.getAuth('openai').catch(error => error); await entered.promise;
    const { pendingRefresh: _pending, ...record } = await f.record(), newer = { ...record, authGeneration: target.authGeneration + 1 };
    await writeFile(f.recordPath, JSON.stringify(newer)); release.resolve(); const failure = await result;
    expect(failure).toMatchObject({ code: 'RUNTIME_AUTH_REVOKED' }); await expect(lease.drain()).rejects.toBe(failure); expect(await f.record()).toEqual(newer);
  });
  it('review detached saving failure survives cancellation and global mutation removal', async () => {
    const f = await fixture({ openai: oauth('expired', 1) }), { lease } = await f.admit(), real = await runtime(f, lease);
    const native = (f.owner as unknown as { native: PiCredentialStore }).native, modify = native.modify.bind(native);
    const entered = deferred(), release = deferred(), failed = deferred(); const savingFailure = new Error('Native save finalization failed');
    vi.spyOn(native, 'modify').mockImplementation(async (...args) => { await modify(...args); entered.resolve(); await release.promise; failed.resolve(); throw savingFailure; });
    real.getProvider('openai')!.auth.oauth!.refresh = async () => oauth('rotated');
    real.getProvider('openai')!.auth.oauth!.toAuth = async value => ({ apiKey: value.access });
    const controller = new AbortController(), resolution = real.getAuth('openai', { signal: controller.signal }).catch(error => error);
    await entered.promise; const cancellation = new DOMException('Cancelled auth', 'AbortError'); controller.abort(cancellation);
    const primary = await resolution;
    let settled = false; const draining = f.owner.drain().finally(() => { settled = true; });
    await Promise.resolve(); expect(settled).toBe(false); release.resolve(); await failed.promise;
    await draining; const failure = await lease.drain().catch(error => error); expect(primary).toMatchObject({ name: 'AbortError' });
    expect(failure).toMatchObject({ code: 'RUNTIME_AUTH_REVOKED', cause: savingFailure });
    await expect(lease.guard()).rejects.toBe(failure); await lease.drain();
    const fresh = await f.admit(); await fresh.lease.guard(); await fresh.lease.drain();
  });
  it('review cancellation before the native callback does not report token saving failure', async () => {
    const f = await fixture({ openai: oauth('expired', 1) }), { lease, target } = await f.admit(), real = await runtime(f, lease);
    const native = (f.owner as unknown as { native: PiCredentialStore }).native, modify = native.modify.bind(native);
    const entered = deferred(), release = deferred();
    vi.spyOn(native, 'modify').mockImplementation(async (...args) => { entered.resolve(); await release.promise; return modify(...args); });
    const refresh = vi.fn(async () => oauth('rotated')); real.getProvider('openai')!.auth.oauth!.refresh = refresh;
    const controller = new AbortController(), result = real.getAuth('openai', { signal: controller.signal }).catch(error => error);
    await entered.promise; controller.abort(); expect((await result).name).toBe('AbortError'); release.resolve(); await lease.drain();
    expect(refresh).not.toHaveBeenCalled(); expect(await f.record()).toMatchObject({ localState: 'ready', authGeneration: target.authGeneration }); await lease.guard();
  });
  it('observes missing directories without creating auth, owner, configuration or mutex', async () => {
    const f = await fixture(undefined, true), { AuthStorage } = await loadPiNativeAuthStorage();
    const create = vi.spyOn(AuthStorage, 'create'), modify = vi.spyOn(AuthStorage.prototype, 'modify');
    expect(await f.owner.observe()).toBeNull(); expect(await readdir(f.dir)).toEqual(['project']);
    expect(create).not.toHaveBeenCalled(); expect(modify).not.toHaveBeenCalled();
  });
  it('admits independently and exposes no secret or private digest in the admission', async () => {
    const f = await fixture(), before = await readFile(f.authPath, 'utf8');
    expect(await f.owner.observe()).toBeNull(); await expect(access(f.recordPath)).rejects.toMatchObject({ code: 'ENOENT' });
    const { admission, target, lease } = await f.admit(); expect(admission.ready).toBe(true); expect(target.authGeneration).toBe(1);
    expect(JSON.stringify(admission)).not.toMatch(/synthetic|credentialRef|access|refresh/);
    await lease.guard(); expect(await readFile(f.authPath, 'utf8')).toBe(before);
    const previous = target.connectionRef; await rm(f.recordPath); expect((await f.admit()).target.connectionRef).not.toBe(previous);
    await expect(lease.guard()).rejects.toMatchObject({ code: 'RUNTIME_AUTH_REVOKED' });
  });
  it('does not revoke equivalent OAuth formatting and key order', async () => {
    const f = await fixture(), { lease, target } = await f.admit(); const current = JSON.parse(await readFile(f.authPath, 'utf8')).openai;
    await writeFile(f.authPath, JSON.stringify({ other: { untouched: true }, openai: { expires: current.expires, refresh: current.refresh, access: current.access, type: current.type } }, null, 4));
    await lease.guard(); expect((await f.record()).authGeneration).toBe(target.authGeneration);
  });
  it.each(['deleted', 'api-key', 'invalid-json', 'replacement'])('fences %s without allowing environment API key fallback', async mode => {
    const f = await fixture(), { lease, target } = await f.admit(); const real = await runtime(f, lease);
    if (mode === 'deleted') await rm(f.authPath);
    else await writeFile(f.authPath, mode === 'invalid-json' ? '{' : JSON.stringify({ openai: mode === 'api-key' ? { type: 'api_key', key: 'synthetic-key' } : oauth('replacement') }));
    vi.stubEnv('OPENAI_API_KEY', 'synthetic-environment-key');
    await expect(real.getAuth('openai')).rejects.toMatchObject({ code: 'RUNTIME_AUTH_REVOKED' });
    expect((await f.record()).authGeneration).toBe(target.authGeneration + 1);
    await expect(lease.guard()).rejects.toMatchObject({ code: 'RUNTIME_AUTH_REVOKED' });
  });
  it('fails closed on corrupt owner metadata without overwriting it', async () => {
    const f = await fixture(); await f.admit(); await writeFile(f.recordPath, '{');
    await expect(f.owner.admit()).rejects.toThrow('connection record'); expect(await readFile(f.recordPath, 'utf8')).toBe('{');
  });
  it('denies arbitrary execution-store OAuth modifications outside official resolution', async () => {
    const f = await fixture(), { lease } = await f.admit(), before = await readFile(f.authPath, 'utf8');
    await expect(lease.credentials.modify('openai', async () => oauth('arbitrary'))).rejects.toMatchObject({ code: 'RUNTIME_AUTH_REVOKED' });
    expect(await readFile(f.authPath, 'utf8')).toBe(before);
  });
  it('uses the official OAuth refresh and native lock once across two runtimes, preserving generation', async () => {
    const f = await fixture({ openai: oauth('expired', 1) }), first = await f.admit(), second = await f.admit();
    const runtimes = await Promise.all([runtime(f, first.lease), runtime(f, second.lease)]);
    const refresh = vi.fn(async () => oauth('rotated'));
    for (const real of runtimes) { const native = real.getProvider('openai')!.auth.oauth!; native.refresh = refresh; native.toAuth = async value => ({ apiKey: value.access }); }
    const values = await Promise.all(runtimes.map(real => real.getAuth('openai')));
    expect(refresh).toHaveBeenCalledOnce(); expect(values.map(value => value?.auth.apiKey)).toEqual(['synthetic-access-rotated', 'synthetic-access-rotated']);
    expect((await f.record()).authGeneration).toBe(first.target.authGeneration); expect((await f.record()).pendingRefresh).toBeUndefined();
    await first.lease.guard(); await second.lease.guard();
  });
  it('guards and drain wait for the complete detached native mutation after caller cancellation', async () => {
    const f = await fixture({ openai: oauth('expired', 1) }), { lease } = await f.admit(), real = await runtime(f, lease);
    const entered = deferred(), release = deferred();
    real.getProvider('openai')!.auth.oauth!.refresh = async () => { entered.resolve(); await release.promise; return oauth('rotated'); };
    real.getProvider('openai')!.auth.oauth!.toAuth = async value => ({ apiKey: value.access });
    const controller = new AbortController(), resolution = real.getAuth('openai', { signal: controller.signal }).catch(error => error);
    await entered.promise; controller.abort(); expect((await resolution).name).toBe('AbortError');
    let guarded = false, drained = false;
    const guard = lease.guard().then(() => { guarded = true; }), drain = lease.drain().then(() => { drained = true; });
    await Promise.resolve(); expect(guarded).toBe(false); expect(drained).toBe(false); expect((await f.record()).pendingRefresh).toBeDefined();
    release.resolve(); await Promise.all([guard, drain]); expect((await f.record()).pendingRefresh).toBeUndefined();
    expect(JSON.parse(await readFile(f.authPath, 'utf8')).openai.access).toBe('synthetic-access-rotated');
  });
  it('fences unproven cross-process pending metadata without auth creation, lock rendezvous or readmission', async () => {
    const f = await fixture(), { lease, target } = await f.admit(), before = await readFile(f.authPath, 'utf8');
    await writeFile(f.recordPath, JSON.stringify({ ...await f.record(), pendingRefresh: { operationId: 'other-process', authGeneration: target.authGeneration } }));
    const { AuthStorage } = await loadPiNativeAuthStorage(), create = vi.spyOn(AuthStorage, 'create'), modify = vi.spyOn(AuthStorage.prototype, 'modify');
    expect((await f.owner.observe())?.ready).toBe(false);
    await expect(lease.guard()).rejects.toMatchObject({ code: 'RUNTIME_AUTH_REVOKED' });
    expect((await f.record()).localState).toBe('unknown'); expect(await readFile(f.authPath, 'utf8')).toBe(before);
    expect(create).not.toHaveBeenCalled(); expect(modify).not.toHaveBeenCalled();
    expect((await f.admit()).target.authGeneration).toBe(target.authGeneration + 1);
    await expect(lease.guard()).rejects.toMatchObject({ code: 'RUNTIME_AUTH_REVOKED' });
  });
  it('rejects replacement during native toAuth before returning its obsolete credential', async () => {
    const f = await fixture(), { lease } = await f.admit(), real = await runtime(f, lease);
    real.getProvider('openai')!.auth.oauth!.toAuth = async current => { await writeFile(f.authPath, JSON.stringify({ openai: oauth('external') })); return { apiKey: current.access }; };
    await expect(real.getAuth('openai')).rejects.toMatchObject({ code: 'RUNTIME_AUTH_REVOKED' });
    expect((await f.record()).localState).toBe('unknown');
  });
  it('allows an entered legitimate refresh to save but never revives an already fenced generation', async () => {
    const f = await fixture({ openai: oauth('expired', 1) }), { lease, target } = await f.admit(), real = await runtime(f, lease);
    const entered = deferred(), release = deferred();
    real.getProvider('openai')!.auth.oauth!.refresh = async () => { entered.resolve(); await release.promise; return oauth('late-rotation'); };
    const resolution = real.getAuth('openai').catch(error => error); await entered.promise;
    const { pendingRefresh: _pending, ...current } = await f.record();
    await writeFile(f.recordPath, JSON.stringify({ ...current, localState: 'unknown', authGeneration: target.authGeneration + 1 }));
    release.resolve(); const failure = await resolution; await expect(lease.drain()).rejects.toBe(failure);
    expect(JSON.parse(await readFile(f.authPath, 'utf8')).openai.access).toBe('synthetic-access-late-rotation');
    expect((await f.record()).localState).toBe('unknown'); expect((await f.record()).authGeneration).toBe(target.authGeneration + 1);
    await expect(lease.guard()).rejects.toMatchObject({ code: 'RUNTIME_AUTH_REVOKED' });
  });
});
