import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { StateValidatorAgent } from "../agents/state-validator.js";
import { ReviserAgent } from "../agents/reviser.js";
import { GoalStore } from "../goals/store.js";
import { GoalExecutor } from "../goals/executor.js";
import { chapterGoalInput, createChapterGoalAdapter } from "../goals/chapters.js";
import { ChapterGoalService } from "../goals/service.js";
import { AutonomousChapterRunner, type SchedulerPublisher } from "../pipeline/autonomous-chapters.js";
import { SchedulerStore, type ScheduledChapter } from "../pipeline/scheduler-store.js";
import { loadRuntimeStateSnapshotAtChapter } from "../state/runtime-state-store.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderChapterDocument } from "../utils/chapter-document.js";
import { PipelineRunner } from "../pipeline/runner.js";
import { StateManager } from "../state/manager.js";
import { createInitialRuntimeState, loadRuntimeStateSnapshot } from "../state/runtime-state-store.js";
import { createWorkManifest, loadWorkManifest, saveWorkManifest } from "../harness/work-store.js";
import { savePersistedPlan } from "../pipeline/persisted-governed-plan.js";
import type { BookConfig } from "../models/book.js";
import type { LLMClient } from "../llm/provider.js";

const mock = vi.hoisted(() => ({ tool: vi.fn(), text: vi.fn() }));
// No native account/session is opened: only admission is replaced, while the
// runner's abort context, real worker-independent persistence and Goal scopes remain.
vi.mock("../runtime/execution.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../runtime/execution.js")>();
  return { ...actual, withRuntimeExecution: async <T>(_root: string, task: () => Promise<T>, options: { signal?: AbortSignal } = {}) => {
    options.signal?.throwIfAborted(); return task();
  } };
});
vi.mock("../agent/worker-agent.js", () => ({ runWorkerAgentTool: mock.tool, runWorkerAgent: mock.text }));
const client: LLMClient = { provider: "openai", apiFormat: "responses", stream: true,
  defaults: { temperature: 0, maxTokens: 16384, thinkingBudget: 0, extra: {} }, _codex: { projectRoot: "/fixture" } };
const roots: string[] = [];
const usage = { promptTokens: 10, completionTokens: 20, totalTokens: 30 };
const prose = "Mara returns the sealed receipt to its owner. The witness closes the door.";
let settleFailures = 0, draftCount = 0;
let onDraft: (() => void | Promise<void>) | undefined;
let onSettle: (() => void | Promise<void>) | undefined;
let onValidate: (() => void | { reconciliationRequired: boolean; reportMarkdown: string } | Promise<void | { reconciliationRequired: boolean; reportMarkdown: string }>) | undefined;

// These citations pass the actual source resolver and contract validators for
// both draft and retained-chapter review; no review method is stubbed.
function sourcedRecoveryReview(toolName: string, messages: ReadonlyArray<{ role: string; content: string }>) {
  const prompt = JSON.parse([...messages].reverse().find(message => message.role === "user")!.content);
  const source = (id: string) => prompt.sources.find((item: { sourceId: string }) => item.sourceId === id)?.numberedLines;
  const memo = source("chapter-contract-source");
  if (!["1\tgoal=Return the receipt | Keep it sealed.", "1\tgoal=Return the receipt\n2\tKeep it sealed."].includes(memo)) {
    throw new Error("Recovery review must classify the actual retained chapter memo.");
  }
  const ref = (sourceId: string, line = 1) => ({ sourceId, startLine: line, endLine: line });
  if (toolName === "submit_chapter_contract") {
    if (source("chapter-1") !== undefined) throw new Error("Contract classification must not see draft prose.");
    return { summary: "The retained memo requires return and prohibits breaking the seal.", observations: [
      { code: "required-event", assessment: "observation", summary: "Return the receipt.", sourceRefs: [ref("chapter-contract-source")] },
      { code: "prohibition", assessment: "observation", summary: "Do not break the seal.", sourceRefs: [ref("chapter-contract-source", memo.includes("\n") ? 2 : 1)] },
    ] };
  }
  if (!source("chapter-1")?.startsWith("1\tMara returns the sealed receipt to its owner. The witness closes the door.")) {
    throw new Error("Recovery review must inspect the actual current draft.");
  }
  if (JSON.stringify(prompt.chapterContract?.requirements.map((item: { code: string }) => item.code)) !== JSON.stringify(["chapter-contract-1", "chapter-contract-2"])) {
    throw new Error("Recovery review must cover both retained requirements.");
  }
  return { summary: "The current body returns the receipt without breaking its seal.", observations: [
    { code: "chapter-contract-inventory", category: "quality", assessment: "observation", summary: "Both original requirements are retained.", sourceRefs: [ref("chapter-contract-source")] },
    ...["chapter-contract-1", "chapter-contract-2"].map(code => ({ code, category: "quality", assessment: "observation",
      summary: "The current body returns the still-sealed receipt.", sourceRefs: [ref(code), ref("chapter-1")] })),
  ] };
}

beforeEach(() => {
  settleFailures = 0; draftCount = 0; onDraft = onSettle = onValidate = undefined;
  mock.tool.mockReset(); mock.text.mockReset();
  mock.text.mockImplementation(() => { throw new Error("Unexpected text model call in offline fixture"); });
  mock.tool.mockImplementation(async (_client, _model, _messages, tool, options) => {
    options.onUsage?.(usage);
    if (tool.name === "submit_chapter_memo") return { goal: "Return the receipt", body: "Keep it sealed.", threadRefs: [] };
    if (tool.name === "submit_chapter_draft") { draftCount++; await onDraft?.(); return { title: "Receipt", content: `${prose}${draftCount > 1 ? ` Attempt ${draftCount}.` : ""}` }; }
    if (tool.name === "submit_runtime_state_delta") {
      await onSettle?.();
      if (settleFailures-- > 0) throw new Error("Fixture interrupted settlement");
      return { postSettlement: "Receipt returned.", factOps: { upsert: [{ subject: "receipt", predicate: "owner", object: "Mara's client" }], expire: [] },
        hookOps: { upsert: [], mention: [], resolve: [], defer: [] }, newHookCandidates: [],
        chapterSummary: { title: "Receipt", characters: "Mara", events: "Receipt returned.", stateChanges: "", hookActivity: "", mood: "quiet", chapterType: "scene" } };
    }
    if (["submit_chapter_contract", "submit_chapter_review"].includes(tool.name)) return sourcedRecoveryReview(tool.name, _messages);
    if (tool.name === "submit_state_validation") { return await onValidate?.() ?? { reconciliationRequired: false, reportMarkdown: "" }; }
    throw new Error(`Unexpected offline tool ${tool.name}`);
  });
});
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "inkos-transient-flow-")); roots.push(root);
  const state = new StateManager(root), bookDir = state.bookDir("novel"), now = "2026-10-08T00:00:00.000Z";
  const book: BookConfig = { id: "novel", title: "Receipt", genre: "general", platform: "other", status: "active" as const,
    targetChapters: 2, chapterWordCount: 20, language: "en" as const, createdAt: now, updatedAt: now };
  await saveWorkManifest(root, createWorkManifest({ id: book.id, title: book.title, profileId: "longform-novel", language: "en" }));
  await state.saveBookConfig(book.id, book);
  await mkdir(join(bookDir, "story/outline"), { recursive: true });
  await mkdir(join(bookDir, "story/runtime"), { recursive: true });
  for (const [file, content] of Object.entries({ "outline/story_frame.md": "Mara returns the sealed receipt.", "outline/volume_map.md": "One delivery.",
    "book_rules.md": "# Rules\nKeep the receipt sealed.", "book_rules.json": JSON.stringify({ version: "2", prohibitions: [], enableFullCastTracking: false, allowedDeviations: [] }) })) await writeFile(join(bookDir, "story", file), content);
  await createInitialRuntimeState({ bookDir, language: "en" }); await state.snapshotState("novel", 0); await state.saveChapterIndex(book.id, []);
  await savePersistedPlan(bookDir, { intent: { chapter: 1, goal: "Return the receipt" }, memo: { chapter: 1, goal: "Return the receipt", body: "Keep it sealed.", threadRefs: [] },
    intentMarkdown: "Return the receipt", plannerInputs: [], runtimePath: "unused" });
  const runner = () => new PipelineRunner({ projectRoot: root, client, model: "fixture" });
  const checkpointDir = join(root, ".inkos/unsettled-drafts/novel"), checkpointPath = join(checkpointDir, "chapter-0001.json");
  const write = (instruction?: string) => runner().writeChapters(book.id, 1, { startChapterNumber: 1, externalContext: instruction });
  return { root, state, bookDir, book, runner, checkpointDir, checkpointPath, write };
}
const calls = (name: string) => mock.tool.mock.calls.filter(call => call[3].name === name);
async function noAcceptedChapter(f: Awaited<ReturnType<typeof fixture>>) {
  expect(await f.state.loadChapterIndex("novel")).toEqual([]);
  expect((await loadRuntimeStateSnapshot(f.bookDir)).manifest.lastAppliedChapter).toBe(0);
  expect((await readdir(join(f.bookDir, "chapters"))).filter(file => file.endsWith(".md"))).toEqual([]);
  expect((await loadWorkManifest(f.root, "novel")).artifacts.filter(artifact => artifact.kind === "chapter" && artifact.currentRevisionId)).toEqual([]);
}

const providerFailure = (code: string) => Object.assign(new Error(`Synthetic validator ${code}`), { code });
const mismatch = { reconciliationRequired: true, reportMarkdown: "The proposed receipt owner contradicts Mara returning it to the client." };
async function acceptedOnce(f: Awaited<ReturnType<typeof fixture>>) {
  expect(draftCount).toBe(1);
  const index = await f.state.loadChapterIndex("novel"); expect(index).toHaveLength(1);
  const files = (await readdir(join(f.bookDir, "chapters"))).filter(file => file.endsWith(".md")); expect(files).toHaveLength(1);
  expect(await readFile(join(f.bookDir, "chapters", files[0]), "utf8")).toBe(renderChapterDocument(1, "Receipt", prose, "en"));
  const snapshot = await loadRuntimeStateSnapshot(f.bookDir);
  expect(snapshot.manifest.lastAppliedChapter).toBe(1); expect(snapshot.currentState.facts).toHaveLength(1);
  expect(snapshot.hooks.hooks).toHaveLength(0); expect(snapshot.chapterSummaries.rows).toHaveLength(1);
  expect(await loadRuntimeStateSnapshotAtChapter({ bookDir: f.bookDir, chapterNumber: 1, language: "en" })).toEqual(snapshot);
  const chapters = (await loadWorkManifest(f.root, "novel")).artifacts.filter(a => a.kind === "chapter" && a.currentRevisionId);
  expect(chapters).toHaveLength(1); expect(chapters[0].revisions).toHaveLength(1);
  await expect(readFile(f.checkpointPath)).rejects.toMatchObject({ code: "ENOENT" });
}

describe("provider exceptions stop before chapter acceptance", () => {
  it.each(["initial", "retry"] as const)("retains the real complete draft when the %s validator fails, then reopens and accepts once", async stage => {
    const f = await fixture(), error = providerFailure(stage === "initial" ? "ECONNRESET" : "ETIMEDOUT");
    const baseline = await loadRuntimeStateSnapshot(f.bookDir);
    const validate = vi.spyOn(StateValidatorAgent.prototype, "validate");
    let validations = 0;
    onValidate = () => { validations++; if (stage === "retry" && validations === 1) return mismatch; throw error; };
    await expect(f.write()).rejects.toBe(error);
    expect(validations).toBe(stage === "initial" ? 1 : 2);
    expect(validate.mock.calls.every(call => call[2] !== call[3] || call[4] !== call[5])).toBe(true);
    await noAcceptedChapter(f); expect(await loadRuntimeStateSnapshot(f.bookDir)).toEqual(baseline);
    const saved = await readFile(f.checkpointPath, "utf8"); expect(JSON.parse(saved).draft.content).toBe(prose);
    expect(calls("submit_chapter_review")).toHaveLength(1);
    onValidate = undefined;
    const resumed = await f.write(); expect(resumed[0].title).toBe("Receipt");
    expect(calls("submit_runtime_state_delta")).toHaveLength(stage === "initial" ? 2 : 3);
    expect(calls("submit_chapter_review")).toHaveLength(2);
    await acceptedOnce(f);
  });

  it("preserves an existing accepted revision and checkpoint when retry validation fails before a revision save", async () => {
    const f = await fixture(); await f.write();
    const chapterFile = join(f.bookDir, "chapters", (await readdir(join(f.bookDir, "chapters"))).find(file => file.endsWith(".md"))!);
    const bytes = await readFile(chapterFile), index = await f.state.loadChapterIndex("novel"), work = await loadWorkManifest(f.root, "novel");
    const state = await loadRuntimeStateSnapshot(f.bookDir), checkpoint = await loadRuntimeStateSnapshotAtChapter({ bookDir: f.bookDir, chapterNumber: 1, language: "en" });
    vi.spyOn(ReviserAgent.prototype, "reviseChapter").mockResolvedValue({ revisedContent: prose + " Mara pauses by the gate.", wordCount: 19, tokenUsage: usage });
    let validations = 0; const error = providerFailure("ETIMEDOUT");
    onValidate = () => { if (++validations === 1) return mismatch; throw error; };
    await expect(f.runner().reviseDraft("novel", 1)).rejects.toBe(error);
    expect(validations).toBe(2); expect(await readFile(chapterFile)).toEqual(bytes);
    expect(await f.state.loadChapterIndex("novel")).toEqual(index);
    const after = await loadWorkManifest(f.root, "novel");
    expect(after.artifacts.filter(a => a.kind === "chapter")).toEqual(work.artifacts.filter(a => a.kind === "chapter"));
    expect(await loadRuntimeStateSnapshot(f.bookDir)).toEqual(state);
    expect(await loadRuntimeStateSnapshotAtChapter({ bookDir: f.bookDir, chapterNumber: 1, language: "en" })).toEqual(checkpoint);
  });
});

async function schedulerFixture() {
  const f = await fixture(), path = join(f.root, ".inkos/harness.sqlite");
  let store = new SchedulerStore(path), clock = Date.now(), continuing = true;
  const publisher: SchedulerPublisher = {
    ready: vi.fn(async () => {}),
    publish: vi.fn(async (input: Parameters<SchedulerPublisher["publish"]>[0]) => {
      const job = store.latest("novel")!;
      expect(job.reviewReceipt?.revisionId).toBe(input.revisionId);
      expect(job.reviewReceipt?.observations.every(o => o.assessment === "observation")).toBe(true);
      expect(calls("submit_chapter_review").length).toBeGreaterThan(0);
      await input.beforeMutation?.(); input.authorizeSubmission?.();
      return { status: "published" as const, remoteChapterId: "synthetic-only" };
    }),
  };
  const runner = () => new AutonomousChapterRunner(f.root, f.runner(), store, {
    publisher, retryDelayMs: 1000, persistentTransientRetries: true, writingAttemptsPerBatch: 1, writingDeadline: "none",
    now: () => clock, shouldContinue: () => continuing, chapterIntent: () => "Keep the receipt sealed.",
  });
  const initial: ScheduledChapter = { workId: "novel", chapter: 1, goalId: "transient-goal", phase: "writing", reviewAttempts: 0, failures: 0, nextAttemptAt: 0 };
  store.reserve("novel", 1, clock, 1);
  store.save(initial, "synthetic-admission", clock);
  return { ...f, path, publisher, run: () => runner().run(store.latest("novel")!, new AbortController().signal),
    latest: () => store.latest("novel")!, due: () => { clock = store.latest("novel")!.nextAttemptAt; },
    reopen: () => { store.close(); store = new SchedulerStore(path); }, stop: () => { continuing = false; }, close: () => store.close() };
}
function readGoal(root: string) {
  const store = new GoalStore(join(root, ".inkos/harness.sqlite"));
  try { return { goal: store.get("transient-goal"), events: store.events("transient-goal") }; } finally { store.close(); }
}

describe("real Goal and Scheduler readback across provider failures", () => {
  it("reopens durable one-attempt backoff, grants one attempt per due tick, and consumes the same draft after repeated failures", async () => {
    const f = await schedulerFixture(); let failures = 2;
    onValidate = () => { if (failures-- > 0) throw providerFailure("ECONNRESET"); };
    try {
      const first = await f.run(); expect(first).toMatchObject({ phase: "writing", failures: 1, error: { code: "CREATION_TRANSIENT_BACKOFF" } });
      const initial = readGoal(f.root); expect(initial.goal).toMatchObject({ status: "failed", attempts: 1, owner: null,
        error: { code: "GOAL_BUDGET_EXHAUSTED" }, budget: { maxAttempts: 1, expiresAt: null } });
      expect(initial.goal.steps[0]).toMatchObject({ status: "pending", attempts: 1, maxAttempts: 1, receipt: null, error: { code: "ECONNRESET" } });
      expect(initial.goal.steps[0].baselineState).toBeTruthy();
      const checkpoint = await readFile(f.checkpointPath, "utf8"); await noAcceptedChapter(f);
      expect(calls("submit_state_validation")).toHaveLength(1); expect(f.publisher.publish).not.toHaveBeenCalled();
      f.reopen(); expect(f.latest()).toEqual(first);
      expect(await f.run()).toEqual(first); expect(readGoal(f.root)).toEqual(initial);
      expect(calls("submit_state_validation")).toHaveLength(1);
      f.due(); const second = await f.run(); const retained = readGoal(f.root);
      expect(second).toMatchObject({ phase: "writing", failures: 2 });
      expect(second.nextAttemptAt - first.nextAttemptAt).toBe(2000);
      expect(retained.goal).toMatchObject({ attempts: 2, budget: { maxAttempts: 2, expiresAt: null } });
      expect(retained.goal.steps[0]).toMatchObject({ attempts: 2, maxAttempts: 2, receipt: null,
        operationKey: initial.goal.steps[0].operationKey, baselineState: initial.goal.steps[0].baselineState });
      expect(retained.events.filter(e => e.type === "goal-transient-retry-granted").map(e => e.payload.additionalAttempts)).toEqual([1]);
      expect(await readFile(f.checkpointPath, "utf8")).toBe(checkpoint); await noAcceptedChapter(f); expect(draftCount).toBe(1);
      f.reopen(); expect(await f.run()).toEqual(second); expect(calls("submit_state_validation")).toHaveLength(2);
      f.due(); const done = await f.run(), final = readGoal(f.root);
      expect(done.error).toBeUndefined(); expect(done.phase).toBe("completed"); expect(final.goal).toMatchObject({ status: "completed", attempts: 3, budget: { maxAttempts: 3, expiresAt: null } });
      expect(final.goal.steps[0]).toMatchObject({ attempts: 3, maxAttempts: 3, status: "completed",
        operationKey: initial.goal.steps[0].operationKey, baselineState: initial.goal.steps[0].baselineState });
      expect(final.goal.steps[0].receipt?.operationKey).toBe(initial.goal.steps[0].operationKey);
      expect(final.events.filter(e => e.type === "goal-transient-retry-granted").map(e => e.payload.additionalAttempts)).toEqual([1, 1]);
      expect(f.publisher.publish).toHaveBeenCalledOnce(); await acceptedOnce(f);
      const count = mock.tool.mock.calls.length; f.reopen(); await f.run(); expect(mock.tool.mock.calls).toHaveLength(count);
    } finally { f.close(); }
  });

  it("pauses after failure without dispatching a due retry or retiring the draft", async () => {
    const f = await schedulerFixture(); onValidate = () => { throw providerFailure("ETIMEDOUT"); };
    try {
      await f.run(); const before = readGoal(f.root), checkpoint = await readFile(f.checkpointPath, "utf8");
      f.stop(); f.reopen(); f.due(); await f.run();
      expect(readGoal(f.root)).toEqual(before); expect(calls("submit_state_validation")).toHaveLength(1);
      expect(await readFile(f.checkpointPath, "utf8")).toBe(checkpoint); expect(f.publisher.publish).not.toHaveBeenCalled(); await noAcceptedChapter(f);
    } finally { f.close(); }
  });

  it.each(["paused", "cancelled"] as const)("drains %s during validator failure and never reopens its goal", async desired => {
    const f = await schedulerFixture();
    onValidate = () => {
      const service = new ChapterGoalService({ projectRoot: f.root });
      try { const goal = service.get("transient-goal"); service.stop(goal.id, desired, goal.version); } finally { service.close(); }
      throw providerFailure("ECONNRESET");
    };
    try {
      await f.run(); const stopped = readGoal(f.root);
      expect(stopped.goal).toMatchObject({ status: desired, desiredState: desired, owner: null, attempts: 1 });
      const checkpoint = await readFile(f.checkpointPath, "utf8"); f.reopen(); f.due(); await f.run();
      expect(readGoal(f.root)).toEqual(stopped); expect(calls("submit_state_validation")).toHaveLength(1);
      expect(await readFile(f.checkpointPath, "utf8")).toBe(checkpoint); expect(f.publisher.publish).not.toHaveBeenCalled(); await noAcceptedChapter(f);
      expect(stopped.events.filter(e => e.type === "goal-transient-retry-granted")).toEqual([]);
    } finally { f.close(); }
  });

  it("keeps actual semantic mismatch observations unresolved and blocks completion without a transient grant", async () => {
    const f = await schedulerFixture(); onValidate = () => mismatch;
    try {
      const result = await f.run(), retained = readGoal(f.root);
      expect(calls("submit_state_validation")).toHaveLength(2);
      expect(result.phase).toBe("blocked"); expect(retained.goal.status).toBe("reconciliation_required");
      expect(retained.goal.error?.code).toBe("CHAPTER_STATE_BEHIND"); expect(retained.goal.steps[0].receipt).toBeNull();
      const index = await f.state.loadChapterIndex("novel"); expect(index).toHaveLength(1);
      expect(index[0].observations.some(o => o.code === "state-reconciliation" && o.summary.includes("contradicts"))).toBe(true);
      expect(retained.events.filter(e => e.type === "goal-transient-retry-granted")).toEqual([]);
      expect(f.publisher.publish).not.toHaveBeenCalled(); f.reopen(); f.due(); await f.run(); expect(draftCount).toBe(1);
    } finally { f.close(); }
  });
});

describe("ordinary finite goals and retained output proof", () => {
  it.each(["attempts", "deadline"] as const)("preserves the ordinary finite %s cap after a validator failure", async limit => {
    const f = await fixture(); let clock = 100;
    const store = new GoalStore(join(f.root, ".inkos/harness.sqlite"), { now: () => clock });
    onValidate = () => { if (limit === "deadline") clock = 201; throw providerFailure("ECONNRESET"); };
    try {
      store.create(chapterGoalInput({ id: "finite", workId: "novel", intent: "Keep the receipt sealed.", startChapter: 1, endChapter: 1,
        maxAttemptsPerChapter: 2, expiresAt: 200 })); store.requestRun("finite", store.get("finite").version);
      const adapter = createChapterGoalAdapter({ projectRoot: f.root, pipeline: f.runner() });
      const result = await new GoalExecutor(store, [adapter], 0).run("finite");
      expect(result).toMatchObject({ status: "failed", error: { code: "GOAL_BUDGET_EXHAUSTED" }, budget: { maxAttempts: 2, expiresAt: 200 },
        attempts: limit === "attempts" ? 2 : 1 });
      expect(calls("submit_state_validation")).toHaveLength(limit === "attempts" ? 2 : 1);
      expect(result.steps[0].receipt).toBeNull(); expect(draftCount).toBe(1); await noAcceptedChapter(f);
      expect(() => store.retryTransientFailure(result.id, result.version, 1)).toThrowError(expect.objectContaining({ code: "GOAL_RETRY_NOT_ALLOWED" }));
    } finally { store.close(); }
  });

  it.each(["completed", "registry-missing", "state-behind"] as const)("reconciles %s retained chapter evidence before any generation", async proof => {
    const f = await fixture(); await f.write(); const count = mock.tool.mock.calls.length;
    const bytes = await readFile(join(f.bookDir, "chapters", (await readdir(join(f.bookDir, "chapters"))).find(file => file.endsWith(".md"))!));
    if (proof === "registry-missing") {
      const work = await loadWorkManifest(f.root, "novel");
      await saveWorkManifest(f.root, { ...work, artifacts: work.artifacts.filter(a => a.kind !== "chapter") });
    }
    if (proof === "state-behind") await createInitialRuntimeState({ bookDir: f.bookDir, language: "en" });
    const store = new GoalStore(join(f.root, ".inkos/harness.sqlite"));
    try {
      store.create(chapterGoalInput({ id: "retained", workId: "novel", intent: "Keep receipt sealed.", startChapter: 1, endChapter: 1, expiresAt: null }));
      store.requestRun("retained", store.get("retained").version);
      const result = await new GoalExecutor(store, [createChapterGoalAdapter({ projectRoot: f.root, pipeline: f.runner() })], 0).run("retained");
      expect(result.status).toBe(proof === "completed" ? "completed" : "reconciliation_required"); expect(result.attempts).toBe(0);
      if (proof === "completed") expect(result.steps[0].receipt).not.toBeNull();
      else { expect(result.steps[0].receipt).toBeNull(); expect(result.error?.code).toBe(proof === "registry-missing" ? "CHAPTER_REGISTRY_UNCONFIRMED" : "CHAPTER_STATE_BEHIND"); }
      expect(mock.tool.mock.calls).toHaveLength(count);
      expect(await readFile(join(f.bookDir, "chapters", (await readdir(join(f.bookDir, "chapters"))).find(file => file.endsWith(".md"))!))).toEqual(bytes);
    } finally { store.close(); }
  });
});
