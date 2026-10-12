# InkOS — durable architecture

## Accepted scope

InkOS remains a three-package, single-project content creation and independent distribution platform: core, CLI, Studio. The [approved goal](../.pi/goal/inkos-durable-深度重构-完整实施与本地验收-20261012-0946.md) and [design source](../.pi/plan/inkos-深度重构-以-pi-durable-为唯一内核的无人值守创作与发布平台-20261012-0058.md) are authoritative. Baseline: `42f9f7ba42d010944a89e1aba2babbbd4ad4e491`; delivery branch: `refactor/durable-platform-20261012`. No live model/account operations, production migration/deployment, push, merge or publication are authorized.

## Components and flow

- `core/runtime`: the project Harness/SQLite owner, pi-ai models/credential storage, official extension loading, MCP connections, local RPC/SSE and native event projections.
- `core/works`: domain Documents, plans/professional state, stable file versions and separate creation/distribution progress.
- `core/extensions/fiction`: profile-driven native content and production tasks, optional planning, review reuse and necessary bounded revision. Other extensions retain research, materials, media, exact editing and exports.
- `core/publishing`: account/target domain records, stable `(targetId,artifactId)` distributions, independent native tasks and intent/observation semantics.
- `core/migrations`: read-only legacy readers and repeatable destination imports. Old model history becomes readable history/business steps, not a resumed old executor.
- `cli`: command/TUI clients of RuntimeClient; `studio`: a Hono assembly server, six domain route modules, read-only native projections and authoring UI. Neither owns execution SQLite.

SOP: author brief → optional research/planning → compose/edit → profile review and only necessary revision → save stable artifact/domain state. Save atomically derives separate enabled-target distribution tasks; later creation, exports and targets proceed independently. A publishing target is not required for creation. Novel memory belongs to its profile; script scenes, storyboard shots, StoryGraph, Play entities/events and translation alignment/glossary remain professional data rather than novel chapter stores.

## Ownership and recovery

Execution data lives in `.inkos/durable.sqlite`. Official pi-durable owns conversations, Submissions, task trees, recovery, context compaction, retries, abort, waits and usage. Domain Documents own author plans, professional memory, artifact references, pause intent, target identity and external-operation records. Large text/images/attachments use stable version files under `.inkos/artifacts/`.

One project has one runtime process. InkOS reuses an exclusive SQLite sidecar lock (`.inkos/runtime-owner.sqlite`); the SDK is not claimed to provide cross-process locking. CLI, TUI, Studio and `up` share the project endpoint. Distinct roots can run independently.

File persistence and SQLite are not one distributed transaction. Atomic file writes and stable revision IDs let interrupted steps adopt saved files; native checkpoints resume the remaining steps. Pause is persisted business intent at boundaries/document watches; cancellation is native abort. Client disconnect never cancels work. Admission request mappings identify requests only, use separate operation namespaces and are not another lifecycle ledger.

Review results are keyed by immutable revision/policy ID. Suggestions do not block; provider failures retain drafts without interpreting failure as a prose defect. Budgets are checked before model calls, not before saved-revision adoption. Author plan changes affect subsequent relevant steps, not already saved manuscripts. Profile parsers can be supplied by external Extensions without a core enum change.

## Independent external operations

Each enabled target consumes the saved ArtifactRevision in an independent task. Edits do not create duplicate logical distributions or implicit republication; established content requires explicit update. Submitted/reviewing/published, user-action and uncertainty remain distinct. Buffer quota counts content not accepted by all enabled targets, not lifetime chapters; calendar parsing uses cron-parser and durable native sleep/document watches, not a scheduler. Invalid retained target cadence fails that target, not content saving or other targets.

The generic browser and MegaNovel extensions share creation/metadata/cover/first-chapter/continuation/submission/observation semantics. Create-work, publish and update capabilities are separately declared by installed extensions. Browser sessions belong to target/account, with persistent profiles or configured official Playwright MCP connections. pi-mcp and Playwright MCP provide transport and browser engine; there is no handwritten generic CDP/MCP stack. Fanqie is not advertised as implemented.

Remote side effects are **not exactly-once**. Persist exact operation intent before mutation; observe uncertain outcomes before considering retry. Remote identity and full retained revision are business context, not invented proof. A proven not-occurred outcome can retry; login/captcha/real-name/payment/new-contract actions suspend only the affected distribution with evidence and resume/observe entry points.

## Removal and packaging decisions

Use published pi-durable, pi-ai, chord and pi-mcp **1.1.0**, Node **≥22.19.0**, and pnpm **11.3.0**. Native pi-ai model providers, API keys, OAuth and model routing remain available; removing Codex App Server does not ban the SDK's native OpenAI/Codex model provider.

Physically remove the old Agent/Codex execution stacks, dual-kernel selection/compatibility, legacy authentication owner, scheduler/leases, Goal/Episode/Creation execution stores, transcript recovery, duplicate capability registration and Studio request/task ledgers. The final deletion list contains **840 old tracked source/test files** (578 core, 48 CLI, 214 Studio), while useful deterministic domain modules/tests and static craft references are retained. Legacy schemas are read only in migration code; no old executor is restarted or dual-written.

Old install bundles, synthetic runtime preload, manifest rewriting, duplicate release proofs, stale gates/specifications and conflicting operational docs were removed. pnpm natively converts workspace dependencies during pack/publish; one clean three-tarball install smoke replaces the old proof chain. CI runs build, typecheck, domain/flow/browser tests and this smoke; release reuses CI and publishes in dependency order. Neither hosted CI nor release publication was executed by this local task.

Only `.opensdlc/architecture.md` and [delivery.md](delivery.md) are workflow documents. Current user operations are in [docs/runtime.md](../docs/runtime.md) and the CLI reference. Existing `.pi/plan/`, historical changelogs, original databases/manuscripts and unrelated user files are preserved. No checksum/freeze/approval layering or fake SDK/model/site success is added.

## Observed verification

Executed engineering commands, behavioral evidence, migration guidance and the deliberately incomplete live chain are recorded in [delivery.md](delivery.md). Local SDK/filesystem/process/browser checks are not claims of literary quality or real platform publication.
