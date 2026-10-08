import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GoalExecutor } from '../goals/executor.js';
import { GoalStore } from '../goals/store.js';
import { goalError, type GoalReceipt, type GoalStepAdapter } from '../goals/contracts.js';

const roots: string[] = [], stores: GoalStore[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  stores.splice(0).forEach(store => store.close());
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function setup(enabled = true, expiresAt: number | null = null) {
  const root = await mkdtemp(join(tmpdir(), 'inkos-interruption-')); roots.push(root);
  const store = new GoalStore(join(root, '.inkos/harness.sqlite')); stores.push(store);
  const controller = new AbortController();
  let locked = false, receipt: GoalReceipt | undefined, baseline: string | undefined = 'same baseline';
  const adapter: GoalStepAdapter = {
    kind: 'fixture', retrySafe: true,
    withScope: async (_context, run) => { locked = true; try { return await run(); } finally { locked = false; } },
    reconcile: async () => receipt ? { status: 'completed', receipt } : { status: 'absent', baselineState: baseline },
    execute: vi.fn(async () => { controller.abort(new Error('fixture pause')); throw controller.signal.reason; }),
    isRetryable: () => false,
  };
  store.create({ id: 'fixture', workId: 'fixture', intent: 'Offline lifecycle fixture',
    budget: { maxAttempts: 1, expiresAt }, steps: [{ id: 'one', kind: 'fixture', input: {}, maxAttempts: 1 }] });
  const executor = new GoalExecutor(store, [adapter], 0, { compensateInterruptedAttempts: enabled });
  const resume = () => { const goal = store.get('fixture'); store.requestRun(goal.id, goal.version); };
  const complete = () => { adapter.execute = vi.fn(async context => {
    receipt = { operationKey: context.step.operationKey, artifacts: [], evidence: { fixtureOnly: true } };
  }); };
  return { root, store, adapter, controller, executor, resume, complete,
    setBaseline: (value: string | undefined) => { baseline = value; },
    locked: () => locked };
}

describe('creation interrupted-attempt compensation, offline', () => {
  it('compensates once under the adapter lock after absence and identical baseline, preserving cumulative attempts', async () => {
    const f = await setup(); f.resume();
    const paused = await f.executor.run('fixture', f.controller.signal);
    expect(paused).toMatchObject({ status: 'interrupted', attempts: 1, budget: { maxAttempts: 1 } });
    expect(paused.steps[0]).toMatchObject({ status: 'running', interruptedAttempt: 1, attempts: 1 });
    const original = f.store.compensateInterruptedAttempt.bind(f.store);
    vi.spyOn(f.store, 'compensateInterruptedAttempt').mockImplementation((...args) => {
      expect(f.locked()).toBe(true); return original(...args);
    });
    // Repeated Resume requests do not grant budget; only locked reconciliation can.
    f.resume(); f.resume();
    expect(f.store.get('fixture').budget.maxAttempts).toBe(1);
    f.complete();
    const done = await f.executor.run('fixture');
    expect(done).toMatchObject({ status: 'completed', attempts: 2, budget: { maxAttempts: 2 } });
    expect(done.steps[0]).toMatchObject({ attempts: 2, maxAttempts: 2, compensatedInterruptedAttempt: 1 });
    expect(f.store.events('fixture').filter(event => event.type === 'step-interruption-compensated')).toHaveLength(1);
    await f.executor.run('fixture');
    expect(f.adapter.execute).toHaveBeenCalledOnce();
  });

  it('fences a duplicate compensation for the same interrupted attempt', async () => {
    const f = await setup(); f.resume(); await f.executor.run('fixture', f.controller.signal);
    const original = f.store.compensateInterruptedAttempt.bind(f.store);
    vi.spyOn(f.store, 'compensateInterruptedAttempt').mockImplementation((...args) => {
      const granted = original(...args);
      expect(original(...args)).toEqual(granted);
      return granted;
    });
    f.complete(); f.resume();
    const done = await f.executor.run('fixture');
    expect(done).toMatchObject({ status: 'completed', attempts: 2, budget: { maxAttempts: 2 } });
    expect(f.store.events('fixture').filter(event => event.type === 'step-interruption-compensated')).toHaveLength(1);
  });

  it('does not treat a Resume before any execution as an interrupted attempt', async () => {
    const f = await setup(); f.resume(); f.resume(); f.complete();
    const done = await f.executor.run('fixture');
    expect(done).toMatchObject({ status: 'completed', attempts: 1, budget: { maxAttempts: 1 } });
    expect(done.steps[0]?.compensatedInterruptedAttempt).toBeUndefined();
  });

  it('grants exactly one replacement per distinct interrupted attempt', async () => {
    const f = await setup();
    for (let n = 1; n <= 3; n++) {
      const abort = new AbortController();
      f.adapter.execute = async () => { abort.abort(); throw abort.signal.reason; };
      f.resume(); const stopped = await f.executor.run('fixture', abort.signal);
      expect(stopped).toMatchObject({ status: 'interrupted', attempts: n, budget: { maxAttempts: n } });
      expect(stopped.steps[0]?.interruptedAttempt).toBe(n);
    }
    f.complete(); f.resume();
    const done = await f.executor.run('fixture');
    expect(done).toMatchObject({ status: 'completed', attempts: 4, budget: { maxAttempts: 4 } });
    expect(f.store.events('fixture').filter(event => event.type === 'step-interruption-compensated')).toHaveLength(3);
  });

  it('persists compensation across a stop and database reopen before the replacement attempt', async () => {
    const f = await setup(); f.resume(); await f.executor.run('fixture', f.controller.signal);
    const original = f.store.compensateInterruptedAttempt.bind(f.store);
    vi.spyOn(f.store, 'compensateInterruptedAttempt').mockImplementation((...args) => {
      const granted = original(...args);
      f.store.requestStop(granted.id, 'paused', granted.version);
      return granted;
    });
    f.complete(); f.resume();
    const paused = await f.executor.run('fixture');
    expect(paused).toMatchObject({ status: 'paused', attempts: 1, budget: { maxAttempts: 2 } });
    f.store.close(); stores.splice(stores.indexOf(f.store), 1);
    const reopened = new GoalStore(join(f.root, '.inkos/harness.sqlite')); stores.push(reopened);
    const current = reopened.get('fixture'); reopened.requestRun(current.id, current.version);
    const done = await new GoalExecutor(reopened, [f.adapter], 0, { compensateInterruptedAttempts: true }).run('fixture');
    expect(done).toMatchObject({ status: 'completed', attempts: 2, budget: { maxAttempts: 2 } });
    expect(reopened.events('fixture').filter(event => event.type === 'step-interruption-compensated')).toHaveLength(1);
    expect(f.adapter.execute).toHaveBeenCalledOnce();
  });

  it('recovers a positively dead owner without granting until the next locked reconciliation', async () => {
    const f = await setup(); f.resume();
    const child = spawn(process.execPath, ['-e', "process.stdout.write('ready'); setInterval(() => {}, 1000)"], { stdio: ['ignore', 'pipe', 'ignore'] });
    try {
      await once(child.stdout!, 'data');
      const { steps, ...goal } = f.store.get('fixture');
      goal.owner = { token: 'fixture-foreign-owner', pid: child.pid!, leaseUntil: 0 };
      goal.status = 'running'; goal.attempts = 1;
      Object.assign(steps[0]!, { status: 'running', attempts: 1, baselineState: 'same baseline' });
      const db = new DatabaseSync(join(f.root, '.inkos/harness.sqlite'));
      try {
        db.prepare('UPDATE goals SET owner_token=?, data_json=? WHERE id=?').run(goal.owner.token, JSON.stringify(goal), goal.id);
        db.prepare('UPDATE goal_steps SET data_json=? WHERE goal_id=?').run(JSON.stringify(steps[0]), goal.id);
      } finally { db.close(); }
      expect(f.store.recover('fixture').owner).not.toBeNull();
      const exited = once(child, 'exit'); child.kill(); await exited;
      const recovered = f.store.recover('fixture');
      expect(recovered).toMatchObject({ status: 'interrupted', attempts: 1, budget: { maxAttempts: 1 } });
      expect(recovered.steps[0]?.interruptedAttempt).toBe(1);
      f.complete(); f.resume();
      expect(await f.executor.run('fixture')).toMatchObject({ status: 'completed', attempts: 2, budget: { maxAttempts: 2 } });
    } finally {
      if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    }
  });

  it('requires executor cleanup to settle before recording interruption or admitting a replacement', async () => {
    const f = await setup(); let release!: () => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    f.adapter.execute = async () => { f.controller.abort(); entered(); await new Promise<void>(resolve => { release = resolve; }); };
    f.resume(); const run = f.executor.run('fixture', f.controller.signal); await started;
    expect(f.store.get('fixture').steps[0]?.interruptedAttempt).toBeUndefined();
    expect(() => f.resume()).toThrowError(expect.objectContaining({ code: 'GOAL_BUSY' }));
    release(); await run;
    expect(f.store.get('fixture').steps[0]?.interruptedAttempt).toBe(1);
  });

  it.each(['changed', 'missing', 'unknown', 'unsafe'] as const)('does not compensate when resumed reconciliation is %s', async kind => {
    const f = await setup(); f.resume(); await f.executor.run('fixture', f.controller.signal);
    f.complete();
    if (kind === 'changed') f.setBaseline('changed baseline');
    if (kind === 'missing') f.setBaseline(undefined);
    if (kind === 'unknown') f.adapter.reconcile = async () => ({ status: 'unknown', error: { code: 'UNCERTAIN', message: 'Uncertain result' } });
    if (kind === 'unsafe') Object.assign(f.adapter, { retrySafe: false });
    f.resume(); const result = await f.executor.run('fixture');
    expect(result.status).toBe('reconciliation_required');
    expect(result.budget.maxAttempts).toBe(1);
    expect(f.adapter.execute).not.toHaveBeenCalled();
    expect(f.store.events('fixture').some(event => event.type === 'step-interruption-compensated')).toBe(false);
  });

  it('retains a late committed receipt without compensation or duplicate output', async () => {
    const f = await setup(); f.complete(); const commit = f.adapter.execute;
    f.adapter.execute = vi.fn(async context => { f.controller.abort(); await commit(context); });
    f.resume(); const interrupted = await f.executor.run('fixture', f.controller.signal);
    expect(interrupted.steps[0]?.status).toBe('completed');
    expect(interrupted.steps[0]?.interruptedAttempt).toBeUndefined();
    f.resume(); const result = await f.executor.run('fixture');
    expect(result).toMatchObject({ status: 'completed', attempts: 1, budget: { maxAttempts: 1 } });
    expect(f.adapter.execute).toHaveBeenCalledOnce();
  });

  it('does not reopen cancellation or convert cancellation into retry authority', async () => {
    const f = await setup(); f.adapter.execute = async () => {
      const goal = f.store.get('fixture'); f.store.requestStop(goal.id, 'cancelled', goal.version);
      f.controller.abort();
    };
    f.resume(); const cancelled = await f.executor.run('fixture', f.controller.signal);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.steps[0]?.interruptedAttempt).toBeUndefined();
    expect(() => f.resume()).toThrowError(expect.objectContaining({ code: 'GOAL_TERMINAL' }));
    expect(cancelled.budget.maxAttempts).toBe(1);
  });

  it.each([false, true])('does not compensate ordinary failure (enabled=%s)', async enabled => {
    const f = await setup(enabled); f.adapter.execute = async () => { throw goalError('QUALITY_FAILED', 'Fixture quality failure'); };
    f.resume(); const result = await f.executor.run('fixture');
    expect(result).toMatchObject({ status: 'failed', attempts: 1, budget: { maxAttempts: 1 } });
    expect(result.steps[0]?.interruptedAttempt).toBeUndefined();
  });

  it.each(['disabled', 'finite'] as const)('keeps existing goal budgets when compensation is %s', async mode => {
    const f = await setup(mode !== 'disabled', mode === 'finite' ? Date.now() + 60_000 : null);
    f.resume(); await f.executor.run('fixture', f.controller.signal); f.complete(); f.resume();
    const result = await f.executor.run('fixture');
    expect(result).toMatchObject({ status: 'failed', attempts: 1, error: { code: 'GOAL_BUDGET_EXHAUSTED' } });
    expect(f.adapter.execute).not.toHaveBeenCalled();
  });
});
