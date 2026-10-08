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

These tests prove contracts and failure behavior, not that generated prose is engaging. Before claiming content improvement, run independent blinded baseline/candidate generation and semantic reading using varied original briefs. Preserve failures and evaluate actual event clarity, motive, contribution, return and language naturalness. Do not reuse author self-ratings as independent evidence.
