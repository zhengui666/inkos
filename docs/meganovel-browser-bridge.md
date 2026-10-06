# MegaNovel native browser binding candidate: live deployment and acceptance still pending

This change does **not** claim a completed unattended MegaNovel deployment. It supplies a real Playwright CDP transport, durable single-chapter publishing adapter and native DOM implementation based on authorized visible UI observations from 2026-10-06. The native implementation has not yet passed a real account run through the product. The public automatic-submission capability remains `unavailable` until that acceptance is completed. A successful mock test, an assistant-operated Chrome tab, or an author-only preview is not product acceptance.

## What can be called

The following APIs are exported from `@actalk/inkos-core`:

- `connectMegaNovelCdpPort(configuration, binding)`: connects Playwright to an **existing, explicitly configured** loopback CDP endpoint and selects the actual configured CDP target ID
- `createMegaNovelDomBinding(configuration?)`: supplies the built-in observed UI workflow, without requiring a user-written JavaScript bootstrap
- `MegaNovelPublishingAdapter(packages, store, browser)`: consumes the existing `ManualPublishingAdapter` frozen package and `PublishingStore`
- `adapter.ready(scope)`: a read-only availability/account/book/blocker check before generating another chapter
- `adapter.saveDraft(intent)`: inspects first, reserves uncertainty before editor input, performs at most one draft mutation, then independently reads back
- `adapter.submit(intent)`: rechecks a verified draft and the current AI disclosure, reserves uncertainty, performs at most one submission action, then independently reads back
- `adapter.reconcile(intent)`: only reads the portal. It can also adopt historical/manual attempts without uploading anything
- `store.getMegaNovelRun(packageId, chapterNumber)`: returns the persisted browser observation/unknown state, separately from manual receipts

`intent` contains `packageId`, `chapterNumber`, an explicit `aiAssisted` boolean and `scope = {sessionId, accountId, accountLabel, remoteBookId}`. For this transport, `sessionId` is the actual CDP target ID. `accountId` must be independently visible in the authorized UI; it is not a cookie or access token.

`ready`, `saveDraft`, `submit` and `reconcile` accept a second `{signal?: AbortSignal}` argument. Cancellation is checked after local loading and browser readback, before any new editor/publish effect starts. Once an effect has started, its uncertainty stays reserved and the adapter drains the independent readback even if the parent stops; stopping is not permission to forget or repeat the effect.

The configuration requires `endpointURL`, `scope`, a shared absolute `lockDirectory`, and explicit `authorization.automation` and `authorization.aiAssistedContent` evidence. Each authorization has `provenance: 'user_reported' | 'platform_document'` and a non-secret `reference`. User-reported platform permission stays user-reported. A logged-in session or an absent AI checkbox cannot substitute for these permissions. `timeoutMs` bounds connecting; `operationTimeoutMs` bounds each binding operation.

`createMegaNovelDomBinding` accepts `knownChapters: [{number, title, remoteChapterId, publicUrl}]`, optional `uiTimeoutMs`, and an optional observed avatar-selector override. Supply only independently observed public URLs; no title slug is guessed. The default avatar trigger is the observed `div.nickname.right-item > img`. The scheduler loader selects this built-in implementation from the `dom` configuration when no external `domBindingModule` is supplied. An injected `MegaNovelDomBinding` remains supported but must not create its own browser connection or ignore cancellation.

The native identity check opens a temporary read-only `/uc` tab in the authorized context, opens the visible avatar menu, and reads its visible `ID:` span inside `.user-center div.user-center-top`. It never uses a public author link or collapsed-menu content as session identity. It closes the temporary tab after reading. Chapter IDs are read from actual editor URLs after opening rows; unnumbered `Untitled Chapter / Unpublished` rows are excluded only after verifying an empty unsaved editor and returning to the original chapter.

Current list calibration covers a fully visible `ul.episode-list` with reverse-contiguous chapter ordinals and no overflow/pagination. A first-submission absence check reloads the author view and requires all configured historical chapters and every expected predecessor. Cached lower chapter counts do not prove absence. A list with overflow, missing ordinals or unknown rows is blocked for further UI calibration; this implementation does not pretend the initial layout scales forever.

A reopened matching author row without Unpublished and with no Publish action establishes `submitted` when anonymous readback is unavailable; it does not infer approval or a rejection reason. Publication requires an actual canonical reader URL with matching book/chapter attributes and body text in a newly created **anonymous browser context with empty storage**. The author's Preview control may supply an observed destination, but its authenticated contents are never publication proof. Preview query parameters, inaccessible anonymous pages, and content mismatches leave publication unverified. The anonymous context is closed after reading. A 404 or delayed listing does not authorize resubmission or establish why the platform is not serving the chapter.

## Durable state and scheduler integration

The adapter stores its runs in `publishing_meganovel_runs` inside the same `harness.sqlite`, with the existing package CAS/event journal. Manual receipts retain their existing provenance and `remoteVerified: false`; browser observations do not alter that claim.

- Use `saveDraft` only for a genuinely new, explicitly reviewed chapter
- For an existing/uncertain platform chapter, call `reconcile` first. An absent read leaves an unknown reservation; it never authorizes a fresh upload
- Reuse the original frozen package after a restart. Do not prepare a new revision to escape a pending attempt
- `draft_unknown` and `submit_unknown` survive restart, timeout, negative lookup and lost responses. They are readback-only states
- A new tab may be used for read-only `reconcile` when the stable account/book/declaration/revision identity still matches. An independently observed row can bind the observation to the new target; uncertainty is never reset
- `submitted` or `reviewing` means accepted into the visible submission/review workflow. Neither is `published`
- `published` requires a distinct, independently reopened publication observation with the real chapter ID, exact title and ordinary body-text comparison
- Conflicting revisions, chapter renumbering and local account aliases cannot bypass an existing browser reservation for the same actual account ID/book/chapter or artifact. Legacy manual labels have no authenticated account identity; an unresolved manual attempt for the same platform book under another label blocks admission until its original mapping is reconciled, while identified browser runs remain scoped to the actual account
- Manual absence receipts cannot clear a browser reservation. Rejected chapters cannot silently become new upload attempts

A scheduler wrapper should select a reviewed canonical revision, prepare only `formats: ['txt']`, and retain the selected package ID. Its `ready(workId)` must fail visibly while the CDP binding/permissions/account/book are unavailable. Its `publish(...)` should return `pending` for unknown/draft states, `submitted` for submitted/reviewing, and `published` only for the observed published phase. It should poll/reconcile pending work before drafting further chapters for the same book. Review failure or an unavailable review is not permission to publish.

Before enabling automation for a book with historical manual/assistant submissions, identify and reconcile those attempts using their **original target and frozen package**. An old manual account label is not an authenticated account ID. Creating a new label/package does not establish that a chapter is a first submission, and a delayed remote result may still be invisible. The integration must block first submission until this migration prerequisite is resolved; the browser adapter cannot infer missing historical account identity from arbitrary legacy strings. Do not substitute a newly prepared package for an unresolved historical attempt.

The adapter does not implement a generic delivery queue, scanning/writing policy, account creation, agreements, authentication, contracting, payments, identity verification, or income reporting. It does not change the model configuration.

## Transport and ownership boundaries

`playwright-core` is pinned to `1.61.0`. No browser binary is downloaded by this package. `connectOverCDP` attaches to an existing Chromium endpoint; it does not enable remote debugging, start Chrome, create a profile, sign in, read cookies, copy a browser profile or grant persistent access. The wrapper uses `noDefaults: true`, preserving the attached context's existing browser defaults.

One cross-process lock owns the configured target; calls within the connection are serialized. Every process that can control this target must use the same lock directory. On normal close the CDP client disconnects and the lock is released. On a timeout the signal is aborted and the CDP client is disconnected before the operation returns; the transport becomes unusable until disposed/reconnected. The chapter's unknown reservation remains. A crashed process leaves its lock behind and the bridge does not steal it. An operator must confirm the old process is gone before clearing such a stale lock. A separate human/executor must not simultaneously operate this same tab.

The DOM binding rechecks the visible account at New Chapter, title entry, body entry, Save, Publish, Now and final Confirm boundaries. During multiline body entry it refreshes that identity before the next line at an eight-line boundary or when the last check is two seconds old, rather than opening the account page for every keystroke; an individual browser operation can take longer than two seconds, and each input still checks the live editor scope/blockers and cancellation. These UI checks are not an atomic server-side identity transaction: already-started input can autosave before a mid-batch session change is detected. Such uncertainty is retained for read-only reconciliation, never automatically replayed. Fill operations have preceding trial-click hit tests so they cannot silently type behind an overlay. Unexpected visible semantic dialogs or agreement/risk notices block work. The publish dialog must contain only the observed Publish Schedule, Now, Later, Confirm and CANCEL labels with no additional form fields; the Now radio must be checked before the single Confirm action, with a fresh account and book/chapter check. It never retries mutations internally. Parent cancellation is composed into the CDP queue and binding signal, so a canceled queued action never starts typing. A toast alone is not a readback.

The authorized UI observation on 2026-10-06 confirmed a separate `Chapter title` input and TinyMCE body. The adapter applies `chapterDocumentBody(document, number, title, language)` to the verified frozen document before writing or comparing body text. This explicitly removes the leading numbered chapter-heading wrapper (including adjacent same-number aliases handled by that shared utility), while preserving the original frozen revision and retained bytes. Comparison normalizes physical CRLF/CR line endings and terminal newlines only, since rendered paragraph text may omit the source file's final newline. It preserves words, punctuation, internal spacing and paragraph breaks; other differences fail closed. No content hash is created.

## Missing deployment prerequisites

1. Verify that an existing authorized CDP endpoint is available to the **InkOS process**. The assistant's Chrome extension connection is not evidence of this
2. If enabling a debugging endpoint or creating a persistent automation profile is necessary, obtain the appropriate explicit authorization first. Do not silently expose a debugging port or reuse/copy a daily browser profile
3. Validate the native binding against the actual dedicated session, especially New Chapter navigation, the empty-placeholder selection, Now radio accessibility and Preview popup behavior. Any changed UI or list overflow needs additional observation before implementation; no unknown selectors are guessed
4. Install the exact runtime dependency and integrate the repository lockfile. The integrator owns lockfile regeneration
5. Connect the binding into the scheduler/CLI and run one authorized real chapter through product code, then repeat the invocation, restart the process, and verify no duplicate appears
6. Independently observe the remote chapter ID, real review/publication status and reopened body text. Existing historical unknown chapters must be reconciled rather than retransmitted

An always-running scheduler cannot overcome a sleeping/offline computer, expired login, missing browser endpoint, unsupported UI or authorization block. Those remain visible blocked states.

## Official transport references

- [Playwright connectOverCDP](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp) documents connecting to an existing Chromium browser and the lower fidelity of CDP compared with the Playwright protocol
- [Chrome remote-debugging security changes](https://developer.chrome.com/blog/remote-debugging-port) explains the Chrome 136+ restriction on remote-debugging switches for the default profile and the need for a non-default user-data directory when those switches are used

These references establish a supported browser transport, not permission to automate MegaNovel or proof of a working authenticated deployment.

## Verification scope

`meganovel-publishing.flow.test.ts` exercises durable reservations, lost responses, restarts, scoped readback, manual historical adoption, target rebinding, truthful disclosure and cross-label duplicate prevention. `meganovel-cdp.test.ts` exercises the transport wrapper against a synthetic browser driver, including configuration validation, target selection, ownership, timeout quarantine, queued cancellation and read-only readiness.

`meganovel-dom-binding.test.ts` includes an opt-in isolated Chromium fixture with every page request intercepted, including anonymous contexts. Set `INKOS_BROWSER_FIXTURES=1` and, when needed, `INKOS_FIXTURE_CHROMIUM` to an installed official Chromium executable. This fixture uses no real account. The browser fixture is opt-in for local runs, and the browser CI job enables it using an installed Chromium. A skipped test, typecheck or synthetic fixture is not live platform acceptance.
