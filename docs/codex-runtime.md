# Codex agent runtime and ChatGPT sign-in

InkOS uses the official `@openai/codex` **0.159.2 App Server** for the main
conversation agent, structured production workers, and semantic context
compilation. `@mariozechner/pi-agent-core` is no longer used. `pi-ai` remains for
standalone provider/image integrations and the existing durable message format.

## Set up

1. Install the workspace with Node 22.16+ and pnpm 9: `pnpm install`, then
   `pnpm build`.
2. Open Studio → Project settings → Codex.
3. Select **Sign in with ChatGPT**, open the official verification page, and enter
   the displayed one-time code there. InkOS never asks for a password or receives
   a password, access token, or refresh token in the browser.
4. Wait for the account status to become connected. Device authorization must be
   enabled for the account/workspace; Codex reports unsuccessful/expired attempts
   and the UI allows cancellation and retry.
5. Select an available Codex model, reasoning effort, and speed, then save.

The account belongs to the Studio server's OS user and project, not to each
browser tab. Deploy Studio only behind its existing access controls. This is not
an end-user multi-tenant OAuth implementation. Closing a pending login panel does
not revoke an already-completed login; use **Sign out** to disconnect it.

CLI/TUI agent conversations share the same project account and settings. TUI
`/model <id>` is a session-specific Codex model override and is checked against the
available Codex catalog. Legacy provider model selectors do not select the Codex
agent model. Separate provider settings still apply to direct LLM/image services.

## Reasoning and speed

These are separate settings. Effort values come from the selected model's
`model/list.supportedReasoningEfforts`; speed options come from its advertised
service tiers. Standard speed explicitly requests the protocol's `default` turn tier. Fast (or
another tier) is shown only when the model advertises it. Fast availability and
usage limits depend on the account and model; InkOS does not invent unsupported
combinations or silently downgrade a requested tier.

Only non-secret settings are written to `.inkos/codex-config.json`:

```json
{"model":"<model ID from Codex>","reasoningEffort":"medium","serviceTier":"default"}
```

A server operator can set `INKOS_CODEX_STATE_ROOT` to a private writable directory
when the OS home is unavailable; each project still gets its own hashed subdirectory.
Never point it at an existing personal Codex home.

The default model is resolved from Codex's current model catalog. Effort defaults
to `medium` and speed to `default`. A saved unsupported combination is rejected
with an actionable error rather than sent to a legacy API provider.

Codex App Server does not expose a per-turn temperature or `max_output_tokens`
parameter. Legacy temperature/web-search worker options are deprecated. Worker
`maxTokens` is an InkOS estimated visible-output admission limit: the host adds
budget guidance, interrupts oversized streamed answers, and rejects oversized
tool arguments before executing them. This is not a provider-side billing cap or
an exact tokenizer limit. Native web access stays disabled; research uses the
permissioned host capability.

## Boundaries and persistence

- InkOS exposes only its current Work Profile's host-owned dynamic tools. Existing
  confirmation, file-read, capability, validation, and atomic-write policies stay
  in the host. Dynamic tool arguments are checked without scalar coercion.
- The child uses an isolated temporary working directory/home, a dedicated
  project-specific Codex home under the server OS user's `~/.inkos/codex/`, a
  sanitized environment, `approvalPolicy: never`, and a read-only native sandbox.
  Native shell, patch, browser, web search, image, MCP/plugin/skill discovery,
  memory, and subagent capabilities are disabled. Project and developer Codex
  configuration and credentials are not inherited.
- Codex manages and stores its own credentials server-side. InkOS never reads
  `auth.json`; account endpoints project only account status and safe login fields.
  Signing out calls the official `account/logout` API.
- Every host invocation starts an ephemeral Codex thread. InkOS's committed
  transcript remains the source of truth. Restored/compacted messages are encoded
  as explicitly role-labelled historical records, with tool receipts preserved;
  historical tool calls are never replayed as execution requests.
- InkOS applies its governed context transform before each invocation. Codex owns
  compaction inside its live tool loop. Historical images are represented as
  earlier attachments; current-turn images are passed as multimodal input.
- Tool-call IDs are deduplicated per invocation, calls execute sequentially, and
  transcript listeners finish before an action executes or the turn commits.
  Turn cancellation uses `turn/interrupt` and always closes the child process.
  Host completion stops further tool execution. A missing explicit completion
  receipt gets one bounded continuation, then fails clearly.

## Verification and limits

Unit and protocol fixture tests exercise device login/cancellation/logout,
credential-safe account projection, catalog validation, cancellation races,
process failure, durable events, tool results, deduplication, and host permissions.
The pinned binary can be tested with a loopback fake Responses provider to verify
its actual offered tools without any real account or model request. Browser tests
use mocked account APIs and cover interrupted/repeated sign-in and settings flows.
A real ChatGPT authorization and paid model inference must be performed by the
operator with their own account; automated tests do not log in or create tokens.

Official references:
- https://developers.openai.com/codex/app-server/
- https://developers.openai.com/codex/auth/
- https://github.com/openai/codex/tree/rust-v0.159.2
