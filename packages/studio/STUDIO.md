# Studio durable workbench

## Design contract
Mission: edit durable works and revisions, inspect native execution, and manage independent distribution targets without making the browser an execution owner.

Keep the existing warm parchment / oxblood ink palette, literary serif headings, system UI sans and monospace data. Use the existing `--background`, `--card`, `--primary`, `--muted-foreground`, `--border`, `--destructive`, `--ring` tokens; success is muted forest green and attention is ochre. Spacing follows 4/8px steps; panels use 12px radii and controls 8px. Entrances use a short overshooting easing with a 32ms list stagger; hover/press feedback is immediate; reduced motion removes entrances.

Do: stable minmax grid tracks; readable revision IDs; visible focus; explicit empty/error/unconfigured states; separate creation from publishing; show raw professional domain data without discarding fields. Don't: marketing sections, kernel selectors, automatic fake model output, local execution ledgers, replay submissions after reconnect, or stop tasks on disconnect.

Assumptions: English is the interface language; work locales accept any Intl locale. Profiles and publishers can come from official extensions. Text-file import saves a real artifact revision; binary/reference material ingestion accepts runtime file paths or URLs. Runtime owns OAuth flows, models, secrets, task state, and SQLite. A missing provider remains explicitly unconfigured.

## API
`startStudio(rootDir, {port?, host?}) -> Promise<{url, server, close(): Promise<void>}>` is exported by `src/api/index.ts` and `src/api/server.ts`. Default host is `127.0.0.1`, default port is 4567; port 0 is supported. `close()` closes only Studio and event subscriptions, not the project runtime.

`createStudioApp(client, {staticDir?}) -> {app, disconnect}` assembles six thin Hono route modules against one connected RuntimeClient. `GET /api/v1/status` (also POST) forwards `status`; `GET /api/v1/events?conversationId=N` forwards runtime SSE (snapshot, changed, taskGraph, agentEvents). Disconnect aborts only the watch. `POST /api/v1/<RPC dots replaced by slashes>` forwards the named RPC with request JSON as params and returns its unwrapped native result. Namespaces: works, creation, tasks, conversations, submissions, artifacts, materials, work, publishing, models, plugins. Shorthand routes `/produce`, `/login/{start,status,respond}`, `/logout` forward `creation.produce`, `models.login.{start,status,respond}`, `models.logout` respectively. No arbitrary-RPC endpoint; no Studio persistence.

Standalone: `INKOS_PROJECT_ROOT=/path/to/project INKOS_STUDIO_PORT=4567 tsx src/api/index.ts`. `INKOS_STUDIO_HOST` optionally overrides the bind host. Packaged files are served from `dist`; there is no startup auto-build. Importing the package does not start a server.

## Checks
Run `pnpm build`, `pnpm typecheck`, `pnpm test`, `pnpm test:flows` and `pnpm --filter @actalk/inkos-studio test:e2e`. E2E uses real Studio/runtime in a scratch project: offline notes, imported revisions, native production scheduled in the future, professional graph/translation data, account targets, materials and read-only refresh. No model or remote publisher calls and no SDK mocks are used. `INKOS_BROWSER_EXECUTABLE` can select installed Chrome; the runner stops its own services.

Actual local verification and live-chain gaps are recorded centrally in [delivery.md](../../.opensdlc/delivery.md). Model creation and MegaNovel live acceptance remain unconfigured/unexecuted.

Publisher capabilities come from installed official extensions, not user-entered capability overrides. SDK `faulted` tasks are terminal and expose native recovery rather than enabled pause/cancel controls.
