# Request execution and recovery

Ordinary chat requests remain single submissions. Recovery never replays a model
turn or a writing/publishing action automatically.

## Execution limits

- `INKOS_AGENT_IDLE_TIMEOUT_MS`: model silence limit, default 60 minutes. Actual
  Codex activity resets it. Time spent in an active host tool is excluded; a quiet
  chapter-writing tool is not evidence that its parent model stalled
- `INKOS_AGENT_TIMEOUT_MS`: total main request budget, default 24 hours. One budget
  covers completion correction and Work transitions; it does not reset between
  them. Waiting in the per-session queue does not consume this budget
- `INKOS_WORKER_TIMEOUT_MS`: existing worker budget, unchanged at 60 minutes

These host environment settings accept integer milliseconds from 1 to 2147483647.
An invalid limit fails the request rather than overflowing Node's timer. Timeout
stops the current attempt and retains saved artifacts; it does not authorize a
retry or increase the writing range. Budget exhaustion is a failure, not a user
cancellation. Stable diagnostics include `AGENT_MODEL_STALLED` (last event and
failed-tool count) and `AGENT_REQUEST_TIMEOUT`.

Abort and timeout signal the Codex peer and host tools. Ownership is held until
already-started host work actually exits. An uncooperative in-process tool cannot
be safely killed with a Promise timeout; the host must not release its slot or
start a replacement mutation while that tool is still alive.

## Durable outcomes

The transcript owns conversation results, Harness owns action/episode receipts,
and the Studio snapshot owns transport status. Request finalization attempts both
transcript and episode settlement even if one storage boundary fails. Episode
terminal status and its event are committed in a single SQLite transaction.
Repeated finalization never rewrites a cancelled/terminal episode or creates a
second terminal transcript event. `REQUEST_PERSISTENCE_FAILED` reports incomplete
settlement; it is not a successful delivery. Storage outages cannot guarantee a
durable write until the storage itself recovers.

The terminal decision checks cancellation in the transcript queue and again after
asynchronous filesystem preparation, immediately before submitting the append.
A stop or request deadline observed there writes failure/cancellation to both
projections and cannot publish a success response. An already-submitted terminal
append is not rewritten by a later signal.

Studio stores request ownership separately from its HTTP connection. Reopening a
page does not interrupt a live request. New snapshots include process and instance
identity; another live server owner is preserved conservatively. Once its owner
is gone, a saved running request is durably marked failed with
`CHAT_REQUEST_INTERRUPTED`. Legacy snapshots without ownership retain the prior
single-server restart policy. This is not a distributed execution lease system.
Admission always checks the durable snapshot, even when this server caches an
older terminal request. Reading, validating and saving a new admission share one
queue across server instances in the same process. This queue is not a
cross-process compare-and-swap for simultaneous cold admissions.

A user stop is persisted before signalling an admitted live request. The active
slot stays occupied while it stops. A stop during initial admission also prevents
model/tool work. If the process exits before finalization, restart recovers the
persisted stop as cancelled, not retryable. A stopped orphan can be cancelled
without an in-memory controller. Late status writes cannot overwrite a newer
request or erase a cancellation intent. Explicit retry retains the original Work
revision baseline and rejects cancelled requests and stale request identities.

These boundaries are intended for reuse by a later durable Goal executor. They do
not start a paused daemon, adopt old cancelled requests, grant publication
approval, or treat a local export/submission as a published chapter.
