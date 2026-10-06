# Persistent autonomous serial workflow

This candidate connects calendar scheduling, saved market evidence, local original-book creation, fixed chapter goals, review/repair and publication reconciliation. It still requires live deployment acceptance. An authenticated author preview, a cached chapter count or a single anonymous response is not sufficient to establish current public availability; inspect the canonical reader and exact chapter body independently.

## What the daemon persists

The existing `.inkos/harness.sqlite` retains calendar deadlines, daily chapter reservations, selected market concepts, foundation creation, chapter stages and events. `inkos up` acquires one live project owner. A dead process can be recovered without deleting retained jobs or resetting attempt budgets. New owners also hold an exclusive SQLite transaction in `.inkos/harness.sqlite.daemon-lock` for their lifetime. This separate local sidecar does not block ledger writes and is released by the operating system after a crash or reboot. A reused PID therefore cannot indefinitely block recovery or authorize taking over a live locked owner. The sidecar is resolved from the canonical ledger path, so directory aliases share the same lock. Never delete or replace it while a daemon is running. Use a local filesystem with working SQLite locks, as required by the existing ledger. Stop pre-upgrade daemons before upgrading: legacy owner records still use the conservative PID check because those processes do not hold the new lock. `inkos down` requests cancellation through the project ledger without signalling a PID from a stale file, lets in-flight effects settle, and confirms exit before removing the PID file. It does not send a forced kill or infer successful shutdown from sending a signal.

Schedules use five-field numeric UTC cron (wildcards, lists, ranges and steps). Missed ticks coalesce; restarting does not reset an existing future deadline. A bounded worker pool processes active/outlining books with complete foundations. Paused/completed/dropped books remain untouched. Foundations still being created are excluded until ready. `--work` or `daemon.workIds` is a strict work allowlist, including previously auto-created works. New local foundation creation requires explicitly enabled automatic creation and no work allowlist or fixed publication bindings; otherwise the saved scan remains available with a visible selection blocker.

The daily cap reserves capacity transactionally before writing, including across processes and restarts. A pending prior-day writing reservation consumes current-day capacity before it resumes, without changing its chapter or Goal identity. A write already in flight at midnight remains charged to its starting day; this is an admission cap, not an assertion that all final persistence happens before midnight.

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

`inkos up --publish-config PATH` loads explicit MegaNovel browser bindings. Without that option the CLI identifies its mode as reviewed writing only. Each binding names the Work, existing local publishing target, stable visible account/book IDs, actual browser target, truthful AI declaration and an existing loopback CDP endpoint. The built-in `dom` configuration supplies the calibrated implementation; an optional `domBindingModule` is supported for explicitly supplied alternatives, but both cannot be selected together. No debugging port, profile, login or new persistent credential is created. Missing transport/DOM deployment is an error before new writing for that destination.

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
