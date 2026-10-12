# Studio Chinese and English localization

<a id="task"></a>
## Task
**Task ID:** studio-i18n
**Original request:** Support i18n with Chinese and English in the locally opened development Studio.
**Endpoint:** Implement and verify in the current worktree; refresh the local deployment. No push, merge or publication.

<a id="intent"></a>
## Intent
Make the workbench usable in Simplified Chinese and English without changing manuscripts, professional data, model instructions or execution state.

<a id="spec"></a>
## Requirements and design
- Localize navigation, page copy, forms, notifications, accessible labels, common statuses and professional UI labels.
- Provide an always-available language selector. Respect a stored selection, otherwise detect the first supported browser language, with English fallback.
- Persist the selection in browser local storage and update the HTML language. Preserve unsaved inputs and do not refetch or resubmit on switching.
- Use React Context, source-phrase dictionaries and native Intl formatting, with no new dependencies. Unknown extension copy and original receipts/errors remain readable in their original form.
- Content locale remains independent from interface locale.

<a id="plan"></a>
## Implementation plan
1. Reuse existing workbench components and the retained non-React language helper; add `src/i18n/` and wrap `main.tsx`.
2. Localize App, Works, Tasks, Publishing and shared components. Delegate only Conversations, Materials, Models, Plugins and DomainView plus their separate dictionary.
3. Add unit coverage and genuine browser coverage for language detection, switching, persistence, translated pages and unchanged drafts/request counts.
4. Run Studio build/typecheck/unit/browser checks and refresh the existing isolated deployment at `http://127.0.0.1:4567`.

<a id="verification"></a>
## Verification
Verified on Node **22.19.0**, pnpm **11.3.0**, and installed Google Chrome:
- `pnpm --filter @actalk/inkos-studio build`: passed (client and API). Vite emits an informational bundle-size warning, not a build failure.
- `pnpm --filter @actalk/inkos-studio typecheck`: passed (client and API).
- `pnpm --filter @actalk/inkos-studio test`: **39 tests / 8 files passed**, including 9 locale tests and 4 actual runtime/backend flow tests.
- `pnpm --filter @actalk/inkos-studio test:e2e`: **11 passed**, including 3 new locale cases. Actual browser checks cover preference detection, both-direction switching, reload persistence, every navigation destination at desktop/mobile widths, translated validation/notifications/mobile captions, draft input retention, unchanged saved revisions/professional data, and no duplicate writes or model calls.
- `git diff --check`: passed. The browser-test listener at port 4580 was cleaned up.

Logs are in the session scratch directory as `i18n-final-{build,typecheck,test,e2e}.log`. Model generation and remote publishing were not invoked.

<a id="delivery"></a>
## Delivery
The existing isolated deployment at `http://127.0.0.1:4567` serves the updated `index-CGtIW7B0.js` / `index-cbCwCNYx.css`. Runtime PID **3101713** and Studio PID **3101725** are unchanged; its empty project and zero model/tool usage are intact. No original project data was modified.

The desktop host could not reveal the browser panel for this session (`Browser view did not become visible for the calling session`). Automatic panel refresh and selecting Chinese in that panel were therefore **not performed**. Bring this conversation to the foreground and refresh; use the header language selector. The actual Playwright browser acceptance above did pass.

Changes remain uncommitted on `refactor/durable-platform-20261012`. No push, merge, release or publication was performed. There are no remaining implementation or test blockers.
