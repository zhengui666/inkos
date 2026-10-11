import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock('../codex/client.js', () => ({ createCodexClient: mocks.createClient }));
import { CodexRuntimeFixtureScope } from './fixtures/codex-runtime-fixture.js';
import { ArchitectAgent } from '../agents/architect.js';
import { CreationTaskCoordinator } from '../creation/coordinator.js';
import { inferCreationPlan } from '../creation/contracts.js';
import { isCreationTransientFailure } from '../creation/transient.js';
import { PipelineRunner } from '../pipeline/runner.js';
import { SchedulerStore } from '../pipeline/scheduler-store.js';

let scope: CodexRuntimeFixtureScope;
const roots: string[] = [];
const closeAfterDrain: Array<() => void> = [];

beforeEach(() => {
  vi.stubEnv('INKOS_CODEX_HOME', undefined);
  vi.stubEnv('INKOS_CODEX_STATE_ROOT', undefined);
  scope = new CodexRuntimeFixtureScope();
  mocks.createClient.mockReset().mockImplementation(scope.createClient);
});

afterEach(async () => {
  try { await scope.drain(); }
  finally {
    try { for (const close of closeAfterDrain.splice(0)) close(); }
    finally {
      mocks.createClient.mockReset();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
    }
  }
});

async function registerProjectRoot(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return { root, project: scope.registerProject(root) };
}

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
    const { root, project } = await registerProjectRoot('inkos-transient-foundation-');
    const scheduler = new SchedulerStore(join(root, '.inkos', 'harness.sqlite'));
    const pipeline = new PipelineRunner({ projectRoot: root, client: {} as any, model: 'offline-fixture' });
    let coordinator = new CreationTaskCoordinator(root, pipeline, scheduler, 1000);
    closeAfterDrain.push(() => { coordinator.close(); scheduler.close(); });
    const generate = vi.spyOn(ArchitectAgent.prototype, 'generateFoundation').mockImplementation(async () => {
      expect(project.fixture.requests.some(request => request.method === 'account/read')).toBe(true);
      throw failure('ECONNRESET');
    });
    const request = { id: randomUUID(), kind: 'short' as const, brief: 'Offline foundation recovery fixture only.' };
    const created = coordinator.tasks.create(request, inferCreationPlan(request,
      { language: 'en', daemon: { market: { platform: 'fixture', language: 'en' } } } as any));
    coordinator.tasks.update(created.id, task => ({ ...task, planStatus: 'ready' }));
    const retained = [];
    for (let attempt = 1; attempt <= 4; attempt++) {
      coordinator.tasks.update(created.id, task => ({ ...task, nextAttemptAt: 0 }));
      await scope.run(signal => coordinator.prepare(created.id, signal));
      expect(generate).toHaveBeenCalledTimes(attempt);
      expect(project.fixture.requests.some(request => request.method === 'account/read')).toBe(true);
      expect(project.fixture.turns).toHaveLength(0);
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
  });
});
