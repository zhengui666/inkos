import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArchitectAgent } from '../agents/architect.js';
import { CreationTaskCoordinator } from '../creation/coordinator.js';
import { inferCreationPlan } from '../creation/contracts.js';
import { isCreationTransientFailure } from '../creation/transient.js';
import { PipelineRunner } from '../pipeline/runner.js';
import { SchedulerStore } from '../pipeline/scheduler-store.js';

afterEach(() => { vi.restoreAllMocks(); });
const failure = (code: string) => Object.assign(new Error(`Offline fixture: ${code}`), { code });

describe('creation transient failures through retained-artifact wrappers', () => {
  it.each(['MODEL_UNAVAILABLE', 'WORKER_TIMEOUT', 'ECONNRESET', 'ETIMEDOUT', 'RATE_LIMITED'])
  ('recognizes the retained %s cause without parsing human-readable text', code => {
    const wrapped = new Error('Foundation candidate retained', { cause: new Error('Operation failed', { cause: failure(code) }) });
    expect(isCreationTransientFailure(wrapped)).toBe(true);
  });

  it.each(['CODEX_AUTH_REQUIRED', 'CHAPTER_STATE_SYNC_REQUIRED', 'QUALITY_FAILED', 'REMOTE_WORK_OUTCOME_UNKNOWN'])
  ('does not bypass explicit %s gates in a wrapper', code => {
    expect(isCreationTransientFailure(Object.assign(new Error('Gate', { cause: failure('MODEL_UNAVAILABLE') }), { code }))).toBe(false);
  });

  it('does not retry uncertain cleanup aggregates, even if their underlying model failure is transient', () => {
    const aggregate = new AggregateError([failure('MODEL_UNAVAILABLE'), new Error('Candidate persistence failed')],
      'Creation and cleanup failed', { cause: failure('MODEL_UNAVAILABLE') });
    expect(isCreationTransientFailure(aggregate)).toBe(false);
  });

  it('fails closed for unknown causes, misleading text, and cyclic wrappers', () => {
    expect(isCreationTransientFailure(new Error('MODEL_UNAVAILABLE'))).toBe(false);
    expect(isCreationTransientFailure(new Error('Wrapped', { cause: failure('UNKNOWN') }))).toBe(false);
    const cyclic = new Error('Cyclic'); cyclic.cause = cyclic;
    expect(isCreationTransientFailure(cyclic)).toBe(false);
    expect(isCreationTransientFailure(undefined)).toBe(false);
  });

  it('keeps real foundation preservation failures retryable across a database reopen', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inkos-transient-foundation-'));
    const scheduler = new SchedulerStore(join(root, '.inkos', 'harness.sqlite'));
    const pipeline = new PipelineRunner({ projectRoot: root, client: {} as any, model: 'offline-fixture' });
    let coordinator = new CreationTaskCoordinator(root, pipeline, scheduler, 1000);
    const generate = vi.spyOn(ArchitectAgent.prototype, 'generateFoundation').mockRejectedValue(failure('ECONNRESET'));
    try {
      const request = { id: randomUUID(), kind: 'short' as const, brief: 'Offline foundation recovery fixture only.' };
      const created = coordinator.tasks.create(request, inferCreationPlan(request,
        { language: 'en', daemon: { market: { platform: 'fixture', language: 'en' } } } as any));
      coordinator.tasks.update(created.id, task => ({ ...task, planStatus: 'ready' }));
      const retained = [];
      for (let attempt = 1; attempt <= 4; attempt++) {
        coordinator.tasks.update(created.id, task => ({ ...task, nextAttemptAt: 0 }));
        await coordinator.prepare(created.id, new AbortController().signal);
        retained.push(coordinator.tasks.get(created.id));
        if (attempt === 2) {
          coordinator.close();
          coordinator = new CreationTaskCoordinator(root, pipeline, scheduler, 1000);
        }
      }
      expect(generate).toHaveBeenCalledTimes(4);
      for (const [index, task] of retained.entries()) {
        expect(task).toMatchObject({ foundation: 'pending', phase: 'queued',
          foundationAttempts: index + 1, foundationTransientFailures: index + 1 });
        expect(task.nextAttemptAt).toBeGreaterThan(task.updatedAt);
      }
      expect(scheduler.chapters(created.workId)).toEqual([]);
      expect(await readFile(join(root, 'works', created.workId, 'source', 'story', 'brief.md'), 'utf8')).toContain(request.brief);
    } finally { coordinator.close(); scheduler.close(); await rm(root, { recursive: true, force: true }); }
  });
});
