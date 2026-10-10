import { AsyncLocalStorage } from 'node:async_hooks';
import { CreativeHarnessRuntime } from '../../harness/runtime.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexFixture, type FixtureReply, type FixtureTurn } from '../../__tests__/codex-fixture.js';
import { runAgentSession, abortAgentSession } from '../../agent/agent-session.js';
import { Type } from '@sinclair/typebox';
import type { CodexClient } from '../../codex/app-server.js';
import { isCreationTransientFailure } from '../../creation/transient.js';
import { CodexAuthenticationOwner } from '../auth/codex-owner.js';
import { dispatchCodexHostEffect } from '../execution.js';
import { runWorkerAgentTool, runWorkerAgent } from '../../agent/worker-agent.js';
import { CreativeEpisodeStore } from '../../harness/episode-store.js';
import { readTranscriptEvents } from '../../interaction/session-transcript.js';
import { loadBookSession } from '../../interaction/book-session-store.js';
import { runWithAgentTrajectoryRole } from '../../llm/agent-trajectory.js';
import { projectRunHistory, RUN_HISTORY_EVENT_TYPE } from '../run-history.js';
import { readAgentSettings, updateAgentSettings } from '../settings.js';
import { currentCodexRun } from '../run-context.js';
import { catalog } from './fixtures.js';

const factory = vi.hoisted(() => vi.fn());
vi.mock('../../codex/client.js', () => ({ createCodexClient: factory }));
let root: string, account: string;
const sessions = new Set<string>();
const configuration = (sessionId: string) => {
  sessions.add(sessionId);
  return { projectRoot: root, sessionId, bookId: null, workId: null, profileId: 'workspace-default',
    sessionKind: 'chat' as const, language: 'en' as const, pipeline: {} as never };
};
const answered = (message = 'Answer saved'): FixtureReply => ({ text: JSON.stringify({ status: 'answered', message }) });
function install(reply: (turn: FixtureTurn) => FixtureReply | Promise<FixtureReply>, coldCallbacks = false) {
  const cold = AsyncLocalStorage.snapshot();
  const fixture = new CodexFixture(reply);
  factory.mockImplementation(async (projectRoot: string) => {
    const peer = await fixture.createClient(projectRoot), request = peer.request.bind(peer);
    peer.request = async (method, params, options) => method === 'account/read'
      ? { account: { type: 'chatgpt', email: `${account}@example.test`, planType: 'fixture' }, requiresOpenaiAuth: true } as never
      : request(method, params, options);
    if (coldCallbacks) {
      const onRequest = peer.onRequest.bind(peer), onNotification = peer.onNotification.bind(peer);
      peer.onRequest = listener => onRequest((method, params) => cold(() => listener(method, params)));
      peer.onNotification = listener => onNotification((method, params) => cold(() => listener(method, params)));
    }
    return peer;
  });
  return fixture;
}
function reopened(sessionId: string) {
  const store = new CreativeEpisodeStore(join(root, '.inkos', 'harness.sqlite'));
  const episodes = store.listEpisodes();
  const events = episodes.flatMap(episode => store.listEvents(episode.id));
  store.close();
  return readTranscriptEvents(root, sessionId).then(transcript => {
    const projected = projectRunHistory({ sessionId, transcript, episodes, events });
    const order = transcript.filter(e => e.type === 'request_started').map(e => e.requestId);
    projected.requests.sort((a, b) => order.indexOf(a.coreRequestId) - order.indexOf(b.coreRequestId));
    return { transcript, episodes, events, projected };
  });
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'inkos-production-runtime-')); account = 'first';
  factory.mockReset();
  vi.stubEnv('INKOS_CODEX_HOME', ''); delete process.env.INKOS_CODEX_HOME;
  vi.stubEnv('INKOS_CODEX_STATE_ROOT', ''); delete process.env.INKOS_CODEX_STATE_ROOT;
  await updateAgentSettings(root, { harnessPreferences: { codex: { model: null, effort: null, speed: null } } }, { expectedRevision: 0 });
});
afterEach(async () => {
  for (const session of sessions) abortAgentSession(root, session);
  sessions.clear(); vi.restoreAllMocks(); vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe('actual core queue / Agent / worker / durable runtime history', () => {
  it('blocks the actual Agent host action when its final permit waits across a sibling ACK failure', async () => {
    let entered!: () => void, release!: () => void, poison!: () => Promise<unknown>;
    const began = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    let armed = false, reads = 0, ackCount = 0, failureB: unknown;
    const append = CreativeEpisodeStore.prototype.append;
    vi.spyOn(CreativeEpisodeStore.prototype, 'append').mockImplementation(function (this: CreativeEpisodeStore, input) {
      if (input.type === RUN_HISTORY_EVENT_TYPE && input.payload.source === 'codex-turn-start-ack' && ++ackCount === 2) throw new Error('Sibling ACK poison before actual host action');
      return append.call(this, input);
    });
    const action = vi.spyOn(CreativeHarnessRuntime.prototype, 'executeAction');
    const fixture = install(turn => {
      if (!turn.thread.dynamicTools?.length) return { text: 'Worker response' };
      armed = true; return { calls: [{ name: 'workspace__list_work_profiles', args: {} }] };
    });
    const create = factory.getMockImplementation()!;
    factory.mockImplementationOnce(async (projectRoot: string) => {
      const peer: CodexClient = await create(projectRoot), request = peer.request.bind(peer);
      peer.request = async (method, params, options) => {
        if (method === 'account/read' && armed && ++reads === 2) {
          const resume = AsyncLocalStorage.snapshot();
          poison = () => resume(() => runWorkerAgent({ _codex: { projectRoot: root } } as never, 'ignored', [{ role: 'user', content: 'Sibling B' }]));
          entered(); await gate;
        }
        return request(method, params, options);
      };
      return peer;
    });
    const running = runAgentSession(configuration('actual-host-race'), 'List profiles').catch(error => error);
    try { await began; try { await poison(); } catch (error) { failureB = error; } }
    finally { release(); }
    expect(await running).toBe(failureB);
    expect(failureB).toMatchObject({ code: 'RUNTIME_HISTORY_WRITE_FAILED' });
    expect(action).not.toHaveBeenCalled();
    expect(fixture.requests.filter(r => r.method === 'turn/start')).toHaveLength(2);
    expect(fixture.toolResponses).toHaveLength(0);
  });

  it.each(['legacy-fast', 'canonical-priority'] as const)('records saved Fast, actual canonical turn wire and raw thread ACK for a %s catalog', async advertised => {
    const capabilities = catalog('codex'); capabilities.models[0]!.serviceTiers.push('fast');
    await updateAgentSettings(root, { harnessPreferences: { codex: { model: 'gpt-6.1-sol', effort: 'ultra', speed: 'fast' } } },
      { expectedRevision: 1, catalogs: { codex: capabilities } });
    const fixture = install(() => answered('Fast request accepted'));
    const create = factory.getMockImplementation()!;
    factory.mockImplementation(async (projectRoot: string) => {
      const peer: CodexClient = await create(projectRoot), request = peer.request.bind(peer);
      peer.request = async (method, params, options) => {
        const result: any = await request(method, params, options);
        if (method === 'model/list') return { ...result, data: result.data.map((model: any) => ({ ...model,
          serviceTiers: advertised === 'canonical-priority' ? [{ id: 'priority' }] : [],
          additionalSpeedTiers: advertised === 'legacy-fast' ? ['fast'] : [],
        })) };
        return (method === 'thread/start' ? { ...result, serviceTier: 'priority' } : result) as never;
      };
      return peer;
    });
    await expect(runAgentSession(configuration(advertised), 'Answer with Fast')).resolves.toMatchObject({ responseText: 'Fast request accepted' });
    expect((await readAgentSettings(root)).harnessPreferences.codex.speed).toBe('fast');
    expect(fixture.requests.find(r => r.method === 'thread/start')?.params.serviceTier).toBe('fast');
    expect(fixture.requests.find(r => r.method === 'turn/start')?.params.serviceTierForTurn).toBe('priority');
    const request = (await reopened(advertised)).projected.requests[0]!;
    expect(request.selection?.saved.speed).toBe('fast');
    expect(request.selection?.selection.serviceTier).toBe('fast');
    expect(request.dispatches.find(d => d.operation === 'codex-thread-start')?.wire.serviceTier).toBe('fast');
    expect(request.dispatches.find(d => d.operation === 'codex-turn-start')?.wire.serviceTierForTurn).toBe('priority');
    expect(request.observations.find(o => o.scope === 'thread')?.effective.serviceTier).toBe('priority');
    expect(request.observations.find(o => o.scope === 'turn')?.fields.serviceTier).toEqual({ state: 'unknown' });
  });


  it.each(['thread', 'turn', 'lease', 'host', 'active'] as const)('blocks a %s permit held across a sibling worker ACK persistence failure', async boundary => {
    let failureA: unknown, failureB: unknown, startsBefore = 0, startsAfter = 0, effects = 0, leasedClosed: boolean | undefined;
    let mainPeer: CodexClient, target: CodexClient | undefined;
    const append = CreativeEpisodeStore.prototype.append, execute = CreativeHarnessRuntime.prototype.executeAction;
    let ackCount = 0;
    vi.spyOn(CreativeEpisodeStore.prototype, 'append').mockImplementation(function (this: CreativeEpisodeStore, input) {
      if (input.type === RUN_HISTORY_EVENT_TYPE && input.payload.source === 'codex-turn-start-ack' && ++ackCount === 2) {
        throw new Error('Sibling B ACK persistence failed');
      }
      return append.call(this, input);
    });
    let step = 0;
    const fixture = install(turn => !turn.thread.dynamicTools?.length ? { text: 'Worker response' }
      : ++step === 1 ? { calls: [{ name: 'workspace__list_work_profiles', args: {} }] } : answered());
    const create = factory.getMockImplementation()!;
    factory.mockImplementation(async (projectRoot: string) => { const peer: CodexClient = await create(projectRoot); mainPeer ??= peer; return peer; });
    vi.spyOn(CreativeHarnessRuntime.prototype, 'executeAction').mockImplementation(async function (this: CreativeHarnessRuntime, input) {
      if (input.actionId !== 'list_work_profiles') return execute.call(this, input);
      const result = await execute.call(this, input);
      let entered!: () => void, release!: () => void;
      const began = new Promise<void>(resolve => { entered = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      const hold = (peer: CodexClient, readNumber: number) => {
        const request = peer.request.bind(peer); let reads = 0;
        peer.request = async (method, params, options) => {
          if (method === 'account/read' && ++reads === readNumber) { entered(); await gate; }
          return request(method, params, options);
        };
      };
      if (boundary === 'host' || boundary === 'active') hold(mainPeer, 1);
      else {
        factory.mockImplementationOnce(async (projectRoot: string) => {
          target = await create(projectRoot);
          hold(target!, boundary === 'thread' ? 3 : boundary === 'turn' ? 5 : 1);
          return target;
        });
      }
      const pending = boundary === 'lease' ? currentCodexRun()!.takeClient()
        : boundary === 'host' ? dispatchCodexHostEffect(mainPeer, async () => ++effects)
        : boundary === 'active' ? currentCodexRun()!.guard().then(() => ++effects)
        : runWorkerAgent({ _codex: { projectRoot: root } } as never, 'ignored', [{ role: 'user', content: 'Held worker A' }]);
      const a = pending.catch(error => { failureA = error; });
      try {
        await began;
        try { await runWorkerAgent({ _codex: { projectRoot: root } } as never, 'ignored', [{ role: 'user', content: 'Poisoning worker B' }]); }
        catch (error) { failureB = error; }
        startsBefore = fixture.requests.filter(r => r.method === 'thread/start' || r.method === 'turn/start').length;
      } finally { release(); }
      await a;
      startsAfter = fixture.requests.filter(r => r.method === 'thread/start' || r.method === 'turn/start').length;
      leasedClosed = target?.closed;
      return result; // Domain wrappers cannot turn the poison into a new permit.
    });
    await expect(runAgentSession(configuration(`held-${boundary}`), 'List profiles')).rejects.toMatchObject({ code: 'RUNTIME_HISTORY_WRITE_FAILED' });
    expect(failureB).toMatchObject({ code: 'RUNTIME_HISTORY_WRITE_FAILED', cause: { message: 'Sibling B ACK persistence failed' } });
    expect(failureA).toBe(failureB);
    expect(isCreationTransientFailure(failureA)).toBe(false);
    expect(startsAfter).toBe(startsBefore);
    expect(effects).toBe(0);
    if (boundary === 'lease') expect(leasedClosed).toBe(true);
  });

  it.each([['text', 'history', 'deadline'], ['structured', 'history', 'deadline'], ['text', 'auth', 'deadline'], ['structured', 'auth', 'deadline'], ['text', 'history', 'cancel'], ['structured', 'history', 'cancel']] as const)('preserves %s worker %s error priority with late %s during peer close', async (kind, fault, abort) => {
    const append = CreativeEpisodeStore.prototype.append, execute = CreativeHarnessRuntime.prototype.executeAction;
    let ackCount = 0, failure: unknown, interrupted = false;
    vi.spyOn(CreativeEpisodeStore.prototype, 'append').mockImplementation(function (this: CreativeEpisodeStore, input) {
      if (fault === 'history' && input.type === RUN_HISTORY_EVENT_TYPE && input.payload.source === 'codex-turn-start-ack' && ++ackCount === 2) throw new Error('Worker ACK failed before deadline');
      return append.call(this, input);
    });
    let step = 0;
    const fixture = install(turn => !turn.thread.dynamicTools?.some((t: { name: string }) => t.name === 'workspace__list_work_profiles') ? { text: 'Worker output' }
      : ++step === 1 ? { calls: [{ name: 'workspace__list_work_profiles', args: {} }] } : answered());
    const create = factory.getMockImplementation()!;
    vi.spyOn(CreativeHarnessRuntime.prototype, 'executeAction').mockImplementation(async function (this: CreativeHarnessRuntime, input) {
      if (input.actionId !== 'list_work_profiles') return execute.call(this, input);
      const result = await execute.call(this, input);
      let entered!: () => void, release!: () => void;
      const began = new Promise<void>(resolve => { entered = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      factory.mockImplementationOnce(async (projectRoot: string) => {
        const peer: CodexClient = await create(projectRoot), close = peer.close.bind(peer), request = peer.request.bind(peer);
        peer.request = async (method, params, options) => {
          const result = await request(method, params, options);
          if (fault === 'auth' && method === 'thread/start') new CodexAuthenticationOwner(peer).disconnect();
          return result as never;
        };
        peer.close = async () => { entered(); await gate; await close(); };
        return peer;
      });
      // Start the clock only after admission; hold cleanup until the actual budget fires.
      vi.useFakeTimers();
      const client = { _codex: { projectRoot: root } } as never;
      const messages = [{ role: 'user' as const, content: 'Worker request' }];
      const caller = new AbortController();
      const options = { timeoutMs: 1000, signal: caller.signal };
      const pending = kind === 'text' ? runWorkerAgent(client, 'ignored', messages, options)
        : runWorkerAgentTool(client, 'ignored', messages, { name: 'result', label: 'Result', description: 'Result', parameters: Type.Object({ value: Type.String() }) }, options);
      const settled = pending.catch(error => { failure = error; });
      try {
        await began;
        if (abort === 'cancel') caller.abort(Object.assign(new Error('Explicit caller cancellation'), { code: 'USER_CANCELLED' }));
        else await vi.advanceTimersByTimeAsync(1000);
        interrupted = true;
      }
      finally { vi.useRealTimers(); release(); }
      await settled;
      return result;
    });
    await expect(runAgentSession(configuration(`deadline-${kind}-${fault}-${abort}`), 'List profiles')).rejects.toMatchObject({ code: fault === 'history' ? 'RUNTIME_HISTORY_WRITE_FAILED' : 'RUNTIME_AUTH_REVOKED' });
    expect(interrupted).toBe(true);
    expect(failure).toMatchObject({ code: abort === 'cancel' ? 'USER_CANCELLED' : fault === 'history' ? 'RUNTIME_HISTORY_WRITE_FAILED' : 'RUNTIME_AUTH_REVOKED' });
    if (fault === 'history' && abort === 'deadline') expect(failure).toMatchObject({ cause: { message: 'Worker ACK failed before deadline' } });
    expect(isCreationTransientFailure(failure)).toBe(false);
    expect(fixture.requests.filter(r => r.method === 'turn/start')).toHaveLength(fault === 'history' ? 2 : 1);
  });

  it('freezes the queued request and nested worker; the next queued request rereads saved preferences', async () => {
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    let first = true;
    const fixture = install(async turn => {
      if (!turn.thread.dynamicTools?.length) return { text: 'Worker answer' };
      if (first) {
        first = false; entered(); await gate;
        const before = currentCodexRun()!;
        const worker = await runWithAgentTrajectoryRole('subagent', () => runWorkerAgent({ _codex: { projectRoot: root } } as never,
          'ignored', [{ role: 'user', content: 'Nested worker' }]), 'host-parent-call');
        expect(worker.content).toBe('Worker answer');
        expect(currentCodexRun()?.selection).toBe(before.selection);
      }
      return answered();
    });
    const config = configuration('queued');
    const running = runAgentSession(config, 'First request');
    await started;
    const queued = runAgentSession(config, 'Second request');
    const saved = await readAgentSettings(root);
    await updateAgentSettings(root, { harnessPreferences: { codex: { model: 'gpt-6.1-sol', effort: 'ultra', speed: 'priority' } } }, { expectedRevision: saved.revision, catalogs: { codex: catalog('codex') } });
    release();
    await expect(running).resolves.toMatchObject({ responseText: 'Answer saved' });
    await expect(queued).resolves.toMatchObject({ responseText: 'Answer saved' });
    const starts = fixture.requests.filter(r => r.method === 'turn/start');
    expect(starts.map(r => r.params.model)).toEqual(['fixture', 'fixture', 'gpt-6.1-sol']);
    expect(starts[0]!.params).not.toHaveProperty('serviceTierForTurn');
    expect(starts[1]!.params).not.toHaveProperty('serviceTierForTurn');
    expect(starts[2]!.params).toMatchObject({ effort: 'ultra', serviceTierForTurn: 'priority' });
    const evidence = await reopened('queued');
    const requests = evidence.projected.requests;
    expect(requests).toHaveLength(2);
    expect(requests.map(r => r.selection?.saved.model)).toEqual([null, 'gpt-6.1-sol']);
    const firstRequest = requests[0]!;
    expect(firstRequest.dispatches.filter(d => d.operation === 'codex-turn-start').map(d => d.agentRole)).toEqual(['main', 'subagent']);
    expect(firstRequest.dispatches.find(d => d.agentRole === 'subagent')).toMatchObject({ parentToolCallId: 'host-parent-call' });
    expect(requests.every(r => r.observations.every(o => o.linked))).toBe(true);
    expect(requests.flatMap(r => r.observations).filter(o => o.scope === 'turn').every(o => o.fields.modelId.state === 'unknown')).toBe(true);
    expect(JSON.stringify(evidence.projected)).not.toMatch(/authContextRef|connectionRef|first@example/);
    expect((await loadBookSession(root, 'queued'))?.messages).toHaveLength(4);
  });

  it('continues with a null thread tier ACK and records that fact without filling requested priority', async () => {
    const saved = await readAgentSettings(root);
    await updateAgentSettings(root, { harnessPreferences: { codex: { model: 'gpt-6.1-sol', effort: 'ultra', speed: 'priority' } } },
      { expectedRevision: saved.revision, catalogs: { codex: catalog('codex') } });
    install(() => answered('Unknown effective tier retained'));
    const create = factory.getMockImplementation()!;
    factory.mockImplementation(async (projectRoot: string) => {
      const peer: Awaited<ReturnType<CodexFixture['createClient']>> = await create(projectRoot);
      const request = peer.request.bind(peer);
      peer.request = async (method, params, options) => {
        const result = await request(method, params, options);
        return (method === 'thread/start' ? { ...result as object, reasoningEffort: null, serviceTier: null } : result) as never;
      };
      return peer;
    });
    await expect(runAgentSession(configuration('unknown-tier'), 'Answer the request')).resolves.toMatchObject({ responseText: 'Unknown effective tier retained' });
    const request = (await reopened('unknown-tier')).projected.requests[0]!;
    expect(request.selection?.selection.serviceTier).toBe('priority');
    expect(request.observations.find(o => o.scope === 'thread')).toMatchObject({ effective: { effort: null, serviceTier: null },
      fields: { serviceTier: { state: 'observed', value: null } } });
    expect(request.observations.find(o => o.scope === 'turn')?.fields.serviceTier).toEqual({ state: 'unknown' });
  });

  it('restores request, model-call and history scopes for a host worker dispatched by a cold transport callback', async () => {
    const execute = CreativeHarnessRuntime.prototype.executeAction;
    let workerRan = false;
    vi.spyOn(CreativeHarnessRuntime.prototype, 'executeAction').mockImplementation(async function (this: CreativeHarnessRuntime, input) {
      const result = await execute.call(this, input);
      if (input.actionId === 'list_work_profiles') {
        const worker = await runWorkerAgent({ _codex: { projectRoot: root } } as never,
          'ignored', [{ role: 'user', content: 'Worker inside the actual host action dispatch' }]);
        expect(worker.content).toBe('Nested host result'); workerRan = true;
      }
      return result;
    });
    let mainStep = 0;
    const fixture = install(turn => {
      if (!turn.thread.dynamicTools?.length) return { text: 'Nested host result' };
      if (++mainStep === 1) return { calls: [{ name: 'workspace__list_work_profiles', args: {} }] };
      return answered('Profiles inspected');
    }, true);
    await expect(runAgentSession(configuration('cold-transport'), 'List work profiles')).resolves.toMatchObject({ responseText: 'Profiles inspected' });
    expect(workerRan).toBe(true);
    expect(fixture.toolResponses).toHaveLength(1);
    const { projected } = await reopened('cold-transport');
    const request = projected.requests[0]!;
    const worker = request.dispatches.find(d => d.operation === 'codex-turn-start' && d.agentRole === 'subagent');
    expect(worker).toMatchObject({ coreRequestId: request.coreRequestId, parentToolCallId: fixture.toolResponses[0]!.id });
    expect(request.observations).toHaveLength(4);
    expect(request.observations.every(o => o.linked)).toBe(true);
  });

  it('shares the same frozen selection across correction and actual Work transition', async () => {
    let step = 0;
    const fixture = install(async () => {
      if (++step === 1) {
        const saved = await readAgentSettings(root);
        await updateAgentSettings(root, { harnessPreferences: { codex: { model: 'gpt-6.1-sol', effort: 'ultra', speed: 'priority' } } }, { expectedRevision: saved.revision, catalogs: { codex: catalog('codex') } });
        return { calls: [{ name: 'workspace__create_work', args: { workId: 'frozen-work', profileId: 'script', title: 'Frozen Work', language: 'en', intent: 'Create one empty script Work' } }] };
      }
      if (step === 2) return { text: 'Invalid completion' };
      return answered('Creation acknowledged');
    });
    await expect(runAgentSession(configuration('transition'), 'Create an empty script Work')).resolves.toMatchObject({ responseText: 'Creation acknowledged' });
    expect(fixture.requests.filter(r => r.method === 'turn/start').map(r => r.params.model)).toEqual(['fixture', 'fixture', 'fixture']);
    const { projected } = await reopened('transition');
    expect(projected.requests).toHaveLength(2);
    const selected = projected.requests.map(r => r.selection?.selection);
    expect(selected[0]).toEqual(selected[1]);
    expect(projected.requests.every(r => r.selection?.saved.model === null)).toBe(true);
    expect(projected.requests[1]!.dispatches.filter(d => d.operation === 'codex-turn-start')).toHaveLength(2);
  });

  it('rejects an account change before a new host tool permit; later admission uses a fresh generation', async () => {
    let change = true;
    const fixture = install(() => {
      if (change) { change = false; account = 'second'; return { calls: [{ name: 'workspace__create_work', args: {
        workId: 'must-not-exist', profileId: 'script', title: 'Forbidden', language: 'en', intent: 'Create' } }] }; }
      return answered('Fresh account');
    });
    await expect(runAgentSession(configuration('revoked'), 'Create')).rejects.toMatchObject({ code: 'RUNTIME_AUTH_REVOKED' });
    expect(fixture.toolResponses).toHaveLength(0);
    const old = await reopened('revoked');
    const generation = old.projected.requests[0]!.selection!.selection.authGeneration;
    await runAgentSession(configuration('revoked'), 'Fresh request');
    const next = await reopened('revoked');
    expect(next.projected.requests[1]!.selection!.selection.authGeneration).toBeGreaterThan(generation);
    expect(next.projected.requests[0]!.transcriptStatus).toBe('failed');
    expect(next.projected.requests[1]!.transcriptStatus).toBe('committed');
  });

  it('never repeats an acknowledged turn when its durable history write fails', async () => {
    const fixture = install(() => answered());
    const append = CreativeEpisodeStore.prototype.append;
    vi.spyOn(CreativeEpisodeStore.prototype, 'append').mockImplementation(function (this: CreativeEpisodeStore, input) {
      if (input.type === RUN_HISTORY_EVENT_TYPE && input.payload.source === 'codex-turn-start-ack') throw new Error('Synthetic SQLite append failure');
      return append.call(this, input);
    });
    await expect(runAgentSession(configuration('history-failed'), 'Answer')).rejects.toMatchObject({ code: 'RUNTIME_HISTORY_WRITE_FAILED' });
    expect(fixture.requests.filter(r => r.method === 'turn/start')).toHaveLength(1);
    const { projected } = await reopened('history-failed');
    expect(projected.requests[0]!.transcriptStatus).toBe('failed');
    expect(projected.requests[0]!.dispatches.filter(d => d.operation === 'codex-turn-start')).toHaveLength(1);
    expect(projected.requests[0]!.observations.filter(o => o.scope === 'turn')).toHaveLength(0);
  });

  it('ends the parent request after a worker ACK append failure even when a domain wrapper catches it', async () => {
    const append = CreativeEpisodeStore.prototype.append, execute = CreativeHarnessRuntime.prototype.executeAction;
    let ackCount = 0, wrapped = false;
    vi.spyOn(CreativeEpisodeStore.prototype, 'append').mockImplementation(function (this: CreativeEpisodeStore, input) {
      if (input.type === RUN_HISTORY_EVENT_TYPE && input.payload.source === 'codex-turn-start-ack' && ++ackCount === 2) {
        throw new Error('Synthetic worker ACK append failure');
      }
      return append.call(this, input);
    });
    vi.spyOn(CreativeHarnessRuntime.prototype, 'executeAction').mockImplementation(async function (this: CreativeHarnessRuntime, input) {
      if (input.actionId === 'list_work_profiles') {
        try { await runWorkerAgent({ _codex: { projectRoot: root } } as never, 'ignored', [{ role: 'user', content: 'Host worker' }]); }
        catch { wrapped = true; }
      }
      return execute.call(this, input);
    });
    const fixture = install(turn => !turn.thread.dynamicTools?.length ? { text: 'Worker result' }
      : { calls: [{ name: 'workspace__list_work_profiles', args: {} }] }, true);
    await expect(runAgentSession(configuration('wrapped-history'), 'List profiles')).rejects.toMatchObject({ code: 'RUNTIME_HISTORY_WRITE_FAILED' });
    expect(wrapped).toBe(true);
    expect(fixture.requests.filter(r => r.method === 'turn/start')).toHaveLength(2);
    expect(fixture.toolResponses).toHaveLength(0);
    const { projected } = await reopened('wrapped-history');
    expect(projected.requests[0]!.transcriptStatus).toBe('failed');
    expect(projected.requests[0]!.dispatches.filter(d => d.operation === 'codex-turn-start')).toHaveLength(2);
  });

  it.each(['cancel', 'deadline'] as const)('retains scoped old receipts after %s and a fresh request', async mode => {
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    let hold = true;
    const fixture = install(() => { if (hold) { entered(); return { hold: true }; } return answered('New request'); });
    const controller = new AbortController();
    if (mode === 'deadline') vi.stubEnv('INKOS_AGENT_TIMEOUT_MS', '80');
    const running = runAgentSession({ ...configuration('stopped'), signal: controller.signal }, 'Old request');
    await started;
    if (mode === 'cancel') controller.abort(new DOMException('Synthetic stop', 'AbortError'));
    await expect(running).rejects.toMatchObject(mode === 'cancel' ? { name: 'AbortError' } : { code: 'AGENT_REQUEST_TIMEOUT' });
    expect(fixture.requests.filter(r => r.method === 'turn/interrupt')).toHaveLength(1);
    hold = false; vi.unstubAllEnvs();
    await runAgentSession(configuration('stopped'), 'New request');
    const { projected } = await reopened('stopped');
    expect(projected.requests.map(r => r.transcriptStatus)).toEqual(['failed', 'committed']);
    expect(projected.requests.every(r => r.observations.every(o => o.coreRequestId === r.coreRequestId && o.linked))).toBe(true);
    expect(new Set(projected.requests.flatMap(r => r.dispatches.map(d => d.modelCallId))).size).toBe(2);
  });

  it('keeps a desired unassembled Pi configuration and fails before any Codex RPC', async () => {
    install(() => answered());
    const saved = await readAgentSettings(root);
    await updateAgentSettings(root, { selectedHarnessId: 'pi' }, { expectedRevision: saved.revision, catalogs: { codex: catalog('codex') } });
    await expect(runAgentSession(configuration('pi'), 'Answer')).rejects.toMatchObject({ code: 'RUNTIME_HARNESS_NOT_CONNECTED' });
    expect(factory).not.toHaveBeenCalled();
    expect((await readAgentSettings(root)).selectedHarnessId).toBe('pi');
  });
});
