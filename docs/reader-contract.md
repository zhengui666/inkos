# Evidence-bound commercial story contracts

## Purpose and limits

New fiction defaults to readable commercial underdog storytelling, with recognizable genre pleasure, an original usable hook, concrete interests, protagonist contribution and a meaningful return. Explicit author direction and source canon override this default. The contract is inferred from the brief; it is not an author questionnaire.

This change does not alter an existing manuscript, create a real book, publish, change platform/account permissions or modify model configuration. Legacy books without a contract remain readable and are not migrated. Product model settings remain outside this change.

## Why a typed contract

Previously market recommendations supplied only concept and rationale; structured book rules had no reading promise; memos supplied only goal/body; reviews could return an empty list. Skills already mentioned commercial fiction, but the desired reading experience could disappear between stages. Automatic repair also always chose spot-fix, and a generic explicit repair instruction could prevent original findings reaching the reviser.

The new surfaces are:

- `RadarRecommendation.readerContract`: an original creative proposal, separate from ranking evidence
- `submit_foundation_outline.readerContract`: required for new foundation output; the host carries exactly this value into `book_rules.json`, subsequent foundation stages and cast context
- `BookRules.readerContract`: optional only for backward compatibility; `commercial-underdog` holds a reading promise and connected rise-route dimensions; `author-directed` records the actual alternative instruction
- `story/book_rules.json#readerContract`: a protected context source, included even if a semantic selector omits all outline sections
- `ChapterMemo.readerDelivery`: required by validation when planning a contracted commercial chapter; the plan includes role, concrete outcome, initiative, consequence and carry-forward. Legacy memos remain valid
- Existing-chapter reviews compare the original retained delivery with current instructions and prose. A plan is not proof of delivery

A rules edit that omits the new field preserves its previous value. Explicit replacement remains possible. Foundation revision supplies the previous structured contract alongside readable artifacts and latest feedback. Recovery retains any available partial rules instead of discarding them.

## No fixed plot order

The fields describe a causal network, not an ordered seven-step formula, paragraph template, chapter-count deadline or score. A mechanism can combine resource defense, skill discovery, survival improvisation, reciprocal relationships, systems, rebirth or other fitting genre devices. Help, luck and allies are permitted and their contribution should be attributed honestly. Limits need not mean suffering; light fiction need not manufacture punishment after each gain. An already-powerful character revealing a hidden position must not silently replace a genuine growth promise.

The first-ten-sentences instruction is a human-style reading window. It does not count punctuation, require a named villain or early victory, or use a keyword detector. Chinese character budgets and English word budgets retain their existing separate interpretation. Paragraph length is not a quality score.

## Independent review and bounded repair

For a contracted commercial chapter the reviewer must supply evidence-backed coverage for `reader-promise`, `opening-readability`, `opposition-stakes`, `protagonist-agency`, `earned-payoff` and `serial-prose`. Satisfactory findings use `observation`, actual defects use `issue`, and absent comparison evidence uses `unavailable`. Exact chapter lines are resolved into source quotes by existing host validation. Plan-only evidence cannot certify prose delivery. The host verifies source identity and coverage, never literary quality from a word count or regex.

Quality defects identify `repairScope`: `local`, `structural` or `foundation`. The autonomous path retains its bounded repair budget and separately reviews the resulting revision. Local defects use source-scoped edits; structural defects can rework the chapter; foundation defects block rather than silently changing accepted premise. Original diagnosis, repair layer and exact cited text reach the actual reviser. Unavailable review or execution failure is not permission to rewrite. Satisfactory coverage alone does not trigger an edit.

A caller explicitly requesting story completion can use `reviewChapter(workId, chapter, {requireStoryClosure: true})`. This adds mandatory `story-closure` evidence, independent of nominal target chapter count. It checks the actual central outcome and its consequence, while respecting an intentional open ending and optional future possibilities. A plan, a count or 'The End' is not closure evidence. Publication receipts and platform compliance remain separate requirements.

## Long-form review receipts

`ChapterReviewInputs` version 2 records exactly nine authoritative file inputs. Each field is required and holds the original file text or `null` for a missing file:

| Field | Source relative to the book directory |
| --- | --- |
| `plan` | `story/runtime/chapter-NNNN.plan.json` |
| `authorBrief` | `story/runtime/chapter-NNNN.user-brief.md` |
| `bookRules` | `story/book_rules.md` |
| `bookRulesJson` | `story/book_rules.json` |
| `authorIntent` | `story/author_intent.md` |
| `currentFocus` | `story/current_focus.md` |
| `styleGuide` | `story/style_guide.md` |
| `parentCanon` | `story/parent_canon.md` |
| `fanficCanon` | `story/fanfic_canon.md` |

Capture requires lossless UTF-8 and preserves whitespace, `null` and the empty string. Creation, deletion or any text change in any of the nine fields invalidates acceptance. Invalid UTF-8 cannot produce an acceptance receipt. Version 1, missing fields and future versions are not implicitly upgraded or accepted.

`reviewChapter` captures these values once. Composer's complete-context fast path and budget-limited selection path consume the same capture. When a capture override exists, a captured `null` means the source was absent; neither path rereads that source from disk. Reader-contract extraction parses the captured `bookRulesJson` through the existing book-rules and reader-contract schemas. Receipt equality compares the raw text, even when two versions parse to the same contract.

The receipt separately binds `reviewPolicy: { requireStoryClosure, language }`, using the actual closure requirement and `book.language` for that review. A change to either policy value requires another review before a new submission. The persisted receipt type permits missing inputs or policy only for reading legacy records and reconciling their retained attempts; every new acceptance requires valid version 2 inputs and a valid matching policy. Receipt validity also remains tied to the retained chapter revision and source-supported review result.

The autonomous path checks the captured inputs and policy after review, after publication preflight and before publication mutations. Submission has a final authorization boundary: after asynchronous browser, revision, snapshot and dialog preparation, the production Confirm path calls `beforeMutation.authorizeSubmission` synchronously to compare the nine nullable raw inputs and the review policy again. That check and the call issuing the Confirm request share one host call stack, with no intervening host `await`. A mismatch or unreadable input rejects authorization before that request is issued.

This boundary governs the host's submission request. It does not make local file reads and a remote DOM click atomic, linearize raw file writes from other processes or prevent an external edit after authorization. The nine file reads are not a filesystem transaction. Changes made during asynchronous preparation are checked again at final authorization; no stronger cross-process or remote atomicity is claimed.

A review-input or policy mismatch detected before submission returns a verified retained draft to review only through the recovery rules below. Invalidating review retains the publication start time, publication evidence, retained revision, frozen package and remote chapter identity, and does not reset the review or repair budgets. Re-reviewing the same prose reuses its existing remote draft.

Publication first reconciles the retained attempt. Submitted or unknown outcomes are checked against the original frozen package and revision; changed local inputs cannot turn them into a new upload or submission. For a retained attempt, only an outcome positively identified as a draft permits validation of current review inputs before a later mutation. Completed jobs remain completed across restart. Review acceptance does not itself prove remote publication.

The DOM and CDP layers use `MegaNovelSubmissionBlockedError` for a guard or preflight rejection only while they can establish that the submission request has not been invoked. The adapter may restore its original draft reservation and propagate that rejection only when this typed no-submission evidence belongs to the current attempt, a compare-and-swap check still identifies this attempt's `submit_unknown` reservation, and an independent readback proves the exact retained remote draft. Recovery preserves the package, revision and remote chapter identity. An arbitrary guard error, a transport failure after dispatch or a draft-looking remote result alone cannot clear an unknown submission; that attempt remains subject to reconciliation.

This receipt covers only the nine authoritative inputs above and the separate review policy. It does not freeze previous chapters, role cards, current-state facts, outlines, memory or every other Composer input. Generated context and intent projections are not authoritative receipt inputs; changing them alone does not invalidate acceptance. Short-fiction caches and model configuration remain outside this mechanism.

## Research basis and boundaries

The method draws on publicly accessible official openings and editorial guidance, not copied scenes or a claimed sales algorithm:

- Resource conflict and early retaliation: [无敌天命, chapter 1](https://read.zongheng.com/chapter/1336976/78192214.html)
- Skill discovery and a usable first return: [The First Legendary Beast Master, chapter 4](https://www.webnovel.com/book/the-first-legendary-beast-master_28706406900589905/windspeed-hawk_77223075640297983)
- Survival pressure, limited leverage and cooperation: [Shadow Slave, chapter 4](https://www.webnovel.com/book/shadow-slave_22196546206090805/mountain-king_59657619828170380)
- Reciprocal value, protection and competing interests: [明君, chapter 2](https://read.zongheng.com/chapter/1610880/110589962.html)
- Concrete interests and logical counteraction: [番茄 official writing lesson](https://fanqienovel.com/writer/zone/article/7614020727024386110)
- Innovation and sustained emotional return: [MegaNovel official 2026 contest](https://www.meganovel.com/contests/meganovel-writing-contest-2026)

Limited opening samples support opening and early-return observations. They do not validate a whole-book formula, short-fiction pacing, a numeric release score, audience retention or revenue prediction. Current implementation languages are Chinese and English; other markets remain uncalibrated.

## Verification

`reader-contract.flow.test.ts` exercises actual schema validation, staged foundation, disk persistence, protected context, planning, writer prompt assembly, source-bound review and real reviser prompt transport with an isolated deterministic model peer. It includes legacy compatibility, author-directed override, omitted rules-field preservation, stale or unavailable evidence and explicit terminal closure. Autonomous repair routing and existing prompt-budget boundaries are covered separately.

Long-form receipt regression coverage uses `review-input-receipt.flow.test.ts`, the actual Composer paths in `composer-selection-budget.test.ts` and `reader-contract.flow.test.ts`, and the autonomous and scheduler-publisher tests. It checks raw input identity, captured-value transport, policy changes, mutation guards and recovery of retained publication attempts with deterministic local fixtures.

These tests prove contracts and failure behavior, not that generated prose is engaging. Before claiming content improvement, run independent blinded baseline/candidate generation and semantic reading using varied original briefs. Preserve failures and evaluate actual event clarity, motive, contribution, return and language naturalness. Do not reuse author self-ratings as independent evidence.
