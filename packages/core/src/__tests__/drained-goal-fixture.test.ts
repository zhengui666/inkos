import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { GoalExecutor } from "../goals/executor.js";
import { GoalStore } from "../goals/store.js";
import { type GoalStepAdapter, goalError } from "../goals/contracts.js";
import { DrainedTestScope } from "./fixtures/drained-test-scope.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe("chapter goal fixture cleanup", () => {
  it.each([false, true])("drains slow I/O before releasing ownership and reopening files, output=%s", async committed => {
    const root = await mkdtemp(join(tmpdir(), "inkos-goal-drain-")), path = join(root, "harness.sqlite");
    const scope = new DrainedTestScope(), entered = deferred(), finishIO = deferred(), bodyCleanup = deferred();
    const store = new GoalStore(path), other = new GoalStore(path);
    let reopened: GoalStore | undefined;
    let hasOutput = false, handleClosed = false, drained = false;
    const execute = vi.fn(async () => {
      const handle = await open(join(root, "output.txt"), "w");
      try {
        entered.resolve();
        // Deliberately uncooperative I/O: abort cannot make its ownership disappear.
        await finishIO.promise;
        if (committed) { await handle.writeFile("durable fixture output"); hasOutput = true; }
        else throw goalError("MODEL_UNAVAILABLE", "Fixture transport failed after slow I/O.");
      } finally { await handle.close(); handleClosed = true; }
    });
    const adapter: GoalStepAdapter = {
      kind: "fixture", retrySafe: true, withScope: (_context, task) => task(), execute,
      isRetryable: () => true,
      reconcile: async context => hasOutput
        ? { status: "completed", receipt: { operationKey: context.step.operationKey, artifacts: [], evidence: { output: "saved" } } }
        : { status: "absent", baselineState: "unchanged" },
    };
    try {
      store.create({ id: "goal", workId: "fixture", intent: "Offline cleanup regression",
        budget: { maxAttempts: 2, expiresAt: null },
        steps: [{ id: "step", kind: "fixture", input: {}, maxAttempts: 2 }] });
      store.requestRun("goal", store.get("goal").version);
      const work = scope.run(async signal => {
        const result = await new GoalExecutor(store, [adapter], 0).run("goal", signal);
        await bodyCleanup.promise;
        return result;
      });
      await entered.promise;
      const cleanup = scope.drain().then(() => { drained = true; });
      expect(scope.signal.aborted).toBe(true);
      expect(() => store.close()).toThrow(/Drain owned work/);
      expect(other.recover("goal").owner).not.toBeNull();
      expect(other.claim("goal")).toBeUndefined();
      expect(drained).toBe(false); expect(handleClosed).toBe(false);
      finishIO.resolve();
      await vi.waitFor(() => expect(store.get("goal").owner).toBeNull());
      expect(handleClosed).toBe(true); expect(drained).toBe(false);
      bodyCleanup.resolve();
      const stopped = await work; await cleanup;
      expect(stopped.status).toBe("interrupted");
      expect(stopped.attempts).toBe(1);
      expect(stopped.budget.maxAttempts).toBe(2);
      expect(stopped.steps[0]!.maxAttempts).toBe(2);
      expect(stopped.steps[0]!.receipt !== null).toBe(committed);
      expect(store.events("goal").some(event => event.type === "step-interruption-compensated")).toBe(false);
      store.close(); other.close(); reopened = new GoalStore(path);
      reopened.requestRun("goal", reopened.get("goal").version);
      adapter.execute = async () => { hasOutput = true; };
      expect((await new GoalExecutor(reopened, [adapter], 0).run("goal")).status).toBe("completed");
      expect(reopened.get("goal").attempts).toBe(committed ? 1 : 2);
      expect(execute).toHaveBeenCalledTimes(1);
      if (committed) expect(await readFile(join(root, "output.txt"), "utf8")).toBe("durable fixture output");
      reopened.close(); reopened = undefined;
      // Windows refuses this if SQLite/WAL or the slow output still has an open handle.
      await rm(root, { recursive: true });
    } finally {
      finishIO.resolve(); bodyCleanup.resolve(); await scope.drain();
      if (reopened) reopened.close();
      // Close may be repeated after successful explicit closure in this test.
      for (const handle of [store, other]) { try { handle.close(); } catch (error) { if ((error as { code?: string }).code !== "ERR_INVALID_STATE") throw error; } }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps failed test bodies tracked until their asynchronous cleanup finishes", async () => {
    const scope = new DrainedTestScope(), entered = deferred(), release = deferred();
    const failure = new Error("fixture assertion failed");
    let cleaned = false, drained = false;
    const work = scope.run(async () => {
      try { entered.resolve(); throw failure; }
      finally { await release.promise; cleaned = true; }
    });
    const rejected = expect(work).rejects.toBe(failure);
    await entered.promise;
    const cleanup = scope.drain().then(() => { drained = true; });
    expect(drained).toBe(false); expect(cleaned).toBe(false);
    release.resolve(); await rejected; await cleanup;
    expect(cleaned).toBe(true); expect(drained).toBe(true);
    expect(() => scope.run(async () => undefined)).toThrow(/fixture is closing/);
  });
});
