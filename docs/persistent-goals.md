# Persistent chapter goals (Core, CLI and agent host tools)

Persistent goals have a Core executor, versioned CLI commands and chapter-goal
agent host tools. Studio chat can use those host tools; there is no separate Goal
API route or dedicated Goal UI. Creating, showing or reopening a goal does not start
writing, replay old requests, or start the existing scheduler. Running remains an
explicit action. Model decisions in the automated tests are fixtures; no live
novel generation or platform publication is established by those tests.

## Start and inspect a goal

```ts
import { join } from "node:path";
import {
  GoalStore, GoalExecutor, chapterGoalInput, createChapterGoalAdapter,
} from "@actalk/inkos-core";

// pipeline must use the same projectRoot and the caller's authorized model setup.
const store = new GoalStore(join(projectRoot, ".inkos", "harness.sqlite"));
const goal = store.create(chapterGoalInput({
  id: "finish-volume-one", workId: "novel", intent: "Finish the departure sequence.",
  startChapter: 1, endChapter: 18, expiresAt: Date.now() + 12 * 60 * 60 * 1000,
}));
// create is inert. requestRun is the explicit start/resume boundary.
store.requestRun(goal.id, goal.version);
const executor = new GoalExecutor(store, [createChapterGoalAdapter({ projectRoot, pipeline })]);
const result = await executor.run(goal.id);
console.log(result.status, result.steps, result.error);
store.close();
```

`get(id)` reads a consistent persisted snapshot. `events(id, afterSeq)` reads the
event cursor. All state changes and their events commit in the same SQLite
transaction. Goal tables share the Harness database and its WAL/foreign-key/busy
timeout settings; they do not duplicate chapter files or transcripts. Step
inputs, operation keys, budgets and accepted receipts remain stable on resume.
The chapter adapter also retains the actual index, settled runtime state, prior
revision IDs and source text before its first attempt. A retry cannot silently
switch to a different baseline while the target chapter is still missing.

The chapter goal's acceptance is structural: all exact chapter numbers must have
a consistent index/source pair, matching Work revision and immutable revision
snapshot, and settled chapter/runtime checkpoints. It does not certify literary
quality, resolution of review observations, export, submission, or publication.
Those require separate adapters and acceptance checks.

## Pause, cancellation and recovery

`requestStop(id, "paused" | "cancelled", version)` first persists the desired
state. A running executor observes it and aborts its signal. Its ownership remains
held until the active adapter and its cleanup finish. During that interval the
status is `running` with a stopped desired state; callers should display
"stopping". A late committed artifact may produce a retained receipt, but cannot
complete or revive a cancelled goal. Cancellation cannot be changed back to
pause/run, including after reopening the store.

`recover(id)` checks an existing owner. A live foreign process or a locally active
owner keeps ownership even after the diagnostic lease expires. A demonstrably
exited owner becomes `interrupted`, `paused`, or `cancelled`, preserving attempts
and in-flight steps. Recovery never dispatches work. An explicit
`requestRun(id, currentVersion)` followed by `run(id)` rechecks persisted effects
before selecting the still-missing chapter. Cancelled/completed/failed goals are
terminal; a new goal is needed to change their scope or budgets.
The shared book lock follows the same rule for ordinary writers: an old heartbeat
does not prove exit. A reused live PID, denied liveness check, or unknown owner
remains blocked until ownership can be reconciled; path aliases share one local owner.
Lock-file inspection, stale removal, claim and token-checked release now use a
short SQLite mutex at `source/.write.lock.guard.sqlite`. It is excluded from Work
artifacts and remains on disk: deleting/replacing this file can split ownership.
The mutex is held only for synchronous lock-file operations, never for generation.
Drain older Inkos processes before deploying this protocol; older binaries do
not participate in its claim/release mutex.

SQLite `BEGIN IMMEDIATE` and a unique live-owner constraint serialize claims both
for the same goal and for different goals targeting the same Work. The chapter
adapter also holds Inkos's existing Work mutation scope/book lock across
reconcile, generation and readback, including interactions with ordinary writing
requests. A timed-out or uncooperative host task never loses ownership while it
can still commit. `close()` refuses to close a store that owns active work.

## Reconciliation is a machine state

`reconciliation_required` means a program must diagnose or repair missing or
conflicting evidence. It does not ask the author a creative question. The error
code identifies examples such as an incomplete index, state behind retained
prose, a missing checkpoint, a changed accepted revision, or an unsynchronized
Work registry. A caller can repair the specific condition through existing
authorized APIs and use `requestRun` to recheck it. Repeated rechecks never replay
an unknown effect. `waiting_user` is reserved for an adapter that explicitly
reports missing author input/permission.

This slice deliberately does not perform model-driven state re-settlement or
automatically accept an unexplained source revision. A registry repair can use
the existing source synchronization API with a verified, narrowly selected
`acceptPaths` set. State repair can use the existing retained-chapter settlement
path after its own safety checks. Neither repair should regenerate saved prose.
The executor exposes diagnostics and a resume boundary so a later bounded repair
adapter can take responsibility without adding a human gate to every error.

## Budgets and adapter contract

Budgets count **step execution attempts**, not raw model calls or tokens. They
persist across restart; each step has its own attempt cap (default three, maximum
ten), plus a goal cap and fixed absolute deadline. Existing worker correction
loops may issue several calls within an attempt and remain subject to the
deadline signal. This is not a token/cost budget. Repeated failures without a new
receipt consume the same caps; readback alone does not reset them or update
`lastProgressAt`.
Completion checks the deadline again inside the terminal SQLite write transaction.
Waiting for another database writer cannot bypass the deadline by blocking the
JavaScript watchdog; a retained receipt can coexist with a failed goal.

A custom `GoalStepAdapter` must hold its own appropriate scope, drain every
started side effect before returning, and provide authoritative `reconcile`:

- `completed` supplies a receipt for the exact operation key and immutable output
- `absent` proves that retry cannot duplicate an already committed effect
- `unknown` stops dispatch in `reconciliation_required`
- `waiting_user` supplies a concrete missing author decision

Execution is repeated only if the adapter explicitly opts into `retrySafe`,
readback proves absence, the error is classified transient, and budget remains.
The chapter adapter retries only a narrow provider/transport error list. It
always calls `writeChapters` with count one and the exact next chapter number.
On resume, previously accepted revision IDs and retained source bytes are checked
before new writing, and all receipts are checked again before goal completion.

Receipts have operationKey, immutable artifact/revision/path references,
and structured evidence. A future publishing adapter must preserve platform
approval and unknown-outcome rules. A prepared manual submission package is not
evidence that a platform accepted or published the chapter.

## Verification and subsequent slices

Tests cover cancellation/late commit, pause/resume, live-owner fencing,
dead-process recovery, durable attempt budgets, atomic receipt/event failures,
unknown outcomes, changed baselines, and chapter 18 recovery with chapters 1–17
unchanged. All inference decisions are mocked; SQLite, chapter persistence, Work
registry, locks, checkpoints and pipeline chapter dispatch are real modules.

The CLI exposes `goal create`, `list`, `show`, `events`, `run`, `pause`, `cancel`
and `recover`. `run`, `pause`, `cancel` and `recover` use the current version from
`show`; `run` is foreground execution and drains work after interruption. Agent
host tools expose the same service to Studio chat. Automatic bounded state replay
is not wired into ordinary Studio/Goal callers; the explicit replay CLI remains
available. Daemon resume and any further repair adapter must preserve cancellation
tombstones and never resume an existing cancelled request implicitly.
