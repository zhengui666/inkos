import { appendTranscriptEvents } from "../interaction/session-transcript.js";
import type { CreativeEpisodeStore } from "../harness/episode-store.js";
import type { EpisodeStatus } from "../harness/contracts.js";

/** Settle both durable projections even if one storage boundary fails. No replay. */
export async function finalizeAgentRequest(input: {
  projectRoot: string;
  sessionId: string;
  requestId: string;
  episodes: CreativeEpisodeStore;
  status: Exclude<EpisodeStatus, "running">;
  error?: unknown;
  signal?: AbortSignal;
}): Promise<number | undefined> {
  const failures: unknown[] = [];
  let committedSeq: number | undefined;
  let episodeStatus = input.status;
  let settlementError = input.error;
  let interruptedBeforeCommit = false;
  try {
    await appendTranscriptEvents(input.projectRoot, input.sessionId, ({ events, nextSeq }) => {
      const terminal = events.find(event => event.type.startsWith("request_")
        && "requestId" in event && event.requestId === input.requestId
        && (event.type === "request_committed" || event.type === "request_failed"));
      if (terminal) {
        if (terminal.type === "request_committed") committedSeq = terminal.seq;
        if (terminal.type === "request_failed") episodeStatus = terminal.code === "REQUEST_CANCELLED" ? "cancelled" : "failed";
        return [];
      }
      if (!events.some(event => event.type === "request_started" && event.requestId === input.requestId)) return [];
      // This runs inside the transcript queue, after its asynchronous read.
      // A stop observed before selecting a terminal receipt cannot commit success.
      if (input.signal?.aborted) {
        settlementError = input.signal.reason;
        episodeStatus = settlementError instanceof Error && settlementError.name === "AbortError" ? "cancelled" : "failed";
        interruptedBeforeCommit = true;
      }
      const base = { version: 1 as const, sessionId: input.sessionId, requestId: input.requestId, seq: nextSeq, timestamp: Date.now() };
      if (settlementError !== undefined) {
        const code = episodeStatus === "cancelled" ? "REQUEST_CANCELLED"
          : settlementError instanceof Error && "code" in settlementError && typeof settlementError.code === "string" ? settlementError.code : undefined;
        return [{ ...base, type: "request_failed" as const,
          error: settlementError instanceof Error ? settlementError.message : String(settlementError), ...(code ? { code } : {}) }];
      }
      committedSeq = nextSeq;
      return [{ ...base, type: "request_committed" as const }];
    }, { beforeAppend: events => {
      if (!input.signal?.aborted) return events;
      return events.map(event => {
        if (event.type !== "request_committed") return event;
        settlementError = input.signal!.reason;
        episodeStatus = settlementError instanceof Error && settlementError.name === "AbortError" ? "cancelled" : "failed";
        interruptedBeforeCommit = true;
        committedSeq = undefined;
        const code = episodeStatus === "cancelled" ? "REQUEST_CANCELLED"
          : settlementError instanceof Error && "code" in settlementError && typeof settlementError.code === "string" ? settlementError.code : undefined;
        return { ...event, type: "request_failed" as const,
          error: settlementError instanceof Error ? settlementError.message : String(settlementError), ...(code ? { code } : {}) };
      });
    } });
  } catch (error) {
    failures.push(error);
    // A delivery whose request receipt was not durably committed is incomplete.
    episodeStatus = "failed";
  }
  try {
    const id = `episode-${input.requestId}`;
    if (input.episodes.getEpisode(id)) input.episodes.finishWithEvent(id, episodeStatus);
  } catch (error) { failures.push(error); }
  if (failures.length) throw Object.assign(new AggregateError(
    settlementError === undefined ? failures : [settlementError, ...failures],
    `Request finalization failed${settlementError instanceof Error ? ` after: ${settlementError.message}` : ""}: ${failures.map(String).join("; ")}`,
    { cause: settlementError ?? failures[0] },
  ), { code: "REQUEST_PERSISTENCE_FAILED" });
  if (interruptedBeforeCommit) throw settlementError;
  return committedSeq;
}
