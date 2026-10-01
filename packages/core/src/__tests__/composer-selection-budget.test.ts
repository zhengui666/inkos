import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComposerAgent, type OutlineSectionSelectionRequest } from "../agents/composer.js";
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
afterEach(() => { vi.restoreAllMocks(); worker.run.mockReset(); });

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
