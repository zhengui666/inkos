import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeGovernedChapter, type ComposeChapterInput, type CompressibleContextCompileRequest } from "../agents/composer.js";
import type { PlanChapterOutput } from "../agents/planner.js";
import type { BookConfig } from "../models/book.js";
import type { HookRecord, RuntimeStateDelta } from "../models/runtime-state.js";
import { buildRuntimeStateArtifactsFromSnapshot, createInitialRuntimeState, loadRuntimeStateSnapshot, saveRuntimeStateSnapshot } from "../state/runtime-state-store.js";
import { renderNarrativeSelectedContext } from "../utils/narrative-control.js";
import { retrieveMemorySelection } from "../utils/memory-retrieval.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const hook = (hookId: string, extra: Partial<HookRecord> = {}): HookRecord => ({
  hookId, startChapter: 0, type: "mystery", status: "open", lastAdvancedChapter: 0,
  expectedPayoff: `Explain ${hookId}`, notes: `Stored evidence for ${hookId}`, ...extra,
});
const book: BookConfig = { id: "dependency-fixture", title: "The Quay", genre: "mystery", platform: "other", language: "en",
  status: "outlining", targetChapters: 12, chapterWordCount: 1200, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };
function plan(threadRefs: string[], chapter = 2): PlanChapterOutput {
  return { intent: { chapter, goal: "Follow the ledger evidence" }, memo: { chapter, goal: "Follow the ledger evidence", body: "Develop the investigation without inventing prior facts.", threadRefs },
    intentMarkdown: "Synthetic offline fixture", plannerInputs: [], runtimePath: "runtime/fixture" };
}
async function setup(hooks: HookRecord[]) {
  const bookDir = await mkdtemp(join(tmpdir(), "inkos-hook-dependency-")); roots.push(bookDir);
  const snapshot = await createInitialRuntimeState({ bookDir, language: "en", hooks });
  return { bookDir, snapshot };
}
function compose(bookDir: string, threadRefs: string[], extra: Partial<ComposeChapterInput> = {}) {
  return composeGovernedChapter({ book, bookDir, chapterNumber: 2, plan: plan(threadRefs),
    outlineSectionSelector: async () => [], memorySemanticSelector: async () => [], ...extra });
}

describe("canonical hook dependency evidence", () => {
  it("carries authored fields from a settlement update through projection, retrieval and protected context", async () => {
    const f = await setup([hook("ledger"), hook("witness", { status: "resolved", notes: "The witness named the previous owner." })]);
    const delta: RuntimeStateDelta = { chapter: 1, factOps: { upsert: [], expire: [] }, newHookCandidates: [],
      hookOps: { upsert: [hook("ledger", { dependsOn: ["witness"], paysOffInArc: "Return to the quay" })], mention: [], resolve: [], defer: [] } };
    const artifacts = buildRuntimeStateArtifactsFromSnapshot({ snapshot: f.snapshot, delta, language: "en" });
    expect(artifacts.snapshot.hooks.hooks.find(item => item.hookId === "ledger")).toMatchObject({ dependsOn: ["witness"], paysOffInArc: "Return to the quay" });
    await saveRuntimeStateSnapshot(f.bookDir, artifacts.snapshot);
    expect(await readFile(join(f.bookDir, "story/pending_hooks.md"), "utf8")).toContain("Return to the quay");
    const selector = vi.fn(async request => request.candidates.filter((item: { id: string }) => item.id === "hook:ledger").map((item: { id: string }) => item.id));
    const selected = await retrieveMemorySelection({ bookDir: f.bookDir, chapterNumber: 2, goal: "Return to the quay", semanticSelector: selector });
    expect(selector.mock.calls[0]![0].candidates.find((item: { id: string }) => item.id === "hook:ledger").excerpt).toContain("dependsOn=witness");
    expect(selected.hooks.map(item => item.hookId)).toEqual(["ledger"]);
    expect(selected.lookupHooks.find(item => item.hookId === "witness")?.status).toBe("resolved");
    const output = await compose(f.bookDir, ["ledger"], { memorySemanticSelector: selector });
    const entries = output.contextPackage.selectedContext;
    const ledger = entries.find(item => item.source === "runtime/referenced_hook#ledger")!;
    const witness = entries.find(item => item.source === "runtime/referenced_hook#witness")!;
    expect(ledger).toMatchObject({ protection: "protected" });
    expect(ledger.excerpt).toContain("dependsOn=witness");
    expect(ledger.excerpt).toContain("paysOffInArc=Return to the quay");
    expect(ledger.excerpt).toContain("author-authored context, not a deadline");
    expect(witness).toMatchObject({ protection: "protected" });
    expect(witness.excerpt).toContain("status=resolved");
    expect(witness.excerpt).toContain("historical evidence only");
    expect(witness.excerpt).toContain("story/state/hooks.json#witness");
    expect(witness.excerpt).toContain("required by=ledger");
    expect(output.trace.contextTiers?.protectedSources).toContain(witness.source);
    const writerEvidence = renderNarrativeSelectedContext(entries, "en");
    expect(writerEvidence).toContain("source=story/state/hooks.json#witness");
    expect(writerEvidence).toContain("required by=ledger");
    expect((await loadRuntimeStateSnapshot(f.bookDir)).hooks).toEqual(artifacts.snapshot.hooks);
  });

  it("expands semantically selected dependencies without a memo reference and keeps unrelated history out", async () => {
    const f = await setup([hook("ledger", { dependsOn: ["witness"] }), hook("witness", { status: "resolved" }), hook("unrelated", { status: "resolved" })]);
    const output = await compose(f.bookDir, [], { memorySemanticSelector: async () => ["hook:ledger"] });
    expect(output.contextPackage.selectedContext.filter(item => item.source.startsWith("runtime/referenced_hook#")).map(item => item.source))
      .toEqual(["runtime/referenced_hook#ledger", "runtime/referenced_hook#witness"]);
    expect(output.contextPackage.selectedContext.some(item => item.source === "story/pending_hooks.md#ledger")).toBe(false);
    expect(output.trace.retrieval?.semanticSelectedIds).toEqual(["hook:ledger"]);
    expect(output.trace.retrieval?.candidates.map(item => item.id)).not.toContain("hook:witness");
  });

  it("deduplicates repeated roots, diamond dependencies and cycles while keeping every causal edge", async () => {
    const f = await setup([hook("a", { dependsOn: ["b", "b", "c"] }), hook("b", { dependsOn: ["d"] }), hook("c", { dependsOn: ["d"] }), hook("d", { dependsOn: ["a", "d"] })]);
    const output = await compose(f.bookDir, ["a", "a", "c"]);
    const entries = output.contextPackage.selectedContext.filter(item => item.source.startsWith("runtime/referenced_hook#"));
    expect(entries.map(item => item.source)).toEqual(["runtime/referenced_hook#a", "runtime/referenced_hook#c", "runtime/referenced_hook#b", "runtime/referenced_hook#d"]);
    expect(entries.find(item => item.source.endsWith("#a"))?.excerpt).toContain("dependsOn=b, c");
    expect(entries.find(item => item.source.endsWith("#d"))?.excerpt).toContain("required by=c, b, d");
    expect(entries.find(item => item.source.endsWith("#d"))?.excerpt).toContain("dependsOn=a, d");
    expect(entries.every(item => item.protection === "protected")).toBe(true);
  });

  it("surfaces missing exact IDs without title guessing or blocking authorized new hook seeding", async () => {
    const f = await setup([hook("canonical-ledger", { type: "Renamed ledger", dependsOn: ["absent"] })]);
    const output = await compose(f.bookDir, ["Renamed ledger", "canonical-ledger", "absent"]);
    const missing = output.contextPackage.selectedContext.filter(item => item.source.startsWith("runtime/missing_hook#"));
    expect(missing.map(item => item.source)).toEqual(["runtime/missing_hook#Renamed ledger", "runtime/missing_hook#absent"]);
    expect(missing.every(item => item.protection === "protected" && item.excerpt?.includes("not found in story/state/hooks.json"))).toBe(true);
    expect(missing.find(item => item.source.endsWith("#absent"))?.excerpt).toContain("required by=canonical-ledger");
    expect(missing[0]?.excerpt).toContain("no prior history is established");
    expect(renderNarrativeSelectedContext(output.contextPackage.selectedContext, "en")).toContain("Renamed ledger: not found");
    const seeded = buildRuntimeStateArtifactsFromSnapshot({ snapshot: f.snapshot, language: "en", allowNewHooks: true,
      delta: { chapter: 1, factOps: { upsert: [], expire: [] }, hookOps: { upsert: [], mention: [], resolve: [], defer: [] },
        newHookCandidates: [{ type: "mystery", expectedPayoff: "Who left the new key?", notes: "A newly authored seed" }] } });
    expect(seeded.snapshot.hooks.hooks).toHaveLength(2);
  });

  it.each(["en", "zh"] as const)("retains superseded withdrawal authority and resolved history in %s without reactivating either", async language => {
    const f = await setup([hook("ledger", { dependsOn: ["withdrawn", "past"] }),
      hook("withdrawn", { status: "superseded", dependsOn: ["obsolete"], notes: "Author withdrew the workshop prohibition." }),
      hook("past", { status: "resolved", dependsOn: ["historical-only"] }), hook("obsolete", { status: "resolved" }), hook("historical-only")]);
    // Even when a chapter summary provides a seed, the withdrawal reason is
    // independent authority and must remain in the writer's context.
    await saveRuntimeStateSnapshot(f.bookDir, { ...f.snapshot, chapterSummaries: { rows: [{ chapter: 1,
      title: "The former plan", characters: "", events: "withdrawn once suggested a rule", stateChanges: "",
      hookActivity: "withdrawn was only proposed", mood: "", chapterType: "" }] } });
    const saved = await loadRuntimeStateSnapshot(f.bookDir);
    const output = await compose(f.bookDir, ["ledger"], { book: { ...book, language } });
    const entries = output.contextPackage.selectedContext;
    const withdrawn = entries.find(item => item.source === "runtime/referenced_hook#withdrawn")!;
    expect(withdrawn.excerpt).toContain("Author withdrew the workshop prohibition.");
    expect(withdrawn.excerpt).toContain(language === "en" ? "withdrawn authority; do not reactivate" : "已撤回的约束，不得重新启用");
    expect(entries.find(item => item.source === "runtime/referenced_hook#past")?.excerpt).toContain(language === "en" ? "historical evidence only" : "仅作历史证据");
    expect(entries.some(item => item.source === "runtime/referenced_hook#obsolete")).toBe(false);
    expect(entries.some(item => item.source === "runtime/referenced_hook#historical-only")).toBe(false);
    expect((await loadRuntimeStateSnapshot(f.bookDir)).hooks).toEqual(saved.hooks);
  });

  it("protects explicit empty updates and arc-only selections without inferring a payoff date", async () => {
    const f = await setup([hook("cleared", { dependsOn: [], paysOffInArc: "" }), hook("arc", { paysOffInArc: "The return" })]);
    const output = await compose(f.bookDir, [], { memorySemanticSelector: async () => ["hook:cleared", "hook:arc"] });
    const entries = output.contextPackage.selectedContext;
    expect(entries.find(item => item.source === "runtime/referenced_hook#cleared")).toMatchObject({ protection: "protected" });
    expect(entries.find(item => item.source === "runtime/referenced_hook#cleared")?.excerpt).toContain("dependsOn=");
    expect(entries.find(item => item.source === "runtime/referenced_hook#cleared")?.excerpt).toContain("paysOffInArc= (author-authored context, not a deadline)");
    expect(entries.find(item => item.source === "runtime/referenced_hook#arc")?.excerpt).toContain("paysOffInArc=The return");
  });

  it("keeps legacy fields omitted and permits unresolved dependencies at a late chapter", async () => {
    const f = await setup([hook("old"), hook("active", { dependsOn: ["old"], paysOffInArc: "Whenever the author returns here" })]);
    const output = await compose(f.bookDir, ["active"], { chapterNumber: 500, plan: plan(["active"], 500) });
    expect(output.contextPackage.selectedContext.find(item => item.source === "runtime/referenced_hook#old")?.excerpt).toContain("status=open");
    expect(output.contextPackage.selectedContext.find(item => item.source === "runtime/referenced_hook#old")?.excerpt).not.toContain("paysOffInArc=");
    expect((await loadRuntimeStateSnapshot(f.bookDir)).hooks.hooks.find(item => item.hookId === "old")).not.toHaveProperty("dependsOn");
  });

  it("preserves dependency evidence through compression and fails explicitly if protected evidence cannot fit", async () => {
    const f = await setup([hook("ledger", { dependsOn: ["witness"] }), hook("witness", { status: "resolved" })]);
    await writeFile(join(f.bookDir, "story/volume_summaries.md"), `## Earlier arc\n${"Optional arc detail. ".repeat(8_000)}`);
    const compiler = vi.fn(async () => "Earlier events are summarized.");
    const output = await compose(f.bookDir, ["ledger"], { memorySemanticSelector: async () => ["volume-summary:0"],
      contextBudget: { contextWindowTokens: 4_000, reservedOutputTokens: 500 }, compressibleContextCompiler: compiler });
    expect(compiler).toHaveBeenCalledTimes(1);
    const request = compiler.mock.calls[0] as unknown as [{ protectedEntries: Array<{ source: string }>; compressibleEntries: Array<{ source: string }> }];
    expect(request[0].protectedEntries.map(item => item.source)).toContain("runtime/referenced_hook#witness");
    expect(request[0].compressibleEntries.map(item => item.source)).toEqual(["story/volume_summaries.md#earlier-arc"]);
    expect(output.contextPackage.selectedContext.find(item => item.source === "runtime/referenced_hook#witness")?.excerpt).toContain("Stored evidence for witness");
    expect(output.trace.tokenBudget?.totalSelectedTokens).toBeLessThanOrEqual(3_500);
    compiler.mockClear();
    await expect(compose(f.bookDir, ["ledger"], { contextBudget: { contextWindowTokens: 10, reservedOutputTokens: 0 }, compressibleContextCompiler: compiler }))
      .rejects.toThrow("Protected context exceeds available input budget");
    expect(compiler).not.toHaveBeenCalled();
  });
  it("rejects an oversized compression result before persisting an over-budget context", async () => {
    const f = await setup([hook("ledger", { dependsOn: ["witness"] }), hook("witness", { status: "resolved" })]);
    await writeFile(join(f.bookDir, "story/volume_summaries.md"), `## Earlier arc\n${"Optional arc detail. ".repeat(8_000)}`);
    const compiler = vi.fn(async () => "Still too much context. ".repeat(8_000));
    const compression = vi.fn();
    await expect(compose(f.bookDir, ["ledger"], { memorySemanticSelector: async () => ["volume-summary:0"],
      contextBudget: { contextWindowTokens: 4_000, reservedOutputTokens: 500 }, compressibleContextCompiler: compiler,
      onContextCompression: compression })).rejects.toThrow("Compiled context exceeds available input budget");
    expect(compiler).toHaveBeenCalledTimes(1);
    expect(compression.mock.calls.at(-1)?.[0]).toMatchObject({ phase: "error" });
    await expect(readFile(join(f.bookDir, "story/runtime/chapter-0002.context.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fits a compliant compiler result at its exact requested limit including the entry wrapper", async () => {
    const f = await setup([hook("ledger", { dependsOn: ["witness"] }), hook("witness", { status: "resolved" })]);
    await writeFile(join(f.bookDir, "story/volume_summaries.md"), `## Earlier arc\n${"Optional arc detail. ".repeat(8_000)}`);
    const compiler = vi.fn(async (request: CompressibleContextCompileRequest) => "界".repeat(request.maxInputTokens));
    const output = await compose(f.bookDir, ["ledger"], { memorySemanticSelector: async () => ["volume-summary:0"],
      contextBudget: { contextWindowTokens: 4_000, reservedOutputTokens: 500 }, compressibleContextCompiler: compiler });
    expect(compiler).toHaveBeenCalledTimes(1);
    expect(output.trace.tokenBudget.totalSelectedTokens).toBe(3_500);
    expect(output.trace.contextTiers.protectedSources).toContain("runtime/referenced_hook#witness");
    expect(output.contextPackage.selectedContext.find(item => item.source === "runtime/referenced_hook#witness")?.excerpt).toContain("historical evidence only");
  });

  it("does not invoke the compiler when protected evidence leaves no room for its entry wrapper", async () => {
    const f = await setup([hook("ledger", { dependsOn: ["witness"] }), hook("witness", { status: "resolved" })]);
    await writeFile(join(f.bookDir, "story/volume_summaries.md"), `## Earlier arc\n${"Optional arc detail. ".repeat(8_000)}`);
    const unbounded = await compose(f.bookDir, ["ledger"], { memorySemanticSelector: async () => ["volume-summary:0"] });
    const compiler = vi.fn(async () => "A summary");
    await expect(compose(f.bookDir, ["ledger"], { memorySemanticSelector: async () => ["volume-summary:0"],
      contextBudget: { contextWindowTokens: unbounded.trace.tokenBudget.protectedTokens + 1, reservedOutputTokens: 0 },
      compressibleContextCompiler: compiler })).rejects.toThrow("No room for compiled context");
    expect(compiler).not.toHaveBeenCalled();
  });

});
