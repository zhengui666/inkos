import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentContext } from "../agents/base.js";
import { ShortFictionOutlineAgent } from "../agents/short-fiction.js";
import { loadWorkManifest } from "../harness/work-store.js";
import {
  runShortFictionStage,
  type ShortFictionRunOptions,
} from "../pipeline/short-fiction-runner.js";
import { readShortProductionState } from "../pipeline/short-production-state.js";
import { defaultChapterLength } from "../utils/length-metrics.js";

const roots: string[] = [];
const storyId = "commercial-target-fixture";
const sourcePath = `works/${storyId}/source`;

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function outlineFixture() {
  const root = await mkdtemp(join(tmpdir(), "inkos-commercial-target-"));
  roots.push(root);
  const outline = vi.spyOn(ShortFictionOutlineAgent.prototype, "createOutline").mockResolvedValue({
    storyTitle: "The returned receipt",
    rawContent: "The seller denies the debt until the buyer produces the original receipt.",
  });
  // The outline stage and persistence are real. Its only model entry point is
  // replaced, and the runtime has no model client capable of making requests.
  const runtime = { projectRoot: root, model: "fixture", client: { defaults: { maxTokens: 4096 } } } as AgentContext;
  const options: ShortFictionRunOptions & { readonly storyId: string } = {
    projectRoot: root,
    storyId,
    direction: "写一个买家凭原始收据追回欠款的故事。",
    cover: false,
    runtimes: { planner: runtime, writer: runtime, draftReview: runtime, package: runtime },
  };
  return { root, options, outline };
}

describe("new short-fiction production targets", () => {
  it.each([
    { language: undefined, expectedLanguage: "zh", chapterCount: 5, charsPerChapter: 2400, totalLength: 12000, minChapterLength: 1200 },
    { language: "en" as const, expectedLanguage: "en", chapterCount: 12, charsPerChapter: 650, totalLength: 7800, minChapterLength: 325 },
  ])("persists the $expectedLanguage budget and gives it to the planner", async ({
    language, expectedLanguage, chapterCount, charsPerChapter, totalLength, minChapterLength,
  }) => {
    const { root, options, outline } = await outlineFixture();
    await runShortFictionStage({ ...options, language, minChapterLengthRatio: 0.5, stage: "outline" });

    expect(outline).toHaveBeenCalledOnce();
    expect(outline.mock.calls[0]![0]).toMatchObject({
      language: expectedLanguage, chapterCount, charsPerChapter,
    });
    const state = await readShortProductionState(root, sourcePath);
    expect(state?.target).toMatchObject({
      language: expectedLanguage, chapterCount, charsPerChapter, minChapterLength,
    });
    expect((state?.target?.chapterCount ?? 0) * (state?.target?.charsPerChapter ?? 0)).toBe(totalLength);
    expect((await loadWorkManifest(root, storyId)).language).toBe(expectedLanguage);
    expect(await readFile(join(root, sourcePath, "outline/v001.md"), "utf8"))
      .toContain("the original receipt");
  });

  it.each(["zh", "en"] as const)("preserves an explicit %s chapter count and length contract", async language => {
    const { root, options, outline } = await outlineFixture();
    await runShortFictionStage({
      ...options, language, chapterCount: 3, charsPerChapter: 1700,
      minChapterLength: 1450, maxChapterLength: 1900,
      minChapterLengthRatio: 0.5, stage: "outline",
    });

    expect(outline).toHaveBeenCalledOnce();
    expect(outline.mock.calls[0]![0]).toMatchObject({ language, chapterCount: 3, charsPerChapter: 1700 });
    expect((await readShortProductionState(root, sourcePath))?.target).toMatchObject({
      language, chapterCount: 3, charsPerChapter: 1700, minChapterLength: 1450, maxChapterLength: 1900,
    });
    expect((await loadWorkManifest(root, storyId)).language).toBe(language);
  });

  it("keeps an existing twelve-chapter Chinese target when resume options are omitted", async () => {
    const { root, options, outline } = await outlineFixture();
    await runShortFictionStage({
      ...options, language: "zh", chapterCount: 12, charsPerChapter: 1000,
      minChapterLengthRatio: 0.5, stage: "outline",
    });
    const before = (await readShortProductionState(root, sourcePath))?.target;
    const outlineBefore = await readFile(join(root, sourcePath, "outline/v001.md"));
    expect(before).toMatchObject({ language: "zh", chapterCount: 12, charsPerChapter: 1000 });

    await runShortFictionStage({ ...options, minChapterLengthRatio: 0.5, stage: "outline" });

    expect((await readShortProductionState(root, sourcePath))?.target).toEqual(before);
    expect(outline).toHaveBeenCalledOnce();
    expect(await readFile(join(root, sourcePath, "outline/v001.md"))).toEqual(outlineBefore);
    expect((await loadWorkManifest(root, storyId)).language).toBe("zh");
  });
});

describe("shared long-form chapter defaults", () => {
  it.each([
    { language: "zh" as const, unit: "characters", expectedLength: 2400 },
    { language: "en" as const, unit: "words", expectedLength: 2000 },
  ])("uses $expectedLength $unit for $language", ({ language, expectedLength }) => {
    expect(defaultChapterLength(language)).toBe(expectedLength);
  });
});
