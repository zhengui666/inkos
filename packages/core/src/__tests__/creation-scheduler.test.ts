import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
const fake = vi.hoisted(() => ({ books: new Map<string, any>(), next: new Map<string, number>(), init: vi.fn(), run: vi.fn(), plan: vi.fn() }));
vi.mock('../creation/planner.js', () => ({ CreationPlannerAgent: class { plan(...args: any[]) { return fake.plan(...args); } } }));
vi.mock('../pipeline/runner.js', () => ({ PipelineRunner: class {
  createAgentContext() { return {}; }
  runWithAgentContext(_ctx: any, fn: any) { return fn(); }
  initBook(...args: any[]) { return fake.init(...args); }
} }));
vi.mock('../state/manager.js', () => ({ StateManager: class {
  bookDir(id: string) { return id; }
  async listBooks() { return [...fake.books.keys()]; }
  async loadBookConfig(id: string) { return fake.books.get(id); }
  async isCompleteBookDirectory() { return true; }
  async getNextChapterNumber(id: string) { return fake.next.get(id) ?? 1; }
  async acquireBookLock() { return async () => undefined; }
} }));
vi.mock('../pipeline/autonomous-chapters.js', () => ({ AutonomousChapterRunner: class {
  constructor(_root: any, _pipeline: any, private store: any, private options: any) {}
  run(job: any, signal: any) { return fake.run(job, signal, this.store, this.options); }
} }));
vi.mock('../harness/builtin-profiles.js', () => ({ createBuiltInWorkProfileRegistry: () => ({ require: () => ({}) }) }));
vi.mock('../skills/index.js', () => ({ loadAvailableAgentSkills: async () => ({ skills: [] }), resolveProfileSkillActivations: () => [] }));
import { Scheduler } from '../pipeline/scheduler.js';
import { SchedulerStore } from '../pipeline/scheduler-store.js';
import { CreationTaskStore } from '../creation/store.js';
import { inferCreationPlan } from '../creation/contracts.js';
const roots: string[] = [], schedulers: Scheduler[] = [], stores: CreationTaskStore[] = [];
beforeEach(() => {
  fake.books.clear(); fake.next.clear(); vi.clearAllMocks();
  fake.plan.mockImplementation(async (_request, plan) => ({ plan, summary: 'Fixture semantic plan.', endingIntent: 'The detective solves the case and chooses to return the memory.' }));
  fake.init.mockImplementation(async book => { fake.books.set(book.id, book); });
  fake.run.mockImplementation(async (job, signal, store, options) => {
    signal.throwIfAborted();
    expect(options.chapterIntent(job.workId, job.chapter)).toContain('FINAL CHAPTER');
    const result = { ...job, phase: 'completed', reviewReceipt: { revisionId: 'fixture-r1', observations: [{ code: 'story-closure', category: 'quality', assessment: 'observation', sourceRefs: [{ sourceId: 'chapter-1', quote: 'The mystery was resolved.' }] }] },
      publication: { status: 'published', remoteChapterId: 'fixture-only', evidence: 'Simulated adapter publication, no network request.' } };
    fake.next.set(job.workId, job.chapter + 1); store.save(result, 'fixture-only-publication'); return result;
  });
});
afterEach(async () => { await Promise.all(schedulers.splice(0).map(s => s.stop())); stores.splice(0).forEach(s => s.close()); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function setup(extra: any = {}) {
  const root = await mkdtemp(join(tmpdir(), 'inkos-creation-scheduler-')); roots.push(root);
  const tasks = new CreationTaskStore(join(root, '.inkos/harness.sqlite')); stores.push(tasks);
  const request = { id: randomUUID(), kind: 'short' as const, brief: 'A detective solves a case that spans two timelines.' };
  const task = tasks.create(request, inferCreationPlan(request, { language: 'en', daemon: { market: { platform: 'fixture', language: 'en' } } } as any));
  const config = { projectRoot: root, client: {} as any, model: 'fixture', radarCron: '0 */6 * * *', writeCron: '*/15 * * * *',
    maxConcurrentBooks: 2, chaptersPerCycle: 1, retryDelayMs: 1000, cooldownAfterChapterMs: 0, maxChaptersPerDay: 10, creationTasksOnly: true, ...extra };
  const scheduler = new Scheduler(config); schedulers.push(scheduler);
  return { root, task, tasks, scheduler, config };
}
async function idle() { for (let i = 0; i < 40; i++) await new Promise(resolve => setImmediate(resolve)); }
describe('creation intake through existing scheduler (simulated model/publisher)', () => {
  it('runs a new two-field task to finite completion without starting old active or paused books', async () => {
    fake.books.set('old-active', { id: 'old-active', status: 'active', targetChapters: 20 });
    fake.books.set('old-paused', { id: 'old-paused', status: 'paused', targetChapters: 20 });
    const f = await setup(); await f.scheduler.start(); await idle();
    expect(fake.init).toHaveBeenCalledOnce(); expect(fake.run).toHaveBeenCalledOnce();
    expect(fake.run.mock.calls[0][0].workId).toBe(f.task.workId);
    expect(f.tasks.get(f.task.id).phase).toBe('completed');
    (f.scheduler as any).tick(); await idle(); expect(fake.run).toHaveBeenCalledOnce();
  });
  it.each([true, false])('honors general daemon --work when enumerating creation tasks (selected=%s)', async selected => {
    const f = await setup();
    const request = { id: randomUUID(), kind: 'short' as const, brief: 'A second unselected offline fixture.' };
    const other = f.tasks.create(request, inferCreationPlan(request, { language: 'en', daemon: { market: { platform: 'fixture', language: 'en' } } } as any));
    fake.books.set('old-paused', { id: 'old-paused', status: 'paused', targetChapters: 20 });
    const ledger = new SchedulerStore(join(f.root, '.inkos/harness.sqlite'));
    ledger.schedule('radar', Date.now() + 86_400_000); ledger.schedule('write', Date.now() + 86_400_000);
    const scheduler = new Scheduler({ ...f.config, creationTasksOnly: false,
      workIds: selected ? [f.task.workId, 'old-paused'] : ['old-paused'] });
    schedulers.push(scheduler); await scheduler.start(); await idle();
    (scheduler as any).tick(); await idle();
    expect(fake.init.mock.calls.map(call => call[0].id)).toEqual(selected ? [f.task.workId] : []);
    expect(fake.run.mock.calls.map(call => call[0].workId)).toEqual(selected ? [f.task.workId] : []);
    expect(f.tasks.get(other.id).foundationAttempts).toBe(0);
    expect(fake.books.get('old-paused').status).toBe('paused');
    ledger.close();
  });

  it('restarts with the same completed work and never repeats a model or submission', async () => {
    const f = await setup(); await f.scheduler.start(); await idle(); await f.scheduler.stop();
    const restart = new Scheduler(f.config); schedulers.push(restart); await restart.start(); await idle();
    expect(fake.init).toHaveBeenCalledOnce(); expect(fake.run).toHaveBeenCalledOnce();
  });
  it('retains missing platform as a visible blocker without guessing or calling the model', async () => {
    const f = await setup(); let task = f.tasks.control(f.task.id, 'paused', f.task.version);
    task = f.tasks.editPlan(task.id, { ...task.plan, platform: null }, task.version, 0); f.tasks.control(task.id, 'run', task.version);
    await f.scheduler.start(); await idle();
    expect(fake.init).not.toHaveBeenCalled(); expect(fake.run).not.toHaveBeenCalled();
    expect(f.tasks.get(task.id).error?.code).toBe('CREATION_PLATFORM_REQUIRED');
  });
  it('does not continue or publish a paused task', async () => {
    const f = await setup(); f.tasks.control(f.task.id, 'paused', f.task.version);
    await f.scheduler.start(); await idle(); expect(fake.init).not.toHaveBeenCalled(); expect(fake.run).not.toHaveBeenCalled();
  });
  it('lets ready work run while another task plans, using the existing bounded pool', async () => {
    const f = await setup();
    fake.books.set(f.task.workId, { ...f.task.plan, id: f.task.workId, status: 'active' });
    f.tasks.update(f.task.id, task => ({ ...task, foundation: 'completed', planStatus: 'ready', phase: 'writing' }));
    const request = { id: randomUUID(), kind: 'short' as const, brief: 'Another new story needs a slow foundation.' };
    const second = f.tasks.create(request, inferCreationPlan(request, { language: 'en', daemon: { market: { platform: 'fixture', language: 'en' } } } as any));
    let finish!: () => void;
    fake.init.mockImplementation(async book => { await new Promise<void>(resolve => { finish = resolve; }); fake.books.set(book.id, book); });
    await f.scheduler.start(); await idle();
    expect(fake.run).toHaveBeenCalled(); expect(fake.run.mock.calls[0][0].workId).toBe(f.task.workId);
    expect(f.tasks.get(second.id).phase).toBe('planning'); finish(); await idle();
  });
  it('keeps free capacity available across later ticks while another foundation remains stuck', async () => {
    const f = await setup();
    fake.books.set(f.task.workId, { ...f.task.plan, id: f.task.workId, status: 'active', targetChapters: 3 });
    f.tasks.update(f.task.id, task => ({ ...task, plan: { ...task.plan, targetChapters: 3 }, foundation: 'completed', planStatus: 'ready', phase: 'writing' }));
    fake.run.mockImplementation(async (job, _signal, store) => {
      const result = { ...job, phase: 'completed', reviewReceipt: { revisionId: `r${job.chapter}`, observations: [] }, publication: { status: 'published', evidence: 'Fixture only' } };
      fake.next.set(job.workId, job.chapter + 1); store.save(result, 'fixture-step'); return result;
    });
    const request = { id: randomUUID(), kind: 'short' as const, brief: 'An unrelated story is still being planned.' };
    const second = f.tasks.create(request, inferCreationPlan(request, { language: 'en', daemon: { market: { platform: 'fixture', language: 'en' } } } as any));
    let finish!: () => void;
    fake.init.mockImplementation(async book => { await new Promise<void>(resolve => { finish = resolve; }); fake.books.set(book.id, book); });
    await f.scheduler.start(); await idle();
    expect(fake.run.mock.calls.filter(call => call[0].workId === f.task.workId).length).toBe(1);
    (f.scheduler as any).tick(); await idle();
    expect(fake.run.mock.calls.filter(call => call[0].workId === f.task.workId).map(call => call[0].chapter)).toEqual([1, 2]);
    expect(f.tasks.get(second.id).phase).toBe('planning'); finish(); await idle();
  });
  it('drains every per-work operation before releasing the scheduler owner or closing stores', async () => {
    const f = await setup();
    const request = { id: randomUUID(), kind: 'short' as const, brief: 'A second independently running story.' };
    f.tasks.create(request, inferCreationPlan(request, { language: 'en', daemon: { market: { platform: 'fixture', language: 'en' } } } as any));
    const releases: Array<() => void> = [];
    fake.init.mockImplementation(async book => { await new Promise<void>(resolve => releases.push(resolve)); fake.books.set(book.id, book); });
    await f.scheduler.start(); await idle(); expect(releases).toHaveLength(2);
    const ledger = new SchedulerStore(join(f.root, '.inkos/harness.sqlite'));
    let stopped = false; const stop = f.scheduler.stop().then(() => { stopped = true; });
    await idle(); expect(stopped).toBe(false); expect(ledger.runningOwner()).toBeDefined();
    releases[0]!(); await idle(); expect(stopped).toBe(false); expect(ledger.runningOwner()).toBeDefined();
    releases[1]!(); await stop; expect(ledger.runningOwner()).toBeUndefined();
    expect(fake.run).not.toHaveBeenCalled(); ledger.close();
  });
  it('persists the semantic plan before foundation and forwards the unmodified full brief', async () => {
    const f = await setup();
    fake.plan.mockImplementation(async (request, plan) => ({ plan: { ...plan, language: 'en', targetChapters: 3 },
      summary: 'The explicit request takes precedence over defaults.', endingIntent: 'The case is solved in section three.' }));
    fake.run.mockImplementation(async job => job);
    await f.scheduler.start(); await idle();
    expect(fake.plan.mock.calls[0][0].brief).toBe(f.task.request.brief);
    expect(fake.init.mock.calls[0][0]).toMatchObject({ language: 'en', targetChapters: 3 });
    expect(f.tasks.get(f.task.id)).toMatchObject({ planStatus: 'ready', endingIntent: 'The case is solved in section three.' });
  });
  it('does not call a submitted receipt completed', async () => {
    fake.run.mockImplementation(async (job, _signal, store) => {
      const result = { ...job, phase: 'publishing', publication: { status: 'submitted', evidence: 'Simulated pending receipt' } };
      store.save(result, 'fixture-pending'); return result;
    });
    const f = await setup(); await f.scheduler.start(); await idle();
    expect(f.tasks.get(f.task.id).phase).toBe('publishing');
    const ledger = new SchedulerStore(join(f.root, '.inkos/harness.sqlite'));
    expect(ledger.chapters(f.task.workId)).toHaveLength(1); ledger.close();
  });
});
