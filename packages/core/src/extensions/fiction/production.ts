import { defineTask, type TaskId, type WatchHandle } from '@earendil-works/pi-durable';
import { CronExpressionParser } from 'cron-parser';
import { randomUUID } from 'node:crypto';
import { ProjectDoc, Works } from '../../works/documents.js';
import { Distributions, PublishingTargets } from '../../publishing/documents.js';
import { distributionKey } from '../../publishing/contracts.js';
import { atBoundary, createContentTask } from './task.js';
import { bufferedUnits, completedUnits } from '../../works/progress.js';

export function nextProductionTime(cron: string | null, from: number): number {
  return cron ? CronExpressionParser.parse(cron, { currentDate: from }).next().getTime() : from;
}
export function createProductionTask(rootDir: string) {
  const content = createContentTask(rootDir);
  type Checkpoint = { phase: 'produce'; nextAt: number } | { phase: 'continue'; child: TaskId<{ artifactId: string; revisionId: string }> };
  return defineTask<{ workId: string }, Checkpoint, null, {}>({
    name: 'inkos.production', version: 1, initial: () => ({ phase: 'produce', nextAt: 0 }),
    phases: {
      produce: async (task, runtime, context) => {
        const work = await atBoundary(runtime, task.input.workId, context);
        const units = await completedUnits(runtime, work, context);
        if (!work.plan.serial && work.plan.units !== null && units >= work.plan.units) {
          await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: null } }), context); return;
        }
        const nextAt = work.plan.production.nextAt ?? task.state.checkpoint.nextAt;
        if (nextAt > runtime.now()) await runtime.sleep(nextAt, context);
        if ((work.plan.serial || work.targetIds.length > 0) && await bufferedUnits(runtime, work, context) >= work.plan.production.backlog) {
          // Native document watches, not a second scheduler: publishing and plan changes wake this step.
          const watches: (WatchHandle<unknown> | undefined)[] = [await runtime.watchDoc(Works, work.id, context), await runtime.watchDoc(ProjectDoc, context)];
          for (const id of work.targetIds) watches.push(await runtime.watchDoc(PublishingTargets, id, context));
          for (const artifactId of work.artifactIds) for (const targetId of work.targetIds) watches.push(await runtime.watchDoc(Distributions, distributionKey(targetId, artifactId), context));
          let wake!: () => void, stop!: (error: unknown) => void;
          const changed = new Promise<void>((resolve, reject) => { wake = resolve; stop = reject; });
          const abort = () => stop(runtime.signal.reason);
          runtime.signal.addEventListener('abort', abort, { once: true });
          try {
            for (const watch of watches) if (watch) { const initial = JSON.stringify(watch.value); watch.start(async () => { if (JSON.stringify(watch.value) !== initial) wake(); }); }
            const latest = await runtime.snapshot(Works, work.id, context);
            if (latest && !latest.pauseRequested && await bufferedUnits(runtime, latest, context) >= latest.plan.production.backlog) {
              runtime.signal.throwIfAborted(); await changed;
            }
          } finally { runtime.signal.removeEventListener('abort', abort); await Promise.all(watches.map(watch => watch?.stop())); }
          await runtime.commit(() => ({ status: 'running', checkpoint: { phase: 'produce', nextAt: runtime.now() } }), context); return;
        }
        await runtime.commit(async tx => {
          const child = await tx.createTask(content, { workId: work.id, artifactId: randomUUID(), revisionId: randomUUID(), title: `${work.title} — ${units + 1}` }, { ownership: { kind: 'task', taskId: task.id } });
          return { status: 'waiting', checkpoint: { phase: 'continue', child }, on: [child], policy: 'allSettled' };
        }, context);
      },
      continue: async (task, runtime, context) => {
        const [outcome] = await runtime.outcomes([task.state.checkpoint.child], context);
        if (outcome.status !== 'completed') { await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'failed', error: { name: 'CreationFailure', message: 'Content unit failed; no automatic rewrite' } } }), context); return; }
        const work = await atBoundary(runtime, task.input.workId, context);
        const nextAt = nextProductionTime(work.plan.production.cron, runtime.now());
        await runtime.commit(async tx => {
          (await tx.doc(Works, work.id, work)).plan.production.nextAt = nextAt;
          return { status: 'running', checkpoint: { phase: 'produce', nextAt } };
        }, context);
      },
    },
    abort: async (_task, runtime, context) => { await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context); },
  });
}
