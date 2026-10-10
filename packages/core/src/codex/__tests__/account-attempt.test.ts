import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createCodexAccountService, CodexLoginAttemptError, type CodexDeviceLogin } from '../account.js';
import { CodexAuthenticationOwner } from '../../runtime/auth/codex-owner.js';
import type { CodexClient, CodexNotificationListener } from '../app-server.js';

function deferred<T = void>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); syncBuiltinESMExports(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const login = (id = 'l1') => ({ type: 'chatgptDeviceCode', loginId: id, verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'SYNTHETIC' });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'inkos-attempt-')); roots.push(root);
  function peer() {
    let closed = false, notice: CodexNotificationListener = () => {}, gone: () => void = () => {};
    let sequence = 0;
    const request = vi.fn(async (method: string, _params?: unknown): Promise<unknown> => {
      if (method === 'account/login/start') return login(`l${++sequence}`);
      if (method === 'account/read') return { account: { type: 'chatgpt', email: 'fixture@example.test' } };
      return method === 'account/login/cancel' ? { status: 'canceled' } : {};
    });
    const client = { cwd: root, codexHome: root, get closed() { return closed; }, request,
      onNotification(listener: CodexNotificationListener) { notice = listener; return () => {}; },
      onClose(listener: () => void) { gone = listener; return () => {}; }, onRequest: () => () => {},
      close: vi.fn(async () => { closed = true; gone(); }),
    } as unknown as CodexClient;
    return { client, request, notify: (success = true, id = 'l1') => notice('account/login/completed', { success, loginId: id }),
      disconnect: () => { closed = true; gone(); } };
  }
  const first = peer(), factory = vi.fn(async () => first.client);
  const service = createCodexAccountService({ projectDir: root, clientFactory: factory });
  return { root, service, factory, peer, ...first, owner: () => new CodexAuthenticationOwner(first.client) };
}
async function suspendedStart() {
  const f = await fixture(), entered = deferred(), reply = deferred<unknown>();
  f.request.mockImplementation(async method => { if (method === 'account/login/start') { entered.resolve(); return reply.promise; } return method === 'account/login/cancel' ? { status: 'canceled' } : {}; });
  const handle = f.service.reserveDeviceLoginAttempt().attemptHandle;
  const start = f.service.startDeviceLogin({ attemptHandle: handle });
  const outcome = start.catch(error => error);
  await entered.promise;
  return { ...f, handle, start, outcome, reply };
}
function holdLoginCompletion() {
  const complete = CodexAuthenticationOwner.prototype.completeLogin, written = deferred(), resume = deferred();
  vi.spyOn(CodexAuthenticationOwner.prototype, 'completeLogin').mockImplementationOnce(async function (this: CodexAuthenticationOwner, ticket, client, onWritten) {
    const result = await complete.call(this, ticket, client, state => { onWritten?.(state); written.resolve(); });
    await resume.promise;
    return result;
  });
  return { written, resume };
}
async function httpAttempt() {
  const f = await fixture(), entered = deferred(), reply = deferred<unknown>(), closeEntered = deferred();
  const handle = f.service.reserveDeviceLoginAttempt().attemptHandle;
  f.request.mockImplementation(async method => { if (method === 'account/login/start') { entered.resolve(); return reply.promise; } return method === 'account/login/cancel' ? { status: 'canceled' } : {}; });
  let start!: Promise<CodexDeviceLogin>, outcome!: Promise<unknown>, close!: ReturnType<typeof f.service.closeDeviceLoginAttempt>;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      const { attemptHandle } = JSON.parse(Buffer.concat(chunks).toString());
      let operation: Promise<unknown>;
      if (request.url === '/start') { start = f.service.startDeviceLogin({ attemptHandle }); outcome = start.catch(error => error); operation = start; }
      else { close = f.service.closeDeviceLoginAttempt(attemptHandle); closeEntered.resolve(); operation = close; }
      // Client transport cancellation never becomes an instruction to the service.
      void operation.then(result => { if (!response.destroyed) response.end(JSON.stringify(result)); },
        () => { if (!response.destroyed) response.writeHead(409).end(); });
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing loopback address');
  return { ...f, handle, entered, closeEntered, reply, get outcome() { return outcome; }, get close() { return close; },
    send(path: string, signal: AbortSignal) { return fetch(`http://127.0.0.1:${address.port}/${path}`, { method: 'POST', body: JSON.stringify({ attemptHandle: handle }), signal }); },
    async shutdown() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await f.service.dispose(); } };
}

describe('exact Codex sign-in attempt', () => {
  it('reuses the healthy peer after durable logout and makes late Close/finish of H1 harmless to H2', async () => {
    const f = await fixture(), h1 = f.service.reserveDeviceLoginAttempt().attemptHandle;
    await f.service.startDeviceLogin({ attemptHandle: h1 });
    const before = f.owner().snapshot()!; await f.service.logout();
    const disconnected = f.owner().snapshot()!;
    expect(disconnected).toMatchObject({ localState: 'disconnected', authGeneration: before.authGeneration + 1, operationId: null });
    expect((await f.service.readAccount()).login).toBeNull();
    f.notify(true, 'l1'); expect(f.owner().snapshot()).toEqual(disconnected);
    const h2 = f.service.reserveDeviceLoginAttempt().attemptHandle;
    expect((await f.service.startDeviceLogin({ attemptHandle: h2 })).loginId).toBe('l2');
    const current = f.owner().snapshot(), rpcCount = f.request.mock.calls.length;
    expect(await f.service.closeDeviceLoginAttempt(h1)).toMatchObject({ state: 'superseded', cleanup: 'not-applicable' });
    f.notify(true, 'l1');
    expect(f.request).toHaveBeenCalledTimes(rpcCount); expect(f.client.close).not.toHaveBeenCalled();
    expect(f.owner().snapshot()).toEqual(current); expect((await f.service.readAccount()).login?.loginId).toBe('l2');
    expect(f.request.mock.calls.filter(([method]) => method === 'account/login/cancel')).toHaveLength(1);
    expect(f.request.mock.calls.filter(([method]) => method === 'account/logout')).toHaveLength(1);
    expect(f.factory).toHaveBeenCalledOnce(); await f.service.dispose();
  });

  it.each(['close-first', 'logout-first'] as const)('preserves exact Close rights around logout: %s', async order => {
    const f = await fixture(), h1 = f.service.reserveDeviceLoginAttempt().attemptHandle;
    await f.service.startDeviceLogin({ attemptHandle: h1 });
    let close: ReturnType<typeof f.service.closeDeviceLoginAttempt>, logout: Promise<void>;
    if (order === 'close-first') { close = f.service.closeDeviceLoginAttempt(h1); logout = f.service.logout(); }
    else { logout = f.service.logout(); close = f.service.closeDeviceLoginAttempt(h1); }
    await logout; const result = await close;
    expect(result).toMatchObject(order === 'close-first' ? { state: 'closed', cleanup: 'cancel-acknowledged' } : { state: 'superseded', cleanup: 'not-applicable' });
    expect(f.owner().snapshot()).toMatchObject({ localState: 'disconnected', operationId: null });
    const h2 = f.service.reserveDeviceLoginAttempt().attemptHandle;
    await f.service.startDeviceLogin({ attemptHandle: h2 }); const current = f.owner().snapshot(), count = f.request.mock.calls.length;
    expect(await f.service.closeDeviceLoginAttempt(h1)).toBe(result);
    expect(f.request).toHaveBeenCalledTimes(count); expect(f.client.close).not.toHaveBeenCalled(); expect(f.owner().snapshot()).toEqual(current);
    expect(f.request.mock.calls.filter(([method]) => method === 'account/login/cancel')).toHaveLength(1);
    await f.service.dispose();
  });

  it('waits for late finishLogin settlement without restoring the logged-out status or retiring its healthy peer', async () => {
    const f = await fixture(), h1 = f.service.reserveDeviceLoginAttempt().attemptHandle, entered = deferred(), account = deferred<unknown>();
    await f.service.startDeviceLogin({ attemptHandle: h1 });
    const native = f.request.getMockImplementation()!; let firstRead = true;
    f.request.mockImplementation(async (method, params) => {
      if (method === 'account/read' && firstRead) { firstRead = false; entered.resolve(); return account.promise; }
      return native(method, params);
    });
    f.notify(true, 'l1'); await entered.promise; await f.service.logout(); const disconnected = f.owner().snapshot();
    const h2 = f.service.reserveDeviceLoginAttempt().attemptHandle;
    await expect(f.service.startDeviceLogin({ attemptHandle: h2 })).rejects.toMatchObject({ code: 'CODEX_LOGIN_ATTEMPT_BUSY' });
    account.resolve({ account: { type: 'chatgpt', email: 'fixture@example.test' } });
    expect((await f.service.readAccount()).login).toBeNull(); expect(f.owner().snapshot()).toEqual(disconnected);
    await f.service.startDeviceLogin({ attemptHandle: h2 }); const current = f.owner().snapshot(), count = f.request.mock.calls.length;
    expect(await f.service.closeDeviceLoginAttempt(h1)).toMatchObject({ state: 'superseded', cleanup: 'not-applicable' });
    expect(f.request).toHaveBeenCalledTimes(count); expect(f.owner().snapshot()).toEqual(current); expect(f.client.close).not.toHaveBeenCalled();
    await f.service.dispose();
  });

  it.each(['logout-rpc', 'CAS-lost', 'CAS-error'] as const)('does not grant terminal proof after %s', async mode => {
    const f = await fixture(), h1 = f.service.reserveDeviceLoginAttempt().attemptHandle;
    await f.service.startDeviceLogin({ attemptHandle: h1 }); const failure = new Error(mode);
    if (mode === 'logout-rpc') f.request.mockImplementation(async method => { if (method === 'account/logout') throw failure; return { status: 'canceled' }; });
    else {
      const complete = CodexAuthenticationOwner.prototype.complete;
      vi.spyOn(CodexAuthenticationOwner.prototype, 'complete').mockImplementation(function (this: CodexAuthenticationOwner, ticket, state, written) {
        if (state === 'disconnected') { if (mode === 'CAS-error') throw failure; return false; }
        return complete.call(this, ticket, state, written);
      });
    }
    if (mode === 'CAS-lost') await f.service.logout(); else await expect(f.service.logout()).rejects.toBe(failure);
    expect(f.owner().snapshot()?.localState).not.toBe('disconnected');
    f.notify(true, 'l1'); const h2 = f.service.reserveDeviceLoginAttempt().attemptHandle;
    await expect(f.service.startDeviceLogin({ attemptHandle: h2 })).rejects.toMatchObject({ code: 'CODEX_LOGIN_ATTEMPT_BUSY' });
    expect(f.request.mock.calls.filter(([method]) => method === 'account/login/start')).toHaveLength(1);
    await f.service.dispose();
  });

  it.each(['same-pending', 'same-rejected', 'replacement-pending', 'replacement-rejected'] as const)('does not bypass original peer retirement after logout: %s', async mode => {
    const f = await fixture(), h1 = f.service.reserveDeviceLoginAttempt().attemptHandle, exit = deferred(), failure = new Error('Original close failed');
    await f.service.startDeviceLogin({ attemptHandle: h1 });
    vi.mocked(f.client.close).mockImplementation(() => exit.promise);
    const internals = f.service as unknown as { closePeer(peer: CodexClient): Promise<void> };
    const retiring = internals.closePeer(f.client); void retiring.catch(() => undefined);
    const second = f.peer();
    if (mode.startsWith('replacement')) { f.disconnect(); f.factory.mockResolvedValueOnce(second.client); }
    await f.service.logout();
    const h2 = f.service.reserveDeviceLoginAttempt().attemptHandle;
    await expect(f.service.startDeviceLogin({ attemptHandle: h2 })).rejects.toMatchObject({ code: 'CODEX_LOGIN_ATTEMPT_BUSY' });
    expect(await f.service.closeDeviceLoginAttempt(h1)).toMatchObject({ state: 'superseded', cleanup: 'not-applicable' });
    expect(second.client.close).not.toHaveBeenCalled();
    if (mode.endsWith('rejected')) {
      exit.reject(failure); await expect(retiring).rejects.toBe(failure);
      await expect(f.service.startDeviceLogin({ attemptHandle: h2 })).rejects.toMatchObject({ code: 'CODEX_LOGIN_ATTEMPT_BUSY' });
      await expect(f.service.dispose()).rejects.toBe(failure);
    } else {
      if (!mode.startsWith('replacement')) f.factory.mockResolvedValueOnce(second.client);
      exit.resolve(); await retiring;
      await f.service.startDeviceLogin({ attemptHandle: h2 }); const current = f.owner().snapshot(), count = second.request.mock.calls.length;
      await f.service.closeDeviceLoginAttempt(h1);
      expect(f.owner().snapshot()).toEqual(current); expect(second.request).toHaveBeenCalledTimes(count); expect(second.client.close).not.toHaveBeenCalled();
      await f.service.dispose();
    }
    expect(f.client.close).toHaveBeenCalledOnce();
  });

  it('reserves only bounded metadata and ignores foreign handles without peer/RPC/owner', async () => {
    const f = await fixture();
    const reservation = f.service.reserveDeviceLoginAttempt();
    expect(Object.isFrozen(reservation)).toBe(true); expect(reservation.expiresAt).toBeGreaterThan(Date.now());
    await expect(f.service.startDeviceLogin({ attemptHandle: randomUUID() })).rejects.toMatchObject({ code: 'CODEX_LOGIN_ATTEMPT_UNKNOWN_OR_EXPIRED' });
    await expect(f.service.startDeviceLogin({ attemptHandle: reservation.attemptHandle, home: '/foreign' } as never)).rejects.toMatchObject({ code: 'CODEX_LOGIN_ATTEMPT_INVALID' });
    expect((await f.service.closeDeviceLoginAttempt(randomUUID())).state).toBe('unknown-or-expired');
    expect(f.factory).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled(); expect(await readdir(f.root)).toEqual([]);
    await f.service.dispose();
  });
  it('enforces capacity/unused expiry and ten-minute tombstones', async () => {
    const f = await fixture(); let now = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => now);
    const handles = Array.from({ length: 128 }, () => f.service.reserveDeviceLoginAttempt());
    expect(() => f.service.reserveDeviceLoginAttempt()).toThrowError(CodexLoginAttemptError);
    now += 120_000;
    await expect(f.service.startDeviceLogin({ attemptHandle: handles[0].attemptHandle })).rejects.toMatchObject({ code: 'CODEX_LOGIN_ATTEMPT_UNKNOWN_OR_EXPIRED' });
    const reserved = f.service.reserveDeviceLoginAttempt();
    const result = await f.service.closeDeviceLoginAttempt(reserved.attemptHandle);
    expect(result).toMatchObject({ state: 'closed', cleanup: 'not-started' });
    now += 599_999; expect(await f.service.closeDeviceLoginAttempt(reserved.attemptHandle)).toBe(result);
    now += 1; expect((await f.service.closeDeviceLoginAttempt(reserved.attemptHandle)).state).toBe('unknown-or-expired');
    expect(f.factory).not.toHaveBeenCalled(); await f.service.dispose();
  });
  it('deduplicates the exact start promise and blocks a different handle and legacy start', async () => {
    const f = await suspendedStart();
    expect(f.service.startDeviceLogin({ attemptHandle: f.handle })).toBe(f.start);
    const other = f.service.reserveDeviceLoginAttempt().attemptHandle;
    await expect(f.service.startDeviceLogin({ attemptHandle: other })).rejects.toMatchObject({ code: 'CODEX_LOGIN_ATTEMPT_BUSY' });
    await expect(f.service.startDeviceLogin()).rejects.toMatchObject({ code: 'CODEX_LOGIN_ATTEMPT_BUSY' });
    f.reply.resolve(login()); await f.start;
    expect(f.request.mock.calls.filter(([method]) => method === 'account/login/start')).toHaveLength(1);
    await f.service.closeDeviceLoginAttempt(f.handle); await f.service.dispose();
  });
  it('closes a reservation before start without changing owner or dispatching', async () => {
    const f = await fixture(), handle = f.service.reserveDeviceLoginAttempt().attemptHandle;
    const close = f.service.closeDeviceLoginAttempt(handle);
    expect(f.service.closeDeviceLoginAttempt(handle)).toBe(close);
    expect(await close).toMatchObject({ state: 'closed', cleanup: 'not-started' });
    await expect(f.service.startDeviceLogin({ attemptHandle: handle })).rejects.toMatchObject({ code: 'CODEX_LOGIN_ATTEMPT_CLOSED' });
    expect(f.factory).not.toHaveBeenCalled(); expect(await readdir(f.root)).toEqual([]); await f.service.dispose();
  });
  it('closes while peer creation is suspended and never creates a ticket', async () => {
    const f = await fixture(), entered = deferred(), peer = deferred<CodexClient>();
    f.factory.mockImplementation(async () => { entered.resolve(); return peer.promise; });
    const handle = f.service.reserveDeviceLoginAttempt().attemptHandle;
    const start = f.service.startDeviceLogin({ attemptHandle: handle }).catch(error => error); await entered.promise;
    const close = f.service.closeDeviceLoginAttempt(handle); peer.resolve(f.client);
    expect(await start).toMatchObject({ code: 'CODEX_LOGIN_ATTEMPT_CLOSED' });
    expect(await close).toMatchObject({ state: 'closed', cleanup: 'not-started' });
    expect(f.request).not.toHaveBeenCalled(); expect(await readdir(f.root)).toEqual([]); await f.service.dispose();
  });
  it('closes a queued start and a ticket created immediately before dispatch', async () => {
    const f = await fixture(), gate = deferred(), entered = deferred();
    const queued = (f.service as unknown as { exclusive<T>(fn: () => Promise<T>): Promise<T> }).exclusive(async () => { entered.resolve(); await gate.promise; });
    await entered.promise;
    const handle = f.service.reserveDeviceLoginAttempt().attemptHandle;
    const start = f.service.startDeviceLogin({ attemptHandle: handle }).catch(error => error);
    const close = f.service.closeDeviceLoginAttempt(handle); gate.resolve(); await queued;
    expect(await start).toMatchObject({ code: 'CODEX_LOGIN_ATTEMPT_CLOSED' });
    expect((await close).cleanup).toBe('not-started'); expect(f.factory).not.toHaveBeenCalled();
    const next = f.service.reserveDeviceLoginAttempt().attemptHandle;
    let closed!: ReturnType<typeof f.service.closeDeviceLoginAttempt>;
    const begin = CodexAuthenticationOwner.prototype.begin;
    vi.spyOn(CodexAuthenticationOwner.prototype, 'begin').mockImplementation(function (this: CodexAuthenticationOwner, replace, onWritten) {
      const ticket = begin.call(this, replace, onWritten); closed = f.service.closeDeviceLoginAttempt(next); return ticket;
    });
    await expect(f.service.startDeviceLogin({ attemptHandle: next })).rejects.toMatchObject({ code: 'CODEX_LOGIN_ATTEMPT_CLOSED' });
    expect((await closed).cleanup).toBe('not-started'); expect(f.owner().snapshot()).toMatchObject({ localState: 'unknown', operationId: null });
    expect(f.request).not.toHaveBeenCalled(); await f.service.dispose();
  });
  it('fences once, retains active cancellation past unused expiry, and ignores early success', async () => {
    const f = await suspendedStart(), before = f.owner().snapshot()!;
    const complete = vi.spyOn(CodexAuthenticationOwner.prototype, 'complete');
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 180_000);
    f.notify(); // Notification before the native start reply is cached, not terminal.
    const close = f.service.closeDeviceLoginAttempt(f.handle);
    expect(f.owner().snapshot()).toMatchObject({ authGeneration: before.authGeneration, localState: 'unknown', operationId: null });
    f.reply.resolve(login()); expect(await f.outcome).toMatchObject({ code: 'CODEX_LOGIN_ATTEMPT_CLOSED' });
    expect(await close).toMatchObject({ state: 'closed', cleanup: 'cancel-acknowledged' });
    expect(await f.service.closeDeviceLoginAttempt(f.handle)).toEqual(await close);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(f.request.mock.calls.filter(([method]) => method === 'account/login/cancel')).toEqual([['account/login/cancel', { loginId: 'l1' }]]);
    f.notify(); expect((await f.service.readAccount()).login?.status).toBe('cancelled');
    expect(f.owner().snapshot()?.localState).toBe('unknown'); await f.service.dispose();
  });
  it('Close wins against an in-flight completion account/read and cannot be revived', async () => {
    const f = await fixture(), handle = f.service.reserveDeviceLoginAttempt().attemptHandle;
    await f.service.startDeviceLogin({ attemptHandle: handle });
    const entered = deferred(), account = deferred<unknown>();
    f.request.mockImplementation(async method => { if (method === 'account/read') { entered.resolve(); return account.promise; } return method === 'account/login/cancel' ? { status: 'canceled' } : {}; });
    f.notify(); await entered.promise;
    const pending = f.owner().snapshot()!;
    const close = f.service.closeDeviceLoginAttempt(handle);
    expect(f.owner().snapshot()).toMatchObject({ localState: 'unknown', operationId: null, authGeneration: pending.authGeneration });
    await close;
    account.resolve({ account: { type: 'chatgpt', email: 'late@example.test' } });
    expect((await f.service.readAccount()).login?.status).toBe('cancelled');
    expect(f.owner().snapshot()?.localState).toBe('unknown'); await f.service.dispose();
  });
  it('durable ready wins before Close; Close neither cancels nor logs out', async () => {
    const f = await fixture(), handle = f.service.reserveDeviceLoginAttempt().attemptHandle;
    await f.service.startDeviceLogin({ attemptHandle: handle }); f.notify();
    expect((await f.service.readAccount()).login?.status).toBe('completed');
    const before = f.owner().snapshot();
    expect(await f.service.closeDeviceLoginAttempt(handle)).toMatchObject({ state: 'already-terminal', cleanup: 'not-applicable' });
    expect(f.owner().snapshot()).toEqual(before);
    expect(f.request.mock.calls.some(([method]) => ['account/login/cancel', 'account/logout'].includes(method))).toBe(false);
    await f.service.dispose();
  });
  it.each(['ready', 'new-generation'] as const)('revokes cleanup on post-fence %s state changes', async mode => {
    const f = await suspendedStart(), close = f.service.closeDeviceLoginAttempt(f.handle);
    const fenced = f.owner().snapshot()!;
    if (mode === 'ready') await writeFile(join(f.root, 'inkos-connection.json'), JSON.stringify({ ...fenced, localState: 'ready' }));
    else f.owner().begin(true);
    const newer = f.owner().snapshot(); f.reply.resolve(login()); await f.outcome;
    expect(await close).toMatchObject({ state: 'superseded', cleanup: 'not-applicable' }); expect(f.owner().snapshot()).toEqual(newer);
    expect(f.request.mock.calls.some(([method]) => method === 'account/login/cancel')).toBe(false); await f.service.dispose();
  });
  it('does not cancel through a rebuilt peer or overwrite newer owner state on a stale ACK', async () => {
    const f = await suspendedStart(), second = f.peer();
    const close = f.service.closeDeviceLoginAttempt(f.handle); f.disconnect();
    f.factory.mockResolvedValueOnce(second.client); expect(await f.service.getRuntimeClient()).toBe(second.client);
    f.reply.resolve(login()); await f.outcome; await close;
    expect(second.request).not.toHaveBeenCalled();
    const next = f.service.reserveDeviceLoginAttempt().attemptHandle;
    await f.service.startDeviceLogin({ attemptHandle: next });
    const cancel = deferred<unknown>(), entered = deferred();
    second.request.mockImplementation(async method => { if (method === 'account/login/cancel') { entered.resolve(); return cancel.promise; } return method === 'account/login/cancel' ? { status: 'canceled' } : {}; });
    const closing = f.service.closeDeviceLoginAttempt(next); await entered.promise;
    new CodexAuthenticationOwner(second.client).begin(true); const newer = f.owner().snapshot();
    cancel.resolve({ status: 'canceled' }); expect((await closing).cleanup).toBe('cancel-acknowledged');
    expect(f.owner().snapshot()).toEqual(newer); expect(f.factory).toHaveBeenCalledTimes(2); await f.service.dispose();
  });
  it('serializes concurrent logout without using an old cleanup permit', async () => {
    const f = await suspendedStart(), loggingOut = f.service.logout(), close = f.service.closeDeviceLoginAttempt(f.handle);
    f.reply.resolve(login()); await f.outcome; await loggingOut;
    const after = f.owner().snapshot(); expect((await close).state).toBe('superseded');
    expect(f.owner().snapshot()).toEqual(after); expect(after?.localState).toBe('disconnected');
    expect(f.request.mock.calls.filter(([method]) => method === 'account/login/cancel')).toHaveLength(0); await f.service.dispose();
  });
  it('retains unconfirmed cancellation without replaying it or allowing a new login', async () => {
    const f = await fixture(), handle = f.service.reserveDeviceLoginAttempt().attemptHandle;
    await f.service.startDeviceLogin({ attemptHandle: handle });
    f.request.mockImplementation(async method => { if (method === 'account/login/cancel') throw new Error('private-provider-error'); return method === 'account/login/cancel' ? { status: 'canceled' } : {}; });
    const result = await f.service.closeDeviceLoginAttempt(handle);
    expect(result).toMatchObject({ state: 'closed', cleanup: 'unconfirmed' }); expect(JSON.stringify(result)).not.toContain('private-provider-error');
    expect(await f.service.closeDeviceLoginAttempt(handle)).toBe(result);
    await expect(f.service.startDeviceLogin()).rejects.toMatchObject({ code: 'CODEX_LOGIN_ATTEMPT_BUSY' });
    f.notify(true);
    expect(f.owner().snapshot()?.localState).toBe('unknown');
    await expect(f.service.startDeviceLogin()).rejects.toMatchObject({ code: 'CODEX_LOGIN_ATTEMPT_BUSY' });
    expect(f.request.mock.calls.filter(([method]) => method === 'account/login/cancel')).toHaveLength(1); await f.service.dispose();
  });
  it.each([false, true])('retires only the original peer after a start timeout; retirement failure=%s', async failure => {
    const f = await suspendedStart();
    if (failure) vi.mocked(f.client.close).mockRejectedValue(new Error('retire failed'));
    f.reply.reject(new Error('native start timeout')); expect(await f.outcome).toBeInstanceOf(Error);
    expect(f.client.close).toHaveBeenCalledTimes(1); expect(f.factory).toHaveBeenCalledTimes(1);
    if (failure) await expect(f.service.startDeviceLogin()).rejects.toMatchObject({ code: 'CODEX_LOGIN_ATTEMPT_BUSY' });
    await f.service.dispose().catch(() => {}); expect(f.client.close).toHaveBeenCalledTimes(1);
    expect(f.request.mock.calls.some(([method]) => method === 'account/login/cancel')).toBe(false);
  });
  it.each([false, true])('sanitizes fence failure and preserves both errors; close failure=%s', async double => {
    const f = await suspendedStart(), fenceError = new Error('SECRET-fsync'), cleanupError = new Error('SECRET-close');
    vi.spyOn(CodexAuthenticationOwner.prototype, 'complete').mockImplementation(() => { throw fenceError; });
    if (double) vi.mocked(f.client.close).mockRejectedValue(cleanupError);
    const close = f.service.closeDeviceLoginAttempt(f.handle).catch(error => error);
    f.reply.resolve(login()); await f.outcome;
    const error = await close;
    expect(error).toMatchObject({ code: 'CODEX_LOGIN_ATTEMPT_FENCE_FAILED' }); expect(error.message).not.toContain('SECRET');
    expect(JSON.stringify(error)).not.toContain('SECRET');
    if (double) expect(error.cause.errors).toEqual([fenceError, cleanupError]); else expect(error.cause).toBe(fenceError);
    expect(f.client.close).toHaveBeenCalledTimes(1); await f.service.dispose().catch(() => {});
    expect(f.client.close).toHaveBeenCalledTimes(1); expect(f.request.mock.calls.some(([method]) => method === 'account/login/cancel')).toBe(false);
  });
  it.each(['navigation', 'timeout'])('real Fetch abort/lost response followed by explicit Close survives %s', async reason => {
    const f = await httpAttempt(), startController = new AbortController(), closeController = new AbortController();
    try {
      const transport = f.send('start', startController.signal);
      await f.entered.promise; startController.abort(); await expect(transport).rejects.toMatchObject({ name: 'AbortError' });
      const closeTransport = f.send('close', closeController.signal);
      await f.closeEntered.promise;
      expect(f.owner().snapshot()?.localState).toBe('unknown');
      // Closing the page or timing out this second HTTP response cannot undo the accepted Close.
      closeController.abort(new DOMException(reason, 'AbortError')); await expect(closeTransport).rejects.toMatchObject({ name: 'AbortError' });
      f.reply.resolve(login()); expect(await f.outcome).toMatchObject({ code: 'CODEX_LOGIN_ATTEMPT_CLOSED' });
      expect(await f.close).toMatchObject({ state: 'closed', cleanup: 'cancel-acknowledged' });
      expect(f.request.mock.calls.filter(([method]) => method === 'account/login/start')).toHaveLength(1);
      expect(f.owner().snapshot()?.localState).toBe('unknown');
    } finally { f.reply.resolve(login()); await f.shutdown(); }
  });
  it('navigation without explicit Close preserves the pending attempt', async () => {
    const f = await httpAttempt(), controller = new AbortController();
    try {
      const transport = f.send('start', controller.signal); await f.entered.promise; controller.abort();
      await expect(transport).rejects.toMatchObject({ name: 'AbortError' }); f.reply.resolve(login()); await f.outcome;
      expect((await f.service.readAccount()).login?.status).toBe('pending'); expect(f.owner().snapshot()?.localState).toBe('transitioning');
      expect(f.request.mock.calls.some(([method]) => method === 'account/login/cancel')).toBe(false);
    } finally { f.reply.resolve(login()); await f.shutdown(); }
  });
  it('shutdown fences before a delayed success, closes once, and clears all records', async () => {
    const f = await suspendedStart();
    const closing = f.service.dispose(); expect(f.service.dispose()).toBe(closing);
    expect(f.owner().snapshot()).toMatchObject({ localState: 'unknown', operationId: null });
    f.notify(); f.reply.resolve(login()); await f.outcome; await closing;
    expect(f.client.close).toHaveBeenCalledTimes(1);
    expect((f.service as unknown as { attempts: Map<string, unknown> }).attempts.size).toBe(0);
    expect(() => f.service.reserveDeviceLoginAttempt()).toThrow('closed');
    await expect(f.service.startDeviceLogin({ attemptHandle: f.handle })).rejects.toThrow('closed');
    expect(f.owner().snapshot()?.localState).toBe('unknown');
  });
  it.each([{ status: 'canceled' }, { status: 'notFound' }, {}, undefined, { status: 'other' }])('accepts only the pinned native canceled ACK: %j', async response => {
    const f = await fixture(), handle = f.service.reserveDeviceLoginAttempt().attemptHandle;
    await f.service.startDeviceLogin({ attemptHandle: handle });
    f.request.mockImplementation(async method => method === 'account/login/cancel' ? response : {});
    const closing = f.service.closeDeviceLoginAttempt(handle), receipt = await closing;
    expect(receipt.cleanup).toBe(response?.status === 'canceled' ? 'cancel-acknowledged' : 'unconfirmed');
    expect(Object.isFrozen(receipt)).toBe(true); expect(f.service.closeDeviceLoginAttempt(handle)).toBe(closing);
    expect(await f.service.closeDeviceLoginAttempt(handle)).toBe(receipt);
    expect(f.request.mock.calls.filter(([method]) => method === 'account/login/cancel')).toEqual([['account/login/cancel', { loginId: 'l1' }]]);
    if (response?.status !== 'canceled') await expect(f.service.startDeviceLogin()).rejects.toMatchObject({ code: 'CODEX_LOGIN_ATTEMPT_BUSY' });
    await f.service.dispose(); expect(receipt.cleanup).toBe(response?.status === 'canceled' ? 'cancel-acknowledged' : 'unconfirmed');
  });
  it.each(['cancel-timeout', 'pending-protocol-error'] as const)('awaits one original process settlement after %s; a new borrowed peer cannot release it', async mode => {
    const f = await fixture(), handle = f.service.reserveDeviceLoginAttempt().attemptHandle;
    await f.service.startDeviceLogin({ attemptHandle: handle });
    const exited = deferred(), second = f.peer();
    vi.mocked(f.client.close).mockImplementation(async () => { f.disconnect(); await exited.promise; });
    if (mode === 'cancel-timeout') {
      f.request.mockImplementation(async method => { if (method === 'account/login/cancel') throw new Error('cancel timeout'); return {}; });
      expect((await f.service.closeDeviceLoginAttempt(handle)).cleanup).toBe('unconfirmed');
    }
    f.disconnect(); await Promise.resolve();
    expect(f.client.close).toHaveBeenCalledTimes(1);
    f.factory.mockResolvedValueOnce(second.client); expect(await f.service.getRuntimeClient()).toBe(second.client);
    const next = f.service.reserveDeviceLoginAttempt().attemptHandle;
    await expect(f.service.startDeviceLogin({ attemptHandle: next })).rejects.toMatchObject({ code: 'CODEX_LOGIN_ATTEMPT_BUSY' });
    await expect(f.service.startDeviceLogin()).rejects.toMatchObject({ code: 'CODEX_LOGIN_ATTEMPT_BUSY' });
    expect(second.client.close).not.toHaveBeenCalled();
    exited.resolve(); await vi.waitFor(() => expect((f.service as unknown as { activeAttempt?: unknown }).activeAttempt).toBeUndefined());
    await f.service.startDeviceLogin({ attemptHandle: next });
    expect(second.request.mock.calls.filter(([method]) => method === 'account/login/start')).toHaveLength(1);
    await f.service.dispose(); expect(f.client.close).toHaveBeenCalledTimes(1); expect(second.client.close).toHaveBeenCalledTimes(1);
  });
  it('keeps an original failed retirement owned and BUSY until dispose observes the same error once', async () => {
    const f = await fixture(), failure = new Error('original process cleanup failed');
    await f.service.startDeviceLogin({ attemptHandle: f.service.reserveDeviceLoginAttempt().attemptHandle });
    vi.mocked(f.client.close).mockRejectedValue(failure); f.disconnect();
    await Promise.resolve(); await Promise.resolve();
    await expect(f.service.startDeviceLogin()).rejects.toMatchObject({ code: 'CODEX_LOGIN_ATTEMPT_BUSY' });
    await expect(f.service.dispose()).rejects.toBe(failure); expect(f.client.close).toHaveBeenCalledTimes(1);
  });
  it('uses the prior shared retirement proof when a closed peer is returned before attempt association', async () => {
    const f = await fixture(), second = f.peer();
    await f.service.getRuntimeClient(); f.disconnect();
    await vi.waitFor(() => expect(f.client.close).toHaveBeenCalledTimes(1));
    f.factory.mockResolvedValueOnce(f.client);
    await expect(f.service.startDeviceLogin({ attemptHandle: f.service.reserveDeviceLoginAttempt().attemptHandle })).rejects.toMatchObject({ code: 'CODEX_LOGIN_ATTEMPT_BUSY' });
    f.factory.mockResolvedValueOnce(second.client);
    await f.service.startDeviceLogin({ attemptHandle: f.service.reserveDeviceLoginAttempt().attemptHandle });
    expect(f.request.mock.calls.filter(([method]) => method === 'account/login/start')).toHaveLength(0);
    expect(second.request.mock.calls.filter(([method]) => method === 'account/login/start')).toHaveLength(1);
    await f.service.dispose(); expect(f.client.close).toHaveBeenCalledTimes(1);
  });
  it('keeps an invalid native start BUSY through a pending retirement, then allows exactly one fresh start', async () => {
    const f = await suspendedStart(), exited = deferred(), second = f.peer();
    vi.mocked(f.client.close).mockImplementation(async () => { f.disconnect(); await exited.promise; });
    f.reply.resolve({ type: 'broken' });
    await vi.waitFor(() => expect(f.client.close).toHaveBeenCalledTimes(1));
    await expect(f.service.startDeviceLogin()).rejects.toMatchObject({ code: 'CODEX_LOGIN_ATTEMPT_BUSY' });
    f.factory.mockResolvedValueOnce(second.client); exited.resolve(); await f.outcome;
    await f.service.startDeviceLogin(); expect(second.request.mock.calls.filter(([method]) => method === 'account/login/start')).toHaveLength(1);
    await f.service.dispose(); expect(f.client.close).toHaveBeenCalledTimes(1);
  });
  it.each(['read-error', 'account-null'] as const)('concludes its own non-ready completion after success + %s without a false ready or permanent BUSY', async mode => {
    const f = await fixture(), handle = f.service.reserveDeviceLoginAttempt().attemptHandle;
    await f.service.startDeviceLogin({ attemptHandle: handle });
    f.request.mockImplementation(async method => {
      if (method === 'account/read') { if (mode === 'read-error') throw new Error('synthetic account/read failed'); return { account: null }; }
      if (method === 'account/login/start') return login('l2');
      return method === 'account/login/cancel' ? { status: 'canceled' } : {};
    });
    f.notify(); await f.service.readAccount().catch(() => {});
    expect(f.owner().snapshot()).toMatchObject({ localState: mode === 'read-error' ? 'unknown' : 'disconnected', operationId: null });
    expect(await f.service.closeDeviceLoginAttempt(handle)).toMatchObject({ state: 'closed', cleanup: 'not-applicable' });
    const before = f.owner().snapshot();
    await f.service.startDeviceLogin({ attemptHandle: f.service.reserveDeviceLoginAttempt().attemptHandle });
    expect(f.owner().snapshot()!.authGeneration).toBe(before!.authGeneration + 1);
    expect(f.request.mock.calls.filter(([method]) => method === 'account/login/cancel')).toHaveLength(0);
    expect(f.request.mock.calls.filter(([method]) => method === 'account/login/start')).toHaveLength(2); await f.service.dispose();
  });
  it.each(['native-failure', 'read-error', 'account-null'] as const)('releases Close accepted after its durable %s settlement but before finally, for either next entry point', async mode => {
    for (const nextEntry of ['handle', 'legacy'] as const) {
      const f = await fixture(), handle = f.service.reserveDeviceLoginAttempt().attemptHandle;
      await f.service.startDeviceLogin({ attemptHandle: handle });
      const gate = mode === 'native-failure' ? undefined : holdLoginCompletion();
      if (gate) {
        const request = f.request.getMockImplementation()!;
        f.request.mockImplementation(async (method, params) => {
          if (method === 'account/read') { if (mode === 'read-error') throw new Error('synthetic account/read failed'); return { account: null }; }
          return request(method, params);
        });
      }
      f.notify(mode !== 'native-failure');
      if (gate) await gate.written.promise;
      const attempt = (f.service as unknown as { activeAttempt: { settlementDone: boolean; ownerSettledStamp?: unknown } }).activeAttempt;
      expect(attempt.settlementDone).toBe(false); expect(attempt.ownerSettledStamp).toBeDefined();
      expect(f.owner().snapshot()).toMatchObject(attempt.ownerSettledStamp!);
      const settled = f.owner().snapshot();
      expect(settled).toMatchObject({ localState: mode === 'account-null' ? 'disconnected' : 'unknown', operationId: null });
      const closing = f.service.closeDeviceLoginAttempt(handle);
      expect(f.service.closeDeviceLoginAttempt(handle)).toBe(closing);
      const receipt = await closing;
      expect(receipt).toMatchObject({ state: 'closed', cleanup: 'not-applicable' }); expect(Object.isFrozen(receipt)).toBe(true);
      const next = f.service.reserveDeviceLoginAttempt().attemptHandle;
      if (gate) {
        await expect(f.service.startDeviceLogin({ attemptHandle: next })).rejects.toMatchObject({ code: 'CODEX_LOGIN_ATTEMPT_BUSY' });
        await expect(f.service.startDeviceLogin()).rejects.toMatchObject({ code: 'CODEX_LOGIN_ATTEMPT_BUSY' });
        gate.resume.resolve();
      }
      await (f.service as unknown as { ownerSettlement: Promise<unknown> }).ownerSettlement;
      expect(f.owner().snapshot()).toEqual(settled);
      expect(f.service.closeDeviceLoginAttempt(handle)).toBe(closing); expect(await closing).toBe(receipt);
      await expect(f.service.startDeviceLogin({ attemptHandle: handle })).rejects.toMatchObject({ code: 'CODEX_LOGIN_ATTEMPT_CLOSED' });
      expect(f.request.mock.calls.filter(([method]) => method === 'account/login/start')).toHaveLength(1);
      const starting = nextEntry === 'handle' ? f.service.startDeviceLogin({ attemptHandle: next }) : f.service.startDeviceLogin();
      expect(nextEntry === 'handle' ? f.service.startDeviceLogin({ attemptHandle: next }) : f.service.startDeviceLogin()).toBe(starting);
      await starting;
      await expect(f.service.startDeviceLogin({ attemptHandle: f.service.reserveDeviceLoginAttempt().attemptHandle })).rejects.toMatchObject({ code: 'CODEX_LOGIN_ATTEMPT_BUSY' });
      expect(f.owner().snapshot()!.authGeneration).toBe(settled!.authGeneration + 1);
      expect(f.request.mock.calls.filter(([method]) => method === 'account/login/start')).toHaveLength(2);
      expect(f.request.mock.calls.some(([method]) => ['account/login/cancel', 'account/logout'].includes(method))).toBe(false);
      expect(f.client.close).not.toHaveBeenCalled(); await f.service.dispose();
    }
  });
  it.each(['fulfilled', 'rejected'] as const)('does not release a proven non-ready terminal while original retirement is %s', async outcome => {
    const f = await fixture(), handle = f.service.reserveDeviceLoginAttempt().attemptHandle, exited = deferred(), failure = new Error('original retirement failed');
    await f.service.startDeviceLogin({ attemptHandle: handle });
    vi.mocked(f.client.close).mockImplementation(() => exited.promise);
    f.notify(false); f.disconnect();
    const closing = f.service.closeDeviceLoginAttempt(handle), receipt = await closing;
    expect(receipt).toMatchObject({ state: 'closed', cleanup: 'not-applicable' });
    const next = f.service.reserveDeviceLoginAttempt().attemptHandle;
    await expect(f.service.startDeviceLogin({ attemptHandle: next })).rejects.toMatchObject({ code: 'CODEX_LOGIN_ATTEMPT_BUSY' });
    await expect(f.service.startDeviceLogin()).rejects.toMatchObject({ code: 'CODEX_LOGIN_ATTEMPT_BUSY' });
    expect(f.service.closeDeviceLoginAttempt(handle)).toBe(closing); expect(f.client.close).toHaveBeenCalledTimes(1);
    if (outcome === 'rejected') {
      exited.reject(failure); await Promise.resolve(); await Promise.resolve();
      await expect(f.service.startDeviceLogin()).rejects.toMatchObject({ code: 'CODEX_LOGIN_ATTEMPT_BUSY' });
      await expect(f.service.dispose()).rejects.toBe(failure);
    } else {
      const second = f.peer(); f.factory.mockResolvedValueOnce(second.client); exited.resolve();
      await vi.waitFor(() => expect((f.service as unknown as { activeAttempt?: unknown }).activeAttempt).toBeUndefined());
      await f.service.startDeviceLogin({ attemptHandle: next });
      expect(second.request.mock.calls.filter(([method]) => method === 'account/login/start')).toHaveLength(1); await f.service.dispose();
    }
    expect(f.client.close).toHaveBeenCalledTimes(1); expect(await closing).toBe(receipt);
    expect(f.request.mock.calls.some(([method]) => method === 'account/login/cancel')).toBe(false);
  });
  it.each(['ready', 'new-generation'] as const)('keeps a %s supersession boundary after its own non-ready onWritten and before finally', async mode => {
    const f = await fixture(), handle = f.service.reserveDeviceLoginAttempt().attemptHandle;
    await f.service.startDeviceLogin({ attemptHandle: handle });
    const gate = holdLoginCompletion(), request = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (method, params) => method === 'account/read' ? { account: null } : request(method, params));
    f.notify(); await gate.written.promise;
    const settled = f.owner().snapshot()!;
    if (mode === 'ready') await writeFile(join(f.root, 'inkos-connection.json'), JSON.stringify({ ...settled, localState: 'ready' }));
    else f.owner().begin(true);
    const superseding = f.owner().snapshot(), closing = f.service.closeDeviceLoginAttempt(handle);
    expect(f.service.closeDeviceLoginAttempt(handle)).toBe(closing);
    const receipt = await closing;
    expect(receipt).toMatchObject({ state: 'superseded', cleanup: 'not-applicable' });
    gate.resume.resolve(); await (f.service as unknown as { ownerSettlement: Promise<unknown> }).ownerSettlement;
    expect(f.owner().snapshot()).toEqual(superseding); expect(await closing).toBe(receipt);
    expect(f.request.mock.calls.some(([method]) => ['account/login/cancel', 'account/logout'].includes(method))).toBe(false);
    expect(f.request.mock.calls.filter(([method]) => method === 'account/login/start')).toHaveLength(1); await f.service.dispose();
  });
  it.each(['CAS', 'file-fsync', 'directory-fsync'] as const)('retires a non-ready success after %s failure without overwriting newer state', async mode => {
    const f = await fixture(), handle = f.service.reserveDeviceLoginAttempt().attemptHandle;
    await f.service.startDeviceLogin({ attemptHandle: handle });
    const exited = deferred(), failure = new Error('synthetic owner fsync failure');
    vi.mocked(f.client.close).mockImplementation(async () => { f.disconnect(); await exited.promise; });
    if (mode === 'CAS') {
      const complete = CodexAuthenticationOwner.prototype.completeLogin;
      vi.spyOn(CodexAuthenticationOwner.prototype, 'completeLogin').mockImplementationOnce(function (this: CodexAuthenticationOwner, ticket, client, written) {
        this.begin(true); return complete.call(this, ticket, client, written);
      });
    } else {
      const fsync = fs.fsyncSync; let failed = false;
      vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => {
        if (!failed && (mode === 'file-fsync' || fs.fstatSync(fd).isDirectory())) { failed = true; throw failure; }
        fsync(fd);
      }); syncBuiltinESMExports();
    }
    f.notify(); await vi.waitFor(() => expect(f.client.close).toHaveBeenCalledTimes(1));
    expect((f.service as unknown as { login: { status: string } }).login.status).toBe('failed');
    const afterFailure = f.owner().snapshot();
    expect(afterFailure?.localState).not.toBe(mode === 'directory-fsync' ? 'unknown' : 'ready');
    await expect(f.service.startDeviceLogin()).rejects.toMatchObject({ code: 'CODEX_LOGIN_ATTEMPT_BUSY' });
    if (mode === 'CAS' || mode === 'directory-fsync') expect((await f.service.closeDeviceLoginAttempt(handle)).state).toBe('superseded');
    expect(f.owner().snapshot()).toEqual(afterFailure);
    exited.resolve(); await vi.waitFor(() => expect((f.service as unknown as { activeAttempt?: unknown }).activeAttempt).toBeUndefined());
    const dispose = f.service.dispose();
    if (mode === 'CAS') await dispose; else await expect(dispose).rejects.toBe(failure);
    expect(f.client.close).toHaveBeenCalledTimes(1);
  });
  it('lets Close fence a concurrent failed completion, then releases only after the original peer retirement', async () => {
    const f = await fixture(), handle = f.service.reserveDeviceLoginAttempt().attemptHandle;
    await f.service.startDeviceLogin({ attemptHandle: handle });
    const entered = deferred(), account = deferred<unknown>(), exited = deferred(), second = f.peer();
    f.request.mockImplementation(async method => {
      if (method === 'account/read') { entered.resolve(); return account.promise; }
      if (method === 'account/login/cancel') throw new Error('cancel timeout'); return {};
    });
    vi.mocked(f.client.close).mockImplementation(async () => { f.disconnect(); await exited.promise; });
    f.notify(); await entered.promise;
    const receipt = await f.service.closeDeviceLoginAttempt(handle), before = f.owner().snapshot();
    expect(receipt).toMatchObject({ state: 'closed', cleanup: 'unconfirmed' });
    account.reject(new Error('completion account/read failed')); await vi.waitFor(() => expect(f.client.close).toHaveBeenCalledTimes(1));
    await expect(f.service.startDeviceLogin()).rejects.toMatchObject({ code: 'CODEX_LOGIN_ATTEMPT_BUSY' }); expect(f.owner().snapshot()).toEqual(before);
    f.factory.mockResolvedValueOnce(second.client); exited.resolve();
    await vi.waitFor(() => expect((f.service as unknown as { activeAttempt?: unknown }).activeAttempt).toBeUndefined());
    await f.service.startDeviceLogin(); expect(receipt.cleanup).toBe('unconfirmed'); expect(Object.isFrozen(receipt)).toBe(true);
    await f.service.dispose(); expect(f.client.close).toHaveBeenCalledTimes(1);
  });
});
