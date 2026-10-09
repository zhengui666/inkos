import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentContext } from "../agents/base.js";
import {
  ShortFictionDraftReviewerAgent,
  ShortFictionOutlineAgent,
  ShortFictionPackagingAgent,
  ShortFictionWriterAgent,
  validateShortFictionDraftForFinal,
} from "../agents/short-fiction.js";
import { runShortFictionProduction, runShortFictionStage, type ShortFictionRunOptions } from "../pipeline/short-fiction-runner.js";
import { readShortProductionState, shortInputSnapshot, writeShortProductionState } from "../pipeline/short-production-state.js";

const modelCall = vi.hoisted(() => vi.fn(() => { throw new Error("Contract fixtures must not call a model"); }));
vi.mock("../agent/worker-agent.js", () => ({ runWorkerAgent: modelCall, runWorkerAgentTool: modelCall }));
const roots: string[] = [];
const source = "works/cache-contract/source";
const manuscriptPaths = ["drafts/v001/draft.json", "drafts/v001/full.md", "drafts/v001/chapters/0001.md",
  "final/short-story.json", "final/full.md", "final/chapters/0001.md"];

it.each(["completed", "unavailable", "package-rebound"] as const)(
  "revalidates a baseline-v2 %s receipt once without rewriting valid prose", async mode => {
    const { root, options, resume, agents } = await fixture();
    if (mode === "unavailable") agents.reviewer.mockRejectedValueOnce(new Error("Synthetic baseline review unavailable"));
    await runShortFictionProduction(options);
    const state = (await readShortProductionState(root, source))!;
    const { targetHash: _targetHash, ...legacyReview } = state.stages.review!;
    const request = JSON.parse(legacyReview.requestHash!);
    for (const key of ["title", "openingHookChars", "minChapterLength", "maxChapterLength"]) delete request[key];
    const target = mode === "package-rebound" ? { ...state.target!, openingHookChars: 110 } : state.target!;
    // Baseline package-only updates could rebind delivery while retaining an old review.
    const delivery = { ...state.delivery!, target };
    await writeShortProductionState(root, source, { ...state, target, delivery, stages: { ...state.stages,
      review: { ...legacyReview, requestHash: shortInputSnapshot(request) },
      package: { ...state.stages.package!, reviewHash: shortInputSnapshot(delivery) },
    } });
    const manuscriptBytes = await Promise.all(manuscriptPaths.map(path => readFile(join(root, source, path))));
    for (const agent of Object.values(agents)) agent.mockClear();

    const result = await runShortFictionProduction(resume);
    const verified = (await readShortProductionState(root, source))!;

    expect(result.delivery).toMatchObject({ status: "checks_passed", target });
    expect(verified.stages.review?.targetHash).toBe(shortInputSnapshot(target));
    expect(agents.reviewer).toHaveBeenCalledOnce();
    expect(agents.outline).not.toHaveBeenCalled();
    expect(agents.writer).not.toHaveBeenCalled();
    expect(modelCall).not.toHaveBeenCalled();
    expect(await Promise.all(manuscriptPaths.map(path => readFile(join(root, source, path))))).toEqual(manuscriptBytes);

    const stateBytes = await readFile(join(root, source, "production-state.json"));
    for (const agent of Object.values(agents)) agent.mockClear();
    expect((await runShortFictionProduction(resume)).delivery).toEqual(result.delivery);
    for (const agent of Object.values(agents)) expect(agent).not.toHaveBeenCalled();
    expect(await readFile(join(root, source, "production-state.json"))).toEqual(stateBytes);
  },
);

afterEach(async () => {
  vi.restoreAllMocks();
  modelCall.mockClear();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "inkos-sol-short-cache-contract-"));
  roots.push(root);
  const draft = { storyTitle: "夜灯", openingHook: "灯".repeat(100), rawContent: "", chapters: [
    { number: 1, title: "归航", content: "海".repeat(40), charCount: 40 },
  ] };
  const outline = vi.spyOn(ShortFictionOutlineAgent.prototype, "createOutline").mockResolvedValue({
    storyTitle: draft.storyTitle, rawContent: "守灯人修灯，引导船只归航。",
  });
  const writer = vi.spyOn(ShortFictionWriterAgent.prototype, "writeDraft").mockResolvedValue(draft);
  // Real continuation keeps the opening-scene and chapter validation in this probe.
  const continuation = vi.spyOn(ShortFictionWriterAgent.prototype, "continueDraft");
  const reviewer = vi.spyOn(ShortFictionDraftReviewerAgent.prototype, "reviewDraft").mockResolvedValue({
    summary: "已审阅合成稿件。", observations: [],
  });
  const packager = vi.spyOn(ShortFictionPackagingAgent.prototype, "generatePackage").mockResolvedValue({
    title: draft.storyTitle, intro: "守灯人修灯。", sellingPoints: ["归航"], coverPrompt: "夜间灯塔。", rawContent: "",
  });
  const runtime = { projectRoot: root, model: "fixture", client: { defaults: { maxTokens: 4096 } } } as AgentContext;
  const options: ShortFictionRunOptions = {
    projectRoot: root, storyId: "cache-contract", title: draft.storyTitle, direction: "修灯引船归航。",
    chapterCount: 1, charsPerChapter: 40, minChapterLength: 35, maxChapterLength: 45, openingHookChars: 100,
    language: "zh", cover: false, runtimes: { planner: runtime, writer: runtime, draftReview: runtime, package: runtime },
  };
  const resume: ShortFictionRunOptions = { projectRoot: root, storyId: options.storyId, direction: "", cover: false, runtimes: options.runtimes };
  const agents = { outline, writer, continuation, reviewer, packager };
  return { root, draft, options, resume, agents };
}

it.each([
  ["openingHookChars", 110],
  ["minChapterLength", 36],
  ["maxChapterLength", 44],
] as const)("rebinds completed delivery and review identity when %s changes inside the existing manuscript's valid range", async (field, value) => {
  const { root, draft, options, resume, agents } = await fixture();
  for (const openingHookChars of [100, 110]) {
    expect(() => validateShortFictionDraftForFinal(draft, { ...options, expectedChapters: 1, openingHookChars })).not.toThrow();
  }
  await runShortFictionProduction(options);
  const before = (await readShortProductionState(root, source))!;
  const bytes = await Promise.all(manuscriptPaths.map(path => readFile(join(root, source, path))));
  for (const agent of Object.values(agents)) agent.mockClear();

  const result = await runShortFictionProduction({ ...resume, [field]: value });
  const persisted = (await readShortProductionState(root, source))!;

  expect(modelCall).not.toHaveBeenCalled();
  expect(await Promise.all(manuscriptPaths.map(path => readFile(join(root, source, path))))).toEqual(bytes);
  expect(agents.outline).not.toHaveBeenCalled();
  expect(agents.writer).not.toHaveBeenCalled();
  expect.soft(result.delivery?.target).toEqual({ ...before.target, [field]: value });
  expect.soft(persisted.target).toEqual({ ...before.target, [field]: value });
  expect.soft(persisted.delivery).toEqual(result.delivery);
  expect.soft(result.delivery?.measurements?.openingHookLength).toBe(100);
  expect.soft(result.delivery?.status).toBe("checks_passed");
  expect.soft(persisted.stages.review?.requestHash).not.toBe(before.stages.review?.requestHash);
  expect.soft(JSON.parse(persisted.stages.review!.requestHash!)).toMatchObject(persisted.target!);
  expect.soft(persisted.stages.review?.targetHash).toBe(shortInputSnapshot(persisted.target));
  expect.soft(agents.reviewer).toHaveBeenCalledOnce();
  expect.soft(agents.packager).toHaveBeenCalledOnce();
  const reviewContext = agents.packager.mock.calls[0]?.[0].reviewContext;
  expect.soft(reviewContext && JSON.parse(reviewContext)).toMatchObject({ target: { [field]: value } });

  const stateBytes = await readFile(join(root, source, "production-state.json"));
  for (const agent of Object.values(agents)) agent.mockClear();
  const inherited = await runShortFictionProduction(resume);
  expect.soft(inherited.delivery).toEqual(result.delivery);
  expect(await readFile(join(root, source, "production-state.json"))).toEqual(stateBytes);
  for (const agent of Object.values(agents)) expect.soft(agent).not.toHaveBeenCalled();
  expect(modelCall).not.toHaveBeenCalled();
});

it("keeps a package-only target change unverified until the unchanged manuscript is reviewed for that target", async () => {
  const { root, options, resume, agents } = await fixture();
  await runShortFictionProduction(options);
  const reviewed = (await readShortProductionState(root, source))!.stages.review;
  const bytes = await Promise.all(manuscriptPaths.map(path => readFile(join(root, source, path))));
  for (const agent of Object.values(agents)) agent.mockClear();

  const packaged = await runShortFictionStage({ ...resume, storyId: "cache-contract", openingHookChars: 110, stage: "package" });
  const persisted = (await readShortProductionState(root, source))!;
  expect(packaged.delivery).toMatchObject({ status: "unverified", target: { openingHookChars: 110 }, measurements: { openingHookLength: 100 } });
  expect(persisted.delivery).toEqual(packaged.delivery);
  expect(persisted.stages.review).toEqual(reviewed);
  expect(agents.reviewer).not.toHaveBeenCalled();
  expect(agents.continuation).not.toHaveBeenCalled();
  expect(await Promise.all(manuscriptPaths.map(path => readFile(join(root, source, path))))).toEqual(bytes);

  const resumed = await runShortFictionProduction(resume);
  expect(resumed.delivery).toMatchObject({ status: "checks_passed", target: { openingHookChars: 110 } });
  expect(agents.reviewer).toHaveBeenCalledOnce();
  expect(await Promise.all(manuscriptPaths.map(path => readFile(join(root, source, path))))).toEqual(bytes);
  expect(modelCall).not.toHaveBeenCalled();
});

it("updates an explicit target after an unavailable review without regenerating prose", async () => {
  const { root, options, resume, agents } = await fixture();
  agents.reviewer.mockRejectedValueOnce(new Error("Synthetic review unavailable"));
  const initial = await runShortFictionProduction(options);
  expect(initial.delivery?.status).toBe("unverified");
  const bytes = await Promise.all(manuscriptPaths.map(path => readFile(join(root, source, path))));
  for (const agent of Object.values(agents)) agent.mockClear();

  expect((await runShortFictionProduction(resume)).delivery).toEqual(initial.delivery);
  expect(agents.reviewer).not.toHaveBeenCalled();
  const result = await runShortFictionProduction({ ...resume, openingHookChars: 110 });
  expect(result.delivery).toMatchObject({ status: "checks_passed", target: { openingHookChars: 110 } });
  expect((await readShortProductionState(root, source))?.delivery).toEqual(result.delivery);
  expect(agents.reviewer).toHaveBeenCalledOnce();
  expect(agents.outline).not.toHaveBeenCalled();
  expect(agents.writer).not.toHaveBeenCalled();
  expect(await Promise.all(manuscriptPaths.map(path => readFile(join(root, source, path))))).toEqual(bytes);
  expect(modelCall).not.toHaveBeenCalled();
});

it.each(["missing", "old target", "old manuscript"] as const)("recovers an interrupted target refresh with %s delivery instead of reusing the old package", async deliveryState => {
  const { root, options, resume, agents } = await fixture();
  await runShortFictionProduction(options);
  const before = (await readShortProductionState(root, source))!;
  const bytes = await Promise.all(manuscriptPaths.map(path => readFile(join(root, source, path))));
  const packageBefore = await readFile(join(root, source, "final/sales-package.json"));
  agents.packager.mockResolvedValue({ title: "夜灯", intro: "Packaging for target 110.", sellingPoints: ["归航"], coverPrompt: "夜间灯塔。", rawContent: "" });
  for (const agent of Object.values(agents)) agent.mockClear();

  await expect(runShortFictionProduction({ ...resume, openingHookChars: 110, onProgress: message => {
    if (message === "Generating synopsis and cover prompt...") throw new Error("Synthetic interruption after review persistence");
  } })).rejects.toThrow("Synthetic interruption after review persistence");
  const interrupted = (await readShortProductionState(root, source))!;
  expect(interrupted.target).toEqual({ ...before.target, openingHookChars: 110 });
  expect(interrupted.stages.review).toMatchObject({ status: "completed", inputHash: before.stages.review!.inputHash, targetHash: shortInputSnapshot(interrupted.target) });
  expect(interrupted.stages.review?.requestHash).not.toBe(before.stages.review?.requestHash);
  expect(interrupted.stages.package).toEqual(before.stages.package);
  expect(interrupted.delivery).toBeUndefined();
  expect(agents.reviewer).toHaveBeenCalledOnce();
  expect(agents.packager).not.toHaveBeenCalled();
  expect(await readFile(join(root, source, "final/sales-package.json"))).toEqual(packageBefore);
  if (deliveryState !== "missing") {
    const delivery = deliveryState === "old target" ? before.delivery!
      : { ...before.delivery!, target: interrupted.target, inputHash: "stale manuscript input" };
    await writeShortProductionState(root, source, { ...interrupted, delivery,
      stages: { ...interrupted.stages, package: { ...interrupted.stages.package!, reviewHash: shortInputSnapshot(delivery) } } });
  }
  for (const agent of Object.values(agents)) agent.mockClear();

  const result = await runShortFictionProduction(resume);
  const recovered = (await readShortProductionState(root, source))!;
  expect.soft(result.delivery).toMatchObject({ status: "checks_passed", target: interrupted.target, measurements: { openingHookLength: 100 } });
  expect.soft(recovered.delivery).toEqual(result.delivery);
  expect.soft(recovered.delivery?.inputHash).toBe(before.stages.review!.inputHash);
  expect.soft(recovered.stages.package?.reviewHash).toBe(shortInputSnapshot(recovered.delivery));
  expect.soft(await readFile(join(root, source, "final/sales-package.json"))).not.toEqual(packageBefore);
  expect.soft(agents.packager).toHaveBeenCalledOnce();
  expect(agents.reviewer).not.toHaveBeenCalled();
  expect(agents.outline).not.toHaveBeenCalled();
  expect(agents.writer).not.toHaveBeenCalled();
  expect(await Promise.all(manuscriptPaths.map(path => readFile(join(root, source, path))))).toEqual(bytes);
  expect(modelCall).not.toHaveBeenCalled();

  const stateBytes = await readFile(join(root, source, "production-state.json"));
  for (const agent of Object.values(agents)) agent.mockClear();
  expect((await runShortFictionProduction(resume)).delivery).toEqual(result.delivery);
  expect(await readFile(join(root, source, "production-state.json"))).toEqual(stateBytes);
  for (const agent of Object.values(agents)) expect(agent).not.toHaveBeenCalled();
});
