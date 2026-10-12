# Repair Studio model authentication

<a id="task"></a>
## Task
**Task ID:** fix-model-auth
**Original request:** API key and OAuth model configuration cannot be completed normally.
**Endpoint:** Fix and verify the existing development implementation and update its isolated local deployment. Preserve the uncommitted Chinese/English localization changes; no push, merge or publication.

<a id="intent"></a>
## Intent
Make provider setup immediately usable and accurately refresh its result, using the official SDK for API-key/OAuth behavior. Never request secrets in chat or use the user's credentials during debugging.

<a id="spec"></a>
## Requirements and design
- Open the authentication interaction in a focused, visible dialog rather than below 42 provider rows.
- Refresh the provider catalog and enable model selection after native login completes.
- Supply the stable UUID and app name required by native OpenAI ChatGPT OAuth. Persist the UUID in the existing project Document, not another execution store.
- Forward whole-flow and per-prompt cancellation to the official SDK; cancel pending login when the dialog is cancelled and clean up on runtime close.
- Preserve typed native prompts, events, errors, credential ownership and Chinese/English copy. Only offer interactive methods actually supported by the SDK.
- Tests may save inert placeholder strings in isolated projects to verify SDK credential persistence, but this is not vendor validation. OAuth checks stop before visiting the provider or exchanging tokens; no account login, model call or fee is authorized.

<a id="plan"></a>
## Implementation plan
1. Add and run focused core and browser regression cases before implementation.
2. Repair `runtime/host.ts` and the project Document field, reusing SDK login and AbortSignal. Add the cancellation RPC to thin Studio routes.
3. Repair `pages/Models.tsx` using the existing dialog component and local catalog refresh; update translations and operations guidance.
4. Run relevant core/Studio tests, build/typecheck and actual browser checks; restart only the previously created isolated local runtime/Studio and verify the updated model screen.

<a id="verification"></a>
## Verification
Before repair, actual focused core tests had **2 failures / 1 pass**: missing `models.login.cancel` and native OpenAI OAuth's required device UUID. Actual browser tests had **2 failures / 1 pass**: the API-key form was outside the viewport and the OAuth interaction was unavailable. Native API-key persistence itself already worked. The post-completion catalog-refresh regression passed on this machine before repair; explicit refresh on native completion now removes its timing dependency.

Verified on Node **22.19.0**, pnpm **11.3.0**, and installed Google Chrome:
- `pnpm build`: all three packages passed.
- `pnpm typecheck`: all three packages passed (Studio client and API).
- `pnpm test`: **340 tests / 54 files passed** (core 165/29, Studio 39/8, CLI 136/17).
- `pnpm test:flows`: **63 tests / 10 files passed**.
- `pnpm --filter @actalk/inkos-studio test:e2e`: **15 passed**, including four authentication cases and the existing Chinese/English, professional-data, task and publishing regressions.
- Core authentication checks verify official SDK key persistence, model selection, absence of the placeholder key from public status/catalog, secret-prompt cancellation, native OpenAI authorization URLs with stable UUID/app name, repeat login and callback-listener cleanup across cancellation/runtime close/reopen. Browser checks verify viewport/focus, asynchronous configured-state refresh, selectable models, real SDK authorization links, cancellation/retry, and the Chinese mobile dialog.
- `git diff --check`: passed. Test ports 1455 and 4580 were released.

The first repaired browser run exposed a dialog accessible-name mismatch; its visible title and accessible label were aligned, then the unchanged assertions passed. Vite's informational bundle-size warning does not affect the successful build. Logs are in session scratch as `auth-before-{core,browser}.log`, `auth-browser-retest.log`, and `auth-final-{build,typecheck,test,test-flows,e2e}.log`.

<a id="delivery"></a>
## Delivery
The isolated development project is running at **http://127.0.0.1:4567/#models**, with Runtime PID **3198834** and Studio PID **3200252**. The old task-created PIDs 3101713/3101725 were stopped. After E2E, Vite's client build had removed compiled API files; `pnpm --filter @actalk/inkos-studio build:server` restored them before the successful start. No additional build-system change was made. The deployed bundle is `index-B1Z2kMIN.js` with `index-CtzAx4UU.css`.

The desktop browser initially retained the pre-i18n document across same-hash navigation. A full cache-ignoring page reload loaded the new bundle. Direct browser inspection and screenshot then confirmed the Chinese authentication dialog and its empty secret input. The empty verification interaction was cancelled; no key was entered or submitted. The model screen remains available in Chinese.

Public deployment status retained zero works/tasks and zero model/tool usage. No original project data or saved credentials were changed. Changes remain uncommitted on `refactor/durable-platform-20261012`; the prior localization changes are preserved. No push, merge, publication or production deployment was performed.

No local implementation/test blocker remains. Live credential validity, provider account authorization, OAuth callback/token exchange and inference are **not verified**: tests used inert keys solely to exercise native local storage and stopped OAuth before visiting the provider. The user must complete their own real authentication; no fee or real model call was incurred.
