import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../codex/client.js", () => ({ createCodexClient: () => { throw new Error("Unexpected model transport in goal fixture."); } }));
import { GoalStore } from "../goals/store.js";
import { GoalExecutor } from "../goals/executor.js";
import { chapterGoalInput, createChapterGoalAdapter } from "../goals/chapters.js";
import { goalError } from "../goals/contracts.js";
import { PipelineRunner } from "../pipeline/runner.js";
import { WriterAgent, type WriteChapterOutput } from "../agents/writer.js";
import { ContinuityAuditor } from "../agents/continuity.js";
import { StateValidatorAgent } from "../agents/state-validator.js";
import { PlannerAgent } from "../agents/planner.js";
import { StateManager } from "../state/manager.js";
import { createLLMClient } from "../llm/provider.js";
import { CreativeEpisodeStore } from "../harness/episode-store.js";
import { HARNESS_VERSION } from "../harness/contracts.js";
import { prepareStateReplay, commitStateReplay, stateReplayPlanId, type StateReplayWorkers } from "../state/state-replay.js";
import { ManualPublishingAdapter, PublishingStore, FanqiePublishingAdapter, type FanqieBrowserPort, type FanqieIntent, type FanqieSnapshot } from "../publishing/index.js";
import { createWorkManifest, loadWorkManifest, saveWorkManifest } from "../harness/work-store.js";
import { syncWorkSourceArtifacts } from "../harness/source-sync.js";
import { persistChapterArtifacts } from "../pipeline/chapter-persistence.js";
import { savePersistedPlan } from "../pipeline/persisted-governed-plan.js";
import {
  buildRuntimeStateArtifacts, createInitialRuntimeState, loadRuntimeStateSnapshot,
  loadRuntimeStateSnapshotAtChapter, saveRuntimeStateSnapshot,
} from "../state/runtime-state-store.js";

const roots: string[] = [], stores: Array<GoalStore | PublishingStore | CreativeEpisodeStore> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
function open(root: string) { const store = new GoalStore(join(root, ".inkos", "harness.sqlite")); stores.push(store); return store; }
function close(store: GoalStore) { store.close(); stores.splice(stores.indexOf(store), 1); }
function start(store: GoalStore) { store.requestRun("goal", store.get("goal").version); }
async function setup(endChapter = 2) {
  const root = await mkdtemp(join(tmpdir(), "inkos-chapter-goal-")); roots.push(root);
  const state = new StateManager(root), bookDir = state.bookDir("novel"), now = new Date().toISOString();
  await saveWorkManifest(root, createWorkManifest({ id: "novel", title: "Departure", profileId: "longform-novel", language: "en" }));
  await state.saveBookConfig("novel", { id: "novel", title: "Departure", genre: "general", platform: "other", status: "active",
    targetChapters: endChapter, chapterWordCount: 10, language: "en", createdAt: now, updatedAt: now });
  await mkdir(join(bookDir, "story/outline"), { recursive: true });
  for (const [name, content] of Object.entries({ "outline/story_frame.md": "A witness leaves.", "outline/volume_map.md": "Departure scenes.",
    "book_rules.md": "Preserve facts.", "book_rules.json": JSON.stringify({ version: "2", prohibitions: [], enableFullCastTracking: false, allowedDeviations: [] }) })) {
    await writeFile(join(bookDir, "story", name), content);
  }
  await createInitialRuntimeState({ bookDir, language: "en" }); await state.saveChapterIndex("novel", []); await state.snapshotState("novel", 0);
  await mkdir(join(bookDir, "story/runtime"), { recursive: true });
  for (let chapter = 1; chapter <= endChapter; chapter++) await savePersistedPlan(bookDir, {
    intent: { chapter, goal: "Continue the departure." }, memo: { chapter, goal: "Continue the departure.", body: "Continue the departure.", threadRefs: [] },
    intentMarkdown: "Continue the departure.", runtimePath: `runtime/chapter-${chapter}.intent.md`, plannerInputs: [],
  });
  const client = createLLMClient({ service: "custom", provider: "openai", configSource: "studio", model: "fixture", apiKey: "fixture",
    baseUrl: "https://fixture.invalid/v1", apiFormat: "chat", stream: false, temperature: 0, thinkingBudget: 0 });
  const pipeline = new PipelineRunner({ projectRoot: root, client, model: "fixture" });
  const writer = new WriterAgent({ client, model: "fixture", projectRoot: root });
  vi.spyOn(PlannerAgent.prototype, "planChapter").mockImplementation(async input => ({
    intent: { chapter: input.chapterNumber, goal: input.externalContext ?? "Continue." },
    memo: { chapter: input.chapterNumber, goal: "Continue.", body: "Continue the departure.", threadRefs: [] },
    intentMarkdown: "Continue the departure.", runtimePath: `runtime/chapter-${input.chapterNumber}.intent.md`, plannerInputs: [],
  }));
  const write = vi.spyOn(WriterAgent.prototype, "writeChapter").mockImplementation(input => output(bookDir, input.chapterNumber));
  vi.spyOn(ContinuityAuditor.prototype, "auditChapter").mockResolvedValue({ summary: "", observations: [] });
  vi.spyOn(StateValidatorAgent.prototype, "validate").mockResolvedValue({ consistent: true, reconciliationRequired: false, observations: [] });
  const save = async (chapterNumber: number) => {
    const value = await output(bookDir, chapterNumber);
    await persistChapterArtifacts({ chapterNumber, chapterTitle: value.title, auditResult: { summary: "", observations: [] }, finalWordCount: value.wordCount,
      loadChapterIndex: () => state.loadChapterIndex("novel"), saveChapter: index => writer.saveChapter(bookDir, value, "en", index),
      markBookActiveIfNeeded: async () => undefined });
  };
  const store = open(root);
  const create = () => store.create(chapterGoalInput({ id: "goal", workId: "novel", intent: "Finish the departure sequence.",
    startChapter: 1, endChapter, expiresAt: Date.now() + 60000 }));
  const adapter = createChapterGoalAdapter({ projectRoot: root, pipeline });
  return { root, state, bookDir, store, create, save, write, adapter };
}
async function output(bookDir: string, chapter: number): Promise<WriteChapterOutput> {
  const artifacts = await buildRuntimeStateArtifacts({ bookDir, language: "en", delta: {
    chapter, factOps: { upsert: [{ subject: "witness", predicate: "location", object: `door ${chapter}` }], expire: [] },
    hookOps: { upsert: [], mention: [], resolve: [], defer: [] }, newHookCandidates: [],
    chapterSummary: { chapter, title: `Departure ${chapter}`, characters: "witness", events: "The witness leaves.",
      stateChanges: "Another door.", hookActivity: "", mood: "tense", chapterType: "investigation" },
  } });
  return { chapterNumber: chapter, title: `Departure ${chapter}`, content: "The witness closes the ledger and leaves the room.", wordCount: 10,
    postSettlement: "", runtimeStateDelta: artifacts.resolvedDelta, runtimeStateSnapshot: artifacts.snapshot,
    updatedState: artifacts.currentStateMarkdown, updatedHooks: artifacts.hooksMarkdown,
    updatedChapterSummaries: artifacts.chapterSummariesMarkdown, runtimeStateApplied: true };
}
async function filesUnder(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) { const path = join(entry.parentPath, entry.name); result[relative(root, path)] = await readFile(path, "utf8"); }
  }
  return result;
}

describe("chapter goals with native persistence", () => {
  it("retains chapters 1–17 and after restart dispatches only chapter 18", async () => {
    const f = await setup(18);
    for (let chapter = 1; chapter <= 17; chapter++) await f.save(chapter);
    await syncWorkSourceArtifacts({ projectRoot: f.root, workId: "novel", accept: true });
    const chapters = await filesUnder(join(f.bookDir, "chapters")), snapshots = await filesUnder(join(f.bookDir, "story/snapshots"));
    const index = await f.state.loadChapterIndex("novel");
    const controller = new AbortController();
    f.write.mockImplementationOnce(async () => { controller.abort(new Error("connection lost")); throw goalError("MODEL_UNAVAILABLE", "provider unavailable"); });
    f.create(); start(f.store);
    const first = await new GoalExecutor(f.store, [f.adapter], 0).run("goal", controller.signal);
    expect(first.status, JSON.stringify(first.error)).toBe("interrupted"); expect(first.steps.slice(0, 17).every(step => step.status === "completed")).toBe(true);
    expect(f.write.mock.calls.map(([input]) => input.chapterNumber)).toEqual([18]);
    expect(await filesUnder(join(f.bookDir, "chapters"))).toEqual(chapters);
    close(f.store); const reopened = open(f.root); start(reopened);
    const finished = await new GoalExecutor(reopened, [f.adapter], 0).run("goal");
    expect(finished.status).toBe("completed"); expect(finished.attempts).toBe(2);
    expect(f.write.mock.calls.map(([input]) => input.chapterNumber)).toEqual([18, 18]);
    expect((await f.state.loadChapterIndex("novel")).slice(0, 17)).toEqual(index);
    const afterChapters = await filesUnder(join(f.bookDir, "chapters")), afterSnapshots = await filesUnder(join(f.bookDir, "story/snapshots"));
    for (const [path, bytes] of Object.entries(chapters)) if (path !== "index.json") expect(afterChapters[path]).toBe(bytes);
    for (const [path, bytes] of Object.entries(snapshots)) expect(afterSnapshots[path]).toBe(bytes);
    expect((await loadRuntimeStateSnapshot(f.bookDir)).manifest.lastAppliedChapter).toBe(18);
  }, 30000);

  it("does not confuse retained prose with settled runtime state", async () => {
    const f = await setup(); await f.save(1);
    await syncWorkSourceArtifacts({ projectRoot: f.root, workId: "novel", accept: true });
    const baseline = await loadRuntimeStateSnapshotAtChapter({ bookDir: f.bookDir, chapterNumber: 0, language: "en" });
    await saveRuntimeStateSnapshot(f.bookDir, baseline);
    f.create(); start(f.store);
    const result = await new GoalExecutor(f.store, [f.adapter]).run("goal");
    expect(result.status).toBe("reconciliation_required"); expect(result.error?.code).toBe("CHAPTER_STATE_BEHIND");
    expect(f.write).not.toHaveBeenCalled(); expect((await f.state.loadChapterIndex("novel")).map(chapter => chapter.number)).toEqual([1]);
  });

  it("repairs retained prose, explicitly resumes the goal, and preserves publication uncertainty across shared-store reopen", async () => {
    const f = await setup(2); await f.save(1);
    await syncWorkSourceArtifacts({ projectRoot: f.root, workId: "novel", accept: true });
    const beforeWork = await loadWorkManifest(f.root, "novel");
    const prosePath = "source/chapters/0001_Departure_1.md";
    const prose = beforeWork.artifacts.find(a => a.revisions.some(r => r.path === prosePath))!;
    const beforeBytes = await readFile(join(f.bookDir, "chapters/0001_Departure_1.md"));
    const baseline = await loadRuntimeStateSnapshotAtChapter({ bookDir: f.bookDir, chapterNumber: 0, language: "en" });
    await saveRuntimeStateSnapshot(f.bookDir, baseline);
    f.create(); start(f.store);
    const executor = new GoalExecutor(f.store, [f.adapter], 0);
    expect((await executor.run("goal")).error?.code).toBe("CHAPTER_STATE_BEHIND");
    expect(f.write).not.toHaveBeenCalled();

    const settle = vi.fn<StateReplayWorkers["writer"]["settleChapterState"]>(async input => ({
      ...await output(input.bookDir, input.chapterNumber), content: input.content, title: input.title,
    }));
    const plan = await prepareStateReplay({ projectRoot: f.root, bookId: "novel", baselineChapter: 0,
      createWorkers: isolatedRoot => {
        expect(isolatedRoot).not.toBe(f.root);
        return { writer: { settleChapterState: settle }, validator: { validate: async (...args) => {
          expect(args[8]?.chapterSummary?.chapter).toBe(1);
          return { consistent: true, reconciliationRequired: false, observations: [] };
        } } };
      } });
    expect(plan.version).toBe(3);
    expect(settle).toHaveBeenCalledTimes(1);
    expect((await loadRuntimeStateSnapshot(f.bookDir)).manifest.lastAppliedChapter).toBe(0);
    await commitStateReplay({ projectRoot: f.root, plan, expectedPlanId: stateReplayPlanId(plan) });
    expect(settle).toHaveBeenCalledTimes(1); // The commit path is model-free.
    expect(await readFile(join(f.bookDir, "chapters/0001_Departure_1.md"))).toEqual(beforeBytes);
    const runtime = await loadRuntimeStateSnapshot(f.bookDir);
    expect(runtime.manifest.lastAppliedChapter).toBe(1);
    expect(await loadRuntimeStateSnapshotAtChapter({ bookDir: f.bookDir, chapterNumber: 1, language: "en" })).toEqual(runtime);
    const repairedWork = await loadWorkManifest(f.root, "novel");
    expect(repairedWork.artifacts.find(a => a.id === prose.id)?.currentRevisionId).toBe(prose.currentRevisionId);
    const stateArtifact = repairedWork.artifacts.find(a => a.revisions.some(r => r.path === "source/story/state/manifest.json"))!;
    const stateBytes = await readFile(join(f.bookDir, "story/state/manifest.json"));
    const selectedState = stateArtifact.revisions.find(r => r.id === stateArtifact.currentRevisionId)!;
    expect(selectedState.path).toBe("source/story/state/manifest.json");
    expect(await readFile(join(f.root, "works/novel", selectedState.snapshotPath!))).toEqual(stateBytes);
    expect((await executor.run("goal")).status).toBe("reconciliation_required");
    expect(f.write).not.toHaveBeenCalled(); // Repair alone grants no resume permission.
    start(f.store);
    expect((await executor.run("goal")).status).toBe("completed");
    expect(f.write.mock.calls.map(([input]) => input.chapterNumber)).toEqual([2]);
    expect(await readFile(join(f.bookDir, "chapters/0001_Departure_1.md"))).toEqual(beforeBytes);

    const dbPath = join(f.root, ".inkos", "harness.sqlite");
    let episodes = new CreativeEpisodeStore(dbPath); stores.push(episodes);
    episodes.create({ version: HARNESS_VERSION, id: "combined-episode", workId: "novel", profileId: "longform-novel",
      status: "running", startedAt: new Date().toISOString(), completedAt: null });
    episodes.append({ episodeId: "combined-episode", workId: "novel", type: "fixture-replay-accepted", payload: { planId: stateReplayPlanId(plan) } });
    episodes.finishWithEvent("combined-episode", "completed");
    const episodeEvents = episodes.listEvents("combined-episode"), goalEvents = f.store.events("goal");
    let publishing = new PublishingStore(dbPath); stores.push(publishing);
    let packages = new ManualPublishingAdapter(f.root, publishing);
    const target = await packages.mapBook({ workId: "novel", platform: "fanqie", accountLabel: "fixture-author", remoteBookId: "fixture-book" });
    const pkg = await packages.prepare({ targetId: target.id, formats: ["txt"],
      chapters: [{ artifactId: prose.id, revisionId: prose.currentRevisionId!, number: 1, title: "Departure 1" }] });
    const frozen = await packages.verify(pkg.manifest.id);
    expect(await readFile(join(frozen.directory, pkg.manifest.chapters[0]!.packagePath))).toEqual(beforeBytes);
    const intent: FanqieIntent = { packageId: pkg.manifest.id, chapterNumber: 1, aiAssisted: true,
      scope: { sessionId: "fixture-tab", accountId: "fixture-account", accountLabel: "fixture-author", remoteBookId: "fixture-book" } };
    const snapshot: FanqieSnapshot = { scope: intent.scope, origin: "https://fanqienovel.com", blocker: "none",
      schedulingAvailable: true, complete: true, chapters: [] };
    const browser: FanqieBrowserPort = { snapshot: vi.fn(async () => structuredClone(snapshot)),
      createDraft: vi.fn(async () => { throw new Error("Fixture: lost response"); }), schedule: vi.fn() };
    expect((await new FanqiePublishingAdapter(packages, publishing, browser).saveDraft(intent)).phase).toBe("draft_unknown");
    for (const store of [episodes, publishing]) { store.close(); stores.splice(stores.indexOf(store), 1); }
    close(f.store);
    const goals = open(f.root);
    episodes = new CreativeEpisodeStore(dbPath); stores.push(episodes);
    publishing = new PublishingStore(dbPath); stores.push(publishing);
    packages = new ManualPublishingAdapter(f.root, publishing);
    expect(goals.get("goal").status).toBe("completed");
    expect(goals.events("goal")).toEqual(goalEvents);
    expect(episodes.requireEpisode("combined-episode").status).toBe("completed");
    expect(episodes.listEvents("combined-episode")).toEqual(episodeEvents);
    expect((await new FanqiePublishingAdapter(packages, publishing, browser).saveDraft(intent)).phase).toBe("draft_unknown");
    expect(browser.createDraft).toHaveBeenCalledTimes(1);
    expect(browser.schedule).not.toHaveBeenCalled();
    expect(publishing.getPackage(pkg.manifest.id).remoteVerified).toBe(false);
    expect(publishing.getPackage(pkg.manifest.id).chapters[0]!.provenance).toBeNull();
  }, 30000);

  it("keeps an accepted goal receipt fenced when replay changes its checkpoint", async () => {
    const f = await setup(2); f.create(); start(f.store);
    const execute = f.adapter.execute;
    f.adapter.execute = async context => { await execute(context); f.store.requestStop("goal", "paused", f.store.get("goal").version); };
    const executor = new GoalExecutor(f.store, [f.adapter], 0);
    expect((await executor.run("goal")).status).toBe("paused");
    const accepted = f.store.get("goal").steps[0]!.receipt;
    expect(accepted).not.toBeNull();
    await saveRuntimeStateSnapshot(f.bookDir,
      await loadRuntimeStateSnapshotAtChapter({ bookDir: f.bookDir, chapterNumber: 0, language: "en" }));
    const plan = await prepareStateReplay({ projectRoot: f.root, bookId: "novel", baselineChapter: 0,
      createWorkers: () => ({ writer: { settleChapterState: async input => {
        const result = await output(input.bookDir, input.chapterNumber);
        return { ...result, content: input.content, title: input.title, runtimeStateDelta: { ...result.runtimeStateDelta,
          chapterSummary: { ...result.runtimeStateDelta.chapterSummary!, events: "A fixture correction to the accepted summary." } } };
      } }, validator: { validate: async () => ({ consistent: true, reconciliationRequired: false, observations: [] }) } }) });
    await commitStateReplay({ projectRoot: f.root, plan, expectedPlanId: stateReplayPlanId(plan) });
    f.adapter.execute = execute; start(f.store);
    const result = await executor.run("goal");
    expect(result.status).toBe("reconciliation_required");
    expect(result.error?.code).toBe("CHAPTER_CHECKPOINT_CHANGED");
    expect(result.steps[0]!.receipt).toEqual(accepted);
    expect(f.write.mock.calls.map(([input]) => input.chapterNumber)).toEqual([1]);
    expect((await f.state.loadChapterIndex("novel")).map(chapter => chapter.number)).toEqual([1]);
  }, 30000);

  it("rechecks a repaired Work registry without regenerating saved prose", async () => {
    const f = await setup(1); await f.save(1); f.create(); start(f.store);
    const executor = new GoalExecutor(f.store, [f.adapter]);
    const pending = await executor.run("goal");
    expect(pending.error?.code).toBe("CHAPTER_REGISTRY_UNCONFIRMED");
    expect(pending.status).toBe("reconciliation_required");
    await syncWorkSourceArtifacts({ projectRoot: f.root, workId: "novel", accept: true });
    start(f.store); expect((await executor.run("goal")).status).toBe("completed");
    expect(f.write).not.toHaveBeenCalled(); expect(f.store.get("goal").attempts).toBe(0);
  });

  it("blocks missing checkpoints and unindexed source files before any generation", async () => {
    const f = await setup(); await f.save(1);
    await syncWorkSourceArtifacts({ projectRoot: f.root, workId: "novel", accept: true });
    await rm(join(f.bookDir, "story/snapshots/1/state/manifest.json"));
    f.create(); start(f.store);
    expect((await new GoalExecutor(f.store, [f.adapter]).run("goal")).status).toBe("reconciliation_required");
    await writeFile(join(f.bookDir, "chapters/0002_unindexed.md"), "Retain this draft.");
    start(f.store);
    expect((await new GoalExecutor(f.store, [f.adapter]).run("goal")).error?.code).toBe("CHAPTER_EXPORT_SOURCE_MISMATCH");
    expect(f.write).not.toHaveBeenCalled();
  });

  it("protects accepted prose from changes before continuing the next chapter", async () => {
    const f = await setup(); f.create(); start(f.store);
    const execute = f.adapter.execute;
    f.adapter.execute = async context => { await execute(context); f.store.requestStop("goal", "paused", f.store.get("goal").version); };
    const paused = await new GoalExecutor(f.store, [f.adapter]).run("goal");
    expect(paused.status, JSON.stringify(paused.error)).toBe("paused");
    expect(f.write).toHaveBeenCalledTimes(1);
    await writeFile(join(f.bookDir, "chapters/0001_Departure_1.md"), "An author's new revision.");
    f.adapter.execute = execute; start(f.store);
    const result = await new GoalExecutor(f.store, [f.adapter]).run("goal");
    expect(result.status).toBe("reconciliation_required"); expect(result.error?.code).toBe("CHAPTER_BASELINE_CHANGED");
    expect(f.write).toHaveBeenCalledTimes(1);
  }, 15000);
});
