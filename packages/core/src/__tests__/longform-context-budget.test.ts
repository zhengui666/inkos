import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SemanticContextCompilerAgent } from "../agents/semantic-context-compiler.js";
import { WriterAgent } from "../agents/writer.js";
import { fitGovernedContext } from "../agents/governed-context-budget.js";
import { prepareWorkerInput } from "../agents/base.js";
import { createInitialRuntimeState, loadRuntimeStateSnapshot, saveRuntimeStateSnapshot } from "../state/runtime-state-store.js";
import { withExecutionEvidence } from "../harness/execution-evidence.js";
import type { LLMClient, LLMMessage } from "../llm/provider.js";
import { estimateTextTokens } from "../llm/provider.js";
import type { ContextPackage } from "../models/input-governance.js";

const mock = vi.hoisted(() => ({ tool: vi.fn(), text: vi.fn() }));
vi.mock("../agent/worker-agent.js", () => ({ runWorkerAgentTool: mock.tool, runWorkerAgent: mock.text }));
const client: LLMClient = { provider: "openai", apiFormat: "responses", stream: true,
  defaults: { temperature: 0, maxTokens: 16384, thinkingBudget: 0, extra: {} },
  _codex: { projectRoot: "/fixture" } };
const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
const roots: string[] = [];
beforeEach(() => { mock.tool.mockReset(); mock.text.mockReset(); mock.text.mockResolvedValue({ content: "Prior events are source-backed background, not new authority.", usage }); });
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe("consumer-sized governed context", () => {
  const protectedEntry = { source: "author_intent", reason: "Binding author intent", excerpt: "Do not open the sealed letter.", protection: "protected" as const };
  const render = (context: ContextPackage): LLMMessage[] => [{ role: "system", content: "Protected protocol" },
    { role: "user", content: "Current chapter must stay verbatim\n" + context.selectedContext.map(entry => `${entry.source}: ${entry.excerpt}`).join("\n") }];

  it("compiles only already-compressible evidence using the complete consumer and author envelope", async () => {
    const contextPackage: ContextPackage = { chapter: 18, selectedContext: [protectedEntry,
      { source: "history", reason: "Retrieved history", excerpt: "往".repeat(115000), protection: "compressible" }] };
    const result = await withExecutionEvidence(() => {}, () => fitGovernedContext({ context: { client, projectRoot: "/fixture", model: "fixture" },
      worker: "writer", language: "en", contextPackage, render }), undefined, null, "Write only chapter 18; never modify chapters 1–17.");
    expect(result.selectedContext[0]).toEqual(protectedEntry);
    expect(contextPackage.selectedContext[1]!.excerpt!.length).toBe(115000);
    expect(mock.tool).not.toHaveBeenCalled();
    expect(mock.text).toHaveBeenCalled();
    const compilerInput = mock.text.mock.calls.flatMap(call => call[2] as LLMMessage[]).map(message => message.content).join("\n");
    expect(compilerInput).not.toContain(protectedEntry.excerpt);
    expect(compilerInput).toContain("Write only chapter 18; never modify chapters 1–17.");
    const prepared = await prepareWorkerInput({ client, projectRoot: "/fixture" }, render(result), undefined, "writer");
    expect(prepared.inputTokens).toBeLessThan(prepared.budgetTokens!);
  });

  it("fails closed without a model call when genuine protected authority cannot fit", async () => {
    const contextPackage: ContextPackage = { chapter: 18, selectedContext: [{ ...protectedEntry, excerpt: "权".repeat(115000) },
      { source: "history", reason: "history", excerpt: "background", protection: "compressible" }] };
    await expect(fitGovernedContext({ context: { client, projectRoot: "/fixture", model: "fixture" }, worker: "writer",
      language: "en", contextPackage, render })).rejects.toMatchObject({ code: "PROTECTED_CONTEXT_OVERFLOW", budgetTokens: 109568 });
    expect(mock.text).not.toHaveBeenCalled(); expect(mock.tool).not.toHaveBeenCalled();
  });

  it("does not summarize already fitting evidence and stops before preparation when cancelled", async () => {
    const contextPackage: ContextPackage = { chapter: 18, selectedContext: [protectedEntry] };
    expect(await fitGovernedContext({ context: { client, projectRoot: "/fixture", model: "fixture" }, worker: "writer", language: "en", contextPackage, render })).toBe(contextPackage);
    const controller = new AbortController(); controller.abort(new Error("User stopped"));
    await expect(fitGovernedContext({ context: { client, projectRoot: "/fixture", model: "fixture", signal: controller.signal }, worker: "writer", language: "en", contextPackage, render })).rejects.toThrow("User stopped");
    expect(mock.text).not.toHaveBeenCalled();
  });
});

it.each([true, false])("settles chapter 18 and preserves 556 fact versions (retired history: %s)", async retired => {
  const root = await mkdtemp(join(tmpdir(), "inkos-settlement-budget-")); roots.push(root);
  await createInitialRuntimeState({ bookDir: root, language: "en", hooks: ["open", "resolved", "superseded"].map((status, index) => ({
    hookId: `hook-${index}`, startChapter: 1, lastAdvancedChapter: 17, type: "mystery", status: status as "open" | "resolved" | "superseded", expectedPayoff: "A promise", notes: "Historical evidence" })) });
  await writeFile(join(root, "story/book_rules.md"), "Keep canon");
  await writeFile(join(root, "story/book_rules.json"), JSON.stringify({ version: "2", prohibitions: [], enableFullCastTracking: false, allowedDeviations: [] }));
  const initial = await loadRuntimeStateSnapshot(root);
  const facts = Array.from({ length: 556 }, (_, index) => ({ subject: `person-${index}`, predicate: "location",
    object: `fact-${index} ${"史".repeat(125)}`, validFromChapter: 1, validUntilChapter: retired && index < 351 ? 17 : index === 351 ? 18 : null, sourceChapter: 1 }));
  const snapshot = { ...initial, manifest: { ...initial.manifest, lastAppliedChapter: 17 }, currentState: { chapter: 17, facts } };
  await saveRuntimeStateSnapshot(root, snapshot);
  const before = await readFile(join(root, "story/state/current_state.json"));
  await mkdir(join(root, "chapters"));
  await writeFile(join(root, "chapters/0017_Fixture.md"), "Previously committed chapter 17 must remain byte-for-byte unchanged.");
  const entries: ContextPackage["selectedContext"] = [{ source: "story/author_intent.md", reason: "Binding", excerpt: "Keep the letter sealed", protection: "protected" },
    { source: "historical-state", reason: "Explicitly selected historical evidence", excerpt: "This selected retired fact remains evidence", protection: "protected" },
    { source: "history", reason: "Relevant background", excerpt: "证".repeat(20596), protection: "compressible" }];
  const duplicates = facts.slice(400).map((fact, offset) => ({ source: `runtime/current_state#${401 + offset}-person-location`,
    reason: "Current-state fact selected for the current chapter task.", protection: "protected" as const,
    excerpt: [`subject: ${fact.subject}`, `predicate: ${fact.predicate}`, `object: ${fact.object}`, `validFromChapter: ${fact.validFromChapter}`, "validUntilChapter: current"].join("\n") }));
  let baseline: any;
  mock.tool.mockImplementation(async (_client, _model, messages: LLMMessage[], tool) => {
    expect(tool.name).toBe("submit_runtime_state_delta");
    const prompt = messages.find(message => message.role === "user")!.content;
    baseline = JSON.parse(prompt.split("## Settlement baseline\n")[1]!.split("\n").slice(1).join("\n"));
    expect(prompt).toContain("This selected retired fact remains evidence");
    expect(prompt).toContain("Keep the letter sealed");
    expect(prompt).toContain("Exact selected fact: see Settlement baseline /currentState/facts/");
    expect(prompt.split(facts[400]!.object)).toHaveLength(2); // Present exactly once, verbatim in the baseline.
    return { postSettlement: "No new facts", factOps: { upsert: [], expire: [] }, hookOps: { upsert: [], mention: [], resolve: [], defer: [] }, newHookCandidates: [],
      chapterSummary: { title: "Chapter", characters: "Person", events: "Waiting", stateChanges: "", hookActivity: "", mood: "quiet", chapterType: "scene" } };
  });
  const book = { id: "fixture", title: "Fixture", genre: "other", platform: "other", language: "en" as const, status: "active" as const,
    targetChapters: 30, chapterWordCount: 100, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const result = await new WriterAgent({ client, model: "fixture", projectRoot: root }).settleChapterState({ book, bookDir: root,
    chapterNumber: 18, title: "Chapter", content: "The person waits outside.", chapterIntent: "Do not open the letter.", contextPackage: { chapter: 18, selectedContext: [...entries, ...duplicates] } });
  expect(estimateTextTokens(JSON.stringify(snapshot.currentState))).toBeGreaterThan(79000);
  expect(baseline.currentState.facts).toEqual(retired ? facts.slice(351) : facts);
  expect(baseline.hooks).toEqual(snapshot.hooks);
  expect(result.runtimeStateSnapshot.currentState.facts).toEqual(facts.slice().sort((a, b) => a.predicate.localeCompare(b.predicate) || a.object.localeCompare(b.object)));
  expect(result.runtimeStateSnapshot.hooks).toEqual(snapshot.hooks);
  expect(await readFile(join(root, "story/state/current_state.json"))).toEqual(before);
  expect(await readFile(join(root, "chapters/0017_Fixture.md"), "utf8")).toBe("Previously committed chapter 17 must remain byte-for-byte unchanged.");
  expect(mock.tool).toHaveBeenCalledOnce();
});


it("stops a semantic compiler fixed point rather than treating fresh metadata as compression progress", async () => {
  const small: LLMClient = { ...client, _codex: undefined, _piModel: { contextWindow: 3150 } as never,
    defaults: { ...client.defaults, maxTokens: 512 } };
  let calls = 0;
  mock.text.mockImplementation(async (_client, _model, messages: LLMMessage[]) => {
    if (++calls > 20) throw new Error("Fixture caught an unbounded compilation loop");
    const text = messages.filter(message => message.role === "user").map(message => message.content).join("\n");
    return { content: /[\u3400-\u9fff]/.test(text) ? "缩".repeat(200) : "m", usage };
  });
  await expect(new SemanticContextCompilerAgent({ client: small, projectRoot: "/fixture", model: "fixture" }).compile({
    intent: "Keep relevant evidence", language: "en", maxTokens: 512,
    fragments: [{ id: "history", source: "history", content: "源".repeat(600), protection: "compressible", priority: 0 }],
  })).rejects.toThrow("made no progress");
  expect(calls).toBeLessThan(10);
  expect(mock.tool).not.toHaveBeenCalled();
});
