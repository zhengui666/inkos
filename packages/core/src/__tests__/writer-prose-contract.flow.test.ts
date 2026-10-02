import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WriterAgent } from "../agents/writer.js";
import { buildWriterSystemPrompt } from "../agents/writer-prompts.js";
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

describe("writer prose authority contract", () => {
  it.each(["zh", "en"] as const)("separates required events from background constraints in %s", language => {
    const rules = { version: "2" as const, prohibitions: ["Keep the letter sealed"], enableFullCastTracking: false,
      allowedDeviations: [], narrativePerson: "third-person limited" as const,
      protagonist: { name: "Owner", personalityLock: ["cautious"], behavioralConstraints: ["no unearned knowledge"] } };
    const prompt = buildWriterSystemPrompt({ ...book, language }, rules, "Binding book facts.", "Keep the accepted voice.");
    const phrases = language === "en"
      ? ["Realize required events, choices, and consequences", "constrain consistency; they are not a checklist to recite",
          "A promise or invoice is not a completed payment", "Honor any explicit user request"]
      : ["要求发生的事件、人物选择及其后果必须在正文兑现", "约束的是一致性，不是逐条复述清单",
          "承诺付款或开出账单不等于已经收款", "用户明确要求呈现的细节仍须遵循"];
    for (const phrase of phrases) expect(prompt).toContain(phrase);
    for (const preserved of ["Binding book facts.", "Keep the accepted voice.", "third-person limited", "cautious", "no unearned knowledge", "Keep the letter sealed", "300"])
      expect(prompt).toContain(preserved);
    expect(prompt).not.toContain("Satisfy every populated memo requirement in the prose");
    expect(prompt).not.toContain("memo 已填写的每项要求都要在正文落地");
  });

  // Model outputs are deliberately fixed. These exercise prompt/Skill wiring,
  // evidence transfer and the real state reducer, not model taste or extraction.
  it.each([true, false])("routes concise prose and preserves settlement facts (payment received: %s)", async received => {
    const root = await mkdtemp(join(tmpdir(), "inkos-prose-contract-")); roots.push(root);
    const bookDir = join(root, "works", book.id, "source");
    await saveWorkManifest(root, createWorkManifest({ id: book.id, title: book.title, profileId: "longform-novel", language: book.language }));
    const initial = await createInitialRuntimeState({ bookDir, language: book.language, hooks: [{
      hookId: "hook-existing", startChapter: 3, lastAdvancedChapter: 5, type: "relationship", status: "open",
      expectedPayoff: "An unanswered invitation", notes: "Not resolved by the payment." }] });
    const opening = [
      { subject: "workshop", predicate: "cash", object: "8400" },
      { subject: "workshop", predicate: "completed income", object: "2100" },
      { subject: "order", predicate: "price", object: "360" },
      { subject: "order", predicate: "prepayment already received", object: "90" },
      { subject: "order", predicate: "unearned prepayment", object: "90" },
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
    const beforeState = await readFile(join(bookDir, "story/state/current_state.json"));
    const contextPackage: ContextPackage = { chapter: 6, selectedContext: [
      { source: "story/author_intent.md", reason: "Author direction", excerpt: "Avoid reading a procedural manual or ledger aloud.", protection: "protected" },
      { source: "opening-facts", reason: "Accounting baseline", excerpt: "The 90 prepayment is already included in cash 8400. Completed income 2100 excludes this order. Recognize the full price 360 only on completed delivery. Nothing else changes these accounts.", protection: "protected" },
      { source: "order-and-hook", reason: "Known order and promise", excerpt: "Price 360; 90 already paid; balance 270. The existing promise is hook-existing. The letter stays sealed.", protection: "protected" },
    ] };
    // Synthetic test prose, not an excerpt from a user's manuscript. It omits
    // opening/closing balances but makes actual receipt versus promise explicit.
    const content = received
      ? "策展人付清270元尾款。陶艺师确认到账，把烧制完成的灯座和配套灯罩交到他手里。他抱着两件陶器走出工作室。"
      : "策展人说，270元尾款等下周再付。陶艺师没有收到款，也没有交货；灯座和配套灯罩仍留在工作台上。";
    const changed = received ? [
      { subject: "workshop", predicate: "cash", object: "8670" },
      { subject: "workshop", predicate: "completed income", object: "2460" },
      { subject: "order", predicate: "unearned prepayment", object: "0" },
      { subject: "order", predicate: "balance due", object: "0" },
      { subject: "order", predicate: "handover", object: "completed; ceramic lamp base and matching shade collected" },
    ] : [];
    const memo = { chapter: 6, goal: "Resolve the collection attempt through a choice.",
      body: "Required scene: resolve the collection attempt. Background: the letter stays sealed. Preserve the existing invitation without resolving it.", threadRefs: ["hook-existing"] };
    worker.tool.mockImplementation(async (_client, _model, messages: LLMMessage[], tool) => {
      const system = messages.filter(message => message.role === "system").map(message => message.content).join("\n");
      const user = messages.find(message => message.role === "user")!.content;
      // Loaded via the real Work profile and production Skill hydration path.
      expect(system).toContain("inkos-long-writing");
      expect(system).toContain("A reply can evade, bargain, or withhold");
      expect(system).toContain("quiet observation and silence");
      expect(system).toContain("These are settlement checks, not a requirement to insert accounting exposition");
      if (tool.name === "submit_chapter_draft") {
        expect(system).toContain("约束的是一致性，不是逐条复述清单");
        expect(system).toContain("Keep the accepted voice; show the disputed choice.");
        expect(user).toContain(memo.body);
        expect(user).toContain("User-specified accounting detail must be honored");
        for (const entry of contextPackage.selectedContext) expect(user).toContain(entry.excerpt);
        expect(user).toContain("hook-existing");
        return { title: "Collection", content };
      }
      expect(tool.name).toBe("submit_runtime_state_delta");
      expect(user).toContain(content);
      const supplied = JSON.parse(user.split("## Settlement baseline\n")[1]!.split("\n").slice(1).join("\n"));
      expect(supplied.currentState).toEqual(baseline.currentState);
      expect(supplied.hooks).toEqual(baseline.hooks);
      for (const entry of contextPackage.selectedContext) expect(user).toContain(entry.excerpt);
      return { postSettlement: received ? "Payment and handover completed." : "Payment and handover remain pending.",
        factOps: { upsert: changed, expire: changed.map(({ subject, predicate }) => ({ subject, predicate })) },
        hookOps: { upsert: [], mention: [], resolve: [], defer: [] }, newHookCandidates: [],
        chapterSummary: { title: "Collection", characters: "Curator and ceramicist", events: content,
          stateChanges: received ? "270 received; order delivered." : "No payment or handover.", hookActivity: "", mood: "quiet", chapterType: "scene" } };
    });
    const result = await new WriterAgent({ client, model: "fixture", projectRoot: root, bookId: book.id }).writeChapter({
      book, bookDir, chapterNumber: 6, chapterIntent: memo.goal, chapterMemo: memo, contextPackage,
      externalContext: "User-specified accounting detail must be honored when requested; keep the title Collection." });
    expect(worker.tool).toHaveBeenCalledTimes(2);
    expect(worker.text).not.toHaveBeenCalled();
    expect(result.content).toBe(content);
    expect(content).not.toMatch(/8400|8670|2100|2460/);
    const active = result.runtimeStateSnapshot.currentState.facts.filter(fact => fact.validUntilChapter === null);
    for (const fact of opening) {
      const expected = changed.find(change => change.subject === fact.subject && change.predicate === fact.predicate) ?? fact;
      expect(active).toContainEqual(expect.objectContaining(expected));
    }
    expect(active).toHaveLength(opening.length);
    expect(result.runtimeStateSnapshot.hooks).toEqual(baseline.hooks);
    expect(await readFile(originalPath, "utf8")).toBe("Previously accepted prose stays unchanged.");
    expect(await readFile(join(bookDir, "story/state/current_state.json"))).toEqual(beforeState);
    expect((await loadRuntimeStateSnapshot(bookDir)).manifest.lastAppliedChapter).toBe(5);
  });
});
