# Prose authority A/B contract

Status: **not run**. No model-generated candidates, reader preferences, or aesthetic scores accompany this change. The automated regression uses fixed model responses; it verifies wiring, evidence preservation, and state reduction only.

## Question and scope

Does separating events that must happen from background constraints that must remain consistent reduce procedural recitation and repeated explanation, without losing narrative facts or the author's voice?

- Control: commit `fbbce82`.
- Treatment: the same commit plus only this prose-authority patch: `writer-prompts.ts`, `inkos-long-writing/SKILL.md`, and its `references/state-projection.md`.
- Hold the shared Skill loader, planner code, memo, context selection, model, and all other code fixed. The treatment is a small prompt/Skill bundle; this pilot cannot attribute effects to an individual sentence.
- Scope is wider than writer-only: the long-writing Skill is shared by architect, writer, auditor, and reviser operations, and the state-projection reference reaches settlement through current hydration. Those consumers can receive changed guidance without any change to their code. The pilot freezes already-prepared planning/memo inputs to isolate short-passage drafting; it does not establish behavior or quality across all shared-Skill consumers.
- This experiment neither rewrites accepted chapters nor updates live state. Run each candidate in a disposable copy and store results outside the source manuscript and repository. Do not publish private passages.

## Why this intervention

[Re3](https://aclanthology.org/2022.emnlp-main.296/) separates planning, context-conditioned drafting, and factual consistency revision. [DOC](https://aclanthology.org/2023.acl-long.190/) studies detailed planning and outline control. They support keeping coherence controls; they do not validate this patch or establish that repeating a plan produces better prose. Our implementation hypothesis is narrower: an instruction requiring every populated memo item to appear in prose may confuse background constraints with visible narrative events.

The current loader loads literal reference links regardless of the conditional prose around those links. Whether that increases manual-like narration remains a hypothesis. Freeze it in this pilot rather than changing both loader behavior and prose authority at once.

## Six preselected pairs

Freeze six short passage packets before viewing any candidate:

1. Two procedure-heavy passages: an actual payment/handover and a different routine with an unresolved obligation.
2. Two dialogue conflicts: characters with different aims and knowledge, where an explanation would cost them something.
3. Two endings from consecutive chapters: include each previous ending so repeated closing gestures or summaries are detectable.

Use actual author-approved context when available, in private packets. Do not substitute a hand-polished demonstration for a generated arm. A shorter demonstration is not an equal-length comparison. If fewer than six complete packets are available, keep missing pairs marked `not_run`; do not fabricate source passages or treat one pair as the entire pilot.

Each packet freezes: source identifier and revision/hash; preceding and following context; user instruction; memo; selected context; book rules and style guide; opening state and hooks; target length and counting mode; expected event, object, time, knowledge, and money constraints. Both arms receive identical bytes for all these inputs. Never let the candidate output become the other arm's context. For the endings, hold the previous accepted chapter fixed in both arms; this tests a local ending, not divergent multi-chapter rollouts.

## Execution contract

1. Record exact control/treatment commits, model identifier and version where available, provider, sampling parameters, reasoning settings, output budget, and seeds when supported. Model selection remains the user's existing selection. Do not change credentials or configure a provider for this pilot.
2. Capture and hash the actual prepared worker messages, including hydrated Skill resources. Verify that differences are restricted to the three treatment files. Fail the comparison if a project Skill override masks the treatment or if extra context, compression, or a changed loader introduces another difference.
3. Use the same passage instruction, target length, and hard range in both arms, measured with the production `countChapterLength` counting mode. Default pilot range: target ±10%, unless the author has already set another range. Require both to fit before preference comparison. Report length failures rather than secretly trimming or padding.
4. Generate one candidate per arm per packet; interleave which arm runs first. If a provider transient error requires a retry, preserve the log and mark the failed attempt as technical, not an aesthetic rejection. Do not cherry-pick the best of extra treatment runs.
5. Use fresh sessions and disposable state for every arm. No accepted chapter save, live-state application, publishing, or submission. Preserve raw outputs and errors. Record actual token use and wall time separately from quality.
6. Randomize neutral display labels and side order, keeping the arm mapping hidden from readers until their judgments are recorded. The source packet and factual constraints can be shown equally to reviewers; the prompt/Skill change should not be revealed during preference review.

## Gate 1: facts and settlement

Review candidate prose against the frozen packet before considering style. For each finding, cite an exact candidate sentence and the source fact. Allow `pass`, `fail`, or `uncertain`, with a reason. An uncertain factual result cannot establish safety.

- Required events, choices, and consequences remain present and recognizable.
- A payment receipt is distinguishable from an offer, invoice, or promise. The recipient, amount, and pending balance are unambiguous where needed.
- Actual items handed over, items retained, event order, and time boundaries remain correct.
- Characters gain only information they could have acquired; viewpoint and explicit prohibitions hold.
- Existing hook identity/lifecycle and unrelated facts remain unchanged unless the passage supports the change.

Run the real settler on each candidate in a disposable copy and inspect its delta against the baseline. For generation preference, use the same frozen settler configuration for both arms; separately run the treatment settler on the treatment output as an integration safety check. Record both configurations so a prose effect cannot be confused with a changed extraction prompt. A mocked delta is not evidence that the model can extract the transaction.

Synthetic accounting stress case (a ceramic workshop order, unrelated to any private manuscript): opening cash `8400` already includes a `90` prepayment; completed income `2100` excludes an order priced at `360`. An actual `270` final receipt plus completed delivery, with no other transactions and explicit recognition rules, yields cash `8670`, completed income `2460`, and no pending balance or unearned prepayment. The original `90` must not be received twice. In the negative case, payment is only promised and no delivery occurs, so neither cash nor completed income advances under this recognition rule. A delivered-but-unpaid order is a different case: income may be recognized with a receivable, so absence of cash alone must not block income recognition. If recognition or other transactions are ambiguous, do not invent closing amounts. Narrating every cumulative total is not required; evidence for the actual change is required.

## Gate 2: author preference

Only compare fact-safe, in-range candidates. Ask the author to select `left`, `right`, `tie`, or `neither`, followed by a short reason and the line(s) that drove it:

- Does the scene feel lived rather than explained after the fact?
- Is information doing work once, rather than being repeated as narration, dialogue, and summary?
- Do characters have distinguishable attention, aims, and ways of speaking?
- Are procedure and quiet moments proportionate to the pressure of the scene?
- For endings, does the stop belong to this scene rather than repeat a closure formula?

No banned-word count, rare-word rate, sensory-detail quota, or model self-score serves as an acceptance criterion. A model critique may surface candidate lines for review but cannot replace author preference. Preserve legitimate repetition, abstraction, and silence when they serve the intended voice.

## Result record and stop condition

For every pair retain: packet hash, both prepared-input hashes, commit/model settings, raw candidates, measured lengths, actual generation status, fact findings with sentence evidence, both settlement checks, blind display mapping, author preference and reason. Missing results stay `null` or `not_run`, never zero scores.

Stop after the six preselected pairs or when authorization/input is missing. Report all failures and `neither` judgments. This small diagnostic pilot cannot establish statistical significance. Keep the patch experimental if facts regress, preferences are mixed, or the author has not evaluated it. Any later broader generation, default rollout, or accepted-manuscript revision requires its own authorized scope.

## Automated coverage shipped with the patch

`packages/core/src/__tests__/writer-prose-contract.flow.test.ts` covers both language contracts, actual Work-profile/Skill hydration, unchanged memo/context/author instructions, writer-to-settler evidence transfer, already-received prepayment versus final receipt, a promised-payment-without-delivery negative case, stable hooks and unrelated facts, and unchanged stored source/state. Its supplied creative and settlement outputs are synthetic fixtures. Passing it is a protocol/state regression result, never a prose-quality result.
