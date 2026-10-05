import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentContext } from "../agents/base.js";
import {
  SHORT_FICTION_DEFAULT_CHAPTERS,
  SHORT_FICTION_DEFAULT_CHARS_PER_CHAPTER,
  ShortFictionDraftReviewerAgent,
  ShortFictionOutlineAgent,
  ShortFictionPackagingAgent,
  ShortFictionWriterAgent,
  renderShortFictionDraftMarkdown,
  type ShortFictionBatchDraft,
  type ShortRevisionProgress,
} from "../agents/short-fiction.js";
import { loadWorkManifest } from "../harness/work-store.js";
import {
  runShortFictionProduction,
  runShortFictionStage,
  type ShortFictionRunOptions,
} from "../pipeline/short-fiction-runner.js";
import { readShortProductionState } from "../pipeline/short-production-state.js";

const roots: string[] = [];
const storyId = "night-light";
const sourcePath = `works/${storyId}/source`;
const chapterWords = 40;

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "inkos-short-resume-target-"));
  roots.push(root);
  const draft: ShortFictionBatchDraft = {
    storyTitle: "Night light",
    rawContent: "",
    chapters: [
      { number: 1, title: "The keeper", content: Array(chapterWords).fill("keeper").join(" "), charCount: chapterWords },
      { number: 2, title: "The signal", content: Array(chapterWords).fill("signal").join(" "), charCount: chapterWords },
    ],
  };
  const outline = vi.spyOn(ShortFictionOutlineAgent.prototype, "createOutline").mockResolvedValue({
    storyTitle: draft.storyTitle,
    rawContent: "The keeper repairs the lamp, then signals the returning ship.",
  });
  const writer = vi.spyOn(ShortFictionWriterAgent.prototype, "writeDraft").mockResolvedValue(draft);
  // Keep the real continuation logic so its chapter selection and word counting
  // remain part of this regression. Only its model-backed editor is replaced.
  const continuation = vi.spyOn(ShortFictionWriterAgent.prototype, "continueDraft");
  const editorPrototype = ShortFictionWriterAgent.prototype as unknown as {
    applyRevisionPlan(
      input: Parameters<ShortFictionWriterAgent["reviseDraft"]>[0],
      plan: ShortRevisionProgress["plan"] & { outlineMarkdown: string },
    ): ReturnType<ShortFictionWriterAgent["reviseDraft"]>;
  };
  const editor = vi.spyOn(editorPrototype, "applyRevisionPlan").mockImplementation(async (input, plan) => {
    const selected = new Set(plan.chapters.map(chapter => chapter.number));
    const next = {
      ...input.draft,
      chapters: input.draft.chapters.map(chapter => selected.has(chapter.number)
        ? draft.chapters.find(candidate => candidate.number === chapter.number)!
        : chapter),
    };
    const completed = { ...next, rawContent: renderShortFictionDraftMarkdown(next, input.language) };
    await input.onRevisionProgress?.({ plan, draft: completed, completed: [...selected] });
    return { draft: completed, outlineMarkdown: input.outlineMarkdown };
  });
  const reviewer = vi.spyOn(ShortFictionDraftReviewerAgent.prototype, "reviewDraft").mockResolvedValue({
    summary: "The keeper's decision and the signal follow the outline.", observations: [],
  });
  const packager = vi.spyOn(ShortFictionPackagingAgent.prototype, "generatePackage").mockResolvedValue({
    title: draft.storyTitle, intro: "A keeper brings a ship home.", sellingPoints: ["A difficult rescue"],
    coverPrompt: "A lighthouse keeper beside a repaired lamp.", rawContent: "",
  });
  // No model client or AppServer is initialized. All model entry points above
  // are fake agents; the production runner and file persistence remain real.
  const runtime = { projectRoot: root, model: "fixture", client: { defaults: { maxTokens: 4096 } } } as AgentContext;
  const options: ShortFictionRunOptions = {
    projectRoot: root, storyId, direction: "A keeper repairs a lamp and guides a ship home.",
    language: "en", chapterCount: 2, charsPerChapter: chapterWords, minChapterLength: 35,
    cover: false, runtimes: { planner: runtime, writer: runtime, draftReview: runtime, package: runtime },
  };
  const resume: ShortFictionRunOptions = {
    projectRoot: root, storyId, direction: "", cover: false, runtimes: options.runtimes,
  };
  return { root, draft, options, resume, outline, writer, continuation, editor, reviewer, packager };
}

async function sourceBytes(root: string): Promise<Record<string, Buffer>> {
  const files: Array<[string, Buffer]> = [];
  const visit = async (path: string): Promise<void> => {
    for (const entry of await readdir(join(root, path), { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await visit(child);
      else files.push([child, await readFile(join(root, child))]);
    }
  };
  await visit(sourcePath);
  const manifestPath = `works/${storyId}/work.json`;
  files.push([manifestPath, await readFile(join(root, manifestPath))]);
  return Object.fromEntries(files.sort(([left], [right]) => left.localeCompare(right)));
}

it("resumes an English partial draft from its saved target without regenerating the outline or completed chapter", async () => {
  const { root, draft, options, resume, outline, writer, continuation, editor, reviewer, packager } = await fixture();
  writer.mockImplementationOnce(async input => {
    await input.onBatchComplete?.({
      ...draft,
      chapters: [draft.chapters[0]!, { number: 2, title: "", content: "", charCount: 0 }],
    }, [1]);
    throw Object.assign(new Error("The fixture writer was interrupted after chapter one."), { code: "MODEL_STREAM_IDLE" });
  });

  await expect(runShortFictionProduction(options)).rejects.toMatchObject({
    code: "MODEL_STREAM_IDLE",
    recovery: { workId: storyId, validChapterNumbers: [1], incompleteChapterNumbers: [2], requestedChapterCount: 2 },
  });
  const outlineBefore = await readFile(join(root, sourcePath, "outline/v001.md"));
  const chapterBefore = await readFile(join(root, sourcePath, "drafts/v001-partial/chapters/0001.md"));
  const targetBefore = (await readShortProductionState(root, sourcePath))!.target;

  const result = await runShortFictionProduction(resume);
  const state = (await readShortProductionState(root, sourcePath))!;
  const savedDraft = JSON.parse(await readFile(join(root, result.finalJsonPath), "utf8")) as ShortFictionBatchDraft;

  expect(outline).toHaveBeenCalledTimes(1);
  expect(writer).toHaveBeenCalledTimes(1);
  expect(continuation).toHaveBeenCalledTimes(1);
  expect(editor).toHaveBeenCalledTimes(1);
  expect(editor.mock.calls[0]![0].chapterNumbers).toEqual([2]);
  expect.soft(continuation.mock.calls[0]![0]).toMatchObject({
    language: "en", chapterCount: 2, charsPerChapter: chapterWords, minChapterLength: 35,
    direction: options.direction,
  });
  expect.soft(reviewer.mock.calls[0]![0].language).toBe("en");
  expect.soft(packager.mock.calls[0]![0].language).toBe("en");
  expect.soft(state.target).toEqual(targetBefore);
  expect.soft(result.delivery?.measurements).toMatchObject({
    unit: "words", chapterCount: 2, totalLength: 80,
    chapterLengths: [{ number: 1, length: 40 }, { number: 2, length: 40 }],
  });
  expect.soft(savedDraft.chapters[0]).toEqual(draft.chapters[0]);
  const finalChapter = await readFile(join(root, sourcePath, "final/chapters/0001.md"));
  expect.soft(finalChapter.equals(chapterBefore), "Completed chapter bytes must survive the resume").toBe(true);
  expect(await readFile(join(root, sourcePath, "outline/v001.md"))).toEqual(outlineBefore);
  expect((await loadWorkManifest(root, storyId)).language).toBe("en");
});

it("reuses a completed English story with omitted target options and leaves every source file unchanged", async () => {
  const { root, options, resume, outline, writer, continuation, editor, reviewer, packager } = await fixture();
  const first = await runShortFictionProduction(options);
  expect(first.delivery?.status).toBe("checks_passed");
  const before = await sourceBytes(root);
  for (const agent of [outline, writer, continuation, editor, reviewer, packager]) agent.mockClear();

  const second = await runShortFictionProduction(resume);

  for (const agent of [outline, writer, continuation, editor, reviewer, packager]) {
    expect.soft(agent.mock.calls.length, `${agent.getMockName()} must not run again`).toBe(0);
  }
  expect.soft(second.delivery).toEqual(first.delivery);
  const after = await sourceBytes(root);
  const changedPaths = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter(path => !before[path] || !after[path] || !before[path]!.equals(after[path]!));
  expect.soft(changedPaths, "Completed-story reuse must preserve every source file and manifest byte").toEqual([]);
});

it("keeps Chinese defaults for a new story when no language or target is supplied", async () => {
  const { root, resume, outline } = await fixture();
  await runShortFictionStage({ ...resume, storyId, direction: "写一个灯塔守护人的故事。", stage: "outline" });

  expect(outline.mock.calls[0]![0]).toMatchObject({
    language: "zh", chapterCount: SHORT_FICTION_DEFAULT_CHAPTERS, charsPerChapter: SHORT_FICTION_DEFAULT_CHARS_PER_CHAPTER,
  });
  expect((await readShortProductionState(root, sourcePath))!.target).toMatchObject({
    language: "zh", chapterCount: SHORT_FICTION_DEFAULT_CHAPTERS, charsPerChapter: SHORT_FICTION_DEFAULT_CHARS_PER_CHAPTER,
  });
  expect((await loadWorkManifest(root, storyId)).language).toBe("zh");
});

it("preserves explicitly selected language and target for a new story", async () => {
  const { root, options, outline } = await fixture();
  await runShortFictionStage({
    ...options, storyId, stage: "outline", chapterCount: 3, charsPerChapter: 55,
    minChapterLength: 45, maxChapterLength: 65,
  });

  expect(outline.mock.calls[0]![0]).toMatchObject({ language: "en", chapterCount: 3, charsPerChapter: 55 });
  expect((await readShortProductionState(root, sourcePath))!.target).toMatchObject({
    language: "en", chapterCount: 3, charsPerChapter: 55, minChapterLength: 45, maxChapterLength: 65,
  });
  expect((await loadWorkManifest(root, storyId)).language).toBe("en");
});
