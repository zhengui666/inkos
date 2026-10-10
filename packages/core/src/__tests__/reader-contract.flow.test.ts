import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { CodexFixture } from "./codex-fixture.js";
const codex = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("../codex/client.js", () => ({ createCodexClient: codex.create }));
import { createLLMClient } from "../llm/provider.js";
import { ArchitectAgent } from "../agents/architect.js";
import { ComposerAgent, composeGovernedChapter } from "../agents/composer.js";
import { PlannerAgent } from "../agents/planner.js";
import { ContinuityAuditor } from "../agents/continuity.js";
import { buildWriterSystemPrompt } from "../agents/writer-prompts.js";
import { contractFromContext, readerContractContext, READER_CONTRACT_SOURCE } from "../agents/reader-contract-context.js";
import { ReaderContractToolSchema, ChapterDeliveryToolSchema } from "../agents/reader-contract-tool.js";
import { COMMERCIAL_REVIEW_CODES, validateCommercialReview } from "../agents/commercial-review.js";
import { ReaderContractSchema, type ReaderContract, type ChapterDelivery } from "../models/reader-contract.js";
import { BookRulesSchema } from "../models/book-rules.js";
import type { BookConfig } from "../models/book.js";
import { resolveObservationSources, type Observation } from "../models/observation.js";
import { saveWorkManifest, createWorkManifest } from "../harness/work-store.js";
import { savePersistedPlan, loadPersistedPlan } from "../pipeline/persisted-governed-plan.js";
import { buildLengthSpec } from "../utils/length-metrics.js";
import { renderMemoAsNarrativeBlock } from "../utils/narrative-control.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

// Entirely original, deliberately short transport fixtures. They are not a
// semantic quality benchmark and no language model makes a real request here.
const routes: Record<"zh" | "en", ReaderContract> = {
  zh: {
    mode: "commercial-underdog", familiarPromise: "手艺人靠本事夺回议价权", distinctiveHook: "旧钟里的误差能指出机器下一次故障",
    readingPleasure: "受压者让自己的手艺变成选择权", openingQuestion: "学徒能否在工钱被扣前证明故障不是自己造成？", proseApproach: "明白直接，师徒说话有利益差别",
    riseRoute: { startingDisadvantage: "学徒欠房租，工头扣下最后一周工钱", desiredChange: "拿到欠薪与独立接单机会", opportunity: "能从旧钟误差推断一处故障", opportunityLimits: "只能判断一台机器，必须停工实测且失误自赔", opposition: { force: "工头", interest: "保住低价劳力并掩盖维修失误", leverage: "控制工资账本与停工许可" }, protagonistContribution: "押上工具，争取见证人并现场测试", firstPayoff: "找出错装零件，取回工钱", payoffMeaning: "能续付房租，开始拒绝不合理派工", escalation: "独立接单将触及工头的客源，而不是再扣同一笔工资" },
  },
  en: {
    mode: "commercial-underdog", familiarPromise: "A low-ranked salvager earns access through practical competence", distinctiveHook: "A damaged navigation echo reveals safe routes only after she commits fuel",
    readingPleasure: "Risky knowledge becomes a usable place in the crew", openingQuestion: "Can the dock cleaner prove the evacuation route before the shift seal closes?", proseApproach: "Concrete English, natural dialogue and clear cause and effect",
    riseRoute: { startingDisadvantage: "An unlicensed dock cleaner cannot board an outbound ship", desiredChange: "Earn one trial berth", opportunity: "A discarded echo stores an obsolete service route", opportunityLimits: "Testing the route consumes her only fuel cartridge and cannot map beyond the next bulkhead", opposition: { force: "The salvage guild's berth controller", interest: "Reserve paid berths for certified crews", leverage: "Can shut access before the storm arrives" }, protagonistContribution: "Spends the cartridge, tests the route and offers a verifiable safe passage", firstPayoff: "Guides a stranded worker back and earns a trial berth", payoffMeaning: "She can leave the flooded dock and bargain as useful crew", escalation: "A berth brings obligations and a larger salvage problem, not instant control of the guild" },
  },
};
const delivery: ChapterDelivery = {
  role: "advance", wantedOutcome: "Secure a witnessed test", openingMove: "The gate closes while the protagonist needs a chance to prove the route",
  opposition: "The controller refuses access", initiative: "Offer the last fuel cartridge as the price of a test", earnedChange: "An observable safe passage earns one trial berth",
  feltConsequence: "The protagonist chooses where to stand with the crew", carryForward: "The berth is retained; responsibility begins", deferredPayoffReason: "Full membership is not due; a trial berth changes the available options",
};
const rulesBase = { version: "2" as const, prohibitions: [], enableFullCastTracking: false, allowedDeviations: [] };
async function setup(language: "zh" | "en") {
  const root = await mkdtemp(join(tmpdir(), "inkos-reader-contract-")); roots.push(root);
  const book: BookConfig = { id: "contract-fixture", title: language === "zh" ? "旧钟试工" : "One Trial Berth", genre: language === "zh" ? "都市异能" : "science-fiction progression", platform: "other", language, status: "outlining", targetChapters: 12, chapterWordCount: language === "zh" ? 2400 : 1300, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
  await saveWorkManifest(root, createWorkManifest({ id: book.id, title: book.title, profileId: "longform-novel", language }));
  const bookDir = join(root, "works", book.id, "source");
  const client = createLLMClient({ service: "custom", provider: "openai", configSource: "studio", model: "fixture", apiKey: "fixture", baseUrl: "https://unused.invalid/v1", apiFormat: "chat", stream: false, temperature: 0, thinkingBudget: 0 });
  return { root, book, bookDir, ctx: { client, model: "fixture", projectRoot: root, bookId: book.id } };
}

describe("reader contract schema and compatibility", () => {
  it("parses captured raw rules without consulting a newer file, retaining existing schema validation", async () => {
    const module = await import("../agents/reader-contract-context.js");
    const fromRaw = Reflect.get(module, "readerContractContextFromRaw") as (raw: string | null) => Awaited<ReturnType<typeof readerContractContext>>;
    expect(fromRaw).toBeTypeOf("function");
    const f = await setup("en"); await mkdir(join(f.bookDir, "story"), { recursive: true });
    const raw = JSON.stringify({ ...rulesBase, readerContract: routes.en }, null, 2) + "\r\n";
    await writeFile(join(f.bookDir, "story/book_rules.json"), JSON.stringify({ ...rulesBase, readerContract: routes.zh }));
    expect(contractFromContext({ chapter: 1, selectedContext: fromRaw(raw) })).toEqual(routes.en);
    expect(fromRaw(null)).toEqual([]);
    expect(fromRaw(JSON.stringify(rulesBase))).toEqual([]);
    for (const invalid of ["", "{", JSON.stringify({ ...rulesBase, version: "future", readerContract: routes.en }), JSON.stringify({ ...rulesBase, readerContract: { mode: "commercial-underdog" } })]) {
      expect(() => fromRaw(invalid)).toThrow();
    }
    expect(await readerContractContext(join(f.bookDir, "story"))).toEqual(fromRaw(JSON.stringify({ ...rulesBase, readerContract: routes.zh })));
  });
  it.each(["zh", "en"] as const)("keeps %s causal meaning without platform or language quotas", language => {
    expect(ReaderContractSchema.parse(routes[language])).toEqual(routes[language]);
    expect(Value.Check(ReaderContractToolSchema, routes[language])).toBe(true);
    expect(Value.Check(ChapterDeliveryToolSchema, delivery)).toBe(true);
    expect(ReaderContractSchema.safeParse({ ...routes[language], riseRoute: {} }).success).toBe(false);
  });
  it("allows an explicit alternative and unchanged legacy rules", () => {
    const alternate = { mode: "author-directed", familiarPromise: "Reflective family story", distinctiveHook: "Letters arrive in reverse order", readingPleasure: "Reinterpreting a relationship", openingQuestion: "Why was the final letter left unopened?", proseApproach: "Quiet lyrical prose as requested", authorDirection: "The author explicitly requests a quiet literary work" };
    expect(ReaderContractSchema.parse(alternate)).toEqual(alternate);
    expect(Value.Check(ReaderContractToolSchema, alternate)).toBe(true);
    expect(BookRulesSchema.parse(rulesBase)).toEqual(rulesBase);
  });
  it("does not write a contract into a legacy book and surfaces malformed stored contracts", async () => {
    const f = await setup("en"); await mkdir(join(f.bookDir, "story"), { recursive: true });
    const path = join(f.bookDir, "story/book_rules.json"), original = JSON.stringify(rulesBase);
    await writeFile(path, original);
    expect(await readerContractContext(join(f.bookDir, "story"))).toEqual([]);
    expect(await readFile(path, "utf8")).toBe(original);
    await writeFile(path, JSON.stringify({ ...rulesBase, readerContract: { mode: "commercial-underdog" } }));
    await expect(readerContractContext(join(f.bookDir, "story"))).rejects.toThrow();
  });
});

describe("captured authority through the real review pipeline", () => {
  const addedKeys = ["bookRulesJson", "authorIntent", "currentFocus", "styleGuide", "parentCanon", "fanficCanon"] as const;
  function authority(label: "A" | "B") {
    const contract: ReaderContract = { mode: "author-directed", familiarPromise: `${label} family promise`, distinctiveHook: `${label} CONTRACT HOOK`, readingPleasure: `${label} family choice`, openingQuestion: `${label} unanswered letter`, proseApproach: `${label} quiet English`, authorDirection: `${label} AUTHOR DIRECTION` };
    return {
      version: 2 as const,
      plan: JSON.stringify({ version: 2, intent: { chapter: 1, goal: `${label} MEMO GOAL` }, memo: { chapter: 1, goal: `${label} MEMO GOAL`, body: `${label} MEMO BODY`, threadRefs: [] }, plannerInputs: [] }) + "\r\n",
      authorBrief: ` \n${label} AUTHOR BRIEF 🙂\r\n `,
      bookRules: ` \n${label} BOOK RULES 🙂\r\n `,
      bookRulesJson: JSON.stringify({ ...rulesBase, readerContract: contract }, null, 2) + "\r\n",
      authorIntent: ` \n${label} AUTHOR INTENT 🙂\r\n `,
      currentFocus: ` \n${label} CURRENT FOCUS 🙂\r\n `,
      styleGuide: ` \n${label} STYLE GUIDE 🙂\r\n `,
      parentCanon: ` \n${label} PARENT CANON 🙂\r\n `,
      fanficCanon: ` \n${label} FANFIC CANON 🙂\r\n `,
    };
  }
  type RawAuthority = { [K in Exclude<keyof ReturnType<typeof authority>, "version">]: string | null } & { version: 2 };
  async function reviewFixture(language: "zh" | "en" = "en") {
    const f = await setup(language);
    const { StateManager } = await import("../state/manager.js");
    const { createInitialRuntimeState } = await import("../state/runtime-state-store.js");
    const { syncWorkSourceArtifacts } = await import("../harness/source-sync.js");
    const { PipelineRunner } = await import("../pipeline/runner.js");
    const state = new StateManager(f.root);
    await state.saveBookConfig(f.book.id, f.book);
    await mkdir(join(f.bookDir, "story/runtime"), { recursive: true });
    await mkdir(join(f.bookDir, "story/outline"), { recursive: true });
    await mkdir(join(f.bookDir, "chapters"), { recursive: true });
    await writeFile(join(f.bookDir, "chapters/0001_Gate.md"), "# Chapter 1: Gate\n\nNeri read the letter and chose to return home.");
    await createInitialRuntimeState({ bookDir: f.bookDir, language });
    const now = "2026-01-01T00:00:00.000Z";
    await state.saveChapterIndex(f.book.id, [{ number: 1, title: "Gate", wordCount: 10, provenance: "generated", observations: [], createdAt: now, updatedAt: now }]);
    const paths = {
      plan: "story/runtime/chapter-0001.plan.json", authorBrief: "story/runtime/chapter-0001.user-brief.md", bookRules: "story/book_rules.md",
      bookRulesJson: "story/book_rules.json", authorIntent: "story/author_intent.md", currentFocus: "story/current_focus.md",
      styleGuide: "story/style_guide.md", parentCanon: "story/parent_canon.md", fanficCanon: "story/fanfic_canon.md",
    };
    const writeAuthority = async (raw: RawAuthority) => {
      await Promise.all(Object.entries(paths).map(([key, path]) => {
        const value = raw[key as keyof typeof paths], fullPath = join(f.bookDir, path);
        return value === null ? rm(fullPath, { force: true }) : writeFile(fullPath, value);
      }));
    };
    await writeAuthority(authority("A"));
    await syncWorkSourceArtifacts({ projectRoot: f.root, workId: f.book.id, accept: true });
    return { ...f, state, writeAuthority, pipeline: new PipelineRunner({ projectRoot: f.root, client: f.ctx.client, model: "fixture" }) };
  }
  function installReviewTransport(options: { inspect?: (prompt: string) => void; beforeInspect?: () => Promise<void>; requireStoryClosure?: boolean } = {}) {
    const fixture = new CodexFixture(async view => {
      const name = view.tools[0]!.function.name;
      if (name === "submit_selected_sources") return { calls: [{ name, args: { selectedIndices: [] } }] };
      await options.beforeInspect?.();
      options.inspect?.(view.messages.map(message => message.content).join("\n"));
      if (name === "submit_chapter_contract") return { calls: [{ name, args: { summary: "Synthetic background inventory", observations: [{ code: "background", assessment: "observation", summary: "Both original memo lines are background for this transport fixture", sourceRefs: [{ sourceId: "chapter-contract-source", startLine: 1, endLine: 2 }] }] } }] };
      if (name === "submit_chapter_review") return { calls: [{ name, args: { summary: "Captured-input transport fixture", observations: [
        { code: "chapter-contract-inventory", category: "quality", assessment: "observation", summary: "The original memo remains available", sourceRefs: [{ sourceId: "chapter-contract-source", startLine: 1, endLine: 2 }] },
        ...(options.requireStoryClosure ? [{ code: "story-closure", category: "quality", assessment: "observation", summary: "The fixture resolves the letter's decision", sourceRefs: [{ sourceId: "chapter-1", startLine: 1, endLine: 1 }] }] : []),
      ] } }] };
      throw new Error(`Unexpected model operation ${name}`);
    });
    codex.create.mockImplementation(fixture.createClient);
    return fixture;
  }

  it.each(["complete", "budgeted"] as const)("uses the nine captured raw values in %s Composer and actual audit prompts despite A-B-A file changes", async mode => {
    const f = await reviewFixture(), expected = authority("A");
    const capture = vi.spyOn(await import("../pipeline/review-inputs.js"), "readChapterReviewInputs");
    await writeFile(join(f.bookDir, "story/outline/story_frame.md"), "# Current scene\nOne letter.\n\n# Distant archive\n" + "Archive details. ".repeat(3000));
    const original = ComposerAgent.prototype.selectTaskContext;
    let context: Awaited<ReturnType<typeof original>> | undefined;
    const selection = vi.spyOn(ComposerAgent.prototype, "selectTaskContext").mockImplementationOnce(async function (this: ComposerAgent, input) {
      await f.writeAuthority(authority("B"));
      context = await original.call(this, { ...input, ...(mode === "budgeted" ? { contextBudget: { contextWindowTokens: 4000, reservedOutputTokens: 1024 } } : {}) });
      return context;
    });
    let prompts = 0;
    const fixture = installReviewTransport({ beforeInspect: () => f.writeAuthority(expected), inspect: prompt => {
      prompts++;
      for (const marker of ["MEMO GOAL", "MEMO BODY", "AUTHOR BRIEF", "BOOK RULES", "CONTRACT HOOK", "AUTHOR INTENT", "CURRENT FOCUS", "STYLE GUIDE", "PARENT CANON", "FANFIC CANON"]) {
        expect(prompt).toContain(`A ${marker}`);
        expect(prompt).not.toContain(`B ${marker}`);
      }
    } });
    const result = await f.pipeline.reviewChapter(f.book.id, 1);
    expect(result.reviewInputs).toEqual(expected);
    expect(Object.keys(result.reviewInputs)).toHaveLength(10);
    expect(result.reviewPolicy).toEqual({ requireStoryClosure: false, language: "en" });
    expect(capture).toHaveBeenCalledOnce(); expect(selection).toHaveBeenCalledOnce(); expect(prompts).toBe(2);
    expect(contractFromContext(context!)).toEqual(JSON.parse(expected.bookRulesJson).readerContract);
    for (const [key, source] of [["authorIntent", "story/author_intent.md"], ["currentFocus", "story/current_focus.md"], ["styleGuide", "story/style_guide.md"], ["parentCanon", "story/parent_canon.md"], ["fanficCanon", "story/fanfic_canon.md"]] as const) {
      expect(context!.selectedContext.find(entry => entry.source === source)?.excerpt).toBe(expected[key].trim());
    }
    const selectorCalls = fixture.turns.filter(view => view.tools[0]!.function.name === "submit_selected_sources");
    if (mode === "complete") expect(selectorCalls).toHaveLength(0);
    else expect(selectorCalls.length).toBeGreaterThan(0);
  });

  it("keeps captured null authority absent when files are created before real Composer reads them", async () => {
    const f = await reviewFixture();
    const expected: RawAuthority = { ...authority("A"), ...Object.fromEntries(addedKeys.map(key => [key, null])) };
    await f.writeAuthority(expected);
    const original = ComposerAgent.prototype.selectTaskContext;
    let context: Awaited<ReturnType<typeof original>> | undefined;
    vi.spyOn(ComposerAgent.prototype, "selectTaskContext").mockImplementationOnce(async function (this: ComposerAgent, input) {
      await f.writeAuthority({ ...expected, ...Object.fromEntries(addedKeys.map(key => [key, authority("B")[key]])) });
      context = await original.call(this, input);
      return context;
    });
    installReviewTransport({ inspect: prompt => {
      for (const marker of ["CONTRACT HOOK", "AUTHOR INTENT", "CURRENT FOCUS", "STYLE GUIDE", "PARENT CANON", "FANFIC CANON"]) expect(prompt).not.toContain(`B ${marker}`);
    } });
    const result = await f.pipeline.reviewChapter(f.book.id, 1);
    expect(result.reviewInputs).toEqual(expected);
    expect(contractFromContext(context!)).toBeUndefined();
    for (const source of [READER_CONTRACT_SOURCE, "story/author_intent.md", "story/current_focus.md", "story/style_guide.md", "story/parent_canon.md", "story/fanfic_canon.md"]) expect(context!.selectedContext.some(entry => entry.source === source)).toBe(false);
  });

  it.each([{ language: "en", requireStoryClosure: false }, { language: "en", requireStoryClosure: true }, { language: "zh", requireStoryClosure: false }, { language: "zh", requireStoryClosure: true }] as const)("returns independent review policy for $language with closure=$requireStoryClosure", async policy => {
    const f = await reviewFixture(policy.language);
    installReviewTransport({ requireStoryClosure: policy.requireStoryClosure });
    const result = await f.pipeline.reviewChapter(f.book.id, 1, { requireStoryClosure: policy.requireStoryClosure });
    expect(result.reviewPolicy).toEqual(policy);
    expect(result.reviewInputs).toEqual(authority("A"));
    expect(result.observations.some(observation => observation.code === "story-closure")).toBe(policy.requireStoryClosure);
  });
});

describe("real foundation to planner to writer/reviewer propagation", () => {
  it.each(["zh", "en"] as const)("retains a %s route across persistence, protected selection and independent source review", async language => {
    const f = await setup(language), route = routes[language];
    let memoAttempts = 0, reviewAttempts = 0;
    const fixture = new CodexFixture(view => {
      const name = view.tools[0]!.function.name;
      const envelope = JSON.stringify(view.messages) + view.thread.baseInstructions;
      if (name === "submit_foundation_outline") return { calls: [{ name, args: { storyFrame: "A denied opportunity becomes an earned test.", volumeMap: "The first arc earns a foothold; later arcs develop its obligations.", readerContract: route } }] };
      if (name === "submit_foundation_details") {
        expect(envelope).toContain(route.distinctiveHook);
        return { calls: [{ name, args: { bookRules: "The advantage cannot remove the test's cost.", bookRulesData: { prohibitions: [], enableFullCastTracking: false, allowedDeviations: [] }, pendingHooks: [] } }] };
      }
      if (name === "submit_foundation_cast_index") { expect(envelope).toContain(route.openingQuestion); return { calls: [{ name, args: { roles: [{ tier: "major", name: "Neri" }] } }] }; }
      if (name === "submit_foundation_cast_documents") return { calls: [{ name, args: { role_1_content: "Neri wants a fair test, controls one useful tool, and bargains directly." } }] };
      if (name === "submit_chapter_memo") {
        expect(envelope).toContain(route.distinctiveHook);
        // Prove the host rejects a sparse commercial memo, then keeps the repair.
        return { calls: [{ name, args: { goal: "Earn a test", body: "Refusal leads to an offered stake and a witnessed test.", threadRefs: [], ...(memoAttempts++ ? { readerDelivery: delivery } : {}) } }] };
      }
      if (name === "submit_chapter_contract") return { calls: [{ name, args: { summary: "Synthetic source inventory", observations: [{ code: "required-event", assessment: "observation", summary: "The offered stake leads to a witnessed test", sourceRefs: [{ sourceId: "chapter-contract-source", startLine: 1, endLine: 1 }] }] } }] };
      if (name === "submit_chapter_review") {
        expect(envelope).toContain(route.distinctiveHook);
        expect(envelope).toContain("opening-readability");
        return { calls: [{ name, args: { summary: "Fixture coverage only, not a literary judgment", observations: reviewAttempts++ ? [
          ...COMMERCIAL_REVIEW_CODES.map(code => ({ code, assessment: "observation", category: "quality", summary: "Transport fixture cites the supplied original line", sourceRefs: [{ sourceId: "chapter-1", startLine: 1, endLine: 1 }] })),
          { code: "chapter-contract-inventory", assessment: "observation", category: "quality", summary: "Synthetic inventory retains the source", sourceRefs: [{ sourceId: "chapter-contract-source", startLine: 1, endLine: 1 }] },
          { code: "chapter-contract-1", assessment: "observation", category: "quality", summary: "Synthetic requirement evidence transport", sourceRefs: [{ sourceId: "chapter-contract-1", startLine: 1, endLine: 1 }, { sourceId: "chapter-1", startLine: 1, endLine: 1 }] },
        ] : [] } }] };
      }
      throw new Error(`Unexpected model operation ${name}`);
    });
    codex.create.mockImplementation(fixture.createClient);
    const architect = new ArchitectAgent(f.ctx);
    const foundation = await architect.generateFoundation(f.book);
    expect(foundation.bookRulesData.readerContract).toEqual(route);
    await architect.writeFoundationFiles(f.bookDir, foundation, language);
    const rules = BookRulesSchema.parse(JSON.parse(await readFile(join(f.bookDir, "story/book_rules.json"), "utf8")));
    expect(rules.readerContract).toEqual(route);
    const contextPackage = await new ComposerAgent(f.ctx).selectTaskContext({ bookDir: f.bookDir, chapterNumber: 1, goal: "Earn a test", language });
    expect(contractFromContext(contextPackage)).toEqual(route);
    expect(contextPackage.selectedContext.find(item => item.source === READER_CONTRACT_SOURCE)?.protection).toBe("protected");
    const memo = await new PlannerAgent(f.ctx).planChapterMemo({ chapterNumber: 1, contextPackage, language, lengthSpec: buildLengthSpec(f.book.chapterWordCount, language) });
    expect(memo.readerDelivery).toEqual(delivery); expect(memoAttempts).toBe(2);
    const plan = { intent: { chapter: 1, goal: memo.goal }, memo, intentMarkdown: memo.body, runtimePath: "runtime/fixture", plannerInputs: [READER_CONTRACT_SOURCE] };
    await mkdir(join(f.bookDir, "story/runtime"), { recursive: true });
    await savePersistedPlan(f.bookDir, plan);
    expect((await loadPersistedPlan(f.bookDir, 1))?.memo.readerDelivery).toEqual(delivery);
    const composed = await composeGovernedChapter({ book: f.book, bookDir: f.bookDir, chapterNumber: 1, plan,
      outlineSectionSelector: async () => [], memorySemanticSelector: async () => [] });
    expect(contractFromContext(composed.contextPackage)).toEqual(route);
    expect(composed.contextPackage.selectedContext.find(item => item.source === "runtime/chapter_memo")?.excerpt).toContain(delivery.earnedChange);
    expect(renderMemoAsNarrativeBlock(memo, plan.intent, language)).toContain(delivery.feltConsequence);
    const writer = buildWriterSystemPrompt(f.book, rules, foundation.bookRules, "", language);
    expect(writer).toContain(route.distinctiveHook);
    expect(writer).toContain(language === "zh" ? "2400 字" : "1300 words");
    const chapter = language === "zh" ? "门闩还没落下，她把最后一件工具放在桌上，要求当众试一次。" : "Before the dock gate closed, Neri set her last fuel cartridge on the desk and asked for one witnessed test.";
    const review = await new ContinuityAuditor(f.ctx).auditChapter(f.bookDir, chapter, 1, f.book.genre, { language, contextPackage: composed.contextPackage });
    expect(reviewAttempts).toBe(2);
    expect(review.observations.map(item => item.code)).toEqual([...COMMERCIAL_REVIEW_CODES, "chapter-contract-inventory", "chapter-contract-1"]);
    expect(review.observations.slice(0, COMMERCIAL_REVIEW_CODES.length).every(item => item.sourceRefs?.[0]?.quote === chapter)).toBe(true);
  });
});

describe("review coverage is evidence validation, not a quality score", () => {
  const complete = (): Observation[] => COMMERCIAL_REVIEW_CODES.map(code => ({ code, category: "quality", assessment: "observation", summary: "Evidence-bound fixture", evidence: [], sourceRefs: [{ sourceId: "chapter-1", quote: "She chose the test." }] }));
  it("rejects an empty review, plan-only proof, and defects with no repair layer", () => {
    expect(() => validateCommercialReview([], "chapter-1")).toThrow("incomplete");
    expect(() => validateCommercialReview(complete().map(item => ({ ...item, sourceRefs: [{ sourceId: "governed-context", quote: "Promised success" }] })), "chapter-1")).toThrow("actual chapter evidence");
    expect(() => validateCommercialReview(complete().map(item => ({ ...item, assessment: "issue" })), "chapter-1")).toThrow("repair layer");
  });
  it("accepts supported defects and explicit missing evidence without turning them into passes", () => {
    const observations = complete(); observations[0] = { ...observations[0]!, assessment: "issue", repairScope: "foundation" };
    observations[4] = { ...observations[4]!, assessment: "unavailable", summary: "Earlier setup is absent", sourceRefs: [] };
    expect(() => validateCommercialReview(observations, "chapter-1")).not.toThrow();
    expect(observations[4]!.assessment).toBe("unavailable");
  });
  it("uses exact source resolution to reject fabricated line addresses", () => {
    expect(() => resolveObservationSources([{ code: "earned-payoff", assessment: "observation", summary: "Fixture", evidence: [], sourceRefs: [{ sourceId: "chapter-1", startLine: 7, endLine: 7 }] }], new Map([["chapter-1", "She chose the test."]]))).toThrow("REVIEW_SOURCE_RANGE_INVALID");
  });
});

// Exercise the actual PipelineRunner -> ReviserAgent message boundary. The
// fixture stops after observing the prompt, before any candidate is submitted.
describe("review-driven repair boundaries", () => {
  async function revisionFixture() {
    const f = await setup("en");
    const { StateManager } = await import("../state/manager.js");
    const { createInitialRuntimeState } = await import("../state/runtime-state-store.js");
    const { syncWorkSourceArtifacts } = await import("../harness/source-sync.js");
    const { PipelineRunner } = await import("../pipeline/runner.js");
    const state = new StateManager(f.root);
    await state.saveBookConfig(f.book.id, f.book);
    await mkdir(join(f.bookDir, "story/outline"), { recursive: true });
    await mkdir(join(f.bookDir, "chapters"), { recursive: true });
    const body = "Neri waits by the locked gate. A stranger opens it for her.";
    for (const [path, content] of Object.entries({ "story/book_rules.json": JSON.stringify(rulesBase), "story/book_rules.md": "Retain the locked gate and the one-day berth rule.", "story/outline/story_frame.md": "Neri must earn a berth.", "story/outline/volume_map.md": "An earned test changes her options.", "chapters/0001_Gate.md": `# Chapter 1: Gate\n\n${body}` })) await writeFile(join(f.bookDir, path), content);
    await createInitialRuntimeState({ bookDir: f.bookDir, language: "en" });
    await state.snapshotState(f.book.id, 0);
    await state.saveChapterIndex(f.book.id, [{ number: 1, title: "Gate", wordCount: 13, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", observations: [], provenance: "generated" }]);
    await syncWorkSourceArtifacts({ projectRoot: f.root, workId: f.book.id, accept: true });
    const pipeline = new PipelineRunner({ projectRoot: f.root, client: f.ctx.client, model: "fixture" });
    const issue: Observation = { code: "protagonist-agency", category: "quality", assessment: "issue", repairScope: "structural", summary: "The stranger supplies the entire breakthrough; Neri never makes the promised test choice.", evidence: [], sourceRefs: [{ sourceId: "chapter-1", quote: body }] };
    return { ...f, state, body, pipeline, issue };
  }

  it("passes retained diagnosis, repair layer and exact source into the real reviser prompt", async () => {
    const f = await revisionFixture();
    let prompt = "";
    const fixture = new CodexFixture(view => {
      expect(view.tools[0]!.function.name).toBe("submit_revised_chapter");
      prompt = view.messages.map(message => message.content).join("\n");
      return { error: "fixture-stop-after-prompt" };
    }); codex.create.mockImplementation(fixture.createClient);
    await expect(f.pipeline.reviseDraft(f.book.id, 1, "rework", "Correct only retained findings.", { reviewFindings: [f.issue] })).rejects.toThrow("fixture-stop-after-prompt");
    expect(prompt).toContain(f.issue.summary);
    expect(prompt).toContain("Repair layer: structural");
    expect(prompt).toContain(`Source chapter-1: ${f.body}`);
    expect(await readFile(join(f.bookDir, "chapters/0001_Gate.md"), "utf8")).toBe(`# Chapter 1: Gate\n\n${f.body}`);
  });
  it("does not revise satisfactory commercial coverage", async () => {
    const f = await revisionFixture();
    const positive: Observation[] = COMMERCIAL_REVIEW_CODES.map(code => ({ ...f.issue, code, assessment: "observation", repairScope: undefined }));
    vi.spyOn(ContinuityAuditor.prototype, "auditChapter").mockResolvedValue({ summary: "No defects", observations: positive });
    const { ReviserAgent } = await import("../agents/reviser.js");
    const revise = vi.spyOn(ReviserAgent.prototype, "reviseChapter");
    const result = await f.pipeline.reviseDraft(f.book.id, 1, "spot-fix");
    expect(result.changed).toBe(false); expect(revise).not.toHaveBeenCalled();
  });
  it.each(["foundation", "unavailable", "stale"] as const)("blocks %s retained evidence before a writing call", async kind => {
    const f = await revisionFixture();
    const issue: Observation = kind === "foundation" ? { ...f.issue, repairScope: "foundation" }
      : kind === "unavailable" ? { ...f.issue, assessment: "unavailable", sourceRefs: [] }
      : { ...f.issue, sourceRefs: [{ sourceId: "chapter-1", quote: "A different older version" }] };
    const { ReviserAgent } = await import("../agents/reviser.js");
    const revise = vi.spyOn(ReviserAgent.prototype, "reviseChapter");
    await expect(f.pipeline.reviseDraft(f.book.id, 1, "rework", "Repair retained findings", { reviewFindings: [issue] })).rejects.toMatchObject({ code: kind === "foundation" ? "CHAPTER_FOUNDATION_REVIEW_REQUIRED" : kind === "unavailable" ? "CHAPTER_REVIEW_UNAVAILABLE" : "CHAPTER_REVIEW_SOURCE_CHANGED" });
    expect(revise).not.toHaveBeenCalled();
  });
});

it("preserves the durable promise during an unrelated rules update and permits an explicit replacement", async () => {
  const f = await setup("en");
  const { StateManager } = await import("../state/manager.js");
  const { createWriteTruthFileTool } = await import("../harness/tools/longform-edits.js");
  await new StateManager(f.root).saveBookConfig(f.book.id, f.book);
  await mkdir(join(f.bookDir, "story"), { recursive: true });
  const path = join(f.bookDir, "story/book_rules.json");
  await writeFile(path, JSON.stringify({ ...rulesBase, readerContract: routes.en }));
  const tool = createWriteTruthFileTool(f.root, f.book.id);
  const { version: _version, ...bookRulesData } = rulesBase;
  await tool.execute("rules", { fileName: "book_rules.md", content: "Use first person.", bookRulesData: { ...bookRulesData, narrativePerson: "first person" } });
  expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ readerContract: routes.en, narrativePerson: "first person" });
  await tool.execute("rules-new", { fileName: "book_rules.md", content: "Follow the explicitly revised premise.", bookRulesData: { ...bookRulesData, readerContract: routes.zh } });
  expect(JSON.parse(await readFile(path, "utf8")).readerContract).toEqual(routes.zh);
});

it("keeps the latest author brief above an earlier generated commercial proposal in actual worker prompts", async () => {
  const f = await setup("en");
  const { withExecutionEvidence } = await import("../harness/execution-evidence.js");
  const { prepareWorkerMessages } = await import("../agents/base.js");
  const { createBuiltInWorkProfileRegistry } = await import("../harness/builtin-profiles.js");
  const { loadWorkManifest } = await import("../harness/work-store.js");
  const instruction = "Keep Neri as the protagonist, but make this a quiet family mystery in first person. Resolve the family question in this one story; do not add a guild rival.";
  const alternate: ReaderContract = { mode: "author-directed", familiarPromise: "A family mystery", distinctiveHook: "An unopened letter changes the remembered departure", readingPleasure: "Understanding a family choice", openingQuestion: "Why did her mother leave the letter?", proseApproach: "Quiet first-person English", authorDirection: instruction };
  const prompts: string[] = [];
  const fixture = new CodexFixture(view => {
    const name = view.tools[0]!.function.name;
    const prompt = view.thread.baseInstructions + JSON.stringify(view.messages); prompts.push(prompt);
    expect(prompt).toContain(instruction);
    const args = name === "submit_foundation_outline" ? { readerContract: alternate, storyFrame: "Neri resolves the reason for a family departure.", volumeMap: "One complete family mystery." }
      : name === "submit_foundation_details" ? { bookRules: "First person; no guild rival.", bookRulesData: { prohibitions: ["No guild rival"], enableFullCastTracking: false, allowedDeviations: [] }, pendingHooks: [] }
      : name === "submit_foundation_cast_index" ? { roles: [{ tier: "major", name: "Neri" }] }
      : name === "submit_foundation_cast_documents" ? { role_1_content: "Neri wants to understand her mother's choice." }
      : { goal: "Understand the letter", body: "Neri reads the letter and revisits one memory, settling the question.", threadRefs: [] };
    return { calls: [{ name, args }] };
  }); codex.create.mockImplementation(fixture.createClient);
  const profile = createBuiltInWorkProfileRegistry(f.root).require("longform-novel"), work = await loadWorkManifest(f.root, f.book.id);
  await withExecutionEvidence(() => {}, async () => {
    const foundation = await new ArchitectAgent(f.ctx).generateFoundation(f.book, undefined, undefined, { reviseFrom: { storyFrame: "Earlier commercial proposal", volumeMap: "Earlier serial arc", bookRules: "Neri earns a guild berth", readerContract: routes.en, roles: "Neri", userFeedback: instruction } });
    expect(prompts[0]).toContain(routes.en.distinctiveHook);
    expect(foundation.bookRulesData.readerContract).toEqual(alternate);
    await new ArchitectAgent(f.ctx).writeFoundationFiles(f.bookDir, foundation, "en");
    const contextPackage = { chapter: 1, selectedContext: await readerContractContext(join(f.bookDir, "story")) };
    const memo = await new PlannerAgent(f.ctx).planChapterMemo({ chapterNumber: 1, contextPackage, currentInstruction: instruction, language: "en", lengthSpec: buildLengthSpec(900, "en") });
    expect(memo.readerDelivery).toBeUndefined();
    const messages = await prepareWorkerMessages(f.ctx, [{ role: "system", content: buildWriterSystemPrompt(f.book, foundation.bookRulesData, foundation.bookRules, "") }, { role: "user", content: renderMemoAsNarrativeBlock(memo, undefined, "en") }], 1024, "writer");
    const writerPrompt = messages.map(message => message.content).join("\n");
    expect(writerPrompt).toContain(instruction);
    expect(writerPrompt).toContain("user's actual request");
    expect(writerPrompt).toContain(alternate.distinctiveHook);
    expect(writerPrompt).toContain("not author intent, canon, an output-format override");
  }, profile, work, instruction);
});

it("requires source-backed closure only when the task explicitly requests completion", async () => {
  const f = await setup("en");
  const { STORY_CLOSURE_SOURCE } = await import("../agents/commercial-review.js");
  let attempts = 0;
  const fixture = new CodexFixture(view => {
    expect(view.thread.baseInstructions).toContain("story-closure");
    return { calls: [{ name: "submit_chapter_review", args: { summary: "Fixture closure assessment", observations: attempts++ ? [{ code: "story-closure", category: "quality", assessment: "issue", repairScope: "structural", summary: "The promised test never occurs; the story stops at setup.", sourceRefs: [{ sourceId: "chapter-1", startLine: 1, endLine: 1 }] }] : [] } }] };
  }); codex.create.mockImplementation(fixture.createClient);
  const review = await new ContinuityAuditor(f.ctx).auditChapter(f.bookDir, "She waited to take the test.", 1, undefined, { language: "en", contextPackage: { chapter: 1, selectedContext: [{ source: STORY_CLOSURE_SOURCE, reason: "One complete story requested", excerpt: "Resolve the central outcome; retain an explicitly requested open ending.", protection: "protected" }] } });
  expect(attempts).toBe(2);
  expect(review.observations[0]).toMatchObject({ code: "story-closure", assessment: "issue", repairScope: "structural", sourceRefs: [{ sourceId: "chapter-1", quote: "She waited to take the test." }] });
});
