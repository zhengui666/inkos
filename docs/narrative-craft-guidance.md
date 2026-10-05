# Mode-aware narrative craft

The built-in `short-fiction` and `longform-novel` profiles combine their existing mode-specific writing Skill with the existing `inkos-story-deslop` prose method. This is prompt guidance inside the current operation, not a new workflow engine, automatic rewrite, detector, or publishing action. Other profiles are unchanged. Project Skills can replace a built-in Skill by id; a custom profile can select its own required methods.

## Shared method and mode differences

- Shared: diagnose a concrete loss of story function before changing prose; preserve accepted voice, facts, viewpoint, knowledge, motive, chronology, objects, and setup/payoff; repair the smallest authorized scope and recheck consequences
- Short fiction: an obstructed goal and opposing aims made visible in the opening, active choices, changing stakes, and a focused conflict with a complete emotional payoff; explicit alternative ending/genre choices remain authoritative
- Long fiction: an active protagonist goal, sustained progress and earned stage payoffs, distinct voices and motivated change over time, carried-forward knowledge and consequences, and independent long-range promises across chapters and arcs
- Planning can compare unsettled titles or openings, build a skeleton, draft scenes, review, and target repairs. These are skippable methods within the active operation, not compulsory new steps or reasons to reopen accepted choices
- Chinese fiction defaults to commercial web fiction when the author has not specified another creative target. Clear conflict, protagonist agency and emotional return take priority over neutral observation. Explicit literary, quiet, tragic or other non-commercial intent overrides this product default. Quiet scenes, lyricism, direct thought and functional repetition can serve buildup, cost, attachment and release; prose cleanup preserves the desired dramatic intensity

Hook intervals, dialogue ratios, word bans, and chapter or scene counts are not universal quality gates. An explicit author constraint still applies. Names of platforms or genres do not imply numerical quotas. Model-predicted completion rates, authorship judgments, AI-detector scores, and platform acceptance are not outcomes this guidance establishes.

## Source record

Reviewed on 2026-10-03. The guidance independently restates transferable craft ideas; it does not import source examples, distinctive prose, code, private tutorials, or executable dependencies.

1. 洗刷刷呀, [《番茄短篇特化的ai提示词工程分享》](https://www.xiaohongshu.com/explore/6aa24696000000002603b65a). All 24 supplied post images were inspected. Used the flexible progression from premise and opening comparison through causal planning, drafting, review, and targeted revision. The user's current creative target adopts its commercial opening/conflict and emotional-payoff priorities without treating one plot type as universal; numerical prescriptions remain optional; claims about distribution algorithms, fixed thresholds, predicted reader completion, or required paid cleanup tools are not treated as verified product requirements. No post images or copied post text are bundled.
2. chaserr/novel-craft, [novel polishing Skill](https://github.com/chaserr/novel-craft/blob/cd9d308d46b4d19286db03e1082f2e2c3064b1b2/skills/zh-novel-polish/SKILL.md), commit `cd9d308d46b4d19286db03e1082f2e2c3064b1b2`; [MIT license](https://github.com/chaserr/novel-craft/blob/cd9d308d46b4d19286db03e1082f2e2c3064b1b2/LICENSE), copyright 2026 chaser. Used diagnosis before minimal revision and preservation of plot, voice, and setup. Excluded hard word/sentence/edit-percentage limits and private reference dependencies.
3. HZ-KMNO/web-novel-writing-guidance-skill, [Skill](https://github.com/HZ-KMNO/web-novel-writing-guidance-skill/blob/24dd6d40099c97c3120dc37942e8dc99263c0259/SKILL.md), commit `24dd6d40099c97c3120dc37942e8dc99263c0259`; [MIT license](https://github.com/HZ-KMNO/web-novel-writing-guidance-skill/blob/24dd6d40099c97c3120dc37942e8dc99263c0259/LICENSE). Used cause-and-effect writing and fluent Chinese rather than broken fragments. Excluded its genre-specific progression package, private tutorials, and imitation of individual authors' wording or voices.
4. renky1025/agent-skills, [prose cleanup](https://github.com/renky1025/agent-skills/blob/32ce6c04a9c0627343da024b678e05dcacaa17a5/de-ai-writing/SKILL.md) and [structural writing](https://github.com/renky1025/agent-skills/blob/32ce6c04a9c0627343da024b678e05dcacaa17a5/snowflake-novel-writer/SKILL.md), commit `32ce6c04a9c0627343da024b678e05dcacaa17a5`; [MIT license](https://github.com/renky1025/agent-skills/blob/32ce6c04a9c0627343da024b678e05dcacaa17a5/LICENSE), copyright 2026 Kangyao. Used function-led cleanup and optional structural planning. Excluded mandatory deletion percentages, opinion-first or forceful tone, and a mandatory act structure.
5. jiji262/humanizer-chinese, [Skill](https://github.com/jiji262/humanizer-chinese/blob/1d6c08e10fbfe0e1b36ac784834451c6aae0a92c/SKILL.md), commit `1d6c08e10fbfe0e1b36ac784834451c6aae0a92c`; [MIT license](https://github.com/jiji262/humanizer-chinese/blob/1d6c08e10fbfe0e1b36ac784834451c6aae0a92c/LICENSE). Used context-sensitive handling of candidate prose patterns and protection of natural Chinese expression. Excluded frequency limits and model-fingerprint claims. General expository advice was not applied wholesale to fiction.

The upstream MIT licenses do not grant rights to third-party literary works or private tutorials referenced by those repositories. InkOS does not bundle them; its existing project license is unchanged.

## Creative target and sample feedback

The initial delivered samples preserved continuity and natural expression, but the user found their creative direction too restrained for the intended web-fiction reading experience. The correction is to restore conflict, active pursuit and tangible emotional reward, while keeping genre variety and author authority. This is a product/default-target decision supported by the user's feedback, not a claim that all readers prefer one kind of fiction.

Sample inputs should state the desired payoff and immediate goal clearly, while keeping essential canon in one authoritative context instead of repeating a dense constraint list across rules, memos and instructions. Technical accuracy or an absence of prose defects does not by itself establish that the story delivers the requested pleasure.

## Verification boundaries

`writing-guidance-routing.test.ts` exercises actual worker message preparation, mode selection, linked resources, author authority and targets, custom overrides, and isolation from other profiles and read-only semantic mechanics. Existing Skill and production contract tests cover regression. These tests use no model calls and establish prompt-routing behavior only.

Literary quality requires a separate evaluation on original passages not used to derive these instructions: different genres, short and long form, quiet and high-pressure scenes, deliberate stylistic exceptions, and continuity across chapters. Compare source and revised text, inspect evidence-backed diagnoses and protected facts, and separate reader preference from objective continuity defects. Passing routing tests does not establish better prose, detector performance, completion rates, or platform acceptance.
