import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WriterAgent } from "../agents/writer.js";
import { createWorkManifest, saveWorkManifest } from "../harness/work-store.js";
import type { LLMClient, LLMMessage } from "../llm/provider.js";
import type { BookConfig } from "../models/book.js";
import type { ContextPackage } from "../models/input-governance.js";
import { createInitialRuntimeState, loadRuntimeStateSnapshot, saveRuntimeStateSnapshot } from "../state/runtime-state-store.js";

const worker = vi.hoisted(() => ({ tool: vi.fn(), text: vi.fn() }));
vi.mock("../agent/worker-agent.js", () => ({ runWorkerAgentTool: worker.tool, runWorkerAgent: worker.text }));
const client: LLMClient = { provider: "openai", apiFormat: "responses", stream: true,
  defaults: { temperature: 0, maxTokens: 16384, thinkingBudget: 0, extra: {} },
  _codex: { projectRoot: "/fixture" } };
const roots: string[] = [];
const book: BookConfig = { id: "prose-contract", title: "Fixture", genre: "general", platform: "other", language: "zh",
  status: "active", targetChapters: 30, chapterWordCount: 300,
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };

beforeEach(() => { worker.tool.mockReset(); worker.text.mockReset(); });
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

// Deliberately fixed model outputs exercise real Skill hydration, evidence
// transfer and state reduction. They do not test a model's extraction accuracy
// or literary quality. Recognition on delivery is this fixture's explicit
// story policy, not a policy imposed on other works by the runtime.
const cases = [
  { name: "new balance payment and delivery", received: true, delivered: true, unknown: false,
    prose: {
      zh: "策展人付清270元尾款。陶艺师确认到账，把烧制完成的灯座和配套灯罩交到他手里。他抱着两件陶器走出工作室。",
      en: "The curator paid the remaining 270. The ceramicist confirmed receipt and handed over the finished lamp base and matching shade. He carried both pieces out.",
    } },
  { name: "promise without receipt or delivery", received: false, delivered: false, unknown: false,
    prose: {
      zh: "策展人说，270元尾款等下周再付。陶艺师没有收到款，也没有交货；灯座和配套灯罩仍留在工作台上。",
      en: "The curator promised to pay the remaining 270 next week. No money arrived and nothing was handed over; the base and shade stayed on the workbench.",
    } },
  { name: "delivery with the balance still unpaid", received: false, delivered: true, unknown: false,
    prose: {
      zh: "策展人请求赊下270元尾款。陶艺师没有收到新款，但把灯座和配套灯罩交到他手里。他抱着两件陶器离开，尾款仍欠着。",
      en: "The curator asked to owe the remaining 270. The ceramicist received no new payment but handed over the base and matching shade. He left with both pieces, still owing the balance.",
    } },
  { name: "new balance received before delivery", received: true, delivered: false, unknown: false,
    prose: {
      zh: "策展人付清270元尾款，陶艺师确认到账。灯座和配套灯罩还要晾干，两件都留在工作室，没有交货。",
      en: "The curator paid the remaining 270 and the ceramicist confirmed receipt. The base and shade still needed to dry; both stayed in the workshop without a handover.",
    } },
  { name: "receipt and delivery with uncertain opening totals and recognition", received: true, delivered: true, unknown: true,
    prose: {
      zh: "策展人付清270元尾款。陶艺师确认到账，将灯座和配套灯罩交给他。早先的总账不在手边，两人没有核算账户总额。",
      en: "The curator paid the remaining 270. The ceramicist confirmed receipt and handed over the base and shade. The earlier ledger was unavailable; neither established the account totals.",
    } },
] as const;

describe.each(["zh", "en"] as const)("writer to settler evidence in %s", language => {
  it.each(cases)("preserves the contract for $name", async scenario => {
    const root = await mkdtemp(join(tmpdir(), "inkos-prose-contract-")); roots.push(root);
    const bookDir = join(root, "works", book.id, "source");
    await saveWorkManifest(root, createWorkManifest({ id: book.id, title: book.title, profileId: "longform-novel", language }));
    const initial = await createInitialRuntimeState({ bookDir, language, hooks: [{
      hookId: "hook-existing", startChapter: 3, lastAdvancedChapter: 5, type: "relationship", status: "open",
      expectedPayoff: "An unanswered invitation", notes: "Not resolved by the collection attempt." }] });
    const opening = [
      { subject: "workshop", predicate: "cash", object: scenario.unknown ? "unknown" : "8400" },
      { subject: "workshop", predicate: "completed income", object: scenario.unknown ? "unknown" : "2100" },
      { subject: "order", predicate: "price", object: "360" },
      { subject: "order", predicate: "prepayment already received", object: "90" },
      { subject: "order", predicate: "unearned prepayment", object: scenario.unknown ? "unknown" : "90" },
      { subject: "order", predicate: "balance due", object: "270" },
      { subject: "order", predicate: "handover", object: "pending" },
      { subject: "sealed letter", predicate: "location", object: "drawer" },
    ];
    const baseline = { ...initial, manifest: { ...initial.manifest, lastAppliedChapter: 5 },
      currentState: { chapter: 5, facts: opening.map(fact => ({ ...fact, validFromChapter: 5, validUntilChapter: null, sourceChapter: 5 })) } };
    await saveRuntimeStateSnapshot(bookDir, baseline);
    await writeFile(join(bookDir, "story/book_rules.json"), JSON.stringify({ version: "2", prohibitions: ["Do not open the letter"], enableFullCastTracking: false, allowedDeviations: [] }));
    await writeFile(join(bookDir, "story/book_rules.md"), "Do not open the letter.");
    await writeFile(join(bookDir, "story/style_guide.md"), "Keep the accepted voice; show the disputed choice.");
    await mkdir(join(bookDir, "chapters"));
    const originalPath = join(bookDir, "chapters/0005_Fixture.md");
    await writeFile(originalPath, "Previously accepted prose stays unchanged.");
    const statePath = join(bookDir, "story/state/current_state.json");
    const beforeState = await readFile(statePath);
    const contextPackage: ContextPackage = { chapter: 6, selectedContext: [
      { source: "story/author_intent.md", reason: "Author direction", excerpt: "Avoid reading a procedural manual or ledger aloud.", protection: "protected" },
      { source: "opening-facts", reason: "Story-specific recognition and opening evidence", protection: "protected", excerpt: scenario.unknown
        ? "Opening cash and completed income are unknown. A prior 90 advance was received, but its inclusion in any opening total and its recognition are unknown. No income-recognition policy has been established. Do not invent totals or unearned amounts; a new receipt and handover can still be recorded."
        : "The 90 advance is already included in cash 8400. Completed income 2100 excludes this order. All payments before delivery remain unearned. Recognize the full price 360 only on completed delivery, whether or not the balance has been paid, and clear all unearned prepayment at that point. Nothing else changes these accounts." },
      { source: "order-and-hook", reason: "Known order and promise", excerpt: "Price 360; 90 already paid; balance 270. The existing promise is hook-existing. The letter stays sealed.", protection: "protected" },
    ] };
    const content = scenario.prose[language];
    const changed = [
      ...(!scenario.unknown && scenario.received ? [{ subject: "workshop", predicate: "cash", object: "8670" }] : []),
      ...(!scenario.unknown && scenario.delivered ? [
        { subject: "workshop", predicate: "completed income", object: "2460" },
        { subject: "order", predicate: "unearned prepayment", object: "0" },
      ] : []),
      ...(!scenario.unknown && scenario.received && !scenario.delivered ? [{ subject: "order", predicate: "unearned prepayment", object: "360" }] : []),
      ...(scenario.received ? [{ subject: "order", predicate: "balance due", object: "0" }] : []),
      ...(scenario.delivered ? [{ subject: "order", predicate: "handover", object: "completed; ceramic lamp base and matching shade collected" }] : []),
      ...(scenario.unknown ? [{ subject: "order", predicate: "new payment received", object: "270" }] : []),
    ];
    const memo = { chapter: 6, goal: "Resolve the collection attempt through a choice.",
      body: "Required scene: resolve the collection attempt. Background: the letter stays sealed. Preserve the existing invitation without resolving it.", threadRefs: ["hook-existing"] };
    const externalContext = "Honor the current author request; keep the title Collection.";
    const projectionGuide = await readFile(new URL("../../skills/inkos-long-writing/references/state-projection.md", import.meta.url), "utf8");
    worker.tool.mockImplementation(async (_client, _model, messages: LLMMessage[], tool) => {
      const system = messages.filter(message => message.role === "system").map(message => message.content).join("\n");
      const user = messages.find(message => message.role === "user")!.content;
      // The linked method must reach both requests. Match the current contract's
      // distinctions, not obsolete writer-prompt sentences from the earlier PR.
      expect(system).toContain(projectionGuide.replace(/\r\n?/g, "\n").trim());
      for (const meaning of [/advances.*new payments/, /total price.*amount due/, /cash.*earned income/,
        /only.*unambiguous openings.*transactions.*story-defined recognition/, /otherwise.*unknowns/, /Promises are not receipts/]) {
        expect(projectionGuide).toMatch(meaning);
      }
      for (const entry of contextPackage.selectedContext) expect(user).toContain(entry.excerpt);
      if (tool.name === "submit_chapter_draft") {
        expect(system).toContain("Keep the accepted voice; show the disputed choice.");
        expect(user).toContain(memo.body);
        expect(user).toContain(externalContext);
        expect(user).toContain("hook-existing");
        return { title: "Collection", content };
      }
      expect(tool.name).toBe("submit_runtime_state_delta");
      expect(user).toContain(content);
      const supplied = JSON.parse(user.split("## Settlement baseline\n")[1]!.split("\n").slice(1).join("\n"));
      expect(supplied.chapter).toBe(5);
      expect(supplied.currentState).toEqual(baseline.currentState);
      expect(supplied.hooks).toEqual(baseline.hooks);
      return { postSettlement: "Only the chapter-established changes are projected under the supplied story policy.",
        factOps: { upsert: changed, expire: changed.filter(change => opening.some(fact => fact.subject === change.subject && fact.predicate === change.predicate))
          .map(({ subject, predicate }) => ({ subject, predicate })) },
        hookOps: { upsert: [], mention: [], resolve: [], defer: [] }, newHookCandidates: [],
        chapterSummary: { title: "Collection", characters: "Curator and ceramicist", events: content,
          stateChanges: scenario.name, hookActivity: "", mood: "quiet", chapterType: "scene" } };
    });
    const result = await new WriterAgent({ client, model: "fixture", projectRoot: root, bookId: book.id }).writeChapter({
      book: { ...book, language }, bookDir, chapterNumber: 6, chapterIntent: memo.goal, chapterMemo: memo, contextPackage, externalContext });
    expect(worker.tool).toHaveBeenCalledTimes(2);
    expect(worker.text).not.toHaveBeenCalled();
    expect(result.content).toBe(content);
    expect(content).not.toMatch(/8400|8670|2100|2460/);
    const active = result.runtimeStateSnapshot.currentState.facts.filter(fact => fact.validUntilChapter === null);
    for (const fact of opening) {
      const expected = changed.find(change => change.subject === fact.subject && change.predicate === fact.predicate) ?? fact;
      expect(active).toContainEqual(expect.objectContaining(expected));
    }
    expect(active).toHaveLength(opening.length + (scenario.unknown ? 1 : 0));
    if (scenario.unknown) {
      expect(active).toContainEqual(expect.objectContaining({ subject: "order", predicate: "new payment received", object: "270" }));
      expect(result.runtimeStateDelta.factOps.upsert.some(fact => ["cash", "completed income", "unearned prepayment"].includes(fact.predicate))).toBe(false);
    }
    expect(result.runtimeStateSnapshot.hooks).toEqual(baseline.hooks);
    expect(await readFile(originalPath, "utf8")).toBe("Previously accepted prose stays unchanged.");
    expect(await readFile(statePath)).toEqual(beforeState);
    expect(await loadRuntimeStateSnapshot(bookDir)).toEqual(baseline);
  });
});
