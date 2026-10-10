# Studio production wiring — offline integration evidence

This integration mounts `AgentSettings` in the existing `ProjectSettings` entry
and mounts `/api/v1/agent-configuration` after the existing Studio request guards.
The controlled presentation components and their internal prop contracts remain
unchanged. The original `README.md` describes the earlier offline component stage.

## Ownership and operations

The old Codex routes and new configuration routes share one project-scoped
`CodexAccountService`. Observation and explicit binding borrow its public
`getRuntimeClient()` peer and use the reviewed public Core `observeCodexRuntime`
and `bindCodexModelConnection` functions. Studio does not close that borrowed
peer, create another authentication owner or accept an authentication home,
project directory or connection reference from the browser. Server shutdown
disposes the account service through its existing lifecycle.

Settings/state GET requests do not initiate sign-in or persist a binding.
Binding requires an explicit POST and the active draft's expected revision.
Core performs its actual project-context check and CAS. Preferences and binding
remain separate; authentication/catalog/descriptor readiness never supplies an
execution result. Production observation always returns `execution: null`.
An absent owner generation is represented by `null`, not an invented generation.

The account service owns device-login attempts. The controller deduplicates
browser mutations, scopes replies to the current target/lifetime/generation,
and retains per-context drafts and their original revisions. Explicit Close
cancels only the returned/observed attempt ID, including when the initial HTTP
response arrives late. A Close received after the ID returns fences the earlier
observation before cancellation read-back. Failed or ambiguous operations show
an inline uncertain state; login is not automatically replayed. Navigation
detaches browser work and returning observes the same service-owned pending
attempt. Only pending sign-in status is polled, with effect cleanup on navigation.

Pi can be selected and its native preferences saved pending connection. Pi
production observation is unavailable and does not borrow the Codex peer, show
the Codex identity, supply speed choices or fall back to Codex. The backend clears
the old binding when the selected harness changes. No remote-URL or Cloudflare
deployment eligibility heuristic is added; explicitly allowed self-hosted origins
are exercised through the existing guards.

## Requirement coverage

All tests described here are offline. The Core service, owner, bridge functions,
filesystem CAS, production route mount and browser transport are real local code;
only the protocol peer is synthetic. Native-control tests replace only the React
subscription boundary, invoke actual controlled handlers and render the actual
`ProjectSettings` entry. They are not browser keyboard or screen-reader tests.

| # | Requirement | Local integration status | Remaining real validation |
|---|---|---|---|
| 1 | ChatGPT-only account path | Wired: actual device-login service, official URL projection | Real OAuth |
| 2 | Codex/Pi selection | Wired: native radio → controller → real settings CAS | Pi execution unavailable |
| 3 | Reusable UI, owner mapping | Wired through reviewed Core contract and pure adapter | Real runtime deployment |
| 4 | Presentation performs no operations | Preserved; operations live in controller/API/service | Browser lifecycle checks |
| 5 | Five independent states | Production mapping preserves independent installation/auth/catalog/execution/save | Real independently failing services |
| 6 | Login does not imply runnable | Production execution always unverified | Real inference verification |
| 7 | Saved Pi says 已保存，待连接, no fallback | Actual native save/read-back and bilingual rendering checked | Real Pi connection |
| 8 | No Codex identity in Pi/context | Safe projection plus target/generation fencing checked | Distinct real accounts |
| 9 | No fictional Pi speed tiers | Pi unavailable; no speed select or Codex catalog inherited | Actual Pi speed support |
| 10 | Independent model/effort/speed | Native controls retain other values across model changes; real save checked | Live catalog changes |
| 11 | Frozen run configuration | Existing controlled stamp unchanged; next-run settings kept separate | Actual concurrent run/default changes |
| 12 | Native keyboard/focus affordances | Mounted native radio/select/button semantics preserved | Browser Tab/arrows/focus |
| 13 | Labels/live/error and bilingual copy | Actual entry renders status/live and inline messages | Browser/screen reader |
| 14 | Login/cancel ordering | Real Core cancel/late completion and controller deferred-response races checked | Real network/OAuth races |
| 15 | Uncertain/conflict/partial failure | Existing mixed fixtures retained; real local CAS conflict/read-back and uncertain controller cases checked | Real backend partial failures |
| 16 | No URL deployment gate | Explicit self-hosted origin passes guards; no new heuristic | Real self-hosted deployment |
| 17 | Separate reviewed production wiring | Necessary server/ProjectSettings entry now wired; old Codex UI/state tests retained | Independent candidate review |
| 18 | Correct collection and isolated delivery | New tests are `src/**/*.test.ts`; pinned installed tools and standard checks | Parent integration/CI |

## Validation

Use installed Node 22.23.3 and pnpm 9.15.9. No dependency/manifest/lockfile,
Vitest collection rule or TypeScript configuration changes are required.

From `packages/core`, run the official `pnpm run build` once in the isolated
worktree to produce current public declarations. From `packages/studio` run:

```sh
pnpm exec vitest run src/api/agent-configuration.test.ts src/api/agent-configuration-production.test.ts src/pages/agent-configuration-adapter.test.ts src/pages/agent-settings-production.test.ts src/hooks/use-agent-configuration.test.ts src/hooks/agent-configuration-auth.test.ts src/components/agent-configuration-ui/agent-configuration-ui.test.ts src/hooks/use-api-codex.test.ts src/pages/codex-settings-state.test.ts src/__tests__/codex-endpoints.test.ts --maxWorkers=1 --minWorkers=1 --no-file-parallelism
pnpm exec vitest run --maxWorkers=1 --minWorkers=1 --no-file-parallelism
pnpm run typecheck
```

The delivery's external evidence ledger contains exact pinned commands, actual
exit codes and full logs, including initial failing reproductions and repairs.
No source-mapped server TypeScript shortcut is used. Offline successes do not
establish real sign-in, inference, browser behavior or deployment success.

Recorded candidate results: 209/209 related tests passed; official Core build,
built public-export load and unmodified Studio typecheck exited 0. The complete
75-file Studio suite exited 1: 689/699 passed. Its same ten failures reproduced
in the unchanged `c3beba2bc456e0e9e5229bc2f9a1b0bd8fef0748` baseline
(three affected files, 29/39 passed). One local-listen `EPERM` failure disappears
when that existing lifecycle file is run with listening permitted: 4/4 passed.

Nine remaining baseline failures require separate Core-contract fixture review:
`codex-production.flow.test.ts` still expects Fast turn wire spelling and legacy
settings-file updates; `task-owner-admission.flow.test.ts` invokes a private
Agent tool path without the new frozen runtime context/peer guard. Those existing
tests and Core source were left unchanged. This delivery is a reviewable local
candidate; full-suite acceptance and push remain blocked pending that review.
