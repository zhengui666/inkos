import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCodexAccountService } from '../account.js';
import { createCodexAccountService as createPublicAccountService, observeCodexRuntime, bindCodexModelConnection, type CodexClient as PublicCodexClient, type CodexAccountService } from '../../index.js';
import { CodexAuthenticationOwner } from '../../runtime/auth/codex-owner.js';
import type { CodexClient, CodexNotificationListener } from '../app-server.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'inkos-account-test-')); roots.push(dir);
  let notification: CodexNotificationListener = () => undefined;
  let close: () => void = () => undefined;
  let connected = false;
  const request = vi.fn(async (method: string): Promise<unknown> => {
    if (method === 'account/read') return { account: connected ? { type: 'chatgpt', email: 'synthetic@example.test' } : null, requiresOpenaiAuth: true, accessToken: 'DO NOT EXPOSE' };
    if (method === 'account/login/start') return { type: 'chatgptDeviceCode', loginId: 'l1', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD', accessToken: 'DO NOT EXPOSE' };
    if (method === 'account/login/cancel') return { status: 'canceled' };
    if (method === 'model/list') return { data: [{ id: 'model1', model: 'gpt-6.1-sol', displayName: 'Model', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'medium' }, { reasoningEffort: 'ultra' }], serviceTiers: [{ id: 'fast' }, { id: 'priority' }], token: 'DO NOT EXPOSE' }], nextCursor: null };
    return {};
  });
  const client = { request, onNotification: (listener: CodexNotificationListener) => { notification = listener; return () => undefined; },
    onClose: (listener: () => void) => { close = listener; return () => undefined; }, close: vi.fn(async () => close()),
    cwd: dir, codexHome: dir, closed: false, onRequest: () => () => undefined } as unknown as CodexClient;
  const service = createCodexAccountService({ projectDir: dir, clientFactory: async () => client });
  return { service, request, client, notify: (method: string, params: unknown) => { if (method === 'account/login/completed' && (params as { success?: boolean }).success) connected = true; notification(method, params); }, close: () => close() };
}
describe('Codex account service', () => {
  it('projects account/model/login data without credential leakage', async () => {
    const { service, request } = await fixture();
    const status = await service.readAccount();
    expect(status.connected).toBe(false); expect(JSON.stringify(status)).not.toContain('EXPOSE');
    expect(JSON.stringify(await service.listModels())).not.toContain('EXPOSE');
    expect(JSON.stringify(await service.startDeviceLogin())).not.toContain('EXPOSE');
    expect(request).toHaveBeenCalledWith('account/login/start', { type: 'chatgptDeviceCode' });
    await service.dispose();
  });
  it('deduplicates repeated starts and guards stale cancellations', async () => {
    const { service, request } = await fixture();
    await Promise.all([service.startDeviceLogin(), service.startDeviceLogin()]);
    expect(request.mock.calls.filter(([method]) => method === 'account/login/start')).toHaveLength(1);
    await expect(service.cancelLogin('stale')).rejects.toThrow('no longer current');
    await service.cancelLogin('l1');
    expect((await service.readAccount()).login).toEqual({ loginId: 'l1', status: 'cancelled' });
    await service.dispose();
  });
  it('tracks completed, failed, and disconnected sign-ins without raw error leakage', async () => {
    const { service, notify, close } = await fixture();
    await service.startDeviceLogin(); notify('account/login/completed', { loginId: 'l1', success: false, error: 'SECRET' });
    expect((await service.readAccount()).login?.status).toBe('failed');
    expect(JSON.stringify(await service.readAccount())).not.toContain('SECRET');
    await service.startDeviceLogin(); notify('account/login/completed', { loginId: 'l1', success: true });
    expect((await service.readAccount()).login).toEqual({ loginId: 'l1', status: 'completed' });
    await service.startDeviceLogin(); close();
    expect((await service.readAccount()).login?.status).toBe('failed');
    await service.dispose();
  });
  it('validates supported reasoning and service tier against model/list', async () => {
    const { service } = await fixture();
    await expect(service.updateSettings({ model: 'made-up' })).rejects.toThrow('not available');
    await expect(service.updateSettings({ serviceTier: 'ultrafast' })).rejects.toThrow('not supported');
    await expect(service.updateSettings({ reasoningEffort: 'high' })).rejects.toThrow('not supported');
    expect(await service.updateSettings({ serviceTier: 'fast' })).toMatchObject({ serviceTier: 'fast' });
    await service.dispose();
  });
});

it('shares catalog aliases/explicit native default/speed projection with runtime settings validation', async () => {
  const { service, request } = await fixture();
  request.mockImplementation(async (method: string) => method === 'model/list' ? { data: [{ id: 'alias', model: 'canonical', displayName: 'Model', isDefault: true,
    supportedReasoningEfforts: [{ reasoningEffort: 'medium' }, { reasoningEffort: 'ultra' }], serviceTiers: [{ id: 'fast', name: 'Fast' }], additionalSpeedTiers: ['fast', 'priority'] }], nextCursor: null } : {});
  expect((await service.listModels())[0]?.serviceTiers.map(tier => tier.id)).toEqual(['fast', 'priority']);
  await expect(service.updateSettings({ model: 'alias', serviceTier: 'priority' })).resolves.toMatchObject({ model: 'alias', serviceTier: 'priority' });
  await expect(service.updateSettings({ model: null, serviceTier: 'default' })).resolves.toEqual({ reasoningEffort: 'ultra', serviceTier: 'default' });
  await expect(service.readSettings()).resolves.toEqual({ reasoningEffort: 'ultra', serviceTier: 'default' });
  await service.dispose();
});

it('routes legacy login/cancel/logout through the same owner and ignores a cancelled late success', async () => {
  const { service, request, client, notify } = await fixture();
  const original = request.getMockImplementation()!;
  request.mockImplementation(async method => method === 'account/read'
    ? { account: { type: 'chatgpt', email: 'synthetic@example.test' } } : original(method));
  const owner = new CodexAuthenticationOwner(client), admitted = await owner.admit(client);
  const initial = owner.snapshot()!;
  let stateAtStart: string | undefined;
  request.mockImplementation(async method => {
    if (method === 'account/login/start') stateAtStart = owner.snapshot()?.localState;
    return method === 'account/read' ? { account: { type: 'chatgpt', email: 'synthetic@example.test' } } : original(method);
  });
  await service.startDeviceLogin();
  expect(stateAtStart).toBe('transitioning');
  expect(owner.snapshot()!.authGeneration).toBeGreaterThan(initial.authGeneration);
  await expect(owner.guard({ ...admitted, ...admitted.connection }, client)).rejects.toMatchObject({ code: 'RUNTIME_AUTH_REVOKED' });
  await service.cancelLogin('l1');
  const cancelled = owner.snapshot()!;
  notify('account/login/completed', { loginId: 'l1', success: true });
  expect((await service.readAccount()).login?.status).toBe('cancelled');
  expect(owner.snapshot()).toEqual(cancelled);
  await service.startDeviceLogin();
  notify('account/login/completed', { loginId: 'l1', success: true });
  await service.readAccount();
  expect(owner.snapshot()?.localState).toBe('ready');
  const ready = owner.snapshot()!;
  await service.logout();
  expect(owner.snapshot()).toMatchObject({ localState: 'disconnected', authGeneration: ready.authGeneration + 1 });
  await service.dispose();
});

it('discards an account read that crossed logout instead of publishing a stale connection', async () => {
  const { service, request, client } = await fixture();
  const owner = new CodexAuthenticationOwner(client);
  request.mockImplementation(async method => method === 'account/read' ? { account: { type: 'chatgpt', email: 'first@example.test' } } : {});
  await owner.admit(client);
  let entered!: () => void, finish!: (value: unknown) => void;
  const began = new Promise<void>(resolve => { entered = resolve; });
  request.mockImplementation(async method => {
    if (method !== 'account/read') return {};
    entered(); return new Promise(resolve => { finish = resolve; });
  });
  const status = service.readAccount(); await began;
  await service.logout();
  finish({ account: { type: 'chatgpt', email: 'first@example.test' } });
  expect((await status).connected).toBe(false);
  expect(owner.snapshot()?.localState).toBe('disconnected');
  await service.dispose();
});

it('leaves the owner non-ready after a login RPC failure', async () => {
  const { service, request, client } = await fixture();
  const owner = new CodexAuthenticationOwner(client);
  request.mockImplementation(async () => { throw new Error('Synthetic RPC deadline'); });
  await expect(service.startDeviceLogin()).rejects.toThrow('Synthetic RPC deadline');
  expect(owner.snapshot()).toMatchObject({ localState: 'unknown', operationId: null });
  await service.dispose();
});

it('refuses to guess the first catalog model when native default evidence is absent', async () => {
  const { service, request } = await fixture();
  request.mockImplementation(async method => method === 'model/list' ? { data: [{ id: 'alias', model: 'canonical', isDefault: false,
    supportedReasoningEfforts: [{ reasoningEffort: 'ultra' }], serviceTiers: [{ id: 'priority' }] }] } : {});
  await expect(service.updateSettings({ model: null })).rejects.toMatchObject({ code: 'CODEX_MODEL_UNAVAILABLE' });
  await service.dispose();
});

it('rejects ambiguous native defaults instead of choosing whichever catalog row appeared first', async () => {
  const { service, request } = await fixture();
  request.mockImplementation(async method => method === 'model/list' ? { data: ['one', 'two'].map(model => ({ id: model, model, isDefault: true,
    supportedReasoningEfforts: [{ reasoningEffort: 'ultra' }], serviceTiers: [{ id: 'priority' }] })) } : {});
  await expect(service.updateSettings({ model: null })).rejects.toMatchObject({ code: 'CODEX_MODEL_UNAVAILABLE' });
  await service.dispose();
});


it('settles the original pending login ticket on dispose, fences late success, and allows fresh reconciliation', async () => {
  const { service, request, client, notify } = await fixture();
  const owner = new CodexAuthenticationOwner(client);
  await service.startDeviceLogin();
  const pending = owner.snapshot()!;
  expect(pending.localState).toBe('transitioning');
  await service.dispose();
  const disposed = owner.snapshot()!;
  expect(disposed).toMatchObject({ localState: 'unknown', operationId: null, authGeneration: pending.authGeneration });
  notify('account/login/completed', { loginId: 'l1', success: true });
  expect(owner.snapshot()).toEqual(disposed);
  expect(request.mock.calls.some(([method]) => method === 'account/logout')).toBe(false);
  request.mockImplementation(async method => method === 'account/read' ? { account: { type: 'chatgpt', email: 'fresh@example.test' } } : {});
  const fresh = createCodexAccountService({ projectDir: client.cwd, clientFactory: async () => client });
  expect((await fresh.readAccount()).connected).toBe(true);
  expect((await owner.admit(client)).ready).toBe(true);
  await fresh.dispose();
});

it('does not let disposing an old pending login overwrite a newer operation', async () => {
  const { service, client, notify } = await fixture();
  const owner = new CodexAuthenticationOwner(client);
  await service.startDeviceLogin();
  const newer = owner.begin(true), before = owner.snapshot()!;
  await service.dispose();
  notify('account/login/completed', { loginId: 'l1', success: true });
  expect(owner.snapshot()).toEqual(before);
  expect(owner.complete(newer, 'unknown')).toBe(true);
});

it('keeps a completed account ready when its service is disposed', async () => {
  const { service, request, client, notify } = await fixture();
  const original = request.getMockImplementation()!;
  request.mockImplementation(async method => method === 'account/read' ? { account: { type: 'chatgpt', email: 'ready@example.test' } } : original(method));
  await service.startDeviceLogin();
  notify('account/login/completed', { loginId: 'l1', success: true });
  await service.readAccount();
  const owner = new CodexAuthenticationOwner(client), ready = owner.snapshot()!;
  expect(ready.localState).toBe('ready');
  await service.dispose();
  expect(owner.snapshot()).toEqual(ready);
  expect(request.mock.calls.some(([method]) => method === 'account/logout')).toBe(false);
});

it('fences a pending success as soon as dispose starts, while it is still awaiting its queue', async () => {
  const { service, request, client, notify } = await fixture();
  await service.startDeviceLogin();
  const owner = new CodexAuthenticationOwner(client), pending = owner.snapshot()!;
  request.mockImplementation(async method => method === 'account/read' ? { account: { type: 'chatgpt', email: 'late@example.test' } } : {});
  const closing = service.dispose();
  // dispose has marked itself closed, but its first await has not resumed yet.
  notify('account/login/completed', { loginId: 'l1', success: true });
  await closing;
  expect(owner.snapshot()).toMatchObject({ localState: 'unknown', operationId: null, authGeneration: pending.authGeneration });
  expect(request.mock.calls.filter(([method]) => method === 'account/read')).toHaveLength(0);
});

it('closes and clears the local login after pending-ticket settlement throws, retaining the original error', async () => {
  const { service, client, request, notify } = await fixture();
  await service.startDeviceLogin();
  notify('account/login/completed', { loginId: 'unmatched-early', success: true });
  const failure = new Error('Synthetic owner fsync failure');
  const settle = vi.spyOn(CodexAuthenticationOwner.prototype, 'complete').mockImplementation(() => { throw failure; });
  try {
    await expect(service.dispose()).rejects.toBe(failure);
    expect(client.close).toHaveBeenCalledTimes(1);
    const state = service as unknown as { clientPromise?: unknown; ownerLogin?: unknown; login: unknown; earlyCompletions: Map<string, boolean> };
    expect(state.clientPromise).toBeUndefined(); expect(state.ownerLogin).toBeUndefined(); expect(state.login).toBeNull(); expect(state.earlyCompletions.size).toBe(0);
    notify('account/login/completed', { loginId: 'l1', success: true });
    expect(state.earlyCompletions.size).toBe(0);
    expect(request.mock.calls.some(([method]) => method === 'account/logout')).toBe(false);
  } finally { settle.mockRestore(); }
});

it('retains settlement and close failures together and still clears local state', async () => {
  const { service, client, notify } = await fixture();
  await service.startDeviceLogin();
  notify('account/login/completed', { loginId: 'unmatched-early', success: true });
  const settlementFailure = new Error('Synthetic owner lock failure'), closeFailure = new Error('Synthetic peer close failure');
  const settle = vi.spyOn(CodexAuthenticationOwner.prototype, 'complete').mockImplementation(() => { throw settlementFailure; });
  vi.mocked(client.close).mockRejectedValueOnce(closeFailure);
  try {
    const failure = await service.dispose().catch(error => error);
    expect(client.close).toHaveBeenCalledTimes(1);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.errors).toEqual([settlementFailure, closeFailure]);
    expect(failure.cause).toBe(settlementFailure);
    const state = service as unknown as { clientPromise?: unknown; ownerLogin?: unknown; login: unknown; earlyCompletions: Map<string, boolean> };
    expect(state.clientPromise).toBeUndefined(); expect(state.ownerLogin).toBeUndefined(); expect(state.login).toBeNull(); expect(state.earlyCompletions.size).toBe(0);
  } finally { settle.mockRestore(); }
});

it('closes after failed old-ticket settlement without changing a newer owner operation', async () => {
  const { service, client, notify } = await fixture();
  const owner = new CodexAuthenticationOwner(client);
  await service.startDeviceLogin();
  const originalTicket = owner.snapshot()!, newer = owner.begin(true), before = owner.snapshot()!;
  const failure = new Error('Synthetic owner read failure');
  const settle = vi.spyOn(CodexAuthenticationOwner.prototype, 'complete').mockImplementation(operation => {
    expect(operation).toEqual({ operationId: originalTicket.operationId, authGeneration: originalTicket.authGeneration });
    throw failure;
  });
  try {
    await expect(service.dispose()).rejects.toBe(failure);
    expect(client.close).toHaveBeenCalledTimes(1);
    notify('account/login/completed', { loginId: 'l1', success: true });
    expect(owner.snapshot()).toEqual(before);
  } finally { settle.mockRestore(); }
  expect(owner.complete(newer, 'unknown')).toBe(true);
});


it('exposes a borrowing getter through the public entry with concurrent creation reuse and disposed rejection', async () => {
  const { client, request } = await fixture();
  let release!: (peer: PublicCodexClient) => void;
  const factory = vi.fn(() => new Promise<PublicCodexClient>(resolve => { release = resolve; }));
  const service: CodexAccountService = createPublicAccountService({ projectDir: client.cwd, clientFactory: factory });
  const first: Promise<PublicCodexClient> = service.getRuntimeClient(), second = service.getRuntimeClient();
  expect(factory).toHaveBeenCalledTimes(1);
  release(client);
  expect(await first).toBe(client); expect(await second).toBe(client);
  expect(request).not.toHaveBeenCalled();
  expect(existsSync(join(client.cwd, '.inkos', 'agent-config.json'))).toBe(false);
  expect(new CodexAuthenticationOwner(client).snapshot()).toBeUndefined();
  expect(client.close).not.toHaveBeenCalled();
  await service.dispose();
  expect(client.close).toHaveBeenCalledTimes(1);
  await expect(service.getRuntimeClient()).rejects.toThrow('closed');
  expect(factory).toHaveBeenCalledTimes(1);
});

it('rebuilds the service-owned peer after close and fences notifications from the old borrowed peer', async () => {
  const first = await fixture(), second = await fixture();
  Object.defineProperties(second.client, { cwd: { value: first.client.cwd }, codexHome: { value: first.client.codexHome } });
  const factory = vi.fn().mockResolvedValueOnce(first.client).mockResolvedValueOnce(second.client);
  const service = createPublicAccountService({ projectDir: first.client.cwd, clientFactory: factory });
  expect(await service.getRuntimeClient()).toBe(first.client);
  first.close();
  expect(await service.getRuntimeClient()).toBe(second.client);
  expect(second.client.codexHome).toBe(first.client.codexHome);
  first.notify('account/login/completed', { loginId: 'old-peer', success: true });
  expect((await service.readAccount()).login).toBeNull();
  expect(factory).toHaveBeenCalledTimes(2);
  expect(second.client.close).not.toHaveBeenCalled();
  await service.dispose();
  expect(second.client.close).toHaveBeenCalledTimes(1);
});

it('shares the actual account peer and auth context with public observe/bind without transferring ownership', async () => {
  const { service, client, request, notify } = await fixture();
  const home = join(client.cwd, '.inkos', 'codex', 'home'); await mkdir(home, { recursive: true, mode: 0o700 });
  Object.defineProperty(client, 'codexHome', { value: home });
  const original = request.getMockImplementation()!;
  request.mockImplementation(async method => method === 'account/read'
    ? { account: { type: 'chatgpt', email: 'bridge@example.test' }, accessToken: 'DO NOT EXPOSE' } : original(method));
  await service.startDeviceLogin();
  notify('account/login/completed', { loginId: 'l1', success: true });
  expect((await service.readAccount()).login?.status).toBe('completed');
  const owner = new CodexAuthenticationOwner(client), before = owner.snapshot()!;
  const borrowed: PublicCodexClient = await service.getRuntimeClient();
  expect(borrowed).toBe(client);
  const observed = await observeCodexRuntime(borrowed);
  expect(observed).toMatchObject({ ready: true, authContextRef: before.authContextRef, owner: { authGeneration: before.authGeneration } });
  expect(JSON.stringify(observed)).not.toMatch(/DO NOT EXPOSE|bridge@example/);
  expect(JSON.stringify(observed)).not.toContain(home);
  const bound = await bindCodexModelConnection(client.cwd, borrowed, { expectedRevision: 0 });
  expect(bound.modelConnectionRef).toBe(before.connectionRef);
  expect(owner.snapshot()).toEqual(before);
  expect(client.close).not.toHaveBeenCalled();
  const newer = owner.begin(true), pending = owner.snapshot()!;
  expect((await observeCodexRuntime(await service.getRuntimeClient())).ready).toBe(false);
  await expect(bindCodexModelConnection(client.cwd, borrowed, { expectedRevision: bound.revision })).rejects.toMatchObject({ code: 'RUNTIME_AUTH_REVOKED' });
  expect(owner.snapshot()).toEqual(pending);
  await service.dispose();
  expect(client.close).toHaveBeenCalledTimes(1);
  expect(owner.snapshot()).toEqual(pending);
  expect(owner.complete(newer, 'unknown')).toBe(true);
});
