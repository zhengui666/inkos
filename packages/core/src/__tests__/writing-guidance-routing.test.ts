import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareWorkerMessages } from "../agents/base.js";
import { buildWriterSystemPrompt } from "../agents/writer-prompts.js";
import { createBuiltInWorkProfileRegistry } from "../harness/builtin-profiles.js";
import { withExecutionEvidence } from "../harness/execution-evidence.js";
import { createWorkManifest } from "../harness/work-store.js";
import { buildShortFictionWriterSystemPrompt, buildShortFictionWriterUserPrompt } from "../prompts/short-fiction.js";
import { loadAvailableAgentSkills, resolveProfileSkillActivations } from "../skills/index.js";
import type { LLMClient, LLMMessage } from "../llm/provider.js";
import type { WorkProfile } from "../harness/contracts.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const profiles = createBuiltInWorkProfileRegistry();
const sharedSkill = "inkos-story-deslop";
const writingModes = [
  { profileId: "short-fiction", skillId: "inkos-short-writing", otherSkill: "inkos-long-writing", reference: "production-checklist.md" },
  { profileId: "longform-novel", skillId: "inkos-long-writing", otherSkill: "inkos-short-writing", reference: "reader-contract-and-progression.md" },
] as const;

async function fixture(profileId: string, language: "zh" | "en" = "zh") {
  const root = await mkdtemp(join(tmpdir(), "inkos-writing-guidance-")); roots.push(root);
  const work = createWorkManifest({ id: "fixture", title: "Routing fixture", profileId, language });
  const profile = profiles.require(profileId);
  const client: LLMClient = { provider: "openai", apiFormat: "responses", stream: true,
    defaults: { temperature: 0, maxTokens: 16384, thinkingBudget: 0, extra: {} }, _codex: { projectRoot: root } };
  return { root, work, profile, client };
}

type AppliedSkill = { id: string; references: Array<{ path: string }> };
async function prepare(input: Awaited<ReturnType<typeof fixture>>, messages: LLMMessage[], options: {
  authorRequest?: string; worker?: string; professionalGuidance?: boolean; scopedProfile?: WorkProfile; native?: boolean;
} = {}) {
  const applied: AppliedSkill[][] = [];
  const client = options.native === false ? { ...input.client, _codex: undefined } : input.client;
  const prepared = await withExecutionEvidence((type, payload) => {
    if (type === "skills-applied") applied.push(payload.skills as AppliedSkill[]);
  }, () => prepareWorkerMessages({ client, projectRoot: input.root }, messages, 1024,
    options.worker ?? "writer", options.professionalGuidance ?? true),
  options.scopedProfile ?? input.profile, input.work, options.authorRequest);
  return { messages: prepared, content: prepared.map(message => message.content).join("\n"), skills: applied[0] ?? [] };
}

// These fixtures verify actual worker prompt assembly, not prose quality or reader preference.
describe("mode-aware narrative guidance routing", () => {
  it.each([
    { profileId: "short-fiction", language: "zh", genre: "悬疑", target: 1200, direction: "单章悬疑短篇，保留已定开放结尾，只写1200字。" },
    { profileId: "short-fiction", language: "zh", genre: "生活", target: 600, direction: "600字安静生活短篇，保留长句和直接心理描写，不强加反转。" },
    { profileId: "short-fiction", language: "en", genre: "science fiction", target: 900, direction: "Write a 900-word standalone science-fiction story with sparse dialogue and a settled ending." },
    { profileId: "longform-novel", language: "zh", genre: "历史", target: 2800, direction: "只写长篇第19章2800字，保留人物知识边界，不提前回收下一卷伏笔。" },
    { profileId: "longform-novel", language: "zh", genre: "家庭", target: 3200, direction: "只润色长篇本章3200字，保留已认可的抒情文风及上一章的关系变化。" },
    { profileId: "longform-novel", language: "en", genre: "comedy", target: 1800, direction: "Write only chapter 7 of the comic novel, 1800 words; retain the narrator's intentional repetition." },
  ] as const)("routes $profileId / $genre without changing the author's target", async item => {
    const input = await fixture(item.profileId, item.language);
    const mode = writingModes.find(mode => mode.profileId === item.profileId)!;
    const system = item.profileId === "short-fiction" ? buildShortFictionWriterSystemPrompt(item.language)
      : buildWriterSystemPrompt({ id: "fixture", title: "Routing fixture", genre: item.genre, platform: "other", language: item.language,
        status: "active", targetChapters: 50, chapterWordCount: item.target, createdAt: "2026-10-03", updatedAt: "2026-10-03" },
      null, "Preserve accepted facts.", "Preserve the author's chosen voice.");
    const user = item.profileId === "short-fiction" ? buildShortFictionWriterUserPrompt({ direction: item.direction,
      outlineMarkdown: "Accepted causal plan; keep its ending.", chapterCount: 1, charsPerChapter: item.target, chapterNumbers: [1] }, item.language)
      : item.direction;
    const result = await prepare(input, [{ role: "system", content: system }, { role: "user", content: user }], { authorRequest: item.direction });
    expect(result.messages.some(message => message.content === user && message.role === "user")).toBe(true);
    expect(result.content).toContain(system);
    expect(result.content).toContain(item.direction);
    expect(result.content).toContain(String(item.target));
    expect(result.content).toContain("user's actual request");
    expect(result.content).toContain("not author intent, canon, an output-format override");
    expect(result.skills.map(skill => skill.id)).toEqual([mode.skillId, sharedSkill]);
    expect(result.content).not.toContain(`### ${mode.otherSkill}`);
    expect(result.content.split(`### ${sharedSkill} —`)).toHaveLength(2);
    expect(result.skills.find(skill => skill.id === sharedSkill)?.references.map(reference => reference.path))
      .toEqual(["references/semantic-cleanup.md"]);
    expect(result.content).toContain(mode.reference);
    expect(result.content).toContain("An empty finding list is valid");
    expect(result.content).toContain("author's accepted voice");
    expect(result.content).toContain("not universal quality rules or platform algorithms");
    expect(result.content).toContain("Do not compress fluent Chinese into fragments");
    expect(result.content).toContain("20–80 characters");
    expect(result.content).toContain("not-X-but-Y");
    expect(result.content).toContain("Keep chapter targets in their declared language and measurement unit");
    expect(result.content).not.toMatch(/300 characters|800 characters|40% dialogue/);
    if (item.profileId === "short-fiction") {
      expect(result.content).toContain("closure does not require a victory, moral, or last-line twist");
      expect(result.content).toContain("Apply such numbers only when the current author explicitly requests them");
      expect(result.content).toContain("Skip settled decisions and unnecessary steps");
      expect(result.content).toContain("2000–2500");
    } else {
      expect(result.content).toContain("Carry change into the next chapter");
      expect(result.content).toContain("Voice persists across scenes");
      expect(result.content).toContain("not fixed chapter numbers");
      expect(result.content).toContain("2000–2500");
    }
  });

  it.each([
    { profileId: "short-fiction", direction: "写一篇修伞人重新争取生计的中文生活短篇。" },
    { profileId: "short-fiction", direction: "写一篇两人关系推进的中文恋爱短篇。" },
    { profileId: "longform-novel", direction: "写科幻连载当前一章，主角争取保住旧区供水。" },
    { profileId: "longform-novel", direction: "写历史经商长篇当前一章，主角争取第一笔合作。" },
  ])("makes the web-fiction target explicit across $profileId subject matter", async ({ profileId, direction }) => {
    const input = await fixture(profileId);
    const result = await prepare(input, [{ role: "user", content: direction }], { authorRequest: direction });
    expect(input.profile.description).toContain("Fiction defaults to accessible commercial web fiction in the requested language");
    expect(result.content).toContain("default to accessible commercial web fiction in the requested language");
    expect(result.content).toContain("meaningful opposing interests");
    expect(result.content).toContain("earns a felt change in circumstances");
    expect(result.content).toContain("must not lower the stakes, neutralize a confrontation, make the protagonist passive");
    expect(result.messages.some(message => message.role === "user" && message.content === direction)).toBe(true);
    expect(result.content).not.toMatch(/300 characters|800 characters|40% dialogue/);
  });


  it.each([
    { profileId: "short-fiction", worker: "short-fiction-outline" },
    { profileId: "short-fiction", worker: "short-fiction-writer" },
    { profileId: "short-fiction", worker: "short-fiction-draft-reviewer" },
    { profileId: "short-fiction", worker: "short-fiction-writer", revision: true },
    { profileId: "longform-novel", worker: "architect" },
    { profileId: "longform-novel", worker: "writer" },
    { profileId: "longform-novel", worker: "auditor" },
    { profileId: "longform-novel", worker: "reviser" },
  ].flatMap(stage => [true, false].map(native => ({ revision: false, ...stage, native }))))
  ("injects the revised method into $profileId $worker (native=$native, revision=$revision)", async ({ profileId, worker, native, revision }) => {
    const direction = revision
      ? "Revise only the dialogue in the supplied English fantasy chapter. Keep its events, narrator and agreed 900-word target."
      : "Write commercial fantasy in English. A tenant with a new useful ability must actively win a contested resource. Keep the agreed 900-word chapter target.";
    const result = await prepare(await fixture(profileId, "en"), [{ role: "user", content: direction }],
      { worker, native, authorRequest: direction });
    expect(result.content).toContain("default to accessible commercial web fiction in the requested language");
    expect(result.content).toContain("meaningful opposing interests");
    expect(result.content).toContain("consequential");
    expect(result.content).toMatch(/\bbasic motive\b/i);
    expect(result.content).toContain("biography");
    expect(result.content).toContain("2000–2500");
    expect(result.content).toContain("English uses its own declared word budget");
    expect(result.content).toContain("only-X/no-Y");
    expect(result.content).toContain("Keep structural change proposals separate from polishing");
    expect(result.messages.some(message => message.role === "user" && message.content === direction)).toBe(true);
  });

  it.each(writingModes)("keeps an explicit quiet/literary target authoritative for $profileId", async ({ profileId }) => {
    const direction = "本次明确写非商业的安静文学片段，保留开放结尾、直接心理描写和慢节奏，不改成逆袭情节。";
    const result = await prepare(await fixture(profileId), [{ role: "user", content: direction }], { authorRequest: direction });
    expect(result.content).toContain("An explicit literary, quiet, tragic, experimental, or other non-commercial intent overrides this default");
    expect(result.messages[0]?.content).toContain(direction);
    expect(result.content).toContain("author's accepted voice and latest request take priority");
  });

  it.each(writingModes.flatMap(mode => ["architect", "auditor", "reviser"].map(worker => ({ ...mode, worker }))))
  ("shares prose guidance with the $profileId $worker", async ({ profileId, skillId, worker }) => {
    const result = await prepare(await fixture(profileId), [{ role: "user", content: "只执行当前授权步骤，保留正文事实。" }], { worker });
    expect(result.skills.map(skill => skill.id)).toEqual([skillId, sharedSkill]);
    expect(result.content).toContain("Keep structural change proposals separate from polishing");
    expect(result.content).toContain("It grants no additional operation or rewrite authority");
  });

  it.each(["workspace-default", "script", "translation", "interactive-film", "visual-asset"])
  ("does not implicitly inject prose cleanup into %s", async profileId => {
    const result = await prepare(await fixture(profileId), [{ role: "user", content: "Perform this profile's current operation." }]);
    expect(result.skills.map(skill => skill.id)).not.toContain(sharedSkill);
    expect(result.content).not.toContain("# Semantic prose cleanup");
    expect(profiles.require(profileId).description).not.toContain("defaults to accessible commercial web fiction");
    expect(result.content).not.toContain("default to accessible commercial web fiction in the requested language");
  });

  it.each(writingModes)("omits writing methods from $profileId read-only semantic mechanics", async ({ profileId }) => {
    const result = await prepare(await fixture(profileId), [{ role: "user", content: "Find the exact paragraph; do not edit it." }],
      { worker: "scope-selector", professionalGuidance: false, authorRequest: "Only locate the paragraph." });
    expect(result.skills).toEqual([]);
    expect(result.content).not.toContain("Activated professional skills");
    expect(result.content).toContain("Only locate the paragraph.");
  });

  it("uses the Work's mode when a workspace coordinator invokes a non-native worker", async () => {
    const result = await prepare(await fixture("longform-novel"), [{ role: "user", content: "Polish only the supplied chapter." }],
      { native: false, scopedProfile: profiles.require("workspace-default") });
    expect(result.skills.map(skill => skill.id)).toEqual(["inkos-long-writing", sharedSkill]);
    expect(result.content).toContain("references/semantic-cleanup.md");
  });

  it("preserves project overrides and a custom profile's explicitly selected method", async () => {
    const input = await fixture("short-fiction");
    const directory = join(input.root, ".agents", "skills", sharedSkill);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "SKILL.md"), `---\nname: ${sharedSkill}\ndescription: Project prose method.\n---\nPROJECT_VOICE_AUTHORITY`);
    const result = await prepare(input, [{ role: "user", content: "Preserve this project's voice." }]);
    expect(result.content).toContain("PROJECT_VOICE_AUTHORITY");
    expect(result.content).not.toContain("# Semantic prose cleanup");
    const available = await loadAvailableAgentSkills({ projectRoot: input.root });
    const custom = { ...input.profile, id: "custom-voice", requiredSkillIds: ["inkos-short-writing"] };
    expect(resolveProfileSkillActivations(available.skills, custom).map(activation => activation.skill.id)).toEqual(["inkos-short-writing"]);
  });

  it.each([true, false])("carries evidence boundaries into selected market research (native=%s)", async native => {
    const input = await fixture("workspace-default");
    const direction = "Compare official charts and the publicly accessible openings; report exactly what was read.";
    const result = await prepare(input, [{ role: "user", content: direction }], {
      native, worker: "researcher", authorRequest: direction,
      scopedProfile: { ...input.profile, requiredSkillIds: ["inkos-long-market-research"] },
    });
    expect(result.skills.map(skill => skill.id)).toEqual(["inkos-long-market-research"]);
    expect(result.skills[0]?.references.map(reference => reference.path)).toContain("references/research-rubric.md");
    expect(result.content).toContain("chart name, category, ranking metric, active filters, observation time, and official URL");
    expect(result.content).toContain("Separate chart, synopsis, contents and actually read prose evidence");
    expect(result.content).toContain("chapters or passages read and the unread scope");
    expect(result.content).toContain("An opening sample cannot establish whole-book payoff");
    expect(result.content).toContain("counterexamples that challenge a proposed mechanism");
    expect(result.content).toContain("not proven causes of popularity");
    expect(result.content).not.toContain("# Commercial underdog story engine");
  });

  it.each(["architect", "planner", "writer", "auditor", "reviser"].flatMap(worker =>
    [true, false].map(native => ({ worker, native }))))
  ("keeps evidence-calibrated guidance and existing commercial promises for $worker (native=$native)", async ({ worker, native }) => {
    const direction = "Use the selected fast-paced commercial mode: an underdog acts for a contested gain. Keep natural dialogue and paragraphs.";
    const result = await prepare(await fixture("longform-novel", "en"), [{ role: "user", content: direction }],
      { worker, native, authorRequest: direction });
    expect(result.content).toContain("For the selected fast-paced commercial mode");
    expect(result.content).toContain("a pacing default, not a universal opening order");
    expect(result.content).not.toContain("For the default commercial web-fiction target, open with");
    expect(result.content).toContain("persistent, meaningful change that affects later choices");
    expect(result.content).toContain("real trade-offs where they apply");
    expect(result.content).not.toContain("and an irreversible price");
    expect(result.content).toContain("meaningful opposing interests");
    expect(result.content).toContain("the protagonist's actions should supply the win");
    expect(result.content).toContain("what the protagonist contributes");
    expect(result.content).toContain("inspection window, not a quota requiring a villain, complete system or win");
    expect(result.content).toContain("do not force suffering, injury or punishment into every win");
    expect(result.content).toContain("Use varied natural paragraphs");
    expect(result.content).toContain("dialogue driven by different aims");
    expect(result.messages.some(message => message.role === "user" && message.content === direction)).toBe(true);
  });

  it.each([true, false])("preserves an explicitly chosen commercial slow-burn without requiring a literary exception (native=%s)", async native => {
    const direction = "明确写商业慢热成长文，保留翻身目标和能力边界，开篇先让读者看懂农家生活，不强加当场胜利。";
    const result = await prepare(await fixture("longform-novel"), [{ role: "user", content: direction }],
      { native, authorRequest: direction });
    expect(result.content).toContain("An explicitly chosen commercial slow-burn");
    expect(result.content).toContain("keep the current event understandable and the promised reader experience intact");
    expect(result.content).toContain("Whether fast-paced or slow-burn, keep the current reader promise clear");
    expect(result.content).not.toContain("do not use these exceptions to dilute the default web-fiction promise");
    expect(result.messages.some(message => message.role === "user" && message.content === direction)).toBe(true);
  });
});
