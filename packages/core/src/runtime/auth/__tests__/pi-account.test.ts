import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, symlink, link } from 'node:fs/promises';
import { createServer, get } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { SettingsManager } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PiAccountService } from '../pi-account.js';
import { PiAuthenticationOwner } from '../pi-owner.js';
import { loadPiNativeAuthStorage } from '../pi-native-store-compat.js';
import * as nativeLogin from '../pi-native-login.js';
vi.mock('../pi-native-store-compat.js', async () => {
  const { createRequire } = await import('node:module');
  return createRequire(import.meta.url)('../pi-native-store-compat.ts');
});
const dirs: string[] = [], services: { service: PiAccountService; handle: string }[] = [];
const oldOAuth = { type: 'oauth', access: 'synthetic-old-access', refresh: 'synthetic-old-refresh', expires: Date.now() + 3_600_000 };
const token = () => new Response(JSON.stringify({ access_token: 'synthetic-new-access', refresh_token: 'synthetic-new-refresh',
  expires_in: 3600, scope: 'openid chatgpt.tokens.use.direct', id_token: 'synthetic-presence-only' }), { status: 200 });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(auth: unknown = { openai: oldOAuth, other: { type: 'api_key', key: 'synthetic-preserve' } }, missing = false) {
  const dir = await mkdtemp(join(tmpdir(), 'inkos-pi-login-')); dirs.push(dir);
  const project = join(dir, 'project'), agent = join(dir, 'agent'); await mkdir(project); await mkdir(agent);
  if (!missing) await writeFile(join(agent, 'auth.json'), JSON.stringify(auth));
  vi.stubEnv('PI_CODING_AGENT_DIR', agent);
  const service = await PiAccountService.create(project), attempt = service.reserveLoginAttempt(); services.push({ service, handle: attempt.handle });
  return { dir, project, agent, service, handle: attempt.handle, auth: join(agent, 'auth.json'), record: join(agent, 'inkos-connection.json') };
}
async function state(f: Awaited<ReturnType<typeof fixture>>, status: string) {
  await vi.waitFor(() => expect(f.service.readLoginAttempt(f.handle).status).toBe(status)); return f.service.readLoginAttempt(f.handle);
}
function reply(f: Awaited<ReturnType<typeof fixture>>, callbackUrl: string) {
  const prompt = f.service.readLoginAttempt(f.handle).prompt!;
  return f.service.replyLoginAttempt(f.handle, { promptId: prompt.promptId, callbackUrl });
}
function callback(challenge: string, stateOverride?: string): string {
  const authorization = new URL(challenge), result = new URL('http://127.0.0.1:1455/auth/callback');
  result.search = new URLSearchParams({ state: stateOverride ?? authorization.searchParams.get('state')!, code: 'synthetic-code', client_id: 'synthetic-issued-client' }).toString();
  return result.href;
}
async function http(url: string): Promise<number | undefined> {
  return new Promise((resolve, reject) => { const request = get(url, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); }); request.on('error', reject); });
}
let network: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.stubEnv('PI_OAUTH_CALLBACK_HOST', '127.0.0.1');
  network = vi.fn(async (url: unknown, options: RequestInit | undefined) => {
    expect(url).toBe('https://auth.openai.com/api/accounts/oauth/token'); expect(options?.method).toBe('POST');
    expect(options?.body).toBeInstanceOf(URLSearchParams); expect(options?.signal).toBeInstanceOf(AbortSignal);
    return token();
  }); vi.stubGlobal('fetch', network);
});
afterEach(async () => {
  for (const { service, handle } of services.splice(0)) { try { await service.closeLoginAttempt(handle); } catch { /* Expired/evicted handles have no active work. */ } }
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  syncBuiltinESMExports();
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});
describe('Pi account service using official 1.1.0 login and native writer, synthetic token endpoint only', () => {
  it('seam prompt: the real auth_url notification cannot accept a reply before manual_code creates its resolver', async () => {
    const f = await fixture(); let checked = false, beforeKind: unknown, beforeError: unknown;
    f.service.subscribeLoginAttempt(f.handle, attempt => {
      if (attempt.challenge && !attempt.canReply && !checked) {
        checked = true;
        beforeKind = (attempt.challenge as unknown as { kind: unknown }).kind;
        try { f.service.replyLoginAttempt(f.handle, { promptId: 'not-issued', callbackUrl: 'synthetic-callback' } as never); } catch (error) { beforeError = (error as { code: unknown }).code; }
      }
    });
    f.service.startLoginAttempt(f.handle); await state(f, 'awaiting-user'); expect(checked).toBe(true);
    expect(beforeKind).toBe('open-url'); expect(beforeError).toBe('prompt-not-current');
    const current = f.service.readLoginAttempt(f.handle) as ReturnType<PiAccountService['readLoginAttempt']> & { prompt: { promptId: string; kind: string } | null };
    expect(current.prompt).toMatchObject({ kind: 'callback-url' }); expect(current.prompt!.promptId).toMatch(/^pi-prompt-/); expect(network).not.toHaveBeenCalled();
  });
  it('seam prompt: only the current handle and application promptId can consume a callback once, without echoing it', async () => {
    const f = await fixture(), response = deferred<Response>(), entered = deferred<void>();
    network.mockImplementation(async () => { entered.resolve(); return response.promise; });
    type PromptAttempt = ReturnType<PiAccountService['readLoginAttempt']> & { prompt: { promptId: string; kind: string } | null };
    try {
      f.service.startLoginAttempt(f.handle); const first = await state(f, 'awaiting-user') as PromptAttempt;
      expect(first.prompt?.kind).toBe('callback-url'); const id = first.prompt!.promptId, url = callback(first.challenge!.url);
      expect(() => f.service.replyLoginAttempt(f.handle, { promptId: 'stale-id', callbackUrl: url } as never)).toThrow('prompt-not-current');
      expect(() => f.service.replyLoginAttempt(f.handle, url as never)).toThrow('prompt-not-current'); expect(network).not.toHaveBeenCalled();
      const replied = f.service.replyLoginAttempt(f.handle, { promptId: id, callbackUrl: url } as never) as PromptAttempt;
      expect(replied).toMatchObject({ canReply: false, prompt: null }); expect(JSON.stringify(replied)).not.toContain(url); await entered.promise;
      expect(() => f.service.replyLoginAttempt(f.handle, { promptId: id, callbackUrl: url } as never)).toThrow('prompt-not-current'); expect(network).toHaveBeenCalledOnce();
      response.resolve(token()); await state(f, 'saved'); const oldHandle = f.handle;
      f.handle = f.service.reserveLoginAttempt(f.service.readLoginExpectation()).handle; services.push({ service: f.service, handle: f.handle });
      f.service.startLoginAttempt(f.handle); const second = await state(f, 'awaiting-user') as PromptAttempt; expect(second.prompt!.promptId).not.toBe(id);
      for (const [handle, promptId] of [[f.handle, id], [oldHandle, second.prompt!.promptId]]) {
        expect(() => f.service.replyLoginAttempt(handle, { promptId, callbackUrl: url } as never)).toThrow('prompt-not-current');
      }
      const closed = await f.service.closeLoginAttempt(f.handle); expect((closed.attempt as PromptAttempt).prompt).toBeNull();
      expect(() => f.service.replyLoginAttempt(f.handle, { promptId: second.prompt!.promptId, callbackUrl: url } as never)).toThrow('prompt-not-current'); expect(network).toHaveBeenCalledOnce();
      expect(JSON.stringify(closed)).not.toContain('synthetic-code'); expect(JSON.stringify(closed)).not.toContain('synthetic-new-');
    } finally { response.resolve(token()); }
  });
  it('seam busy: an entered official refresh is scope-busy for both services, without OAuth or changing owner/auth bytes', async () => {
    const f = await fixture(), owner = await PiAuthenticationOwner.create(f.project), admitted = await owner.admit();
    const target = { harnessId: 'pi' as const, authContextRef: admitted.authContextRef, connectionRef: admitted.connection.connectionRef, authGeneration: admitted.authGeneration };
    const entered = deferred<void>(), release = deferred<void>(), lease = owner.lease(target), login = vi.spyOn(nativeLogin, 'loginPiNative');
    const operation = lease.resolveAuth(() => lease.credentials.modify('openai', async () => { entered.resolve(); await release.promise; return undefined; }));
    try {
      await entered.promise; const before = await readFile(f.record, 'utf8'), auth = await readFile(f.auth, 'utf8');
      const other = await PiAccountService.create(f.project);
      for (const service of [f.service, other]) {
        const reserved = service.reserveLoginAttempt(service.readLoginExpectation());
        expect(service.startLoginAttempt(reserved.handle)).toMatchObject({ status: 'failed', error: 'scope-busy' });
        expect(await readFile(f.record, 'utf8')).toBe(before); expect(await readFile(f.auth, 'utf8')).toBe(auth);
      }
      expect(login).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
    } finally { release.resolve(); await operation; await lease.drain(); }
  });
  it('seam busy: a pending login discovered on the locked re-read keeps scope-busy instead of CAS changed', async () => {
    const f = await fixture(), peer = await PiAuthenticationOwner.create(f.project), admitted = await peer.admit();
    const target = { harnessId: 'pi' as const, authContextRef: admitted.authContextRef, connectionRef: admitted.connection.connectionRef, authGeneration: admitted.authGeneration };
    const local = (f.service as unknown as { owner: { locked<T>(fn: () => T): T } }).owner, locked = local.locked.bind(local);
    let ticket: ReturnType<PiAuthenticationOwner['beginLogin']> | undefined, peerBytes = '';
    vi.spyOn(local, 'locked').mockImplementation(fn => {
      ticket = peer.beginLogin(target); peerBytes = createRequire(import.meta.url)('node:fs').readFileSync(f.record, 'utf8'); return locked(fn);
    });
    const auth = await readFile(f.auth, 'utf8'), attempt = f.service.reserveLoginAttempt(target);
    try {
      expect(f.service.startLoginAttempt(attempt.handle)).toMatchObject({ status: 'failed', error: 'scope-busy' });
      expect(await readFile(f.record, 'utf8')).toBe(peerBytes); expect(await readFile(f.auth, 'utf8')).toBe(auth); expect(network).not.toHaveBeenCalled();
    } finally {
      if (ticket) { peer.closeLogin(ticket); const controller = new AbortController(); controller.abort(); await peer.runLogin(ticket, async () => { throw new DOMException('closed', 'AbortError'); }, controller.signal); }
    }
  });
  it('seam errors: malformed storage stays distinct from a genuine stale expectation', async () => {
    const f = await fixture(); await writeFile(f.auth, '{bad');
    expect(f.service.startLoginAttempt(f.handle)).toMatchObject({ status: 'failed', error: 'storage-failed' }); expect(network).not.toHaveBeenCalled();
  });
  it('seam errors: a changed trusted host scope is context-changed before mutation', async () => {
    const f = await fixture(), other = join(f.dir, 'other-agent'); await mkdir(other); vi.stubEnv('PI_CODING_AGENT_DIR', other);
    const before = await readFile(f.auth, 'utf8'); expect(f.service.startLoginAttempt(f.handle)).toMatchObject({ status: 'failed', error: 'context-changed' });
    expect(await readFile(f.auth, 'utf8')).toBe(before); expect(await readdir(other)).toEqual([]); expect(network).not.toHaveBeenCalled();
  });
  it('review R1: service dispose is idempotent, synchronously stops owned attempts and waits for actual token settlement', async () => {
    const f = await fixture(), response = deferred<Response>(), entered = deferred<void>();
    network.mockImplementation(async () => { entered.resolve(); return response.promise; });
    f.service.startLoginAttempt(f.handle); const pending = await state(f, 'awaiting-user');
    const unused = f.service.reserveLoginAttempt();
    reply(f, callback(pending.challenge!.url)); await entered.promise;
    try {
      expect(typeof (f.service as unknown as { dispose?: unknown }).dispose).toBe('function');
      const service = f.service, disposing = service.dispose();
      expect(service.dispose()).toBe(disposing);
      expect(network.mock.calls[0][1].signal.aborted).toBe(true);
      expect(service.readLoginAttempt(f.handle).status).toBe('closing');
      expect(service.readLoginAttempt(unused.handle).status).toBe('closed');
      expect(() => service.reserveLoginAttempt()).toThrow('service-stopped');
      expect(() => service.startLoginAttempt(unused.handle)).toThrow('service-stopped');
      let settled = false; void disposing.then(() => { settled = true; }); await Promise.resolve(); expect(settled).toBe(false);
      expect(JSON.parse(await readFile(f.record, 'utf8')).pendingLogin.closed).toBe(true);
      response.resolve(token()); await disposing;
      expect(JSON.parse(await readFile(f.record, 'utf8')).pendingLogin).toBeUndefined();
    } finally { response.resolve(token()); }
  });
  it('review R1: disposing another service in the same scope only closes its own reservations', async () => {
    const f = await fixture(); f.service.startLoginAttempt(f.handle); const before = await state(f, 'awaiting-user');
    const other = await PiAccountService.create(f.project), reserved = other.reserveLoginAttempt();
    expect(typeof (other as unknown as { dispose?: unknown }).dispose).toBe('function');
    await other.dispose();
    expect(other.readLoginAttempt(reserved.handle).status).toBe('closed');
    expect(f.service.readLoginAttempt(f.handle)).toEqual(before);
    expect(JSON.parse(await readFile(f.record, 'utf8')).pendingLogin.closed).toBe(false);
  });
  it('review R1: shutdown rejects the actual manual wait, releases the official port and is safe inside a listener', async () => {
    const f = await fixture(), before = await readFile(f.auth, 'utf8');
    f.service.startLoginAttempt(f.handle); await state(f, 'awaiting-user');
    let reentrant: Promise<void> | undefined;
    f.service.subscribeLoginAttempt(f.handle, attempt => { if (attempt.status === 'closing') reentrant = f.service.dispose(); });
    const disposing = f.service.dispose(); expect(reentrant).toBe(disposing); await disposing;
    expect(f.service.readLoginAttempt(f.handle)).toMatchObject({ status: 'closed', challenge: null, canReply: false });
    expect(JSON.parse(await readFile(f.record, 'utf8')).pendingLogin).toBeUndefined(); expect(await readFile(f.auth, 'utf8')).toBe(before);
    const server = createServer(); await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(1455, '127.0.0.1', resolve); });
    await new Promise<void>(resolve => server.close(() => resolve())); expect(network).not.toHaveBeenCalled();
  });
  it('review R1: service dispose waits for the actual native save reply after a committed write', async () => {
    const f = await fixture(), { AuthStorage } = await loadPiNativeAuthStorage(), original = AuthStorage.prototype.modify;
    const committed = deferred<void>(), release = deferred<void>(); let signal: AbortSignal | undefined;
    vi.spyOn(AuthStorage.prototype, 'modify').mockImplementation(async function(this: typeof AuthStorage.prototype, provider, fn, options) {
      signal = options?.signal; const result = await original.call(this, provider, fn, options); committed.resolve(); await release.promise; return result;
    });
    try {
      f.service.startLoginAttempt(f.handle); const pending = await state(f, 'awaiting-user'); reply(f, callback(pending.challenge!.url)); await committed.promise;
      expect(typeof (f.service as unknown as { dispose?: unknown }).dispose).toBe('function');
      const disposing = f.service.dispose();
      expect(signal?.aborted).toBe(true); expect(signal).toBe(network.mock.calls[0][1].signal);
      let done = false; void disposing.then(() => { done = true; }); await Promise.resolve(); expect(done).toBe(false);
      expect(JSON.parse(await readFile(f.record, 'utf8')).pendingLogin.closed).toBe(true);
      release.resolve(); await disposing;
      expect((await f.service.closeLoginAttempt(f.handle)).outcome).toBe('already-committed');
    } finally { release.resolve(); }
  });
  it('review R2: repeated start returns the exact current attempt through starting, waiting, exchanging and saved', async () => {
    const f = await fixture(), begin = vi.spyOn(PiAuthenticationOwner.prototype, 'beginLogin'), login = vi.spyOn(nativeLogin, 'loginPiNative');
    const response = deferred<Response>(), entered = deferred<void>(); network.mockImplementation(async () => { entered.resolve(); return response.promise; });
    try {
      const first = f.service.startLoginAttempt(f.handle); expect(f.service.startLoginAttempt(f.handle)).toEqual(first);
      const pending = await state(f, 'awaiting-user'); expect(f.service.startLoginAttempt(f.handle)).toEqual(pending);
      reply(f, callback(pending.challenge!.url)); await entered.promise;
      const exchanging = f.service.readLoginAttempt(f.handle); expect(exchanging.status).toBe('exchanging'); expect(f.service.startLoginAttempt(f.handle)).toEqual(exchanging);
      response.resolve(token()); const saved = await state(f, 'saved'); expect(f.service.startLoginAttempt(f.handle)).toEqual(saved);
      expect(begin).toHaveBeenCalledOnce(); expect(login).toHaveBeenCalledOnce(); expect(network).toHaveBeenCalledOnce();
    } finally { response.resolve(token()); }
  });
  it('review R2: repeated start after Close never replays the same flow', async () => {
    const f = await fixture(), begin = vi.spyOn(PiAuthenticationOwner.prototype, 'beginLogin');
    f.service.startLoginAttempt(f.handle); await state(f, 'awaiting-user'); await f.service.closeLoginAttempt(f.handle);
    const closed = f.service.readLoginAttempt(f.handle); expect(f.service.startLoginAttempt(f.handle)).toEqual(closed);
    expect(begin).toHaveBeenCalledOnce(); expect(network).not.toHaveBeenCalled();
  });
  it('review R2: repeated start of a failed attempt returns its receipt without another owner admission', async () => {
    const f = await fixture({}), begin = vi.spyOn(PiAuthenticationOwner.prototype, 'beginLogin'); await writeFile(f.auth, '{bad');
    const failed = f.service.startLoginAttempt(f.handle); expect(failed.status).toBe('failed');
    expect(f.service.startLoginAttempt(f.handle)).toEqual(failed); expect(begin).toHaveBeenCalledOnce(); expect(network).not.toHaveBeenCalled();
  });
  it.each(['saved', 'closed', 'unknown'] as const)('review R3: detached %s receipt survives another reservation for the Codex 10-minute retention window', async outcome => {
    const f = await fixture();
    if (outcome === 'unknown') {
      const { AuthStorage } = await loadPiNativeAuthStorage(), original = AuthStorage.prototype.modify;
      vi.spyOn(AuthStorage.prototype, 'modify').mockImplementation(async function(this: typeof AuthStorage.prototype, ...args) {
        await original.call(this, ...args); throw new Error('synthetic-after-commit-failure');
      });
    }
    f.service.startLoginAttempt(f.handle); const pending = await state(f, 'awaiting-user');
    const now = Date.now(), clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    if (outcome === 'closed') await f.service.closeLoginAttempt(f.handle);
    else { reply(f, callback(pending.challenge!.url)); await state(f, outcome); }
    const ended = f.service.readLoginAttempt(f.handle); expect(f.service.startLoginAttempt(f.handle)).toEqual(ended); f.service.disposeLoginAttempt(f.handle);
    clock.mockReturnValue(now + 599_999); f.service.reserveLoginAttempt();
    expect(f.service.readLoginAttempt(f.handle)).toEqual(ended);
    expect(ended.expiresAt).toBeGreaterThan(0);
    expect((await f.service.closeLoginAttempt(f.handle)).outcome).toBe(outcome === 'saved' ? 'already-committed' : outcome === 'unknown' ? 'unknown' : 'closed');
    clock.mockReturnValue(now + 600_001); f.service.reserveLoginAttempt();
    expect(() => f.service.readLoginAttempt(f.handle)).toThrow('unknown-handle');
  });
  it('review R3: reservation publishes its unchanged five-minute server expiry', async () => {
    const f = await fixture(), now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now);
    const reserved = f.service.reserveLoginAttempt();
    expect(reserved.expiresAt).toBe(now + 300_000); expect(f.service.readLoginAttempt(reserved.handle)).toEqual(reserved);
  });
  it('review R3: full capacity rejects reserve while all terminal receipts are retained', async () => {
    const f = await fixture(); f.service.startLoginAttempt(f.handle); await state(f, 'awaiting-user'); await f.service.closeLoginAttempt(f.handle);
    for (let i = 0; i < 127; i++) f.service.reserveLoginAttempt();
    expect(() => f.service.reserveLoginAttempt()).toThrow('too-many-attempts'); expect(f.service.readLoginAttempt(f.handle).status).toBe('closed');
  });
  it.each(['', null, false, 0])('review R4: existing falsy deviceId %j is rejected before the official generator, leaving bytes unchanged', async deviceId => {
    const f = await fixture(), settings = join(f.agent, 'settings.json'), bytes = JSON.stringify({ deviceId, unrelated: 'synthetic-retain' }, null, 2);
    await writeFile(settings, bytes);
    const generate = vi.spyOn(SettingsManager.prototype, 'getOrCreateDeviceId');
    f.service.startLoginAttempt(f.handle); await state(f, 'failed');
    expect(f.service.readLoginAttempt(f.handle).error).toBe('device-settings-invalid'); expect(generate).not.toHaveBeenCalled();
    expect(await readFile(settings, 'utf8')).toBe(bytes); expect(network).not.toHaveBeenCalled();
  });
  it('review R4: an existing valid global UUID survives unchanged while project settings remain untrusted', async () => {
    const f = await fixture(), settings = join(f.agent, 'settings.json'), deviceId = '12345678-1234-5678-90ab-1234567890ab';
    const bytes = JSON.stringify({ deviceId, unrelated: 'synthetic-retain' }, null, 2); await writeFile(settings, bytes);
    await mkdir(join(f.project, '.pi')); await writeFile(join(f.project, '.pi', 'settings.json'), JSON.stringify({ deviceId: null }));
    const create = vi.spyOn(SettingsManager, 'create'), generate = vi.spyOn(SettingsManager.prototype, 'getOrCreateDeviceId'), flush = vi.spyOn(SettingsManager.prototype, 'flush');
    f.service.startLoginAttempt(f.handle); const pending = await state(f, 'awaiting-user');
    expect(create).toHaveBeenCalledWith(f.project, f.agent, { projectTrusted: false }); expect(generate).toHaveBeenCalledOnce(); expect(flush).toHaveBeenCalledOnce();
    expect(new URL(pending.challenge!.url).searchParams.get('ext_agent_host_id')).toBe(`urn:uuid:${deviceId}`);
    expect(await readFile(settings, 'utf8')).toBe(bytes);
  });
  it.each(['before-native-callback', 'after-callback-before-write'] as const)('cancellation evidence: Close at %s waits for the actual official lock operation and prevents native write', async boundary => {
    const f = await fixture(), before = await readFile(f.auth, 'utf8'), { AuthStorage } = await loadPiNativeAuthStorage(), modify = AuthStorage.prototype.modify;
    const entered = deferred<void>(), release = deferred<void>(); let signal: AbortSignal | undefined;
    type NativeBackend = { withLockAsync(fn: (content: string | undefined) => Promise<{ result: unknown; next?: string }>, options?: { signal?: AbortSignal }): Promise<unknown> };
    vi.spyOn(AuthStorage.prototype, 'modify').mockImplementation(function(this: typeof AuthStorage.prototype, provider, fn, options) {
      signal = options?.signal;
      if (boundary === 'before-native-callback') return modify.call(this, provider, async current => {
        entered.resolve(); await release.promise; return fn(current);
      }, options);
      // Hold only the callback result; the official backend still owns its real lock, abort check and writer.
      const backend = (this as unknown as { storage: NativeBackend }).storage, withLock = backend.withLockAsync;
      vi.spyOn(backend, 'withLockAsync').mockImplementation((action, nativeOptions) => withLock.call(backend, async content => {
        const candidate = await action(content); expect(candidate.next).toContain('synthetic-new-access');
        entered.resolve(); await release.promise; return candidate;
      }, nativeOptions));
      return modify.call(this, provider, fn, options);
    });
    try {
      f.service.startLoginAttempt(f.handle); const pending = await state(f, 'awaiting-user'); reply(f, callback(pending.challenge!.url)); await entered.promise;
      expect(await readdir(f.agent)).toContain('auth.json.lock');
      let done = false; const closing = f.service.closeLoginAttempt(f.handle).then(result => { done = true; return result; });
      expect(signal).toBe(network.mock.calls[0][1].signal); expect(signal?.aborted).toBe(true);
      expect(f.service.startLoginAttempt(f.handle)).toEqual(f.service.readLoginAttempt(f.handle));
      await Promise.resolve(); expect(done).toBe(false); expect(JSON.parse(await readFile(f.record, 'utf8')).pendingLogin.closed).toBe(true);
      expect(await readFile(f.auth, 'utf8')).toBe(before); release.resolve(); expect((await closing).outcome).toBe('closed');
      expect(await readFile(f.auth, 'utf8')).toBe(before); expect(await readdir(f.agent)).not.toContain('auth.json.lock');
      expect(JSON.parse(await readFile(f.record, 'utf8')).pendingLogin).toBeUndefined();
    } finally { release.resolve(); }
  });
  it('cold missing auth starts a ticket without inventing OAuth and the official writer saves the first grant', async () => {
    const f = await fixture({}, true); expect(await readdir(f.agent)).toEqual([]);
    f.service.startLoginAttempt(f.handle); const pending = await state(f, 'awaiting-user');
    expect(JSON.parse(await readFile(f.record, 'utf8'))).toMatchObject({ credentialRef: null, localState: 'unknown', authGeneration: 1 });
    expect(await readdir(f.agent)).not.toContain('auth.json');
    reply(f, callback(pending.challenge!.url)); await state(f, 'saved');
    expect(JSON.parse(await readFile(f.auth, 'utf8')).openai.access).toBe('synthetic-new-access');
  });
  it.each(['null', '[]', '42', '{broken'])('start rejects raw root %s before creating a ticket or settings', async content => {
    const f = await fixture({}); await writeFile(f.auth, content);
    expect(f.service.startLoginAttempt(f.handle)).toMatchObject({ status: 'failed', error: 'storage-failed' });
    expect(await readdir(f.agent)).toEqual(['auth.json']); expect(await readFile(f.auth, 'utf8')).toBe(content); expect(network).not.toHaveBeenCalled();
  });
  it('Close waits through actual native write and returns already-committed when save preceded Close', async () => {
    const f = await fixture(), { AuthStorage } = await loadPiNativeAuthStorage(), original = AuthStorage.prototype.modify;
    const committed = deferred<void>(), release = deferred<void>();
    vi.spyOn(AuthStorage.prototype, 'modify').mockImplementation(async function(this: typeof AuthStorage.prototype, ...args) {
      const result = await original.call(this, ...args); committed.resolve(); await release.promise; return result;
    });
    try {
      f.service.startLoginAttempt(f.handle); const pending = await state(f, 'awaiting-user'); reply(f, callback(pending.challenge!.url)); await committed.promise;
      let closed = false; const closing = f.service.closeLoginAttempt(f.handle).then(result => { closed = true; return result; });
      expect(closed).toBe(false); expect(JSON.parse(await readFile(f.record, 'utf8')).pendingLogin.closed).toBe(true);
      expect(JSON.parse(await readFile(f.auth, 'utf8')).openai.access).toBe('synthetic-new-access');
      release.resolve(); expect((await closing).outcome).toBe('already-committed'); expect(JSON.parse(await readFile(f.record, 'utf8')).pendingLogin).toBeUndefined();
    } finally { release.resolve(); }
  });
  it('a native Promise rejection after commit reports unknown and never compensates with delete', async () => {
    const f = await fixture(), { AuthStorage } = await loadPiNativeAuthStorage(), original = AuthStorage.prototype.modify;
    const deleteAuth = vi.spyOn(AuthStorage.prototype, 'delete');
    vi.spyOn(AuthStorage.prototype, 'modify').mockImplementation(async function(this: typeof AuthStorage.prototype, ...args) {
      await original.call(this, ...args); throw Object.assign(new Error('save-after-commit-sentinel'), { code: 'EIO' });
    });
    f.service.startLoginAttempt(f.handle); const pending = await state(f, 'awaiting-user'); reply(f, callback(pending.challenge!.url)); await state(f, 'unknown');
    expect(f.service.readLoginAttempt(f.handle).error).toBe('storage-failed'); expect((await f.service.closeLoginAttempt(f.handle)).outcome).toBe('unknown');
    expect(JSON.parse(await readFile(f.auth, 'utf8')).openai.access).toBe('synthetic-new-access'); expect(deleteAuth).not.toHaveBeenCalled();
  });
  it('official native writeFileSync EIO is a safe failed save; OAuth bytes and other providers survive', async () => {
    const f = await fixture(), before = await readFile(f.auth, 'utf8'), fs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
    const write = fs.writeFileSync;
    vi.spyOn(fs, 'writeFileSync').mockImplementation((path, data, options) => {
      if (String(path) === f.auth) throw Object.assign(new Error('native-write-sentinel'), { code: 'EIO' }); return write(path, data, options);
    }); syncBuiltinESMExports();
    f.service.startLoginAttempt(f.handle); const pending = await state(f, 'awaiting-user'); reply(f, callback(pending.challenge!.url)); await state(f, 'failed');
    expect(f.service.readLoginAttempt(f.handle).error).toBe('storage-failed'); expect(await readFile(f.auth, 'utf8')).toBe(before);
    expect(JSON.parse(await readFile(f.record, 'utf8')).pendingLogin).toBeUndefined();
  });
  it('official SettingsManager persistence EIO is drained before listener or token exchange', async () => {
    const f = await fixture(), fs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs'), write = fs.writeFileSync;
    vi.spyOn(fs, 'writeFileSync').mockImplementation((path, data, options) => {
      if (String(path) === join(f.agent, 'settings.json')) throw Object.assign(new Error('global-settings-sentinel'), { code: 'EIO' }); return write(path, data, options);
    }); syncBuiltinESMExports();
    f.service.startLoginAttempt(f.handle); await state(f, 'failed'); expect(f.service.readLoginAttempt(f.handle).error).toBe('device-settings-invalid');
    expect(network).not.toHaveBeenCalled();
  });
  it('reserve/read/dispose/unknown handles/logout create no ticket, settings, auth or listener', async () => {
    const f = await fixture({}); const inventory = await readdir(f.agent), before = await readFile(f.auth, 'utf8');
    expect(f.service.readLoginAttempt(f.handle)).toMatchObject({ harnessId: 'pi', status: 'reserved', challenge: null, canReply: false });
    f.service.disposeLoginAttempt(f.handle);
    for (const action of [() => f.service.readLoginAttempt('unknown'), () => f.service.startLoginAttempt('unknown'),
      () => f.service.replyLoginAttempt('unknown', { promptId: 'not-issued', callbackUrl: 'raw-url-sentinel' }), () => f.service.disposeLoginAttempt('unknown')]) expect(action).toThrow('unknown-handle');
    await expect(f.service.closeLoginAttempt('unknown')).rejects.toThrow('unknown-handle'); expect(() => f.service.logout()).toThrow('unsupported');
    expect(await readdir(f.agent)).toEqual(inventory); expect(await readFile(f.auth, 'utf8')).toBe(before); expect(network).not.toHaveBeenCalled();
  });
  it('only unstarted reservations expire; started attempts remain pending after that age', async () => {
    const f = await fixture(), clock = vi.spyOn(Date, 'now'), started = Date.now(); clock.mockReturnValue(started + 5 * 60_000);
    expect(() => f.service.startLoginAttempt(f.handle)).toThrow('attempt-expired');
    clock.mockReturnValue(started); f.handle = f.service.reserveLoginAttempt().handle; services.push({ service: f.service, handle: f.handle });
    f.service.startLoginAttempt(f.handle); await state(f, 'awaiting-user');
    clock.mockReturnValue(started + 24 * 60 * 60_000); expect(f.service.readLoginAttempt(f.handle).status).toBe('awaiting-user');
    expect(JSON.parse(await readFile(f.record, 'utf8')).pendingLogin).toBeDefined(); expect(network).not.toHaveBeenCalled();
  });
  it('official manual callback saves only OAuth, retains other providers and stable global deviceId', async () => {
    const f = await fixture(), owner = await PiAuthenticationOwner.create(f.project), old = await owner.admit();
    f.handle = f.service.reserveLoginAttempt(f.service.readLoginExpectation()).handle; services.push({ service: f.service, handle: f.handle });
    await mkdir(join(f.project, '.pi')); await writeFile(join(f.project, '.pi', 'settings.json'), JSON.stringify({ deviceId: 'bad-project-id' }));
    const { AuthStorage } = await loadPiNativeAuthStorage(), modify = AuthStorage.prototype.modify, signals: AbortSignal[] = [];
    vi.spyOn(AuthStorage.prototype, 'modify').mockImplementation(function(this: typeof AuthStorage.prototype, provider, fn, options) {
      signals.push(options!.signal!); return modify.call(this, provider, fn, options);
    });
    f.service.startLoginAttempt(f.handle); const pending = await state(f, 'awaiting-user');
    const ticket = JSON.parse(await readFile(f.record, 'utf8'));
    expect(ticket).toMatchObject({ localState: 'unknown', authGeneration: old.authGeneration + 1, pendingLogin: { kind: 'login', closed: false } });
    expect(ticket.pendingLogin).toMatchObject({ authContextRef: ticket.authContextRef, connectionRef: ticket.connectionRef, authGeneration: ticket.authGeneration });
    await expect(owner.lease({ harnessId: 'pi', authContextRef: old.authContextRef, connectionRef: old.connection.connectionRef, authGeneration: old.authGeneration }).guard()).rejects.toThrow();
    const id = JSON.parse(await readFile(join(f.agent, 'settings.json'), 'utf8')).deviceId;
    expect(new URL(pending.challenge!.url).searchParams.get('ext_agent_host_id')).toBe(`urn:uuid:${id}`);
    expect(new URL(pending.challenge!.url).searchParams.get('agent_name_hint')).toBe('Pi');
    reply(f, callback(pending.challenge!.url)); await state(f, 'saved');
    const saved = JSON.parse(await readFile(f.auth, 'utf8')); expect(saved.other.key).toBe('synthetic-preserve');
    expect(saved.openai).toMatchObject({ type: 'oauth', access: 'synthetic-new-access', refresh: 'synthetic-new-refresh', clientId: 'synthetic-issued-client' });
    expect(signals[0]).toBe(network.mock.calls[0][1].signal); expect(JSON.parse(await readFile(f.record, 'utf8')).pendingLogin).toBeUndefined();
    const dto = JSON.stringify(f.service.readLoginAttempt(f.handle)); for (const secret of ['synthetic-', 'callback', 'deviceId', 'credentialRef']) expect(dto).not.toContain(secret);
    expect(Object.isFrozen(f.service.readLoginAttempt(f.handle))).toBe(true);
    expect((await f.service.closeLoginAttempt(f.handle)).outcome).toBe('already-committed');
    const next = f.service.reserveLoginAttempt(f.service.readLoginExpectation()); f.handle = next.handle; services.push({ service: f.service, handle: f.handle });
    f.service.startLoginAttempt(f.handle); const again = await state(f, 'awaiting-user');
    expect(new URL(again.challenge!.url).searchParams.get('ext_agent_host_id')).toBe(`urn:uuid:${id}`);
  });
  it('wrong-state callback does not settle; the correct official HTTP callback completes login', async () => {
    const f = await fixture(); f.service.startLoginAttempt(f.handle); const pending = await state(f, 'awaiting-user');
    expect(await http(callback(pending.challenge!.url, 'wrong-state-sentinel'))).toBe(400);
    expect(f.service.readLoginAttempt(f.handle).status).toBe('awaiting-user'); expect(network).not.toHaveBeenCalled();
    expect(await http(callback(pending.challenge!.url))).toBe(200); await state(f, 'saved');
  });
  it.each(['http://wrong.example/auth/callback', 'http://127.0.0.1:1455/wrong', 'wrong-state'] as const)('official manual parser rejects %s without returning raw errors', async wrong => {
    const f = await fixture(), before = await readFile(f.auth, 'utf8'); f.service.startLoginAttempt(f.handle); const pending = await state(f, 'awaiting-user');
    reply(f, wrong === 'wrong-state' ? callback(pending.challenge!.url, 'wrong-state') : wrong);
    await state(f, 'failed'); expect(f.service.readLoginAttempt(f.handle)).toMatchObject({ challenge: null, error: 'login-failed' });
    expect(await readFile(f.auth, 'utf8')).toBe(before); expect(network).not.toHaveBeenCalled();
  });
  it('detach, unmount and another project/service cannot stop or replace an active login', async () => {
    const f = await fixture(); f.service.startLoginAttempt(f.handle); await state(f, 'awaiting-user');
    const unsubscribe = f.service.subscribeLoginAttempt(f.handle, () => { throw new Error('host-failure-sentinel'); }); unsubscribe(); f.service.disposeLoginAttempt(f.handle);
    const project = join(f.dir, 'other-project'); await mkdir(project); const other = await PiAccountService.create(project), reserved = other.reserveLoginAttempt();
    expect(() => other.startLoginAttempt(reserved.handle)).toThrow('scope-busy');
    expect(() => other.readLoginAttempt(f.handle)).toThrow('unknown-handle');
    expect(f.service.readLoginAttempt(f.handle).status).toBe('awaiting-user'); expect(JSON.parse(await readFile(f.record, 'utf8')).pendingLogin.closed).toBe(false);
    f.service.subscribeLoginAttempt(f.handle, () => { throw new Error('host-failure-sentinel'); });
    const challenge = f.service.readLoginAttempt(f.handle).challenge!.url; reply(f, callback(challenge)); await state(f, 'saved');
  });
  it('Close during PKCE/listener startup latches first and immediate prompt rejection releases the official port', async () => {
    const f = await fixture(), before = await readFile(f.auth, 'utf8'); f.service.startLoginAttempt(f.handle);
    const result = await f.service.closeLoginAttempt(f.handle); expect(result.outcome).toBe('closed');
    expect(await readFile(f.auth, 'utf8')).toBe(before); expect(JSON.parse(await readFile(f.record, 'utf8')).pendingLogin).toBeUndefined();
    const server = createServer(); await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(1455, '127.0.0.1', resolve); });
    await new Promise<void>(resolve => server.close(() => resolve())); expect(network).not.toHaveBeenCalled();
  });
  it('a host Close inside official auth_url notification makes the following prompt reject asynchronously and cleans the port', async () => {
    const f = await fixture(), closing = deferred<ReturnType<PiAccountService['closeLoginAttempt']>>();
    f.service.subscribeLoginAttempt(f.handle, attempt => { if (attempt.challenge) closing.resolve(f.service.closeLoginAttempt(f.handle)); });
    f.service.startLoginAttempt(f.handle); expect((await (await closing.promise)).outcome).toBe('closed');
    const server = createServer(); await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(1455, '127.0.0.1', resolve); });
    await new Promise<void>(resolve => server.close(() => resolve())); expect(network).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(f.record, 'utf8')).pendingLogin).toBeUndefined();
  });
  it('Close after listener creation closes spare sockets and does not change auth bytes', async () => {
    const f = await fixture(), before = await readFile(f.auth, 'utf8'); f.service.startLoginAttempt(f.handle); await state(f, 'awaiting-user');
    const socket = connect(1455, '127.0.0.1'); await new Promise<void>(resolve => socket.once('connect', resolve));
    const destroyed = new Promise<void>(resolve => socket.once('close', () => resolve()));
    expect((await f.service.closeLoginAttempt(f.handle)).outcome).toBe('closed'); await destroyed;
    expect(await readFile(f.auth, 'utf8')).toBe(before); expect(network).not.toHaveBeenCalled();
  });
  it('Close waits for the actual token Promise and retains exclusion until it settles', async () => {
    const f = await fixture(), response = deferred<Response>(), entered = deferred<void>(), before = await readFile(f.auth, 'utf8');
    network.mockImplementation(async () => { entered.resolve(); return response.promise; });
    f.service.startLoginAttempt(f.handle); const pending = await state(f, 'awaiting-user'); reply(f, callback(pending.challenge!.url)); await entered.promise;
    let done = false; const closing = f.service.closeLoginAttempt(f.handle).then(result => { done = true; return result; });
    expect(done).toBe(false); expect(f.service.readLoginAttempt(f.handle)).toMatchObject({ status: 'closing', canReply: false, challenge: null });
    expect(JSON.parse(await readFile(f.record, 'utf8')).pendingLogin.closed).toBe(true);
    const owner = await PiAuthenticationOwner.create(f.project); await expect(owner.admit()).rejects.toThrow();
    response.resolve(token()); expect((await closing).outcome).toBe('closed'); expect(await readFile(f.auth, 'utf8')).toBe(before);
  });
  it('occupied callback port fails safely without exchange, native save or compensating delete', async () => {
    const f = await fixture(), before = await readFile(f.auth, 'utf8'), occupied = createServer();
    await new Promise<void>((resolve, reject) => { occupied.once('error', reject); occupied.listen(1455, '127.0.0.1', resolve); });
    try { f.service.startLoginAttempt(f.handle); await state(f, 'failed'); expect(f.service.readLoginAttempt(f.handle).error).toBe('login-failed'); }
    finally { await new Promise<void>(resolve => occupied.close(() => resolve())); }
    expect(await readFile(f.auth, 'utf8')).toBe(before); expect(network).not.toHaveBeenCalled();
  });
  it.each(['malformed', 'invalid-device'] as const)('official global settings %s is a finite failure before OAuth exchange', async mode => {
    const f = await fixture(), before = await readFile(f.auth, 'utf8');
    await writeFile(join(f.agent, 'settings.json'), mode === 'malformed' ? '{bad' : JSON.stringify({ deviceId: 'device-sentinel' }));
    f.service.startLoginAttempt(f.handle); await state(f, 'failed'); expect(f.service.readLoginAttempt(f.handle).error).toBe('device-settings-invalid');
    expect(await readFile(f.auth, 'utf8')).toBe(before); expect(network).not.toHaveBeenCalled();
  });
  it('official SettingsManager flush drains queued persistence failures before starting OAuth', async () => {
    const f = await fixture(); const actual = SettingsManager.prototype.drainErrors; let drains = 0;
    const spy = vi.spyOn(SettingsManager.prototype, 'drainErrors').mockImplementation(function(this: SettingsManager) {
      if (++drains === 2) return [{ scope: 'global', error: new Error('settings-save-sentinel') }]; return actual.call(this);
    });
    const flush = vi.spyOn(SettingsManager.prototype, 'flush'); f.service.startLoginAttempt(f.handle); await state(f, 'failed');
    expect(flush).toHaveBeenCalledOnce(); expect(spy).toHaveBeenCalledTimes(2); expect(f.service.readLoginAttempt(f.handle).error).toBe('device-settings-invalid');
    expect(network).not.toHaveBeenCalled();
  });
  it('start rejects stale user-observed CAS instead of silently replacing a newer owner', async () => {
    const f = await fixture(), owner = await PiAuthenticationOwner.create(f.project); await owner.admit();
    const expectation = f.service.readLoginExpectation()!;
    f.handle = f.service.reserveLoginAttempt(expectation).handle; services.push({ service: f.service, handle: f.handle });
    const current = JSON.parse(await readFile(f.record, 'utf8')); await writeFile(f.record, JSON.stringify({ ...current, authGeneration: current.authGeneration + 1 }));
    const before = await readFile(f.record, 'utf8'), auth = await readFile(f.auth, 'utf8');
    expect(f.service.startLoginAttempt(f.handle)).toMatchObject({ status: 'failed', error: 'owner-changed' });
    expect(await readFile(f.record, 'utf8')).toBe(before); expect(await readFile(f.auth, 'utf8')).toBe(auth); expect(network).not.toHaveBeenCalled();
  });
  it('an omitted expectation means no observed owner; it cannot overwrite an existing owner', async () => {
    const f = await fixture(), owner = await PiAuthenticationOwner.create(f.project); await owner.admit();
    const before = await readFile(f.record, 'utf8'); expect(f.service.startLoginAttempt(f.handle)).toMatchObject({ status: 'failed', error: 'owner-changed' });
    expect(await readFile(f.record, 'utf8')).toBe(before); expect(network).not.toHaveBeenCalled();
  });
  it('service-local handle records stay bounded without evicting an active attempt', async () => {
    const f = await fixture(); f.service.startLoginAttempt(f.handle); await state(f, 'awaiting-user');
    for (let i = 0; i < 127; i++) f.service.reserveLoginAttempt();
    expect(() => f.service.reserveLoginAttempt()).toThrow('too-many-attempts'); expect(f.service.readLoginAttempt(f.handle).status).toBe('awaiting-user');
  });
  it.each(['symlink', 'hardlink'] as const)('login rejects a %s auth alias before issuing a split-scope ticket', async mode => {
    const f = await fixture(), other = join(f.dir, 'aliased-auth.json'), before = await readFile(f.auth, 'utf8');
    if (mode === 'symlink') { await rm(f.auth); await writeFile(other, before); await symlink(other, f.auth); }
    else await link(f.auth, other);
    const service = await PiAccountService.create(f.project), attempt = service.reserveLoginAttempt();
    expect(service.startLoginAttempt(attempt.handle)).toMatchObject({ status: 'failed', error: 'storage-failed' });
    expect(await readdir(f.agent)).toEqual(['auth.json']); expect(await readFile(other, 'utf8')).toBe(before); expect(network).not.toHaveBeenCalled();
  });
});
