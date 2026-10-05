# Safe replay of existing chapter state

This is an operator recovery command for a book whose prose is ahead of validated canonical state. It does not write new chapters, revise prose, restart requests, resume a Goal, or publish anything.

## Preconditions and execution boundary

1. Install the reviewed implementation together with the final shared book-lock repair. Use a naturally idle project, with no active writer or pending operation. A lease timeout is not evidence that a live writer has stopped.
2. Back up the project using the existing backup procedure. Do not modify the user's original chapter files to make replay pass.
3. Select the exact Work ID and a reviewed, previously validated checkpoint. For a 30-chapter book whose canonical state stopped at chapter 27, the baseline is 27. The selected `story/snapshots/27/state` checkpoint must actually contain chapter 27. A directory called “28” containing a chapter-27 manifest is not a chapter-28 checkpoint. The selected checkpoint is validated directly; equality between the current live canonical state and that older checkpoint is not an additional code requirement.
4. The checkpoint must have consecutive summaries from chapter 1 through the baseline, no unresolved validation observations before/at it, and exactly one body file for every indexed chapter. Missing, duplicate and unindexed chapters are blocked.
5. Select a private plan path. It contains derived story facts and validation observations. The CLI creates it with mode 0600 and refuses to overwrite an existing plan; an additional outside-Work placement rule is not imposed.

## Dry run and review

Run from the original project root, using the installed CLI:

```sh
inkos chapter replay-state BOOK_ID --baseline 27 --dry-run --plan /private/replay-27-to-30.json --json
```

“Dry run” means **no live projection commit**, not “no inference.” It invokes the configured settler and validator on a disposable book copy and consumes model calls. Do not run it as an unattended read-only inspection. It uses the original project's existing account and model settings without copying credentials, while book data and intermediate state remain in a temporary directory.

The same existing book lock covers the operation. Actual chapter inputs and selected authority/checkpoint text are retained. The write lock and its SQLite coordination files are excluded from story artifacts. Those coordination files are never copied into the staged book or treated as story artifacts. Replay processes every persisted chapter after the baseline in order. Each chapter settles against exactly the preceding validated snapshot, is host-reduced from its typed delta, and is validated against its original prose and the fixed author authorities. Only a consistent result without reconciliation advances to the next chapter. There is no creative writer, chapter save, automatic prose correction, or latest-chapter shortcut.

Any failure, cancellation, change to the retained selected inputs, missing authority, or unavailable validator returns an error and discards the staged copy; it does not partially repair the live book. Ordinary execution errors remain execution blockers rather than being classified as user decisions. Genuine authority/content choices should be shown to the user before any different recovery is attempted.

New plan format v3 retains actual inputs and ordinary IDs. The current host-reduced chapter summary is reviewed as an unverified candidate projection, separately from prior accepted summaries. Old v2 records remain readable, but missing retained inputs cannot establish that unchanged source was replayed; v1 plans remain unsupported. Required authority files retain the existing reader contract: readable files are required, but intentionally blank Markdown is allowed; structured book rules keep their existing validation.

Review the JSON's baseline, target, selected chapter text, authority/checkpoint inputs, deltas and observations. The returned `planId` is an ordinary identity; it is not a content digest or trust signature. Commit only the plan actually reviewed. `--expect-plan` can optionally select that ID, but no plan hash is mandatory.

## Commit without more inference

```sh
inkos chapter replay-state BOOK_ID --commit --plan /private/replay-27-to-30.json --expect-plan REVIEWED_PLAN_ID --json
```

Commit performs no model calls. It reacquires the same book lock, checks the optional selected plan ID, actual retained authority/checkpoint inputs, chapter identities and text, baseline contents and full contiguous coverage, then re-reduces the deltas on the host. If a selected input changed after dry run, it rejects the plan; prepare a fresh one rather than overwriting newer state. Unrelated Work changes do not require a whole-Work digest.

The existing Work source-sync and journaled atomic file set commit one set of:

- Four canonical state JSON files and the three generated truth Markdown projections
- Correct structured snapshots and their truth projections for every replayed chapter
- A per-chapter validation receipt carrying its chapter number, baseline and ordinary plan ID
- Chapter index validation observations only; counts, titles, provenance and original timestamps stay unchanged
- Normal Work artifact/revision bookkeeping for those derived changes

Original prose paths and bytes are never in the write set. Only the exact state failure codes `state-validation-unavailable`, `state-validation`, `state-sync-required`, and `state-reconciliation` are replaced for replayed chapters; other observation codes and unrelated quality findings are preserved. Replacement of those four codes does not distinguish older revision/text targets within that chapter. Fresh validator observations are scoped to the replayed chapter. Validation success does not silently resolve contradictory prose.

A file-system error while applying the transaction rolls the entire touched file set back. On abrupt process termination the existing atomic transaction journal is recoverable; dead-owner journals are handled by the normal recovery path, while the book lock coordinates live writers. The transaction is recoverable atomicity for participating writers, not a single-filesystem-operation snapshot for unlocked readers. The book lock coordinates Inkos writers; external editors that ignore it must remain idle during replay and commit.

After success, independently check the canonical manifest and every new snapshot's chapter number, the chapter index observations, and the original chapter bytes. A second commit of the same plan is rejected because its baseline has changed. Goal resumption or daemon restart is a separate explicitly authorized operation after verification.

## Local verification (no real inference)

- `state-replay.test.ts`: frozen 27→28→29→30 sequence; misleading snapshot names; incomplete/duplicate/unindexed prose; typed host reduction; precise observation updates; model failures and cancellation; changed selected inputs; invalid plan order; lock exclusion; partial I/O rollback; symlink rejection
- `state-replay-runtime.test.ts`: real WriterAgent + StateValidatorAgent + host tools driven by a deterministic Codex transport fixture, proving the original runtime root is retained while manuscript data is isolated, without credentials or network inference
- Built CLI process test: commits a fixture-generated plan from local files without model configuration or authentication
- CLI tests: explicit dry-run/commit selection, optional selected plan ID, private new plan file, operator-selected placement, wrong-book rejection, model-free commit, failed-run cleanup

Mock and protocol fixtures prove the recovery mechanism, not semantic correctness of a real chapter projection. Actual book replay remains an explicitly authorized model-assisted operator action. A scoped PipelineRunner recovery hook exists for callers that supply a range and AbortSignal; ordinary Studio/Goal callers do not supply that optional scope, so their automatic recovery is not claimed.
