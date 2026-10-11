import { mkdtemp, rm, realpath, readFile, readdir, symlink, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CodexFixture, syntheticChatGptAccount, type FixtureTurn } from './codex-fixture.js';
const sentinels = vi.hoisted(() => ({
  process: vi.fn(() => { throw new Error('Unexpected native process in offline fixture'); }),
  network: vi.fn(() => { throw new Error('Unexpected network in offline fixture'); }),
}));
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(),
  spawn: sentinels.process, spawnSync: sentinels.process, exec: sentinels.process, execFile: sentinels.process }));
vi.mock('../utils/proxy-fetch.js', async original => ({ ...await original<typeof import('../utils/proxy-fetch.js')>(), fetchWithProxy: sentinels.network }));
const mocks = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock('../codex/client.js', () => ({ createCodexClient: mocks.createClient }));
import { CodexRuntimeFixtureScope, type RegisteredCodexProject } from './fixtures/codex-runtime-fixture.js';
import { withRuntimeExecution, guardRuntimeExecution, dispatchCodexHostEffect, observeCodexRuntime } from '../runtime/execution.js';
import { currentRuntimeRun, currentCodexRun } from '../runtime/run-context.js';
import { readAgentSettings, updateAgentSettings } from '../runtime/settings.js';
import { CodexRuntimeAdapter } from '../runtime/adapters/codex/adapter.js';
import { CodexAuthenticationOwner } from '../runtime/auth/codex-owner.js';
import { Agent } from '../codex/agent.js';
import { resolveCodexModel } from '../codex/model.js';
import { resolveCodexHome } from '../codex/app-server.js';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
let root: string, scope: CodexRuntimeFixtureScope, project: RegisteredCodexProject;
const extraRoots: string[] = [];
const barrier = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
const modelRequests = (fixture: CodexFixture) => fixture.requests.filter(request => ['thread/start', 'turn/start'].includes(request.method));
const agent = (signal?: AbortSignal) => new Agent({ projectRoot: root, signal, initialState: {
  model: resolveCodexModel(), systemPrompt: 'Offline host contract', messages: [], tools: [],
} });
beforeEach(async () => {
  sentinels.process.mockClear(); sentinels.network.mockClear(); vi.stubGlobal('fetch', sentinels.network);
  vi.stubEnv('INKOS_CODEX_HOME', undefined); vi.stubEnv('INKOS_CODEX_STATE_ROOT', undefined);
  root = await mkdtemp(join(tmpdir(), 'inkos-wire-contract-'));
  scope = new CodexRuntimeFixtureScope(); project = scope.registerProject(root);
  mocks.createClient.mockReset().mockImplementation(scope.createClient);
  await updateAgentSettings(root, { harnessPreferences: { codex: { model: null, effort: null, speed: null } } }, { expectedRevision: 0 });
});
afterEach(async () => {
  try {
    await scope.drain();
    expect(project.fixture.pendingTaskCount).toBe(0);
    expect(project.fixture.peers.every(peer => peer.closed && peer.closeCount === 1)).toBe(true);
    expect(sentinels.process).not.toHaveBeenCalled(); expect(sentinels.network).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
    await Promise.all([root, ...extraRoots.splice(0)].map(path => rm(path, { recursive: true, force: true })));
  }
});
it('labels synthetic ChatGPT evidence with requiresOpenaiAuth=true', async () => {
  const peer = await new CodexFixture(() => ({ text: 'unused' })).createClient(root);
  try { expect(await peer.request('account/read')).toMatchObject({ account: { type: 'chatgpt' }, requiresOpenaiAuth: true }); }
  finally { await peer.close(); }
});
it('matches the pinned rust-v0.159.2 ChatGPT account shape and PlanType enum', async () => {
  // https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/app-server-protocol/schema/json/v2/GetAccountResponse.json
  const planTypes = ['free', 'go', 'plus', 'pro', 'prolite', 'promax', 'team', 'self_serve_business_prolite',
    'self_serve_business_usage_based', 'business', 'ent26', 'enterprise_cbp_automation', 'enterprise_cbp_usage_based',
    'enterprise', 'edu', 'edu_plus', 'edu_pro', 'unknown'] as const;
  const shape = Type.Object({ requiresOpenaiAuth: Type.Boolean(), account: Type.Object({
    type: Type.Literal('chatgpt'), email: Type.Union([Type.String(), Type.Null()]),
    planType: Type.Union(planTypes.map(plan => Type.Literal(plan))),
  }) });
  const peer = await scope.createClient(root), response = await peer.request('account/read');
  expect(Value.Check(shape, response)).toBe(true);
  expect(response).toMatchObject({ account: { planType: 'unknown' }, requiresOpenaiAuth: true });
});
it('matches the pinned rust-v0.159.2 model/list required response fields', async () => {
  // https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/app-server-protocol/schema/json/v2/ModelListResponse.json
  const effort = Type.String({ minLength: 1 });
  const shape = Type.Object({ data: Type.Array(Type.Object({
    id: Type.String(), model: Type.String(), displayName: Type.String(), description: Type.String(),
    hidden: Type.Boolean(), isDefault: Type.Boolean(), defaultReasoningEffort: effort,
    supportedReasoningEfforts: Type.Array(Type.Object({ reasoningEffort: effort, description: Type.String() })),
    serviceTiers: Type.Optional(Type.Array(Type.Object({ id: Type.String(), name: Type.String(), description: Type.String() }))),
  })), nextCursor: Type.Optional(Type.Union([Type.String(), Type.Null()])) });
  const peer = await scope.createClient(root), response = await peer.request('model/list');
  expect(Value.Check(shape, response)).toBe(true);
  expect(response).toMatchObject({ data: [
    { id: 'fixture', defaultReasoningEffort: 'medium' },
    { id: 'gpt-6.1-sol', defaultReasoningEffort: 'ultra', serviceTiers: [{ id: 'priority' }, { id: 'fast' }] },
  ], nextCursor: null });
});
it('closes idempotently and rejects RPC use after close', async () => {
  const peer = await new CodexFixture(() => ({ text: 'unused' })).createClient(root), listener = vi.fn();
  peer.onClose(listener); await peer.close(); await peer.close();
  expect(listener).toHaveBeenCalledTimes(1);
  await expect(peer.request('account/read')).rejects.toThrow('Codex app-server is closed');
});
it('records a peer identity alongside untouched aggregate RPCs', async () => {
  const fixture = new CodexFixture(() => ({ text: 'unused' })), peer = await fixture.createClient(root);
  try { await peer.request('account/read', { refreshToken: false }); expect(fixture.requests[0]).toMatchObject({ peerId: expect.any(String) }); }
  finally { await peer.close(); }
});
it('does not run a queued model callback after close', async () => {
  const reply = vi.fn(() => ({ text: 'unused' })), fixture = new CodexFixture(reply), peer = await fixture.createClient(root);
  await peer.request('turn/start', { input: [] }); await peer.close();
  await fixture.drain();
  expect(reply).not.toHaveBeenCalled(); expect(fixture.pendingTaskCount).toBe(0);
});

it('uses only the registered transport for a real generic runtime and host Agent turn', async () => {
  const reply = vi.fn((turn: FixtureTurn) => turn.step === 1
    ? { calls: [{ id: 'exact-call', name: 'save', args: { value: 'fixture bytes' } }] }
    : { text: 'done', complete: true });
  // Register a fresh scope before the first production entrypoint.
  await scope.drain(); scope = new CodexRuntimeFixtureScope(); project = scope.registerProject(root, { reply });
  mocks.createClient.mockImplementation(scope.createClient);
  const execute = vi.fn(async (_id: string, args: { value: string }) => ({ content: [{ type: 'text' as const, text: args.value }], details: args }));
  let selection: unknown;
  await scope.run(signal => withRuntimeExecution(root, async () => {
    selection = currentRuntimeRun()!.selection;
    const host = new Agent({ projectRoot: root, signal, initialState: {
      model: resolveCodexModel(), systemPrompt: 'Host', messages: [], tools: [{ name: 'save', label: 'Save',
        description: 'Save', parameters: Type.Object({ value: Type.String() }), execute }],
    } });
    await host.prompt('Save fixture bytes'); expect(host.finalOutput).toBe('done');
  }, { signal }));
  expect(selection).toMatchObject({ harnessId: 'codex', modelId: 'fixture', effort: 'medium', serviceTier: null });
  expect(execute).toHaveBeenCalledTimes(1); expect(execute.mock.calls[0]?.slice(0, 2)).toEqual(['exact-call', { value: 'fixture bytes' }]);
  expect(project.fixture.toolResponses).toHaveLength(1);
  expect(modelRequests(project.fixture).map(request => request.method)).toEqual(['thread/start', 'turn/start']);
  expect(mocks.createClient).toHaveBeenCalledTimes(project.fixture.peers.length);
  expect(project.fixture.peers.filter(peer => modelRequestsFor(peer).length)).toHaveLength(1);
  expect(project.fixture.peers.filter(peer => !modelRequestsFor(peer).length).every(peer => peer.requests.every(request => request.method === 'account/read'))).toBe(true);
});
const modelRequestsFor = (peer: CodexFixture['peers'][number]) => peer.requests.filter(request => ['thread/start', 'turn/start'].includes(request.method));

it.each([
  ['null/auth-required', { account: null, requiresOpenaiAuth: true }],
  ['null/no-auth', { account: null, requiresOpenaiAuth: false }],
  ['API key', { account: { type: 'apiKey' }, requiresOpenaiAuth: true }],
  ['missing', {}], ['undefined', undefined], ['malformed', { account: 'chatgpt', requiresOpenaiAuth: true }],
  ['unknown', { account: { type: 'other' }, requiresOpenaiAuth: true }],
  ['invalid envelope', []],
])('rejects %s before callback/model/host effects', async (_label, response) => {
  project.setAccountResponse(response);
  const callback = vi.fn(async () => { throw new Error('Host effect was reached'); });
  const running = scope.run(signal => withRuntimeExecution(root, callback, { signal }));
  await expect(running).rejects.toMatchObject({ code: 'RUNTIME_AUTH_REVOKED' });
  expect(callback).not.toHaveBeenCalled(); expect(modelRequests(project.fixture)).toEqual([]);
  expect(project.fixture.turns).toEqual([]); expect(project.fixture.toolResponses).toEqual([]);
  expect(mocks.createClient).toHaveBeenCalledTimes(1);
  expect((await readAgentSettings(root)).modelConnectionRef).toBeNull();
});
it('surfaces a rejected account/read to the caller without an unhandled rejection', async () => {
  project.setAccountResponse(() => { throw new Error('Deliberately rejected account/read'); });
  const callback = vi.fn(async () => {});
  const running = scope.run(signal => withRuntimeExecution(root, callback, { signal }));
  await expect(running).rejects.toMatchObject({ code: 'RUNTIME_AUTH_REVOKED' });
  expect(callback).not.toHaveBeenCalled(); expect(modelRequests(project.fixture)).toEqual([]);
  await scope.drain();
});
it('fails unexpected actual model dispatch for an admission-only fixture', async () => {
  const host = agent(); await host.prompt('This model dispatch is forbidden');
  expect(host.finalOutput).toBeUndefined();
  expect(host.state.messages.at(-1)).toMatchObject({ stopReason: 'error', errorMessage: 'Unexpected model dispatch in offline fixture' });
  expect(project.fixture.turns).toHaveLength(1);
});
it('fails unknown RPC loudly and preserves raw null parameters with peer identity', async () => {
  const peer = await scope.createClient(root);
  await expect(peer.request('not/a/protocol-method', null)).rejects.toThrow('Unexpected fixture RPC');
  expect(project.fixture.requests[0]).toEqual({ method: 'not/a/protocol-method', params: null, peerId: project.fixture.peers[0]!.id });
});
it('canonicalizes registered aliases and rejects unregistered roots before any peer or home writes', async () => {
  const other = await mkdtemp(join(tmpdir(), 'inkos-unregistered-')); extraRoots.push(other);
  expect(() => scope.createClient(other)).toThrow('Unregistered offline fixture project');
  expect(await readdir(other)).toEqual([]); expect(project.fixture.peers).toEqual([]);
  const alias = join(root, 'alias'); await symlink(root, alias);
  const peer = await scope.createClient(alias);
  expect(peer.codexHome).toBe(await realpath(resolveCodexHome(root)));
  expect((await stat(peer.codexHome)).mode & 0o077).toBe(0);
  expect(() => scope.registerProject(alias)).toThrow('already registered');
  expect(await readdir(peer.codexHome)).toEqual([]); // no auth.json, tokens or ready DTO
});
it('distinguishes absent/empty home and state-root resolution and rejects inherited authority', async () => {
  expect(resolveCodexHome(root)).toBe(join(root, '.inkos', 'codex', 'home'));
  vi.stubEnv('INKOS_CODEX_HOME', ''); expect(resolveCodexHome(root)).toBe(join(root, '.inkos', 'codex', 'home'));
  vi.stubEnv('INKOS_CODEX_STATE_ROOT', ''); expect(resolveCodexHome(root)).toBe(join(resolve(''), 'home'));
  expect(() => new CodexRuntimeFixtureScope().registerProject(root)).toThrow('Clear inherited');
  await expect(new CodexFixture().createClient(root)).rejects.toThrow('project-private');
  vi.stubEnv('INKOS_CODEX_STATE_ROOT', undefined); vi.stubEnv('INKOS_CODEX_HOME', join(root, 'external-home'));
  expect(() => new CodexRuntimeFixtureScope().registerProject(root)).toThrow('Clear inherited');
  await expect(new CodexFixture().createClient(root)).rejects.toThrow('project-private');
});
it('rejects a linked Codex home before account evidence', async () => {
  const external = join(root, 'external'); await mkdir(external, { mode: 0o700 });
  await mkdir(join(root, '.inkos', 'codex'), { recursive: true });
  await symlink(external, resolveCodexHome(root));
  await expect(scope.createClient(root)).rejects.toThrow('must be canonical');
  expect(project.fixture.requests).toEqual([]); expect(await readdir(external)).toEqual([]);
});
it('shares account state within a project and isolates valid projects, owner records and config', async () => {
  const otherRoot = await mkdtemp(join(tmpdir(), 'inkos-other-project-')); extraRoots.push(otherRoot);
  const other = scope.registerProject(otherRoot, { config: { model: 'gpt-6.1-sol', model_reasoning_effort: 'ultra', service_tier: 'priority' } });
  const first = await scope.createClient(root), sibling = await scope.createClient(root), second = await scope.createClient(otherRoot);
  project.setAccountResponse({ account: null, requiresOpenaiAuth: true });
  expect(await first.request('account/read')).toEqual(await sibling.request('account/read'));
  expect(await second.request('account/read')).toEqual(syntheticChatGptAccount());
  expect(first.codexHome).not.toBe(second.codexHome);
  await expect(withRuntimeExecution(root, async () => {})).rejects.toMatchObject({ code: 'RUNTIME_AUTH_REVOKED' });
  await withRuntimeExecution(otherRoot, async () => {
    expect(currentRuntimeRun()!.selection).toMatchObject({ modelId: 'gpt-6.1-sol', effort: 'ultra', serviceTier: 'priority' });
  });
  expect(new CodexAuthenticationOwner(first).snapshot()?.localState).toBe('disconnected');
  expect(new CodexAuthenticationOwner(second).snapshot()?.localState).toBe('ready');
  expect((await readAgentSettings(root)).modelConnectionRef).toBeNull();
  expect((await readAgentSettings(otherRoot)).modelConnectionRef).not.toBeNull();
  expect(await readdir(second.codexHome)).not.toContain('auth.json');
});
it('rejects a cross-project transport mismatch without mutating the other project', async () => {
  const otherRoot = await mkdtemp(join(tmpdir(), 'inkos-cross-project-')); extraRoots.push(otherRoot);
  const other = scope.registerProject(otherRoot); const foreign = await scope.createClient(otherRoot);
  await withRuntimeExecution(otherRoot, async () => {});
  const ownerPath = join(foreign.codexHome, 'inkos-connection.json');
  const ownerBefore = await readFile(ownerPath), settingsBefore = await readAgentSettings(otherRoot);
  const requestCount = other.fixture.requests.length;
  mocks.createClient.mockImplementation(() => foreign);
  const callback = vi.fn(async () => {});
  await expect(withRuntimeExecution(root, callback)).rejects.toMatchObject({ code: 'RUNTIME_AUTH_REVOKED' });
  expect(callback).not.toHaveBeenCalled(); expect(other.fixture.requests).toHaveLength(requestCount);
  expect(await readFile(ownerPath)).toEqual(ownerBefore); expect(await readAgentSettings(otherRoot)).toEqual(settingsBefore);
});
it('preserves frozen selection during nested execution and setting edits while retaining original authority', async () => {
  await scope.run(signal => withRuntimeExecution(root, async () => {
    const run = currentCodexRun()!, selection = run.selection;
    expect(Object.isFrozen(selection)).toBe(true);
    const peer = await run.takeClient();
    const workDir = join(root, 'isolated-work'); await mkdir(workDir); Object.defineProperty(peer, 'cwd', { value: workDir });
    await guardRuntimeExecution(signal); // cwd is not account authority
    const harness = await new CodexRuntimeAdapter(peer).describe();
    const settings = await readAgentSettings(root);
    await updateAgentSettings(root, { harnessPreferences: { codex: { model: 'gpt-6.1-sol', effort: 'ultra', speed: 'priority' } } },
      { expectedRevision: settings.revision, catalogs: { codex: harness.capabilities! } });
    const before = project.fixture.requests.length;
    await withRuntimeExecution(root, async () => {
      expect(currentRuntimeRun()!.selection).toBe(selection); expect(selection.modelId).toBe('fixture');
      expect(currentRuntimeRun()!.projectRoot).toBe(root);
    }, { signal });
    expect(project.fixture.requests.slice(before).map(request => request.method)).toEqual(['account/read']);
  }, { signal }));
  await withRuntimeExecution(root, async () => {
    expect(currentRuntimeRun()!.selection).toMatchObject({ modelId: 'gpt-6.1-sol', effort: 'ultra', serviceTier: 'priority' });
  });
  expect(modelRequests(project.fixture)).toEqual([]);
});
it('sends satisfiable frozen model/effort/tier with the distinct thread and turn wire names', async () => {
  await scope.drain(); scope = new CodexRuntimeFixtureScope();
  project = scope.registerProject(root, { reply: () => ({ text: 'selected' }) }); mocks.createClient.mockImplementation(scope.createClient);
  await withRuntimeExecution(root, async () => {
    const selection = currentRuntimeRun()!.selection;
    expect(selection).toMatchObject({ modelId: 'gpt-6.1-sol', effort: 'ultra', serviceTier: 'fast' });
    const host = agent(); await host.prompt('One selected turn'); expect(host.finalOutput).toBe('selected');
    expect(currentRuntimeRun()!.selection).toBe(selection);
  }, { settings: { model: 'gpt-6.1-sol', reasoningEffort: 'ultra', serviceTier: 'fast' } });
  expect(modelRequests(project.fixture).map(request => request.params)).toMatchObject([
    { model: 'gpt-6.1-sol', serviceTier: 'fast' }, { model: 'gpt-6.1-sol', effort: 'ultra', serviceTierForTurn: 'priority' },
  ]);
  expect(modelRequests(project.fixture)[1]!.params).not.toHaveProperty('serviceTier');
});
it.each(['revoked', 'different-identity'] as const)('fences a live run after %s and restores only by fresh admission', async mode => {
  let oldRun!: NonNullable<ReturnType<typeof currentCodexRun>>, peer!: Awaited<ReturnType<typeof scope.createClient>>;
  const effect = vi.fn(async () => {});
  await withRuntimeExecution(root, async () => {
    oldRun = currentCodexRun()!; peer = await oldRun.takeClient();
    project.setAccountResponse(mode === 'revoked' ? { account: null, requiresOpenaiAuth: true } : syntheticChatGptAccount('other@example.test'));
    await expect(dispatchCodexHostEffect(peer, effect)).rejects.toMatchObject({ code: 'RUNTIME_AUTH_REVOKED' });
    expect(effect).not.toHaveBeenCalled();
    project.setAccountResponse(syntheticChatGptAccount());
    await expect(guardRuntimeExecution()).rejects.toMatchObject({ code: 'RUNTIME_AUTH_REVOKED' });
  });
  await withRuntimeExecution(root, async () => { expect(currentRuntimeRun()!.selection.authGeneration).toBeGreaterThan(oldRun.selection.authGeneration); });
  const freshPeer = await scope.createClient(root), before = project.fixture.requests.length;
  await expect(oldRun.owner.guard(oldRun.selection, freshPeer)).rejects.toMatchObject({ code: 'RUNTIME_AUTH_REVOKED' });
  expect(project.fixture.requests).toHaveLength(before); expect(modelRequests(project.fixture)).toEqual([]);
});
it('keeps a persisted unknown owner passive, allows fresh admission, and fences captured targets', async () => {
  const peer = await scope.createClient(root), owner = new CodexAuthenticationOwner(peer);
  const captured = await owner.admit(peer), operation = owner.begin(); expect(owner.complete(operation, 'unknown')).toBe(true);
  const unknown = owner.snapshot(); const configBefore = await readAgentSettings(root);
  const observed = await observeCodexRuntime(peer);
  expect(observed.ready).toBe(false); expect(owner.snapshot()).toEqual(unknown);
  expect(await readAgentSettings(root)).toEqual(configBefore);
  await withRuntimeExecution(root, async () => { expect(currentRuntimeRun()!.selection.authGeneration).toBe(operation.authGeneration); });
  expect(owner.snapshot()?.localState).toBe('ready');
  await expect(owner.guard({ harnessId: 'codex', authContextRef: captured.authContextRef,
    authGeneration: captured.authGeneration, connectionRef: captured.connection.connectionRef }, peer)).rejects.toMatchObject({ code: 'RUNTIME_AUTH_REVOKED' });
  expect(modelRequests(project.fixture)).toEqual([]);
});
it('does not admit a transitioning owner or reconcile it by passive probe', async () => {
  const peer = await scope.createClient(root), owner = new CodexAuthenticationOwner(peer), operation = owner.begin();
  const callback = vi.fn(async () => {});
  expect((await observeCodexRuntime(peer)).ready).toBe(false);
  await expect(withRuntimeExecution(root, callback)).rejects.toMatchObject({ code: 'RUNTIME_AUTH_REVOKED' });
  expect(owner.snapshot()).toMatchObject({ localState: 'transitioning', operationId: operation.operationId });
  expect(callback).not.toHaveBeenCalled(); expect(modelRequests(project.fixture)).toEqual([]);
});
it('performs account-only probes without binding config, writing an owner, or dispatching a model', async () => {
  const peer = await scope.createClient(root), owner = new CodexAuthenticationOwner(peer);
  const configBefore = await readAgentSettings(root);
  expect((await observeCodexRuntime(peer)).ready).toBe(true);
  expect(owner.snapshot()).toBeUndefined(); expect(await readAgentSettings(root)).toEqual(configBefore);
  expect(modelRequests(project.fixture)).toEqual([]);
  await peer.close(); await scope.drain();
  expect(project.fixture.peers[0]).toMatchObject({ closed: true, closeCount: 1 });
});
it('cancels before admission with zero transport, callback and model calls', async () => {
  const controller = new AbortController(), reason = new Error('Pre-admission cancellation'); controller.abort(reason);
  const callback = vi.fn(async () => {});
  await expect(withRuntimeExecution(root, callback, { signal: controller.signal })).rejects.toBe(reason);
  expect(callback).not.toHaveBeenCalled(); expect(mocks.createClient).not.toHaveBeenCalled(); expect(project.fixture.peers).toEqual([]);
});
it('delivers in-flight cancellation to the real caller and drains cooperative reply work', async () => {
  const entered = barrier(), release = barrier(), controller = new AbortController(), reason = new Error('In-flight cancellation');
  await scope.drain(); scope = new CodexRuntimeFixtureScope();
  project = scope.registerProject(root, { reply: async turn => {
    entered.resolve(); await release.promise; expect(turn.signal.aborted).toBe(true);
    return { calls: [{ name: 'forbidden-after-cancel', args: {} }] };
  } }); mocks.createClient.mockImplementation(scope.createClient);
  const host = agent(controller.signal), notifications = vi.fn(); host.subscribe(notifications);
  const running = scope.run(() => host.prompt('Hold until cancellation'));
  try {
    await Promise.race([entered.promise, running.then(() => { throw new Error('Caller ended before fixture entry'); })]);
    controller.abort(reason);
    await expect(running).rejects.toBe(reason);
    const count = notifications.mock.calls.length; release.resolve(); await scope.drain();
    expect(notifications).toHaveBeenCalledTimes(count);
    expect(project.fixture.toolResponses).toEqual([]);
    expect(project.fixture.requests.filter(request => request.method === 'turn/interrupt')).toHaveLength(1);
  } finally { controller.abort(reason); release.resolve(); await scope.drain(); await Promise.allSettled([running]); }
});
it('drains an owned rejected operation even when teardown starts before the assertion', async () => {
  const entered = barrier(), release = barrier();
  project.setAccountResponse(async () => { entered.resolve(); await release.promise; throw new Error('Rejected readiness'); });
  const running = scope.run(signal => withRuntimeExecution(root, async () => {}, { signal }));
  try { await entered.promise; release.resolve(); await scope.drain(); await expect(running).rejects.toBeInstanceOf(Error); }
  finally { release.resolve(); await Promise.allSettled([running]); }
  expect(modelRequests(project.fixture)).toEqual([]); expect(project.fixture.pendingTaskCount).toBe(0);
});
it.each(['close', 'interrupt'] as const)('suppresses queued replies/tools/notifications after %s and closes subscriptions once', async mode => {
  const reply = vi.fn(() => ({ calls: [{ name: 'never', args: {} }] }));
  const fixture = new CodexFixture(reply), peer = await fixture.createClient(root), notifications = vi.fn(), tools = vi.fn(), onClose = vi.fn();
  peer.onNotification(notifications); peer.onRequest(tools); peer.onClose(onClose);
  await peer.request('turn/start', { input: [] });
  if (mode === 'interrupt') await peer.request('turn/interrupt');
  await peer.close(); await peer.close(); await fixture.drain();
  expect(reply).not.toHaveBeenCalled(); expect(tools).not.toHaveBeenCalled(); expect(onClose).toHaveBeenCalledTimes(1);
  expect(notifications.mock.calls.map(call => call[0])).toEqual(mode === 'interrupt' ? ['turn/completed'] : []);
  const late = vi.fn(); peer.onClose(late); await Promise.resolve(); await peer.close(); expect(late).toHaveBeenCalledTimes(1);
  await expect(peer.request('account/read')).rejects.toThrow('Codex app-server is closed');
});
it('surfaces detached notification failures through drain rather than losing rejections', async () => {
  const fixture = new CodexFixture(() => ({ text: 'unused' })), peer = await fixture.createClient(root);
  const failure = new Error('Synthetic subscriber failure'); peer.onNotification(() => { throw failure; });
  await peer.request('turn/start', { input: [] });
  await expect(fixture.drain()).rejects.toMatchObject({ errors: [failure] });
  await peer.close(); expect(fixture.pendingTaskCount).toBe(0);
});

it.each([['reply', 'close'], ['reply', 'interrupt'], ['tool', 'close'], ['tool', 'interrupt']] as const)(
  'reports a late %s failure through drain after %s', async (source, mode) => {
    const entered = barrier(), failure = new Error('late fixture failure');
    let reject!: (error: unknown) => void;
    const deferred = new Promise<never>((_resolve, fail) => { reject = fail; });
    const fixture = new CodexFixture(() => {
      if (source === 'reply') { entered.resolve(); return deferred; }
      return { calls: [{ name: 'deferred-tool', args: {} }] };
    });
    const peer = await fixture.createClient(root), notifications = vi.fn();
    peer.onNotification(notifications); peer.onRequest(() => { entered.resolve(); return deferred; });
    try {
      await peer.request('turn/start', { input: [] }); await entered.promise;
      if (mode === 'close') await peer.close(); else await peer.request('turn/interrupt');
      const count = notifications.mock.calls.length;
      reject(failure);
      await expect(fixture.drain()).rejects.toMatchObject({ errors: [failure] });
      expect(notifications).toHaveBeenCalledTimes(count); expect(fixture.toolResponses).toEqual([]);
      expect(fixture.pendingTaskCount).toBe(0);
    } finally { reject(failure); await peer.close(); await fixture.drain(); }
  });
it.each([['reply', 'close'], ['reply', 'interrupt'], ['tool', 'close'], ['tool', 'interrupt']] as const)(
  'drains cooperative %s rejection with the exact %s cancellation reason', async (source, mode) => {
    const entered = barrier();
    let reject!: (error: unknown) => void, signal!: AbortSignal;
    const deferred = new Promise<never>((_resolve, fail) => { reject = fail; });
    const fixture = new CodexFixture(turn => {
      signal = turn.signal;
      if (source === 'reply') { entered.resolve(); return deferred; }
      return { calls: [{ name: 'deferred-tool', args: {} }] };
    });
    const peer = await fixture.createClient(root);
    peer.onRequest(() => { entered.resolve(); return deferred; });
    try {
      await peer.request('turn/start', { input: [] }); await entered.promise;
      if (mode === 'close') await peer.close(); else await peer.request('turn/interrupt');
      expect(signal.aborted).toBe(true); reject(signal.reason);
      await fixture.drain(); expect(fixture.pendingTaskCount).toBe(0); expect(fixture.toolResponses).toEqual([]);
    } finally { await peer.close(); reject(signal.reason); await fixture.drain(); }
  });
it.each(['reply', 'tool'] as const)('delivers an open-peer %s failure once through turn/completed without a drain duplicate', async source => {
  const failure = new Error('expected open-peer model failure');
  const fixture = new CodexFixture(() => {
    if (source === 'reply') throw failure;
    return { calls: [{ name: 'failing-tool', args: {} }] };
  });
  const peer = await fixture.createClient(root), notifications = vi.fn();
  peer.onNotification(notifications); peer.onRequest(() => { throw failure; });
  try {
    await peer.request('turn/start', { input: [] }); await fixture.drain();
    const completed = notifications.mock.calls.filter(call => call[0] === 'turn/completed');
    expect(completed).toHaveLength(1);
    expect(completed[0]![1]).toMatchObject({ turn: { status: 'failed', error: { message: failure.message } } });
    expect(fixture.pendingTaskCount).toBe(0);
  } finally { await peer.close(); await fixture.drain(); }
});
it('reports a throwing completed-notification listener through drain after the turn is finished', async () => {
  const failure = new Error('completed notification failure'), fixture = new CodexFixture(() => ({ text: 'done' }));
  const peer = await fixture.createClient(root);
  peer.onNotification(method => { if (method === 'turn/completed') throw failure; });
  try {
    await peer.request('turn/start', { input: [] });
    await expect(fixture.drain()).rejects.toMatchObject({ errors: [failure] });
    expect(fixture.pendingTaskCount).toBe(0);
  } finally { await peer.close(); await fixture.drain(); }
});

it.each(['.inkos', 'codex'] as const)('rejects a linked %s ancestor before creating anything in another registered project', async ancestor => {
  const otherRoot = await mkdtemp(join(tmpdir(), 'inkos-linked-ancestor-')); extraRoots.push(otherRoot);
  const other = scope.registerProject(otherRoot);
  const target = join(otherRoot, 'untouched'); await mkdir(target, { mode: 0o700 });
  if (ancestor === '.inkos') await rm(join(root, '.inkos'), { recursive: true, force: true });
  const linked = ancestor === '.inkos' ? join(root, '.inkos') : join(root, '.inkos', 'codex');
  await symlink(target, linked);
  const before = await readdir(otherRoot, { recursive: true });
  await expect(scope.createClient(root)).rejects.toThrow('must be canonical');
  expect(await readdir(otherRoot, { recursive: true })).toEqual(before);
  expect(project.fixture.peers).toEqual([]); expect(other.fixture.peers).toEqual([]);
  expect(project.fixture.requests).toEqual([]);
});
