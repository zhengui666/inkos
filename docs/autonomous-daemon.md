# Persistent autonomous serial workflow

This candidate connects calendar scheduling, saved market evidence, local original-book creation, fixed chapter goals, review/repair and publication reconciliation. It still requires live deployment acceptance. An authenticated author preview, a cached chapter count or a single anonymous response is not sufficient to establish current public availability; inspect the canonical reader and exact chapter body independently.

## What the daemon persists

The existing `.inkos/harness.sqlite` retains calendar deadlines, daily chapter reservations, selected market concepts, foundation creation, chapter stages and events. `inkos up` acquires one live project owner. A dead process can be recovered without deleting retained jobs or resetting attempt budgets. New owners also hold an exclusive SQLite transaction in `.inkos/harness.sqlite.daemon-lock` for their lifetime. This separate local sidecar does not block ledger writes and is released by the operating system after a crash or reboot. A reused PID therefore cannot indefinitely block recovery or authorize taking over a live locked owner. The sidecar is resolved from the canonical ledger path, so directory aliases share the same lock. Never delete or replace it while a daemon is running. Use a local filesystem with working SQLite locks, as required by the existing ledger. Stop pre-upgrade daemons before upgrading: legacy owner records still use the conservative PID check because those processes do not hold the new lock. `inkos down` requests cancellation through the project ledger without signalling a PID from a stale file, lets in-flight effects settle, and confirms exit before removing the PID file. It does not send a forced kill or infer successful shutdown from sending a signal.

Schedules use five-field numeric UTC cron (wildcards, lists, ranges and steps). Missed ticks coalesce; restarting does not reset an existing future deadline. A bounded worker pool processes active/outlining books with complete foundations. Paused/completed/dropped books remain untouched. Foundations still being created are excluded until ready. `--work` or `daemon.workIds` is a strict work allowlist, including previously auto-created works. New local foundation creation requires explicitly enabled automatic creation and no work allowlist or fixed publication bindings; otherwise the saved scan remains available with a visible selection blocker.

Admission priority follows each work's last durable chapter reservation, so quota-exhausted ticks and process restarts do not repeatedly favor the same book. Short metadata/admission steps are serialized in that order; chapter and provider execution retain the configured bounded concurrency. A paused retained foundation is skipped without consuming an attempt or blocking other eligible foundations or a due radar scan. Retried foundations use current book settings rather than restoring an old configuration snapshot.

The daily cap reserves capacity transactionally before writing, including across processes and restarts. A pending prior-day writing reservation consumes current-day capacity before it resumes, without changing its chapter or Goal identity. A write already in flight at midnight remains charged to its starting day; this is an admission cap, not an assertion that all final persistence happens before midnight.

The cap is project-wide, not a separate budget for each work, and is not a daily token or spending limit. Existing `chaptersPerCycle`, per-chapter Goal deadlines and attempt/review budgets retain their meanings. Original long-form book creation and daemon writing currently support `zh` and `en`; the generic platform string and registered publisher interface do not establish support for arbitrary languages or real automatic submission on unimplemented platforms.

Each writing request uses the existing ChapterGoalService for one fixed chapter number. It reconciles retained prose/revisions/state before retrying, so a lost response or notification error cannot mean "write the next chapter again." The same Goal and its attempt budget survive restart. Transient provider/worker timeout retries require positively confirmed absence, have a maximum of three attempts, and use exponential delays capped at one minute. Active owners are not stolen; the existing finite Goal deadline bounds waiting.

## Review before publication

An accepted writing Goal means persisted prose and settled state, not publication approval. The daemon calls the native reviewer for the exact current revision under the existing book lock, and retains a revision-bound review receipt. Empty index observations alone are not approval. Audit attempts and the one source-scoped `spot-fix` budget survive edits, cancellation and restart; an interrupted repair is read back and re-reviewed before any possible continuation. Unresolved review/state findings preserve the manuscript and block that chapter. No numeric AI-detector score, silent model downgrade or generated review fixture certifies literary quality.

The accepted revision is retained. Package preparation locks the same work and verifies that the current source still matches that reviewed revision. New user edits therefore cannot inherit approval for an older draft. The original source is not overwritten by publication preparation.

## Market research and local creation

`daemon.market` can specify `platform`, `language`, `maxSourceAgeMs` and optional `autoCreate` with `maxActiveBooks`, `targetChapters` and `chapterWordCount`. The ordinary config command supports these fields. Results retain host-owned source URLs, acquisition time, language and live/snapshot provenance. Creation stops when source evidence is missing, unrelated to the target language, expired or unsupported. Ranking information is reference data; model prompts explicitly request original concepts and forbid copying benchmark plot/characters/prose.

MegaNovel's actual HTML parser and HTTPS source are available through explicit `liveMegaNovel` configuration. It is not enabled by default. Applicable platform authorization is an operational prerequisite. User-reported permission retains that provenance and is not represented as independently verified platform documentation. A single retrieved ranking page is not two scheduled live observations.

Selection is persisted before `PipelineRunner.initBook`, with a fixed Work ID and original concept. Interrupted foundation creation resumes the same ID with at most three attempts. An existing unfinished local serial consumes the active-book allowance, and repeating the same selected concept does not generate another Work.

Local creation does not create the platform's book. Fully automatic new-series launch still requires the actual remote Create Story metadata workflow and its readback. The chapter adapter currently needs an existing platform book binding. This remains a full-chain implementation gap, not a claim that the whole unattended launch task is complete.

## Publication and historical migration

`inkos up --publish-config PATH` loads explicit per-work publisher bindings. The versioned JSON format is `{ "version": 1, "bindings": [...] }`; each binding contains `provider`, `workId`, `targetId` and provider-specific `configuration`. Each work selects exactly one existing target; duplicate works/targets and unknown providers fail before any transport opens. The old MegaNovel array remains supported. To migrate an element, move its `workId` and `targetId` to the binding, set `provider` to `meganovel`, and place its remaining fields in `configuration`.

Only the existing MegaNovel driver is automatic in the default registry. `manual`, `fanqie`, `qidian`, `qimao`, `goodnovel` and `dreame` fail with `PUBLISHING_MANUAL_REQUIRED`; use the existing `inkos publishing prepare` and manual receipt workflow instead. An export or user-reported receipt is not verified publication. Applications may register a typed factory with explicit target identity and provider configuration; JSON cannot load arbitrary provider names as modules. Before startup and every delegated ready/publish call, the router checks the retained target's work, platform, account label and remote book identity. Drivers remain responsible for actual account readback and durable reconciliation of unknown outcomes; the router never retries, falls back to another destination, or promotes pending to published. Synthetic multi-provider tests verify this protocol, not other platforms' DOM or live publishing capabilities.

Without that option the CLI identifies its mode as reviewed writing only. A MegaNovel binding names the Work, existing local publishing target, stable visible account/book IDs, actual browser target, truthful AI declaration and an existing loopback CDP endpoint. The built-in `dom` configuration supplies the calibrated implementation; an optional `domBindingModule` is supported for explicitly supplied alternatives, but both cannot be selected together. No debugging port, profile, login or new persistent credential is created. Missing transport/DOM deployment is an error before new writing for that destination.

The configured `firstNewChapter` distinguishes existing author-operated chapters from new autonomous chapters. Every known historical identity must be below this boundary; duplicate remote IDs and mismatched DOM identities are rejected. Independently retained attempts are reconciled even when they fall outside that initial boundary, so changing a local label or boundary cannot bypass uncertainty. Set this boundary to the next chapter that has never been submitted through the author portal. Known historical IDs can direct independent detail readback despite stale listing caches; keep these deployment identities in the private binding configuration.

Historical chapters use their original target/package if one exists, and read-only reconciliation. A known ID is retained in an unknown reservation until the reopened remote detail verifies title, body and status. It is not automatically a publication receipt. An empty Untitled/Unpublished placeholder is not a saved chapter. Missing a row from a cached directory never authorizes re-uploading historical chapters.

When an explicitly identified canonical replay is still pending, the optional `requiredStateReplay: {chapterNumber, planId}` setting requires its exact successful existing commit receipt before new writing or submission. This is a deployment-specific read-only gate: it does not create a receipt, commit a plan, infer settlement from a latest-chapter count, or impose a new replay requirement on other books.

New publication freezes TXT only. A draft or submission mutation reserves uncertainty first; unknown outcomes are readback-only across restart. `submitted`/`reviewing` is distinct from `published`. The next chapter for that book waits for the current publication readback. Pending publication is polled at `publicationPollMs` (default 15 minutes). Each read is deadline-bound; the reservation remains pending until a verified terminal result, an author pause/cancellation, or a login/authorization blocker. An arbitrary number of pending observations is not failure and never resets the reservation to authorize another upload.

The status and event log are available through `inkos daemon-status --json`. A blocked state contains the original error; it is not a successful publication, contract or income claim.

## Remaining acceptance work

The native candidate's deterministic tests cover scheduling, persistent quotas, real child-process crash recovery, fixed chapter receipts, pause/cancel boundaries, review races, frozen-package adoption and unknown publication outcomes. Model and remote browser ports are synthetic in those tests. Focused tests do not replace a complete official dependency installation, build, typecheck, repository-wide tests and browser E2E against the exact proposed version. Refer to the pull request's current CI results for the latest automated validation status.

The native DOM implementation is included, but real deployment still needs a logged-in dedicated session reachable by the InkOS process, official full build validation, one authorized product-driven chapter readback, repeated invocation/restart without duplicate, and observations across two natural scheduled cycles. Remote new-book creation must also be implemented and verified before claiming automatic topic-to-new-series publication.

## Host supervision

`inkos up` is a foreground service process. An executor's PTY is not a durable deployment. `scripts/inkos-daemon.service.example` is an uninstalled user-service template for a host that already supports systemd user services. Fill its actual validated Node, CLI, project and private binding paths only after build and live prerequisites pass. Install/enable it through the authorized host's normal service workflow, and verify the user-service status and a genuine restart. The template does not change boot/login policy, enable lingering, create an account or start Chrome. A machine that sleeps or goes offline cannot supply continuous execution.

Use `inkos down` for a requested stop. It targets the current ledger owner rather than sending a signal based only on a PID file; a new owner clears the previous stop request. Legacy processes without a ledger identity are reported as unconfirmed, not killed. Normal SIGTERM from an established host supervisor remains supported and drains before release.

## Ownership recovery acceptance

After applying this change to the exact reviewed source, run the official install and checks:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
pnpm --filter @actalk/inkos-core exec vitest run src/__tests__/scheduler-store.test.ts src/__tests__/scheduler-owner-recovery.test.ts src/__tests__/scheduler.test.ts
pnpm verify:publish-manifests
```

The ownership regressions use temporary projects, real SQLite locks and disposable child processes. They cover a killed owner whose retained PID is reused by an unrelated live process, live-owner exclusion even with a stale ledger PID, unchanged Goal/quota/deadline recovery, ledger stop access, safe legacy upgrade, failed claims, failed cleanup and path aliases. They perform no model calls, browser login, book creation or publication.

For host deployment, stop the existing supervisor through its established service workflow, confirm the old process has exited, then replace the validated source and restart that same service. On a host already using the supplied systemd user unit, the commands are `systemctl --user stop inkos-daemon.service`, `systemctl --user start inkos-daemon.service`, `systemctl --user status inkos-daemon.service`, and `journalctl --user -u inkos-daemon.service --since "10 minutes ago"`. Use the actual installed service name; these commands do not install a service or authorize starting writing/publication. Do not delete a retained owner row or sidecar to force recovery. A live legacy PID mismatch requires operator verification.

A green temporary-process regression establishes the ownership mechanism only. A production supervisor restart, two natural source/writing periods and continuous 24-hour operation still require separate acceptance with the authorized work allowlist and live prerequisites. Do not use a crash test against an in-flight production submission.

## Studio and supervised-daemon lifecycle

Studio's Start action honors the saved daemon work allowlist, market settings and
publication polling interval. Start returns success only after the core scheduler
has acquired ownership. Concurrent starts, an external CLI owner, or a stop still
draining return a conflict; no second owner is started. Stop waits for in-flight
work to settle before reporting stopped. A stop during configuration cancels that
startup. A failed drain is visible and does not admit a replacement.

The Studio daemon status has an explicit `scope: "studio"` and lifecycle `phase`.
It describes the scheduler started by that Studio process. It is not proof that a
separate CLI daemon is stopped. Use `inkos daemon-status --json` and the installed
host service status for a separately supervised daemon. Studio does not reload or
restart its in-memory daemon after a Studio process restart. A persistent writing
service must therefore run the built CLI `up` entry as its own supervised process,
with the approved project, work allowlist and publication configuration. Keep
Studio as a separate UI service; do not press Start Daemon while the CLI service
owns the project. Studio alone does not establish unattended operation.

Standalone Studio now handles SIGTERM/SIGINT by refusing new daemon starts,
draining its own scheduler, closing its event streams and disposing its account
connection. This lifecycle change does not promise recovery or graceful completion
of every unrelated foreground Studio request. The CLI service template uses
`KillMode=mixed` so the main process receives SIGTERM first; remaining children are
terminated when its configured stop deadline is reached. A forced termination is
not successful drainage. Inspect retained jobs before restarting an uncertain
publication; never clear ownership records to make a service appear healthy.

Deployment acceptance must record the actual Node/CLI paths, project root,
service unit, work allowlist, existing model identity/budget and explicit writing
versus publication scope. Do not install or enable a template, enable user linger,
change sleep policy, create credentials or open a debugging port as a side effect
of a software update. An authorized operator must separately approve and verify
those host prerequisites. A template syntax check and a synthetic natural-minute
process test are not a production supervisor or 24-hour acceptance result.

## Reproducible isolated process checks

After `pnpm build`, run `node scripts/verify-daemon-runtime.mjs /tmp/inkos-runtime-evidence.json`.
This opt-in smoke test initializes an isolated temporary project, launches the real
CLI and waits for real minute boundaries. Only the model-facing Agent methods are
synthetic; scheduler ownership, fixed Goals, chapter persistence and child-process
lifecycle are the product implementation. It checks a competing owner, a killed
writer recovering the same Goal/deadline, two natural minute cycles and a delayed
SIGTERM drain. It leaves the temporary project and JSON receipt for inspection.
No production config, provider credential or remote platform is loaded. These
synthetic chapters are not evidence of model or literary quality.

`node scripts/verify-studio-shutdown.mjs` starts the compiled standalone Studio
server in another isolated project. It keeps a real HTTP event stream connected,
starts the real scheduler with an empty work list and future deadlines, and checks
that SIGTERM closes the stream and releases ownership before normal process exit.
Neither check installs or verifies an OS supervisor or establishes 24-hour uptime.
