import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const boundary = vi.hoisted(() => ({ plan: vi.fn(), init: vi.fn(), onSkills: undefined as undefined | (() => Promise<void>) }));
vi.mock('../creation/planner.js', () => ({ CreationPlannerAgent: class { plan(...args: any[]) { return boundary.plan(...args); } } }));
vi.mock('../pipeline/runner.js', () => ({ PipelineRunner: class {
  createAgentContext() { return {}; }
  runWithAgentContext(_context: any, run: any) { return run(); }
  initBook(...args: any[]) { return boundary.init(...args); }
} }));
vi.mock('../skills/index.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../skills/index.js')>();
  return { ...actual, loadAvailableAgentSkills: async (...args: Parameters<typeof actual.loadAvailableAgentSkills>) => {
    const result = await actual.loadAvailableAgentSkills(...args); await boundary.onSkills?.(); return result;
  } };
});
import { StateManager } from '../state/manager.js';
import { CreationTaskStore } from '../creation/store.js';
import { inferCreationPlan } from '../creation/contracts.js';
import { SchedulerStore } from '../pipeline/scheduler-store.js';
import { Scheduler } from '../pipeline/scheduler.js';
import { loadWorkManifest, saveWorkManifest } from '../harness/work-store.js';
import type { BookStatus } from '../models/book.js';

const roots: string[] = [], tasks: CreationTaskStore[] = [], schedulers: Scheduler[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  boundary.onSkills = undefined;
  boundary.plan.mockImplementation(async (_request, plan) => ({ plan, summary: 'Offline fixture only', endingIntent: 'Keep the author’s ending' }));
  // Positive controls stop once admission is proved; no foundation/model is run.
  boundary.init.mockRejectedValue(new Error('Offline fixture stops at foundation dispatch'));
});
afterEach(async () => {
  await Promise.all(schedulers.splice(0).map(scheduler => scheduler.stop()));
  tasks.splice(0).forEach(store => store.close());
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture(status?: BookStatus, planReady = false) {
  const root = await mkdtemp(join(tmpdir(), 'inkos-book-pause-recovery-')); roots.push(root);
  const store = new CreationTaskStore(join(root, '.inkos/harness.sqlite')); tasks.push(store);
  const request = { id: randomUUID(), kind: 'long' as const, brief: 'A synthetic mystery whose existing author direction must survive.' };
  let task = store.create(request, inferCreationPlan(request, { language: 'en', daemon: { market: { platform: 'offline-fixture', language: 'en' } } } as any));
  task = store.update(task.id, current => ({ ...current, foundationAttempts: 1, nextAttemptAt: 0, ...(planReady ? { planStatus: 'ready' as const } : {}) }));
  const state = new StateManager(root);
  if (status) {
    const now = new Date().toISOString();
    await state.saveBookConfig(task.workId, { id: task.workId, title: 'Original title', genre: 'mystery', platform: 'offline-fixture',
      language: 'en', status, targetChapters: 20, chapterWordCount: 1700, createdAt: now, updatedAt: now });
    await mkdir(join(state.bookDir(task.workId), 'story'), { recursive: true });
    await writeFile(join(state.bookDir(task.workId), 'story/author_intent.md'), 'Keep the original promise.\n');
  }
  const publisher = { ready: vi.fn(), publish: vi.fn(), reconcile: vi.fn() };
  async function restart() {
    const ledger = new SchedulerStore(join(root, '.inkos/harness.sqlite'));
    ledger.schedule('radar', Date.now() + 86_400_000); ledger.schedule('write', Date.now() + 86_400_000); ledger.close();
    const errors = vi.fn();
    const scheduler = new Scheduler({ projectRoot: root, client: {} as any, model: 'offline-fixture', creationTasksOnly: true,
      radarCron: '0 */6 * * *', writeCron: '*/15 * * * *', maxConcurrentBooks: 1, chaptersPerCycle: 1,
      retryDelayMs: 1000, cooldownAfterChapterMs: 0, maxChaptersPerDay: 20, publisher: publisher as any, onError: errors });
    schedulers.push(scheduler);
    const drain = async () => {
      await (scheduler as any).writeCycleInFlight;
      await Promise.all([...(scheduler as any).workInFlight.values()]);
    };
    await scheduler.start(); await drain(); (scheduler as any).tick(); await drain(); await scheduler.stop();
    return errors;
  }
  function noPublication() { for (const spy of Object.values(publisher)) expect(spy).not.toHaveBeenCalled(); }
  return { root, store, state, task, restart, noPublication };
}

describe('persisted book control vetoes retained creation foundation recovery', () => {
  it.each(['paused', 'completed', 'dropped', 'incubating'] as const)('preserves %s through repeated startup with a retained run task', async status => {
    for (const ready of [false, true]) {
      const f = await fixture(status, ready);
      const before = await readFile(join(f.state.bookDir(f.task.workId), 'book.json'), 'utf8');
      for (let restart = 0; restart < 2; restart++) expect(await f.restart()).not.toHaveBeenCalled();
      expect(boundary.plan).not.toHaveBeenCalled(); expect(boundary.init).not.toHaveBeenCalled(); f.noPublication();
      expect(f.store.get(f.task.id)).toEqual(f.task);
      expect(await readFile(join(f.state.bookDir(f.task.workId), 'book.json'), 'utf8')).toBe(before);
      expect(await readFile(join(f.state.bookDir(f.task.workId), 'story/author_intent.md'), 'utf8')).toBe('Keep the original promise.\n');
    }
  });

  it.each(['active', 'outlining'] as const)('allows a fresh foundation attempt after the author explicitly changes the book back to %s', async status => {
    const f = await fixture('paused');
    await f.restart(); await f.restart();
    expect(boundary.plan).not.toHaveBeenCalled(); expect(boundary.init).not.toHaveBeenCalled();
    await f.state.saveBookConfig(f.task.workId, { ...await f.state.loadBookConfig(f.task.workId), status });
    expect(await f.restart()).not.toHaveBeenCalled();
    expect(boundary.plan).toHaveBeenCalledOnce(); expect(boundary.init).toHaveBeenCalledOnce(); f.noPublication();
    expect(f.store.get(f.task.id).desiredState).toBe('run');
  });

  it('keeps task pause authoritative over an active book and admits work after explicit task Resume', async () => {
    const f = await fixture('active');
    const paused = f.store.control(f.task.id, 'paused', f.task.version);
    await f.restart(); await f.restart();
    expect(boundary.plan).not.toHaveBeenCalled(); expect(boundary.init).not.toHaveBeenCalled();
    expect(f.store.get(paused.id)).toEqual(paused);
    f.store.control(paused.id, 'run', paused.version);
    expect(await f.restart()).not.toHaveBeenCalled();
    expect(boundary.plan).toHaveBeenCalledOnce(); expect(boundary.init).toHaveBeenCalledOnce(); f.noPublication();
  });

  it('does not let task Resume silently clear a separate book pause', async () => {
    const f = await fixture('paused');
    const paused = f.store.control(f.task.id, 'paused', f.task.version);
    f.store.control(paused.id, 'run', paused.version);
    await f.restart(); await f.restart();
    expect(boundary.plan).not.toHaveBeenCalled(); expect(boundary.init).not.toHaveBeenCalled(); f.noPublication();
    expect((await f.state.loadBookConfig(f.task.workId)).status).toBe('paused');
  });

  it('rechecks a book pause made during planning before calling foundation creation', async () => {
    const f = await fixture('active');
    boundary.plan.mockImplementationOnce(async (_request, plan) => {
      await f.state.saveBookConfig(f.task.workId, { ...await f.state.loadBookConfig(f.task.workId), status: 'paused' });
      return { plan, summary: 'Offline fixture only', endingIntent: 'Keep the author’s ending' };
    });
    expect(await f.restart()).not.toHaveBeenCalled(); await f.restart();
    expect(boundary.plan).toHaveBeenCalledOnce(); expect(boundary.init).not.toHaveBeenCalled(); f.noPublication();
    expect((await f.state.loadBookConfig(f.task.workId)).status).toBe('paused');
  });

  it('rechecks a book pause made during skill loading before calling the planner', async () => {
    const f = await fixture('active');
    boundary.onSkills = async () => {
      await f.state.saveBookConfig(f.task.workId, { ...await f.state.loadBookConfig(f.task.workId), status: 'paused' });
    };
    expect(await f.restart()).not.toHaveBeenCalled(); await f.restart();
    expect(boundary.plan).not.toHaveBeenCalled(); expect(boundary.init).not.toHaveBeenCalled(); f.noPublication();
    expect((await f.state.loadBookConfig(f.task.workId)).status).toBe('paused');
    boundary.onSkills = undefined;
    await f.state.saveBookConfig(f.task.workId, { ...await f.state.loadBookConfig(f.task.workId), status: 'active' });
    expect(await f.restart()).not.toHaveBeenCalled();
    expect(boundary.plan).toHaveBeenCalledOnce(); expect(boundary.init).toHaveBeenCalledOnce();
  });

  it('checks the actual book control even if the retained Work uses a custom profile ID', async () => {
    const f = await fixture('paused');
    await saveWorkManifest(f.root, { ...await loadWorkManifest(f.root, f.task.workId), profileId: 'custom-longform' });
    expect(await f.restart()).not.toHaveBeenCalled();
    expect(boundary.plan).not.toHaveBeenCalled(); expect(boundary.init).not.toHaveBeenCalled(); f.noPublication();
  });

  it.each([false, true])('still admits new work or the manifest-before-book.json crash window (manifest exists=%s)', async retainedManifest => {
    const f = await fixture();
    if (retainedManifest) {
      await mkdir(join(f.root, 'works', f.task.workId), { recursive: true });
      await saveWorkManifest(f.root, { version: 2, id: f.task.workId, title: 'Interrupted work', profileId: 'longform-novel', language: 'en',
        status: 'draft', artifacts: [], lineage: [], metadata: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    }
    expect(await f.restart()).not.toHaveBeenCalled();
    expect(boundary.plan).toHaveBeenCalledOnce(); expect(boundary.init).toHaveBeenCalledOnce(); f.noPublication();
  });

  it('fails closed on a malformed retained book instead of treating it as a missing new book', async () => {
    const f = await fixture('paused');
    await writeFile(join(f.state.bookDir(f.task.workId), 'book.json'), '{malformed');
    expect(await f.restart()).toHaveBeenCalled();
    expect(boundary.plan).not.toHaveBeenCalled(); expect(boundary.init).not.toHaveBeenCalled(); f.noPublication();
    expect(f.store.get(f.task.id)).toEqual(f.task);
  });
});
