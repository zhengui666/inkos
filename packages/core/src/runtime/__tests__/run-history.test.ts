import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CreativeEpisodeStore } from '../../harness/episode-store.js';
import { recordExecutionEvidence } from '../../harness/execution-evidence.js';
import { HARNESS_VERSION, type CreativeEpisodeEvent } from '../../harness/contracts.js';
import { appendTranscriptEvent, readTranscriptEvents, transcriptPath } from '../../interaction/session-transcript.js';
import { committedMessageEvents, deriveBookSessionFromTranscript } from '../../interaction/session-transcript-restore.js';
import { TranscriptEventSchema, type TranscriptEvent } from '../../interaction/session-transcript-schema.js';
import { resolveRuntimeSelection } from '../selection.js';
import type { AgentSettings } from '../contracts.js';
import { admission, authContext, descriptor } from './fixtures.js';
import {
  appendRunSelection, appendRunDispatch, appendRunObservation, projectRunHistory,
  RunSelectionSchema, RunDispatchSchema, RunObservationSchema, RUN_HISTORY_EVENT_TYPE,
  type RunHistoryBinding, type RunSelection, type RunDispatch, type RunObservation,
} from '../run-history.js';

const identity = { schemaVersion: 1 as const, sessionId: 's1', coreRequestId: 'r1' };
function selection(id = 'r1'): RunSelection {
  const settings: AgentSettings = { schemaVersion: 1, revision: 42, selectedHarnessId: 'codex',
    modelConnectionRef: 'opaque-test-connection', harnessPreferences: {
      codex: { model: null, effort: null, speed: null }, pi: { model: null, effort: null, speed: null },
    } };
  return { ...identity, coreRequestId: id, kind: 'selection',
    saved: { ...settings.harnessPreferences.codex, harnessId: 'codex', revision: settings.revision },
    selection: resolveRuntimeSelection({ settings, harness: descriptor('codex'), authContext: authContext(), connection: admission() }),
  };
}
function dispatch(id = 'r1'): RunDispatch {
  return { ...identity, coreRequestId: id, kind: 'dispatch', modelCallId: 'call-1', agentRole: 'main',
    operation: 'codex-turn-start', threadId: 'thread-1', wire: { model: 'override-model', effort: null, serviceTierForTurn: 'Standard' } };
}
function observation(id = 'r1'): RunObservation {
  return { ...identity, coreRequestId: id, kind: 'observation', modelCallId: 'call-1',
    source: 'codex-turn-start-ack', scope: 'turn', threadId: 'thread-1', turnId: 'turn-1', effective: {} };
}
function event(payload: unknown, seq = 0, episodeId = 'episode-r1'): CreativeEpisodeEvent {
  return { version: HARNESS_VERSION, episodeId, seq, timestamp: '2026-10-10T00:00:00.000Z',
    type: RUN_HISTORY_EVENT_TYPE, workId: null, payload: payload as Record<string, unknown> };
}
function transcript(id = 'r1', status: 'committed' | 'failed' | 'interrupted' = 'committed'): TranscriptEvent[] {
  const base = { version: 1 as const, sessionId: 's1', requestId: id, timestamp: 1 };
  return [
    { ...base, seq: 1, type: 'request_started', input: 'private prompt' },
    { ...base, seq: 2, type: 'message', uuid: `message-${id}`, parentUuid: null, role: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'visible' }], model: 'message-end-model', timestamp: 1 } },
    ...(status === 'committed' ? [{ ...base, seq: 3, type: 'request_committed' as const }]
      : status === 'failed' ? [{ ...base, seq: 3, type: 'request_failed' as const, error: 'private raw error' }] : []),
  ];
}
function project(events: unknown[], extra: Partial<Parameters<typeof projectRunHistory>[0]> = {}) {
  return projectRunHistory({ sessionId: 's1', transcript: transcript(), episodes: [], events, ...extra });
}

describe('strict runtime history payloads', () => {
  it('captures the frozen selection and exact saved nulls at the same harness/revision', () => {
    const value = selection();
    expect(Object.isFrozen(value.selection)).toBe(true);
    expect(RunSelectionSchema.parse(value)).toEqual(value);
    expect(value.saved).toEqual({ model: null, effort: null, speed: null, harnessId: 'codex', revision: 42 });
    for (const saved of [{ ...value.saved, revision: 43 }, { ...value.saved, harnessId: 'pi' }]) {
      expect(() => RunSelectionSchema.parse({ ...value, saved })).toThrow();
    }
  });

  it('keeps omission, null, native IDs and Standard distinct without tier mapping', () => {
    for (const wire of [{}, { effort: null }, { effort: 'low', serviceTier: null, serviceTierForTurn: 'Standard' },
      { model: 'native-model', serviceTier: 'default', serviceTierForTurn: 'Priority' }]) {
      const parsed = RunDispatchSchema.parse({ ...dispatch(), wire });
      expect(parsed.wire).toEqual(wire);
      expect(JSON.parse(JSON.stringify(parsed)).wire).toEqual(wire);
    }
    expect(() => RunDispatchSchema.parse({ ...dispatch(), wire: { effort: undefined } })).toThrow();
    expect(() => RunDispatchSchema.parse({ ...dispatch(), parentToolCallId: undefined })).toThrow();
    expect(() => RunObservationSchema.parse({ ...observation(), effective: { modelId: undefined } })).toThrow();
  });

  it.each(['token', 'email', 'accountId', 'path', 'env', 'headers', 'prompt', 'parameters', 'rawError', 'transportRequestId', 'runId'])(
    'rejects the non-whitelisted field %s at every payload boundary', field => {
      for (const [schema, value] of [[RunSelectionSchema, selection()], [RunDispatchSchema, dispatch()], [RunObservationSchema, observation()]] as const) {
        expect(schema.safeParse({ ...value, [field]: 'synthetic-private' }).success).toBe(false);
      }
      const value = selection();
      expect(RunSelectionSchema.safeParse({ ...value, saved: { ...value.saved, [field]: 'synthetic-private' } }).success).toBe(false);
      expect(RunSelectionSchema.safeParse({ ...value, selection: { ...value.selection, [field]: 'synthetic-private' } }).success).toBe(false);
      expect(RunDispatchSchema.safeParse({ ...dispatch(), wire: { [field]: 'synthetic-private' } }).success).toBe(false);
      expect(RunObservationSchema.safeParse({ ...observation(), effective: { [field]: 'synthetic-private' } }).success).toBe(false);
    },
  );

  it('requires actual scoped identities and rejects message_end/request provenance', () => {
    for (const patch of [{ source: 'message_end' }, { source: 'request' }, { scope: 'thread' }, { turnId: undefined }, { threadId: undefined },
      { piSessionId: 'pi-1', entryId: 'entry-1' }]) {
      expect(RunObservationSchema.safeParse({ ...observation(), ...patch }).success).toBe(false);
    }
    expect(RunObservationSchema.safeParse({ ...identity, kind: 'observation', modelCallId: 'pi-call',
      source: 'pi-session-entry', scope: 'entry', piSessionId: 'pi-1', effective: {} }).success).toBe(false);
  });
});

describe('explicit SQLite run history receipts', () => {
  let root: string;
  let store: CreativeEpisodeStore;
  let binding: RunHistoryBinding;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'inkos-run-history-'));
    store = new CreativeEpisodeStore(join(root, '.inkos', 'harness.sqlite'));
    store.create({ version: HARNESS_VERSION, id: 'episode-r1', workId: null, profileId: null, status: 'running',
      startedAt: '2026-10-10T00:00:00.000Z', completedAt: null });
    binding = { store, episodeId: 'episode-r1', sessionId: 's1', coreRequestId: 'r1' };
  });
  afterEach(async () => { store.close(); await rm(root, { recursive: true, force: true }); vi.restoreAllMocks(); });

  it('uses the existing sequence transaction and survives close/reopen with immutable snapshots', () => {
    store.append({ episodeId: binding.episodeId, workId: null, type: 'existing-evidence', payload: {} });
    const value = selection();
    const selected = appendRunSelection(binding, value);
    const dispatched = appendRunDispatch(binding, { ...dispatch(), agentRole: 'subagent', parentToolCallId: 'tool-1' });
    const observed = appendRunObservation(binding, observation());
    expect([selected.seq, dispatched.seq, observed.seq]).toEqual([1, 2, 3]);
    value.saved.model = 'later-model';
    store.close();
    store = new CreativeEpisodeStore(join(root, '.inkos', 'harness.sqlite'));
    const events = store.listEvents('episode-r1');
    expect(events.map(({ seq }) => seq)).toEqual([0, 1, 2, 3]);
    expect(events[1].payload).toEqual(selection());
    expect(selected).toEqual({ episodeId: events[1].episodeId, seq: events[1].seq, timestamp: events[1].timestamp });
    expect(events[2].payload).toMatchObject({ modelCallId: 'call-1', agentRole: 'subagent', parentToolCallId: 'tool-1' });
  });

  it('does not create an episode or confuse a Studio transport ID with the core request', () => {
    expect(() => appendRunSelection({ ...binding, episodeId: 'episode-transport' }, selection())).toThrow('binding');
    expect(() => appendRunSelection({ ...binding, coreRequestId: 'transport' }, selection())).toThrow('binding');
    expect(() => appendRunSelection({ ...binding, sessionId: 'other-session' }, selection())).toThrow('binding');
    expect(() => appendRunSelection({ ...binding, episodeId: 'episode-missing', coreRequestId: 'missing' }, selection('missing'))).toThrow('Unknown creative episode');
    expect(store.listEvents(binding.episodeId)).toHaveLength(0);
    expect(store.getEpisode('episode-missing')).toBeUndefined();
  });

  it('works without ALS, while a missing store or a closed SQLite store cannot return success', () => {
    recordExecutionEvidence(RUN_HISTORY_EVENT_TYPE, selection());
    expect(store.listEvents(binding.episodeId)).toHaveLength(0);
    expect(appendRunSelection(binding, selection()).seq).toBe(0);
    expect(() => appendRunSelection({ ...binding, store: undefined } as never, selection())).toThrow('explicit episode store');
    store.close();
    for (const append of [() => appendRunSelection(binding, selection()), () => appendRunDispatch(binding, dispatch()), () => appendRunObservation(binding, observation())]) {
      expect(append).toThrow();
    }
    store = new CreativeEpisodeStore(join(root, '.inkos', 'harness.sqlite'));
    expect(store.listEvents(binding.episodeId)).toHaveLength(1);
  });

  it('propagates an append failure after an ACK without retrying or manufacturing a receipt', () => {
    const append = vi.spyOn(store, 'append').mockImplementation(() => { throw new Error('synthetic write failure'); });
    expect(() => appendRunObservation(binding, observation())).toThrow('synthetic write failure');
    expect(append).toHaveBeenCalledTimes(1);
    expect(store.listEvents(binding.episodeId)).toHaveLength(0);
  });

  it('permits duplicate physical appends but projects the same source idempotently', () => {
    const a = appendRunDispatch(binding, dispatch());
    const b = appendRunDispatch(binding, dispatch());
    expect(b.seq).toBe(a.seq + 1);
    const projected = project(store.listEvents(binding.episodeId));
    expect(projected.requests[0].dispatches).toHaveLength(1);
    expect(projected.issues).toEqual([]);
  });

  it('leaves transcript v1 bytes, committed replay and failed/interrupted UI restoration unchanged', async () => {
    const events = [...transcript(), ...transcript('failed', 'failed'), ...transcript('unfinished', 'interrupted')]
      .map((value, index) => ({ ...value, seq: index + 1 }));
    for (const value of events) await appendTranscriptEvent(root, value);
    const before = await readFile(transcriptPath(root, 's1'));
    appendRunSelection(binding, selection()); appendRunDispatch(binding, dispatch()); appendRunObservation(binding, observation());
    const loaded = await readTranscriptEvents(root, 's1');
    const projected = project(store.listEvents(binding.episodeId), { transcript: loaded });
    expect(await readFile(transcriptPath(root, 's1'))).toEqual(before);
    expect(committedMessageEvents(loaded).map(value => value.requestId)).toEqual(['r1']);
    expect((await deriveBookSessionFromTranscript(root, 's1'))?.messages.length).toBeGreaterThanOrEqual(3);
    expect(projected.requests.find(value => value.coreRequestId === 'failed')).toMatchObject({ transcriptStatus: 'failed', recording: 'not-recorded' });
    expect(projected.requests.find(value => value.coreRequestId === 'unfinished')).toMatchObject({ transcriptStatus: 'interrupted', recording: 'not-recorded' });
    expect(TranscriptEventSchema.safeParse({ ...events[0], runtimeHistory: {} }).success).toBe(false);
    expect(TranscriptEventSchema.safeParse({ ...events[0], type: 'runtime-history' }).success).toBe(false);
  });
});

describe('pure historical projection', () => {
  it('shows old requests as unrecorded and never derives selection/effective from messages or latest overrides', () => {
    const metadata: TranscriptEvent = { version: 1, sessionId: 's1', seq: 10, timestamp: 10,
      type: 'session_metadata_updated', modelOverride: 'latest-model', serviceOverride: 'priority', updatedAt: 10 };
    const result = project([], { transcript: [...transcript(), metadata] });
    expect(result.requests[0]).toMatchObject({ recording: 'not-recorded', selection: null, observations: [], modelReplayEligible: true });
    expect(JSON.stringify(result)).not.toMatch(/latest-model|message-end-model|private prompt/);
  });

  it('retains saved values independently of the selected native defaults and hides context/ref', () => {
    const result = project([event(selection())]);
    expect(result.requests[0].selection).toEqual({ saved: selection().saved, selection: {
      harnessId: 'codex', adapterVersion: 'codex-adapter-test-v1', authGeneration: 7, modelId: 'gpt-6.1-sol',
      effort: 'low', serviceTier: 'default', configRevision: 42,
    } });
    expect(JSON.stringify(result)).not.toMatch(/authContextRef|connectionRef|fixture-codex-auth-context|opaque-test-connection/);
  });

  it('keeps thread ACK scoped to its thread and turn ACK unknown despite the requested override', () => {
    const threadDispatch: RunDispatch = { ...identity, kind: 'dispatch', modelCallId: 'call-1', agentRole: 'main',
      operation: 'codex-thread-start', wire: { model: 'requested-thread-model', serviceTier: null } };
    const threadAck: RunObservation = { ...identity, kind: 'observation', modelCallId: 'call-1', source: 'codex-thread-start-ack',
      scope: 'thread', threadId: 'thread-1', effective: { modelId: 'thread-ack-model', effort: null, serviceTier: 'default' } };
    const result = project([event(threadAck, 3), event(observation(), 4), event(dispatch(), 2), event(threadDispatch, 1)]);
    const observed = result.requests[0].observations;
    expect(observed[0]).toMatchObject({ scope: 'thread', linked: true, fields: { modelId: { state: 'observed', value: 'thread-ack-model' } } });
    expect(observed[1]).toMatchObject({ scope: 'turn', linked: true, fields: { modelId: { state: 'unknown' }, effort: { state: 'unknown' }, serviceTier: { state: 'unknown' } } });
    expect(result.issues).toEqual([]);
    expect(result.requests[0].dispatches.find(value => value.operation === 'codex-turn-start')?.wire).toEqual(dispatch().wire);
  });

  it('does not inherit a confirmed earlier turn into a later turn on the same thread', () => {
    const first = { ...observation(), source: 'codex-turn-runtime', effective: { modelId: 'actual-first', serviceTier: null } };
    const second = { ...observation(), modelCallId: 'call-2', turnId: 'turn-2' };
    const result = project([event(first, 2), event(dispatch(), 1), event(second, 4), event({ ...dispatch(), modelCallId: 'call-2', wire: { model: 'later-override' } }, 3)]);
    expect(result.requests[0].observations[0].fields.modelId).toEqual({ state: 'observed', value: 'actual-first' });
    expect(result.requests[0].observations[0].fields.serviceTier).toEqual({ state: 'observed', value: null });
    expect(result.requests[0].observations[1].fields.modelId).toEqual({ state: 'unknown' });
  });

  it('requires runtime turn observations to match the ACK turn identity of their model call', () => {
    const wrongTurn = { ...observation(), source: 'codex-turn-runtime', turnId: 'other-turn', effective: { modelId: 'other-model' } };
    const result = project([event(wrongTurn, 3), event(dispatch(), 1), event(observation(), 2)]);
    expect(result.requests[0].observations.map(value => value.linked)).toEqual([true, false]);
    expect(result.issues.map(value => value.code)).toEqual(['identity-mismatch']);
    const actualTurn = { ...wrongTurn, turnId: 'turn-1' };
    expect(project([event(dispatch()), event(observation(), 1), event(actualTurn, 2)]).requests[0].observations.every(value => value.linked)).toBe(true);
    // A real scoped notification can remain evidence when the ACK was not recorded.
    expect(project([event(dispatch()), event(actualTurn, 1)]).requests[0].observations[0].linked).toBe(true);
  });

  it('treats contradictory ACK identities for one model call as a source conflict', () => {
    const runtime = { ...observation(), source: 'codex-turn-runtime', effective: { modelId: 'actual' } };
    const result = project([event(dispatch()), event(observation(), 1), event({ ...observation(), turnId: 'different-turn' }, 2), event(runtime, 3)]);
    expect(result.requests[0].recording).toBe('invalid');
    expect(result.requests[0].observations).toHaveLength(1);
    expect(result.requests[0].observations[0].linked).toBe(false);
    expect(result.issues.map(value => value.code)).toEqual(['conflicting-source', 'identity-mismatch']);
    const threadDispatch = { ...identity, kind: 'dispatch', modelCallId: 'call-1', agentRole: 'main', operation: 'codex-thread-start', wire: {} };
    const threadAck = { ...identity, kind: 'observation', modelCallId: 'call-1', source: 'codex-thread-start-ack', scope: 'thread', threadId: 'thread-1', effective: {} };
    const threads = project([event(threadDispatch), event(threadAck, 1), event({ ...threadAck, threadId: 'thread-2' }, 2)]);
    expect(threads.requests[0].observations).toEqual([]);
    expect(threads.issues.map(value => value.code)).toEqual(['conflicting-source']);
  });

  it('checks turn identity against the same call thread ACK without inheriting its effective fields', () => {
    const threadDispatch = { ...identity, kind: 'dispatch', modelCallId: 'call-1', agentRole: 'main', operation: 'codex-thread-start', wire: {} };
    const threadAck = { ...identity, kind: 'observation', modelCallId: 'call-1', source: 'codex-thread-start-ack', scope: 'thread',
      threadId: 'thread-1', effective: { modelId: 'thread-model' } };
    const result = project([event(threadDispatch), event(threadAck, 1), event({ ...dispatch(), threadId: 'thread-2' }, 2),
      event({ ...observation(), threadId: 'thread-2' }, 3)]);
    expect(result.requests[0].observations.map(value => value.linked)).toEqual([true, false]);
    expect(result.requests[0].observations[1].fields.modelId).toEqual({ state: 'unknown' });
    expect(result.issues.map(value => value.code)).toEqual(['identity-mismatch']);
    const conflicted = project([event(threadDispatch), event(threadAck, 1), event({ ...threadAck, threadId: 'thread-2' }, 2),
      event(dispatch(), 3), event(observation(), 4)]);
    expect(conflicted.requests[0].observations[0].linked).toBe(false);
    expect(conflicted.issues.map(value => value.code)).toEqual(['conflicting-source', 'identity-mismatch']);
    expect(project([event(dispatch()), event(observation(), 1)]).requests[0].observations[0].linked).toBe(true);
  });

  it('distinguishes Pi entries and Pi sessions even with the same model call ID', () => {
    const piDispatch = { ...identity, kind: 'dispatch', modelCallId: 'pi-call', agentRole: 'workflow',
      operation: 'pi-prompt', piSessionId: 'pi-1', wire: {} };
    const piEntry = { ...identity, kind: 'observation', modelCallId: 'pi-call', source: 'pi-session-entry',
      scope: 'entry', piSessionId: 'pi-1', entryId: 'entry-1', effective: { modelId: 'pi-actual' } };
    const result = project([event(piDispatch, 1), event(piEntry, 2), event({ ...piEntry, entryId: 'entry-2', effective: {} }, 3),
      event({ ...piEntry, piSessionId: 'pi-other' }, 4)]);
    expect(result.requests[0].observations.map(value => value.linked)).toEqual([true, true, false]);
    expect(result.requests[0].observations[1].fields.modelId).toEqual({ state: 'unknown' });
    expect(result.issues.map(value => value.code)).toEqual(['identity-mismatch']);
  });

  it('is independent of arrival order and cannot join across requests, sessions or threads', () => {
    const events = [event(dispatch('r2'), 2, 'episode-r2'), event(observation(), 3),
      event({ ...observation('r2'), threadId: 'wrong-thread' }, 3, 'episode-r2'),
      event({ ...selection(), sessionId: 'other-session' }, 0), event(selection(), 1)];
    const input = { transcript: [...transcript(), ...transcript('r2')] };
    const result = project(events, input);
    expect(project([...events].reverse(), input).requests).toEqual(result.requests);
    expect(result.requests.find(value => value.coreRequestId === 'r1')?.observations[0].linked).toBe(false);
    expect(result.issues.map(value => value.code).sort()).toEqual(['identity-mismatch', 'missing-dispatch']);
  });

  it.each(['selection', 'dispatch', 'observation'] as const)('reports conflicting %s sources and never chooses a winning value', kind => {
    const value = kind === 'selection' ? selection() : kind === 'dispatch' ? dispatch() : observation();
    const changed = value.kind === 'selection' ? { ...value, saved: { ...value.saved, model: 'different' } }
      : value.kind === 'dispatch' ? { ...value, wire: { model: 'different' } } : { ...value, effective: { modelId: 'different' } };
    const result = project([event(value, 1), event(changed, 2), event(value, 3)]);
    expect(result.requests[0]).toMatchObject({ recording: 'invalid', selection: null, dispatches: [], observations: [] });
    expect(result.issues.map(value => value.code)).toEqual(['conflicting-source']);
    expect(project([event(value, 3), event(changed, 2), event(value, 1)]).requests).toEqual(result.requests);
  });

  it('deduplicates identical observations regardless of object key order, with no physical exactly-once claim', () => {
    const ack = observation();
    const shuffled = Object.fromEntries(Object.entries(ack).reverse());
    const result = project([event(dispatch(), 0), event(ack, 2), event(shuffled, 1)]);
    expect(result.requests[0].observations).toHaveLength(1);
    expect(result.issues).toEqual([]);
  });

  it('reports unknown versions, corrupt payloads and episode binding mismatches without leaking raw data', () => {
    const result = project([event({ ...selection(), schemaVersion: 2 }, 1), event({ ...observation(), token: 'synthetic-secret' }, 2),
      event(selection(), 3, 'episode-transport'), event({ schemaVersion: 1, kind: 'unknown', rawError: 'private-error' }, 4)],
      { transcript: [...transcript(), { schemaVersion: 2, prompt: 'private-transcript' }], episodes: [{}] });
    expect(result.issues.map(value => value.code)).toEqual(['invalid-transcript', 'unsupported-version', 'invalid-payload', 'binding-mismatch', 'invalid-payload', 'invalid-episode']);
    expect(result.requests[0].recording).toBe('invalid');
    expect(result.requests[0].selection).toBeNull();
    expect(JSON.stringify(result)).not.toMatch(/synthetic-secret|private-error|private-transcript/);
  });

  it.each([undefined, null, '2', -1, 1.5])('reports a malformed schema version %s as corruption', schemaVersion => {
    const result = project([event({ ...selection(), schemaVersion })]);
    expect(result.issues.map(value => value.code)).toEqual(['invalid-payload']);
    expect(result.requests[0].recording).toBe('invalid');
  });

  it('never makes orphan dispatch/observation into a terminal business receipt', () => {
    const result = project([event(dispatch()), event(observation(), 1)], { transcript: [] });
    expect(result.requests[0]).toMatchObject({ transcriptStatus: 'unrecorded', modelReplayEligible: false, episodeStatus: null });
    expect(result.issues.map(value => value.code)).toEqual(['orphan-evidence']);
  });

  it('keeps committed replay separate from a failed episode for a blocked completion', () => {
    const blocked: TranscriptEvent = { version: 1, sessionId: 's1', requestId: 'r1', seq: 2, timestamp: 1, type: 'message',
      uuid: 'blocked', parentUuid: null, role: 'assistant', message: {}, display: { completion: { status: 'blocked', message: 'Blocked' } } };
    const events = transcript().map(value => value.type === 'message' ? blocked : value);
    const result = project([event(selection())], { transcript: events, episodes: [{ version: HARNESS_VERSION, id: 'episode-r1', workId: null,
      profileId: null, status: 'failed', startedAt: '2026-10-10T00:00:00Z', completedAt: '2026-10-10T00:01:00Z' }] });
    expect(result.requests[0]).toMatchObject({ transcriptStatus: 'committed', episodeStatus: 'failed', modelReplayEligible: true });
    expect(committedMessageEvents(events)).toEqual([blocked]);
    expect(result.requests[0]).not.toHaveProperty('success');
  });
});
