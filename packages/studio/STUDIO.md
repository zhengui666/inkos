# Studio durable workbench

## Design contract
Mission: edit durable works and revisions, inspect native execution, and manage independent distribution targets without making the browser an execution owner.
The shell retains exactly three destinations: **Model configuration**, **Extensions**, and **Works & revisions**. Works contain the unattended ranking/topic/title/writing controls, revisions, native task recovery and independent target receipts. Legacy routes are read-only Works fallbacks. Provider search and configuration filters keep large catalogs compact.

Keep the existing warm parchment / oxblood ink palette, literary serif headings, system UI sans and monospace data. Use the existing `--background`, `--card`, `--primary`, `--muted-foreground`, `--border`, `--destructive`, `--ring` tokens; success is muted forest green and attention is ochre. Spacing follows 4/8px steps; panels use 12px radii and controls 8px. Entrances use a short overshooting easing with a 32ms list stagger; hover/press feedback is immediate; reduced motion removes entrances.

Do: stable minmax grid tracks; readable revision IDs; visible focus; explicit empty/error/unconfigured states; separate creation from publishing; show raw professional domain data without discarding fields. Don't: marketing sections, kernel selectors, automatic fake model output, local execution ledgers, replay submissions after reconnect, or stop tasks on disconnect.

Interface languages: Simplified Chinese and English; work locales accept any Intl locale independently. Profiles and publishers can come from official extensions. Text-file import saves a real artifact revision; binary/reference material ingestion accepts runtime file paths or URLs. Runtime owns OAuth flows, models, secrets, task state, and SQLite. A missing provider remains explicitly unconfigured.

The header language selector switches immediately and remembers the selection in browser local storage (`inkos-studio-language`). On first visit, Studio detects the first supported browser language, falling back to English. `src/i18n/` centralizes source-phrase dictionaries, interpolation and native Intl formatting. Shared components localize labels and statuses; raw manuscripts, identifiers, model instructions and external evidence are not translated. Switching language preserves unsaved form values and never resubmits work.

Model authentication uses a focused, scrollable dialog with native SDK prompts/events. Completion refreshes the provider catalog and closes the dialog; cancellation/Escape forwards `models.login.cancel`. The runtime owns the stable device UUID required by OpenAI OAuth, whole-flow/per-prompt aborts, credential writes and callback-server cleanup. No API key is returned in the login status.

Unattended operation uses named autonomy/ranking RPCs and installed ranking-source readers. Settings, acquired source evidence and original topic/blueprint are work business data; execution, waits, recovery and the persisted deadline belong to native tasks. See [Unattended fiction](../../docs/autonomous-fiction.md).

## API
`startStudio(rootDir, {port?, host?}) -> Promise<{url, server, close(): Promise<void>}>` is exported by `src/api/index.ts` and `src/api/server.ts`. Default host is `127.0.0.1`, default port is 4567; port 0 is supported. `close()` closes only Studio and event subscriptions, not the project runtime.

`createStudioApp(client, {staticDir?}) -> {app, disconnect}` assembles six thin Hono route modules against one connected RuntimeClient. `GET /api/v1/status` (also POST) forwards `status`; `GET /api/v1/events?conversationId=N` forwards runtime SSE (snapshot, changed, taskGraph, agentEvents). Disconnect aborts only the watch. `POST /api/v1/<RPC dots replaced by slashes>` forwards the named RPC with request JSON as params and returns its unwrapped native result. Namespaces: works, autonomy, ranking, creation, tasks, conversations, submissions, artifacts, materials, work, publishing, models, plugins. Shorthand routes `/produce`, `/login/{start,status,respond,cancel}`, `/logout` forward `creation.produce`, `models.login.{start,status,respond,cancel}`, `models.logout` respectively. No arbitrary-RPC endpoint; no Studio persistence.

Standalone: `INKOS_PROJECT_ROOT=/path/to/project INKOS_STUDIO_PORT=4567 tsx src/api/index.ts`. `INKOS_STUDIO_HOST` optionally overrides the bind host. Packaged files are served from `dist`; there is no startup auto-build. Importing the package does not start a server.

## Checks
Run `pnpm build`, `pnpm typecheck`, `pnpm test`, `pnpm test:flows` and `pnpm --filter @actalk/inkos-studio test:e2e`. E2E uses real Studio/runtime in a scratch project: offline notes, imported revisions, native production scheduled in the future, professional graph/translation data, account targets, materials and read-only refresh. No model or remote publisher calls and no SDK mocks are used. `INKOS_BROWSER_EXECUTABLE` can select installed Chrome; the runner stops its own services.

The historical refactor acceptance is recorded in [delivery.md](../../.opensdlc/delivery.md). Current three-entry and authorized real-run observations are recorded separately in [autonomous-fiction-studio/task.md](../../.opensdlc/tasks/autonomous-fiction-studio/task.md); a local UI test is not a completed 24-hour run or live publication.

Publisher capabilities come from installed official extensions, not user-entered capability overrides. SDK `faulted` tasks are terminal and expose native recovery rather than enabled pause/cancel controls.
