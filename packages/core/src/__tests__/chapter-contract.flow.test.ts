import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexFixture } from "./codex-fixture.js";
const codex = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("../codex/client.js", () => ({ createCodexClient: codex.create }));
import { createLLMClient } from "../llm/provider.js";
import { ContinuityAuditor } from "../agents/continuity.js";
import { CHAPTER_CONTRACT_SOURCE, chapterContractRequirements, validateChapterContractInventory, validateChapterContractReview } from "../agents/chapter-contract.js";
import { resolveObservationSources, type Observation } from "../models/observation.js";
import { buildWriterSystemPrompt } from "../agents/writer-prompts.js";
import { getPlannerMemoSystemPrompt } from "../agents/planner-prompts.js";
import { withExecutionEvidence } from "../harness/execution-evidence.js";
import { ChapterMemoSchema } from "../models/input-governance.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

// Original synthetic prose and semantic fixtures. These exercise the real
// review protocol, not model judgment or the quality of a user's novel.
const memo = "Show Neri refusing the unpaid handover.\nDo not reveal who sent the sealed letter.\nKeep this scene before sunset.\nThe workshop already holds a 90 deposit.\nThe balance may be paid next week.";
const chapter = "Before sunset, Neri left the parcel on her own bench.\n‘You can collect it after the balance arrives,’ she said.\nHer customer promised to pay next week and left empty-handed.";
const kinds = ["required-event", "prohibition", "time-constraint", "background", "future-plan"];
const classified = () => kinds.map((code, index) => ({ code, assessment: "observation", summary: memo.split("\n")[index]!, sourceRefs: [{ sourceId: "chapter-contract-source", startLine: index + 1, endLine: index + 1 }] }));
const coverage = () => [
  { code: "chapter-contract-inventory", category: "quality", assessment: "observation", summary: "The inventory retains the current requirements and excludes background and future events.", sourceRefs: [{ sourceId: "chapter-contract-source", startLine: 1, endLine: 5 }] },
  ...kinds.slice(0, 3).map((_kind, index) => ({ code: `chapter-contract-${index + 1}`, category: "quality", assessment: "observation", summary: "The current prose supports this requirement; payment remains pending.", sourceRefs: [{ sourceId: `chapter-contract-${index + 1}`, startLine: 1, endLine: 1 }, { sourceId: "chapter-6", startLine: 1, endLine: 3 }] })),
];

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "inkos-chapter-contract-")); roots.push(root);
  const client = createLLMClient({ service: "custom", provider: "openai", configSource: "studio", model: "fixture", apiKey: "fixture", baseUrl: "https://unused.invalid/v1", apiFormat: "chat", stream: false, temperature: 0, thinkingBudget: 0 });
  return { root, client, auditor: new ContinuityAuditor({ client, model: "fixture", projectRoot: root }) };
}

it("does not accept an empty review of a legacy free-Markdown chapter memo", async () => {
  const f = await setup(); let reviewCalls = 0, classificationCalls = 0;
  const fixture = new CodexFixture(view => {
    const name = view.tools[0]!.function.name;
    if (name === "submit_chapter_contract") { classificationCalls++; return { calls: [{ name, args: { summary: "Source-preserving inventory", observations: classified() } }] }; }
    expect(name).toBe("submit_chapter_review");
    return { calls: [{ name, args: { summary: "Synthetic evidence fixture", observations: reviewCalls++ ? coverage() : [] } }] };
  }); codex.create.mockImplementation(fixture.createClient);
  const result = await f.auditor.auditChapter(f.root, chapter, 6, undefined, { language: "en", contextPackage: { chapter: 6, selectedContext: [{ source: "runtime/chapter_memo", reason: "Existing legacy memo", excerpt: memo, protection: "protected" }] } });
  expect(reviewCalls).toBe(2);
  expect(classificationCalls).toBe(1);
  expect(result.observations.map(item => item.code)).toEqual(["chapter-contract-inventory", "chapter-contract-1", "chapter-contract-2", "chapter-contract-3"]);
});

const inventory = (): Observation[] => classified().map((item, index) => ({ ...item, assessment: "observation", evidence: [], sourceRefs: [{ sourceId: CHAPTER_CONTRACT_SOURCE, quote: memo.split("\n")[index]! }] }));
const checked = (): Observation[] => coverage().map((item, index) => ({ ...item, assessment: "observation", category: "quality", evidence: [], sourceRefs: index === 0
  ? [{ sourceId: CHAPTER_CONTRACT_SOURCE, quote: memo }]
  : [{ sourceId: item.code, quote: memo.split("\n")[index - 1]! }, { sourceId: "chapter-6", quote: chapter }] }));

describe("host coverage checks are structural, never a keyword quality verdict", () => {
  it("keeps the existing legacy memo schema and separates background/future from current requirements", () => {
    expect(ChapterMemoSchema.parse({ chapter: 6, goal: "A collection attempt", body: memo, threadRefs: [] }).body).toBe(memo);
    expect(() => validateChapterContractInventory(inventory(), memo)).not.toThrow();
    expect(chapterContractRequirements(inventory()).map(item => item.kind)).toEqual(kinds.slice(0, 3));
    expect(() => validateChapterContractInventory([], memo)).toThrow("every supplied memo line");
    expect(() => validateChapterContractInventory(inventory().slice(1), memo)).toThrow("every supplied memo line");
    expect(() => validateChapterContractInventory([{ ...inventory()[0]!, code: "winner-score" }], memo)).toThrow("supported kind");
  });
  it.each(["missing", "duplicate", "unknown"])("rejects %s expected-id coverage", kind => {
    const items = checked();
    if (kind === "missing") items.splice(2, 1);
    if (kind === "duplicate") items.push({ ...items[1]! });
    if (kind === "unknown") items.push({ ...items[1]!, code: "chapter-contract-999" });
    expect(() => validateChapterContractReview(items, inventory(), "chapter-6")).toThrow();
  });
  it.each(["plan-only", "chapter-only", "previous-chapter"])("rejects %s delivery evidence", kind => {
    const items = checked();
    items[1]!.sourceRefs = kind === "plan-only" ? [{ sourceId: "chapter-contract-1", quote: memo }]
      : kind === "chapter-only" ? [{ sourceId: "chapter-6", quote: chapter }]
      : [{ sourceId: "chapter-contract-1", quote: memo }, { sourceId: "chapter-5", quote: chapter }];
    expect(() => validateChapterContractReview(items, inventory(), "chapter-6")).toThrow("actual current chapter evidence");
  });
  it("retains a source-supported prohibition violation and requires its repair layer", () => {
    const items = checked(); items[2] = { ...items[2]!, assessment: "issue", summary: "The narration reveals the forbidden sender." };
    expect(() => validateChapterContractReview(items, inventory(), "chapter-6")).toThrow("repair layer");
    items[2]!.repairScope = "local";
    expect(() => validateChapterContractReview(items, inventory(), "chapter-6")).not.toThrow();
    // The validator cannot certify this semantic finding: exact present-source
    // support is resolved separately, and the reviewer supplies the judgment.
  });
  it("keeps missing semantic evidence unknown and disallows repairs for a mistaken inventory", () => {
    const unknown: Observation[] = [{ code: "unknown", assessment: "unavailable", summary: "The latest instruction needed to resolve the memo is absent.", evidence: [], sourceRefs: [] }];
    expect(() => validateChapterContractInventory(unknown, memo)).not.toThrow();
    expect(() => validateChapterContractReview([checked()[0]!], unknown, "chapter-6")).toThrow("remains unknown");
    const missing: Observation = { ...checked()[0]!, assessment: "unavailable", sourceRefs: [] };
    expect(() => validateChapterContractReview([missing], unknown, "chapter-6")).not.toThrow();
    expect(() => validateChapterContractReview([{ ...missing, assessment: "issue", repairScope: "structural" }], unknown, "chapter-6")).toThrow("mistaken plan");
  });
  it("rejects an invented quote or out-of-range reference through the existing source resolver", () => {
    const sources = new Map([["chapter-6", chapter], [CHAPTER_CONTRACT_SOURCE, memo]]);
    expect(() => resolveObservationSources([{ ...checked()[0]!, sourceRefs: [{ sourceId: "chapter-6", quote: "The payment cleared." }] }], sources)).toThrow("REVIEW_SOURCE_MISMATCH");
    expect(() => resolveObservationSources([{ ...checked()[0]!, sourceRefs: [{ sourceId: "chapter-6", startLine: 4, endLine: 4 }] }], sources)).toThrow("REVIEW_SOURCE_RANGE_INVALID");
  });
});

it("classifies without draft leakage, allows unrecited background/prohibitions, and leaves the original memo unchanged", async () => {
  const f = await setup(), memoPath = join(f.root, "original-memo.md");
  await writeFile(memoPath, memo);
  const fixture = new CodexFixture(view => {
    const name = view.tools[0]!.function.name, prompt = view.thread.baseInstructions + JSON.stringify(view.messages);
    if (name === "submit_chapter_contract") {
      expect(prompt).toContain(memo.split("\n")[3]);
      expect(prompt).not.toContain("Her customer promised");
      return { calls: [{ name, args: { summary: "Current requirements classified", observations: classified() } }] };
    }
    expect(prompt).toContain("a satisfactory absence does not require");
    expect(prompt).toContain("setup and aftermath need not force a win");
    expect(prompt).toContain("promised payment is not received money");
    return { calls: [{ name, args: { summary: "The refusal occurs before sunset; sender remains unrevealed", observations: coverage() } }] };
  }); codex.create.mockImplementation(fixture.createClient);
  const review = await f.auditor.auditChapter(f.root, chapter, 6, undefined, { language: "en", contextPackage: { chapter: 6, selectedContext: [{ source: "runtime/chapter_memo", reason: "Legacy", excerpt: memo, protection: "protected" }] } });
  expect(review.observations).toHaveLength(4);
  expect(chapter).not.toContain("90"); expect(chapter).not.toContain("letter");
  expect(await readFile(memoPath, "utf8")).toBe(memo);
});

it("retains genuine unavailable classification instead of fabricating a coverage pass", async () => {
  const f = await setup(); let reviewCalls = 0;
  const fixture = new CodexFixture(view => {
    const name = view.tools[0]!.function.name;
    if (name === "submit_chapter_contract") return { calls: [{ name, args: { summary: "Unknown authority", observations: [{ code: "unknown", assessment: "unavailable", summary: "The memo refers to an absent revised instruction.", sourceRefs: [] }] } }] };
    return { calls: [{ name, args: { summary: "Unknown remains unknown", observations: reviewCalls++
      ? [{ code: "chapter-contract-inventory", category: "quality", assessment: "unavailable", summary: "The revised instruction is missing", sourceRefs: [] }]
      : [coverage()[0]] } }] };
  }); codex.create.mockImplementation(fixture.createClient);
  const result = await f.auditor.auditChapter(f.root, chapter, 6, undefined, { language: "en", contextPackage: { chapter: 6, selectedContext: [{ source: "runtime/chapter_memo", reason: "Legacy", excerpt: memo, protection: "protected" }] } });
  expect(reviewCalls).toBe(2); expect(result.observations[0]!.assessment).toBe("unavailable");
});

it("preserves review compatibility when no chapter memo was supplied", async () => {
  const f = await setup(); const names: string[] = [];
  const fixture = new CodexFixture(view => {
    const name = view.tools[0]!.function.name; names.push(name);
    return { calls: [{ name, args: { summary: "Independent existing review", observations: [] } }] };
  }); codex.create.mockImplementation(fixture.createClient);
  const result = await f.auditor.auditChapter(f.root, chapter, 6, undefined, { language: "en", contextPackage: { chapter: 6, selectedContext: [] } });
  expect(names).toEqual(["submit_chapter_review"]); expect(result.observations).toEqual([]);
});

it("accepts a background/future-only memo without inventing a current event or a win", async () => {
  const f = await setup(), context = "The deposit was received yesterday.\nThe customer may return next week.";
  const fixture = new CodexFixture(view => {
    const name = view.tools[0]!.function.name;
    const observations = name === "submit_chapter_contract" ? ["background", "future-plan"].map((code, index) => ({ code, assessment: "observation", summary: context.split("\n")[index], sourceRefs: [{ sourceId: CHAPTER_CONTRACT_SOURCE, startLine: index + 1, endLine: index + 1 }] }))
      : [{ ...coverage()[0], summary: "Neither source item mandates a current event", sourceRefs: [{ sourceId: CHAPTER_CONTRACT_SOURCE, startLine: 1, endLine: 2 }] }];
    return { calls: [{ name, args: { summary: "No invented requirement", observations } }] };
  }); codex.create.mockImplementation(fixture.createClient);
  const result = await f.auditor.auditChapter(f.root, chapter, 6, undefined, { language: "en", contextPackage: { chapter: 6, selectedContext: [{ source: "runtime/chapter_memo", reason: "Existing memo", excerpt: context, protection: "protected" }] } });
  expect(result.observations.map(item => item.code)).toEqual(["chapter-contract-inventory"]);
  expect(result.observations[0]!.assessment).toBe("observation");
});

it("handles a Chinese free-form memo and headings without keyword-derived judgments or reciting its background", async () => {
  const f = await setup();
  const original = "## 本章安排\n阿宁拒绝未付款就交货。\n信件寄出者不能揭晓。\n本场发生在日落前。\n九十元定金早已收到。\n客人打算下周再来付尾款。";
  const prose = "天还亮着，阿宁把包裹留在自己的台面上。\n‘等尾款到了再来拿。’她说。\n客人答应下周再付，空着手走了。";
  const classifications = ["background", ...kinds];
  const fixture = new CodexFixture(view => {
    const name = view.tools[0]!.function.name;
    if (name === "submit_chapter_contract") return { calls: [{ name, args: { summary: "保留原始安排并分类", observations: classifications.map((code, index) => ({ code, assessment: "observation", summary: original.split("\n")[index], sourceRefs: [{ sourceId: CHAPTER_CONTRACT_SOURCE, startLine: index + 1, endLine: index + 1 }] })) } }] };
    expect(view.thread.baseInstructions).toContain("禁令检查是否被违背");
    return { calls: [{ name, args: { summary: "拒绝交货已发生，款项仍待支付", observations: [
      { ...coverage()[0], sourceRefs: [{ sourceId: CHAPTER_CONTRACT_SOURCE, startLine: 1, endLine: 6 }] },
      ...[2, 3, 4].map(id => ({ ...coverage()[1], code: `chapter-contract-${id}`, sourceRefs: [{ sourceId: `chapter-contract-${id}`, startLine: 1, endLine: 1 }, { sourceId: "chapter-6", startLine: 1, endLine: 3 }] })),
    ] } }] };
  }); codex.create.mockImplementation(fixture.createClient);
  const result = await f.auditor.auditChapter(f.root, prose, 6, undefined, { language: "zh", contextPackage: { chapter: 6, selectedContext: [{ source: "runtime/chapter_memo", reason: "已有自由格式规划", excerpt: original, protection: "protected" }] } });
  expect(result.observations.map(item => item.code)).toEqual(["chapter-contract-inventory", "chapter-contract-2", "chapter-contract-3", "chapter-contract-4"]);
  expect(prose).not.toContain("九十元"); expect(prose).not.toContain("信件");
});

it.each(["required-event", "prohibition", "time-constraint"])("retains an actual source-supported %s defect for existing repair handling", async kind => {
  const f = await setup();
  const index = kinds.indexOf(kind), source = memo.split("\n")[index]!;
  const defective = kind === "required-event" ? "Neri handed over the parcel; the customer would pay next week."
    : kind === "prohibition" ? "Neri opened the sealed letter and read the sender's full name."
    : "They began the collection after sunset.";
  const fixture = new CodexFixture(view => {
    const name = view.tools[0]!.function.name;
    const observations = name === "submit_chapter_contract" ? [{ code: kind, assessment: "observation", summary: source, sourceRefs: [{ sourceId: CHAPTER_CONTRACT_SOURCE, startLine: 1, endLine: 1 }] }]
      : [{ ...coverage()[0], sourceRefs: [{ sourceId: CHAPTER_CONTRACT_SOURCE, startLine: 1, endLine: 1 }] }, { code: "chapter-contract-1", category: "quality", assessment: "issue", repairScope: "local", summary: `The current scene contradicts the supplied ${kind}.`, sourceRefs: [{ sourceId: "chapter-contract-1", startLine: 1, endLine: 1 }, { sourceId: "chapter-6", startLine: 1, endLine: 1 }] }];
    return { calls: [{ name, args: { summary: "Synthetic defect diagnosis", observations } }] };
  }); codex.create.mockImplementation(fixture.createClient);
  const result = await f.auditor.auditChapter(f.root, defective, 6, undefined, { language: "en", contextPackage: { chapter: 6, selectedContext: [{ source: "runtime/chapter_memo", reason: "One explicit constraint", excerpt: source, protection: "protected" }] } });
  expect(result.observations[1]).toMatchObject({ assessment: "issue", repairScope: "local", sourceRefs: [{ sourceId: "chapter-contract-1", quote: source }, { sourceId: "chapter-6", quote: defective }] });
});

it("reclassifies the actual current memo on the next review instead of accepting stale expected ids", async () => {
  const f = await setup(), sourcesSeen: string[] = [];
  const fixture = new CodexFixture(view => {
    const name = view.tools[0]!.function.name;
    if (name === "submit_chapter_contract") {
      const payload = JSON.parse(view.messages.find(message => message.role === "user")!.content);
      sourcesSeen.push(payload.sources.find((source: { sourceId: string }) => source.sourceId === CHAPTER_CONTRACT_SOURCE).numberedLines);
      return { calls: [{ name, args: { summary: "Current memo", observations: [{ code: "required-event", assessment: "observation", summary: "Current direction", sourceRefs: [{ sourceId: CHAPTER_CONTRACT_SOURCE, startLine: 1, endLine: 1 }] }] } }] };
    }
    return { calls: [{ name, args: { summary: "Current evidence", observations: [coverage()[0], coverage()[1]].map((item, index) => index ? item : { ...item, sourceRefs: [{ sourceId: CHAPTER_CONTRACT_SOURCE, startLine: 1, endLine: 1 }] }) } }] };
  }); codex.create.mockImplementation(fixture.createClient);
  for (const excerpt of ["Refuse handover.", "Ask for the receipt before making a choice."]) {
    await f.auditor.auditChapter(f.root, chapter, 6, undefined, { language: "en", contextPackage: { chapter: 6, selectedContext: [{ source: "runtime/chapter_memo", reason: "Current memo", excerpt, protection: "protected" }] } });
  }
  expect(sourcesSeen).toEqual(["1\tRefuse handover.", "1\tAsk for the receipt before making a choice."]);
});

it("keeps the latest author instruction above a superseded event and does not force a setup victory", async () => {
  const f = await setup(), oldMemo = "Collect the balance and hand over the parcel.";
  const request = "Change this chapter to a setup: Neri refuses handover; payment is only promised next week.";
  const fixture = new CodexFixture(view => {
    const name = view.tools[0]!.function.name, prompt = view.thread.baseInstructions + JSON.stringify(view.messages);
    expect(prompt).toContain(request);
    if (name === "submit_chapter_contract") return { calls: [{ name, args: { summary: "New author direction supersedes the older plan", observations: [
      { code: "superseded", assessment: "observation", summary: "The previous collection instruction is superseded", sourceRefs: [{ sourceId: CHAPTER_CONTRACT_SOURCE, startLine: 1, endLine: 1 }, { sourceId: "chapter-contract-author-request", startLine: 1, endLine: 1 }] },
      { code: "required-event", assessment: "observation", summary: "Refuse handover", sourceRefs: [{ sourceId: "chapter-contract-author-request", startLine: 1, endLine: 1 }] },
      { code: "future-plan", assessment: "observation", summary: "Payment may happen next week", sourceRefs: [{ sourceId: "chapter-contract-author-request", startLine: 1, endLine: 1 }] },
    ] } }] };
    expect(prompt).not.toContain('"code":"chapter-contract-1"');
    return { calls: [{ name, args: { summary: "The revised setup has evidence", observations: [coverage()[0], { ...coverage()[1], code: "chapter-contract-2", sourceRefs: [{ sourceId: "chapter-contract-2", startLine: 1, endLine: 1 }, { sourceId: "chapter-6", startLine: 1, endLine: 3 }] }].map((item, index) => index ? item : { ...item, sourceRefs: [{ sourceId: CHAPTER_CONTRACT_SOURCE, startLine: 1, endLine: 1 }] }) } }] };
  }); codex.create.mockImplementation(fixture.createClient);
  const result = await withExecutionEvidence(undefined, () => f.auditor.auditChapter(f.root, chapter, 6, undefined, { language: "en", contextPackage: { chapter: 6, selectedContext: [{ source: "runtime/chapter_memo", reason: "Older plan", excerpt: oldMemo, protection: "protected" }] } }), undefined, undefined, request);
  expect(result.observations.map(item => item.code)).toEqual(["chapter-contract-inventory", "chapter-contract-2"]);
});

it.each(["zh", "en"] as const)("keeps the %s writer/planner authority protocol and PR18 reader contract", language => {
  const readerContract = { mode: "author-directed" as const, familiarPromise: "A quiet mystery", distinctiveHook: "A blank letter", readingPleasure: "Understanding a choice", openingQuestion: "Who sent it?", proseApproach: "Quiet", authorDirection: "Preserve uncertainty" };
  const prompt = buildWriterSystemPrompt({ id: "test", title: "Test", genre: "general", platform: "other", language, status: "paused", chapterWordCount: 300, targetChapters: 10, createdAt: "2026-01-01", updatedAt: "2026-01-01" }, { version: "2", prohibitions: [], enableFullCastTracking: false, allowedDeviations: [], readerContract }, "Binding book facts", "Author voice");
  expect(prompt).toContain(readerContract.distinctiveHook); expect(prompt).toContain("Binding book facts"); expect(prompt).toContain("Author voice");
  expect(prompt).toContain(language === "en" ? "A promise or invoice is not a completed payment" : "承诺付款或开出账单不等于已经收款");
  expect(getPlannerMemoSystemPrompt(language)).toContain(language === "en" ? "future plans" : "未来计划");
  expect(prompt).not.toContain("Satisfy every populated memo requirement");
});

it.each(["review", "revision"])("uses the actual persisted memo through PipelineRunner %s rather than inventing a plan from the review task", async action => {
  const f = await setup();
  const { StateManager } = await import("../state/manager.js");
  const { createWorkManifest, saveWorkManifest } = await import("../harness/work-store.js");
  const { createInitialRuntimeState } = await import("../state/runtime-state-store.js");
  const { savePersistedPlan } = await import("../pipeline/persisted-governed-plan.js");
  const { syncWorkSourceArtifacts } = await import("../harness/source-sync.js");
  const { PipelineRunner } = await import("../pipeline/runner.js");
  const { PlannerAgent } = await import("../agents/planner.js");
  const { ReviserAgent } = await import("../agents/reviser.js");
  const state = new StateManager(f.root), bookId = "retained-contract", bookDir = state.bookDir(bookId);
  await saveWorkManifest(f.root, createWorkManifest({ id: bookId, title: "Collection", profileId: "longform-novel", language: "en" }));
  await state.saveBookConfig(bookId, { id: bookId, title: "Collection", genre: "general", platform: "other", language: "en", status: "paused", chapterWordCount: 300, targetChapters: 10, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" });
  await mkdir(join(bookDir, "story/outline"), { recursive: true });
  await mkdir(join(bookDir, "story/runtime"), { recursive: true });
  await mkdir(join(bookDir, "chapters"), { recursive: true });
  for (const [path, body] of Object.entries({ "story/book_rules.md": "Keep payment and possession distinct.", "story/book_rules.json": JSON.stringify({ version: "2", prohibitions: [], enableFullCastTracking: false, allowedDeviations: [] }), "story/outline/story_frame.md": "A collection attempt tests a boundary.", "story/outline/volume_map.md": "The decision creates a later obligation.", "chapters/0001_Collection.md": `# Chapter 1: Collection\n\n${chapter}` })) await writeFile(join(bookDir, path), body);
  await createInitialRuntimeState({ bookDir, language: "en" });
  await state.saveChapterIndex(bookId, [{ number: 1, title: "Collection", wordCount: 40, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", observations: [], provenance: "generated" }]);
  const intent = { chapter: 1, goal: "A collection attempt" };
  await savePersistedPlan(bookDir, { intent, memo: { ...intent, body: memo, threadRefs: [] }, intentMarkdown: memo, runtimePath: "", plannerInputs: [] });
  await syncWorkSourceArtifacts({ projectRoot: f.root, workId: bookId, accept: true });
  const planPath = join(bookDir, "story/runtime/chapter-0001.plan.json"), statePath = join(bookDir, "story/state/current_state.json");
  const planBefore = await readFile(planPath, "utf8"), stateBefore = await readFile(statePath, "utf8");
  const replan = vi.spyOn(PlannerAgent.prototype, "planChapter"), rewrite = vi.spyOn(ReviserAgent.prototype, "reviseChapter");
  let classifications = 0;
  const fixture = new CodexFixture(view => {
    const name = view.tools[0]!.function.name;
    if (name === "submit_chapter_contract") {
      classifications++;
      const payload = JSON.parse(view.messages.find(message => message.role === "user")!.content);
      const originalSource = payload.sources.find((source: { sourceId: string }) => source.sourceId === CHAPTER_CONTRACT_SOURCE).numberedLines;
      expect(originalSource).toBe(`1\tgoal=A collection attempt\n${memo.split("\n").map((line, index) => `${index + 2}\t${line}`).join("\n")}`);
      expect(originalSource).not.toContain("Review existing chapter");
      return { calls: [{ name, args: { summary: "Original persisted plan", observations: ["background", ...kinds].map((code, index) => ({ code, assessment: "observation", summary: index ? memo.split("\n")[index - 1] : "Chapter goal", sourceRefs: [{ sourceId: CHAPTER_CONTRACT_SOURCE, startLine: index + 1, endLine: index + 1 }] })) } }] };
    }
    expect(name).toBe("submit_chapter_review");
    return { calls: [{ name, args: { summary: "Current retained prose reviewed against its actual plan", observations: [
      { ...coverage()[0], sourceRefs: [{ sourceId: CHAPTER_CONTRACT_SOURCE, startLine: 1, endLine: 6 }] },
      ...[2, 3, 4].map(id => ({ ...coverage()[1], code: `chapter-contract-${id}`, sourceRefs: [{ sourceId: `chapter-contract-${id}`, startLine: 1, endLine: 1 }, { sourceId: "chapter-1", startLine: 1, endLine: 3 }] })),
    ] } }] };
  }); codex.create.mockImplementation(fixture.createClient);
  const pipeline = new PipelineRunner({ projectRoot: f.root, client: f.client, model: "fixture" });
  const result = action === "review" ? await pipeline.reviewChapter(bookId, 1) : await pipeline.reviseDraft(bookId, 1, "spot-fix");
  expect(result.observations.map(item => item.code)).toEqual(["chapter-contract-inventory", "chapter-contract-2", "chapter-contract-3", "chapter-contract-4"]);
  expect(classifications).toBe(1); expect(replan).not.toHaveBeenCalled(); expect(rewrite).not.toHaveBeenCalled();
  expect(await readFile(planPath, "utf8")).toBe(planBefore); expect(await readFile(statePath, "utf8")).toBe(stateBefore);
  expect(await readFile(join(bookDir, "chapters/0001_Collection.md"), "utf8")).toBe(`# Chapter 1: Collection\n\n${chapter}`);
  expect((await state.loadBookConfig(bookId)).status).toBe("paused");
});
