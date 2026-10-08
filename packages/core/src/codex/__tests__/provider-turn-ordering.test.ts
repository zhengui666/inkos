import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Type } from '@sinclair/typebox';
import { Agent } from '../agent.js';
import { resolveCodexModel } from '../model.js';
import { isCreationTransientFailure } from '../../creation/transient.js';
import type { LLMClient } from '../../llm/provider.js';
const mocks = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('../client.js', () => ({ createCodexClient: mocks.create }));
class FailureClient {
  readonly cwd = '/offline-fixture';
  notifications = new Set<(method: string, params: unknown) => void>();
  run: () => void | Promise<void> = () => {};
  request = vi.fn(async (method: string) => {
    if (method === 'account/read') return { account: { type: 'chatgpt' }, requiresOpenaiAuth: false };
    if (method === 'model/list') return { data: [{ id: 'fixture', model: 'fixture', isDefault: true,
      supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }] };
    if (method === 'thread/start') return { thread: { id: 'thread' }, model: 'fixture' };
    if (method === 'turn/start') { queueMicrotask(() => { void this.run(); }); return { turn: { id: 'turn' } }; }
    return {};
  });
  onNotification(listener: (method: string, params: unknown) => void) {
    this.notifications.add(listener); return () => { this.notifications.delete(listener); };
  }
  handler?: (method: string, params: unknown) => unknown;
  onRequest(listener: (method: string, params: unknown) => unknown) { this.handler = listener; return () => { this.handler = undefined; }; }
  async tool() {
    return await this.handler!('item/tool/call', { threadId: 'thread', turnId: 'turn', callId: 'call', tool: 'submit', arguments: { value: 7 } });
  }
  onClose() { return () => {}; }
  close = vi.fn(async () => {});
  notify(method: string, params: object) {
    for (const listener of this.notifications) listener(method, { threadId: 'thread', turnId: 'turn', ...params });
  }
  terminal(info: unknown, source: 'error' | 'turn/completed' = 'error') {
    const error = { message: 'Offline provider fixture', codexErrorInfo: info,
      additionalDetails: 'private raw details must not escape', token: 'fixture-secret' };
    if (source === 'error') this.notify(source, { error, willRetry: false });
    else this.notify(source, { turn: { id: 'turn', status: 'failed', error } });
  }
}
const clientOptions: LLMClient = { provider: 'openai', apiFormat: 'chat', stream: false,
  defaults: { temperature: 0.7, maxTokens: 4096, thinkingBudget: 0, extra: {} },
  _codex: { projectRoot: '/offline-fixture', settings: { model: 'fixture', reasoningEffort: 'high', serviceTier: 'default' } } };
let client: FailureClient;
beforeEach(() => { client = new FailureClient(); mocks.create.mockReset().mockResolvedValue(client); });
afterEach(() => { vi.restoreAllMocks(); });

it('binds the successful start response before later mismatched notifications overtake its gated read-only inspection', async () => {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const agent = new Agent({ projectRoot: '/offline-fixture', settings: clientOptions._codex!.settings,
    initialState: { model: resolveCodexModel(), systemPrompt: '', messages: [], tools: [] } });
  agent.subscribe(event => {
    if (event.type === 'message_start' && event.message.role === 'assistant') { entered(); return gate; }
  });
  const ordinaryRequest = client.request.getMockImplementation()!;
  client.request.mockImplementation(async method => {
    if (method !== 'turn/start') return ordinaryRequest(method);
    client.notify('item/agentMessage/delta', { itemId: 'answer', delta: 'Offline partial' });
    return { turn: { id: 'correct-rpc-turn' } };
  });
  const pending = agent.prompt('Offline later notification fixture').then(() => agent.modelError).catch(error => error);
  await started;
  // Let the RPC continuation register its inspection while the earlier listener remains gated.
  for (let i = 0; i < 10; i++) await Promise.resolve();
  client.notify('turn/started', { turn: { id: 'wrong-later-turn', status: 'inProgress' } });
  client.notify('error', { turnId: 'wrong-later-turn', willRetry: false,
    error: { message: 'Stale other turn rate limit', codexErrorInfo: 'rateLimitExceeded' } });
  client.notify('turn/completed', { turn: { id: 'correct-rpc-turn', status: 'completed' } });
  release();
  const result = await pending;
  expect(result).toBeUndefined();
});


function heldAgent(signal?: AbortSignal) {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const execute = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'saved' }], details: {} }));
  const persisted = vi.fn();
  const agent = new Agent({ projectRoot: '/offline-fixture', settings: clientOptions._codex!.settings, signal,
    initialState: { model: resolveCodexModel(), systemPrompt: '', messages: [], tools: [
      { name: 'submit', label: 'Submit', description: 'Offline tool', parameters: Type.Object({ value: Type.Integer() }), execute },
    ] } });
  agent.subscribe(event => {
    if (event.type === 'message_start' && event.message.role === 'assistant') { entered(); return gate; }
    if (event.type === 'message_end' && event.message.role === 'assistant') persisted();
  });
  return { agent, execute, persisted, started, release: () => release() };
}

it('checks a notification-first contradiction after a held listener without admitting later tool or persistence work', async () => {
  const fixture = heldAgent(), ordinaryRequest = client.request.getMockImplementation()!;
  client.request.mockImplementation(async method => {
    if (method !== 'turn/start') return ordinaryRequest(method);
    client.notify('item/agentMessage/delta', { itemId: 'answer', delta: 'Offline partial' });
    client.notify('turn/started', { turn: { id: 'wrong-notification-turn', status: 'inProgress' } });
    client.notify('error', { turnId: 'wrong-notification-turn', willRetry: false,
      error: { message: 'Wrong turn rate limit', codexErrorInfo: 'rateLimitExceeded' } });
    return { turn: { id: 'correct-rpc-turn' } };
  });
  const pending = fixture.agent.prompt('Offline notification-first fixture').catch(error => error);
  await fixture.started;
  for (let i = 0; i < 10; i++) await Promise.resolve();
  const tool = client.tool().catch(error => error);
  client.notify('item/completed', { item: { id: 'answer', type: 'agentMessage', text: 'Must not persist' } });
  fixture.release();
  const failure = await pending;
  await tool;
  expect(failure).toMatchObject({ code: 'WORKER_MODEL_ERROR', cause: {
    providerFailure: { source: 'error', codexErrorInfo: 'rateLimitExceeded' } } });
  expect(isCreationTransientFailure(failure)).toBe(false);
  expect(fixture.execute).not.toHaveBeenCalled();
  expect(fixture.persisted).not.toHaveBeenCalled();
  expect(fixture.agent.finalOutput).toBeUndefined();
});

it.each([false, true])('keeps cancellation-first response binding and later effects blocked, RPC already queued=%s', async rpcFirst => {
  const controller = new AbortController(), reason = new Error('User stopped offline fixture');
  const fixture = heldAgent(controller.signal), ordinaryRequest = client.request.getMockImplementation()!;
  let respond!: () => void;
  const response = new Promise<void>(resolve => { respond = resolve; });
  client.request.mockImplementation(async method => {
    if (method !== 'turn/start') return ordinaryRequest(method);
    client.notify('item/agentMessage/delta', { itemId: 'answer', delta: 'Offline partial' });
    await response;
    return { turn: { id: 'correct-rpc-turn' } };
  });
  const pending = fixture.agent.prompt('Offline cancellation-first fixture').catch(error => error);
  await fixture.started;
  if (rpcFirst) { respond(); for (let i = 0; i < 10; i++) await Promise.resolve(); }
  controller.abort(reason);
  const tool = client.tool().catch(error => error);
  client.notify('turn/started', { turn: { id: 'wrong-later-turn', status: 'inProgress' } });
  client.notify('error', { turnId: 'wrong-later-turn', willRetry: false,
    error: { message: 'Must not be admitted', codexErrorInfo: 'rateLimitExceeded' } });
  client.notify('item/completed', { item: { id: 'answer', type: 'agentMessage', text: 'Must not persist' } });
  client.notify('turn/completed', { turn: { id: 'correct-rpc-turn', status: 'completed' } });
  respond(); fixture.release();
  expect(await pending).toBe(reason);
  await tool;
  expect(fixture.execute).not.toHaveBeenCalled();
  expect(fixture.persisted).not.toHaveBeenCalled();
  expect(fixture.agent.finalOutput).toBeUndefined();
  expect(fixture.agent.modelError).toBeUndefined();
});


it('uses the queued RPC identity before admitting a later tool request behind an old listener', async () => {
  const fixture = heldAgent(), ordinaryRequest = client.request.getMockImplementation()!;
  client.request.mockImplementation(async method => {
    if (method !== 'turn/start') return ordinaryRequest(method);
    client.notify('item/agentMessage/delta', { itemId: 'answer', delta: 'Offline partial' });
    return { turn: { id: 'correct-rpc-turn' } };
  });
  const pending = fixture.agent.prompt('Offline stale-tool fixture');
  await fixture.started;
  for (let i = 0; i < 10; i++) await Promise.resolve();
  const tool = client.tool(); // Carries the unrelated fixture turn ID "turn".
  client.notify('turn/completed', { turn: { id: 'correct-rpc-turn', status: 'completed' } });
  fixture.release();
  await expect(tool).resolves.toMatchObject({ success: false });
  await pending;
  expect(fixture.execute).not.toHaveBeenCalled();
  expect(fixture.agent.modelError).toBeUndefined();
});


it.each(['completed', 'failed'])('does not admit queued tool effects after the turn is %s', async status => {
  const execute = vi.fn(async () => ({ content: [], details: {} }));
  const agent = new Agent({ projectRoot: '/offline-fixture', settings: clientOptions._codex!.settings,
    initialState: { model: resolveCodexModel(), systemPrompt: '', messages: [], tools: [
      { name: 'submit', label: 'Submit', description: 'Offline tool', parameters: Type.Object({ value: Type.Integer() }), execute },
    ] } });
  const ordinaryRequest = client.request.getMockImplementation()!;
  let tool!: Promise<unknown>;
  client.request.mockImplementation(async method => {
    if (method !== 'turn/start') return ordinaryRequest(method);
    client.notify('turn/started', { turn: { id: 'turn', status: 'inProgress' } });
    client.notify('turn/completed', { turn: { id: 'turn', status,
      ...(status === 'failed' ? { error: { message: 'Offline rate limit', codexErrorInfo: 'rateLimitExceeded' } } : {}) } });
    // Process the matching terminal notification before the late tool arrives,
    // while this turn/start RPC is still pending and the native snapshot is zero.
    await new Promise(resolve => setImmediate(resolve));
    if (status === 'failed') expect(agent.modelError).toMatchObject({ code: 'RATE_LIMITED', hostToolCalls: 0 });
    tool = client.tool();
    return { turn: { id: 'turn' } };
  });
  await agent.prompt('Offline terminal-admission fixture');
  await expect(tool).resolves.toMatchObject({ success: false });
  expect(execute).not.toHaveBeenCalled();
  expect(agent.finalOutput).toBeUndefined();
  expect(agent.state.messages.filter(message => message.role === 'toolResult'
    || message.role === 'assistant' && message.content.some(part => part.type === 'toolCall'))).toEqual([]);
});
