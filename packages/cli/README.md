# InkOS 2 runtime client

Requires Node **22.19.0+** and built `@actalk/inkos-core` / `@actalk/inkos-studio` packages. Build this package with `pnpm --dir packages/cli build` after those packages have been built; the CLI build does not rebuild core.

Every command accepts global `--project <directory>` or `--root <directory>`, before or after the command. The default is **cwd**, not a recent Studio project. Files supplied with `--file` are relative to cwd. Business operations use `RuntimeClient.connect()` and RPC; the CLI never opens a Harness, database, model adapter, or scheduler.

## Lifecycle

```sh
inkos init [directory] [--lang <locale>]
inkos up [--no-studio] [--port <number>] [--host <host>]
inkos status [--json]
inkos down
inkos daemon start|stop|status
inkos daemon-status [--json]
inkos studio [--port <number>] [--host <host>]
inkos tui [--conversation <native-id>]
inkos events [--conversation <native-id>]
```

`init` is offline. `up` starts/connects the core-owned runtime, then starts a detached **CLI `studio` child** unless `--no-studio` is supplied. `studio` imports `startStudio(rootDir, {port, host})` from the Studio package only after connecting the runtime. Defaults: port 4567, host 127.0.0.1; port 0 chooses a free port. Runtime and Studio have independent PIDs.

`status` and `doctor` never start a runtime. `down` is the explicit project stop operation: `RuntimeClient.stop()` plus the CLI-owned Studio's project-local control endpoint. It does not send PID signals or stop an unspecified host/another project's service. Ctrl-C, TUI exit, and SSE disconnection detach readers only; background tasks keep running. `inkos` without a command opens the TUI.

## Works, plans, creation and tasks

```sh
inkos work list [--profile <id>]
inkos work create [title] [--title <title>] [--id <id>] [--profile <id>] [--locale <locale>] [--domain <json>] [plan options]
inkos work show <id>
inkos work update <id> [--changes <json>] [Work fields] [plan options]
inkos work pause|resume <id>
inkos work migrate [--source <path>] [--apply]
inkos goal list
inkos goal show|set <work-id> [plan options]
inkos goal create <work-id> [plan options]  # alias of set
inkos goal run <work-id> [--request-id <id>] [--wait]
inkos goal pause|resume <work-id>
inkos goal cancel <native-task-id>
inkos write [start] <work-id> [--artifact <id>] [--revision <id>] [--title <title>] [--instruction <text>] [--content <text>|--file <path>|--stdin] [--request-id <id>] [--wait]
inkos write next|produce <work-id> [--request-id <id>] [--wait]
inkos tasks list|tree
inkos tasks show|wait|pause|resume|cancel|abort <native-task-id>
```

Profiles are not a CLI enum: built-ins include fiction, short-fiction, script, storyboard, interactive-film, play, translation, article; extension profile IDs are passed through. A Work needs no publishing target or platform.

Plan options: `--plan <json>`, `--brief <text>`, `--serial` / `--no-serial`, `--units <number|null>`, `--needs-planning` / `--no-needs-planning`, `--review <json>`, `--production <json>`, `--backlog <number>`, `--cron <expression|null>`, `--next-at <ISO|epoch-ms|null>`. Review fields: `id`, `enabled`, `maxRevisions`, `maxCost`. Production fields: `backlog`, `cron`, `nextAt`. Omitted fields remain absent; the runtime merges changes into persisted state.

`goal` edits/executes the Work's native plan, not a separate legacy goal ledger. Work/task pause is domain pause; cancel is native abort. Creation accepts `content` only as an explicitly imported manuscript/manual edit, not a model script. Manual saves/imports are offline; creation with imported content and disabled review can also complete without a model. `--wait` inspects **`task.state.outcome.status`**, not `task.status`; failed/aborted outcomes exit nonzero. Without `--wait`, accepted tasks continue after the CLI exits. Migration defaults to preview; `--apply` retains the original source.

## Conversations and native authentication

```sh
inkos agent|interact [message...] [--message <text>|--file <path>|--stdin] [--conversation <native-id>] [--session <native-id>] [--work <id>] [--instructions <text>] [--model <json>] [--request-id <id>] [--when-busy steer|followUp|reject] [--note] [--no-wait]
inkos conversations list|create [--instructions <text>] [--model <json>]
inkos conversations show|abort <native-id>
inkos conversations configure <native-id> --changes <json>
inkos conversations note <native-id> <text> [--request-id <id>]
inkos submissions show|wait|abort <native-id>
inkos models list
inkos models set <provider> <model-id>
inkos models login <provider-id> [--type api_key|oauth]
inkos models logout <provider-id>
inkos plugins list
inkos plugins configure [modules...]
```

`agent` and `interact` share one submission path. `--note` uses `{type:'write', entry:{kind:'inkos.note',data:{text}}}` without model inference. Input uses a native `type:'input'` draft and a request ID. Use the same explicit conversation/request IDs for a deliberate retry; SSE reconnects never resubmit. Native entries, inbox, usage and agent documents remain owned by the runtime; there is no CLI transcript/session file or Codex/Pi backend selector.

Login only forwards native SDK prompts/events using `models.login.start/status/respond`; no CLI auth-store owner is implemented. Secret/manual-code inputs use hidden readline input and are not logged. Credentials are not CLI arguments.

TUI commands include `/new`, `/conversations`, `/use <id>`, `/note <text>`, `/works`, `/tasks`, `/write <work-id>`, `/pause|resume|cancel <task-id>`, `/work-pause|work-resume <work-id>`, `/abort` (current conversation), `/submission <id>`, `/models`, `/model <provider> <model-id>`, `/busy <policy>`, `/help`, `/quit`. Enter sends, Tab completes, arrows recall native user-input history, PgUp/PgDn scroll. Auth login is available in a separate CLI terminal.

## Artifacts, materials and publishing

```sh
inkos artifact read <id> [--revision <id>]
inkos artifact save <work-id> --title <title> [--artifact <id>] [--revision <id>] [--format <format>] --content <text>|--file <path>|--stdin
inkos import <work-id> --title <title> [same save options]
inkos artifact edit <id> --target-text <text> --replacement <text>
inkos export <artifact-id> [--format txt|md|epub|html|json|ink]
inkos materials ingest --file <path>|--url <url> [--title <text>] [--purpose <text>]
inkos materials query <query> [--limit <number>] [--purpose <text>]
inkos materials list
inkos publishing targets|list
inkos publishing create-target [id] --work <id> --publisher <id> --account-id <id> --account-label <label> [--remote-work <id>] [--browser <json>] [--metadata <json>] [--skill <text>]
inkos publishing update-target <id> --changes <json>
inkos publishing queue <target-id> <artifact-id> [--revision <id>] [--operation publish|update] [--scheduled-at <ISO|epoch-ms>] [--request-id <id>]
inkos publishing resume|observe <distribution-id>
```

Business commands support `--json`; most return the native RPC result as JSON even without it. `artifact` also has the alias `artifacts`, `materials` the alias `material`, and `artifact export` the same signature as top-level `export`. Read/export without `--json` output content/the export path. Publishing uses independent targets and distributions, not manual frozen packages or a CLI uploader.

## RPC surface and validation

The CLI depends on the fixed methods: `status`; `works.list/create/get/update/pause`; `work.migrate`; `creation.start/produce`; `tasks.list/get/pause/abort/wait`; `conversations.list/create/get/submit/abort/configure`; `submissions.get/wait/abort`; `artifacts.read/save/edit/export`; `materials.ingest/query/list`; `publishing.targets/createTarget/updateTarget/list/queue/resume/observe`; `models.list/set/login.start/login.status/login.respond/logout`; `plugins.list/configure`. Project stop is `RuntimeClient.stop()`. SSE consumes `snapshot`, `changed`, `taskGraph`, and raw `agentEvents`; reconnect uses `connect(root,{start:false})`.

Run `pnpm --dir packages/cli test:flows` after integration builds. Flows spawn the actual core dist runtime into temporary projects and use its SQLite/official SDK. They cover concurrent clients sharing one PID, all built-in profiles, imported revisions/export, domain pause/native abort, duplicate request IDs/passive notes, future distributions cancelled before any publisher contact, Studio/project-scoped shutdown, Ink input and read-only SSE reconnect. No flow mocks core success or uses a model/site. Pure tests preserve Markdown, locale, theme, composer/history and plan-parameter assertions. Legacy agent/scheduler/goal-ledger/host-auth fixture tests and unsupported direct-state command surfaces were removed.
