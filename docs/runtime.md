# Runtime operations and configuration

## Project ownership

`inkos init` writes a project configuration without starting execution. `inkos up` starts/connects the core runtime and, by default, a separate Studio client process. CLI, TUI and Studio use the same `RuntimeClient` RPC/SSE interface. `status` is read-only and does not start a stopped service. `down` explicitly stops this project's runtime and CLI-owned Studio; leaving the TUI/Studio only detaches readers.

The runtime owns `.inkos/durable.sqlite`. The reused exclusive SQLite sidecar lock in `.inkos/runtime-owner.sqlite` prevents a second process owning this project; this is InkOS ownership, not a claim that the SDK provides cross-process locking. Two different project roots can run independently. `.inkos/runtime.json` is the local endpoint; `.inkos/runtime.log` contains startup/operational diagnostics. Do not edit the execution database or run an old executor alongside it.

## Models and authentication

Use `inkos models list`, `models login <provider> --type api_key|oauth`, and `models set <provider> <model-id>`. API keys and OAuth follow the official pi-ai catalog and authentication flows, including supported OpenAI/Codex providers; removing Codex App Server does not ban those model providers. Login secrets are prompted, not passed as CLI arguments. Project credentials live in `.inkos/credentials.json` with owner-only file permissions.

`inkos.json` accepts a native project `model: {provider, modelId}` and `durable` Harness settings. Conversation configuration accepts SDK model references and routing through `conversations configure <id> --changes <json>`. New conversations inherit the project model unless explicitly configured. No `backend`, kernel selector or old `INKOS_LLM_*` override layer is used. Configure a custom provider through an official extension when it is not in the SDK catalog.

No model connection/generation was executed for this local delivery. Do not interpret catalog visibility or an unconfigured-model failure regression as a live inference check.

## Work plans and content SOP

Create a platform-free Work with title, profile, locale, brief and optional professional `domain`. The default finite goal is one content unit. `goal set <work-id>` and `work update <id>` merge relevant plan changes rather than rewriting saved artifacts.

```json
{
  "brief": "Author direction, source constraints and voice",
  "serial": false,
  "units": 4,
  "needsPlanning": false,
  "review": {"id": "author-intent-v1", "enabled": true, "maxRevisions": 2, "maxCost": null},
  "production": {"backlog": 3, "cron": null, "nextAt": null}
}
```

`units` is the author's target, not a mandated chapter count. `serial:true` keeps production open. `production.backlog` counts content not yet accepted by every enabled target (submission/reviewing releases accepted units; it need not wait for final approval). Finite platform-free production is not limited by a serial buffer. Cron parsing uses `cron-parser`; pacing and buffer waits are native durable sleep/document watches.

The official content task follows prepare → optional plan → compose → review → necessary targeted revision → save. Imported manuscript content bypasses compose inference. Disable review for a fully offline import. For model review, suggestions do not block; only contradictions/author requirements trigger configured necessary revisions. Reviews are keyed by revision and policy ID. Change the policy ID when changing its review meaning. A provider/model failure retains the saved draft; it is not a literary diagnosis and does not cause blind rewriting. Budget is checked before model calls, not before adoption of an already saved revision.

Pause persists `pauseRequested` and takes effect at a native step boundary. Cancel uses native task abort; explicit retry creates a new native task without reviving a terminal task. Closing an event stream does not cancel execution. Task graphs, outcomes, usage and conversation state come from the SDK, not a second status ledger.

## Artifacts, materials and media

Artifact revisions use stable IDs and files under `.inkos/artifacts/<work>/<artifact>/<revision>/`. Text and professional JSON remain readable; image/attachment reads expose a data URL. An interrupted step adopts an already saved revision instead of regenerating it. Exact text edits create another revision; historical revisions remain available. Export formats include text, Markdown, EPUB, JSON and profile-appropriate HTML/Ink.

Archive sources using `materials ingest --file <path>|--url <url>` and retrieve with `materials query <query>`. Bind selected material IDs to `Work.materialIds` with `work update --changes`. Source evidence is not new canon. Story/professional memory belongs in Work domain data; review results can carry established facts, summaries, character state and hooks.

The `media_generate` extension tool uses a configured official pi-ai image model or the retained thin `media` service (`service`, `baseUrl`, `api`, `model`, optional `endpoint`/`apiKeyEnv` in `inkos.json`). `api` is `images`, `responses` or `gemini`. It supports reference-image edits and stable file storage. Set credentials using the provider login or the configured environment variable; generation is not replay-safe. No cover/image call was performed in this delivery.

## Official extensions and skills

`inkos.json` accepts `plugins: ["installed-npm-module", "./local-extension.mjs"]`. Modules export an official `Extension` or a factory receiving `{rootDir}`. They can attach `profiles` or `publishers` descriptors; profile parsers add professional domain data without modifying a core enum.

```js
import { defineExtension } from '@earendil-works/pi-durable';
export default Object.assign(defineExtension({name: 'my.verse'}), {
  profiles: [{id: 'verse', label: 'Verse', format: 'text', countingUnit: 'grapheme',
    domainKind: 'verse', instructions: 'Follow the author’s verse form.',
    parseDomain: text => ({verse: text})}]
});
```

`plugins list` reports actual installed tools/tasks/profiles/publishers. `plugins configure` loads the specified modules and persists their configuration. Profiles count words or graphemes using locale-aware `Intl.Segmenter`.

Content skill guidance resolves, in order, `.agents/skills/<id>/SKILL.md`, `skills/<id>/SKILL.md`, then bundled skills. Override a built-in by the same ID, or add IDs to `work.domain.skills`. References are static craft resources readable with official coding tools. Skills do not create another execution framework. Built-in professional JSON parsers validate script scenes, storyboard shots, StoryGraph and Play entity/state structures.

Generic configured MCP connections also use official pi-mcp, with `inkos.json.mcp` entries defining stdio, HTTP or SSE connections. Do not add a custom MCP/CDP transport.

<a id="publishing"></a>
## Publishing

Create a target tied to a Work and a visible account ID. MegaNovel has a default entry URL; the generic browser path needs `config.entryUrl` (CLI `--metadata` may carry `entryUrl`, or set it directly in Studio). Publisher capabilities come from the installed extension, not CLI-provided claims.

```sh
inkos publishing create-target destination --work story --publisher browser \
  --account-id <visible-account-id> --account-label 'My test account' \
  --metadata '{"entryUrl":"https://authorized-site.example/author"}'
inkos publishing update-target destination --changes \
  '{"config":{"cadence":{"cron":"0 10 * * *","timeZone":"Asia/Tokyo"}}}'
inkos publishing targets
inkos publishing list
inkos publishing observe <distribution-id>
inkos publishing resume <distribution-id>
# Explicit update after editing an established artifact:
inkos publishing queue destination <artifact-id> --revision <revision-id> --operation update
```

Browser settings are target/account-scoped. Use a persistent `userDataDir`, optional `executablePath`/`headless`, or official Playwright MCP `args: ["--cdp-endpoint", "http://127.0.0.1:9222"]` for an existing connection. A configured `browser.mcp` can also connect to an existing MCP service. No tab target ID is required. Default profiles are project-local and account-specific; Playwright MCP owns the browser engine and protocol handling.

Automatic distribution directly consumes a content `ArtifactRevision` in its own native task. Each `(targetId,artifactId)` has one stable logical record. Editing does not auto-republish. Calendar errors are rejected on configuration; retained bad target cadence becomes that target's failure without rolling back content or other targets.

Shared business protocol covers discovery/create-work, metadata/cover, empty-work first chapter, continuation, submission/scheduling and observation. Both `browser` and `meganovel` connect to it; create-work/publish/update are separate capabilities. Fanqie is not a default implemented publisher.

Intention, exact retained revision, account/work identity and remote IDs are persisted before mutation. Unknown results require observation before retry; a proven not-occurred outcome can be retried. Submitted, reviewing, rejected and published are distinct. User-action evidence (login, captcha, real-name verification, payment or new contract) is retained and provides a resume/observe path for that distribution only. No automatic login, payment or contract acceptance is promised.

## Migration

`work migrate [--source <legacy-root>]` previews by default; `--apply` imports to this runtime. Preserve a backup and read conflicts before application. Migration keeps old databases/manuscripts, original work/artifact/version IDs where present, hidden historical bodies, binary assets, material references, configuration, readable model history, business progress and pause/cancel/completion intent. Existing current runtime owner/endpoint/log files are not imported as legacy sources.

Migration does not start model/browser tasks or old executors. Repeating an import does not duplicate works/tasks. Old model transcripts are readable history and business steps, not resumed native model runs. Valid remote identity mappings are retained; missing/conflicting identity disables the affected target with readable issues, and uncertain external operations remain observation obligations.

## Local versus live acceptance

Local checks and install smoke are documented in [.opensdlc/delivery.md](../.opensdlc/delivery.md). They exercise real official SDK, SQLite, files, processes and browser MCP without live model responses or platform accounts.

A real end-to-end chain remains **unconfigured and unexecuted**: generation → review/revision → MegaNovel create-work → first chapter submit → status observation → restart/non-duplication. It requires provider/model settings, a fee allowance, an authorized test account/work scope, and valid browser login/interactive conditions. Local DOM/protocol checks are not evidence of remote success.
