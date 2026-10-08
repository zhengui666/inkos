import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { openHarnessDatabase } from "../harness/sqlite.js";
import {
  GoalInputSchema, GoalReceiptSchema, GoalSchema, GoalStepSchema, goalError, goalInputValue,
  type Goal, type GoalError, type GoalEvent, type GoalInput, type GoalLease, type GoalReceipt, type GoalStatus,
} from "./contracts.js";

const activeOwners = new Set<string>();
const terminal = new Set<GoalStatus>(["completed", "cancelled", "failed"]);
const transientFailures = new Set(["MODEL_UNAVAILABLE", "WORKER_TIMEOUT", "ECONNRESET", "ETIMEDOUT", "RATE_LIMITED"]);
function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/** Synchronous transactions fence all ownership and progress writes across processes. */
export class GoalStore {
  private readonly db: DatabaseSync;
  private readonly owned = new Set<string>();
  readonly now: () => number;

  constructor(path: string, options: { readonly now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
    this.db = openHarnessDatabase(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS goals (
        id TEXT PRIMARY KEY, work_id TEXT NOT NULL, owner_token TEXT, data_json TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS goal_work_owner ON goals(work_id) WHERE owner_token IS NOT NULL;
      CREATE TABLE IF NOT EXISTS goal_steps (
        goal_id TEXT NOT NULL REFERENCES goals(id), ordinal INTEGER NOT NULL,
        id TEXT NOT NULL, operation_key TEXT NOT NULL UNIQUE, data_json TEXT NOT NULL,
        PRIMARY KEY(goal_id, id), UNIQUE(goal_id, ordinal)
      );
      CREATE TABLE IF NOT EXISTS goal_events (
        goal_id TEXT NOT NULL REFERENCES goals(id), seq INTEGER NOT NULL, at INTEGER NOT NULL,
        type TEXT NOT NULL, payload_json TEXT NOT NULL, PRIMARY KEY(goal_id, seq)
      );
    `);
  }

  create(input: GoalInput): Goal {
    const parsed = GoalInputSchema.parse(input), now = this.now();
    if (parsed.budget.expiresAt !== null && parsed.budget.expiresAt <= now) throw goalError("GOAL_BUDGET_EXHAUSTED", "Goal deadline has already elapsed.");
    if (new Set(parsed.steps.map(step => step.id)).size !== parsed.steps.length) {
      throw goalError("GOAL_STEP_ID_REUSED", "Goal step IDs must be unique.");
    }
    const goal = GoalSchema.parse({ ...parsed, schemaVersion: 1, version: 0,
      status: "paused", desiredState: "paused", attempts: 0, owner: null, error: null,
      createdAt: now, updatedAt: now, lastProgressAt: now,
      steps: parsed.steps.map(step => ({ ...step,
        operationKey: `operation-${randomUUID()}`,
        status: "pending", attempts: 0, baselineState: null, receipt: null, error: null,
      })),
    });
    return this.transaction(() => {
      this.db.prepare("INSERT INTO goals(id, work_id, owner_token, data_json) VALUES (?, ?, NULL, '{}')")
        .run(goal.id, goal.workId);
      this.persist(goal, "goal-created", {});
      return goal;
    });
  }

  get(id: string): Goal {
    // One statement gives a consistent read snapshot even if another process
    // commits between the goal and step reads.
    const rows = this.db.prepare(`SELECT g.data_json AS goal_json, s.data_json AS step_json
      FROM goals g LEFT JOIN goal_steps s ON s.goal_id = g.id WHERE g.id = ? ORDER BY s.ordinal`).all(id);
    if (!rows.length) throw goalError("GOAL_NOT_FOUND", `Unknown goal: ${id}`);
    const steps = rows.filter(row => row.step_json !== null).map(row => GoalStepSchema.parse(JSON.parse(String(row.step_json))));
    return GoalSchema.parse({ ...JSON.parse(String(rows[0]!.goal_json)), steps });
  }

  list(workId?: string): Goal[] {
    const rows = workId === undefined
      ? this.db.prepare("SELECT id FROM goals ORDER BY id").all()
      : this.db.prepare("SELECT id FROM goals WHERE work_id = ? ORDER BY id").all(workId);
    return rows.map(row => this.get(String(row.id)));
  }

  events(id: string, afterSeq = -1, limit?: number): GoalEvent[] {
    const statement = this.db.prepare("SELECT seq, at, type, payload_json FROM goal_events WHERE goal_id = ? AND seq > ? ORDER BY seq" + (limit === undefined ? "" : " LIMIT ?"));
    return (limit === undefined ? statement.all(id, afterSeq) : statement.all(id, afterSeq, limit)).map(row => ({ goalId: id, seq: Number(row.seq), at: Number(row.at),
        type: String(row.type), payload: JSON.parse(String(row.payload_json)) }));
  }

  /** Explicit user/API transition. Opening a store or recovering never resumes work. */
  requestRun(id: string, expectedVersion: number): Goal {
    return this.change(id, "goal-resume-requested", {}, goal => {
      this.checkVersion(goal, expectedVersion);
      if (terminal.has(goal.status) || goal.desiredState === "cancelled") {
        throw goalError("GOAL_TERMINAL", "A terminal goal cannot be resumed; create a new goal.");
      }
      if (goal.owner) throw goalError("GOAL_BUSY", "The previous executor still owns this goal.");
      return { ...goal, status: "ready", desiredState: "run", error: null };
    });
  }

  /** Scoped transient retry grant; never resets prior attempts or authorizes blind replay. */
  retryTransientFailure(id: string, expectedVersion: number, additionalAttempts = 3): Goal {
    if (!Number.isInteger(additionalAttempts) || additionalAttempts < 1 || additionalAttempts > 3) {
      throw goalError("GOAL_RETRY_GRANT_INVALID", "A transient retry grant must add between one and three attempts.");
    }
    return this.change(id, "goal-transient-retry-granted", { additionalAttempts }, goal => {
      this.checkVersion(goal, expectedVersion);
      const unfinished = goal.steps.filter(step => step.status !== "completed");
      if (goal.owner || goal.status !== "failed" || goal.desiredState === "cancelled"
        || goal.budget.expiresAt !== null || goal.error?.code !== "GOAL_BUDGET_EXHAUSTED"
        || !unfinished.length || unfinished.some(step => step.status !== "pending" || step.receipt !== null
          || !step.error || !transientFailures.has(step.error.code))
        || (goal.attempts < goal.budget.maxAttempts && !unfinished.some(step => step.attempts >= step.maxAttempts))) {
        throw goalError("GOAL_RETRY_NOT_ALLOWED", "Only an unowned, non-expiring goal exhausted by confirmed transient failures can receive an explicit retry grant.");
      }
      return { ...goal, status: "ready", desiredState: "run", error: null,
        budget: { ...goal.budget, maxAttempts: goal.budget.maxAttempts + additionalAttempts },
        steps: goal.steps.map(step => step.status === "completed" ? step : { ...step, maxAttempts: step.maxAttempts + additionalAttempts }) };
    });
  }

  requestStop(id: string, desiredState: "paused" | "cancelled", expectedVersion: number): Goal {
    return this.change(id, `goal-${desiredState}-requested`, {}, goal => {
      this.checkVersion(goal, expectedVersion);
      if (terminal.has(goal.status) || goal.desiredState === "cancelled") return goal;
      return { ...goal, desiredState, status: goal.owner ? "running" : desiredState };
    });
  }

  claim(id: string, leaseMs = 30_000): GoalLease | undefined {
    const token = randomUUID();
    const claimed = this.transaction(() => {
      const goal = this.get(id);
      if (goal.owner || goal.status !== "ready" || goal.desiredState !== "run") return false;
      const other = this.db.prepare("SELECT id FROM goals WHERE work_id = ? AND owner_token IS NOT NULL").get(goal.workId);
      if (other) return false;
      this.persist(this.next(goal, { status: "running", owner: { token, pid: process.pid, leaseUntil: this.now() + leaseMs } }),
        "goal-claimed", { token });
      return true;
    });
    if (!claimed) return undefined;
    this.owned.add(token); activeOwners.add(this.ownerKey(token));
    return { goalId: id, token };
  }

  /** Lease renewal must not invalidate an otherwise current user/API control version. */
  heartbeat(lease: GoalLease, leaseMs = 30_000): Goal {
    return this.transaction(() => {
      // Read under the write transaction so a recent stop or step update survives.
      const goal = this.get(lease.goalId);
      this.checkOwner(goal, lease);
      const now = this.now();
      const updated = GoalSchema.parse({ ...goal, updatedAt: now,
        owner: { ...goal.owner!, leaseUntil: now + leaseMs } });
      this.persist(updated, null, {});
      return updated;
    });
  }

  assertRunnable(lease: GoalLease): Goal {
    const goal = this.get(lease.goalId);
    this.checkOwner(goal, lease);
    if (goal.desiredState !== "run") throw goalError("GOAL_STOP_REQUESTED", `Goal is ${goal.desiredState}.`);
    if (goal.budget.expiresAt !== null && this.now() >= goal.budget.expiresAt) throw goalError("GOAL_BUDGET_EXHAUSTED", "Goal deadline exhausted.");
    return goal;
  }

  beginAttempt(lease: GoalLease, stepId: string, baselineState?: string): Goal {
    return this.change(lease.goalId, "step-started", { stepId }, goal => {
      this.checkOwner(goal, lease);
      this.assertRunnable(lease);
      const step = this.requireStep(goal, stepId);
      if (step.baselineState != null && step.baselineState !== baselineState) {
        throw goalError("GOAL_BASELINE_CHANGED", "Execution inputs changed since the previous attempt.");
      }
      if (step.status === "completed" || step.status === "running") throw goalError("GOAL_STEP_BUSY", "Step is already started or completed.");
      if (goal.attempts >= goal.budget.maxAttempts || step.attempts >= step.maxAttempts) {
        throw goalError("GOAL_BUDGET_EXHAUSTED", "Goal or step attempt budget exhausted.");
      }
      return { ...goal, attempts: goal.attempts + 1, steps: goal.steps.map(item => item.id === stepId
        ? { ...item, status: "running", attempts: item.attempts + 1, baselineState: baselineState ?? null, error: null } : item) };
    });
  }

  /** Caller holds the adapter scope and has just verified absent output and the same baseline. */
  compensateInterruptedAttempt(lease: GoalLease, stepId: string, attempt: number, baselineState: string): Goal {
    return this.change(lease.goalId, "step-interruption-compensated", { stepId, attempt }, goal => {
      this.checkOwner(goal, lease);
      this.assertRunnable(lease);
      const step = this.requireStep(goal, stepId);
      if (step.compensatedInterruptedAttempt === attempt) return goal;
      if (goal.budget.expiresAt !== null || step.status !== "running" || step.receipt !== null
        || step.attempts !== attempt || step.interruptedAttempt !== attempt
        || step.baselineState == null || step.baselineState !== baselineState) {
        throw goalError("GOAL_INTERRUPTION_NOT_RETRYABLE", "The interrupted attempt has no matching, safely reconciled baseline.");
      }
      return { ...goal, budget: { ...goal.budget, maxAttempts: goal.budget.maxAttempts + 1 },
        steps: goal.steps.map(item => item.id !== stepId ? item : { ...item,
          status: "pending", maxAttempts: item.maxAttempts + 1, compensatedInterruptedAttempt: attempt,
          error: { code: "GOAL_ATTEMPT_INTERRUPTED", message: "Interrupted work settled without output on the same baseline." } }) };
    });
  }

  recordStep(lease: GoalLease, stepId: string, result:
    | { readonly status: "completed"; readonly receipt: GoalReceipt }
    | { readonly status: "pending" | "reconciliation_required" | "waiting_user" | "failed"; readonly error: GoalError }): Goal {
    return this.change(lease.goalId, `step-${result.status}`, { stepId, ...result }, goal => {
      this.checkOwner(goal, lease);
      const step = this.requireStep(goal, stepId);
      if (result.status === "completed" && GoalReceiptSchema.parse(result.receipt).operationKey !== step.operationKey) {
        throw goalError("GOAL_RECEIPT_MISMATCH", "Receipt does not belong to this operation.");
      }
      if (result.status === "completed" && step.receipt && goalInputValue(step.receipt) !== goalInputValue(result.receipt)) {
        throw goalError("GOAL_RECEIPT_CHANGED", "An accepted receipt cannot be replaced with a different output.");
      }
      const completed = result.status === "completed";
      return { ...goal, lastProgressAt: completed && step.status !== "completed" ? this.now() : goal.lastProgressAt,
        steps: goal.steps.map(item => item.id !== stepId ? item : { ...item, status: result.status,
          receipt: completed ? result.receipt : item.receipt, error: completed ? null : result.error }) };
    });
  }

  /** Call only after all adapter work has settled. Cancellation wins late receipts. */
  release(lease: GoalLease, status: Exclude<GoalStatus, "running">, error: GoalError | null = null): Goal {
    try {
      return this.transaction(() => {
        const goal = this.get(lease.goalId);
        this.checkOwner(goal, lease);
        let selected = goal.desiredState === "cancelled" ? "cancelled" : goal.desiredState === "paused" ? "paused" : status;
        let failure = error;
        // BEGIN IMMEDIATE can wait for another process and block JS timers.
        // Recheck after acquiring the write transaction, at the durable decision.
        if (selected === "completed" && goal.budget.expiresAt !== null && this.now() >= goal.budget.expiresAt) {
          selected = "failed";
          failure = { code: "GOAL_BUDGET_EXHAUSTED", message: "Goal deadline exhausted before completion committed." };
        }
        if (selected === "completed" && !goal.steps.every(step => step.status === "completed")) {
          throw goalError("GOAL_ACCEPTANCE_INCOMPLETE", "Every step must be verified before completion.");
        }
        const next = this.next(goal, { status: selected, owner: null, error: failure,
          steps: ["interrupted", "paused"].includes(selected) ? interruptedSteps(goal) : goal.steps });
        this.persist(next, "goal-released", { status: selected, error: failure });
        return next;
      });
    } finally { this.owned.delete(lease.token); activeOwners.delete(this.ownerKey(lease.token)); }
  }

  /** Lease expiry alone never proves that an uncooperative writer stopped. */
  recover(id: string, expectedVersion?: number): Goal {
    return this.change(id, "goal-owner-recovered", {}, goal => {
      if (expectedVersion !== undefined) this.checkVersion(goal, expectedVersion);
      if (!goal.owner || this.ownerAlive(goal.owner)) return goal;
      return { ...goal, owner: null, steps: interruptedSteps(goal),
        status: goal.desiredState === "cancelled" ? "cancelled" : goal.desiredState === "paused" ? "paused" : "interrupted",
        error: { code: "GOAL_INTERRUPTED", message: "Executor exited. Reconcile persisted effects before an explicit resume." } };
    });
  }

  close(): void {
    if (this.owned.size) throw goalError("GOAL_BUSY", "Drain owned work before closing the goal store.");
    this.db.close();
  }

  private ownerKey(token: string): string { return token; }
  private ownerAlive(owner: NonNullable<Goal["owner"]>): boolean {
    return owner.pid === process.pid ? activeOwners.has(this.ownerKey(owner.token)) : processAlive(owner.pid);
  }
  private checkOwner(goal: Goal, lease: GoalLease): void {
    if (goal.owner?.token !== lease.token || !this.owned.has(lease.token)) throw goalError("GOAL_OWNER_LOST", "Goal ownership changed.");
  }
  private checkVersion(goal: Goal, expected: number): void {
    if (goal.version !== expected) throw goalError("GOAL_VERSION_CONFLICT", "Goal changed. Read its latest state first.");
  }
  private requireStep(goal: Goal, stepId: string) {
    const step = goal.steps.find(item => item.id === stepId);
    if (!step) throw goalError("GOAL_STEP_NOT_FOUND", `Unknown goal step: ${stepId}`);
    return step;
  }
  private next(goal: Goal, update: Partial<Goal>): Goal {
    return GoalSchema.parse({ ...goal, ...update, version: goal.version + 1, updatedAt: this.now() });
  }
  private change(id: string, type: string | null, payload: Record<string, unknown>, change: (goal: Goal) => Goal): Goal {
    return this.transaction(() => {
      const goal = this.get(id), updated = change(goal);
      if (updated === goal) return goal;
      const next = this.next(goal, updated);
      this.persist(next, type, payload);
      return next;
    });
  }
  private persist(goal: Goal, type: string | null, payload: Record<string, unknown>): void {
    const { steps, ...data } = goal;
    this.db.prepare("UPDATE goals SET owner_token = ?, data_json = ? WHERE id = ?")
      .run(goal.owner?.token ?? null, JSON.stringify(data), goal.id);
    const insert = this.db.prepare(`INSERT INTO goal_steps(goal_id, ordinal, id, operation_key, data_json) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(goal_id, id) DO UPDATE SET data_json = excluded.data_json`);
    steps.forEach((step, index) => insert.run(goal.id, index, step.id, step.operationKey, JSON.stringify(step)));
    if (type) this.db.prepare(`INSERT INTO goal_events(goal_id, seq, at, type, payload_json)
      SELECT ?, COALESCE(MAX(seq), -1) + 1, ?, ?, ? FROM goal_events WHERE goal_id = ?`)
      .run(goal.id, this.now(), type, JSON.stringify(payload), goal.id);
  }
  private transaction<T>(task: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = task(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
}

/** Record interruption only after executor cleanup, or after a positively dead owner is recovered. */
function interruptedSteps(goal: Goal): Goal["steps"] {
  return goal.steps.map(step => step.status === "running" && step.attempts > 0 && step.receipt === null
    ? { ...step, interruptedAttempt: step.attempts } : step);
}
