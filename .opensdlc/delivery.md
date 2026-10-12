# InkOS — durable delivery

## Outcome and scope

The complete durable refactor and approved **local acceptance** are implemented on `refactor/durable-platform-20261012`, containing baseline `42f9f7ba42d010944a89e1aba2babbbd4ad4e491`. The [approved goal](../.pi/goal/inkos-durable-深度重构-完整实施与本地验收-20261012-0946.md) is authoritative. `master` remains `369ef6cc7216c788bf6f238baf4b3e1730620544`; the existing `.pi/plan/` has not been rewritten. No push/merge, npm publication, deployment, production migration, host-service changes or live model/account operation occurred.

Core/CLI/Studio now share one official durable runtime. Old execution and recovery ledgers were deleted, domain state converged into Documents, migration became repeatable/read-only for originals, and creation/distribution became independent. See [architecture.md](architecture.md) for component/removal decisions and [runtime operations](../docs/runtime.md) for the current SOP/configuration.

## Executed final checks

Final run on **2026-10-12**, using actual **Node 22.19.0**, **pnpm 11.3.0**, npm 10.9.3 and installed `/usr/bin/google-chrome-stable`. No model credentials or real site account were configured. Every command below returned exit code 0 on the delivered source; no zero-test or skipped-test acceptance is used.

| Command | Observed result |
| --- | --- |
| `pnpm install` | Passed; lockfile/current dependency installation succeeds. |
| `pnpm build` | All three packages passed, including client assets and server declarations. |
| `pnpm typecheck` | Core, CLI, Studio client/server passed. |
| `pnpm test` | **328 tests / 52 files**: core 162/28, Studio 30/7, CLI 136/17; no skips. |
| `pnpm test:flows` | **63 tests / 10 files**: core 51/7, Studio 4/1, CLI/TUI 8/2; no skips. |
| `pnpm --filter @actalk/inkos-studio test:e2e` | **8 real-browser cases passed**, including native budget-fault recovery; no mocks or real model/site calls. |
| `node scripts/install-smoke.mjs` | Packed core/Studio/CLI, installed all three tarballs with npm in a clean scratch directory, resolved public ESM imports, ran installed CLI init/up/write/down, read the persisted Japanese manuscript, started/closed installed Studio and checked the same runtime PID. Passed; temporary installation/services cleaned. |
| Source/installed-dependency audit and `git diff --check` | Passed: old execution SDKs/references absent, official four SDKs are 1.1.0, no whitespace errors. |

Full command logs are session scratch files `final-install.log`, `final-build.log`, `final-typecheck.log`, `final-test.log`, `final-flows.log`, `final-e2e.log`, `final-install-smoke.log`. Node 22's SQLite experimental warning remains informational. The e2e missing-extension error is an intentionally exercised visible failure state, not a failed test. Earlier failed/stale logs are not delivery evidence.

## Acceptance criteria, individually

All **12 contract criteria are met within their approved local scope**. This does not mark the deliberately excluded live chain as successful.

| # | Status | Observed evidence |
| --- | --- | --- |
| 1 | Met | Git ancestry contains the designated baseline; master and original plan preserved. Root/three package engines are ≥22.19.0; packageManager and CI pin pnpm 11.3.0. Installed production tree contains pi-durable/pi-ai/chord/pi-mcp 1.1.0, with no old pi-ai override. |
| 2 | Met | Source and installed-production dependency scans found no Codex App Server/Pi coding-agent, dual-kernel compatibility/auth owner or old execution ledgers. All production admissions use RuntimeHost/Harness; front ends use RuntimeClient. Native model catalog/API-key/OAuth and conversation model configuration remain exposed. |
| 3 | Met | `durable.flow.test.ts` and `runtime.flow.test.ts` use real SDK/SQLite/files/processes: native submission dedupe, reopen/read refresh, persisted pause, native abort, saved-revision adoption, SIGKILL → reopen → remaining-step completion, exact unchanged bytes/mtime and one saved write. SSE disconnection leaves tasks running; usage is native. |
| 4 | Met | Runtime flow: six concurrent clients share one owner, an actual duplicate service process is rejected, and two roots run independently. CLI/TUI flows and Studio backend/e2e/install checks observe the same project runtime rather than opening another execution database. |
| 5 | Met | Native profile tests cover platform-free Japanese content, finite completion/serial continuation, short/script/storyboard/Play/translation/article structures, saved plan changes, revision/policy review reuse, suggestions, retained drafts on real unconfigured-model failure and zero-budget saved-edit adoption. Original graph/material/search/edit/export assertions remain; actual EPUB and immutable file versions are checked. Media is retained through official image models/thin image service, not falsely live-validated. |
| 6 | Met | Real local official extension loading registers a tool, native task and external profile/parser. The archive task executes, survives SIGKILL, and completes; Japanese external profile content/parser executes without changing core enums. npm/local module resolution is implemented by the same official registry path. |
| 7 | Met | Creation/distribution flow checks two independent targets, retained reviewing/failure/user-action while later author content completes, direct revision-derived native tasks, stable logical IDs and non-republication after edits. Native buffer watch wakes on accepted submission; invalid cadence affects one target only; explicit update queued during prior observation is retained. |
| 8 | Met | Two actual installed pi-mcp/Playwright MCP checks discover real tools and perform DOM operations on about:blank/standard HTML. Thirteen local publishing business checks cover first chapter/create-work/update, account/remote identity, status distinctions and observation-first uncertainty. Generic and MegaNovel share implemented paths; no Fanqie default or custom transport. These checks are not real book/submission success. |
| 9 | Met | Fourteen migration tests use actual SQLite/files: original IDs, historical/hidden versions, materials/binary assets, seven layouts, YAML/config, readable history/progress/control intent, active remote mappings and uncertainty; repeat/concurrent/rollback/reopen cases remain idempotent. Actual host self-migration excludes its live owner/endpoint files and creates no execution tasks. Original source bytes are checked unchanged. |
| 10 | Met | Studio assembly plus domain routes, shared CLI/TUI service, no kernel selector, native tree/progress/model/extensions, professional data and explicit recovery. Eight real-browser cases check refresh, version edits, multiple targets, unconfigured/failed states, materials, pause/cancel/retry, keyboard focus and responsive layouts. README/SOP/skills/docs/CI/release now match the implementation; only two OpenSDLC workflow docs remain. |
| 11 | Met | All six named commands plus clean three-package installation smoke actually passed on the final source and minimum Node version. Tests use official SDK, SQLite, files, subprocesses and browser transport, with no fake SDK or successful model script. |
| 12 | Met | The unconfigured/unexecuted model and MegaNovel live gaps below are stated explicitly, separately from local acceptance. No fake page, offline check or interface declaration is used to claim remote success. |

## Migration procedure and preservation

```sh
inkos work migrate --source /path/to/legacy --json
inkos work migrate --source /path/to/legacy --apply --json
```

Preview is read-only. Apply imports domain Documents and stable destination files; original databases, manuscripts, hidden history, attachments and configuration remain. Repeating the same import does not duplicate works, conversations or tasks. Conflicts are readable and do not overwrite an unrelated destination work. Missing/conflicting account/remote identity disables the affected migrated target with issues. Unknown external operations remain observation obligations; user-reported success is not promoted to observed publication.

Old model transcripts are readable history and unfinished business steps, **not** seamless native model checkpoints. Migration starts no models/browser tasks or old executors and performs no dual writing. Only temporary projects were migrated for acceptance. The repository root has no newly created runtime database, and process inspection found no remaining task-created runtime, Studio/e2e or MCP service after verification.

## Deliberately incomplete real-world chain

**Unconfigured and unexecuted:** real model creation/review/revision, and real MegaNovel create-work → empty-work first chapter → actual submission → status observation → restart/non-duplication. No real model/image generation fees, login, account operation or platform work creation/modification occurred. Local business states are labelled retained local data, not remote observations; actual MCP protocol/DOM checks are not platform acceptance or a literary-quality result.

Subsequent live acceptance requires:

1. Authorized provider/model configuration and supported API Key or OAuth; any endpoint/routing settings needed for that provider.
2. A fee allowance for generation/review/revision and optional cover/image generation.
3. An authorized test account, designated test-work scope and explicit permission for create/submit/update/observe operations.
4. A valid target/account browser session and the conditions for any interactive login, captcha, real-name verification, payment or contract step. These become user actions, not automatic bypasses.

There is no remaining local engineering/environment blocker. Hosted CI/release, production migration/deployment and the live chain were not executed and are not claimed as verified delivery actions.
