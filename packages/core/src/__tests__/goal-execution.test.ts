import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { GoalStore } from "../goals/store.js";
import { GoalExecutor } from "../goals/executor.js";
import { type GoalInput, type GoalReceipt, type GoalStepAdapter, goalError } from "../goals/contracts.js";

const roots: string[] = [], stores: GoalStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function setup(now: () => number = Date.now) {
  const root = await mkdtemp(join(tmpdir(), "inkos-goal-")); roots.push(root);
  const path = join(root, "harness.sqlite"), store = open(path, now);
  return { path, store };
}
function open(path: string, now: () => number = Date.now) {
  const store = new GoalStore(path, { now }); stores.push(store); return store;
}
function close(store: GoalStore) { store.close(); stores.splice(stores.indexOf(store), 1); }
function input(id = "goal", steps = 1, expiresAt = Date.now() + 60_000): GoalInput {
  return { id, workId: "novel", intent: "Write the requested chapters.",
    budget: { maxAttempts: 6, expiresAt }, steps: Array.from({ length: steps }, (_, index) => ({
      id: `step-${index}`, kind: "fixture", input: { chapter: index + 1 }, maxAttempts: 3,
    })) };
}
function start(store: GoalStore, id = "goal") { store.requestRun(id, store.get(id).version); }
function fixture() {
  const effects = new Map<string, number>();
  const calls: string[] = [];
  const receipt = (operationKey: string): GoalReceipt => ({ operationKey, artifacts: [], evidence: { revision: effects.get(operationKey)! } });
  const adapter: GoalStepAdapter = {
    kind: "fixture", retrySafe: true, withScope: (_context, task) => task(),
    reconcile: async context => effects.has(context.step.operationKey)
      ? { status: "completed", receipt: receipt(context.step.operationKey) } : { status: "absent" },
    execute: async context => { calls.push(context.step.id); effects.set(context.step.operationKey, 1); },
    isRetryable: error => (error as { code?: string }).code === "TRANSIENT",
  };
  return { adapter, effects, calls };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe("persistent goal execution", () => {
  it("requires explicit start and uses versioned user intent", async () => {
    const { store } = await setup(), { adapter, calls } = fixture();
    const created = store.create(input());
    expect((await new GoalExecutor(store, [adapter]).run("goal")).status).toBe("paused");
    expect(calls).toEqual([]);
    start(store);
    expect(() => store.requestStop("goal", "cancelled", created.version)).toThrow(/changed/);
    const result = await new GoalExecutor(store, [adapter]).run("goal");
    expect(result.status).toBe("completed");
    expect(result.attempts).toBe(1);
    expect(calls).toEqual(["step-0"]);
    expect(store.events("goal").filter(event => event.type === "step-completed")).toHaveLength(1);
  });

  it("claims one owner across stores and blocks another goal for the same Work", async () => {
    let now = 100;
    const { path, store } = await setup(() => now), other = open(path, () => now);
    store.create(input("goal", 1, 10000)); store.create(input("other", 1, 10000)); start(store); start(other, "other");
    const lease = store.claim("goal", 10)!;
    now += 1000;
    expect(other.recover("goal").status).toBe("running");
    expect(other.claim("goal")).toBeUndefined();
    expect(other.claim("other")).toBeUndefined();
    expect(() => store.close()).toThrow(/Drain/);
    store.release(lease, "interrupted");
    const otherLease = other.claim("other")!;
    expect(otherLease).toBeDefined(); other.release(otherLease, "paused");
  });

  it.each([false, true])("recovers a dead foreign process without resuming or losing cancellation=%s", async cancelled => {
    const { path, store } = await setup(); store.create(input()); start(store);
    const child = spawn(process.execPath, ["-e", "process.stdout.write('ready'); setInterval(() => {}, 1000)"], { stdio: ["ignore", "pipe", "ignore"] });
    try {
      await once(child.stdout!, "data");
      const db = new DatabaseSync(path), goal = store.get("goal");
      const { steps, ...data } = goal;
      data.status = "running"; data.owner = { token: "foreign-executor", pid: child.pid!, leaseUntil: 0 }; data.attempts = 1;
      steps[0].status = "running"; steps[0].attempts = 1;
      db.prepare("UPDATE goals SET owner_token = ?, data_json = ? WHERE id = ?").run(data.owner.token, JSON.stringify(data), goal.id);
      db.prepare("UPDATE goal_steps SET data_json = ? WHERE goal_id = ?").run(JSON.stringify(steps[0]), goal.id); db.close();
      expect(store.recover("goal").status).toBe("running");
      if (cancelled) store.requestStop("goal", "cancelled", store.get("goal").version);
      const exited = once(child, "exit"); child.kill(); await exited;
      const recovered = store.recover("goal");
      expect(recovered.status).toBe(cancelled ? "cancelled" : "interrupted");
      expect(recovered.owner).toBeNull(); expect(recovered.attempts).toBe(1);
      expect(store.claim("goal")).toBeUndefined();
      expect(store.recover("goal").version).toBe(recovered.version);
    } finally { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill(); await exited; } }
  });

  it("does not resurrect cancellation during a live, uncooperative effect", async () => {
    let now = 100;
    const { path, store } = await setup(() => now), other = open(path, () => now), f = fixture();
    store.create(input("goal", 2, 100000)); start(store);
    const entered = deferred(), drain = deferred();
    const execute = f.adapter.execute;
    f.adapter.execute = async context => { entered.resolve(); await drain.promise; await execute(context); };
    const running = new GoalExecutor(store, [f.adapter]).run("goal"); await entered.promise;
    let goal = other.requestStop("goal", "cancelled", other.get("goal").version);
    goal = other.requestStop("goal", "paused", goal.version);
    expect(goal.desiredState).toBe("cancelled");
    now += 40000;
    expect(other.recover("goal").owner).not.toBeNull();
    expect(other.claim("goal")).toBeUndefined();
    expect(() => other.requestRun("goal", goal.version)).toThrow();
    drain.resolve();
    const stopped = await running;
    expect(stopped.status).toBe("cancelled");
    expect(stopped.steps.map(step => step.status)).toEqual(["completed", "pending"]);
    close(store); close(other);
    const reopened = open(path, () => now);
    expect(reopened.recover("goal").status).toBe("cancelled");
    expect(() => start(reopened)).toThrow(/terminal/);
    expect(f.calls).toEqual(["step-0"]);
  });

  it("pauses at a drained boundary and resumes only the remaining steps", async () => {
    const { path, store } = await setup(), f = fixture(); store.create(input("goal", 2)); start(store);
    const execute = f.adapter.execute;
    f.adapter.execute = async context => { await execute(context); store.requestStop("goal", "paused", store.get("goal").version); };
    expect((await new GoalExecutor(store, [f.adapter]).run("goal")).status).toBe("paused");
    close(store);
    const reopened = open(path); start(reopened); f.adapter.execute = execute;
    expect((await new GoalExecutor(reopened, [f.adapter]).run("goal")).status).toBe("completed");
    expect(f.calls).toEqual(["step-0", "step-1"]);
  });

  it("recovers a crash after effect commit without replay, with atomic event/state writes", async () => {
    const { path, store } = await setup(), f = fixture(); store.create(input()); start(store);
    const db = new DatabaseSync(path);
    db.exec("CREATE TRIGGER injected_failure BEFORE INSERT ON goal_events WHEN NEW.type = 'step-completed' BEGIN SELECT RAISE(FAIL, 'receipt disk failure'); END;");
    const failed = await new GoalExecutor(store, [f.adapter]).run("goal");
    expect(failed.status).toBe("reconciliation_required");
    expect(failed.steps[0].status).toBe("running");
    expect(store.events("goal").filter(event => event.type === "step-completed")).toEqual([]);
    db.exec("DROP TRIGGER injected_failure"); db.close(); close(store);
    for (let pass = 0; pass < 3; pass++) {
      const reopened = open(path);
      if (reopened.get("goal").status !== "completed") start(reopened);
      expect((await new GoalExecutor(reopened, [f.adapter]).run("goal")).status).toBe("completed");
      expect(reopened.get("goal").attempts).toBe(1); close(reopened);
    }
    expect(f.calls).toEqual(["step-0"]);
  });

  it("recovers a failed final goal commit after all step receipts were saved", async () => {
    const { path, store } = await setup(), f = fixture(); store.create(input()); start(store);
    const db = new DatabaseSync(path);
    db.exec("CREATE TRIGGER injected_failure BEFORE INSERT ON goal_events WHEN NEW.type = 'goal-released' BEGIN SELECT RAISE(FAIL, 'terminal disk failure'); END;");
    await expect(new GoalExecutor(store, [f.adapter]).run("goal")).rejects.toThrow("terminal disk failure");
    expect(store.get("goal").status).toBe("running");
    expect(store.get("goal").steps[0].status).toBe("completed");
    db.exec("DROP TRIGGER injected_failure"); db.close(); close(store);
    const reopened = open(path);
    expect(reopened.recover("goal").status).toBe("interrupted"); start(reopened);
    expect((await new GoalExecutor(reopened, [f.adapter]).run("goal")).status).toBe("completed");
    expect(f.calls).toEqual(["step-0"]);
  });

  it("cannot dispatch when the ownership transaction fails", async () => {
    const { path, store } = await setup(), f = fixture(); store.create(input()); start(store);
    const db = new DatabaseSync(path);
    db.exec("CREATE TRIGGER injected_failure BEFORE INSERT ON goal_events WHEN NEW.type = 'goal-claimed' BEGIN SELECT RAISE(FAIL, 'claim disk failure'); END;");
    await expect(new GoalExecutor(store, [f.adapter]).run("goal")).rejects.toThrow("claim disk failure");
    expect(store.get("goal").status).toBe("ready"); expect(store.get("goal").owner).toBeNull();
    expect(f.calls).toEqual([]); db.close();
  });

  it("keeps attempt budgets through interruption and restart", async () => {
    const { path, store } = await setup(), f = fixture(), controller = new AbortController();
    store.create({ ...input(), budget: { maxAttempts: 2, expiresAt: Date.now() + 60000 } }); start(store);
    let calls = 0;
    f.adapter.execute = async () => { calls++; controller.abort(new Error("transport disconnected")); throw goalError("TRANSIENT", "retry later"); };
    expect((await new GoalExecutor(store, [f.adapter], 0).run("goal", controller.signal)).status).toBe("interrupted");
    close(store); const reopened = open(path); start(reopened);
    f.adapter.execute = async () => { calls++; throw goalError("TRANSIENT", "retry later"); };
    const exhausted = await new GoalExecutor(reopened, [f.adapter], 0).run("goal");
    expect(exhausted.status).toBe("failed");
    expect(exhausted.error?.code).toBe("GOAL_BUDGET_EXHAUSTED");
    expect(exhausted.attempts).toBe(2); expect(calls).toBe(2);
  });

  it("retains a late output but never reports deadline expiry as success", async () => {
    let now = 100;
    const { store } = await setup(() => now), f = fixture(); store.create(input("goal", 1, 200)); start(store);
    const execute = f.adapter.execute;
    f.adapter.execute = async context => { await execute(context); now = 201; };
    const result = await new GoalExecutor(store, [f.adapter]).run("goal");
    expect(result.status).toBe("failed"); expect(result.error?.code).toBe("GOAL_BUDGET_EXHAUSTED");
    expect(result.steps[0].receipt).not.toBeNull(); expect(result.owner).toBeNull();
  });

  it("rechecks the deadline after waiting for SQLite ownership at final commit", async () => {
    let clock = () => 100;
    const { path, store } = await setup(() => clock()), f = fixture();
    store.create(input("goal", 1, 200)); start(store);
    let child: ReturnType<typeof spawn> | undefined, checks = 0;
    const reconcile = f.adapter.reconcile;
    f.adapter.reconcile = async context => {
      if (++checks === 3) {
        child = spawn(process.execPath, ["--input-type=module", "-e", `
          import { DatabaseSync } from 'node:sqlite';
          const db = new DatabaseSync(process.argv[1]); db.exec('BEGIN IMMEDIATE');
          process.send('locked');
          process.once('message', () => setTimeout(() => { db.exec('COMMIT'); db.close(); process.disconnect(); }, 200));
        `, path], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
        await Promise.race([once(child, "message"), once(child, "exit").then(() => { throw new Error("SQLite fixture exited before locking"); })]);
        const started = Date.now(); clock = () => 100 + Date.now() - started;
        child.send("release");
      }
      return reconcile(context);
    };
    try {
      const result = await new GoalExecutor(store, [f.adapter]).run("goal");
      expect(result.status).toBe("failed"); expect(result.error?.code).toBe("GOAL_BUDGET_EXHAUSTED");
      expect(result.steps[0].status).toBe("completed"); expect(result.owner).toBeNull();
      expect(store.events("goal").at(-1)?.payload).toMatchObject({ status: "failed", error: { code: "GOAL_BUDGET_EXHAUSTED" } });
      expect(f.calls).toEqual(["step-0"]);
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit"); child.kill(); await exited;
      }
    }
  });

  it("limits identical transient failures without resetting committed progress", async () => {
    const { store } = await setup(), f = fixture(); const goal = store.create(input()); start(store);
    let calls = 0;
    f.adapter.execute = async () => { calls++; throw goalError("TRANSIENT", "same failure"); };
    const result = await new GoalExecutor(store, [f.adapter], 0).run("goal");
    expect(result.status).toBe("failed"); expect(calls).toBe(3);
    expect(result.lastProgressAt).toBe(goal.lastProgressAt);
  });

  it("reserves waiting_user for an explicit missing user decision", async () => {
    const { store } = await setup(), f = fixture(); store.create(input()); start(store);
    f.adapter.reconcile = async () => ({ status: "waiting_user", error: { code: "APPROVAL_REQUIRED", message: "Select the publication destination." } });
    const result = await new GoalExecutor(store, [f.adapter]).run("goal");
    expect(result.status).toBe("waiting_user"); expect(result.attempts).toBe(0); expect(f.calls).toEqual([]);
  });

  it("rechecks unknown outcomes programmatically without repeated effects", async () => {
    const { store } = await setup(), f = fixture(); store.create(input()); start(store);
    const reconcile = f.adapter.reconcile;
    let unknown = true;
    f.adapter.reconcile = async context => f.effects.size && unknown
      ? { status: "unknown", error: { code: "UNCONFIRMED", message: "Readback is pending." } } : reconcile(context);
    const executor = new GoalExecutor(store, [f.adapter]);
    expect((await executor.run("goal")).status).toBe("reconciliation_required");
    start(store); expect((await executor.run("goal")).status).toBe("reconciliation_required");
    unknown = false; start(store); expect((await executor.run("goal")).status).toBe("completed");
    expect(f.calls).toEqual(["step-0"]);
  });

  it("refuses to retry a missing step against changed execution inputs", async () => {
    const { path, store } = await setup(), f = fixture(), signal = new AbortController();
    store.create(input()); start(store);
    f.adapter.reconcile = async () => ({ status: "absent", baselineState: "original-state" });
    let calls = 0;
    f.adapter.execute = async () => { calls++; signal.abort(new Error("interrupted")); };
    expect((await new GoalExecutor(store, [f.adapter]).run("goal", signal.signal)).status).toBe("interrupted");
    expect(store.get("goal").steps[0].baselineState).toBe("original-state");
    close(store); const reopened = open(path); start(reopened);
    f.adapter.reconcile = async () => ({ status: "absent", baselineState: "revised-state" });
    const result = await new GoalExecutor(reopened, [f.adapter]).run("goal");
    expect(result.status).toBe("reconciliation_required"); expect(result.error?.code).toBe("GOAL_BASELINE_CHANGED");
    expect(calls).toBe(1);
  });

  it("does not repeat an adapter without a retry-safe recovery contract", async () => {
    const { store } = await setup(), f = fixture(); store.create(input()); start(store);
    const lease = store.claim("goal")!; store.beginAttempt(lease, "step-0"); store.release(lease, "interrupted");
    start(store); const adapter = { ...f.adapter, retrySafe: false };
    expect((await new GoalExecutor(store, [adapter]).run("goal")).error?.code).toBe("GOAL_RECONCILIATION_REQUIRED");
    expect(f.calls).toEqual([]);
  });

  it("requires all accepted output fingerprints to remain current", async () => {
    const { store } = await setup(), f = fixture(); store.create(input("goal", 2)); start(store);
    const execute = f.adapter.execute;
    f.adapter.execute = async context => {
      await execute(context);
      if (context.step.id === "step-1") f.effects.set(context.goal.steps[0].operationKey, 2);
    };
    const result = await new GoalExecutor(store, [f.adapter]).run("goal");
    expect(result.status).toBe("reconciliation_required"); expect(result.error?.code).toBe("GOAL_RECEIPT_CHANGED");
    expect(f.calls).toEqual(["step-0", "step-1"]);
  });
});
