import { z } from 'zod';
import type { CreativeEpisodeStore } from '../harness/episode-store.js';
import { CreativeEpisodeEventSchema, CreativeEpisodeSchema, type CreativeEpisodeEvent, type EpisodeStatus } from '../harness/contracts.js';
import { TranscriptEventSchema } from '../interaction/session-transcript-schema.js';
import { HarnessIdSchema, HarnessPreferencesSchema, ModelConnectionAdmissionSchema, RuntimeIdSchema, RuntimeRevisionSchema, type RuntimeSelection } from './contracts.js';

export const RUN_HISTORY_SCHEMA_VERSION = 1;
export const RUN_HISTORY_EVENT_TYPE = 'runtime-history';

const Identity = { sessionId: RuntimeIdSchema, coreRequestId: RuntimeIdSchema };
const Base = { schemaVersion: z.literal(RUN_HISTORY_SCHEMA_VERSION), ...Identity };
const Call = {
  modelCallId: RuntimeIdSchema,
  agentRole: z.enum(['main', 'subagent', 'workflow']),
  parentToolCallId: RuntimeIdSchema.optional(),
};

/** Host snapshot. authGeneration is an owner version, not a provider auth claim. */
const SelectionSchema = z.object({
  harnessId: HarnessIdSchema,
  adapterVersion: z.string().min(1).max(128),
  authContextRef: ModelConnectionAdmissionSchema.shape.authContextRef,
  connectionRef: ModelConnectionAdmissionSchema.shape.connection.shape.connectionRef,
  authGeneration: RuntimeRevisionSchema,
  modelId: RuntimeIdSchema,
  effort: RuntimeIdSchema.nullable(),
  serviceTier: RuntimeIdSchema.nullable(),
  configRevision: RuntimeRevisionSchema,
}).strict() satisfies z.ZodType<RuntimeSelection>;

export const RunSelectionSchema = z.object({
  ...Base, kind: z.literal('selection'),
  saved: HarnessPreferencesSchema.extend({ harnessId: HarnessIdSchema, revision: RuntimeRevisionSchema }).strict(),
  selection: SelectionSchema,
}).strict().superRefine((value, context) => {
  if (value.saved.harnessId !== value.selection.harnessId || value.saved.revision !== value.selection.configRevision) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Saved preferences and selection must share harness and revision' });
  }
});
export type RunSelection = z.infer<typeof RunSelectionSchema>;

// Missing, null and concrete wire values stay distinct, including Standard.
const WireValue = RuntimeIdSchema.nullable().optional();
const ThreadWire = z.object({ model: WireValue, serviceTier: WireValue }).strict();
const TurnWire = ThreadWire.extend({ effort: WireValue, serviceTierForTurn: WireValue }).strict();
const PiWire = z.object({ model: WireValue, effort: WireValue, serviceTier: WireValue }).strict();

export const RunDispatchSchema = z.discriminatedUnion('operation', [
  z.object({ ...Base, kind: z.literal('dispatch'), ...Call, operation: z.literal('codex-thread-start'), wire: ThreadWire }).strict(),
  z.object({ ...Base, kind: z.literal('dispatch'), ...Call, operation: z.literal('codex-turn-start'), threadId: RuntimeIdSchema, wire: TurnWire }).strict(),
  z.object({ ...Base, kind: z.literal('dispatch'), ...Call, operation: z.literal('pi-prompt'), piSessionId: RuntimeIdSchema, wire: PiWire }).strict(),
]).superRefine((value, context) => {
  if (Object.values(value.wire).some(field => field === undefined)
    || (Object.hasOwn(value, 'parentToolCallId') && value.parentToolCallId === undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Omit absent fields; explicit undefined is not durable JSON' });
  }
});
export type RunDispatch = z.infer<typeof RunDispatchSchema>;

const EffectiveSchema = z.object({ modelId: WireValue, effort: WireValue, serviceTier: WireValue }).strict();
const Observed = { ...Base, kind: z.literal('observation'), modelCallId: RuntimeIdSchema, effective: EffectiveSchema };
export const RunObservationSchema = z.discriminatedUnion('source', [
  z.object({ ...Observed, source: z.literal('codex-thread-start-ack'), scope: z.literal('thread'), threadId: RuntimeIdSchema }).strict(),
  z.object({ ...Observed, source: z.literal('codex-turn-start-ack'), scope: z.literal('turn'), threadId: RuntimeIdSchema, turnId: RuntimeIdSchema }).strict(),
  z.object({ ...Observed, source: z.literal('codex-turn-runtime'), scope: z.literal('turn'), threadId: RuntimeIdSchema, turnId: RuntimeIdSchema }).strict(),
  z.object({ ...Observed, source: z.literal('pi-session-entry'), scope: z.literal('entry'), piSessionId: RuntimeIdSchema, entryId: RuntimeIdSchema }).strict(),
]).superRefine((value, context) => {
  if (Object.values(value.effective).some(field => field === undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Omit unobserved fields; explicit undefined is not durable JSON' });
  }
});
export type RunObservation = z.infer<typeof RunObservationSchema>;
export const RunHistoryPayloadSchema = z.union([RunSelectionSchema, RunDispatchSchema, RunObservationSchema]);
export type RunHistoryPayload = z.infer<typeof RunHistoryPayloadSchema>;

/** Explicitly bind to the existing core episode; never use a Studio transport ID. */
export interface RunHistoryBinding {
  readonly store: CreativeEpisodeStore;
  readonly episodeId: string;
  readonly sessionId: string;
  readonly coreRequestId: string;
}
export type RunHistoryReceipt = Pick<CreativeEpisodeEvent, 'episodeId' | 'seq' | 'timestamp'>;

function append(binding: RunHistoryBinding, payload: RunHistoryPayload): RunHistoryReceipt {
  if (!binding?.store) throw new Error('Run history requires an explicit episode store');
  if (binding.episodeId !== `episode-${payload.coreRequestId}` || binding.coreRequestId !== payload.coreRequestId
    || binding.sessionId !== payload.sessionId) throw new Error('Run history episode/request binding mismatch');
  const episode = binding.store.requireEpisode(binding.episodeId);
  const receipt = binding.store.append({ episodeId: episode.id, workId: episode.workId, type: RUN_HISTORY_EVENT_TYPE, payload });
  return { episodeId: receipt.episodeId, seq: receipt.seq, timestamp: receipt.timestamp };
}

/** Returns only after the existing SQLite append transaction commits. No ALS/no-op sink. */
export function appendRunSelection(binding: RunHistoryBinding, payload: RunSelection): RunHistoryReceipt {
  return append(binding, RunSelectionSchema.parse(payload));
}

/** Records intent only. An ACK followed by a failed append must not trigger an RPC retry. */
export function appendRunDispatch(binding: RunHistoryBinding, payload: RunDispatch): RunHistoryReceipt {
  return append(binding, RunDispatchSchema.parse(payload));
}

/** Only adapter-observed fields belong here; request values and message_end are not evidence. */
export function appendRunObservation(binding: RunHistoryBinding, payload: RunObservation): RunHistoryReceipt {
  return append(binding, RunObservationSchema.parse(payload));
}

export type RunHistoryIssueCode = 'invalid-transcript' | 'invalid-episode' | 'unsupported-version' | 'invalid-payload'
  | 'binding-mismatch' | 'conflicting-source' | 'orphan-evidence' | 'missing-dispatch' | 'identity-mismatch';
export interface RunHistoryIssue {
  readonly code: RunHistoryIssueCode;
  readonly coreRequestId?: string;
  readonly seq?: number;
}
type PublicSelection = Omit<RunSelection['selection'], 'authContextRef' | 'connectionRef'>;
type ObservedValue = { readonly state: 'unknown' } | { readonly state: 'observed'; readonly value: string | null };
export type ProjectedObservation = RunObservation & {
  /** False retains a scoped fact for diagnosis, not confirmation of this dispatch. */
  readonly linked: boolean;
  readonly fields: { readonly modelId: ObservedValue; readonly effort: ObservedValue; readonly serviceTier: ObservedValue };
};
export interface ProjectedRunHistory {
  readonly sessionId: string;
  readonly coreRequestId: string;
  /** interrupted means no terminal transcript receipt, not proof the process stopped. */
  transcriptStatus: 'unrecorded' | 'interrupted' | 'committed' | 'failed';
  episodeStatus: EpisodeStatus | null;
  modelReplayEligible: boolean;
  recording: 'not-recorded' | 'recorded' | 'invalid';
  selection: { readonly saved: RunSelection['saved']; readonly selection: PublicSelection } | null;
  dispatches: RunDispatch[];
  observations: ProjectedObservation[];
}

function sourceKey(payload: RunHistoryPayload): string {
  if (payload.kind === 'selection') return 'selection';
  if (payload.kind === 'dispatch') return JSON.stringify(['dispatch', payload.modelCallId, payload.operation]);
  if (payload.source === 'codex-thread-start-ack' || payload.source === 'codex-turn-start-ack') {
    return JSON.stringify([payload.source, payload.modelCallId]);
  }
  return JSON.stringify([payload.source, payload.modelCallId, payload.scope,
    payload.scope === 'entry' ? payload.piSessionId : payload.threadId,
    payload.scope === 'entry' ? payload.entryId : payload.scope === 'turn' ? payload.turnId : null]);
}

function sameDestination(dispatch: RunDispatch, observation: RunObservation): boolean {
  if (observation.scope === 'thread') return dispatch.operation === 'codex-thread-start';
  if (observation.scope === 'turn') return dispatch.operation === 'codex-turn-start' && dispatch.threadId === observation.threadId;
  return dispatch.operation === 'pi-prompt' && dispatch.piSessionId === observation.piSessionId;
}

function observedField(effective: RunObservation['effective'], field: keyof RunObservation['effective']): ObservedValue {
  return effective[field] === undefined ? { state: 'unknown' } : { state: 'observed', value: effective[field] };
}

/** Pure, browser-safe join. No settings/override reads, raw messages, authentication refs or retry.
 * Transcript and SQLite are independent receipts. Neither dispatch nor observation proves business success.
 * Identical sources project idempotently; physical appends are not exactly-once.
 */
export function projectRunHistory(input: {
  readonly sessionId: string;
  readonly transcript: readonly unknown[];
  readonly episodes: readonly unknown[];
  readonly events: readonly unknown[];
}): { readonly requests: ProjectedRunHistory[]; readonly issues: RunHistoryIssue[] } {
  const sessionId = RuntimeIdSchema.parse(input.sessionId);
  const requests = new Map<string, ProjectedRunHistory>();
  const issues: RunHistoryIssue[] = [];
  const issue = (code: RunHistoryIssueCode, coreRequestId?: string, seq?: number) => {
    issues.push({ code, ...(coreRequestId === undefined ? {} : { coreRequestId }), ...(seq === undefined ? {} : { seq }) });
  };
  const request = (id: string) => {
    let value = requests.get(id);
    if (!value) {
      value = { sessionId, coreRequestId: id, transcriptStatus: 'unrecorded', episodeStatus: null,
        modelReplayEligible: false, recording: 'not-recorded', selection: null, dispatches: [], observations: [] };
      requests.set(id, value);
    }
    return value;
  };
  const terminal = new Map<string, Set<'committed' | 'failed'>>();
  for (const raw of input.transcript) {
    const parsed = TranscriptEventSchema.safeParse(raw);
    if (!parsed.success) { issue('invalid-transcript'); continue; }
    const event = parsed.data;
    if (event.sessionId !== sessionId || !('requestId' in event)) continue;
    const row = request(event.requestId);
    if (row.transcriptStatus === 'unrecorded') row.transcriptStatus = 'interrupted';
    if (event.type === 'request_committed' || event.type === 'request_failed') {
      const states = terminal.get(event.requestId) ?? new Set<'committed' | 'failed'>();
      states.add(event.type === 'request_committed' ? 'committed' : 'failed');
      terminal.set(event.requestId, states);
    }
  }
  for (const [id, states] of terminal) {
    const row = request(id);
    row.transcriptStatus = states.has('failed') ? 'failed' : 'committed';
    row.modelReplayEligible = states.size === 1 && states.has('committed');
    if (states.size > 1) issue('invalid-transcript', id);
  }

  const sources = new Map<string, Map<string, { payload: RunHistoryPayload; seq: number } | null>>();
  for (const raw of input.events) {
    // Other episode evidence is not part of this history contract.
    if (!raw || typeof raw !== 'object' || !('type' in raw) || raw.type !== RUN_HISTORY_EVENT_TYPE) continue;
    const parsed = CreativeEpisodeEventSchema.safeParse(raw);
    if (!parsed.success) { issue('invalid-payload'); continue; }
    const event = parsed.data;
    if (typeof event.payload.sessionId === 'string' && event.payload.sessionId !== sessionId) continue;
    const id = RuntimeIdSchema.safeParse(event.payload.coreRequestId);
    if (event.payload.schemaVersion !== RUN_HISTORY_SCHEMA_VERSION) {
      const version = event.payload.schemaVersion;
      issue(typeof version === 'number' && Number.isSafeInteger(version) && version > 0 ? 'unsupported-version' : 'invalid-payload',
        id.success ? id.data : undefined, event.seq);
      if (id.success) request(id.data).recording = 'invalid';
      continue;
    }
    const payloadResult = RunHistoryPayloadSchema.safeParse(event.payload);
    if (!payloadResult.success) {
      issue('invalid-payload', id.success ? id.data : undefined, event.seq);
      if (id.success) request(id.data).recording = 'invalid';
      continue;
    }
    const payload = payloadResult.data;
    const row = request(payload.coreRequestId);
    if (event.episodeId !== `episode-${payload.coreRequestId}`) {
      issue('binding-mismatch', payload.coreRequestId, event.seq); row.recording = 'invalid'; continue;
    }
    if (row.recording !== 'invalid') row.recording = 'recorded';
    const group = sources.get(payload.coreRequestId) ?? new Map();
    sources.set(payload.coreRequestId, group);
    const key = sourceKey(payload);
    const previous = group.get(key);
    if (previous === null) continue;
    if (previous && JSON.stringify(previous.payload) !== JSON.stringify(payload)) {
      issue('conflicting-source', payload.coreRequestId, event.seq); row.recording = 'invalid'; group.set(key, null);
    } else if (!previous || event.seq < previous.seq) group.set(key, { payload, seq: event.seq });
  }

  for (const [id, group] of sources) {
    const row = request(id);
    const records = [...group.values()].filter(value => value !== null).sort((a, b) => a.seq - b.seq);
    const selection = records.find(value => value.payload.kind === 'selection')?.payload;
    if (selection?.kind === 'selection') {
      const { authContextRef: _context, connectionRef: _connection, ...publicSelection } = selection.selection;
      row.selection = { saved: selection.saved, selection: publicSelection };
    }
    row.dispatches = records.flatMap(({ payload }) => payload.kind === 'dispatch' ? [payload] : []);
    for (const { payload, seq } of records) {
      if (payload.kind !== 'observation') continue;
      const calls = row.dispatches.filter(dispatch => dispatch.modelCallId === payload.modelCallId);
      const ackSource = payload.scope === 'thread' ? 'codex-thread-start-ack' : 'codex-turn-start-ack';
      const ack = group.get(JSON.stringify([ackSource, payload.modelCallId]));
      const ackIdentityMatches = payload.scope === 'entry' || (ack !== null && (!ack
        || (ack.payload.kind === 'observation' && ack.payload.scope === payload.scope
          && ack.payload.threadId === payload.threadId
          && (payload.scope !== 'turn' || (ack.payload.scope === 'turn' && ack.payload.turnId === payload.turnId)))));
      const threadAck = group.get(JSON.stringify(['codex-thread-start-ack', payload.modelCallId]));
      const threadIdentityMatches = payload.scope === 'entry' || (threadAck !== null && (!threadAck
        || (threadAck.payload.kind === 'observation' && threadAck.payload.scope === 'thread'
          && threadAck.payload.threadId === payload.threadId)));
      const linked = ackIdentityMatches && threadIdentityMatches && calls.some(dispatch => sameDestination(dispatch, payload));
      if (!linked) issue(calls.length ? 'identity-mismatch' : 'missing-dispatch', id, seq);
      row.observations.push({ ...payload, linked, fields: {
        modelId: observedField(payload.effective, 'modelId'), effort: observedField(payload.effective, 'effort'),
        serviceTier: observedField(payload.effective, 'serviceTier'),
      } });
    }
    if (row.transcriptStatus === 'unrecorded') issue('orphan-evidence', id);
  }
  for (const raw of input.episodes) {
    const parsed = CreativeEpisodeSchema.safeParse(raw);
    if (!parsed.success) { issue('invalid-episode'); continue; }
    const episode = parsed.data;
    const row = [...requests.values()].find(value => episode.id === `episode-${value.coreRequestId}`);
    if (row) row.episodeStatus = episode.status;
  }
  return { requests: [...requests.values()].sort((a, b) => a.coreRequestId.localeCompare(b.coreRequestId)), issues };
}
