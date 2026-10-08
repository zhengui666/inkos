import { afterEach, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexFixture } from "./codex-fixture.js";
const codex = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("../codex/client.js", () => ({ createCodexClient: codex.create }));
import { createLLMClient } from "../llm/provider.js";
import { CHAPTER_CONTRACT_SOURCE } from "../agents/chapter-contract.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

// Original synthetic prose and semantic fixtures. These exercise the real
// review protocol, not model judgment or the quality of a user's novel.
const memo = "Show Neri refusing the unpaid handover.\nDo not reveal who sent the sealed letter.\nKeep this scene before sunset.\nThe workshop already holds a 90 deposit.\nThe balance may be paid next week.";
const chapter = "Before sunset, Neri left the parcel on her own bench.\n‘You can collect it after the balance arrives,’ she said.\nHer customer promised to pay next week and left empty-handed.";
const kinds = ["required-event", "prohibition", "time-constraint", "background", "future-plan"];
const coverage = () => [
  { code: "chapter-contract-inventory", category: "quality", assessment: "observation", summary: "The inventory retains the current requirements and excludes background and future events.", sourceRefs: [{ sourceId: "chapter-contract-source", startLine: 1, endLine: 5 }] },
  ...kinds.slice(0, 3).map((_kind, index) => ({ code: `chapter-contract-${index + 1}`, category: "quality", assessment: "observation", summary: "The current prose supports this requirement; payment remains pending.", sourceRefs: [{ sourceId: `chapter-contract-${index + 1}`, startLine: 1, endLine: 1 }, { sourceId: "chapter-6", startLine: 1, endLine: 3 }] })),
];

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "inkos-chapter-contract-")); roots.push(root);
  const client = createLLMClient({ service: "custom", provider: "openai", configSource: "studio", model: "fixture", apiKey: "fixture", baseUrl: "https://unused.invalid/v1", apiFormat: "chat", stream: false, temperature: 0, thinkingBudget: 0 });
  return { root, client };
}

it.each(["review", "revision"])("retains exact memo hook withdrawal evidence through PipelineRunner %s", async action => {
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
  await createInitialRuntimeState({ bookDir, language: "en", hooks: [
    { hookId: "terminal-witness", startChapter: 0, type: "evidence", status: "superseded", lastAdvancedChapter: 0, expectedPayoff: "An old collection prohibition", notes: "AUTHOR WITHDREW THE OLD COLLECTION PROHIBITION" },
    { hookId: "resolved-return", startChapter: 0, type: "evidence", status: "resolved", lastAdvancedChapter: 0, expectedPayoff: "An earlier receipt return", notes: "RETURN ALREADY COMPLETED IN CHAPTER ZERO" },
  ] });
  await state.saveChapterIndex(bookId, [{ number: 1, title: "Collection", wordCount: 40, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", observations: [], provenance: "generated" }]);
  const intent = { chapter: 1, goal: "A collection attempt" };
  await savePersistedPlan(bookDir, { intent, memo: { ...intent, body: memo, threadRefs: ["terminal-witness", "resolved-return"] }, intentMarkdown: memo, runtimePath: "", plannerInputs: [] });
  await syncWorkSourceArtifacts({ projectRoot: f.root, workId: bookId, accept: true });
  const planPath = join(bookDir, "story/runtime/chapter-0001.plan.json"), statePath = join(bookDir, "story/state/current_state.json");
  const planBefore = await readFile(planPath, "utf8"), stateBefore = await readFile(statePath, "utf8");
  const hooksPath = join(bookDir, "story/state/hooks.json"), hooksBefore = await readFile(hooksPath, "utf8");
  const replan = vi.spyOn(PlannerAgent.prototype, "planChapter"), rewrite = vi.spyOn(ReviserAgent.prototype, "reviseChapter");
  let classifications = 0;
  const fixture = new CodexFixture(view => {
    const name = view.tools[0]!.function.name;
    const payload = JSON.parse(view.messages.find(message => message.role === "user")!.content);
    const governedSource = payload.sources.find((source: { sourceId: string }) => source.sourceId === "governed-context").numberedLines;
    expect(governedSource).toContain("source=story/state/hooks.json#terminal-witness");
    expect(governedSource).toContain("AUTHOR WITHDREW THE OLD COLLECTION PROHIBITION");
    expect(governedSource).toContain("source=story/state/hooks.json#resolved-return");
    expect(governedSource).toContain("RETURN ALREADY COMPLETED IN CHAPTER ZERO");
    if (name === "submit_chapter_contract") {
      classifications++;
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
  expect(await readFile(hooksPath, "utf8")).toBe(hooksBefore);
  expect(await readFile(join(bookDir, "chapters/0001_Collection.md"), "utf8")).toBe(`# Chapter 1: Collection\n\n${chapter}`);
  expect((await state.loadBookConfig(bookId)).status).toBe("paused");
});
