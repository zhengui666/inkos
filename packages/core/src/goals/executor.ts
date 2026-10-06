import {
  goalError, goalFailure, goalInputValue,
  type Goal, type GoalError, type GoalLease, type GoalStatus, type GoalStepAdapter, type GoalStepContext,
} from "./contracts.js";
import { GoalStore } from "./store.js";

type StoppedStatus = "reconciliation_required" | "waiting_user" | "failed";
class StepStopped extends Error {
  constructor(readonly status: StoppedStatus, readonly failure: GoalError) { super(failure.message); }
}

/** One bounded, explicitly started run. No scheduler or automatic restart. */
export class GoalExecutor {
  private readonly adapters: Map<string, GoalStepAdapter>;
  constructor(readonly store: GoalStore, adapters: readonly GoalStepAdapter[],
    private readonly retryDelayMs = 1000) {
    this.adapters = new Map(adapters.map(adapter => [adapter.kind, adapter]));
    if (this.adapters.size !== adapters.length) throw new Error("Duplicate goal adapter kind.");
    if (!Number.isInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 60000) throw new Error("Retry delay must be 0–60000 milliseconds.");
  }

  async run(goalId: string, signal?: AbortSignal): Promise<Goal> {
    const lease = this.store.claim(goalId);
    if (!lease) return this.store.get(goalId);
    const controller = new AbortController();
    const boundedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const timer = this.watch(lease, controller);
    let status: Exclude<GoalStatus, "running"> = "interrupted", failure: GoalError | null = null;
    try {
      const stepIds = this.store.get(goalId).steps.map(step => step.id);
      for (const id of stepIds) await this.runStep(lease, id, boundedSignal);
      // Re-check all accepted receipts before goal acceptance, including those
      // skipped on resume. A deleted/revised output must not cause a rewrite.
      for (const id of stepIds) await this.runStep(lease, id, boundedSignal, true);
      this.check(lease, boundedSignal);
      status = "completed";
    } catch (error) {
      failure = error instanceof StepStopped ? error.failure : goalFailure(error);
      status = error instanceof StepStopped ? error.status
        : failure.code === "GOAL_BUDGET_EXHAUSTED" ? "failed"
          : boundedSignal.aborted ? "interrupted" : "reconciliation_required";
    } finally { clearInterval(timer); }
    // No Promise.race: adapter cleanup and host side effects have settled before
    // this point, even when the watchdog or user has already aborted the signal.
    return this.store.release(lease, status, failure);
  }

  private watch(lease: GoalLease, controller: AbortController): ReturnType<typeof setInterval> {
    let lastHeartbeat = this.store.now();
    const timer = setInterval(() => {
      try {
        this.store.assertRunnable(lease);
        if (this.store.now() - lastHeartbeat >= 5000) {
          this.store.heartbeat(lease); lastHeartbeat = this.store.now();
        }
      } catch (error) { controller.abort(error); }
    }, 100);
    timer.unref();
    return timer;
  }

  private check(lease: GoalLease, signal: AbortSignal): Goal {
    signal.throwIfAborted();
    return this.store.assertRunnable(lease);
  }

  private async runStep(lease: GoalLease, stepId: string, signal: AbortSignal, verifyOnly = false): Promise<void> {
    while (true) {
      const goal = this.check(lease, signal), step = goal.steps.find(item => item.id === stepId)!;
      const adapter = this.adapters.get(step.kind);
      if (!adapter) throw new StepStopped("reconciliation_required", { code: "GOAL_ADAPTER_UNAVAILABLE", message: `No adapter for ${step.kind}.` });
      const context: GoalStepContext = { goal, step, signal };
      const retry = await adapter.withScope(context, () => this.advance(lease, context, adapter, verifyOnly));
      if (!retry) return;
      await wait(Math.min(60_000, this.retryDelayMs * 2 ** Math.min(step.attempts, 6)), signal);
    }
  }

  private async advance(lease: GoalLease, context: GoalStepContext, adapter: GoalStepAdapter, verifyOnly: boolean): Promise<boolean> {
    const before = await adapter.reconcile(context);
    if (before.status === "completed") {
      if (context.step.receipt && goalInputValue(context.step.receipt) !== goalInputValue(before.receipt)) {
        return this.stop(lease, context, "GOAL_RECEIPT_CHANGED", "Previously accepted output changed.");
      }
      if (context.step.status !== "completed") this.store.recordStep(lease, context.step.id, before);
      this.check(lease, context.signal);
      return false;
    }
    if (before.status === "unknown") return this.stop(lease, context, before.error.code, before.error.message);
    if (before.status === "waiting_user") return this.stop(lease, context, before.error.code, before.error.message, "waiting_user");
    if (verifyOnly || context.step.receipt) return this.stop(lease, context, "GOAL_OUTPUT_CHANGED", "Previously accepted output is missing.");
    if (context.step.baselineState != null && context.step.baselineState !== before.baselineState) {
      return this.stop(lease, context, "GOAL_BASELINE_CHANGED", "Execution inputs changed since the previous attempt.");
    }
    if (context.step.attempts > 0 && !adapter.retrySafe) {
      return this.stop(lease, context, "GOAL_RECONCILIATION_REQUIRED", "This adapter cannot safely repeat an attempted operation.");
    }
    this.check(lease, context.signal);
    if (context.step.status === "running") this.store.recordStep(lease, context.step.id,
      { status: "pending", error: { code: "GOAL_ATTEMPT_INTERRUPTED", message: "Reconciliation confirmed no persisted output." } });
    const started = this.store.beginAttempt(lease, context.step.id, before.baselineState);
    const current: GoalStepContext = { goal: started, step: started.steps.find(step => step.id === context.step.id)!, signal: context.signal };
    let failure: unknown;
    try { await adapter.execute(current); } catch (error) { failure = error; }
    // A failed/aborted call can have committed an artifact. Reconcile before
    // deciding whether any retry is safe, while the adapter still holds its lock.
    const after = await adapter.reconcile(current);
    if (after.status === "completed") {
      this.store.recordStep(lease, context.step.id, after);
      this.check(lease, context.signal);
      return false;
    }
    if (after.status === "unknown") return this.stop(lease, current, after.error.code, after.error.message);
    if (after.status === "waiting_user") return this.stop(lease, current, after.error.code, after.error.message, "waiting_user");
    this.check(lease, context.signal);
    if (failure && adapter.retrySafe && adapter.isRetryable(failure)) {
      this.store.recordStep(lease, context.step.id, { status: "pending", error: goalFailure(failure) });
      return true;
    }
    if (failure) {
      const error = goalFailure(failure);
      this.store.recordStep(lease, context.step.id, { status: "failed", error });
      throw new StepStopped("failed", error);
    }
    return this.stop(lease, current, "GOAL_OUTPUT_UNCONFIRMED", "Execution returned without a verifiable committed output.");
  }

  private stop(lease: GoalLease, context: GoalStepContext, code: string, message: string,
    status: "reconciliation_required" | "waiting_user" = "reconciliation_required"): never {
    const error = { code, message };
    this.store.recordStep(lease, context.step.id, { status, error });
    throw new StepStopped(status, error);
  }
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const finish = () => { signal.removeEventListener("abort", abort); resolve(); };
    const timer = setTimeout(finish, ms);
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(signal.reason ?? goalError("GOAL_INTERRUPTED", "Run interrupted.")); };
    signal.addEventListener("abort", abort, { once: true });
  });
}
