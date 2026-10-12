# Three-entry Studio and autonomous fiction production

<a id="task"></a>
## Task
**Task ID:** autonomous-fiction-studio
**Request:** Refactor the frontend to retain only Model configuration, Extensions, and Works & revisions; make ranking research, topic/title selection, web-fiction writing and publishing run unattended.
**Endpoint:** Implement and locally verify the generic extensible chain, update the local deployment, and start a real 24-hour run within the configured capabilities. No push, merge or package publication.

<a id="intent"></a>
## Intent and authorization
The user explicitly chose a generic extension-based implementation and authorized **real 24-hour model operation with unlimited budget** using the configured project model. Operational defaults communicated: one chapter per hour and periodic ranking refresh. No publishing target/account/remote-work scope has been configured; do not claim real publication or invent account mappings. Preserve existing work, manuscripts, credentials, task history and prior i18n/authentication fixes.

<a id="spec"></a>
## Requirements and design
- Exactly three top-level UI destinations; versions, native execution controls/status, distribution targets/receipts and required user actions belong to the selected work.
- Retain Chinese/English, model API-key/OAuth configuration, native extension capabilities, accessibility, mobile layout and reconnect-without-resubmission semantics.
- Add ranking-source extension descriptors and a configurable generic public-URL adapter; source data/evidence feeds original topic/title/novel-plan selection, not copied manuscripts or unsupported claims.
- Use official pi durable tasks/conversations, document watches and durable sleep for source refresh, topic/title preparation and continuous content SOP. Do not add another agent loop, executor, scheduler, browser/MCP engine, or execution ledger.
- Read assistant answers in the owned model conversation, rather than the parent task conversation. Current real generation succeeds but content task 40 faults with `Model step has no assistant answer` because its answer is in conversation 42.
- Continuous creation needs durable pacing and recoverable failures preserving stable saved revision identities; platform-free serial creation must not stop at a publishing backlog with no enabled targets.
- Publishing remains separately derived native target tasks consuming exact revisions. Unknown/user-action results must be visible in the work, not promoted to publication success.
- Real acceptance must observe actual generated artifacts and native status. A running service and shortened-clock/offline checks are not proof that a full 24-hour run or real publication completed.

<a id="plan"></a>
## Implementation plan
1. Reproduce/fix the real assistant-entry visibility defect and add scoped native-SDK regression coverage.
2. Add generic ranking descriptors, source acquisition, native autonomy task/configuration RPC and continuous production/title/recovery integration; reuse works/artifacts/publishing services.
3. Delegate only App, Models, Plugins, CSS and their separate translation dictionary. Parent owns Works, autonomy controls, integrated execution/publishing panels, backend, tests and docs.
4. Preserve meaningful backend/API assertions; replace standalone-page browser expectations with the requested three-entry/in-work behavior and run build/type/unit/native flow/browser checks.
5. Update the local instance, perform bounded real generation/source checks, then leave an explicitly time-bounded 24-hour native run. Report the observed start/output, scheduled end and any real source/account/publication blockers, not future success.

<a id="verification"></a>
## Initial findings (before implementation)
The existing project is now genuinely configured with `openai-codex/gpt-6.1-sol`, one English fiction work and prior model usage. All inspected existing tasks are terminal; production 38 failed after content 40 faulted. Conversation 42 contains real `pi.assistant` entry 53. TaskRuntime.entry is documented as visible only from the task's conversation. There is no ranking/topic/autonomy implementation or publishing target. User data is no longer an empty demo; it must be retained.

## Implemented and checked
- Exactly three Studio destinations. Searchable providers/current model and existing API-key/OAuth dialog retained; real installed profiles/publishers/ranking readers exposed. Works contain source configuration, timed-run progress, artifact versions, native recovery controls and target receipts. Chinese/English, unsaved edits, theme, mobile and passive reconnect are preserved.
- Child answers are read by exact entry ID through the owned conversation context. A real native storage regression confirms that parent `entry()` cannot see that child record; no successful model simulation is used.
- Generic `rankingSources` extension contract and the built-in public-page reader feed memoized genuine evidence into native topic/book-title/blueprint and chapter-title preparation. The work stores research/selection business data; native tasks own checkpoints, retries, waits and the persisted deadline.
- Model/source failures back off from five minutes up to one hour. Content recovery keeps artifact/revision identities and saved drafts. No enabled destination means no publication backlog wait. Autonomy creation and exact-revision publishing remain independent; no destination is invented.
- Node 22.19.0 / pnpm 11.3.0: three-package build/typecheck passed; 348 tests in 55 files, 71 native-flow checks in 11 files, and 17 browser cases passed. The concrete live-output format repair also passed 28 focused native checks. Logs are `autonomy-{build,types,test,flows,e2e}.log`, `autonomy-live-repair.log` and `autonomy-ui-final-types.log` under the session scratch directory. Vite bundle-size and Node SQLite warnings are informational.
- Public source checks: Royal Road, Scribble Hub and Webnovel returned 403; Qidian returned an empty 202 page; these were not counted as ranking success. `https://yomou.syosetu.com/rank/list/type/daily_total/` returned HTTP 200 with readable real daily ranking entries. The configured project model remains `openai-codex/gpt-6.1-sol`; the original work and all 13 terminal tasks remain untouched.

## Live verification
- Updated the designated local deployment at `http://127.0.0.1:4567`. Runtime PID 3416380 (native endpoint 43465); Studio PID 3416410. Original work metadata and all 13 prior task states compared equal after live verification. The selected real model remains `openai-codex/gpt-6.1-sol`; credentials were neither displayed nor copied into tests. Unrelated services on 4568/4576 were preserved; test ports 1455/4580 were released.
- Genuine model output exposed a further decoder mismatch: `brief` and `blueprint` arrived as structured objects. These fields are now retained completely as serialized plan text; empty plans and fabricated source evidence still fail. Recovery adopts completed owned model answers rather than regenerating a valid plan. Two paid selection attempts from before that repair remain in native history; no successful response or platform result was simulated.
- Real work `8ae0d3bb-1990-4fc2-8983-53f832cf8076`, **雾城验收簿**. Verification task 55 completed planning, chapter title, composition, review and save. Chapter 1 **桥上多了一级台阶**, 2,369 characters, immutable revision `e58bcc50-adc6-4856-84dd-0ea5a23d2d52`, remains unchanged with one revision.
- Native continuation task **127**, persisted deadline task **128**, use the existing story selection and the previously saved next-chapter time. Authorization window begins `2026-10-12T08:31:46.279Z`; the persisted deadline is `2026-10-13T08:31:45.282Z` (October 13, 16:31 UTC+8). The first verification is included in that window; restart/continuation did not extend authorization. Chapter interval is one hour after successful save; ranking refresh is every six hours. Model cost cap remains null as authorized.
- At `2026-10-12T10:02:42.836Z`, the run had autonomously generated and saved chapter 2 **湿灰不认主人**, 2,444 characters, revision `e35d5aa0-7bbb-4f4c-87ee-0dd65e06b9b0`. Task 127 was running in `schedule`, with no error; next chapter due `2026-10-12T10:53:59.891Z`. This is observed real unattended continuation, not a shortened-clock model simulation. Live metadata is in `autonomy-live-{run,artifact,final,chapters}.json` in scratch.
- Remaining unobserved outcome: full elapsed 24-hour completion. Remaining publication prerequisite: no legitimate account/target/remote-work mapping is configured (zero targets and zero distributions). Generic independent publishing is integrated and locally checked, but **no real publication is claimed**. The project/runtime must remain available for the scheduled run.

<a id="delivery"></a>
## Remote delivery authorization
The user requested a merge to remote `main`. Read-only inspection found that `origin` (`zhengui666/inkos`) has no `main`, defaults to `master`, and still points to `369ef6cc7216c788bf6f238baf4b3e1730620544`. The user explicitly selected **merge to the existing remote master** after this was clarified. The fetched remote master is an ancestor of the current work, and GitHub reports no branch protection or repository rulesets requiring a PR. Delivery will use a normal fast-forward push, preserving history; no force push, default-branch change, release tag, package publication or runtime restart is authorized or needed. Only the implemented source/tests/docs are included; original `.pi/`, live credentials, manuscripts and databases remain excluded. Local master and the baseline handoff reference are retained. Remote push and hosted CI are pending at this record's commit.
Fresh delivery packaging verification passed on Node 22.19.0 / pnpm 11.3.0: all three packages were packed and clean-installed, public ESM imports succeeded, installed CLI/runtime/Studio startup and shutdown passed, and an isolated author manuscript persisted with a single project owner. No live credentials/model or publisher operation was used. Log: `remote-merge-install-smoke.log` in session scratch. `git diff --check` passed before staging.
