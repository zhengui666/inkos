import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Type } from '@sinclair/typebox';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from '../agent.js';
import { resolveCodexModel } from '../model.js';
import { GoalExecutor } from '../../goals/executor.js';
import { GoalStore } from '../../goals/store.js';
import { chapterGoalInput, createChapterGoalAdapter } from '../../goals/chapters.js';
import type { GoalReceipt, GoalStepAdapter } from '../../goals/contracts.js';
import { ArchitectAgent } from '../../agents/architect.js';
import { CreationTaskCoordinator } from '../../creation/coordinator.js';
import { inferCreationPlan } from '../../creation/contracts.js';
import { PipelineRunner } from '../../pipeline/runner.js';
import { SchedulerStore } from '../../pipeline/scheduler-store.js';
import { runWorkerAgent, runWorkerAgentTool } from '../../agent/worker-agent.js';
import { isCreationTransientFailure } from '../../creation/transient.js';
import type { LLMClient } from '../../llm/provider.js';
import { withCodexExecution } from '../../runtime/execution.js';

const mocks = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('../client.js', () => ({ createCodexClient: mocks.create }));

class FailureClient {
  closed = false;
  readonly closes = new Set<() => void>();
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
  onClose(fn: () => void) { this.closes.add(fn); return () => { this.closes.delete(fn); }; }
  close = vi.fn(async () => { this.closed = true; for (const fn of this.closes) fn(); this.closes.clear(); });
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
let clientOptions: LLMClient = { provider: 'openai', apiFormat: 'chat', stream: false,
  defaults: { temperature: 0.7, maxTokens: 4096, thinkingBudget: 0, extra: {} },
  _codex: { projectRoot: '', settings: { model: 'fixture', reasoningEffort: 'high', serviceTier: 'default' } } };
const resultTool = { name: 'submit', label: 'Submit', description: 'Offline result', parameters: Type.Object({ value: Type.Integer() }) };
const run = () => runWorkerAgent(clientOptions, 'fixture', [{ role: 'user', content: 'Offline fixture only' }]);
let client: FailureClient, fixtureRoot: string;
beforeEach(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), 'inkos-provider-recovery-'));
  vi.stubEnv('INKOS_CODEX_HOME', ''); delete process.env.INKOS_CODEX_HOME;
  vi.stubEnv('INKOS_CODEX_STATE_ROOT', ''); delete process.env.INKOS_CODEX_STATE_ROOT;
  client = new FailureClient();
  clientOptions = { ...clientOptions, _codex: { ...clientOptions._codex, projectRoot: fixtureRoot } };
  mocks.create.mockReset().mockImplementation(async (projectRoot: string) => {
    const codexHome = join(projectRoot, '.inkos', 'codex', 'home');
    mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    const legacyPath = join(projectRoot, '.inkos', 'codex-config.json');
    try { writeFileSync(legacyPath, JSON.stringify({ model: 'fixture', reasoningEffort: 'high', serviceTier: 'default' }), { flag: 'wx' }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    let used = false, closed = false;
    const closes = new Set<() => void>();
    return { cwd: client.cwd, codexHome, get closed() { return closed || used && client.closed; },
      request: async (method: string, params?: unknown, options?: unknown) => {
        if (method === 'thread/start') { used = true; client.closed = false; }
        return Reflect.apply(client.request, client, [method, params, options]);
      },
      onNotification: client.onNotification.bind(client), onRequest: client.onRequest.bind(client),
      onClose: (fn: () => void) => { closes.add(fn); client.closes.add(fn); return () => { closes.delete(fn); client.closes.delete(fn); }; },
      close: async () => { closed = true; if (used) await client.close(); else for (const fn of closes) { client.closes.delete(fn); fn(); } },
    };
  });
});
afterEach(async () => { await rm(fixtureRoot, { recursive: true, force: true }); vi.unstubAllEnvs(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

for (const source of ['error', 'turn/completed'] as const) describe(`native provider recovery via ${source}`, () => {
  it.each([
    ['rateLimitExceeded', 'RATE_LIMITED'], ['serverOverloaded', 'MODEL_UNAVAILABLE'], ['flexUnavailable', 'MODEL_UNAVAILABLE'],
    [{ httpConnectionFailed: { httpStatusCode: 503 } }, 'MODEL_UNAVAILABLE'],
    [{ responseStreamConnectionFailed: { httpStatusCode: 502 } }, 'MODEL_UNAVAILABLE'],
    [{ httpConnectionFailed: { httpStatusCode: 408 } }, 'MODEL_UNAVAILABLE'],
    [{ responseStreamConnectionFailed: { httpStatusCode: 504 } }, 'MODEL_UNAVAILABLE'],
  ])('classifies %j from structured native fields', async (info, code) => {
    client.run = () => client.terminal(info, source);
    const failure = await run().catch(error => error);
    expect(failure).toMatchObject({ code, message: 'Offline provider fixture', providerFailure: { source, codexErrorInfo: info } });
    expect(failure.providerFailure).toEqual({ source, codexErrorInfo: info,
      ...(source === 'error' ? { willRetry: false } : { turnStatus: 'failed' }) });
    expect(isCreationTransientFailure(new Error('Retained candidate', { cause: failure }))).toBe(true);
    expect(JSON.stringify(failure)).not.toContain('fixture-secret');
    expect(JSON.stringify(failure)).not.toContain('private raw details');
    expect(client.request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(1);
  });

  it.each(['usageLimitExceeded', 'sessionBudgetExceeded', 'contextWindowExceeded', 'unauthorized', 'badRequest',
    'cyberPolicy', 'misalignmentPolicyViolation', 'internalServerError', 'other', undefined, 'RATE_LIMITED',
    { httpConnectionFailed: { httpStatusCode: null } }, { responseStreamConnectionFailed: { httpStatusCode: null } },
    { httpConnectionFailed: { httpStatusCode: 401 } }, { httpConnectionFailed: { httpStatusCode: 429 } },
    { httpConnectionFailed: { httpStatusCode: 500 } }, { httpConnectionFailed: { httpStatusCode: '503' } }, { httpConnectionFailed: {} },
    { httpConnectionFailed: { httpStatusCode: 503 }, unauthorized: true },
    { responseStreamDisconnected: { httpStatusCode: null } }, { responseTooManyFailedAttempts: { httpStatusCode: 503 } },
  ])('does not turn %j into a retry', async info => {
    client.run = () => client.terminal(info, source);
    const failure = await run().catch(error => error);
    expect(failure).toMatchObject({ code: 'WORKER_MODEL_ERROR' });
    expect(isCreationTransientFailure(failure)).toBe(false);
    expect(client.request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(1);
  });
});

it('does not accept or correct failed native structured output', async () => {
  const validate = vi.fn((value: { value: number }) => value);
  client.run = () => {
    client.notify('item/completed', { item: { id: 'answer', type: 'agentMessage', text: '{"resultJson":"{\\"value\\":7}"}' } });
    client.terminal('rateLimitExceeded', 'turn/completed');
  };
  await expect(runWorkerAgentTool(clientOptions, 'fixture', [{ role: 'user', content: 'Offline' }], { ...resultTool, validate }))
    .rejects.toMatchObject({ code: 'RATE_LIMITED', attempts: 1, providerFailure: { source: 'turn/completed' } });
  expect(validate).not.toHaveBeenCalled();
  expect(client.request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(1);
});

it('lets the native peer finish its own retry without a host retry or stale failure', async () => {
  client.run = () => {
    client.notify('error', { willRetry: true, error: { message: 'Retrying', codexErrorInfo: 'serverOverloaded' } });
    client.notify('item/completed', { item: { id: 'answer', type: 'agentMessage', text: 'Recovered' } });
    client.notify('turn/completed', { turn: { id: 'turn', status: 'completed' } });
  };
  await expect(run()).resolves.toMatchObject({ content: 'Recovered' });
  expect(client.request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(1);
});


it.each(['interrupted', 'completed', 'inProgress', 'unknown'])('keeps a %s turn with a rate-limit error blocked', async status => {
  client.run = () => client.notify('turn/completed', { turn: { id: 'turn', status,
    error: { message: 'Uncertain turn outcome', codexErrorInfo: 'rateLimitExceeded' } } });
  const failure = await run().catch(error => error);
  expect(failure).toMatchObject({ code: 'WORKER_MODEL_ERROR', providerFailure: { turnStatus: status } });
  expect(isCreationTransientFailure(failure)).toBe(false);
});

it('preserves the terminal failure when it cancels an in-flight turn/start request', async () => {
  const ordinaryRequest = client.request.getMockImplementation()!;
  client.request.mockImplementation(async method => {
    if (method !== 'turn/start') return ordinaryRequest(method);
    client.notify('turn/started', { turn: { id: 'turn', status: 'inProgress' } });
    client.terminal('rateLimitExceeded');
    await new Promise(resolve => setImmediate(resolve));
    throw new Error('Codex request cancelled');
  });
  await expect(run()).rejects.toMatchObject({ code: 'RATE_LIMITED', providerFailure: { source: 'error' } });
});

it.each(['error', 'turn/completed'] as const)('does not retry uncertain peer cleanup after %s and retains both causes', async source => {
  const cleanup = Object.assign(new Error('Offline cleanup failure'), { code: 'ECONNRESET' });
  client.close.mockRejectedValue(cleanup);
  client.run = () => client.terminal('serverOverloaded', source);
  const failure = await run().catch(error => error);
  expect(failure).toBeInstanceOf(AggregateError);
  expect(failure.cause).toMatchObject({ code: 'MODEL_UNAVAILABLE', providerFailure: { codexErrorInfo: 'serverOverloaded' } });
  expect(failure.errors).toEqual([failure.cause, cleanup]);
  expect(isCreationTransientFailure(failure)).toBe(false);
});

it('does not carry a prior native failure into the next successful Agent invocation', async () => {
  const agent = new Agent({ projectRoot: fixtureRoot, settings: clientOptions._codex!.settings,
    initialState: { model: resolveCodexModel(), systemPrompt: '', messages: [], tools: [] } });
  client.run = () => client.terminal('rateLimitExceeded', 'turn/completed');
  await agent.prompt('First offline turn');
  expect(agent.modelError).toMatchObject({ code: 'RATE_LIMITED' });
  client.run = () => {
    client.notify('item/completed', { item: { id: 'answer', type: 'agentMessage', text: 'Recovered' } });
    client.notify('turn/completed', { turn: { id: 'turn', status: 'completed' } });
  };
  await agent.prompt('Next offline turn');
  expect(agent.modelError).toBeUndefined();
  expect(agent.finalOutput).toBe('Recovered');
});

it.each(['rateLimitExceeded', 'usageLimitExceeded'])('preserves foundation policy across restart for %s', async info => {
  const root = await mkdtemp(join(tmpdir(), 'inkos-native-foundation-'));
  const scheduler = new SchedulerStore(join(root, '.inkos', 'harness.sqlite'));
  const pipeline = new PipelineRunner({ projectRoot: root, client: clientOptions, model: 'fixture' });
  let coordinator = new CreationTaskCoordinator(root, pipeline, scheduler, 1000);
  client.run = () => client.terminal(info);
  const generate = vi.spyOn(ArchitectAgent.prototype, 'generateFoundation').mockImplementation(async () => {
    await runWorkerAgent({ ...clientOptions, _codex: { ...clientOptions._codex, projectRoot: root } }, 'fixture',
      [{ role: 'user', content: 'Offline fixture only' }]);
    throw new Error('Unexpected native success');
  });
  try {
    const request = { id: '11111111-1111-4111-8111-111111111111', kind: 'short' as const, brief: 'Offline native recovery fixture.' };
    const created = coordinator.tasks.create(request, inferCreationPlan(request,
      { language: 'en', daemon: { market: { platform: 'fixture', language: 'en' } } } as any));
    coordinator.tasks.update(created.id, task => ({ ...task, planStatus: 'ready' }));
    for (let attempt = 1; attempt <= 4; attempt++) {
      coordinator.tasks.update(created.id, task => ({ ...task, nextAttemptAt: 0 }));
      await coordinator.prepare(created.id, new AbortController().signal);
      if (attempt === 2) { coordinator.close(); coordinator = new CreationTaskCoordinator(root, pipeline, scheduler, 1000); }
    }
    const result = coordinator.tasks.get(created.id);
    if (info === 'rateLimitExceeded') {
      expect(generate).toHaveBeenCalledTimes(4);
      expect(result).toMatchObject({ foundation: 'pending', phase: 'queued', foundationAttempts: 4,
        foundationTransientFailures: 4, foundationFailures: 0 });
      expect(result.nextAttemptAt).toBeGreaterThan(result.updatedAt);
    } else {
      expect(generate).toHaveBeenCalledTimes(3);
      expect(result).toMatchObject({ foundation: 'blocked', phase: 'blocked', foundationAttempts: 3,
        foundationTransientFailures: 0, foundationFailures: 3 });
    }
    expect(await readFile(join(root, 'works', created.workId, 'source', 'story', 'brief.md'), 'utf8')).toContain(request.brief);
    expect(scheduler.chapters(created.workId)).toEqual([]);
  } finally { coordinator.close(); scheduler.close(); await rm(root, { recursive: true, force: true }); }
});

it('persists native retry classification across goal reopen without rewriting an accepted receipt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inkos-native-goal-')), path = join(root, 'harness.sqlite');
  let store = new GoalStore(path);
  const receipts = new Map<string, GoalReceipt>(), writes = vi.fn();
  const adapter: GoalStepAdapter = {
    kind: 'longform.write_chapter', retrySafe: true, withScope: (_context, task) => task(),
    reconcile: async context => receipts.has(context.step.operationKey)
      ? { status: 'completed', receipt: receipts.get(context.step.operationKey)! }
      : { status: 'absent', baselineState: 'unchanged fixture input' },
    execute: async context => {
      await run(); writes();
      receipts.set(context.step.operationKey, { operationKey: context.step.operationKey, artifacts: [], evidence: { accepted: true } });
    },
    isRetryable: createChapterGoalAdapter({ projectRoot: root, pipeline: {} as any }).isRetryable,
  };
  try {
    store.create(chapterGoalInput({ id: 'native-goal', workId: 'novel', intent: 'Offline recovery fixture',
      startChapter: 1, endChapter: 1, expiresAt: null }));
    store.requestRun('native-goal', store.get('native-goal').version);
    client.run = () => client.terminal({ httpConnectionFailed: { httpStatusCode: 503 } }, 'turn/completed');
    const exhausted = await new GoalExecutor(store, [adapter], 0).run('native-goal');
    expect(exhausted).toMatchObject({ status: 'failed', attempts: 3, error: { code: 'GOAL_BUDGET_EXHAUSTED' },
      steps: [{ status: 'pending', attempts: 3, error: { code: 'MODEL_UNAVAILABLE' }, receipt: null }] });
    store.close(); store = new GoalStore(path);
    expect(store.get('native-goal')).toEqual(exhausted);
    store.retryTransientFailure('native-goal', exhausted.version);
    client.run = () => {
      client.notify('item/completed', { item: { id: 'answer', type: 'agentMessage', text: 'Offline accepted result' } });
      client.notify('turn/completed', { turn: { id: 'turn', status: 'completed' } });
    };
    const completed = await new GoalExecutor(store, [adapter], 0).run('native-goal');
    expect(completed).toMatchObject({ status: 'completed', attempts: 4, steps: [{ status: 'completed', attempts: 4 }] });
    expect(completed.steps[0]!.operationKey).toBe(exhausted.steps[0]!.operationKey);
    expect(writes).toHaveBeenCalledOnce();
    store.close(); store = new GoalStore(path);
    expect(await new GoalExecutor(store, [adapter], 0).run('native-goal')).toEqual(completed);
    expect(writes).toHaveBeenCalledOnce();
    expect(client.request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(4);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});


it.each(['error', 'turn/completed'] as const)('keeps %s after an accepted dynamic result nonretryable', async source => {
  const validate = vi.fn((value: { value: number }) => value);
  client.run = async () => { await client.tool(); client.terminal('rateLimitExceeded', source); };
  const failure = await runWorkerAgentTool(clientOptions, 'fixture', [{ role: 'user', content: 'Offline fixture' }],
    { ...resultTool, validate }).catch(error => error);
  expect(validate).toHaveBeenCalledOnce();
  expect(failure).toMatchObject({ code: 'WORKER_MODEL_ERROR', hostToolCalls: 1,
    providerFailure: { source, codexErrorInfo: 'rateLimitExceeded' } });
  expect(isCreationTransientFailure(failure)).toBe(false);
  expect(client.request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(1);
});


it.each([null, 503, ['failed'], { status: 'failed', token: 'fixture-secret' }, 'fixture-secret'])
('does not retain malformed turn status %j', async status => {
  client.run = () => client.notify('turn/completed', { turn: { id: 'turn', status,
    error: { message: 'Offline failure', codexErrorInfo: 'rateLimitExceeded' } } });
  const failure = await run().catch(error => error);
  expect(failure).toMatchObject({ code: 'WORKER_MODEL_ERROR', providerFailure: { turnStatus: 'unknown' } });
  expect(JSON.stringify(failure)).not.toContain('fixture-secret');
});

// Admit on real I/O before fake clocks exercise the original RPC/cleanup deadline assertions.
it.each(['error', 'turn/completed'] as const)('preserves cleanup uncertainty over a worker deadline after %s', async source  => withCodexExecution(fixtureRoot, async () => {
  vi.useFakeTimers();
  client.run = () => client.terminal('serverOverloaded', source);
  client.close.mockImplementation(async () => {
    await new Promise(resolve => setTimeout(resolve, 20));
    throw Object.assign(new Error('Offline cleanup failure'), { code: 'ECONNRESET' });
  });
  const pending = runWorkerAgent(clientOptions, 'fixture', [{ role: 'user', content: 'Offline' }], { timeoutMs: 10 }).catch(error => error);
  await vi.advanceTimersByTimeAsync(30);
  const failure = await pending;
  expect(failure).toBeInstanceOf(AggregateError);
  expect(failure.cause).toMatchObject({ code: 'MODEL_UNAVAILABLE', providerFailure: { source } });
  expect(isCreationTransientFailure(failure)).toBe(false);
}, { settings: clientOptions._codex!.settings }));


it.each(['error', 'turn/completed'] as const)('keeps accepted-tool uncertainty blocked when a deadline expires during %s cleanup', async source  => withCodexExecution(fixtureRoot, async () => {
  vi.useFakeTimers();
  const validate = vi.fn((value: { value: number }) => value);
  client.run = async () => { await client.tool(); client.terminal('rateLimitExceeded', source); };
  client.close.mockImplementation(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  const pending = runWorkerAgentTool(clientOptions, 'fixture', [{ role: 'user', content: 'Offline' }],
    { ...resultTool, validate }, { timeoutMs: 10 }).catch(error => error);
  await vi.advanceTimersByTimeAsync(30);
  const failure = await pending;
  expect(validate).toHaveBeenCalledOnce();
  expect(failure).toMatchObject({ code: 'WORKER_MODEL_ERROR', hostToolCalls: 1, providerFailure: { source } });
  expect(isCreationTransientFailure(failure)).toBe(false);
}, { settings: clientOptions._codex!.settings }));

it.each(['error', 'turn/completed'] as const)('does not downgrade an account failure to timeout during %s cleanup', async source  => withCodexExecution(fixtureRoot, async () => {
  vi.useFakeTimers();
  client.run = () => client.terminal('usageLimitExceeded', source);
  client.close.mockImplementation(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  const pending = runWorkerAgent(clientOptions, 'fixture', [{ role: 'user', content: 'Offline' }], { timeoutMs: 10 }).catch(error => error);
  await vi.advanceTimersByTimeAsync(30);
  expect(await pending).toMatchObject({ code: 'WORKER_MODEL_ERROR', providerFailure: { source, codexErrorInfo: 'usageLimitExceeded' } });
}, { settings: clientOptions._codex!.settings }));


for (const source of ['error', 'turn/completed'] as const) {
  it.each(['dynamic', 'outputSchema'])('does not retry a later native failure after an earlier %s validator persisted a candidate (' + source + ')', async transport => {
    let turn = 0, retainedCandidates = 0;
    const validate = vi.fn(() => { retainedCandidates++; throw new Error('Offline domain quality rejection'); });
    client.run = async () => {
      if (++turn > 1) { client.terminal('rateLimitExceeded', source); return; }
      if (transport === 'dynamic') await client.tool();
      else client.notify('item/completed', { item: { id: 'answer', type: 'agentMessage', text: JSON.stringify({ resultJson: JSON.stringify({ value: 7 }) }) } });
      client.notify('turn/completed', { turn: { id: 'turn', status: 'completed' } });
    };
    const failure = await runWorkerAgentTool(clientOptions, 'fixture', [{ role: 'user', content: 'Offline' }],
      { ...resultTool, validate }).catch(error => error);
    expect(failure).toMatchObject({ code: 'WORKER_MODEL_ERROR', resultTool: 'submit',
      cause: { code: 'RATE_LIMITED', providerFailure: { source, codexErrorInfo: 'rateLimitExceeded' } } });
    expect(isCreationTransientFailure(failure)).toBe(false);
    expect(retainedCandidates).toBe(1);
    expect(validate).toHaveBeenCalledOnce();
    expect(client.request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(2);
  });
}

it.each([false, true])('does not downgrade retained failed completion during pending turn/start, prior tool=%s', async priorTool  => withCodexExecution(fixtureRoot, async () => {
  vi.useFakeTimers();
  const ordinaryRequest = client.request.getMockImplementation()!;
  const validate = vi.fn((value: { value: number }) => value);
  client.request.mockImplementation(async method => {
    if (method !== 'turn/start') return ordinaryRequest(method);
    if (priorTool) await client.tool();
    client.terminal(priorTool ? 'rateLimitExceeded' : 'usageLimitExceeded', 'turn/completed');
    await new Promise(resolve => setTimeout(resolve, 20));
    throw new Error('Synthetic cancelled start response');
  });
  const operation = priorTool
    ? runWorkerAgentTool(clientOptions, 'fixture', [{ role: 'user', content: 'Offline pending-start fixture' }], { ...resultTool, validate }, { timeoutMs: 10 })
    : runWorkerAgent(clientOptions, 'fixture', [{ role: 'user', content: 'Offline pending-start fixture' }], { timeoutMs: 10 });
  const pending = operation.catch(error => error);
  await vi.advanceTimersByTimeAsync(30);
  const failure = await pending;
  if (priorTool) expect(validate).toHaveBeenCalledOnce();
  expect(failure).toMatchObject({ code: 'WORKER_MODEL_ERROR', providerFailure: { source: 'turn/completed' } });
  expect(isCreationTransientFailure(failure)).toBe(false);
}, { settings: clientOptions._codex!.settings }));


it.each([false, true])('preserves a bound failed completion during pending turn/start, prior tool=%s', async priorTool  => withCodexExecution(fixtureRoot, async () => {
  vi.useFakeTimers();
  const ordinaryRequest = client.request.getMockImplementation()!;
  const validate = vi.fn((value: { value: number }) => value);
  client.request.mockImplementation(async method => {
    if (method !== 'turn/start') return ordinaryRequest(method);
    client.notify('turn/started', { turn: { id: 'turn', status: 'inProgress' } });
    if (priorTool) await client.tool();
    client.terminal(priorTool ? 'rateLimitExceeded' : 'usageLimitExceeded', 'turn/completed');
    await new Promise(resolve => setTimeout(resolve, 20));
    throw new Error('Synthetic cancelled start response');
  });
  const operation = priorTool
    ? runWorkerAgentTool(clientOptions, 'fixture', [{ role: 'user', content: 'Offline bound-start fixture' }], { ...resultTool, validate }, { timeoutMs: 10 })
    : runWorkerAgent(clientOptions, 'fixture', [{ role: 'user', content: 'Offline bound-start fixture' }], { timeoutMs: 10 });
  const pending = operation.catch(error => error);
  await vi.advanceTimersByTimeAsync(30);
  const failure = await pending;
  if (priorTool) expect(validate).toHaveBeenCalledOnce();
  expect(failure).toMatchObject({ code: 'WORKER_MODEL_ERROR', providerFailure: { source: 'turn/completed' } });
  expect(isCreationTransientFailure(failure)).toBe(false);
}, { settings: clientOptions._codex!.settings }));


for (const source of ['error', 'turn/completed'] as const) {
  it.each([false, true])('does not cancel the correct pending start for an unrelated ' + source + ' notification, already bound=%s', async bound  => withCodexExecution(fixtureRoot, async () => {
    vi.useFakeTimers();
    const ordinaryRequest = client.request.getMockImplementation()!;
    client.request.mockImplementation(async method => {
      if (method !== 'turn/start') return ordinaryRequest(method);
      if (bound) client.notify('turn/started', { turn: { id: 'turn', status: 'inProgress' } });
      const error = { message: 'Stale failure', codexErrorInfo: 'rateLimitExceeded' };
      if (source === 'error') client.notify(source, { turnId: 'different-turn', willRetry: false, error });
      else client.notify(source, { turn: { id: 'different-turn', status: 'failed', error } });
      client.notify('turn/completed', { threadId: 'different-thread', turn: { id: 'turn', status: 'failed', error } });
      await new Promise(resolve => setTimeout(resolve, 5));
      setTimeout(() => {
        client.notify('item/completed', { item: { id: 'answer', type: 'agentMessage', text: 'Correct turn completed' } });
        client.notify('turn/completed', { turn: { id: 'turn', status: 'completed' } });
      }, 1);
      return { turn: { id: 'turn' } };
    });
    const pending = runWorkerAgent(clientOptions, 'fixture', [{ role: 'user', content: 'Offline identity fixture' }], { timeoutMs: 30 });
    await vi.advanceTimersByTimeAsync(4);
    expect(client.request.mock.calls.filter(([method]) => method === 'turn/interrupt')).toHaveLength(0);
    expect(client.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10);
    await expect(pending).resolves.toMatchObject({ content: 'Correct turn completed' });
    expect(client.request.mock.calls.filter(([method]) => method === 'turn/interrupt')).toHaveLength(0);
  }, { settings: clientOptions._codex!.settings }));

  it('binds an early ' + source + ' notification only after the matching start response', async ()  => withCodexExecution(fixtureRoot, async () => {
    vi.useFakeTimers();
    const ordinaryRequest = client.request.getMockImplementation()!;
    client.request.mockImplementation(async method => {
      if (method !== 'turn/start') return ordinaryRequest(method);
      client.terminal('rateLimitExceeded', source);
      await new Promise(resolve => setTimeout(resolve, 5));
      return { turn: { id: 'turn' } };
    });
    const pending = runWorkerAgent(clientOptions, 'fixture', [{ role: 'user', content: 'Offline identity fixture' }], { timeoutMs: 30 }).catch(error => error);
    await vi.advanceTimersByTimeAsync(4);
    expect(client.request.mock.calls.filter(([method]) => method === 'turn/interrupt')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(10);
    expect(await pending).toMatchObject({ code: 'RATE_LIMITED', turnIdConfirmed: true, providerFailure: { source } });
  }, { settings: clientOptions._codex!.settings }));
}

it('keeps an unbound failed terminal explicitly uncertain when the start RPC never identifies the turn', async ()  => withCodexExecution(fixtureRoot, async () => {
  vi.useFakeTimers();
  const ordinaryRequest = client.request.getMockImplementation()!;
  client.request.mockImplementation(async method => {
    if (method !== 'turn/start') return ordinaryRequest(method);
    client.terminal('rateLimitExceeded', 'turn/completed');
    await new Promise(resolve => setTimeout(resolve, 20));
    throw new Error('Offline start cancellation');
  });
  const pending = runWorkerAgent(clientOptions, 'fixture', [{ role: 'user', content: 'Offline' }], { timeoutMs: 10 }).catch(error => error);
  await vi.advanceTimersByTimeAsync(30);
  expect(await pending).toMatchObject({ code: 'WORKER_MODEL_ERROR', turnIdConfirmed: false,
    providerFailure: { source: 'turn/completed', turnStatus: 'failed', codexErrorInfo: 'rateLimitExceeded' } });
  expect(client.request.mock.calls.filter(([method]) => method === 'turn/interrupt')).toHaveLength(0);
}, { settings: clientOptions._codex!.settings }));

it('preserves explicit caller cancellation during a pending start after a bound failed completion', async ()  => withCodexExecution(fixtureRoot, async () => {
  vi.useFakeTimers();
  const controller = new AbortController(), reason = Object.assign(new Error('User cancelled'), { code: 'USER_CANCELLED' });
  const ordinaryRequest = client.request.getMockImplementation()!;
  client.request.mockImplementation(async method => {
    if (method !== 'turn/start') return ordinaryRequest(method);
    client.notify('turn/started', { turn: { id: 'turn', status: 'inProgress' } });
    client.terminal('usageLimitExceeded', 'turn/completed');
    await new Promise(resolve => setTimeout(resolve, 20));
    throw new Error('Offline start cancellation');
  });
  const pending = runWorkerAgent(clientOptions, 'fixture', [{ role: 'user', content: 'Offline' }],
    { signal: controller.signal, timeoutMs: 100 }).catch(error => error);
  await vi.advanceTimersByTimeAsync(5);
  controller.abort(reason);
  await vi.advanceTimersByTimeAsync(30);
  expect(await pending).toBe(reason);
  expect(client.request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(1);
}, { settings: clientOptions._codex!.settings }));

it.each([false, true])('retains native cause and cleanup uncertainty after pending start failure, bound=%s', async bound  => withCodexExecution(fixtureRoot, async () => {
  vi.useFakeTimers();
  const ordinaryRequest = client.request.getMockImplementation()!;
  const cleanup = Object.assign(new Error('Offline close failed'), { code: 'ECONNRESET' });
  client.close.mockRejectedValue(cleanup);
  client.request.mockImplementation(async method => {
    if (method !== 'turn/start') return ordinaryRequest(method);
    if (bound) client.notify('turn/started', { turn: { id: 'turn', status: 'inProgress' } });
    client.terminal('usageLimitExceeded', 'turn/completed');
    await new Promise(resolve => setTimeout(resolve, 20));
    throw new Error('Offline start cancellation');
  });
  const pending = runWorkerAgent(clientOptions, 'fixture', [{ role: 'user', content: 'Offline' }], { timeoutMs: 10 }).catch(error => error);
  await vi.advanceTimersByTimeAsync(30);
  const failure = await pending;
  expect(failure).toBeInstanceOf(AggregateError);
  expect(failure.cause).toMatchObject({ code: 'WORKER_MODEL_ERROR', turnIdConfirmed: bound,
    providerFailure: { source: 'turn/completed', codexErrorInfo: 'usageLimitExceeded' } });
  expect(failure.errors).toContain(cleanup);
  expect(isCreationTransientFailure(failure)).toBe(false);
}, { settings: clientOptions._codex!.settings }));

it('blocks conflicting notification and start-response turn identities without claiming a retryable provider outcome', async () => {
  const ordinaryRequest = client.request.getMockImplementation()!;
  client.request.mockImplementation(async method => {
    if (method !== 'turn/start') return ordinaryRequest(method);
    client.notify('turn/started', { turn: { id: 'turn', status: 'inProgress' } });
    client.terminal('rateLimitExceeded', 'turn/completed');
    await new Promise(resolve => setImmediate(resolve));
    return { turn: { id: 'different-turn' } };
  });
  const failure = await run().catch(error => error);
  expect(failure).toMatchObject({ code: 'WORKER_MODEL_ERROR', cause: { code: 'RATE_LIMITED' } });
  expect(isCreationTransientFailure(failure)).toBe(false);
});


it('does not hide transcript persistence failure behind an earlier transient provider failure', async () => {
  const persistence = Object.assign(new Error('Offline transcript persistence failed'), { code: 'PERSISTENCE_FAILED' });
  const agent = new Agent({ projectRoot: fixtureRoot, settings: clientOptions._codex!.settings,
    initialState: { model: resolveCodexModel(), systemPrompt: '', messages: [], tools: [] } });
  agent.subscribe(event => { if (event.type === 'message_end' && event.message.role === 'assistant') throw persistence; });
  client.run = () => client.terminal('rateLimitExceeded', 'turn/completed');
  const failure = await agent.prompt('Offline persistence fixture').catch(error => error);
  expect(failure).toBeInstanceOf(AggregateError);
  expect(failure.cause).toBe(persistence);
  expect(failure.errors).toContainEqual(expect.objectContaining({ code: 'RATE_LIMITED' }));
  expect(isCreationTransientFailure(failure)).toBe(false);
});

it('does not downgrade a turn-identity conflict to a retryable deadline during close', async ()  => withCodexExecution(fixtureRoot, async () => {
  vi.useFakeTimers();
  const ordinaryRequest = client.request.getMockImplementation()!;
  client.request.mockImplementation(async method => {
    if (method !== 'turn/start') return ordinaryRequest(method);
    client.notify('turn/started', { turn: { id: 'turn', status: 'inProgress' } });
    client.terminal('rateLimitExceeded', 'turn/completed');
    await new Promise(resolve => setTimeout(resolve, 1));
    return { turn: { id: 'different-turn' } };
  });
  client.close.mockImplementation(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  const pending = runWorkerAgent(clientOptions, 'fixture', [{ role: 'user', content: 'Offline' }], { timeoutMs: 10 }).catch(error => error);
  await vi.advanceTimersByTimeAsync(30);
  const failure = await pending;
  expect(failure).toMatchObject({ code: 'WORKER_MODEL_ERROR', cause: { code: 'RATE_LIMITED' } });
  expect(isCreationTransientFailure(failure)).toBe(false);
}, { settings: clientOptions._codex!.settings }));


it('preserves an authoritative transient code rather than replacing it with a late start deadline', async ()  => withCodexExecution(fixtureRoot, async () => {
  vi.useFakeTimers();
  const ordinaryRequest = client.request.getMockImplementation()!;
  client.request.mockImplementation(async method => {
    if (method !== 'turn/start') return ordinaryRequest(method);
    client.notify('turn/started', { turn: { id: 'turn', status: 'inProgress' } });
    client.terminal('rateLimitExceeded', 'turn/completed');
    await new Promise(resolve => setTimeout(resolve, 20));
    throw new Error('Offline start cancellation');
  });
  const pending = runWorkerAgent(clientOptions, 'fixture', [{ role: 'user', content: 'Offline' }], { timeoutMs: 10 }).catch(error => error);
  await vi.advanceTimersByTimeAsync(30);
  expect(await pending).toMatchObject({ code: 'RATE_LIMITED', turnIdConfirmed: true,
    providerFailure: { source: 'turn/completed', codexErrorInfo: 'rateLimitExceeded' } });
}, { settings: clientOptions._codex!.settings }));

it.each(['dynamic', 'outputSchema'])('preserves earlier %s validation uncertainty through a later pending start deadline', async transport  => withCodexExecution(fixtureRoot, async () => {
  vi.useFakeTimers();
  let turn = 0, retainedCandidates = 0;
  const ordinaryRequest = client.request.getMockImplementation()!;
  const validate = vi.fn(() => { retainedCandidates++; throw new Error('Offline quality rejection after retention'); });
  client.request.mockImplementation(async method => {
    if (method !== 'turn/start') return ordinaryRequest(method);
    if (++turn === 1) {
      queueMicrotask(() => { void client.run(); });
      return { turn: { id: 'turn' } };
    }
    client.notify('turn/started', { turn: { id: 'turn', status: 'inProgress' } });
    client.terminal('rateLimitExceeded', 'turn/completed');
    await new Promise(resolve => setTimeout(resolve, 20));
    throw new Error('Offline start cancellation');
  });
  client.run = async () => {
    if (transport === 'dynamic') await client.tool();
    else client.notify('item/completed', { item: { id: 'answer', type: 'agentMessage', text: JSON.stringify({ resultJson: JSON.stringify({ value: 7 }) }) } });
    client.notify('turn/completed', { turn: { id: 'turn', status: 'completed' } });
  };
  const pending = runWorkerAgentTool(clientOptions, 'fixture', [{ role: 'user', content: 'Offline' }],
    { ...resultTool, validate }, { timeoutMs: 10 }).catch(error => error);
  await vi.advanceTimersByTimeAsync(30);
  const failure = await pending;
  expect(failure).toMatchObject({ code: 'WORKER_MODEL_ERROR', resultTool: 'submit',
    cause: { code: 'RATE_LIMITED', turnIdConfirmed: true, providerFailure: { source: 'turn/completed' } } });
  expect(isCreationTransientFailure(failure)).toBe(false);
  expect(retainedCandidates).toBe(1);
  expect(validate).toHaveBeenCalledOnce();
  expect(client.request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(2);
}, { settings: clientOptions._codex!.settings }));

it('serializes the authoritative response identity check behind queued turn notifications', async () => {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const agent = new Agent({ projectRoot: fixtureRoot, settings: clientOptions._codex!.settings,
    initialState: { model: resolveCodexModel(), systemPrompt: '', messages: [], tools: [] } });
  agent.subscribe(event => {
    if (event.type === 'message_start' && event.message.role === 'assistant') { entered(); return gate; }
  });
  const ordinaryRequest = client.request.getMockImplementation()!;
  client.request.mockImplementation(async method => {
    if (method !== 'turn/start') return ordinaryRequest(method);
    client.notify('item/agentMessage/delta', { itemId: 'answer', delta: 'Offline partial' });
    client.notify('turn/started', { turn: { id: 'different-turn', status: 'inProgress' } });
    client.notify('turn/completed', { turn: { id: 'different-turn', status: 'failed',
      error: { message: 'Offline rate limit', codexErrorInfo: 'rateLimitExceeded' } } });
    return { turn: { id: 'turn' } };
  });
  const pending = agent.prompt('Offline serialized identity fixture').then(() => agent.modelError).catch(error => error);
  await started;
  release();
  const failure = await pending;
  expect(failure).toMatchObject({ code: 'WORKER_MODEL_ERROR', cause: { code: 'RATE_LIMITED' } });
  expect(isCreationTransientFailure(failure)).toBe(false);
});


it.each([false, true])('retains failure provenance when the pending start RPC resolves after the deadline, bound=%s', async bound  => withCodexExecution(fixtureRoot, async () => {
  vi.useFakeTimers();
  const ordinaryRequest = client.request.getMockImplementation()!;
  client.request.mockImplementation(async method => {
    if (method !== 'turn/start') return ordinaryRequest(method);
    if (bound) client.notify('turn/started', { turn: { id: 'turn', status: 'inProgress' } });
    client.terminal('usageLimitExceeded', 'turn/completed');
    await new Promise(resolve => setTimeout(resolve, 20));
    return { turn: { id: 'turn' } };
  });
  const pending = runWorkerAgent(clientOptions, 'fixture', [{ role: 'user', content: 'Offline' }], { timeoutMs: 10 }).catch(error => error);
  await vi.advanceTimersByTimeAsync(30);
  const failure = await pending;
  expect(failure).toMatchObject({ code: 'WORKER_MODEL_ERROR', turnIdConfirmed: bound,
    providerFailure: { source: 'turn/completed', codexErrorInfo: 'usageLimitExceeded' } });
  expect(isCreationTransientFailure(failure)).toBe(false);
}, { settings: clientOptions._codex!.settings }));


it('preserves a queued host failure that cancels pending start before a later worker deadline', async ()  => withCodexExecution(fixtureRoot, async () => {
  vi.useFakeTimers();
  const persistence = Object.assign(new Error('Offline host subscriber failure'), { code: 'ECONNRESET' });
  const ordinaryRequest = client.request.getMockImplementation()!;
  client.request.mockImplementation(async method => {
    if (method !== 'turn/start') return ordinaryRequest(method);
    client.notify('turn/started', { turn: { id: 'turn', status: 'inProgress' } });
    client.terminal('rateLimitExceeded', 'turn/completed');
    client.notify('item/agentMessage/delta', { itemId: 'answer', delta: 'Offline partial' });
    await new Promise(resolve => setTimeout(resolve, 20));
    throw new Error('Offline start cancellation');
  });
  const pending = runWorkerAgent(clientOptions, 'fixture', [{ role: 'user', content: 'Offline' }],
    { timeoutMs: 10, onTextDelta: () => { throw persistence; } }).catch(error => error);
  await vi.advanceTimersByTimeAsync(30);
  const failure = await pending;
  expect(failure).toBeInstanceOf(AggregateError);
  expect(failure.cause).toBe(persistence);
  expect(failure.errors).toContainEqual(expect.objectContaining({ code: 'RATE_LIMITED' }));
  expect(isCreationTransientFailure(failure)).toBe(false);
}, { settings: clientOptions._codex!.settings }));

it('does not replace a distinct un-aborted start RPC failure with a retryable completed-turn error', async () => {
  const rpcFailure = new Error('Offline independent start RPC failure');
  const ordinaryRequest = client.request.getMockImplementation()!;
  client.request.mockImplementation(async method => {
    if (method !== 'turn/start') return ordinaryRequest(method);
    client.notify('turn/started', { turn: { id: 'turn', status: 'inProgress' } });
    client.terminal('rateLimitExceeded', 'turn/completed');
    await new Promise(resolve => setImmediate(resolve));
    throw rpcFailure;
  });
  const failure = await run().catch(error => error);
  expect(failure).toBeInstanceOf(AggregateError);
  expect(failure.cause).toBe(rpcFailure);
  expect(failure.errors).toContainEqual(expect.objectContaining({ code: 'RATE_LIMITED' }));
  expect(isCreationTransientFailure(failure)).toBe(false);
});

it('rejects a contradictory successful start response after a bound terminal error already aborted', async ()  => withCodexExecution(fixtureRoot, async () => {
  vi.useFakeTimers();
  const ordinaryRequest = client.request.getMockImplementation()!;
  client.request.mockImplementation(async method => {
    if (method !== 'turn/start') return ordinaryRequest(method);
    client.notify('turn/started', { turn: { id: 'turn' } });
    client.terminal('rateLimitExceeded', 'error');
    await new Promise(resolve => setTimeout(resolve, 20));
    return { turn: { id: 'contradictory-rpc-turn' } };
  });
  const pending = run().catch(error => error);
  await vi.advanceTimersByTimeAsync(30);
  const failure = await pending;
  expect(failure).toMatchObject({ code: 'WORKER_MODEL_ERROR' });
  expect(isCreationTransientFailure(failure)).toBe(false);
}, { settings: clientOptions._codex!.settings }));


it('checks a contradictory response already resolved before the queued terminal error is observed', async () => {
  const ordinaryRequest = client.request.getMockImplementation()!;
  client.request.mockImplementation(async method => {
    if (method !== 'turn/start') return ordinaryRequest(method);
    client.notify('turn/started', { turn: { id: 'turn' } });
    client.terminal('rateLimitExceeded', 'error');
    return { turn: { id: 'contradictory-rpc-turn' } };
  });
  const failure = await run().catch(error => error);
  expect(failure).toMatchObject({ code: 'WORKER_MODEL_ERROR', cause: { code: 'RATE_LIMITED' } });
  expect(isCreationTransientFailure(failure)).toBe(false);
  expect(client.request.mock.calls.filter(([method]) => method === 'turn/interrupt')).toHaveLength(1);
});

it('preserves explicit caller cancellation despite an already-aborted terminal error and conflicting response', async ()  => withCodexExecution(fixtureRoot, async () => {
  vi.useFakeTimers();
  const controller = new AbortController(), reason = Object.assign(new Error('User cancelled'), { code: 'USER_CANCELLED' });
  const ordinaryRequest = client.request.getMockImplementation()!;
  client.request.mockImplementation(async method => {
    if (method !== 'turn/start') return ordinaryRequest(method);
    client.notify('turn/started', { turn: { id: 'turn' } });
    client.terminal('rateLimitExceeded', 'error');
    await new Promise(resolve => setTimeout(resolve, 20));
    return { turn: { id: 'contradictory-rpc-turn' } };
  });
  const pending = runWorkerAgent(clientOptions, 'fixture', [{ role: 'user', content: 'Offline' }],
    { signal: controller.signal, timeoutMs: 100 }).catch(error => error);
  await vi.advanceTimersByTimeAsync(5);
  controller.abort(reason);
  await vi.advanceTimersByTimeAsync(30);
  expect(await pending).toBe(reason);
  expect(client.request.mock.calls.filter(([method]) => method === 'turn/interrupt')).toHaveLength(1);
}, { settings: clientOptions._codex!.settings }));

it('coalesces interrupts for one turn and resets cancellation ownership for the next invocation', async () => {
  const agent = new Agent({ projectRoot: fixtureRoot, settings: clientOptions._codex!.settings,
    initialState: { model: resolveCodexModel(), systemPrompt: '', messages: [], tools: [] } });
  client.run = () => client.terminal('usageLimitExceeded', 'error');
  for (let invocation = 1; invocation <= 2; invocation++) {
    await expect(agent.prompt('Offline interrupt fixture')).rejects.toMatchObject({ code: 'WORKER_MODEL_ERROR' });
    expect(client.request.mock.calls.filter(([method]) => method === 'turn/interrupt')).toHaveLength(invocation);
  }
});
