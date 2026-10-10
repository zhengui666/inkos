import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComposerAgent, composeGovernedChapter, type CompressibleContextCompileRequest, type OutlineSectionSelectionRequest } from "../agents/composer.js";
import { contractFromContext, READER_CONTRACT_SOURCE } from "../agents/reader-contract-context.js";
import { readChapterReviewInputs } from "../pipeline/review-inputs.js";
import { createInitialRuntimeState } from "../state/runtime-state-store.js";
import type { PlanChapterOutput } from "../agents/planner.js";
import type { BookConfig } from "../models/book.js";
import type { ContextPackage } from "../models/input-governance.js";
import { ProtectedContextOverflowError } from "../harness/context-compiler.js";
import { withExecutionEvidence } from "../harness/execution-evidence.js";
import { estimateTextTokens, type LLMClient, type LLMMessage } from "../llm/provider.js";
import type { AgentContext } from "../agents/base.js";
import type { ActivatedSkillGuidance } from "../agent/skill-tool.js";

const worker = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("../agent/worker-agent.js", () => ({ runWorkerAgentTool: worker.run, runWorkerAgent: vi.fn() }));

type SelectionIndex = { number: number; sourceId: string };
const WINDOW = 5_496;
const authorRequest = "Preserve the author's complete constraints.\n" + "授权约束".repeat(100);
const roots: string[] = [];

function context(extra: Partial<AgentContext> = {}, window: number | undefined = WINDOW): AgentContext {
  return {
    client: {
      defaults: { maxTokens: 2_048 },
      ...(window === undefined ? {} : { _piModel: { contextWindow: window } }),
    } as unknown as LLMClient,
    model: "selection-budget-fixture",
    projectRoot: "/tmp/inkos-selection-budget-fixture",
    ...extra,
  };
}

function indexOf(messages: ReadonlyArray<LLMMessage>): SelectionIndex[] {
  return JSON.parse(messages.at(-1)!.content).candidateIndex;
}

function inputs(): ReadonlyArray<LLMMessage>[] {
  return worker.run.mock.calls.map((call) => call[2] as ReadonlyArray<LLMMessage>);
}

function candidateText(messages: ReadonlyArray<LLMMessage>, marker: string): string {
  const task = messages.find((message) => message.role === "user" && /^(Chapter:|File:)/.test(message.content))!.content;
  return task.slice(task.indexOf(marker) + marker.length).replace(/^Candidate fragment [^\n]+:\n/, "");
}

function outline(candidates: OutlineSectionSelectionRequest["candidates"]): OutlineSectionSelectionRequest {
  return { fileName: "state/current_state.json", kind: "current-state", chapterNumber: 5,
    goal: "Follow the current investigation.", outlineNode: "", language: "en", candidates };
}

function withAuthority<T>(task: () => T): T {
  return withExecutionEvidence(() => {}, task, undefined, undefined, authorRequest);
}

beforeEach(() => {
  worker.run.mockImplementation(async (_client, _model, messages: ReadonlyArray<LLMMessage>) => ({
    selectedIndices: indexOf(messages).map((entry) => entry.number),
  }));
});
afterEach(async () => {
  vi.restoreAllMocks(); worker.run.mockReset();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("bounded composer source selection", () => {
  it.each(["current-state", "role-card"] as const)("covers every %s candidate without truncating the protected author request", async (kind) => {
    const candidates = Array.from({ length: 12 }, (_, index) => ({
      source: `story/é/角色-${index}.md`, heading: `Heading ${index}`,
      excerpt: `BEGIN-${index}\n${"状态线索".repeat(90)}\nEND-${index}`,
    }));
    const skills = [{ skill: { id: "irrelevant-writing-method", body: "WRITING-SKILL-MUST-NOT-BE-LOADED ".repeat(10_000) }, resources: [] }] as unknown as ActivatedSkillGuidance[];
    const result = await withAuthority(() => new ComposerAgent(context({ activatedSkills: skills }))
      .selectOutlineSections({ ...outline(candidates), kind }));
    expect(result).toEqual(candidates.map((candidate) => candidate.source));
    expect(worker.run.mock.calls.length).toBeGreaterThan(1);
    const sent = inputs();
    for (const messages of sent) {
      expect(messages[0]!.content).toContain(JSON.stringify({ authorRequest }));
      expect(messages.map((message) => message.content).join("\n")).not.toContain("WRITING-SKILL-MUST-NOT-BE-LOADED");
      const tokens = messages.reduce((sum, message) => sum + estimateTextTokens(`## composer:${message.role}\n${message.content}`), 0);
      expect(tokens).toBeLessThanOrEqual(WINDOW - 1_024 - 2_048);
    }
    const allText = sent.flatMap((messages) => messages.filter((message) => message.content.startsWith("File:")).map((message) => message.content)).join("\n");
    for (const candidate of candidates) {
      const complete = `source_id: ${candidate.source}\nheading: ${candidate.heading}\n${candidate.excerpt}`;
      expect(allText.split(complete)).toHaveLength(2);
    }
    expect(sent.flatMap(indexOf).map((entry) => entry.sourceId)).toEqual(candidates.map((candidate) => candidate.source));
    for (const call of worker.run.mock.calls) {
      expect(call[4]).toMatchObject({ professionalGuidance: false });
      expect(call[3].parameters.properties.selectedIndices).toMatchObject({ uniqueItems: true, items: { minimum: 1 } });
    }
  });

  it("splits an oversized outline candidate without losing any text or exact source mapping", async () => {
    const huge = { source: "story/roles/é/é/主要人物.md", heading: "Full role card", excerpt: "角色经历🙂é\n".repeat(2_000) };
    const small = { source: "story/roles/other.md", heading: "Other role", excerpt: "The witness returned." };
    const result = await withAuthority(() => new ComposerAgent(context()).selectOutlineSections(outline([huge, small])));
    expect(result).toEqual([huge.source, small.source]);
    const fragments = inputs().filter((messages) => indexOf(messages)[0]!.sourceId.startsWith("candidate-1-part-"));
    expect(fragments.length).toBeGreaterThan(2);
    expect(fragments.map((messages) => candidateText(messages, "Goal: Follow the current investigation.\n\n")).join(""))
      .toBe(`source_id: ${huge.source}\nheading: ${huge.heading}\n${huge.excerpt}`);
    expect(inputs().at(-1)!.some((message) => message.content.includes(small.excerpt))).toBe(true);
  });

  it("accounts for the real memory envelope, losslessly shards a huge candidate, and maps any selected fragment to the original id", async () => {
    const candidate = { id: "memory:é/é/记忆", kind: "chapter-summary", source: "story/历史.md#记忆", title: "Full memory",
      excerpt: ("独特状态🙂é\n".repeat(1_300)) + "ONLY-SELECT-THIS-END" };
    worker.run.mockImplementation(async (_client, _model, messages: ReadonlyArray<LLMMessage>) => ({
      selectedIndices: messages.some((message) => message.content.includes("ONLY-SELECT-THIS-END")) ? [1] : [],
    }));
    const result = await withAuthority(() => new ComposerAgent(context()).selectMemoryCandidates({
      chapterNumber: 5, query: "Find the relevant memory.", candidates: [candidate],
    }));
    expect(result).toEqual([candidate.id]);
    expect(inputs().length).toBeGreaterThan(2);
    expect(inputs().map((messages) => candidateText(messages, "Candidates:\n")).join("")).toBe(
      `id: ${candidate.id}\nkind: ${candidate.kind}\nsource: ${candidate.source}\ntitle: ${candidate.title}\n${candidate.excerpt}`,
    );
    for (const messages of inputs()) {
      expect(messages[0]!.content).toContain(JSON.stringify({ authorRequest }));
      expect(messages.reduce((sum, message) => sum + estimateTextTokens(`## composer:${message.role}\n${message.content}`), 0))
        .toBeLessThanOrEqual(WINDOW - 2_048 - 2_048);
      expect(indexOf(messages)).toHaveLength(1);
    }
  });

  it("preserves long reference metadata and identifiers across shards and unions duplicate selections", async () => {
    const candidate = { source: `reference/${"长来源".repeat(450)}#段落`, materialId: "reference", title: "长标题".repeat(700),
      heading: "Reference section", uses: ["Consider this style", "Compare its pacing"], note: "完整参考说明🙂\n".repeat(900) };
    const result = await withAuthority(() => new ComposerAgent(context()).selectReferenceSections({
      chapterNumber: 5, goal: "Use the reference.", outlineNode: "", mustKeep: [], language: "en", candidates: [candidate],
    }));
    expect(result).toEqual([candidate.source]);
    expect(inputs().length).toBeGreaterThan(2);
    expect(inputs().map((messages) => candidateText(messages, "Goal: Use the reference.\n\n")).join("")).toBe(
      `source_id: ${candidate.source}\ntitle: ${candidate.title}\nheading: ${candidate.heading}\nuser-defined uses: ${candidate.uses.join("; ")}\nuser note: ${candidate.note}`,
    );
    expect(new Set(inputs().flatMap(indexOf).map((entry) => entry.sourceId)).size).toBe(inputs().length);
  });

  it("unions original ids across all groups without duplicates", async () => {
    const candidates = Array.from({ length: 8 }, (_, index) => ({ id: `memory-${index % 3}`, source: `source-${index}`,
      kind: "summary", title: `Title ${index}`, excerpt: "候选全文".repeat(120) }));
    expect(await withAuthority(() => new ComposerAgent(context()).selectMemoryCandidates({ chapterNumber: 5, query: "Read all.", candidates })))
      .toEqual(["memory-0", "memory-1", "memory-2"]);
    expect(inputs().length).toBeGreaterThan(1);
    const allSent = inputs().map((messages) => candidateText(messages, "Candidates:\n")).join("\n\n");
    for (const candidate of candidates) expect(allSent).toContain(`source: ${candidate.source}\ntitle: ${candidate.title}\n${candidate.excerpt}`);
  });

  it.each(["outline", "memory"] as const)("bounds the complete %s result when many tiny candidates fit the input window", async (selector) => {
    const maxTokens = selector === "outline" ? 1_024 : 2_048;
    const candidates = Array.from({ length: 4_000 }, (_, index) => ({
      id: `id-${index}`, source: `source-${index}`, kind: "summary", title: "T", heading: "H", excerpt: "x",
    }));
    const composer = new ComposerAgent(context({}, 1_000_000));
    expect(estimateTextTokens(JSON.stringify({ selectedIndices: candidates.map((_, index) => index + 1) })))
      .toBeGreaterThan(maxTokens);
    const expected = candidates.map((candidate) => selector === "outline" ? candidate.source : candidate.id);
    const result = selector === "outline"
      ? await composer.selectOutlineSections(outline(candidates))
      : await composer.selectMemoryCandidates({ chapterNumber: 5, query: "All are relevant.", candidates });
    expect(result).toEqual(expected);
    expect(inputs().length).toBeGreaterThan(1);
    expect(inputs().flatMap(indexOf).map((entry) => entry.sourceId)).toEqual(expected);
    for (const messages of inputs()) {
      const tokens = estimateTextTokens(JSON.stringify({ selectedIndices: indexOf(messages).map((entry) => entry.number) }));
      expect(tokens + 128).toBeLessThanOrEqual(maxTokens);
    }
  });

  it("keeps empty-selection and zero-candidate semantics", async () => {
    const composer = new ComposerAgent(context());
    worker.run.mockResolvedValue({ selectedIndices: [] });
    const request = outline(Array.from({ length: 8 }, (_, index) => ({ source: `source-${index}`, heading: "Fact", excerpt: "记忆".repeat(300) })));
    expect(await composer.selectOutlineSections(request)).toEqual([]);
    expect(inputs().length).toBeGreaterThan(1);
    worker.run.mockClear();
    expect(await composer.selectMemoryCandidates({ chapterNumber: 5, query: "Empty", candidates: [] })).toEqual([]);
    expect(await composer.selectReferenceSections({ chapterNumber: 5, goal: "Empty", outlineNode: "", mustKeep: [], language: "en", candidates: [] })).toEqual([]);
    expect(await composer.selectOutlineSections(outline([]))).toEqual([]);
    expect(await composer.selectOutlineSections(outline([request.candidates[0]!]))).toEqual(["source-0"]);
    expect(worker.run).not.toHaveBeenCalled();
  });

  it("fails closed before any model call when protected authority alone exceeds the window", async () => {
    const composer = new ComposerAgent(context());
    const request = { chapterNumber: 5, query: "Read these.", candidates: Array.from({ length: 20 }, (_, index) => ({
      id: `memory-${index}`, source: `source-${index}`, kind: "summary", title: "Fact", excerpt: "候选".repeat(100),
    })) };
    const pending = withExecutionEvidence(() => {}, () => composer.selectMemoryCandidates(request), undefined, undefined, "完整作者授权".repeat(3_000));
    await expect(pending).rejects.toBeInstanceOf(ProtectedContextOverflowError);
    await expect(pending).rejects.toThrow("Source selection has no room");
    expect(worker.run).not.toHaveBeenCalled();
  });

  it("fails clearly and terminates if the protocol leaves no token space for a candidate", async () => {
    const composer = new ComposerAgent(context({}, 4_264));
    await expect(composer.selectMemoryCandidates({ chapterNumber: 5, query: "Read.", candidates: [{
      id: "id", kind: "memory", title: "Title", source: "source", excerpt: "原文".repeat(3_000),
    }] })).rejects.toThrow("Source selection has no room");
    expect(worker.run).not.toHaveBeenCalled();
  });

  it("propagates cancellation before work and between batches", async () => {
    const cancelled = new AbortController();
    const reason = new Error("Selection cancelled");
    cancelled.abort(reason);
    await expect(new ComposerAgent(context({ signal: cancelled.signal })).selectOutlineSections(outline([]))).rejects.toBe(reason);
    expect(worker.run).not.toHaveBeenCalled();
    const controller = new AbortController();
    worker.run.mockImplementation(async () => { controller.abort(reason); return { selectedIndices: [1] }; });
    await expect(new ComposerAgent(context({ signal: controller.signal })).selectMemoryCandidates({
      chapterNumber: 5, query: "Read all.", candidates: Array.from({ length: 10 }, (_, index) => ({ id: `id-${index}`,
        kind: "memory", title: "Title", source: "source", excerpt: "原文".repeat(500) })),
    })).rejects.toBe(reason);
    expect(worker.run).toHaveBeenCalledTimes(1);
  });

  it("does not reinterpret a runtime overflow as permission to replay or subdivide a worker call", async () => {
    const runtimeFailure = new ProtectedContextOverflowError(9_000, 1_000);
    worker.run.mockRejectedValue(runtimeFailure);
    await expect(new ComposerAgent(context()).selectMemoryCandidates({ chapterNumber: 5, query: "Read all.", candidates: Array.from({ length: 10 }, (_, index) => ({
      id: `id-${index}`, kind: "memory", title: "Title", source: "source", excerpt: "原文".repeat(500),
    })) })).rejects.toBe(runtimeFailure);
    expect(worker.run).toHaveBeenCalledTimes(1);
  });

  it("keeps the single-call path for a model without a declared input window", async () => {
    const unbounded = context({ client: { defaults: { maxTokens: 2_048 } } as LLMClient });
    expect(await new ComposerAgent(unbounded).selectMemoryCandidates({ chapterNumber: 5, query: "Read all.", candidates: [
      { id: "memory", kind: "summary", title: "Title", source: "source", excerpt: "完整原文".repeat(10_000) },
    ] })).toEqual(["memory"]);
    expect(worker.run).toHaveBeenCalledTimes(1);
  });
});

const authorityPaths = {
  plan: "runtime/chapter-0001.plan.json",
  authorBrief: "runtime/chapter-0001.user-brief.md",
  bookRules: "book_rules.md",
  bookRulesJson: "book_rules.json",
  authorIntent: "author_intent.md",
  currentFocus: "current_focus.md",
  styleGuide: "style_guide.md",
  parentCanon: "parent_canon.md",
  fanficCanon: "fanfic_canon.md",
} as const;
type AuthorityField = keyof typeof authorityPaths;
const literalContextFields = ["authorIntent", "currentFocus", "styleGuide", "parentCanon", "fanficCanon"] as const;

function authorityContract(marker: string) {
  return {
    mode: "author-directed" as const,
    familiarPromise: `${marker} family story`, distinctiveHook: `${marker} letters arrive in reverse order`,
    readingPleasure: `${marker} relationships change`, openingQuestion: `${marker} why was the last letter unopened?`,
    proseApproach: `${marker} quiet concrete prose`, authorDirection: `${marker} explicit author direction`,
  };
}

function authorityValues(marker: string): Record<AuthorityField, string> {
  return {
    plan: JSON.stringify({ marker }), authorBrief: `${marker} author brief`, bookRules: `${marker} book rules`,
    bookRulesJson: JSON.stringify({ version: "2", prohibitions: [], enableFullCastTracking: false,
      allowedDeviations: [], readerContract: authorityContract(marker) }),
    authorIntent: `\n${marker} author intent é🙂\n`, currentFocus: `${marker} current focus`,
    styleGuide: `${marker} approved style`, parentCanon: `${marker} parent canon`, fanficCanon: `${marker} fanfic canon`,
  };
}

async function writeAuthority(bookDir: string, values: Record<AuthorityField, string | null>): Promise<void> {
  for (const field of Object.keys(authorityPaths) as AuthorityField[]) {
    const path = join(bookDir, "story", authorityPaths[field]);
    if (values[field] === null) await rm(path, { force: true });
    else await writeFile(path, values[field]!);
  }
}

async function authorityFixture(withFiles = true, budgeted = false) {
  const bookDir = await mkdtemp(join(tmpdir(), "inkos-composer-review-inputs-")); roots.push(bookDir);
  await createInitialRuntimeState({ bookDir, language: "en" });
  await mkdir(join(bookDir, "story", "runtime"), { recursive: true });
  const values = authorityValues("CAPTURED-É-🙂");
  if (withFiles) await writeAuthority(bookDir, values);
  if (budgeted) await writeFile(join(bookDir, "story", "volume_summaries.md"),
    "# Earlier voyage\n" + "Lower-priority history about the voyage. ".repeat(4_000));
  const book: BookConfig = {
    id: "composer-review-inputs", title: "Captured letters", genre: "family story", platform: "other", language: "en",
    status: "active", targetChapters: 12, chapterWordCount: 1300,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const plan: PlanChapterOutput = {
    intent: { chapter: 1, goal: "Read the letter" },
    memo: { chapter: 1, goal: "Read the letter", body: "The last letter changes a family relationship.", threadRefs: [] },
    intentMarkdown: "The last letter changes a family relationship.", plannerInputs: [],
    runtimePath: join(bookDir, "story", "runtime", "chapter-0001.plan.json"),
  };
  return { bookDir, book, plan, values };
}

function expectCapturedContext(contextPackage: ContextPackage, values: Record<AuthorityField, string>): void {
  for (const field of literalContextFields) {
    expect(contextPackage.selectedContext.find(entry => entry.source === `story/${authorityPaths[field]}`))
      .toMatchObject({ protection: "protected", excerpt: values[field].trim() });
  }
  expect(contractFromContext(contextPackage)).toEqual(JSON.parse(values.bookRulesJson).readerContract);
  expect(contextPackage.selectedContext.find(entry => entry.source === READER_CONTRACT_SOURCE)?.protection).toBe("protected");
}

describe("captured review authority in the real composer", () => {
  it("keeps the captured corpus on the complete fast path across A-B-A disk changes", async () => {
    const f = await authorityFixture();
    const authoritativeInputs = await readChapterReviewInputs(f.bookDir, 1);
    await writeAuthority(f.bookDir, authorityValues("LATER-B"));
    const composer = new ComposerAgent(context({ projectRoot: f.bookDir }, 100_000));
    const input = { book: f.book, bookDir: f.bookDir, chapterNumber: 1, plan: f.plan, authoritativeInputs };
    const whileChanged = await composer.composeChapter(input);
    expectCapturedContext(whileChanged.contextPackage, f.values);
    expect(whileChanged.trace.retrieval?.selectionMode).toBe("complete");
    await writeAuthority(f.bookDir, f.values);
    const afterRestored = await composer.composeChapter(input);
    expect(afterRestored.contextPackage).toEqual(whileChanged.contextPackage);
    expect(worker.run).not.toHaveBeenCalled();
  });

  it("keeps captured authority through complete probing, semantic selection and budget compilation when disk goes A-B-A", async () => {
    const f = await authorityFixture(true, true);
    const authoritativeInputs = await readChapterReviewInputs(f.bookDir, 1);
    await writeAuthority(f.bookDir, authorityValues("LATER-B"));
    worker.run.mockImplementation(async (_client, _model, messages: ReadonlyArray<LLMMessage>) => {
      expect(await readFile(join(f.bookDir, "story", "style_guide.md"), "utf8")).toContain("LATER-B");
      await writeAuthority(f.bookDir, f.values);
      return { selectedIndices: indexOf(messages).map(entry => entry.number) };
    });
    const compiler = vi.fn(async (request: CompressibleContextCompileRequest) => {
      expectCapturedContext({ chapter: 1, selectedContext: request.protectedEntries }, f.values);
      return "The earlier voyage established the missing letter.";
    });
    const input = { book: f.book, bookDir: f.bookDir, chapterNumber: 1, plan: f.plan, authoritativeInputs,
      contextBudget: { contextWindowTokens: 8_000, reservedOutputTokens: 1_024 },
      compressibleContextCompiler: compiler };
    const composed = await new ComposerAgent(context({ projectRoot: f.bookDir }, 100_000)).composeChapter(input);
    expectCapturedContext(composed.contextPackage, f.values);
    expect(composed.trace.retrieval?.selectionMode).toBe("semantic");
    expect(worker.run).toHaveBeenCalledTimes(1);
    expect(compiler).toHaveBeenCalledTimes(1);
    expect(composed.trace.compression?.compiledSource).toBe("runtime/compiled-compressible-context");
    expect(await readFile(join(f.bookDir, "story", "style_guide.md"), "utf8")).toBe(f.values.styleGuide);
  });

  it.each([["complete", "null"], ["complete", "empty"], ["budgeted", "null"], ["budgeted", "empty"]] as const)
    ("does not read newly created files on the %s path when captured text is %s", async (path, capturedText) => {
    const budgeted = path === "budgeted", f = await authorityFixture(false, budgeted);
    if (capturedText === "empty") await writeAuthority(f.bookDir, { ...f.values, bookRulesJson: null,
      authorIntent: "", currentFocus: "", styleGuide: "", parentCanon: "", fanficCanon: "" });
    const authoritativeInputs = await readChapterReviewInputs(f.bookDir, 1);
    await writeAuthority(f.bookDir, authorityValues("CREATED-AFTER-CAPTURE"));
    const compiler = vi.fn(async () => "The voyage established the missing letter.");
    const input = { book: f.book, bookDir: f.bookDir, chapterNumber: 1, plan: f.plan, authoritativeInputs,
      ...(budgeted ? { contextBudget: { contextWindowTokens: 8_000, reservedOutputTokens: 1_024 },
        compressibleContextCompiler: compiler } : {}) };
    const composed = await new ComposerAgent(context({ projectRoot: f.bookDir }, 100_000)).composeChapter(input);
    expect(composed.contextPackage.selectedContext.some(entry =>
      literalContextFields.some(field => entry.source === `story/${authorityPaths[field]}`)
      || entry.source === READER_CONTRACT_SOURCE)).toBe(false);
    expect(contractFromContext(composed.contextPackage)).toBeUndefined();
    expect(composed.trace.retrieval?.selectionMode).toBe(budgeted ? "semantic" : "complete");
    expect(compiler).toHaveBeenCalledTimes(budgeted ? 1 : 0);
    expect(worker.run).toHaveBeenCalledTimes(budgeted ? 1 : 0);
    });

  it("passes the same captured inputs through direct governed composition before disk is restored from B to A", async () => {
    const f = await authorityFixture();
    const authoritativeInputs = await readChapterReviewInputs(f.bookDir, 1);
    await writeAuthority(f.bookDir, authorityValues("LATER-B"));
    const input = { book: f.book, bookDir: f.bookDir, chapterNumber: 1, plan: f.plan, authoritativeInputs,
      outlineSectionSelector: async () => [], memorySemanticSelector: async () => [],
      referenceContextProvider: async () => { await writeAuthority(f.bookDir, f.values); return { entries: [], notes: [] }; } };
    const composed = await composeGovernedChapter(input);
    expectCapturedContext(composed.contextPackage, f.values);
    expect(await readFile(join(f.bookDir, "story", "book_rules.json"), "utf8")).toBe(f.values.bookRulesJson);
    expect(worker.run).not.toHaveBeenCalled();
  });

  it.each([["", SyntaxError], ["{invalid-json", SyntaxError],
    [JSON.stringify({ version: "2", readerContract: { mode: "author-directed" } }), ZodError]] as const)
    ("validates captured raw structured rules instead of replacing malformed authority with valid disk rules (%s)", async (bookRulesJson, errorClass) => {
      const f = await authorityFixture();
      const authoritativeInputs = { ...await readChapterReviewInputs(f.bookDir, 1), bookRulesJson };
      const input = { book: f.book, bookDir: f.bookDir, chapterNumber: 1, plan: f.plan, authoritativeInputs,
        outlineSectionSelector: async () => [], memorySemanticSelector: async () => [] };
      await expect(composeGovernedChapter(input)).rejects.toBeInstanceOf(errorClass);
      expect(worker.run).not.toHaveBeenCalled();
    });
});
