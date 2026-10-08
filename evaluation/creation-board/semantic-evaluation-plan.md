# Inkos story engine: bounded semantic before/after evaluation

Status: proposed, not run. No external model session, private manuscript, publishing account, or production book is used. Passing TypeScript/protocol tests does not establish improved fiction.

## Question and stopping condition

Does the frozen candidate improve intelligible causal events, interests and opposition, an attractive opening reading window, familiar genre pleasure, and colloquial target-language prose compared with baseline 04238c5a0d938b3acd8c319fc78d25b7c3d27447, while honoring explicit author direction?

Run one paired generation per brief below, with the required model gpt-6.1-sol, reasoning effort ultra, and service tier priority. Pin the same available model version, book-length targets and host output admission settings. The native Codex runtime does not expose temperature or a deterministic seed here; record this nondeterminism and do not imply paired seeds or a provider billing cap. The fixed first pass ends after four two-chapter pairs and two one-chapter control pairs (20 chapters total), independent blind reading, and a defect ledger. Do not run repeated samples until the desired verdict appears. If a repair is warranted, one selected defect case may be rerun as a separately labeled iteration, not substituted for the first result.

Save baseline and candidate outputs in disposable, separately identified work directories. Record exact version/path manifests and bytewise source comparisons, actual prompts, runtime, completion status, token usage, and any retries. Use only disposable evaluation projects, keep production manuscripts out of the experiment, and do not infer authorization to publish.

## Original briefs

These briefs are newly authored test inputs, not adaptations of the researched novels or the implementation's mocked fixtures. They intentionally leave the mechanism to the engine. Each pair receives identical input.

1. Chinese, urban practical-competence rise, two chapters of approximately 1800 Chinese characters each: 夜班洗衣工发现医院外包洗衣房把合格布草报成废品转卖，老板却要她赔一车货。写一个明白好懂、说话像普通人的底层翻身爽文。第一轮回报在第二章兑现：她必须靠自己采取的行动保住工作以外的一项真实利益，不能靠突然出现的富豪亲属。
2. Chinese, fantasy/rebirth, two chapters of approximately 1800 Chinese characters each: 山城药铺的小杂役重活到第一次试药前一天。他只记得上一世一场失败的结果，并不知道全部原因。写大众玄幻爽文，允许强金手指，但要让读者看懂他如何用这点信息争到第一份自己的资源，第二章有可见小回报。
3. English, survival progression, two chapters of approximately 1000 words each: A flood-tunnel cleaner can briefly hear which old valves are still under pressure. During an evacuation she is barred from a dry shelter because she has no guild credential. Write accessible commercial progression fiction; earn a concrete improvement by the end of chapter two without making everyone cruel or letting the ability solve every problem.
4. English, relationship-based rise, two chapters of approximately 1000 words each: An itinerant kitchen porter recognizes why a coastal town's food ledger cannot match the meals served. A recently appointed magistrate needs the answer but cannot openly trust him. Write a satisfying low-status rise driven by bargaining and decisions; the first two chapters should earn him one durable choice he did not have before, with both sides' interests clear.
5. Explicit-direction control, English, one chapter of approximately 1000 words: The protagonist already owns her ferry and has won the route dispute. Write a warm, funny aftermath chapter in which she takes her estranged brother on the first legal trip. Keep her established success intact. No new villain, poverty reset, public humiliation, surprise debt or cliffhanger is wanted.
6. Mystery-direction control, Chinese, one chapter of approximately 1800 Chinese characters: 底层保安接到一位已故住户的正常报修电话。他想保住当晚的工作，也怕让邻居遇险。写通俗悬疑开篇，让当下行动明白、人物说人话；本章只兑现一条可以核查的新线索，不揭真相，不强加系统、打脸或升级。

The listed counts are equal experimental production budgets, not literary scores. Preserve and report provider output-limit failures separately from readable completed chapters.

## Blind reading procedure

Randomize A/B order for each case and hide build identity, generated plan, reviewer result and prompt-derived checklist from the first reader. Give only the brief and prose. Readers should not be the generation run's own self-review. Use two independent readers, with at least one human/native or proficient target-language reader before claiming a real reader-quality improvement. Without human reading, label the result independent model assessment only.

For each version, the reader records:

- Opening: paraphrase the first roughly ten natural sentences in one or two sentences; what is happening, what matters now, and what question makes continuation attractive? Cite confusion rather than count keywords or insist on every element appearing by sentence ten
- Interests and opposition: what each relevant party wants, what they control, and why the protagonist cannot ignore the situation; note an impersonal force where appropriate
- Causality and initiative: reconstruct opportunity → choice/action → consequence using the actual text; state what help/luck supplied separately, without requiring this to be the scene order
- Payoff: what has actually changed by the agreed window, why it matters, and whether chapter two retains prior gains; distinguish planned, observed, deferred and unknown
- Prose: cite any confusing references, unnatural translated slogan, expository dialogue, decorative abstraction or procedural narration; preserve intentionally energetic drama and justified quiet scenes
- Continuation: choose A, B, tie or neither, with reasons and uncertainty; preference is not a revenue/retention prediction
- Direction controls: specifically check that existing success, a quiet aftermath, and a mystery's unexposed explanation survive intact

Only after this first pass show the plans/contracts. Check whether planned achievements are being claimed as delivered and whether a missing payoff is actually due. Keep the initial blind verdict unchanged; add the comparison as a separate annotation.

## Interpretation and repair routing

Keep per-case evidence and adverse cases, not an uncalibrated total score. A candidate can improve one dimension while damaging another. Investigate source-supported local prose defects with a narrow rewrite; missing choices or broken scene logic require structural repair; a contradicted premise requires author review before foundation changes. Re-read the repaired source and compare protected text where appropriate.

A useful result is a transparent answer about these six cases and the regressions found. It is not proof of general superiority, market fit, bestseller likelihood, or reader retention. Stop at that bounded conclusion and choose further work only from observed defects.


## Product runner and execution commands

`run-semantic-fixture.sh` uses the real product CLI paths `init`, the safe native account/catalog preflight, `book create --brief`, and `write next --context-file`, which must be verified against the selected source version. It runs one chosen fixture in a new isolated project and never invokes publishing, a daemon, or notifications. It refuses an existing run directory and checks the exact requested account/model/effort/tier readiness before inference. A successful syntax check or dry run does not establish a successful build or real model execution; record those stages separately.

Required before execution: frozen and built baseline/candidate CLI artifacts from their own dependency graphs; a verified existing source project and an explicitly authorized Inkos account home on the selected execution environment; no copying credentials, no substituting a personal Codex home, and no login/security changes. Check that each selected CLI `dist/index.js` exists and that the intended model account is authorized and ready. If either check fails, stop before inference and record the blocker. A matching model setting is not proof of login or quota.

Run dry only:

```sh
bash run-semantic-fixture.sh --dry-run case-01 baseline
```

After verifying runner identity and account authorization, execute one case (the same commands apply to the candidate with its own compiled CLI and a different fresh output directory):

```sh
INKOS_CLI=/verified/baseline/packages/cli/dist/index.js \
INKOS_CODEX_HOME=/verified/authorized/inkos-account-home \
INKOS_SOURCE_PROJECT=/verified/existing/service-project \
RUN_ROOT=/new/isolated/semantic-eval/baseline-case-01 \
bash run-semantic-fixture.sh --execute case-01 baseline
```

Repeat explicitly for `case-01` through `case-06` and both build labels. There is no automatic retry loop or hidden extra generation. Retain failed cases and their logs. Review the resulting actual prose under `project/works/*/source/chapters/`; model reviews are auxiliary evidence, not the blind reader verdict. The supplied titles are held constant across each pair, so this experiment does not establish improved automatic title selection or market-radar quality.

### Build prerequisites and source provenance

Use an authorized execution environment with the project's supported toolchain. Keep both product runs on the pinned gpt-6.1-sol / ultra / priority settings specified for this experiment. Record any unavailable prerequisite rather than silently substituting a different model or execution route.

Build each version in its own isolated source tree after verifying the required toolchain/dependencies and exact version manifest:

```sh
bash build-evaluation-cli.sh /verified/isolated/baseline-source
bash build-evaluation-cli.sh /verified/isolated/final-integrated-candidate-source
```

The build helper runs the repository's normal `pnpm build` and checks the expected Core/CLI outputs. It does not install software, fetch credentials or start inference. Record its actual build result for each selected source version. Missing dependencies, unsupported Node/pnpm, missing authorized Inkos account access, or an unverified candidate snapshot are explicit blockers. Do not silently use a different source build, downgrade model settings, copy authentication files, or point at a private book.

Each version must include a complete clean source package or a reproducible base plus its complete changed/deleted-file manifest and patch series. A partial prompt overlay is not a substitute for the corresponding full product version. Verify local materialization, build output and source identity before inference; copying files alone does not establish those stages.

## Separate two-field intake experiment

`run-intake-first-chapter.sh` and its `.mjs` implementation exercise the final product's actual CreationTaskStore → CreationPlannerAgent/Coordinator → foundation → AutonomousChapterRunner → first-chapter review. The original fixture contains an explicit language correction and chapter-count correction that conflict with provisional defaults, plus story constraints. It records the resolved plan and original-brief retention before writing. It does not replace the blinded engine comparison above.

```sh
INKOS_CLI=/verified/final-integrated-candidate/packages/cli/dist/index.js \
INKOS_CODEX_HOME=/verified/previously-authorized/inkos-account-home \
INKOS_SOURCE_PROJECT=/verified/existing/service-project \
RUN_ROOT=/new/isolated/intake-first-chapter \
bash run-intake-first-chapter.sh --execute
```

Review the helper against the exact selected source/build and validate its shell/JavaScript syntax and dry-run branch before any real execution. Record real inference as unrun until it actually completes. It follows the creation task's scoped execution policy and retains the result of the first runner invocation; transient failures are recorded rather than hidden by a fresh task or automatic retry loop.

The publication adapter is deliberately omitted. The product chapter runner may issue a local review receipt, but this experiment does not mark the creation task published/completed, does not manufacture a mock publication receipt, and cannot certify Studio HTTP/UI behavior. The output `intake-report.json` explicitly records publicationTested=false. Check the actual first chapter against the listed semantic constraints independently; a valid plan object or retained brief is not proof that prose follows it.

Real platform publication requires a separately validated, platform-permitted publishing workflow, an authorized account and explicit destination, and actual platform readback. The existing adapter's new-book and empty-book first-chapter limits still apply. Publication is outside this experiment and remains untested by it. Mock adapters, if used elsewhere, establish protocol behavior only.


## Safe existing-runtime preflight

Use `safe-runtime-preflight.mjs` before any real generation. It emits only allowlisted JSON, checks saved Codex settings and the account/model catalog without inference, and does not change settings or copy credentials. Use its exit status, not doctor output or doctor exit 0. See `safe-runtime-preflight.md` for the exact command and optional comparison with a verified running Studio PID. An app-server closure, missing RPC result, and missing/unusable authentication are different states. Do not switch accounts to bypass a failed readiness check.

The generation shell helpers now require `INKOS_SOURCE_PROJECT`. They check the existing authorized service project first, before creating the isolated evaluation project, then check that isolated project again. Optional `INKOS_STUDIO_PID` compares the existing service launch context and stops on a mismatch. The native runtime can write temporary/cache state while the account/catalog operations remain read-only; no inference or login is performed by the preflight itself.
