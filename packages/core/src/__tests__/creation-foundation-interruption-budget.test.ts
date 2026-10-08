import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArchitectAgent } from '../agents/architect.js';
import { CreationTaskCoordinator } from '../creation/coordinator.js';
import { CreationPlannerAgent } from '../creation/planner.js';
import { inferCreationPlan } from '../creation/contracts.js';
import { PipelineRunner } from '../pipeline/runner.js';
import { SchedulerStore } from '../pipeline/scheduler-store.js';

afterEach(() => { vi.restoreAllMocks(); });

describe('foundation interruption failure allowance, isolated actual preservation flow', () => {
  it('does not spend the later failure allowance on settled pauses across reopen', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inkos-foundation-pause-budget-'));
    const scheduler = new SchedulerStore(join(root, '.inkos/harness.sqlite'));
    const pipeline = new PipelineRunner({ projectRoot: root, client: {} as any, model: 'offline-fixture' });
    let coordinator = new CreationTaskCoordinator(root, pipeline, scheduler, 1000);
    const generate = vi.spyOn(ArchitectAgent.prototype, 'generateFoundation');
    try {
      const request = { id: randomUUID(), kind: 'short' as const, brief: 'Disposable foundation pause and failure fixture.' };
      const created = coordinator.tasks.create(request, inferCreationPlan(request,
        { language: 'en', daemon: { market: { platform: 'fixture', language: 'en' } } } as any));
      coordinator.tasks.update(created.id, task => ({ ...task, planStatus: 'ready' }));
      for (let attempt = 1; attempt <= 3; attempt++) {
        coordinator.tasks.update(created.id, task => ({ ...task, nextAttemptAt: 0 }));
        const controller = new AbortController();
        generate.mockImplementationOnce(async () => {
          const task = coordinator.tasks.get(created.id);
          coordinator.tasks.control(task.id, 'paused', task.version);
          controller.abort(new Error('Explicit fixture pause'));
          throw controller.signal.reason;
        });
        await coordinator.prepare(created.id, controller.signal);
        expect(coordinator.tasks.get(created.id)).toMatchObject({ foundation: 'pending', desiredState: 'paused', foundationAttempts: attempt });
        coordinator.close(); coordinator = new CreationTaskCoordinator(root, pipeline, scheduler, 1000);
        let task = coordinator.tasks.get(created.id);
        task = coordinator.tasks.control(task.id, 'run', task.version);
        task = coordinator.tasks.control(task.id, 'paused', task.version);
        task = coordinator.tasks.control(task.id, 'run', task.version);
        expect(task.foundationAttempts).toBe(attempt);
      }
      generate.mockRejectedValue(Object.assign(new Error('Settled nontransient fixture failure'), { code: 'FIXTURE_FOUNDATION_FAILURE' }));
      for (let failure = 1; failure <= 3; failure++) {
        coordinator.tasks.update(created.id, task => ({ ...task, nextAttemptAt: 0 }));
        await coordinator.prepare(created.id, new AbortController().signal);
        expect(coordinator.tasks.get(created.id)).toMatchObject({ foundationAttempts: failure + 3,
          foundation: failure === 3 ? 'blocked' : 'pending', phase: failure === 3 ? 'blocked' : 'queued' });
      }
      expect(generate).toHaveBeenCalledTimes(6);
      expect(scheduler.chapters(created.workId)).toEqual([]);
      expect(await readFile(join(root, 'works', created.workId, 'source/story/brief.md'), 'utf8')).toContain(request.brief);
    } finally { coordinator.close(); scheduler.close(); await rm(root, { recursive: true, force: true }); }
  });

  it.each([0, 1])('retains conservative legacy failures before an interrupted attempt (known transient failures: %s)', async knownTransient => {
    const root = await mkdtemp(join(tmpdir(), 'inkos-legacy-foundation-budget-'));
    const scheduler = new SchedulerStore(join(root, '.inkos/harness.sqlite'));
    const pipeline = new PipelineRunner({ projectRoot: root, client: {} as any, model: 'offline-fixture' });
    const coordinator = new CreationTaskCoordinator(root, pipeline, scheduler, 1000);
    try {
      const request = { id: randomUUID(), kind: 'short' as const, brief: 'Legacy foundation accounting fixture only.' };
      const created = coordinator.tasks.create(request, inferCreationPlan(request,
        { language: 'en', daemon: { market: { platform: 'fixture', language: 'en' } } } as any));
      coordinator.tasks.update(created.id, current => {
        const { foundationFailures: _unknown, ...legacy } = current;
        return {...legacy, planStatus: 'ready', foundationAttempts: 2, foundationTransientFailures: knownTransient, nextAttemptAt: 0};
      });
      const controller = new AbortController();
      const generate = vi.spyOn(ArchitectAgent.prototype, 'generateFoundation').mockImplementationOnce(async () => {
        const task = coordinator.tasks.get(created.id); coordinator.tasks.control(task.id, 'paused', task.version);
        controller.abort(new Error('Explicit legacy fixture pause')); throw controller.signal.reason;
      });
      await coordinator.prepare(created.id, controller.signal);
      let task = coordinator.tasks.get(created.id);
      expect(task).toMatchObject({foundationAttempts: 3, foundationFailures: 2 - knownTransient, foundation: 'pending'});
      coordinator.tasks.control(task.id, 'run', task.version);
      coordinator.tasks.update(task.id, current => ({...current, nextAttemptAt: 0}));
      generate.mockRejectedValue(new Error('Settled actual failure'));
      await coordinator.prepare(task.id, new AbortController().signal);
      task = coordinator.tasks.get(task.id);
      expect(task).toMatchObject({foundationAttempts: 4, foundationFailures: 3 - knownTransient,
        foundation: knownTransient ? 'pending' : 'blocked'});
    } finally { coordinator.close(); scheduler.close(); await rm(root, { recursive: true, force: true }); }
  });

  it('does not charge a pause after plan persistence when prepare returns before foundation dispatch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inkos-planner-pause-budget-'));
    const scheduler = new SchedulerStore(join(root, '.inkos/harness.sqlite'));
    const pipeline = new PipelineRunner({ projectRoot: root, client: {} as any, model: 'offline-fixture' });
    const coordinator = new CreationTaskCoordinator(root, pipeline, scheduler, 1000);
    try {
      const request = { id: randomUUID(), kind: 'short' as const, brief: 'Planner pause accounting fixture only.' };
      const created = coordinator.tasks.create(request, inferCreationPlan(request,
        { language: 'en', daemon: { market: { platform: 'fixture', language: 'en' } } } as any));
      const generate = vi.spyOn(ArchitectAgent.prototype, 'generateFoundation').mockRejectedValue(new Error('Settled actual failure'));
      vi.spyOn(CreationPlannerAgent.prototype, 'plan').mockImplementationOnce(async () => {
        const task = coordinator.tasks.get(created.id); coordinator.tasks.control(task.id, 'paused', task.version);
        return {plan: {...created.plan, blurb: 'Public synthetic fixture blurb.'}, endingIntent: 'Deliver the fixture ending.', summary: 'Synthetic semantic plan.'};
      });
      await coordinator.prepare(created.id, new AbortController().signal);
      let task = coordinator.tasks.get(created.id);
      expect(task).toMatchObject({planStatus: 'ready', desiredState: 'paused', foundationAttempts: 1, foundationFailures: 0});
      expect(generate).not.toHaveBeenCalled();
      coordinator.tasks.control(task.id, 'run', task.version);
      coordinator.tasks.update(task.id, current => ({...current, nextAttemptAt: 0}));
      await coordinator.prepare(task.id, new AbortController().signal);
      task = coordinator.tasks.get(task.id);
      expect(task).toMatchObject({foundationAttempts: 2, foundationFailures: 1, foundation: 'pending'});
      expect(generate).toHaveBeenCalledOnce();
    } finally { coordinator.close(); scheduler.close(); await rm(root, { recursive: true, force: true }); }
  });

});
