import { afterEach, describe, expect, it, vi } from "vitest";
const faults = vi.hoisted(() => ({ destination: "" }));
vi.mock("node:fs/promises", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, rename: async (from: string, to: string) => {
    if (faults.destination && to === faults.destination && /[\\/]staged[\\/]/.test(from)) {
      faults.destination = "";
      throw new Error("injected file commit failure");
    }
    return fs.rename(from, to);
  } };
});
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, cp, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StateManager } from "../state/manager.js";
import { createInitialRuntimeState, loadRuntimeStateSnapshot, loadRuntimeStateSnapshotAtChapter, saveRuntimeStateSnapshot } from "../state/runtime-state-store.js";
import { applyRuntimeStateDelta } from "../state/state-reducer.js";
import { prepareStateReplay, commitStateReplay, stateReplayPlanId, type StateReplayWorkers } from "../state/state-replay.js";
import type { RuntimeStateDelta } from "../models/runtime-state.js";
import type { ChapterMeta } from "../models/chapter.js";
import { WriterAgent, type WriteChapterOutput } from "../agents/writer.js";
import { StateValidatorAgent } from "../agents/state-validator.js";
import { PipelineRunner } from "../pipeline/runner.js";
import { loadWorkManifest } from "../harness/work-store.js";

const roots: string[] = [];
const bookId = "replay-book";
const now = "2026-10-02T00:00:00.000Z";
afterEach(async () => { vi.restoreAllMocks(); faults.destination = ""; await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
function delta(chapter: number): RuntimeStateDelta {
  return { chapter, factOps: { upsert: [{ subject: "Lin", predicate: "location", object: `room-${chapter}` }], expire: [] },
    hookOps: { upsert: [], mention: [], resolve: [], defer: [] }, newHookCandidates: [],
    chapterSummary: { chapter, title: `Chapter ${chapter}`, characters: "Lin", events: `Entered room ${chapter}`,
      stateChanges: "location", hookActivity: "", mood: "quiet", chapterType: "scene" } };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "inkos-replay-test-")); roots.push(root);
  const state = new StateManager(root), bookDir = state.bookDir(bookId);
  await state.saveBookConfig(bookId, { id: bookId, title: "Replay", platform: "local", genre: "mystery", status: "active",
    targetChapters: 50, chapterWordCount: 100, language: "en", createdAt: now, updatedAt: now });
  let snapshot = await createInitialRuntimeState({ bookDir, language: "en" });
  for (let chapter = 1; chapter <= 27; chapter++) snapshot = applyRuntimeStateDelta({ snapshot, delta: delta(chapter) });
  await saveRuntimeStateSnapshot(bookDir, snapshot);
  await state.snapshotState(bookId, 27);
  await mkdir(join(bookDir, "story/outline"), { recursive: true });
  await writeFile(join(bookDir, "story/outline/story_frame.md"), "Lin is an archivist.");
  await writeFile(join(bookDir, "story/book_rules.md"), "Respect the existing chapter body.");
  await mkdir(join(bookDir, "chapters"), { recursive: true });
  const index: ChapterMeta[] = [];
  for (let number = 1; number <= 30; number++) {
    await writeFile(join(bookDir, `chapters/${String(number).padStart(4, "0")}_chapter.md`), `# Chapter ${number}\r\n\r\nLin entered room ${number}.  \r\n`);
    index.push({ number, title: `Chapter ${number}`, wordCount: 20, createdAt: now, updatedAt: now, provenance: "generated",
      observations: number > 27 ? [
        { code: "state-validation-unavailable", summary: "Earlier unavailable validator", evidence: [] },
        { code: "quality-review", summary: "Keep this unrelated observation", evidence: ["slow scene"] },
        { code: "state-validation", summary: "Different prose revision", evidence: [], targetHash: "other-revision" },
      ] : [] });
  }
  await state.saveChapterIndex(bookId, index);
  // Deliberately reproduce old mislabeled snapshots: directory 28/29/30 contains chapter 27 state.
  for (const chapter of [28, 29, 30]) await cp(join(bookDir, "story/snapshots/27"), join(bookDir, `story/snapshots/${chapter}`), { recursive: true });
  return { root, state, bookDir, index };
}
async function tree(root: string, prefix = ""): Promise<Record<string, Buffer>> {
  const result: Record<string, Buffer> = {};
  for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === ".write.lock" || entry.name.startsWith(".write.lock.guard.sqlite")) continue;
    const path = join(root, entry.name), key = join(prefix, entry.name);
    if (entry.isDirectory()) Object.assign(result, await tree(path, key)); else result[key] = await readFile(path);
  }
  return result;
}
function workers() {
  const calls: number[] = [], isolatedRoots: string[] = [];
  const settleChapterState = vi.fn<StateReplayWorkers["writer"]["settleChapterState"]>(async input => {
    calls.push(input.chapterNumber);
    const prior = await loadRuntimeStateSnapshotAtChapter({ bookDir: input.bookDir, chapterNumber: input.baselineChapter!, language: "en" });
    expect(prior.manifest.lastAppliedChapter).toBe(input.chapterNumber - 1);
    const canonical = await loadRuntimeStateSnapshot(input.bookDir);
    expect(canonical).toEqual(prior);
    expect(input.contextPackage.selectedContext.at(-1)!.excerpt).not.toContain(`Entered room ${input.chapterNumber}`);
    // Only the typed delta is authoritative. These intentionally bogus worker projections must not be used.
    return { chapterNumber: input.chapterNumber, content: input.content, title: input.title, runtimeStateDelta: delta(input.chapterNumber),
      updatedState: "BOGUS", updatedHooks: "BOGUS", updatedChapterSummaries: "BOGUS", runtimeStateSnapshot: prior,
      wordCount: 999, runtimeStateApplied: true, postSettlement: "fixture" } satisfies WriteChapterOutput;
  });
  const validate = vi.fn<StateReplayWorkers["validator"]["validate"]>(async (content, chapter, oldState, newState) => {
    expect(content).toContain(`room ${chapter}`);
    expect(oldState).toContain(`room-${chapter - 1}`);
    expect(newState).toContain(`room-${chapter}`);
    return { consistent: true, reconciliationRequired: false, observations: [{ code: "state-projection-review", summary: `Checked chapter ${chapter}`, evidence: [] }] };
  });
  return { calls, isolatedRoots, settleChapterState, validate, createWorkers: (root: string) => {
    isolatedRoots.push(root); return { writer: { settleChapterState }, validator: { validate } };
  } };
}

 describe("safe existing-prose state replay", () => {
  it("dry-runs 28→29→30 from 27, then atomically commits only derived state and exact observations", async () => {
    const f = await fixture(), w = workers(), before = await tree(f.root);
    const plan = await prepareStateReplay({ projectRoot: f.root, bookId, baselineChapter: 27, createWorkers: w.createWorkers });
    expect(w.calls).toEqual([28, 29, 30]);
    expect(await tree(f.root)).toEqual(before);
    await expect(readdir(w.isolatedRoots[0]!)).rejects.toMatchObject({ code: "ENOENT" });
    const result = await commitStateReplay({ projectRoot: f.root, plan, expectedPlanId: stateReplayPlanId(plan) });
    expect(result).toMatchObject({ committed: true, baselineChapter: 27, targetChapter: 30 });
    expect(w.calls).toEqual([28, 29, 30]); // Commit invokes no model.
    expect((await loadRuntimeStateSnapshot(f.bookDir)).manifest.lastAppliedChapter).toBe(30);
    const after = await tree(f.root);
    const proseBefore = Object.entries(before).filter(([path]) => /source[\\/]chapters[\\/]\d+_.*\.md$/.test(path));
    expect(proseBefore).toHaveLength(30);
    for (const [path, bytes] of proseBefore) expect(after[path]).toEqual(bytes);
    for (const chapter of [28, 29, 30]) {
      const snapshot = await loadRuntimeStateSnapshotAtChapter({ bookDir: f.bookDir, chapterNumber: chapter, language: "en" });
      expect(snapshot.manifest.lastAppliedChapter).toBe(chapter);
      expect(snapshot.chapterSummaries.rows.at(-1)!.chapter).toBe(chapter);
    }
    const index = await f.state.loadChapterIndex(bookId);
    expect(index.slice(0, 27)).toEqual(f.index.slice(0, 27));
    for (const meta of index.slice(27)) {
      expect({ ...meta, observations: [] }).toEqual({ ...f.index[meta.number - 1], observations: [] });
      expect(meta.observations.map(o => o.code)).toEqual(["quality-review", "state-projection-review"]);
      expect(meta.observations.at(-1)!.scope).toBe(`chapter:${meta.number}`);
    }
    const manifest = await loadWorkManifest(f.root, bookId);
    const stateArtifact = manifest.artifacts.find(a => a.revisions.some(r => r.path === "source/story/state/manifest.json"))!;
    const stateRevision = stateArtifact.revisions.find(r => r.id === stateArtifact.currentRevisionId)!;
    expect(await readFile(join(f.root, "works", bookId, stateRevision.snapshotPath!)))
      .toEqual(await readFile(join(f.bookDir, "story/state/manifest.json")));
    await expect(commitStateReplay({ projectRoot: f.root, plan, expectedPlanId: stateReplayPlanId(plan) })).rejects.toMatchObject({ code: "STATE_REPLAY_VERSION_CHANGED" });
  });
  it.each(["reconciliation", "unavailable", "settlement", "prose", "cancel"])("stops at chapter 29 for %s with no live changes", async kind => {
    const f = await fixture(), w = workers(), before = await tree(f.root), controller = new AbortController();
    const original = w.settleChapterState.getMockImplementation()!;
    w.settleChapterState.mockImplementation(async input => {
      const output = await original(input);
      if (input.chapterNumber !== 29) return output;
      if (kind === "settlement") throw new Error("settler unavailable");
      if (kind === "prose") return { ...output, content: "new story" };
      if (kind === "cancel") controller.abort();
      return output;
    });
    w.validate.mockImplementation(async (_, chapter) => {
      if (chapter === 29 && kind === "unavailable") throw new Error("validator unavailable");
      return { consistent: !(chapter === 29 && kind === "reconciliation"), reconciliationRequired: chapter === 29 && kind === "reconciliation", observations: [] };
    });
    await expect(prepareStateReplay({ projectRoot: f.root, bookId, baselineChapter: 27, createWorkers: w.createWorkers, signal: controller.signal })).rejects.toThrow();
    expect(w.calls).toEqual([28, 29]); expect(await tree(f.root)).toEqual(before);
    await expect(readdir(w.isolatedRoots[0]!)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each(["prose", "canonical", "index", "new-chapter"])("rejects a %s version change after dry run", async kind => {
    const f = await fixture(), w = workers();
    const plan = await prepareStateReplay({ projectRoot: f.root, bookId, baselineChapter: 27, createWorkers: w.createWorkers });
    const paths = { prose: join(f.bookDir, "chapters/0028_chapter.md"), canonical: join(f.bookDir, "story/state/manifest.json"),
      index: join(f.bookDir, "chapters/index.json"), "new-chapter": join(f.bookDir, "chapters/0031_chapter.md") };
    await writeFile(paths[kind as keyof typeof paths], "changed");
    const before = await tree(f.root);
    await expect(commitStateReplay({ projectRoot: f.root, plan, expectedPlanId: stateReplayPlanId(plan) })).rejects.toThrow();
    expect(await tree(f.root)).toEqual(before);
  });
  it("stops before chapter 30 when the host-reduced chapter 29 summary is rejected", async () => {
    const f = await fixture(), w = workers(), before = await tree(f.root);
    const original = w.settleChapterState.getMockImplementation()!;
    w.settleChapterState.mockImplementation(async input => {
      const output = await original(input);
      if (input.chapterNumber !== 29) return output;
      return { ...output, runtimeStateDelta: { ...output.runtimeStateDelta,
        chapterSummary: { ...output.runtimeStateDelta.chapterSummary!, events: "UNSUPPORTED_SUMMARY_Lin_burns_archive" } } };
    });
    w.validate.mockImplementation(async (_body, chapter, _oldState, _newState, _oldHooks, _newHooks, _language, authority, candidate) => {
      expect(candidate?.chapterSummary?.chapter).toBe(chapter);
      expect(authority?.chapterSummaries).not.toContain("UNSUPPORTED_SUMMARY_Lin_burns_archive");
      const invalid = candidate!.chapterSummary!.events.includes("UNSUPPORTED_SUMMARY");
      return { consistent: !invalid, reconciliationRequired: invalid,
        observations: invalid ? [{ code: "state-reconciliation", summary: "Summary invents burning the archive", evidence: [] }] : [] };
    });
    await expect(prepareStateReplay({ projectRoot: f.root, bookId, baselineChapter: 27, createWorkers: w.createWorkers })).rejects.toMatchObject({ code: "STATE_REPLAY_VALIDATION_FAILED" });
    expect(w.calls).toEqual([28, 29]); expect(await tree(f.root)).toEqual(before);
  });
  it.each(["story/outline/story_frame.md", "story/book_rules.md"])("preserves the existing contract for blank authority %s", async path => {
    const f = await fixture(), w = workers(); await writeFile(join(f.bookDir, path), " \n\t");
    const before = await tree(f.root);
    const plan = await prepareStateReplay({ projectRoot: f.root, bookId, baselineChapter: 27, createWorkers: w.createWorkers });
    expect(plan.targetChapter).toBe(30); expect(w.calls).toEqual([28, 29, 30]); expect(await tree(f.root)).toEqual(before);
  });
  it("rejects legacy plans whose summaries were not included in validation", async () => {
    const f = await fixture(), w = workers();
    const plan = await prepareStateReplay({ projectRoot: f.root, bookId, baselineChapter: 27, createWorkers: w.createWorkers });
    const before = await tree(f.root);
    expect(plan.version).toBe(3);
    await expect(commitStateReplay({ projectRoot: f.root, plan: { ...plan, version: 1 }, expectedPlanId: stateReplayPlanId(plan) })).rejects.toThrow();
    expect(await tree(f.root)).toEqual(before);
  });
  it("rolls the whole live file set back if the atomic commit fails midway", async () => {
    const f = await fixture(), w = workers();
    const plan = await prepareStateReplay({ projectRoot: f.root, bookId, baselineChapter: 27, createWorkers: w.createWorkers });
    const before = await tree(f.root);
    faults.destination = join(f.bookDir, "story/state/hooks.json");
    await expect(commitStateReplay({ projectRoot: f.root, plan, expectedPlanId: stateReplayPlanId(plan) })).rejects.toThrow("injected");
    expect(faults.destination).toBe("");
    expect(await tree(f.root)).toEqual(before);
  });
  it("does not trust a snapshot directory named 27 whose manifest is 26", async () => {
    const f = await fixture(), w = workers();
    const path = join(f.bookDir, "story/snapshots/27/state/manifest.json");
    const manifest = JSON.parse(await readFile(path, "utf8")); manifest.lastAppliedChapter = 26; await writeFile(path, JSON.stringify(manifest));
    await expect(prepareStateReplay({ projectRoot: f.root, bookId, baselineChapter: 27, createWorkers: w.createWorkers })).rejects.toThrow();
    expect(w.calls).toEqual([]);
  });
  it.each(["missing", "duplicate", "unindexed"])("rejects %s prose before model calls", async kind => {
    const f = await fixture(), w = workers();
    if (kind === "missing") await rm(join(f.bookDir, "chapters/0029_chapter.md"));
    else await writeFile(join(f.bookDir, kind === "duplicate" ? "chapters/0029_duplicate.md" : "chapters/0031_unindexed.md"), "body");
    const before = await tree(f.root);
    await expect(prepareStateReplay({ projectRoot: f.root, bookId, baselineChapter: 27, createWorkers: w.createWorkers })).rejects.toThrow();
    expect(w.calls).toEqual([]); expect(await tree(f.root)).toEqual(before);
  });
  it("rejects a selected plan whose delta skips a chapter", async () => {
    const f = await fixture(), w = workers();
    const plan = await prepareStateReplay({ projectRoot: f.root, bookId, baselineChapter: 27, createWorkers: w.createWorkers });
    const before = await tree(f.root);
    plan.chapters[0].delta.chapter = 31;
    await expect(commitStateReplay({ projectRoot: f.root, plan, expectedPlanId: stateReplayPlanId(plan) })).rejects.toMatchObject({ code: "STATE_REPLAY_CHAPTER_GAP" });
    expect(await tree(f.root)).toEqual(before);
  });
  it("refuses active work and starts no worker", async () => {
    const f = await fixture(), w = workers(), release = await f.state.acquireBookLock(bookId);
    try {
      await expect(prepareStateReplay({ projectRoot: f.root, bookId, baselineChapter: 27, createWorkers: w.createWorkers })).rejects.toMatchObject({ code: "BOOK_BUSY" });
      expect(w.calls).toEqual([]);
    } finally { await release(); }
  });
  it("detects a live out-of-band edit during dry run", async () => {
    const f = await fixture(), w = workers();
    const validate = w.validate.getMockImplementation()!;
    w.validate.mockImplementation(async (...args) => {
      if (args[1] === 30) await writeFile(join(f.bookDir, "chapters/0030_chapter.md"), "user's concurrent edit");
      return validate(...args);
    });
    await expect(prepareStateReplay({ projectRoot: f.root, bookId, baselineChapter: 27, createWorkers: w.createWorkers })).rejects.toMatchObject({ code: "STATE_REPLAY_VERSION_CHANGED" });
    expect((await loadRuntimeStateSnapshot(f.bookDir)).manifest.lastAppliedChapter).toBe(27);
    expect(await readFile(join(f.bookDir, "chapters/0030_chapter.md"), "utf8")).toBe("user's concurrent edit");
  });
  it.each(["revisions", "work.json"])("rejects a linked %s path after dry run without writing outside the Work", async name => {
    const f = await fixture(), w = workers();
    const plan = await prepareStateReplay({ projectRoot: f.root, bookId, baselineChapter: 27, createWorkers: w.createWorkers });
    const external = await mkdtemp(join(tmpdir(), "inkos-replay-external-")); roots.push(external);
    const path = join(f.root, "works", bookId, name);
    if (name === "work.json") await cp(path, join(external, "manifest.json"));
    await rm(path, { recursive: true, force: true });
    await symlink(name === "work.json" ? join(external, "manifest.json") : external, path);
    const before = await tree(external);
    await expect(commitStateReplay({ projectRoot: f.root, plan, expectedPlanId: stateReplayPlanId(plan) })).rejects.toMatchObject({ code: "STATE_REPLAY_UNSAFE_SOURCE" });
    expect(await tree(external)).toEqual(before);
  });
  it("rejects symlinked source inputs rather than copying or following them", async () => {
    const f = await fixture(), w = workers();
    await symlink(join(f.bookDir, "chapters/0028_chapter.md"), join(f.bookDir, "story/alias.md"));
    await expect(prepareStateReplay({ projectRoot: f.root, bookId, baselineChapter: 27, createWorkers: w.createWorkers })).rejects.toMatchObject({ code: "STATE_REPLAY_UNSAFE_SOURCE" });
    expect(w.calls).toEqual([]);
  });
  it('rebuilds an edited old chapter through all retained successors from a real checkpoint', async () => {
    const f = await fixture(), w = workers();
    let current = await loadRuntimeStateSnapshot(f.bookDir);
    for (const number of [28, 29, 30]) current = applyRuntimeStateDelta({snapshot: current, delta: delta(number)});
    await saveRuntimeStateSnapshot(f.bookDir, current);
    const index = await f.state.loadChapterIndex(bookId);
    index[27]!.observations.push({code:'state-sync-required',summary:'Edited existing chapter',evidence:[]});
    await f.state.saveChapterIndex(bookId,index);
    const body = await readFile(join(f.bookDir,'chapters/0028_chapter.md'));
    const controller = new AbortController();
    const settle = vi.spyOn(WriterAgent.prototype,'settleChapterState').mockImplementation(w.settleChapterState);
    vi.spyOn(StateValidatorAgent.prototype,'validate').mockImplementation(w.validate);
    const logStage = vi.fn();
    const invoke = PipelineRunner.prototype as unknown as {reconcileEditedChaptersForWrite(id:string):Promise<void>};
    const receiver = {state:f.state,config:{projectRoot:f.root},operationContext:{getStore:()=>({stateRecoveryRange:{startChapter:28,endChapter:30}})},
      currentAbortSignal:()=>controller.signal,resolveBookLanguageById:async()=> 'en',logStage,
      agentCtxFor:()=>({signal:controller.signal,projectRoot:f.root})};
    const release = await f.state.acquireBookLock(bookId);
    try { await invoke.reconcileEditedChaptersForWrite.call(receiver,bookId); } finally { await release(); }
    expect(settle).toHaveBeenCalledTimes(3);
    expect(w.calls).toEqual([28,29,30]);
    expect(logStage.mock.calls[0]![1].en).toContain('28–30');
    expect((await loadRuntimeStateSnapshot(f.bookDir)).manifest.lastAppliedChapter).toBe(30);
    expect((await f.state.loadChapterIndex(bookId))[27]!.observations.some(o=>o.code==='state-sync-required')).toBe(false);
    expect(await readFile(join(f.bookDir,'chapters/0028_chapter.md'))).toEqual(body);
  });
  it.each(['range','aborted','missing-baseline','validator'] as const)('keeps live state when scoped recovery cannot finish: %s',async kind=>{
    const f=await fixture(),w=workers(),controller=new AbortController();
    const index=await f.state.loadChapterIndex(bookId);index[27]!.observations.push({code:'state-sync-required',summary:'Edited',evidence:[]});
    await f.state.saveChapterIndex(bookId,index);
    if(kind==='missing-baseline')await rm(join(f.bookDir,'story/snapshots/27'),{recursive:true});
    if(kind==='aborted')controller.abort();
    const before=await tree(f.root);
    const settle=vi.spyOn(WriterAgent.prototype,'settleChapterState').mockImplementation(w.settleChapterState);
    vi.spyOn(StateValidatorAgent.prototype,'validate').mockImplementation(kind==='validator'?async()=>({consistent:false,reconciliationRequired:true,observations:[]}):w.validate);
    const invoke=PipelineRunner.prototype as unknown as {reconcileEditedChaptersForWrite(id:string):Promise<void>};
    const receiver={state:f.state,config:{projectRoot:f.root},operationContext:{getStore:()=>({stateRecoveryRange:{startChapter:28,endChapter:kind==='range'?29:30}})},
      currentAbortSignal:()=>controller.signal,resolveBookLanguageById:async()=> 'en',logStage:vi.fn(),agentCtxFor:()=>({signal:controller.signal,projectRoot:f.root})};
    const release=await f.state.acquireBookLock(bookId);
    try{await expect(invoke.reconcileEditedChaptersForWrite.call(receiver,bookId)).rejects.toThrow();}finally{await release();}
    expect(settle).toHaveBeenCalledTimes(kind==='validator'?1:0);
    expect(await tree(f.root)).toEqual(before);
  });

});
