# Agent configuration UI — offline controlled components

Base: `977d04b04ae85f0d8209bd5e46cb1cf6b644fdc5`.

This package adds reusable UI components only. It has no production import, route,
API client, operation manager or persistence. It does not modify the existing
Codex settings behavior or tests. All properties in `view-model.ts` are internal
display models, not a proposed server schema. The configuration owner remains
responsible for mapping the reviewed backend contract into these views.

## Components and controlled behavior

Import the six components and their prop types from
`src/components/agent-configuration-ui/index.ts`:

- `HarnessSelector`: native Codex/Pi radio group. Give each mounted group a unique
  `name`. Changing the selection emits only the chosen harness.
- `ChatGptConnectionCard`: ChatGPT-only connection display and target-bound
  connect, sign-out, status-check and cancel intents. An uncertain or unverified
  connection requires a status check before a new sign-in intent.
- `ModelOptions`: native selects populated exclusively from the scoped catalog.
  Invalid existing values remain visible. Model changes emit a single-field
  intent; the component never resets reasoning or speed. `null` means inherit the
  native default; users can select that option explicitly to remove an override.
  Selectable speed tiers require capability evidence marked `backend`. With no
  verified tiers, the current speed preference remains visible with an unknown or
  unsupported reason and an explicit remove-override button, including for Pi.
- `ConfigurationStatus`: separate installation, authentication, catalog,
  execution and save rows, with visible text, live announcements and inline
  errors. A saved configuration without readiness reads **已保存，待连接** /
  **Saved, awaiting connection**. Another target's state is not reused.
- `RunConfigurationStamp`: receives only the frozen startup display snapshot.
  It never looks up new defaults or a current catalog to replace a run's values.
- `AgentConfigurationPanel`: composes the controls and an explicit save button.
  `canSave`, `hasChanges` and `disabled` are controlled by the owner. Saving can
  be allowed before connection is ready. Clicking emits a copied target and
  selection, without altering any displayed state or performing a save.

Provide unique panel/model `id` values for labels and description references.
No control submits a surrounding form; every button is `type="button"`.
Controls use the product's native elements, Tailwind classes and `isZh` pattern.

## Integration obligations

1. Keep `TargetView` identity stable for each harness and connection context.
   `contextKey`, option keys and attempt keys are opaque internal view identities;
   do not send them as invented API fields. Map them through the configuration
   owner's reviewed adapter.
   `SelectionIntent.choiceKey: null` explicitly requests native inheritance for
   that one field. It does not reset the other fields. Missing catalog data is
   represented by catalog phase/evidence, never by changing a preference to null.
2. Supply account labels only from the selected target's account state. The UI
   also suppresses labels on target mismatch and on every phase except signed-in.
3. Resolve actual operations outside this package. Cancel intents carry the
   original target and attempt key; an old event handler remains bound to that
   original intent after another render. The adapter must implement per-target
   concurrency, deduplication, cancellation, stale-result rejection and result
   reconciliation. UI tests do not prove those operations work.
4. Preserve draft, persisted defaults and execution evidence separately. A save
   row is bound to its attempted selection; changing the draft cannot turn an old
   save acknowledgement into a new acknowledgement. Stale save/execution details
   are hidden. A save response from another harness does not disable this target's
   save button. Actual partial persistence/conflicts need backend read-back.
5. Mark execution evidence `backend` only after a real verification for the
   exact target and selection. `ready` also requires installed, signed-in and
   supported catalog choices. Missing evidence, stale verification or mismatched
   prerequisites display **尚未验证** / **Not yet verified**, regardless of a
   `ready` phase. Tests fabricate evidence to exercise that rendering branch;
   fabricated inputs are never actual verification.
   An all-null native preference is valid even before the catalog arrives, but
   cannot be ready with an empty/unverified catalog. Inheriting a model does not
   identify its capabilities: explicit reasoning/speed overrides then remain
   unverified until reviewed or removed, rather than using the first listed model.
6. Capture `FrozenRunView` when the run starts, using its actual configuration.
   Keep that snapshot independent of edits and new defaults. The component renders
   the snapshot verbatim and has no fallback path between Codex and Pi.
7. No URL or deployment-origin heuristic exists here. Remote URLs, Cloudflare
   and personal self-hosted use do not automatically create deployment eligibility
   gates. Deployment verification belongs to the later backend integration.

## Offline fixture surface

`OfflineConfigurationFixtures.tsx` is an unconnected fixture component, available
by direct import for an existing isolated preview. Its optional `onIntent` can
record user intents; fixed fixture state never claims an operation completed.
It renders eight mixed scenarios in either language: Codex signed in with no
execution evidence, saved/disconnected Pi, missing Pi installation, pending Pi
sign-in, expired authentication with a partially available catalog, uncertain
sign-in with save conflict, uncertain installation with partial save failure,
and an uncertain save result. The current-run stamp remains Codex while the new
default example is Pi. Emails and model labels are explicitly fictional.

The fixture notice states that all installation/account/catalog/save examples
are simulated and real sign-in, inference and deployment are **尚未验证**.
No fixture is runnable according to `isExecutionReady`.

## 18-item coverage for this delegated UI work package

These items correspond to the supplied UI requirements. “Offline” means the
component/intent rule is checked locally, not that the real service works.

| # | Requirement | Offline evidence | Wiring | Real validation |
|---|---|---|---|---|
| 1 | ChatGPT is the only model-account login path | Card has ChatGPT intents and no key login | Pending: map reviewed auth adapter | Pending: real ChatGPT auth |
| 2 | Select Codex or Pi | Controlled native radio group tested | Pending: select target/context | Pending: both actual harnesses |
| 3 | General reusable UI, no API ownership | Internal view/intent types; isolated exports | Pending: configuration owner maps contract | Pending: reviewed adapter behavior |
| 4 | No direct fetch/login/poll/save | Render/event tests; zero fetch and timers; source audit | Pending: operations outside components | Pending: operation end-to-end tests |
| 5 | Five independent lifecycle states | Five status rows and mixed fixtures | Pending: independent backend state mapping | Pending: independently failing services |
| 6 | Login success does not mean runnable | Exact-target/selection/evidence readiness tests | Pending: verification result mapping | Pending: real execution verification |
| 7 | Saved unready Pi says 已保存，待连接; no fallback | Bilingual status and target tests | Pending: actual persisted-default read-back | Pending: save while disconnected |
| 8 | Codex email cannot leak into Pi/context | Cross-harness/context and signed-out label tests | Pending: correctly scoped account source | Pending: different real accounts |
| 9 | Pi has no fabricated speed tiers without evidence | Unverified/unsupported capabilities hide tier selects; retain the current value and explicit removal | Pending: verified capability adapter | Pending: actual Pi speed support |
| 10 | Model/reasoning/speed are independent; no silent resets | Choice-only intents; unavailable values retained | Pending: explicit owner reconciliation | Pending: real catalogs and model changes |
| 11 | Old run keeps Codex when new defaults become Pi | Frozen stamp unchanged by default render | Pending: capture true startup snapshot | Pending: concurrent run/default edits |
| 12 | Keyboard radio/select and focus affordances | Native group/select/button semantics and focus classes asserted | Pending: mount in existing UI | Pending: browser Tab/arrows/focus recovery |
| 13 | Labels, live status, inline errors; bilingual | Associated native labels, descriptions, alerts and live regions rendered in both languages | Pending: surrounding page semantics | Pending: browser/screen reader check |
| 14 | Out-of-order login/cancel emits bound intent only | Original target/attempt closure and mismatch tests | Pending: true operation manager | Pending: reordered/cancel races |
| 15 | Uncertain/conflict/partial failure fixtures | Eight fixture scenarios; inline error tests | Pending: reconcile real results | Pending: backend partial failures |
| 16 | No remote/Cloudflare deployment gate | No URL/deployment inference in source; fixture deployment unverified | Pending: real deployment evidence adapter | Pending: self-hosted/remote validation |
| 17 | No production entry/server/core/shared/hook changes | Additions only in the two permitted directories | Pending: separately reviewed production integration | Pending: integrated regression tests |
| 18 | Correct collection, existing tools, isolated local delivery | `.test.ts` under `src`; Vitest and scoped TypeScript; shared-object worktree and local commit | Pending: parent integrates reviewed commit | Real login/inference/deploy are outside this delivery |

## Validation commands

Run from `packages/studio` in the isolated worktree. These reuse installed
dependencies. No download or install is needed. `bin/pnpm.cjs` is an existing
shell wrapper, so execute it directly (rather than passing it to Node).

```sh
PATH=/home/zzy/Documents/Codex/2026-10-09/task-16/.toolchains/inkos/node-v22.23.3-linux-x64/bin:$PATH /home/zzy/Documents/Codex/2026-10-09/task-16/.toolchains/inkos/pnpm-9.15.9/bin/pnpm.cjs exec vitest run src/components/agent-configuration-ui/agent-configuration-ui.test.ts

PATH=/home/zzy/Documents/Codex/2026-10-09/task-16/.toolchains/inkos/node-v22.23.3-linux-x64/bin:$PATH /home/zzy/Documents/Codex/2026-10-09/task-16/.toolchains/inkos/pnpm-9.15.9/bin/pnpm.cjs exec tsc --noEmit --jsx react-jsx --module ESNext --moduleResolution bundler --target ES2022 --lib ES2022,DOM,DOM.Iterable --strict --esModuleInterop --skipLibCheck --types node,vitest/globals src/components/agent-configuration-ui/*.ts src/components/agent-configuration-ui/*.tsx
```

The checked-in Vitest config includes `src/**/*.test.ts`. Tests live in the
component directory for actual collection; this `tests/` directory contains
coverage/usage documentation, not an uncollected `.tsx` test suite. TypeScript
checks all newly added production, fixture and test files without widening the
existing application contract.

Recorded local results (2026-10-10 UTC):

| Invocation | Exit code | Result |
|---|---|---|
| Initial `pnpm exec vitest run …` with PATH-only selection | 1 | System pnpm 11 was selected; automatic dependency precheck failed before tests started |
| Initial `pnpm exec tsc …` with PATH-only selection | 1 | Same system pnpm precheck failure; compiler did not start |
| Pinned pnpm 9.15.9, initial targeted Vitest | 0 | 1 file collected, 32/32 passed |
| Pinned pnpm 9.15.9, initial scoped TypeScript | 0 | All added TS/TSX production/fixture/test files checked |
| Pinned pnpm 9.15.9, final targeted Vitest | 0 | 1 file collected, 35/35 passed; 0 failed, 0 skipped; 868 ms wall time |
| Pinned pnpm 9.15.9, final scoped TypeScript | 0 | No diagnostics |
| Source import/effect/URL boundary audit | 0 | 11 presentation/fixture files; local imports, no network/timer/storage calls or URL gate |

Validation-command nonzero count: **2 of 6** attempts; both were environment
precheck failures. Final test/typecheck nonzero count: **0 of 2**. No installation
completed. A separate setup probe incorrectly passed the shell pnpm wrapper to
Node and produced a syntax error; executing the wrapper directly confirmed
9.15.9. Manifests/lockfiles remained unchanged and the source repository remained
clean after verification. No caches were cleared.

The first local commit attempt exited 128 because the isolated repository had no
author identity. The retry uses per-command `Codex <codex@openai.com>` identity,
matching the baseline commit, without changing global or source-repository config.

## Review remediation: P1 and P2

- P1: `null` now means inherit the native default for model, reasoning and speed.
  Native-default options remain selectable and emit `choiceKey: null`. Unknown
  capabilities and unavailable explicit overrides stay separate from that valid
  preference. Model changes still emit only a model intent. Empty catalogs never
  create readiness, including with a fabricated ready execution input.
- P2: after switching from a verified speed tier to a model with unknown or
  unsupported speed, the old override remains visible with its reason. Only an
  explicit remove-override click emits the null speed intent; controlled props
  stay unchanged until the owner supplies a new view. No fake speed tier is added.

All original 35 test cases are retained. One original assertion changed: a model
select with a mismatched catalog is no longer disabled. The catalog-isolation
assertions remain; the select now permits only explicit native inheritance when
no scoped models are available. Keeping it disabled would trap the old override
and contradict P1. No original test case was deleted.

11 additional cases cover null/default roundtrips, explicit clearing, unresolved
native-model capabilities, empty catalogs, supported-value retention, transition
from verified speed to unknown/unsupported speed, and disabled removal.

Remediation reproduction used the documented pinned Vitest command with
`-t 'native defaults|retained speed overrides'`: exit 1, 10 failed, 1 passed and
35 original cases skipped by the filter. This reproduced the reported defects
before the component changes. The exact documented commands above were then run
twice: targeted Vitest exit 0, 46/46 passed each time; scoped TypeScript exit 0,
no diagnostics each time. The final Vitest run collected one file, with 0 failed
and 0 skipped (666 ms wall time). This remediation iteration had 1 nonzero exit
among 5 test/compiler invocations, the intentional failing reproduction. Final
test/compiler nonzero count is 0 of 2. Boundary/scope/resource and diff-whitespace
checks also passed. Actual backend operations remain unverified.

No existing isolated browser preview was found. No router or preview-tool change
was made; browser keyboard/focus and visual checks remain pending. Full app/CI,
real sign-in, inference, persistence, deployment and screen-reader tests were not
run. Board synchronization is cancelled; this package performs no board actions.
