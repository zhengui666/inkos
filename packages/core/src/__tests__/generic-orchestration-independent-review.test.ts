import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const fixture = vi.hoisted(() => ({ books: new Map<string, any>(), next: new Map<string, number>(), run: vi.fn(), radar: vi.fn(), init: vi.fn(), loads: new Map<string, number>(), slowProcess: '' }));
vi.mock('../pipeline/runner.js', () => ({ PipelineRunner: class {
  runWithAbortSignal(_signal: any, fn: any) { return fn(); }
  runWithAgentContext(_ctx: any, fn: any) { return fn(); }
  runRadar() { return fixture.radar(); }
  initBook(...args: any[]) { return fixture.init(...args); }
} }));
vi.mock('../state/manager.js', () => ({ StateManager: class {
  bookDir(id: string) { return id; }
  async isCompleteBookDirectory() { return true; }
  async listBooks() { return [...fixture.books.keys()]; }
  async loadBookConfig(id: string) {
    const count = (fixture.loads.get(id) ?? 0) + 1; fixture.loads.set(id, count);
    // Delay only the per-worker config read. Discovery reads remain ordered.
    if (fixture.slowProcess === id && count % 2 === 0) await new Promise(resolve => setTimeout(resolve, 20));
    return fixture.books.get(id);
  }
  async getNextChapterNumber(id: string) { return fixture.next.get(id) ?? 1; }
} }));
vi.mock('../pipeline/autonomous-chapters.js', () => ({ AutonomousChapterRunner: class {
  constructor(_root: any, _pipeline: any, readonly store: any) {}
  run(job: any, signal: any) { return fixture.run(job, signal, this.store); }
} }));
vi.mock('../harness/builtin-profiles.js', () => ({ createBuiltInWorkProfileRegistry: () => ({ require: () => ({}) }) }));
vi.mock('../skills/index.js', () => ({ loadAvailableAgentSkills: async () => ({ skills: [] }), resolveProfileSkillActivations: () => [] }));
import { Scheduler } from '../pipeline/scheduler.js';
import { SchedulerStore } from '../pipeline/scheduler-store.js';
const roots: string[] = [], schedulers: Scheduler[] = [];
beforeEach(() => {
  fixture.books.clear(); fixture.next.clear(); fixture.loads.clear(); fixture.slowProcess = ''; vi.clearAllMocks();
  fixture.radar.mockResolvedValue({ recommendations: [], marketSummary: 'fixture', timestamp: new Date().toISOString() });
  fixture.init.mockImplementation(async book => { fixture.books.set(book.id, book); });
  fixture.run.mockImplementation(async (job, _signal, store) => {
    const completed = { ...job, phase: 'completed' }; fixture.next.set(job.workId, job.chapter + 1);
    store.save(completed, 'independent-fixture-completed'); return completed;
  });
});
afterEach(async () => {
  await Promise.all(schedulers.splice(0).map(s => s.stop())); vi.useRealTimers();
  await Promise.all(roots.splice(0).map(r => rm(r, { recursive: true, force: true })));
});
async function setup(extra: any = {}) {
  const root = await mkdtemp(join(tmpdir(), 'inkos-independent-review-')); roots.push(root);
  const config = { projectRoot: root, client: {} as any, model: 'fixture-only', radarCron: '0 */6 * * *', writeCron: '*/15 * * * *', maxConcurrentBooks: 2, chaptersPerCycle: 1, retryDelayMs: 1000, cooldownAfterChapterMs: 0, maxChaptersPerDay: 1, ...extra };
  const scheduler = new Scheduler(config); schedulers.push(scheduler); return { root, config, scheduler };
}
function book(id: string, status = 'active') { fixture.books.set(id, { id, status, targetChapters: 20, language: 'zh' }); }
async function idle() { for (let n = 0; n < 20; n++) await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setTimeout(resolve, 35)); }

describe('independent generic scheduling review', () => {
  it('does not let per-worker I/O latency defeat fair daily admission with parallel workers', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-07T12:00:00Z'));
    book('recently-admitted'); book('waiting-work'); const { root, scheduler } = await setup();
    const seed = new SchedulerStore(join(root, '.inkos/harness.sqlite'));
    const prior = seed.reserve('recently-admitted', 1, Date.parse('2026-10-06T12:00:00Z'), 1)!;
    seed.save({ ...prior, phase: 'completed' }, 'fixture-prior-day'); seed.close();
    fixture.next.set('recently-admitted', 2); fixture.slowProcess = 'waiting-work';
    // Execute the exact scheduled-cycle entry point with no unrelated startup resume pass.
    (scheduler as any).running = true; await (scheduler as any).runWriteCycle(false);
    // A cycle now admits independent work; wait for its actual operations before checking allocation.
    await Promise.all([...(scheduler as any).workInFlight.values()]);
    expect(fixture.run.mock.calls.map(c => c[0].workId)).toEqual(['waiting-work']);
  });

  it('a paused earliest pending foundation does not starve another eligible retained foundation', async () => {
    book('paused-foundation', 'paused'); book('eligible-foundation', 'outlining');
    const { root, scheduler } = await setup({ market: { platform: 'fixture-platform', language: 'zh', maxSourceAgeMs: 86400000, autoCreate: { maxActiveBooks: 3, targetChapters: 24, chapterWordCount: 2000 } } });
    const seed = new SchedulerStore(join(root, '.inkos/harness.sqlite'));
    for (const id of ['paused-foundation', 'eligible-foundation']) seed.reserveFoundation({ scanId: `scan-${id}`, concept: `original concept ${id}`, book: { id, status: 'outlining' } as any, instruction: 'fixture-only', phase: 'pending', attempts: 1, nextAttemptAt: 0 });
    seed.schedule('write', Date.now() + 86400000); seed.schedule('radar', Date.now() + 86400000); seed.close();
    await scheduler.start(); await idle();
    for (let n = 0; n < 3; n++) { (scheduler as any).tick(); await idle(); }
    expect(fixture.init.mock.calls.map(c => c[0].id)).toEqual(['eligible-foundation']);
    expect(fixture.books.get('paused-foundation').status).toBe('paused');
  });

  it('all paused pending foundations do not suppress a due radar scan', async () => {
    book('paused-foundation', 'paused');
    const { root, scheduler } = await setup({ market: { platform: 'fixture-platform', language: 'zh', maxSourceAgeMs: 86400000, autoCreate: { maxActiveBooks: 3, targetChapters: 24, chapterWordCount: 2000 } } });
    const seed = new SchedulerStore(join(root, '.inkos/harness.sqlite'));
    seed.reserveFoundation({ scanId: 'paused-only', concept: 'retained paused concept', book: { id: 'paused-foundation', status: 'outlining' } as any, instruction: 'fixture-only', phase: 'pending', attempts: 1, nextAttemptAt: 0 });
    seed.schedule('write', Date.now() + 86400000); seed.schedule('radar', Date.now() - 1); seed.close();
    await scheduler.start(); await idle(); await (scheduler as any).radarScanInFlight;
    expect(fixture.init).not.toHaveBeenCalled();
    expect(fixture.radar).toHaveBeenCalledTimes(1);
    expect(fixture.books.get('paused-foundation').status).toBe('paused');
  });

  it('retains bounded daily slots and durable fair order for zh/en works across reopen', async () => {
    const { root } = await setup(); const path = join(root, '.inkos/harness.sqlite');
    const first = new SchedulerStore(path); const day = Date.parse('2026-10-07T00:00:00Z');
    const job = first.reserve('zh-work', 8, day, 1)!; first.save({ ...job, phase: 'completed' }, 'fixture-done'); first.close();
    const reopened = new SchedulerStore(path);
    try {
      expect(reopened.orderForAdmission(['zh-work', 'en-work'])).toEqual(['en-work', 'zh-work']);
      expect(reopened.reserve('en-work', 19, day, 1)).toBeUndefined();
      expect(reopened.reserve('en-work', 19, day + 86400000, 1)?.chapter).toBe(19);
      expect(reopened.orderForAdmission(['zh-work', 'en-work'])).toEqual(['zh-work', 'en-work']);
    } finally { reopened.close(); }
  });
});
