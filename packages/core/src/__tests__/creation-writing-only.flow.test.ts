import { writeFileSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const transport = vi.hoisted(() => ({ create: vi.fn(), network: vi.fn(() => { throw new Error('Unexpected offline network'); }) }));
vi.mock('../codex/client.js', () => ({ createCodexClient: transport.create }));
vi.mock('../utils/proxy-fetch.js', async original => ({ ...await original<typeof import('../utils/proxy-fetch.js')>(), fetchWithProxy: transport.network }));
import { CodexRuntimeFixtureScope } from './fixtures/codex-runtime-fixture.js';
import type { FixtureTurn } from './codex-fixture.js';
import { Scheduler, type SchedulerConfig } from '../pipeline/scheduler.js';
import { GoalStore } from '../goals/store.js';
import { SchedulerStore } from '../pipeline/scheduler-store.js';
import { CreationTaskStore } from '../creation/store.js';
import { creationBook, type CreationDeliveryMode } from '../creation/contracts.js';
import { CreationTaskCoordinator, creationTaskView } from '../creation/coordinator.js';
import { AutonomousChapterRunner } from '../pipeline/autonomous-chapters.js';
import { RemoteWorkStore } from '../publishing/work-creation-store.js';
import { StateManager } from '../state/manager.js';
import { createInitialRuntimeState } from '../state/runtime-state-store.js';
import { createWorkManifest, loadWorkManifest, saveWorkManifest } from '../harness/work-store.js';
import { syncWorkSourceArtifacts } from '../harness/source-sync.js';
import { createLLMClient } from '../llm/provider.js';

const prose = 'Mara returns the sealed receipt to its owner. The witness closes the door.';
let scope: CodexRuntimeFixtureScope;
const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => {
  vi.stubEnv('INKOS_CODEX_HOME', undefined); vi.stubEnv('INKOS_CODEX_STATE_ROOT', undefined);
  scope = new CodexRuntimeFixtureScope();
  transport.create.mockReset().mockImplementation(scope.createClient);
  transport.network.mockClear(); vi.stubGlobal('fetch', transport.network);
});
afterEach(async () => {
  try { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); }
  finally { await scope.drain(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); }
  expect(transport.network).not.toHaveBeenCalled();
});

// Only wire responses are synthetic. The Agent, writer, review, Goal, revision
// retention, SQLite scheduler and creation coordinator are the production paths.
function reply(view: FixtureTurn) {
  const name = view.tools[0]!.function.name;
  let args: unknown;
  if (name === 'submit_chapter_memo') args = { goal: 'Return the receipt', body: 'Keep it sealed.', threadRefs: [] };
  else if (name === 'submit_chapter_draft') args = { title: 'Receipt', content: prose };
  else if (name === 'submit_runtime_state_delta') args = {
    postSettlement: 'Receipt returned.', factOps: { upsert: [], expire: [] },
    hookOps: { upsert: [], mention: [], resolve: [], defer: [] }, newHookCandidates: [],
    chapterSummary: { title: 'Receipt', characters: 'Mara', events: 'Receipt returned.', stateChanges: '', hookActivity: '', mood: 'quiet', chapterType: 'scene' },
  };
  else if (name === 'submit_state_validation') args = { reconciliationRequired: false, reportMarkdown: '' };
  else if (name === 'submit_chapter_contract' || name === 'submit_chapter_review') {
    const prompt = JSON.parse([...view.messages].reverse().find(message => message.role === 'user')!.content);
    const ref = (sourceId: string, endLine = 1) => ({ sourceId, startLine: 1, endLine });
    const memo = prompt.sources.find((source: any) => source.sourceId === 'chapter-contract-source');
    if (name === 'submit_chapter_contract') {
      args = { summary: 'Synthetic classification of the actual retained memo.', observations: memo.numberedLines.split('\n').map((_line: string, i: number) => ({
        code: 'required-event', assessment: 'observation', summary: 'Return the sealed receipt.',
        sourceRefs: [{ sourceId: memo.sourceId, startLine: i + 1, endLine: i + 1 }],
      })) };
    } else {
      const chapter = prompt.sources.find((source: any) => /^chapter-\d+$/.test(source.sourceId));
      args = { summary: 'Independent synthetic review of the actual retained prose.', observations: [
        ...(memo ? [{ code: 'chapter-contract-inventory', category: 'quality', assessment: 'observation', summary: 'The original inventory is retained.', sourceRefs: [ref(memo.sourceId, memo.numberedLines.split('\n').length)] }] : []),
        ...(prompt.chapterContract?.requirements ?? []).map((requirement: any) => ({ code: requirement.code, category: 'quality', assessment: 'observation', summary: 'The current body returns the sealed receipt.', sourceRefs: [ref(requirement.code), ref(chapter.sourceId)] })),
        { code: 'story-closure', category: 'quality', assessment: 'observation', summary: 'The receipt reaches its owner and the promised return is resolved.', sourceRefs: [ref(chapter.sourceId)] },
      ] };
    }
  } else throw new Error(`Unexpected offline model tool: ${name}`);
  return { calls: [{ name, args }] };
}

async function prepareTask(root: string, tasks: CreationTaskStore, state: StateManager, mode: CreationDeliveryMode | undefined, chapters: number) {
  const request = { id: randomUUID(), kind: 'short' as const, brief: 'Three synthetic sections in which Mara returns the sealed receipt.', ...(mode === undefined ? {} : { deliveryMode: mode }) };
  let task = tasks.create(request, { title: 'Synthetic Receipt', genre: 'general', language: 'en', platform: 'other', targetChapters: chapters, chapterWordCount: 20 });
  const bookDir = state.bookDir(task.workId);
  await saveWorkManifest(root, createWorkManifest({ id: task.workId, title: task.plan.title, profileId: 'longform-novel', language: 'en' }));
  await state.saveBookConfig(task.workId, { ...creationBook(task), status: 'active', minChapterLength: 10, maxChapterLength: 40 });
  await mkdir(join(bookDir, 'story/outline'), { recursive: true });
  await mkdir(join(bookDir, 'story/runtime'), { recursive: true });
  for (const [file, content] of Object.entries({ 'outline/story_frame.md': 'Mara returns a sealed receipt.', 'outline/volume_map.md': 'Three synthetic sections.',
    'book_rules.md': 'Preserve the sealed receipt.', 'book_rules.json': JSON.stringify({ version: '2', prohibitions: [], enableFullCastTracking: false, allowedDeviations: [] }) })) await writeFile(join(bookDir, 'story', file), content);
  await createInitialRuntimeState({ bookDir, language: 'en' });
  await state.saveChapterIndex(task.workId, []); await state.snapshotState(task.workId, 0);
  await syncWorkSourceArtifacts({ projectRoot: root, workId: task.workId, accept: true });
  task = tasks.update(task.id, current => ({ ...current, foundation: 'completed', planStatus: 'ready', phase: 'writing' }));
  return task;
}
async function setup(mode: CreationDeliveryMode | undefined, poison = false, chapters = 3) {
  const root = await mkdtemp(join(tmpdir(), 'inkos-writing-only-'));
  const project = scope.registerProject(root, { reply });
  const tasks = new CreationTaskStore(join(root, '.inkos/harness.sqlite'));
  const ledger = new SchedulerStore(join(root, '.inkos/harness.sqlite'));
  const state = new StateManager(root);
  const task = await prepareTask(root, tasks, state, mode, chapters);
  const poisonCall = () => { throw new Error('Manuscript called a poison publisher'); };
  const publisher = { ready: vi.fn(poisonCall), reconcile: vi.fn(poisonCall), ensureWork: vi.fn(poisonCall), publish: vi.fn(poisonCall) };
  const errors = vi.fn();
  const client = createLLMClient({ service: 'custom', provider: 'openai', configSource: 'studio', model: 'fixture', apiKey: 'fixture', baseUrl: 'https://unused.invalid/v1', apiFormat: 'chat', stream: false, temperature: 0, thinkingBudget: 0 });
  const config: SchedulerConfig = { projectRoot: root, client, model: 'fixture', creationTasksOnly: true,
    radarCron: '0 */6 * * *', writeCron: '*/15 * * * *', maxConcurrentBooks: 1, chaptersPerCycle: 3,
    retryDelayMs: 1, cooldownAfterChapterMs: 0, maxChaptersPerDay: 20, onError: errors,
    ...(poison ? { publisher } : {}),
  };
  const schedulers: Scheduler[] = [];
  const start = async (ticks = 4, overrides: Partial<SchedulerConfig> = {}) => {
    const scheduler = new Scheduler({ ...config, ...overrides }); schedulers.push(scheduler);
    await scheduler.start();
    const drain = async () => {
      await (scheduler as any).writeCycleInFlight;
      await Promise.all([...(scheduler as any).workInFlight.values()]);
    };
    await drain();
    for (let i = 0; i < ticks; i++) { (scheduler as any).tick(); await drain(); }
    return scheduler;
  };
  cleanups.push(async () => {
    for (const scheduler of schedulers) await scheduler.stop();
    await scope.drain(); tasks.close(); ledger.close(); await rm(root, { recursive: true, force: true });
  });
  const view = () => creationTaskView(tasks.get(task.id), ledger.chapters(task.workId));
  const drafts = () => project.fixture.turns.filter(turn => turn.tools[0]?.function.name === 'submit_chapter_draft');
  return { root, project, task, tasks, ledger, state, config, publisher, errors, start, view, drafts, schedulers,
    addTask: (mode: CreationDeliveryMode, chapters: number) => prepareTask(root, tasks, state, mode, chapters) };
}

describe('manuscript on the real creation Scheduler and runner (synthetic wire only)', () => {
  it.each([false, true])('finishes exactly three reviewed chapters with zero publisher calls (poison=%s)', async poison => {
    const f = await setup('manuscript', poison);
    await f.start();
    expect(f.drafts(), JSON.stringify({ task: f.tasks.get(f.task.id), jobs: f.ledger.chapters(f.task.workId) })).toHaveLength(3);
    expect(f.errors).not.toHaveBeenCalled();
    expect(f.view()).toMatchObject({ phase: 'completed', deliveryMode: 'manuscript', contentStatus: 'reviewed_complete', publicationStatus: 'not_requested', writtenChapters: 3, reviewedChapters: 3, publishedChapters: 0 });
    const jobs = f.ledger.chapters(f.task.workId);
    expect(jobs.map(job => job.chapter)).toEqual([1, 2, 3]);
    for (const job of jobs) {
      expect(job.reviewReceipt?.revisionId).toBe(job.revisionId);
      expect(job.reviewReceipt?.inputs?.version).toBe(2);
      expect(job.reviewReceipt?.reviewPolicy?.lengthBounds).toEqual({ countingMode: 'en_words', minChapterLength: 10, maxChapterLength: 40 });
      expect(job.publication).toBeUndefined();
    }
    const goals = new GoalStore(join(f.root, '.inkos/harness.sqlite'));
    try { for (const job of jobs) expect(goals.get(job.goalId)).toMatchObject({ status: 'completed', owner: null }); }
    finally { goals.close(); }
    expect(jobs[2]!.reviewReceipt?.reviewPolicy?.requireStoryClosure).toBe(true);
    expect(f.view().receipts).toHaveLength(3);
    for (const call of Object.values(f.publisher)) expect(call).not.toHaveBeenCalled();
    expect((await loadWorkManifest(f.root, f.task.workId)).artifacts.filter(artifact => artifact.kind === 'chapter' && artifact.currentRevisionId)).toHaveLength(3);
  });
  it.each([undefined, 'publish'] as const)('retains the first reviewed chapter and publication obligation (%s)', async mode => {
    const f = await setup(mode);
    await f.start();
    expect(f.drafts()).toHaveLength(1);
    expect(f.ledger.latest(f.task.workId)).toMatchObject({ chapter: 1, phase: 'publishing', error: { code: 'CREATION_PUBLISHER_REQUIRED' } });
    expect(f.ledger.latest(f.task.workId)?.reviewReceipt).toBeDefined();
    expect(f.tasks.get(f.task.id).phase).toBe('blocked');
  });

  it.each(['task-pause', 'book-pause', 'cancel'] as const)('vetoes acceptance after the final async policy read (%s)', async stop => {
    const f = await setup('manuscript', true, 1);
    const original = (AutonomousChapterRunner.prototype as any).currentReviewPolicy;
    vi.spyOn(AutonomousChapterRunner.prototype as any, 'currentReviewPolicy').mockImplementationOnce(async function (this: any, job: any) {
      const policy = await original.call(this, job);
      if (stop === 'task-pause') { const task = f.tasks.get(f.task.id); f.tasks.control(task.id, 'paused', task.version); }
      else if (stop === 'book-pause') await f.state.saveBookConfig(f.task.workId, { ...await f.state.loadBookConfig(f.task.workId), status: 'paused' });
      else void f.schedulers[0]!.stop().catch(error => f.errors(error));
      return policy;
    });
    await f.start();
    const retained = f.ledger.latest(f.task.workId)!;
    expect(retained).toMatchObject({ phase: 'reviewing', writingCompleted: true, reviewChecks: 1 });
    expect(retained.reviewReceipt).toBeUndefined();
    expect(f.drafts()).toHaveLength(1);
    expect(f.tasks.get(f.task.id).phase).not.toBe('completed');
    for (const call of Object.values(f.publisher)) expect(call).not.toHaveBeenCalled();
    if (stop === 'cancel') await f.schedulers[0]!.stop();
  });

  it.each(['author-input', 'length-policy'] as const)('rejects stale authority changed after the final async read (%s)', async changed => {
    const f = await setup('manuscript', true, 1);
    const original = (AutonomousChapterRunner.prototype as any).currentReviewPolicy;
    vi.spyOn(AutonomousChapterRunner.prototype as any, 'currentReviewPolicy').mockImplementationOnce(async function (this: any, job: any) {
      const policy = await original.call(this, job);
      if (changed === 'author-input') await writeFile(join(f.state.bookDir(f.task.workId), 'story/author_intent.md'), 'A new synthetic author requirement.');
      else await f.state.saveBookConfig(f.task.workId, { ...await f.state.loadBookConfig(f.task.workId), minChapterLength: 30 });
      return policy;
    });
    await f.start(0);
    expect(f.ledger.latest(f.task.workId)).toMatchObject({ phase: 'reviewing', writingCompleted: true, reviewChecks: 1 });
    expect(f.ledger.latest(f.task.workId)?.reviewReceipt).toBeUndefined();
    expect(f.drafts()).toHaveLength(1); expect(f.view().phase).not.toBe('completed');
    for (const call of Object.values(f.publisher)) expect(call).not.toHaveBeenCalled();
  });

  it.each(['author-input', 'canonical-state'] as const)('preserves the committed receipt but refuses stale task completion (%s)', async changed => {
    const f = await setup('manuscript', true, 1);
    const sync = CreationTaskCoordinator.prototype.sync;
    let changedOnce = false;
    vi.spyOn(CreationTaskCoordinator.prototype, 'sync').mockImplementation(function (this: any, workId: string) {
      if (!changedOnce && this.scheduler.latest(workId)?.phase === 'completed') {
        changedOnce = true;
        const bookDir = f.state.bookDir(workId);
        if (changed === 'author-input') writeFileSync(join(bookDir, 'story/author_intent.md'), 'A changed synthetic requirement after acceptance.');
        else {
          const path = join(bookDir, 'chapters/index.json');
          const index = JSON.parse(readFileSync(path, 'utf8'));
          index[0].observations.push({ code: 'state-sync-required', category: 'execution', assessment: 'issue', summary: 'Synthetic unsettled canonical state.', evidence: [] });
          writeFileSync(path, JSON.stringify(index));
        }
      }
      return sync.call(this, workId);
    });
    await f.start();
    expect(f.tasks.get(f.task.id)).toMatchObject({ phase: 'blocked', error: { code: 'CREATION_REVIEW_RECONCILIATION_REQUIRED' } });
    expect(f.ledger.latest(f.task.workId)).toMatchObject({ phase: 'completed', reviewChecks: 1 });
    expect(f.ledger.latest(f.task.workId)?.reviewReceipt).toBeDefined();
    expect(f.view().contentStatus).toBe('in_progress'); expect(f.drafts()).toHaveLength(1);
    for (const call of Object.values(f.publisher)) expect(call).not.toHaveBeenCalled();
  });

  it.each(['publishing', 'attempt', 'published-receipt', 'remote-reserved', 'remote-unknown'] as const)('blocks contradictory durable manuscript history before dispatch (%s)', async marker => {
    const f = await setup('manuscript', true);
    const job = f.ledger.reserve(f.task.workId, 1, Date.now(), 20)!;
    const retained = { ...job,
      ...(marker === 'publishing' ? { phase: 'publishing' as const } : {}),
      ...(marker === 'attempt' ? { publicationStartedAt: 1234 } : {}),
      ...(marker === 'published-receipt' ? { phase: 'completed' as const, publication: { status: 'published' as const, remoteChapterId: 'synthetic-history', evidence: 'Synthetic prior remote history.' } } : {}),
    };
    f.ledger.save(retained, 'synthetic-contradictory-history');
    const remote = new RemoteWorkStore(join(f.root, '.inkos/harness.sqlite'));
    try {
      if (marker.startsWith('remote-')) {
        const run = remote.reserve({ workId: f.task.workId, destination: { provider: 'meganovel', platform: 'meganovel', accountId: 'synthetic', accountLabel: 'synthetic', sessionId: 'synthetic' },
          metadata: { title: 'Synthetic Receipt', blurb: 'Synthetic retained history.', genre: 'general', language: 'en', aiAssisted: true } });
        if (marker === 'remote-unknown') remote.beginCreation(run.id, run.version);
      }
      const remoteBefore = remote.forWork(f.task.workId);
      await f.start();
      expect(f.tasks.get(f.task.id)).toMatchObject({ phase: 'blocked', error: { code: 'CREATION_DELIVERY_HISTORY_CONFLICT' } });
      expect(f.ledger.latest(f.task.workId)).toEqual(retained);
      expect(remote.forWork(f.task.workId)).toEqual(remoteBefore);
      expect(f.drafts()).toHaveLength(0);
      const view = creationTaskView(f.tasks.get(f.task.id), f.ledger.chapters(f.task.workId), remoteBefore);
      expect(view).toMatchObject({ publicationStatus: 'reconciliation_required', canResume: false, publishedChapters: marker === 'published-receipt' ? 1 : 0 });
      const task = f.tasks.get(f.task.id);
      expect(() => f.tasks.control(task.id, 'run', task.version)).toThrow(expect.objectContaining({ code: 'CREATION_RECONCILIATION_REQUIRED' }));
      for (const call of Object.values(f.publisher)) expect(call).not.toHaveBeenCalled();
    } finally { remote.close(); }
  });

  it('requires complete modern matching acceptance evidence, without inventing legacy policy', async () => {
    const f = await setup('manuscript', true, 1);
    await f.start();
    const accepted = f.ledger.latest(f.task.workId)!;
    expect(f.view().contentStatus).toBe('reviewed_complete');
    const invalid = [
      { ...accepted, reviewReceipt: { ...accepted.reviewReceipt!, inputs: undefined } },
      { ...accepted, reviewReceipt: { ...accepted.reviewReceipt!, reviewPolicy: { requireStoryClosure: true, language: 'en' } as any } },
      { ...accepted, reviewReceipt: { ...accepted.reviewReceipt!, revisionId: 'wrong-revision' } },
      { ...accepted, reviewReceipt: { ...accepted.reviewReceipt!, observations: [] } },
      { ...accepted, reviewReceipt: { ...accepted.reviewReceipt!, observations: [{ code: 'review-unavailable', assessment: 'unavailable' as const, category: 'quality' as const, summary: 'Synthetic unavailable review.', evidence: [] }] } },
    ];
    for (const job of invalid) {
      f.tasks.update(f.task.id, task => ({ ...task, phase: 'writing', error: undefined }));
      f.ledger.save(job, 'synthetic-invalid-review-history');
      (f.schedulers[0] as any).creation.sync(f.task.workId);
      expect(f.tasks.get(f.task.id)).toMatchObject({ phase: 'blocked', error: { code: 'CREATION_REVIEW_RECONCILIATION_REQUIRED' } });
      expect(f.view()).toMatchObject({ contentStatus: 'in_progress', reviewedChapters: 0, publicationStatus: 'not_requested' });
      expect(f.ledger.latest(f.task.workId)).toEqual(job);
    }
    expect(f.drafts()).toHaveLength(1);
    const task = f.tasks.get(f.task.id);
    expect(creationTaskView(task, [{ ...accepted, chapter: 2 }]).contentStatus).toBe('in_progress');
  });

  it('retains acceptance committed before pause and does not dispatch the next chapter until explicit resume', async () => {
    const f = await setup('manuscript', true);
    const save = SchedulerStore.prototype.save;
    const committed = vi.spyOn(SchedulerStore.prototype, 'save').mockImplementation(function (this: SchedulerStore, job, event, now) {
      save.call(this, job, event, now);
      if (event === 'review-accepted' && job.chapter === 1) {
        const task = f.tasks.get(f.task.id); f.tasks.control(task.id, 'paused', task.version);
      }
    });
    const first = await f.start(); committed.mockRestore();
    expect(f.drafts()).toHaveLength(1);
    const accepted = f.ledger.latest(f.task.workId)!;
    expect(accepted.phase).toBe('completed');
    expect(f.view()).toMatchObject({ status: 'paused', reviewedChapters: 1, publicationStatus: 'not_requested' });
    await first.stop();
    const pausedRestart = await f.start(); await pausedRestart.stop();
    expect(f.ledger.latest(f.task.workId)).toEqual(accepted);
    expect(f.drafts()).toHaveLength(1);
    const task = f.tasks.get(f.task.id); f.tasks.control(task.id, 'run', task.version);
    await f.start();
    expect(f.drafts()).toHaveLength(3);
    expect(f.ledger.chapters(f.task.workId)[0]).toEqual(accepted);
    expect(f.view().phase).toBe('completed');
    for (const call of Object.values(f.publisher)) expect(call).not.toHaveBeenCalled();
  });

  it('does not let a blocked publish task consume another manuscript slot or start an old paused book', async () => {
    const f = await setup('manuscript');
    const publish = await f.addTask('publish', 1);
    await f.state.saveBookConfig('synthetic-old-paused', { ...creationBook(f.task), id: 'synthetic-old-paused', status: 'paused' });
    const oldPath = join(f.state.bookDir('synthetic-old-paused'), 'book.json');
    const oldBytes = await readFile(oldPath);
    await f.start(4, { maxConcurrentBooks: 2 });
    expect(f.view()).toMatchObject({ phase: 'completed', reviewedChapters: 3, publishedChapters: 0 });
    expect(f.tasks.get(publish.id)).toMatchObject({ phase: 'blocked', error: { code: 'CREATION_PUBLISHER_REQUIRED' } });
    expect(f.ledger.latest(publish.workId)?.reviewReceipt).toBeDefined();
    expect(f.ledger.chapters(f.task.workId)).toHaveLength(3);
    expect(f.ledger.chapters(publish.workId)).toHaveLength(1);
    expect(f.ledger.latest('synthetic-old-paused')).toBeUndefined();
    expect(await readFile(oldPath)).toEqual(oldBytes);
    expect(f.drafts()).toHaveLength(4);
  });

  it('reopens committed chapters in a fresh OS process before task sync without repeating any writer or publisher', async () => {
    const f = await setup('manuscript', true);
    const sync = CreationTaskCoordinator.prototype.sync;
    vi.spyOn(CreationTaskCoordinator.prototype, 'sync').mockImplementation(function (this: any, workId: string) {
      // Simulate the actual crash window: the chapter/Goal are committed, but
      // the process has not yet synchronized the creation task.
      if (this.scheduler.latest(workId)?.phase === 'completed') return;
      return sync.call(this, workId);
    });
    for (let chapter = 1; chapter <= 3; chapter++) {
      const scheduler = await f.start(0, { publisher: chapter === 2 ? undefined : f.publisher });
      expect(f.drafts()).toHaveLength(chapter);
      const before = f.ledger.chapters(f.task.workId);
      expect(before).toHaveLength(chapter);
      expect(before.at(-1)?.phase).toBe('completed');
      expect(f.tasks.get(f.task.id).phase).not.toBe('completed');
      await scheduler.stop();
      const script = `
        globalThis.fetch = () => { throw new Error('Unexpected child network'); };
        const { SchedulerStore } = await import(${JSON.stringify(new URL('../../dist/pipeline/scheduler-store.js', import.meta.url).href)});
        const { CreationTaskCoordinator, creationTaskView } = await import(${JSON.stringify(new URL('../../dist/creation/coordinator.js', import.meta.url).href)});
        const { join } = await import('node:path');
        const [root, workId] = process.argv.slice(1);
        const ledger = new SchedulerStore(join(root, '.inkos/harness.sqlite'));
        const coordinator = new CreationTaskCoordinator(root, {}, ledger, 1);
        try {
          coordinator.sync(workId);
          const task = coordinator.tasks.forWork(workId);
          const { writeFileSync } = await import('node:fs');
          writeFileSync(join(root, 'fresh-process-view.json'), JSON.stringify({ pid: process.pid, view: creationTaskView(task, ledger.chapters(workId)) }));
        } finally { coordinator.close(); ledger.close(); }
      `;
      await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', script, f.root, f.task.workId], { timeout: 10_000 });
      const result = JSON.parse(await readFile(join(f.root, 'fresh-process-view.json'), 'utf8'));
      expect(result.pid).not.toBe(process.pid);
      const reopened = result.view;
      await rm(join(f.root, 'fresh-process-view.json'));
      expect(reopened).toMatchObject({ deliveryMode: 'manuscript', publicationStatus: 'not_requested', publishedChapters: 0,
        phase: chapter === 3 ? 'completed' : 'writing', reviewedChapters: chapter });
      expect(f.ledger.chapters(f.task.workId)).toEqual(before);
    }
    await f.start();
    expect(f.drafts()).toHaveLength(3);
    for (const call of Object.values(f.publisher)) expect(call).not.toHaveBeenCalled();
  });
});
