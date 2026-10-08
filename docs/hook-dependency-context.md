# Hook dependency context

InkOS already stores optional `dependsOn` (canonical hook IDs) and `paysOffInArc`
(authored arc context) on hook records. This increment connects those existing
fields to the reducer, readable projection, local retrieval and governed context.
It adds no persistent schema, memory store, model provider or runtime.

## Semantics

- An upsert with omitted fields leaves existing metadata intact. Explicit `[]`
  or `""` clears the corresponding authored value. Books without these fields
  keep their existing state shape and projection columns.
- SQLite FTS5 and the existing semantic selector still select relevant unresolved
  hooks. Resolved and superseded hooks are available only to exact-ID evidence
  lookup; they are not selectable active promises.
- The chapter memo's references, plus semantically selected hooks carrying
  authored dependency/arc metadata, receive protected context. Their stored
  dependencies are followed iteratively, with one entry per exact canonical ID
  and all encountered causal edges retained. Cycles do not cause recursion or
  duplicate expansion. Labels and similar titles never substitute for IDs.
- Resolved records are historical evidence. Superseded records retain the
  withdrawal reason. Neither becomes active, and traversal stops at these
  terminal records: their older prerequisites are not reintroduced as current
  work. Other roots may independently select still-active records.
- A missing reference becomes a protected diagnostic naming the exact ID and
  its referring hook or chapter memo. It establishes no prior history and does
  not block the normal authorized new-hook workflow.
- `paysOffInArc` is authored context, not a deadline. No age-based payoff rule or
  rule requiring every dependency to resolve before writing is added.
- Canonical record sources, statuses, promises, notes and causal IDs survive
  lower-priority context compression. If protected evidence exceeds the actual
  context window, composition reports overflow rather than silently dropping it.
  Compiler allowances reserve the emitted entry metadata, and the final complete
  context is checked before persistence; an oversized result is not retried.
- Studio's hook-table parser decodes the existing projection's escaped-pipe
  format without changing its UI model, preserving literal backslashes and empty
  cells in both legacy and optional dependency columns.

## Verification

Synthetic offline tests exercise reducer updates, projection escaping and legacy
compatibility; selection and exact-ID lookup; protected writer-facing evidence;
repeated roots, diamonds and cycles; missing and renamed references; historical
resolution and superseded authority; new-hook seeding; and context compression.
These are transport and state-contract tests, not a claim of novel quality or a
live-platform validation.

## Design reference and implementation boundary

The user-shared Webnovel Writer material prompted a review of chapter-context and
review-input completeness. Reference: [lingfengQAQ/webnovel-writer, fixed commit
0af0c0b2fc2e4104e8a12c1d62136c6595a6a983](https://github.com/lingfengQAQ/webnovel-writer/tree/0af0c0b2fc2e4104e8a12c1d62136c6595a6a983),
particularly `webnovel-writer/agents/context-agent.md` and the review-input
contract. The missing fields and lookup gaps were independently reproduced in
InkOS. This TypeScript implementation was written for InkOS's existing state and
context contracts; it does not copy upstream code or prompt passages, import its
Python/Claude runtime, or claim that upstream provides this dependency algorithm.
