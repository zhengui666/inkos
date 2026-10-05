import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderProjectionComparison } from "../agents/state-validation-context.js";
import { StateValidatorAgent } from "../agents/state-validator.js";
import { WriterAgent, type WriteChapterOutput } from "../agents/writer.js";
import { prepareWorkerInput } from "../agents/base.js";
import { estimateTextTokens, type LLMClient, type LLMMessage } from "../llm/provider.js";
import { withExecutionEvidence } from "../harness/execution-evidence.js";
import { validateChapterTruthPersistence } from "../pipeline/chapter-truth-validation.js";
import { persistChapterArtifacts } from "../pipeline/chapter-persistence.js";
import { createInitialRuntimeState, loadRuntimeStateSnapshot, loadRuntimeStateSnapshotAtChapter, saveRuntimeStateSnapshot } from "../state/runtime-state-store.js";
import type { ChapterMeta } from "../models/chapter.js";

const mock = vi.hoisted(() => ({ tool: vi.fn(), text: vi.fn() }));
vi.mock("../agent/worker-agent.js", () => ({ runWorkerAgentTool: mock.tool, runWorkerAgent: mock.text }));
const client: LLMClient = { provider: "openai", apiFormat: "responses", stream: true,
  defaults: { temperature: 0, maxTokens: 16384, thinkingBudget: 0, extra: {} },
  _codex: { projectRoot: "/fixture" } };
const roots: string[] = [];
beforeEach(() => { mock.tool.mockReset(); mock.text.mockReset(); mock.tool.mockResolvedValue({ reconciliationRequired: false, reportMarkdown: "" }); });
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

function reconstruct(block: string): [string, string] {
  const rows = JSON.parse(block.split("\n").slice(2).join("\n")) as [number[], number[], string][];
  const versions: [string[], string[]] = [[], []];
  for (const [previous, proposed, line] of rows) {
    for (const position of previous) versions[0][position - 1] = line;
    for (const position of proposed) versions[1][position - 1] = line;
  }
  return [versions[0].join("\n"), versions[1].join("\n")];
}

describe("lossless state validation context", () => {
  const fact = `| Character | location | ${"事实".repeat(250)} | 1 | 1 |`;

  it("preserves order, multiplicity, edits, removals, empty lines, CRLF and escaped characters", () => {
    const previous = ["# Current State\r", fact, "", "", fact, 'Old \\| "quoted" 🐈\r', "expired fact", ""].join("\n");
    const proposed = ["# Current State\r", "new fact", fact, 'New \\| "quoted" 🐈\r', "", fact, ""].join("\n");
    const block = renderProjectionComparison("State Card", previous, proposed);
    expect(block).toContain("lossless line table");
    expect(block).toContain("Shared lines remain binding evidence in BOTH versions");
    expect(reconstruct(block)).toEqual([previous, proposed]);
    expect(block.split(fact)).toHaveLength(2);
    expect(estimateTextTokens(block)).toBeLessThan(estimateTextTokens(previous + proposed));
  });

  it.each([["", "changed"], ["previous", "proposed"], ["same", "same"]])("keeps small inputs readable (%s / %s)", (previous, proposed) => {
    expect(renderProjectionComparison("Hooks", previous, proposed)).toBe(`## Previous Hooks\n${previous}\n\n## Proposed Hooks\n${proposed}`);
  });

  it("round-trips different overlapping versions without interpreting source text", () => {
    for (let seed = 0; seed < 30; seed++) {
      const source = [fact, "\r", "", "| Other | values <br> and \\| |", "## Proposed Hooks", '[[],[],"source"]'];
      const previous = Array.from({ length: 50 }, (_, i) => source[(i * 7 + seed) % source.length]).join("\n");
      const proposed = Array.from({ length: 43 }, (_, i) => source[(i * 11 + seed + 1) % source.length]).join("\n");
      expect(reconstruct(renderProjectionComparison("Hooks", previous, proposed))).toEqual([previous, proposed]);
    }
  });

  it("round-trips an empty projection, blank lines and untouched whitespace", () => {
    for (const [previous, proposed] of [["", `${fact}\n`.repeat(10)], [`${fact}\n`.repeat(10), ""],
      [["\t  ", fact, "\r", "", fact, ""].join("\n"), [fact, "\t  ", "\r", fact, "", ""].join("\n")]]) {
      expect(reconstruct(renderProjectionComparison("State Card", previous!, proposed!))).toEqual([previous, proposed]);
    }
  });

  it("reviews a candidate summary even when state and hooks are unchanged", async () => {
    const agent = new StateValidatorAgent({ client, model: "fixture", projectRoot: "/fixture" });
    await expect(agent.validate("Lin enters the archive.", 1, "same state", "same state", "same hooks", "same hooks", "en"))
      .resolves.toMatchObject({ consistent: true });
    expect(mock.tool).not.toHaveBeenCalled();
    mock.tool.mockResolvedValue({ reconciliationRequired: true, reportMarkdown: "The summary invents a fire absent from the chapter." });
    const summary = { chapter: 1, title: "Archive", characters: "Lin", events: "UNSUPPORTED_SUMMARY_Lin_burns_archive",
      stateChanges: "", hookActivity: "", mood: "quiet", chapterType: "scene" };
    const result = await agent.validate("Lin enters the archive.", 1, "same state", "same state", "same hooks", "same hooks", "en",
      { chapterSummaries: "Previously accepted chapters only" }, { chapterSummary: summary });
    expect(mock.tool).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ consistent: false, reconciliationRequired: true });
    const messages = mock.tool.mock.calls[0][2] as LLMMessage[];
    const prompt = messages.find(message => message.role === "user")!.content;
    const [authority, proposed] = prompt.split("## Candidate Projection (unverified; not authority)");
    expect(authority).toContain("Previously accepted chapters only");
    expect(authority).not.toContain(summary.events);
    expect(proposed).toContain(JSON.stringify(summary, null, 2));
  });

  it("preserves lossless projection sharing without imposing a made-up Codex input budget", async () => {
    const rows = Array.from({ length: 570 }, (_, i) => `| person-${i} | location | ${"史".repeat(100)} | 1 | 1 |`);
    const previous = ["# Current State", "> Current chapter: 27", ...rows, "| witness | location | outside | 27 | 27 |"].join("\n");
    const proposed = ["# Current State", "> Current chapter: 28", ...rows, "| witness | location | workshop | 28 | 28 |"].join("\n");
    const hooks = ["# Pending Hooks", ...["open", "resolved", "superseded"].map(status => `| hook-${status} | ${status} | ${"伏".repeat(500)} | withdrawal authority remains explicit |`)].join("\n");
    const authority = { storyFrame: "Author-approved frame: " + "设".repeat(1000), bookRules: "Keep the sealed letter closed.", chapterSummaries: "Every earlier chapter: " + "摘".repeat(1000) };
    const chapter = "The witness enters the workshop. The letter remains sealed.";
    const context = { client, model: "fixture", projectRoot: "/fixture" };
    // Even the larger raw layout reaches Codex without a host capacity guess.
    const raw = await prepareWorkerInput(context, [{ role: "user", content: previous + proposed + hooks + hooks }], 8192, "state-validator");
    expect(raw.inputTokens).toBeGreaterThan(117760);
    expect(raw.budgetTokens).toBeUndefined();
    const evidence: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const result = await withExecutionEvidence((type, payload) => evidence.push({ type, payload }),
      () => new StateValidatorAgent(context).validate(chapter, 28, previous, proposed, hooks, hooks, "en", authority),
      undefined, null, "Validate chapter 28 and preserve all earlier chapters.");
    expect(result).toEqual({ consistent: true, reconciliationRequired: false, observations: [] });
    expect(mock.tool).toHaveBeenCalledOnce();
    expect(mock.text).not.toHaveBeenCalled(); // No semantic summarization of authority.
    const messages = mock.tool.mock.calls[0][2] as LLMMessage[];
    const prompt = messages.find(message => message.role === "user")!.content;
    expect(reconstruct(prompt.slice(prompt.indexOf("## State Card:"), prompt.indexOf("\n\n## Hooks:")))).toEqual([previous, proposed]);
    expect(reconstruct(prompt.slice(prompt.indexOf("## Hooks:"), prompt.indexOf("\n\n## Chapter Text")))).toEqual([hooks, hooks]);
    for (const source of [...Object.values(authority), chapter]) expect(prompt).toContain(source);
    expect(messages.map(message => message.content).join("\n")).toContain("Validate chapter 28 and preserve all earlier chapters.");
    const trace = evidence.find(entry => entry.type === "context-compiled" && entry.payload.worker === "state-validator")!.payload.trace as { budgetTokens?: number; finalTokens: number };
    expect(trace.budgetTokens).toBeUndefined();
    expect(trace.finalTokens).toBeLessThan(80000);
  });

  it.each(["authority", "unique projections", "chapter"])("passes protected %s above the former host cap intact to Codex", async (source) => {
    const huge = "权".repeat(120000);
    await new StateValidatorAgent({ client, model: "fixture", projectRoot: "/fixture" }).validate(source === "chapter" ? huge : "Full chapter", 28,
      source === "unique projections" ? huge : "old", "new", "old hooks", "new hooks", "en",
      { storyFrame: source === "authority" ? huge : "Binding authority" });
    expect(mock.tool).toHaveBeenCalledOnce();
    expect((mock.tool.mock.calls[0][2] as LLMMessage[]).some(message => message.content.includes(huge))).toBe(true);
    expect(mock.text).not.toHaveBeenCalled();
  });

  it("preserves a shared state when only hooks change and the existing no-change shortcut", async () => {
    const validator = new StateValidatorAgent({ client, model: "fixture", projectRoot: "/fixture" });
    await validator.validate("Chapter", 28, fact, fact, "Old hooks", "New hooks", "en");
    const prompt = (mock.tool.mock.calls[0][2] as LLMMessage[]).find(message => message.role === "user")!.content;
    expect(prompt).toContain(fact);
    expect(prompt).toContain("Old hooks");
    expect(prompt).toContain("New hooks");
    expect(await validator.validate("Chapter", 28, fact, fact, "Same hooks", "Same hooks", "en"))
      .toEqual({ consistent: true, reconciliationRequired: false, observations: [] });
    expect(mock.tool).toHaveBeenCalledOnce();
  });
});

it("preserves canonical chapter 27 through consecutive unavailable validations for chapters 28–30", async () => {
  mock.tool.mockRejectedValue(Object.assign(new Error("Codex model context window exceeded"), { code: "WORKER_MODEL_ERROR" }));
  const root = await mkdtemp(join(tmpdir(), "inkos-validator-overflow-")); roots.push(root);
  await createInitialRuntimeState({ bookDir: root, language: "en" });
  const initial = await loadRuntimeStateSnapshot(root);
  const canonical = { ...initial, manifest: { ...initial.manifest, lastAppliedChapter: 27 }, currentState: { ...initial.currentState, chapter: 27 } };
  await saveRuntimeStateSnapshot(root, canonical);
  const context = { client, model: "fixture", projectRoot: root };
  const writer = new WriterAgent(context);
  const settleChapterState = vi.fn();
  let index: ReadonlyArray<ChapterMeta> = [];
  for (const chapterNumber of [28, 29, 30]) {
    const output: WriteChapterOutput = { chapterNumber, title: "Saved prose", content: `The witness enters workshop ${chapterNumber}.`, wordCount: 6,
      postSettlement: "Proposed location update", runtimeStateApplied: true, runtimeStateSnapshot: { ...canonical, manifest: { ...canonical.manifest, lastAppliedChapter: chapterNumber } },
      runtimeStateDelta: { chapter: chapterNumber, factOps: { upsert: [{ subject: "witness", predicate: "location", object: `workshop ${chapterNumber}` }], expire: [] },
        hookOps: { upsert: [], mention: [], resolve: [], defer: [] }, newHookCandidates: [],
        chapterSummary: { chapter: chapterNumber, title: "Saved prose", characters: "witness", events: "enters", stateChanges: "location", hookActivity: "", mood: "quiet", chapterType: "scene" } },
      updatedState: "Proposed state", updatedHooks: "Proposed hooks", updatedChapterSummaries: "Proposed summary" };
    const result = await validateChapterTruthPersistence({ writer: { settleChapterState }, validator: new StateValidatorAgent(context),
      book: {} as never, bookDir: root, chapterNumber, title: output.title, content: output.content, persistenceOutput: output,
      previousTruth: { oldState: "Previous state", oldHooks: "Previous hooks" }, authorityContext: { storyFrame: "权".repeat(120000) },
      reducedControlInput: { chapterIntent: "Continue", contextPackage: { chapter: chapterNumber, selectedContext: [] } }, language: "en", logWarn: () => {} });
    expect(result.validation).toMatchObject({ consistent: false, reconciliationRequired: true, observations: [{ code: "state-validation-unavailable" }] });
    expect(result.persistenceOutput.runtimeStateApplied).toBe(false);
    expect(result.persistenceOutput.runtimeStateSnapshot).toEqual(canonical);
    await persistChapterArtifacts({ chapterNumber, chapterTitle: output.title, finalWordCount: output.wordCount,
      auditResult: { summary: "Validation unavailable", observations: result.validation.observations }, loadChapterIndex: async () => index,
      saveChapter: async next => { await writer.saveChapter(root, result.persistenceOutput, "en", next); index = next; }, markBookActiveIfNeeded: async () => {} });
    const chapterPath = (await readdir(join(root, "chapters"))).find(file => file.startsWith(`00${chapterNumber}_`))!;
    expect(await readFile(join(root, "chapters", chapterPath), "utf8")).toContain(output.content);
    expect(await loadRuntimeStateSnapshot(root)).toEqual(canonical);
    // A snapshot directory named for a saved chapter does not imply its state was applied.
    expect(await loadRuntimeStateSnapshotAtChapter({ bookDir: root, chapterNumber, language: "en" })).toEqual(canonical);
  }
  expect(index.map(entry => [entry.number, entry.observations[0]?.code])).toEqual(
    [28, 29, 30].map(chapter => [chapter, "state-validation-unavailable"]));
  expect(JSON.parse(await readFile(join(root, "chapters", "index.json"), "utf8"))).toHaveLength(3);
  expect(settleChapterState).not.toHaveBeenCalled();
  expect(mock.tool).toHaveBeenCalledTimes(3);
});
