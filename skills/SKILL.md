---
name: inkos
description: Operate InkOS durable content creation, materials, editing, exports and independent browser distribution through the unified CLI/runtime.
---
# InkOS durable operations

Use the installed `inkos` CLI in the intended project (`--project <directory>` when needed). All clients share one project runtime; do not open execution SQLite directly or start another scheduler.

1. Inspect `inkos status`, `inkos work list`, `inkos tasks tree` and `inkos publishing list`. `status` does not start a stopped service.
2. Use `inkos init` for a new project, `inkos up` to start/connect and `inkos down` to explicitly stop it. Closing Studio/TUI or SSE only detaches viewers.
3. Create/update a Work with the author's locale, profile, brief and plan. Platforms are optional. Built-in profiles include fiction, short-fiction, script, storyboard, interactive-film, play, translation and article; external profile IDs are allowed.
4. Use `inkos write <work-id>` for native content tasks. `--file`/`--content` is an explicit manuscript input, not a scripted model result. `--wait` reports the native outcome. Reuse a request ID for the same deliberate retry; never resubmit on refresh.
5. `goal` modifies/runs the Work plan. Pause persists intent at native boundaries; cancel uses native abort. Preserve saved drafts on model failure. Do not impose fixed chapters, commercial templates or universal ending tests.
6. Preserve research provenance with `materials ingest/query`; edit exact selected text with `artifact edit`; export stable versions with `export`. Model/image calls need configured providers and fee authorization.
7. Distribution uses targets bound to a Work and account. Saving content derives independent target tasks. Submitted/reviewing/published are distinct; user-action or uncertain outcomes are not success. Use `publishing observe/resume` to recover; edits to submitted/published revisions require explicit `--operation update`.
8. `work migrate` previews by default; `--apply` imports legacy domain/history without modifying original databases/manuscripts or restarting old executors.

For precise flags, read `packages/cli/README.md` and `docs/runtime.md`. Model catalog/API Key/OAuth come from official pi-ai; capabilities and tasks come from official Extensions. Do not use legacy backend selection, manual publishing packages or old transcript/Goal ledgers.

Never claim local browser/protocol tests as real platform creation/submission. Live acceptance needs provider/model configuration, authorized test account/work scope, fee authorization and valid login conditions.
