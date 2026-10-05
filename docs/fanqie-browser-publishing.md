# Fanqie: scoped browser protocol, not a live publishing integration

Research checked on 2026-10-02 against Fanqie's public official pages in a cloud browser. No author account was signed in, no credentials were created, no agreement was accepted, and no manuscript was transferred. The existing manual-package baseline is preserved. New automatic adapters for other platforms are outside this slice.

## What exists now

`FanqiePublishingAdapter` consumes the same immutable packages verified against their retained bytes as `ManualPublishingAdapter`. Its injected `FanqieBrowserPort` exposes an independently observed chapter inventory plus two narrowly scoped mutations: save **one** draft and schedule **that** draft. There is no default live port, invented author API, hardcoded unobserved selector, CLI upload command, background worker, or claim of live acceptance. Public capability reporting therefore remains unavailable for automatic submission.

The adapter persists state in the existing `harness.sqlite` using the same package CAS/event journal and chapter reservation. Manual receipts retain their original `user_reported` semantics; browser observations are kept separately by `getFanqieRun(packageId, chapterNumber)` and never masquerade as user reports. `remoteVerified: false` on a manual package does not become a platform-wide guarantee.

- Reverify frozen source bytes before browser access; send the exact selected content, not a moving source file
- Pin session, actual platform account ID, local account label and platform book ID; changing them stops this run
- Require explicit `aiAssisted` with no default false
- Require complete draft/review/published inventories and exact number, title, remote ID and observed content text; never deduplicate by title alone
- Reserve the attempt before typing, because editor input may autosave
- Persist `draft_unknown` / `schedule_unknown` before mutations; exceptions or absent readbacks never authorize replay
- Distinguish draft, review, scheduled, published and rejected observations; scheduled is not published
- Confirm the exact scheduled instant (explicit offset) on readback; mismatches remain unresolved
- Stop at login, CAPTCHA, new agreements, risk controls, quota notices or unknown UI
- Keep conflicting revisions and local account aliases from submitting the same account/book/chapter again

Exact frozen Markdown bytes are not silently stripped, reformatted or normalized. If the actual editor uses separate chapter headings or normalized rich text, introduce and review an explicit deterministic payload transformation with separately retained output bytes before live use. The current protocol intentionally fails equality rather than concealing changed text.

## Official evidence and constraints

### Native publishing workflow and state

[Current publishing help](https://fanqienovel.com/writer/zone/help/article?rank1=10006&rank2=10162&rank3=10166), updated 2026-09-07, describes editing then **Next** to open the publishing dialog. Serial-contract works can choose scheduled or immediate publication; the completed-work mode lists batch or immediate publication. Thus scheduling capability must be observed per book, not assumed globally.

[Scheduled-publishing guide](https://fanqienovel.com/writer/zone/article/7616317866916200472) gives the desktop route: workbench → work management → chapter editor → scheduled publishing → time. Review may take roughly 24 hours and preceding chapters can block later ones. Schedule changes are locked inside the final 30 minutes. These are workflow cautions, not a guarantee of timely publication.

[Chapter-state help](https://fanqienovel.com/writer/zone/help/article?rank1=10006&rank2=10162&rank3=10163) differentiates review, waiting for publication, published, rejection annotation and rejected. “Waiting for publication” can also accompany rejected author notes. The binding must inspect relevant details rather than equating a toast or this label with successful public release.

### Long-form publication quotas

[Second-edition long-form rules](https://fanqienovel.com/writer/zone/article/7639950766869839897) took effect 2026-05-22 and replaced the preceding edition. The embedded official table was visually inspected, not inferred from search snippets:

| Scope | Lv0–1 | Lv2–3 | Lv4+ |
|---|---:|---:|---:|
| New books per account/day | 1 | 1 | 1 |
| New books per account/month | ≤3 | ≤3 | ≤3 |
| Updated books per account/day | 1 | ≤3 | ≤5 |
| Submitted body characters per work/day | <10,000 | <20,000 | <50,000 |
| Submitted body characters per work/month | <250,000 | <500,000 | <1,000,000 |

The table uses strict `<` for character limits. Calendar days/months apply. Scheduled chapters reserve the scheduled date's book/character quota; moving to immediate transfers usage to that date. Rejected/deleted new chapters return character quota; all applicable new chapters rejected/deleted returns that work's update slot. Old-chapter additions count toward day/month characters; reductions do not refund them. Whole-book violation rectification is exempt from daily modification usage. Level changes apply immediately and can exhaust remaining monthly quota. Do not delete work to evade limits. The adapter does not hardcode these changing account rules or silently bypass an observed quota notice.

### Content, rights and automation uncertainty

[Originality/first-publication help](https://fanqienovel.com/writer/zone/help/article?rank1=10226&rank2=10227&rank3=0) requires appropriate original rights and explains exclusive-signing requirements and removal/release of prior external publication. Check the particular book's actual contract before transfer; publication automation does not resolve rights.

[February low-quality mass-production announcement](https://fanqienovel.com/writer/zone/article/7602950185735438398) addresses abusive mass-produced low-quality content, including AI-generated/spliced work. It is not a public API, an automation license, or evidence that every AI-assisted work is prohibited. The exact current AI-declaration UI and options were **not** observed; the port must truthfully map them after authorized inspection and stop if uncertain.

Neither native scheduling nor third-party plugin advertisements establish permission for unattended automated clients. The public [user agreement](https://fanqienovel.com/protocal/agreement) rendered only its title during this inspection, so its full automation terms were not verified. No assertion is made that Fanqie permits third-party bots. Verify current agreement/platform authorization before enabling a live binding; do not evade CAPTCHA, fingerprint checks or risk controls.

## Missing before live acceptance

1. User-reviewed sample and approved final chapter, exact existing account/book and intended schedule
2. Already-authorized session and actual live UI inspection, including stable account identity, contract mode, remaining quota, AI declaration, all inventory pages, editor and publish preview
3. A concrete `FanqieBrowserPort` calibrated from that inspection, owning and serializing one tab; fresh scope/blocker checks immediately before every type/click, no internal mutation retries
4. Explicit payload/heading conversion if needed; independent reopened draft-content readback, then scheduled timestamp/status readback; never trust a click result or toast
5. One authorized real draft test, duplicate invocation test, schedule submission and reopened list/detail verification. Public release remains a separate observed outcome

Session replacement, content edits after submission, schedule changes, deletion/retraction, batch publishing, authentication and agreement handling are deliberately outside this slice. They must not be smuggled through a retry. An unresolved attempt stays reserved until a separate explicit reconciliation workflow is implemented and verified.

## Local verification

`src/__tests__/fanqie-publishing.flow.test.ts` uses a synthetic port, including timeouts, delayed visibility, partial inventory, wrong account, stale revision, CAS competition, quota/CAPTCHA blocks and mismatched schedules. These are protocol regressions, **not live DOM or platform acceptance tests**. Existing manual-publishing tests remain applicable. Historical checks for the original browser-protocol slice: core 869 passed / 12 explicitly skipped, CLI 138 passed, Studio 339 passed; 44 focused publishing regressions independently repeated. Core and CLI TypeScript builds, Studio client/server builds, and all package typechecks passed using the installed tools directly. Studio retains its existing large-chunk build warning. No live platform test, repository CI, push, merge or deployment was performed.
