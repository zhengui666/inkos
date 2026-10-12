---
name: inkos-story-import
description: 导入已有小说、逆向重建设定与续写工程，并区分母本参考。Use for importing manuscripts or attaching external canon safely.
---
# Story import and reconstruction

Use this skill when the user wants an existing manuscript to become an editable, continuable InkOS project.

- Determine the user's intent before acting:
  - Manuscript import saves real content revisions through the artifact service/CLI `import` or explicit `content_create` input; inspect evidence before reconstructing domain state.
  - `materials_ingest`: the text remains reference material only.
  - `work_update`: selected material IDs and their purposes guide subsequent creation without automatically becoming canon.
- Preserve chapter order with natural chapter-number ordering. Confirm the continuation point when the active book already has chapters.
- Never treat a user's own manuscript as an imitation target by default.
- After import, report imported chapter count, detected gaps, reconstructed facts, uncertainties, and the next safe continuation point.
- Do not invent missing canon to make the project look complete. Mark uncertainty for later confirmation.
- For fan-fiction canon extraction, preserve world rules, character identity and voice evidence, key-event order, information boundaries, capability limits, and observable style traits. Cite only supplied evidence; mark absent material as unknown instead of inferring it.
- Respond in the user's language.

Load `references/reconstruction-rubric.md` for large or inconsistent manuscripts.
