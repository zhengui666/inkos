import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StateManager } from '../state/manager.js';
import { syncWorkSourceArtifacts } from '../harness/source-sync.js';
import { loadWorkManifest } from '../harness/work-store.js';
import { SchedulerStore, type ScheduledChapter } from '../pipeline/scheduler-store.js';
import { AutonomousChapterRunner } from '../pipeline/autonomous-chapters.js';
import { readChapterReviewInputs } from '../pipeline/review-inputs.js';
import { PublishingStore } from '../publishing/store.js';
import { ManualPublishingAdapter } from '../publishing/manual-adapter.js';
import { createMegaNovelSchedulerPublisher } from '../publishing/scheduler-publisher.js';
import type { MegaNovelBrowserPort, MegaNovelSnapshot } from '../publishing/meganovel-contracts.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const signal = () => new AbortController().signal;
const scope = { sessionId: 'offline', accountId: 'author', accountLabel: 'Synthetic author', remoteBookId: 'synthetic-book' };
const content = 'Neri hid the sealed letter and left the parcel on her own bench.\n';
const sourcePath = 'works/book/source/chapters/0001_Scene.md';

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'inkos-review-inputs-'));
  const state = new StateManager(root), now = new Date().toISOString();
  await state.saveBookConfig('book', { id: 'book', title: 'Synthetic book', platform: 'meganovel', genre: 'fantasy',
    status: 'active', targetChapters: 3, chapterWordCount: 2000, language: 'en', createdAt: now, updatedAt: now });
  await state.saveChapterIndex('book', [{ number: 1, title: 'Scene', wordCount: 14, provenance: 'generated',
    observations: [], createdAt: now, updatedAt: now }]);
  await syncWorkSourceArtifacts({ projectRoot: root, workId: 'book', accept: true, writes: [{ relativePath: sourcePath, content }] });
  const bookDir = state.bookDir('book'), runtime = join(bookDir, 'story/runtime');
  await mkdir(runtime, { recursive: true });
  const paths = { plan: join(runtime, 'chapter-0001.plan.json'), brief: join(runtime, 'chapter-0001.user-brief.md'), rules: join(bookDir, 'story/book_rules.md') };
  await writeFile(paths.plan, JSON.stringify({ version: 2, intent: { chapter: 1, goal: 'Keep the sender secret' },
    memo: { chapter: 1, goal: 'Keep the sender secret', body: 'Do not identify the sender.', threadRefs: [] }, plannerInputs: [] }));
  await writeFile(paths.brief, 'Keep the sender secret.\n');
  await writeFile(paths.rules, 'Preserve the original author instructions.\n');
  let scheduler = new SchedulerStore(join(root, '.inkos/harness.sqlite'));
  const store = new PublishingStore(join(root, '.inkos/harness.sqlite'));
  const target = await new ManualPublishingAdapter(root, store).mapBook({ workId: 'book', platform: 'meganovel',
    accountLabel: scope.accountLabel, remoteBookId: scope.remoteBookId });
  const snapshot: MegaNovelSnapshot = { scope, origin: 'https://www.meganovel.com', blocker: 'none', chapterNumber: 1, complete: true, candidates: [] };
  const browser: MegaNovelBrowserPort = {
    probe: vi.fn(async () => ({ scope, origin: 'https://www.meganovel.com' as const, blocker: 'none' as const })),
    snapshot: vi.fn(async () => structuredClone(snapshot)),
    createDraft: vi.fn(async input => { snapshot.candidates = [{ remoteChapterId: 'remote-1', number: 1, title: input.title,
      content: input.content, status: 'draft', aiDisclosure: 'declared_ai', evidence: 'Offline synthetic detail readback' }]; }),
    submit: vi.fn(async () => { snapshot.candidates[0]!.status = 'reviewing'; }),
  };
  const configure = () => createMegaNovelSchedulerPublisher(root, [{ workId: 'book', targetId: target.id,
    scope, firstNewChapter: 1, aiAssisted: true, browser }]);
  let publisher = configure(), clock = Date.now(), continuing = true;
  const pipeline = { writeChapters: vi.fn(), reviseDraft: vi.fn(), runWithAbortSignal: (_s: any, fn: any) => fn(),
    runWithAgentContext: (_ctx: any, fn: any) => fn(),
    reviewChapter: vi.fn(async () => ({ chapterNumber: 1, summary: 'Offline audit of the captured inputs.', observations: [],
      reviewInputs: await readChapterReviewInputs(bookDir, 1) })),
  };
  const createRunner = () => new AutonomousChapterRunner(root, pipeline as any, scheduler, {
    publisher, retryDelayMs: 1, publicationPollMs: 1000, now: () => clock, shouldContinue: () => continuing,
  });
  let runner = createRunner();
  const first = scheduler.reserve('book', 1, clock, 1)!;
  const job: ScheduledChapter = { ...first, phase: 'reviewing' }; scheduler.save(job, 'offline-fixture');
  cleanups.push(async () => { await publisher.close(); scheduler.close(); store.close(); await rm(root, { recursive: true, force: true }); });
  return { root, paths, bookDir, browser, snapshot, pipeline, store, job,
    publisher: () => publisher, latest: () => scheduler.latest('book')!,
    save: (job: ScheduledChapter) => scheduler.save(job, 'offline-fixture'),
    run: (job: ScheduledChapter) => runner.run(job, signal()), advance: () => { clock += 10000; },
    pause: () => { continuing = false; }, resume: () => { continuing = true; },
    restart: async () => { await publisher.close(); scheduler.close(); scheduler = new SchedulerStore(join(root, '.inkos/harness.sqlite'));
      publisher = configure(); runner = createRunner(); clock += 10000; },
    capture: () => readChapterReviewInputs(bookDir, 1),
  };
}

async function approvedButUnsubmitted(f: Awaited<ReturnType<typeof setup>>) {
  f.pipeline.reviewChapter.mockImplementationOnce(async () => {
    const reviewInputs = await f.capture(); f.pause();
    return { chapterNumber: 1, summary: 'Offline reviewed inputs.', observations: [], reviewInputs };
  });
  const accepted = await f.run(f.job); f.resume();
  expect(accepted.phase).toBe('publishing'); expect(accepted.reviewReceipt?.inputs).toEqual(await f.capture());
  expect(f.browser.createDraft).not.toHaveBeenCalled();
  return accepted;
}

it.each(['plan', 'brief', 'rules'] as const)('requires a new audit after only %s changes before any submission', async key => {
  const f = await setup(), accepted = await approvedButUnsubmitted(f);
  const before = await readFile(f.paths[key], 'utf8');
  const changed = key === 'plan' ? JSON.stringify({ ...JSON.parse(before), memo: { ...JSON.parse(before).memo, body: 'Reveal the sender now.' } }) : 'Reveal the sender now.';
  await writeFile(f.paths[key], changed);
  const invalidated = await f.run(accepted);
  expect(invalidated.phase).toBe('reviewing'); expect(invalidated.reviewReceipt).toBeUndefined();
  expect(invalidated.reviewChecks).toBe(1); expect(f.browser.createDraft).not.toHaveBeenCalled();
  const submitted = await f.run(invalidated);
  expect(submitted.publication?.status).toBe('submitted'); expect(f.pipeline.reviewChapter).toHaveBeenCalledTimes(2);
  expect(f.browser.createDraft).toHaveBeenCalledOnce(); expect(f.browser.submit).toHaveBeenCalledOnce();
});

it('resumes an unchanged receipt after process restart without reviewing or submitting twice', async () => {
  const f = await setup(), accepted = await approvedButUnsubmitted(f);
  await f.restart(); const submitted = await f.run(f.latest());
  expect(submitted.publication?.status).toBe('submitted'); expect(submitted.reviewReceipt).toEqual(accepted.reviewReceipt);
  await f.restart(); f.snapshot.candidates[0]!.status = 'published';
  const completed = await f.run(f.latest()); expect(completed.phase).toBe('completed');
  expect(f.pipeline.reviewChapter).toHaveBeenCalledOnce(); expect(f.browser.createDraft).toHaveBeenCalledOnce(); expect(f.browser.submit).toHaveBeenCalledOnce();
});

it('does not bind new inputs read after an in-flight audit to its older acceptance', async () => {
  const f = await setup();
  f.pipeline.reviewChapter.mockImplementationOnce(async () => {
    const reviewInputs = await f.capture(); await writeFile(f.paths.brief, 'Reveal the sender now.');
    return { chapterNumber: 1, summary: 'Acceptance of the old brief only.', observations: [], reviewInputs };
  });
  const result = await f.run(f.job);
  expect(result.phase).toBe('reviewing'); expect(result.reviewReceipt).toBeUndefined(); expect(result.reviewChecks).toBe(1);
  expect(f.browser.createDraft).not.toHaveBeenCalled();
  expect((await f.run(result)).publication?.status).toBe('submitted'); expect(f.pipeline.reviewChapter).toHaveBeenCalledTimes(2);
});

it('rechecks the actual authority after asynchronous remote preflight and before creating a draft', async () => {
  const f = await setup();
  vi.mocked(f.browser.snapshot).mockImplementationOnce(async () => {
    await writeFile(f.paths.brief, 'Reveal the sender now.'); return structuredClone(f.snapshot);
  });
  const changed = await f.run(f.job);
  expect(changed.phase).toBe('reviewing'); expect(f.browser.createDraft).not.toHaveBeenCalled(); expect(f.browser.submit).not.toHaveBeenCalled();
  expect((await f.run(changed)).publication?.status).toBe('submitted');
  expect(f.pipeline.reviewChapter).toHaveBeenCalledTimes(2); expect(f.browser.createDraft).toHaveBeenCalledOnce();
});

it('re-audits an edited verified draft before its first submit, retaining the same remote chapter', async () => {
  const f = await setup();
  vi.mocked(f.browser.createDraft).mockImplementationOnce(async (input, options) => {
    // Use the independent synthetic editor, then change only the local author brief.
    f.snapshot.candidates = [{ remoteChapterId: 'remote-1', number: 1, title: input.title, content: input.content,
      status: 'draft', aiDisclosure: 'declared_ai', evidence: 'Offline saved draft' }];
    await writeFile(f.paths.brief, 'Reveal the sender now.');
  });
  const changed = await f.run(f.job);
  expect(changed.phase).toBe('reviewing'); expect(changed.publicationStartedAt).toBeDefined(); expect(f.browser.submit).not.toHaveBeenCalled();
  await f.restart(); const submitted = await f.run(f.latest());
  expect(submitted.publication?.status).toBe('submitted'); expect(f.pipeline.reviewChapter).toHaveBeenCalledTimes(2);
  expect(f.browser.createDraft).toHaveBeenCalledOnce(); expect(f.browser.submit).toHaveBeenCalledOnce();
  expect(f.store.listPackages()).toHaveLength(1); expect(submitted.publication?.remoteChapterId).toBe('remote-1');
});

it.each(['submitted', 'submit_unknown', 'draft_unknown'] as const)('reconciles %s before inspecting changed or missing local review inputs', async phase => {
  const f = await setup();
  if (phase === 'submit_unknown') vi.mocked(f.browser.submit).mockRejectedValue(new Error('Offline lost acknowledgement'));
  if (phase === 'draft_unknown') vi.mocked(f.browser.createDraft).mockRejectedValue(new Error('Offline unknown autosave'));
  const original = await f.run(f.job), receipt = original.reviewReceipt;
  expect(original.phase).toBe('publishing');
  await writeFile(f.paths.brief, 'Reveal the sender now.'); await rm(f.paths.plan);
  // Unregistered prose is also irrelevant to readback of the already-frozen remote attempt.
  await writeFile(join(f.root, sourcePath), 'Unregistered newer prose, never submit this copy.');
  await f.restart(); const pending = await f.run(f.latest());
  expect(pending.phase).toBe('publishing'); expect(pending.reviewReceipt).toEqual(receipt);
  expect(f.pipeline.reviewChapter).toHaveBeenCalledOnce(); expect(f.browser.createDraft).toHaveBeenCalledOnce();
  expect(f.browser.submit).toHaveBeenCalledTimes(phase === 'draft_unknown' ? 0 : 1);
  f.snapshot.candidates = [{ remoteChapterId: 'remote-1', number: 1, title: 'Scene', content, status: 'published',
    aiDisclosure: 'declared_ai', evidence: 'Offline later published readback' }];
  f.advance(); const completed = await f.run(pending);
  expect(completed.phase).toBe('completed'); expect(completed.reviewReceipt).toEqual(receipt);
  expect(f.pipeline.reviewChapter).toHaveBeenCalledOnce(); expect(f.browser.createDraft).toHaveBeenCalledOnce();
});

it('waits through unknown draft outcome, then re-audits only after readback proves it remains unsubmitted', async () => {
  const f = await setup(); vi.mocked(f.browser.createDraft).mockRejectedValueOnce(new Error('Unknown save'));
  let job = await f.run(f.job); await writeFile(f.paths.brief, 'Changed brief.'); f.advance();
  job = await f.run(job); expect(job.phase).toBe('publishing'); expect(f.pipeline.reviewChapter).toHaveBeenCalledOnce();
  f.snapshot.candidates = [{ remoteChapterId: 'remote-1', number: 1, title: 'Scene', content, status: 'draft',
    aiDisclosure: 'declared_ai', evidence: 'Offline verified draft' }];
  f.advance(); job = await f.run(job); expect(job.phase).toBe('reviewing');
  job = await f.run(job); expect(job.publication?.status).toBe('submitted');
  expect(f.pipeline.reviewChapter).toHaveBeenCalledTimes(2); expect(f.browser.createDraft).toHaveBeenCalledOnce(); expect(f.browser.submit).toHaveBeenCalledOnce();
});

it('migrates an unsubmitted legacy receipt lazily, while leaving completed history intact', async () => {
  const f = await setup(), accepted = await approvedButUnsubmitted(f);
  const legacy = { ...accepted, reviewReceipt: { ...accepted.reviewReceipt!, inputs: undefined } };
  f.save(legacy); await f.restart();
  const invalidated = await f.run(f.latest()); expect(invalidated.phase).toBe('reviewing');
  expect((await f.run(invalidated)).publication?.status).toBe('submitted'); expect(f.pipeline.reviewChapter).toHaveBeenCalledTimes(2);
  const historical: ScheduledChapter = { ...legacy, phase: 'completed', publication: { status: 'published', remoteChapterId: 'remote-1' } };
  f.save(historical); await f.restart(); expect(await f.run(f.latest())).toEqual(historical);
  expect(f.pipeline.reviewChapter).toHaveBeenCalledTimes(2);
});

it('keeps a legacy submitted receipt and reconciles the already-published remote version once', async () => {
  const f = await setup(), submitted = await f.run(f.job);
  const legacy = { ...submitted, reviewReceipt: { ...submitted.reviewReceipt!, inputs: undefined } };
  f.save(legacy); await writeFile(f.paths.brief, 'A newer author instruction.'); await f.restart();
  f.snapshot.candidates[0]!.status = 'published';
  const completed = await f.run(f.latest()); expect(completed.phase).toBe('completed');
  expect(completed.reviewReceipt).toEqual(legacy.reviewReceipt); expect(f.pipeline.reviewChapter).toHaveBeenCalledOnce();
  expect(f.browser.createDraft).toHaveBeenCalledOnce(); expect(f.browser.submit).toHaveBeenCalledOnce();
});

it('ignores generated context and human-readable intent projections for receipt authority', async () => {
  const f = await setup(), accepted = await approvedButUnsubmitted(f);
  await writeFile(join(f.bookDir, 'story/runtime/chapter-0001.intent.md'), 'Changed projection, not the JSON memo.');
  await writeFile(join(f.bookDir, 'story/runtime/chapter-0001.context.json'), JSON.stringify({ generated: 'new cache' }));
  expect((await f.run(accepted)).publication?.status).toBe('submitted'); expect(f.pipeline.reviewChapter).toHaveBeenCalledOnce();
});

it('fails closed on malformed/future snapshot versions instead of silently upgrading approval', async () => {
  const f = await setup(), accepted = await approvedButUnsubmitted(f);
  const incompatible = { ...accepted, reviewReceipt: { ...accepted.reviewReceipt!, inputs: { ...accepted.reviewReceipt!.inputs!, version: 2 } as any } };
  f.save(incompatible); await f.restart(); expect((await f.run(f.latest())).phase).toBe('reviewing');
  expect(f.browser.submit).not.toHaveBeenCalled();
});

it('returns the exact pre-audit memo, brief and rules that shaped real PipelineRunner context selection', async () => {
  const f = await setup();
  const { PipelineRunner } = await import('../pipeline/runner.js');
  const { ComposerAgent } = await import('../agents/composer.js');
  const { ContinuityAuditor } = await import('../agents/continuity.js');
  const initial = await f.capture();
  const plan = JSON.parse(initial.plan!); plan.memo.threadRefs = ['resolved-hook'];
  await writeFile(f.paths.plan, JSON.stringify(plan));
  const expected = await f.capture();
  const selected = vi.spyOn(ComposerAgent.prototype, 'selectTaskContext').mockImplementationOnce(async input => {
    expect(input.goal).toBe(expected.authorBrief!.trim());
    expect(input.chapterMemo).toEqual(plan.memo);
    // These changes happen after context preparation has received its inputs.
    await writeFile(f.paths.plan, JSON.stringify({ ...plan, memo: { ...plan.memo, body: 'Reveal the sender.', threadRefs: [] } }));
    await writeFile(f.paths.brief, 'Reveal the sender.'); await writeFile(f.paths.rules, 'New rules.');
    return { chapter: 1, selectedContext: [] };
  });
  vi.spyOn(ContinuityAuditor.prototype, 'auditChapter').mockImplementationOnce(async (_dir, _content, _chapter, _genre, options) => {
    const entries = options.contextPackage.selectedContext;
    expect(entries.find(entry => entry.source === 'runtime/chapter_memo')?.excerpt).toContain(plan.memo.body);
    expect(entries.find(entry => entry.source === 'runtime/current_chapter_task')?.excerpt).toBe(expected.authorBrief!.trim());
    expect(entries.find(entry => entry.source === 'story/book_rules.md')?.excerpt).toBe(expected.bookRules);
    expect(JSON.stringify(entries)).not.toContain('Reveal the sender.');
    return { summary: 'Offline inspection of actual audit context.', observations: [] };
  });
  const pipeline = new PipelineRunner({ projectRoot: f.root, client: {} as any, model: 'offline-no-provider' });
  const result = await pipeline.reviewChapter('book', 1);
  expect(result.reviewInputs).toEqual(expected); expect(result.reviewInputs).not.toEqual(await f.capture());
  expect(selected).toHaveBeenCalledOnce();
});

it('does not invent an input snapshot for a review result produced by a legacy pipeline', async () => {
  const f = await setup();
  f.pipeline.reviewChapter.mockResolvedValueOnce({ chapterNumber: 1, summary: 'Legacy unbound review.', observations: [] } as any);
  const result = await f.run(f.job); expect(result.phase).toBe('reviewing'); expect(result.reviewReceipt).toBeUndefined();
  expect(f.browser.createDraft).not.toHaveBeenCalled();
});

it.each(['plan', 'brief', 'rules'] as const)('rejects non-lossless UTF-8 in %s instead of accepting replacement-character collisions', async key => {
  const f = await setup(); await writeFile(f.paths[key], Buffer.from([0xc0, 0xaf]));
  await expect(f.capture()).rejects.toMatchObject({ code: 'CHAPTER_REVIEW_INPUTS_UNREADABLE' });
  expect(f.browser.createDraft).not.toHaveBeenCalled();
});
