import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GoalInputSchema, goalError, type Goal, type GoalReceipt, type GoalStepAdapter } from "../goals/contracts.js";
import { chapterGoalInput } from "../goals/chapters.js";
import { GoalExecutor } from "../goals/executor.js";
import { GoalStore } from "../goals/store.js";
import { ChapterGoalService } from "../goals/service.js";
import { StateManager } from "../state/manager.js";
import { createWorkManifest, saveWorkManifest } from "../harness/work-store.js";

const roots: string[] = [], stores: GoalStore[] = [], services: ChapterGoalService[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const service of services.splice(0)) service.close();
  for (const store of stores.splice(0)) store.close();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
function input(expiresAt: number | null = null, count = 1) {
  return chapterGoalInput({ id: "creation", workId: "novel", intent: "Write the requested chapters",
    startChapter: 1, endChapter: count, expiresAt });
}
async function setup(now: () => number = Date.now) {
  const root = await mkdtemp(join(tmpdir(), "inkos-creation-budget-")); roots.push(root);
  const path = join(root, ".inkos", "harness.sqlite"), store = new GoalStore(path, { now }); stores.push(store);
  return { root, path, store };
}
function start(store: GoalStore) { const goal = store.get("creation"); store.requestRun(goal.id, goal.version); }
function fixture() {
  const receipts = new Map<string, GoalReceipt>(), calls: string[] = [];
  const adapter: GoalStepAdapter = {
    kind: "longform.write_chapter", retrySafe: true, withScope: (_context, task) => task(),
    reconcile: async context => receipts.has(context.step.operationKey)
      ? { status: "completed", receipt: receipts.get(context.step.operationKey)! } : { status: "absent", baselineState: "unchanged input" },
    execute: async context => {
      calls.push(context.step.id);
      receipts.set(context.step.operationKey, { operationKey: context.step.operationKey,
        artifacts: [{ artifactId: context.step.id, revisionId: "revision-1", path: "chapter.md" }], evidence: { verified: true } });
    },
    isRetryable: error => (error as { code?: string }).code === "MODEL_UNAVAILABLE",
  };
  return { adapter, calls, receipts };
}
async function exhausted() {
  const f = await setup(), worker = fixture();
  f.store.create(input(null, 2)); start(f.store);
  const execute = worker.adapter.execute;
  worker.adapter.execute = async context => {
    if (context.step.id === "chapter-2") throw goalError("MODEL_UNAVAILABLE", "temporary provider error");
    await execute(context);
  };
  const result = await new GoalExecutor(f.store, [worker.adapter], 0).run("creation");
  expect(result).toMatchObject({ status: "failed", error: { code: "GOAL_BUDGET_EXHAUSTED" }, attempts: 4 });
  return { ...f, ...worker, result, execute };
}

describe("creation goals without wall-clock expiry", () => {
  it("accepts explicit null expiry while preserving existing numeric and required-expiry semantics", () => {
    expect(GoalInputSchema.parse(input()).budget.expiresAt).toBeNull();
    expect(GoalInputSchema.parse(input(123)).budget.expiresAt).toBe(123);
    for (const expiresAt of [undefined, -1, Infinity, "never"]) {
      expect(GoalInputSchema.safeParse({ ...input(), budget: { maxAttempts: 3, expiresAt } }).success).toBe(false);
    }
  });

  it("persists null expiry and accepts a verified chapter after years of elapsed application time", async () => {
    let now = 100;
    const f = await setup(() => now), worker = fixture();
    f.store.create(input()); start(f.store);
    const execute = worker.adapter.execute;
    worker.adapter.execute = async context => {
      now += 5 * 365 * 24 * 60 * 60_000;
      // Allow the real ownership/stop watchdog to check the non-expiring goal.
      await new Promise(resolve => setTimeout(resolve, 120));
      expect(context.signal.aborted).toBe(false);
      await execute(context);
    };
    const result = await new GoalExecutor(f.store, [worker.adapter]).run("creation");
    expect(result).toMatchObject({ status: "completed", budget: { expiresAt: null, maxAttempts: 3 }, attempts: 1, error: null });
    expect(result.steps[0]!.receipt).not.toBeNull();
    const reopened = new GoalStore(f.path, { now: () => now }); stores.push(reopened);
    expect(reopened.get("creation")).toEqual(result);
  });

  it("still fails existing numeric deadlines and retains late chapter receipts", async () => {
    let now = 100;
    const f = await setup(() => now), worker = fixture();
    expect(() => f.store.create(input(100))).toThrowError(expect.objectContaining({ code: "GOAL_BUDGET_EXHAUSTED" }));
    f.store.create(input(200)); start(f.store);
    const execute = worker.adapter.execute;
    worker.adapter.execute = async context => { await execute(context); now = 201; };
    const result = await new GoalExecutor(f.store, [worker.adapter]).run("creation");
    expect(result).toMatchObject({ status: "failed", error: { code: "GOAL_BUDGET_EXHAUSTED" } });
    expect(result.steps[0]!.receipt).not.toBeNull();
  });

  it("allows the public chapter service to create and begin a null-expiry goal long after creation", async () => {
    const f = await setup(), state = new StateManager(f.root), createdAt = new Date().toISOString();
    await saveWorkManifest(f.root, createWorkManifest({ id: "novel", title: "Story", profileId: "longform-novel", language: "en" }));
    await state.saveBookConfig("novel", { id: "novel", title: "Story", genre: "general", platform: "other", status: "active",
      targetChapters: 1, chapterWordCount: 1000, language: "en", createdAt, updatedAt: createdAt });
    const runtime = vi.fn(() => { throw new Error("runtime reached without expiry rejection"); });
    const service = new ChapterGoalService({ projectRoot: f.root, createPipeline: runtime }); services.push(service);
    const created = await service.create({ id: "creation", workId: "novel", intent: "Write", startChapter: 1, endChapter: 1, expiresAt: null });
    vi.spyOn(Date, "now").mockReturnValue(created.createdAt + 5 * 365 * 24 * 60 * 60_000);
    await expect(service.run(created.id, created.version)).rejects.toThrow("runtime reached without expiry rejection");
    expect(runtime).toHaveBeenCalledOnce();
    expect(service.get(created.id).budget.expiresAt).toBeNull();
  });

  it("honors user cancellation after a late receipt without rewriting or completing later steps", async () => {
    const f = await setup(), worker = fixture();
    f.store.create(input(null, 2)); start(f.store);
    const execute = worker.adapter.execute;
    worker.adapter.execute = async context => {
      const goal = f.store.get("creation"); f.store.requestStop(goal.id, "cancelled", goal.version);
      await execute(context);
    };
    const result = await new GoalExecutor(f.store, [worker.adapter]).run("creation");
    expect(result.status).toBe("cancelled");
    expect(result.steps.map(step => step.status)).toEqual(["completed", "pending"]);
    expect(worker.calls).toEqual(["chapter-1"]);
  });
});

describe("explicit creation transient retry grants", () => {
  it("grants three additional attempts without resetting counters, receipts, operation keys, or baselines", async () => {
    const f = await exhausted();
    const granted = f.store.retryTransientFailure("creation", f.result.version);
    expect(granted).toMatchObject({ status: "ready", desiredState: "run", attempts: 4, error: null, budget: { expiresAt: null, maxAttempts: 9 } });
    expect(granted.steps[0]).toEqual(f.result.steps[0]);
    expect(granted.steps[1]).toEqual({ ...f.result.steps[1], maxAttempts: 6 });
    expect(f.store.events("creation").at(-1)).toMatchObject({ type: "goal-transient-retry-granted", payload: { additionalAttempts: 3 } });
    expect(() => f.store.retryTransientFailure("creation", granted.version)).toThrowError(expect.objectContaining({ code: "GOAL_RETRY_NOT_ALLOWED" }));
    const order: string[] = [], reconcile = f.adapter.reconcile;
    f.adapter.reconcile = async context => { order.push(`reconcile:${context.step.id}`); return reconcile(context); };
    f.adapter.execute = async context => { order.push(`execute:${context.step.id}`); await f.execute(context); };
    start(f.store);
    const done = await new GoalExecutor(f.store, [f.adapter], 0).run("creation");
    expect(done).toMatchObject({ status: "completed", attempts: 5 });
    expect(done.steps.map(step => step.attempts)).toEqual([1, 4]);
    expect(order.indexOf("reconcile:chapter-2")).toBeLessThan(order.indexOf("execute:chapter-2"));
    expect(f.calls).toEqual(["chapter-1", "chapter-2"]);
  });

  it("grants a single persisted scheduler attempt while keeping cumulative counters and completed work", async () => {
    const f = await exhausted(), runtime = vi.fn();
    const service = new ChapterGoalService({ projectRoot: f.root, createPipeline: runtime }); services.push(service);
    const granted = service.retryTransientFailure("creation", f.result.version, "novel", 1);
    expect(granted).toMatchObject({ status: "ready", attempts: 4, budget: { expiresAt: null, maxAttempts: 7 } });
    expect(granted.steps[0]).toEqual(f.result.steps[0]);
    expect(granted.steps[1]).toEqual({ ...f.result.steps[1], maxAttempts: 4 });
    expect(f.store.events("creation").at(-1)).toMatchObject({ type: "goal-transient-retry-granted", payload: { additionalAttempts: 1 } });
    expect(runtime).not.toHaveBeenCalled();
  });

  it.each([0, -1, 4, 1.5, NaN, Infinity])("rejects invalid additional attempt count %s without changing state", async additionalAttempts => {
    const f = await exhausted(), events = f.store.events("creation");
    expect(() => f.store.retryTransientFailure("creation", f.result.version, additionalAttempts))
      .toThrowError(expect.objectContaining({ code: "GOAL_RETRY_GRANT_INVALID" }));
    expect(f.store.get("creation")).toEqual(f.result);
    expect(f.store.events("creation")).toEqual(events);
  });

  it.each(["changed baseline", "unknown outcome"])("reconciles and refuses replay after a grant when the next read finds %s", async reason => {
    const f = await exhausted();
    f.store.retryTransientFailure("creation", f.result.version, 1);
    const reconcile = f.adapter.reconcile, execute = vi.fn(f.execute);
    f.adapter.reconcile = async context => context.step.id === "chapter-1" ? reconcile(context)
      : reason === "changed baseline" ? { status: "absent", baselineState: "changed input" }
        : { status: "unknown", error: { code: "OUTPUT_UNCONFIRMED", message: "Outcome cannot be verified" } };
    f.adapter.execute = execute;
    start(f.store);
    const stopped = await new GoalExecutor(f.store, [f.adapter], 0).run("creation");
    expect(stopped).toMatchObject({ status: "reconciliation_required", attempts: 4 });
    expect(execute).not.toHaveBeenCalled();
    expect(stopped.steps[0]!.receipt).toEqual(f.result.steps[0]!.receipt);
    expect(() => f.store.retryTransientFailure("creation", stopped.version, 1)).toThrowError(expect.objectContaining({ code: "GOAL_RETRY_NOT_ALLOWED" }));
  });

  it("preserves version and work-scope checks through the service without starting execution", async () => {
    const f = await exhausted(), runtime = vi.fn();
    const service = new ChapterGoalService({ projectRoot: f.root, createPipeline: runtime }); services.push(service);
    expect(() => service.retryTransientFailure("creation", f.result.version, "other")).toThrowError(expect.objectContaining({ code: "GOAL_WORK_SCOPE_MISMATCH" }));
    expect(() => service.retryTransientFailure("creation", f.result.version - 1)).toThrowError(expect.objectContaining({ code: "GOAL_VERSION_CONFLICT" }));
    expect(service.retryTransientFailure("creation", f.result.version, "novel").status).toBe("ready");
    expect(runtime).not.toHaveBeenCalled();
  });

  it.each([
    ["numeric expiry", (goal: Goal) => { goal.budget.expiresAt = Date.now() + 60_000; }],
    ["cancelled goal", (goal: Goal) => { goal.status = "cancelled"; goal.desiredState = "cancelled"; }],
    ["active owner", (goal: Goal) => { goal.owner = { token: "other", pid: process.pid, leaseUntil: Date.now() + 1000 }; }],
    ["quality failure", (goal: Goal) => { goal.error = { code: "REVIEW_FAILED", message: "Quality check failed" }; }],
    ["uncertain result", (goal: Goal) => { goal.steps[1]!.status = "reconciliation_required"; }],
    ["unsettled running step", (goal: Goal) => { goal.steps[1]!.status = "running"; }],
    ["unfinished retained receipt", (goal: Goal) => { goal.steps[1]!.receipt = { operationKey: goal.steps[1]!.operationKey, artifacts: [], evidence: {} }; }],
    ["nontransient error", (goal: Goal) => { goal.steps[1]!.error = { code: "WORKER_RESULT_INVALID", message: "Invalid output" }; }],
    ["no confirmed transient error", (goal: Goal) => { goal.steps[1]!.error = null; }],
    ["unexhausted attempts", (goal: Goal) => { goal.steps[1]!.maxAttempts = 10; }],
  ] as const)("rejects %s without modifying the failed goal", async (_label, change) => {
    const f = await exhausted(), changed = structuredClone(f.result); change(changed);
    const db = new DatabaseSync(f.path), { steps, ...goal } = changed;
    try {
      db.prepare("UPDATE goals SET owner_token = ?, data_json = ? WHERE id = ?").run(goal.owner?.token ?? null, JSON.stringify(goal), goal.id);
      for (const step of steps) db.prepare("UPDATE goal_steps SET data_json = ? WHERE goal_id = ? AND id = ?").run(JSON.stringify(step), goal.id, step.id);
    } finally { db.close(); }
    const before = f.store.get("creation"), events = f.store.events("creation");
    expect(() => f.store.retryTransientFailure("creation", before.version)).toThrowError(expect.objectContaining({ code: "GOAL_RETRY_NOT_ALLOWED" }));
    expect(f.store.get("creation")).toEqual(before);
    expect(f.store.events("creation")).toEqual(events);
  });
});
