import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StateManager } from '../state/manager.js';
import { syncWorkSourceArtifacts } from '../harness/source-sync.js';
import { SchedulerStore, type ScheduledChapter } from '../pipeline/scheduler-store.js';
import { AutonomousChapterRunner } from '../pipeline/autonomous-chapters.js';
import { readChapterReviewInputs } from '../pipeline/review-inputs.js';
import { PublishingStore } from '../publishing/store.js';
import { ManualPublishingAdapter } from '../publishing/manual-adapter.js';
import { createMegaNovelSchedulerPublisher } from '../publishing/scheduler-publisher.js';
import type { MegaNovelBrowserPort, MegaNovelRun, MegaNovelSnapshot } from '../publishing/meganovel-contracts.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); cdp.connect.mockReset(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const signal = () => new AbortController().signal;
const scope = { sessionId: 'offline', accountId: 'author', accountLabel: 'Synthetic author', remoteBookId: 'synthetic-book' };
const content = 'Neri hid the sealed letter and left the parcel on her own bench.\n';
const sourcePath = 'works/book/source/chapters/0001_Scene.md';
const rawFields = ['bookRulesJson', 'authorIntent', 'currentFocus', 'styleGuide', 'parentCanon', 'fanficCanon'] as const;
const rawFileNames = { bookRulesJson: 'book_rules.json', authorIntent: 'author_intent.md', currentFocus: 'current_focus.md',
  styleGuide: 'style_guide.md', parentCanon: 'parent_canon.md', fanficCanon: 'fanfic_canon.md' } as const;
const bookRulesJson = JSON.stringify({ version: '2', prohibitions: [], enableFullCastTracking: false, allowedDeviations: [] });
const closureObservation = { code: 'story-closure', category: 'quality' as const, assessment: 'observation' as const,
  summary: 'The sealed letter closes the promise.', evidence: [], sourceRefs: [{ sourceId: 'chapter-1', quote: 'Neri hid the sealed letter' }] };

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
  const paths = { plan: join(runtime, 'chapter-0001.plan.json'), brief: join(runtime, 'chapter-0001.user-brief.md'), rules: join(bookDir, 'story/book_rules.md'),
    bookRulesJson: join(bookDir, 'story', rawFileNames.bookRulesJson), authorIntent: join(bookDir, 'story', rawFileNames.authorIntent),
    currentFocus: join(bookDir, 'story', rawFileNames.currentFocus), styleGuide: join(bookDir, 'story', rawFileNames.styleGuide),
    parentCanon: join(bookDir, 'story', rawFileNames.parentCanon), fanficCanon: join(bookDir, 'story', rawFileNames.fanficCanon) };
  await writeFile(paths.plan, JSON.stringify({ version: 2, intent: { chapter: 1, goal: 'Keep the sender secret' },
    memo: { chapter: 1, goal: 'Keep the sender secret', body: 'Do not identify the sender.', threadRefs: [] }, plannerInputs: [] }));
  await writeFile(paths.brief, 'Keep the sender secret.\n');
  await writeFile(paths.rules, 'Preserve the original author instructions.\n');
  for (const key of rawFields) await writeFile(paths[key], key === 'bookRulesJson' ? bookRulesJson : `原文 ${key}: café\r\n`);
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
  let publisher = configure(), clock = Date.now(), continuing = true, requireStoryClosure = false;
  const capturePolicy = async () => ({ requireStoryClosure, language: (await state.loadBookConfig('book')).language });
  const pipeline = { writeChapters: vi.fn(), reviseDraft: vi.fn(), runWithAbortSignal: (_s: any, fn: any) => fn(),
    runWithAgentContext: (_ctx: any, fn: any) => fn(),
    reviewChapter: vi.fn(async (_workId?: string, _chapter?: number, options?: { requireStoryClosure?: boolean }) => ({
      chapterNumber: 1, summary: 'Offline audit of the captured inputs.',
      observations: options?.requireStoryClosure ? [closureObservation] : [],
      reviewInputs: await readChapterReviewInputs(bookDir, 1),
      reviewPolicy: { requireStoryClosure: options?.requireStoryClosure === true, language: (await state.loadBookConfig('book')).language },
    })),
  };
  const createRunner = () => new AutonomousChapterRunner(root, pipeline as any, scheduler, {
    publisher, retryDelayMs: 1, publicationPollMs: 1000, now: () => clock, shouldContinue: () => continuing,
    requireStoryClosure: () => requireStoryClosure,
  });
  let runner = createRunner();
  const first = scheduler.reserve('book', 1, clock, 1)!;
  const job: ScheduledChapter = { ...first, phase: 'reviewing' }; scheduler.save(job, 'offline-fixture');
  cleanups.push(async () => { await publisher.close(); scheduler.close(); store.close(); await rm(root, { recursive: true, force: true }); });
  return { root, paths, bookDir, browser, snapshot, pipeline, store, job, capturePolicy,
    setClosure: (value: boolean) => { requireStoryClosure = value; },
    setLanguage: async (language: 'zh' | 'en') => { await state.saveBookConfig('book', { ...await state.loadBookConfig('book'), language }); },
    publisher: () => publisher, latest: () => scheduler.latest('book')!,
    save: (job: ScheduledChapter) => scheduler.save(job, 'offline-fixture'),
    run: (job: ScheduledChapter) => runner.run(job, signal()), advance: () => { clock += 10000; },
    pause: () => { continuing = false; }, resume: () => { continuing = true; },
    restart: async () => { await publisher.close(); scheduler.close(); scheduler = new SchedulerStore(join(root, '.inkos/harness.sqlite'));
      publisher = configure(); runner = createRunner(); clock += 10000; },
    capture: () => readChapterReviewInputs(bookDir, 1),
  };
}

import { EventEmitter } from 'node:events';
import { connectMegaNovelCdpPort, type MegaNovelDomBinding } from '../publishing/meganovel-cdp.js';
const cdp = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock('playwright-core', () => ({ chromium: { connectOverCDP: cdp.connect } }));

// The real adapter and CDP port run here. Only the browser driver and semantic audit are synthetic.
// Expected contract: a positively known draft stopped BEFORE browser mutation returns to reviewing.
it.each(['styleGuide', 'language', 'closure'] as const)('returns to review after %s changes during actual CDP submit preflight', async changed => {
  const f = await setup();
  const events = new EventEmitter();
  let connected = true, changedOnce = false;
  let reservation: MegaNovelRun | undefined, acceptedBeforeChange: ScheduledChapter | undefined;
  const page = { url: () => 'https://www.meganovel.com/fixture-only', isClosed: () => false,
    setDefaultTimeout: vi.fn(), setDefaultNavigationTimeout: vi.fn() };
  const context = { pages: () => [page], newCDPSession: async () => ({
    send: async () => ({ targetInfo: { targetId: scope.sessionId } }), detach: vi.fn() }) };
  const driver = { once: events.once.bind(events),
    close: vi.fn(async () => { connected = false; events.emit('disconnected'); }),
    isConnected: () => connected, contexts: () => [context] };
  cdp.connect.mockResolvedValue(driver);
  const originalCreate = f.browser.createDraft;
  const originalSubmit = f.browser.submit;
  const binding: MegaNovelDomBinding = { protocol: 'inkos-meganovel-dom-v1',
    calibration: { observedAt: '2026-10-06T00:00:00Z', evidence: 'Offline independent boundary fixture only.' },
    probe: vi.fn(async () => {
      const pkg = f.store.listPackages()[0];
      const run = pkg && f.store.getMegaNovelRun(pkg.manifest.id, 1);
      if (!changedOnce && run?.phase === 'submit_unknown') {
        changedOnce = true;
        reservation = structuredClone(run); acceptedBeforeChange = structuredClone(f.latest());
        if (changed === 'styleGuide') await writeFile(f.paths.styleGuide, 'Changed during CDP preflight.');
        else if (changed === 'language') await f.setLanguage('zh');
        else f.setClosure(true);
      }
      return { scope, origin: 'https://www.meganovel.com' as const, blocker: 'none' as const };
    }),
    snapshot: vi.fn(async () => structuredClone(f.snapshot)),
    createDraft: vi.fn(async (_page, input, signal, beforeMutation) => originalCreate(input, { signal, beforeMutation })),
    submit: vi.fn(async (_page, input, signal, beforeMutation) => originalSubmit(input, { signal, beforeMutation })),
  };
  const port = await connectMegaNovelCdpPort({ endpointURL: 'ws://127.0.0.1:9222/devtools/browser/offline',
    scope, lockDirectory: join(f.root, 'offline-cdp-locks'), operationTimeoutMs: 5000,
    authorization: { automation: { provenance: 'user_reported', reference: 'Offline fixture' },
      aiAssistedContent: { provenance: 'user_reported', reference: 'Offline fixture' } } }, binding);
  cleanups.push(() => port.close());
  f.browser.probe = vi.fn((input, options) => port.probe(input, options));
  f.browser.snapshot = vi.fn((input, options) => port.snapshot(input, options));
  f.browser.createDraft = vi.fn((input, options) => port.createDraft(input, options));
  f.browser.submit = vi.fn((input, options) => port.submit(input, options));
  const result = await f.run(f.job);
  expect(changedOnce).toBe(true);
  expect(binding.createDraft).toHaveBeenCalledOnce();
  expect(binding.submit).not.toHaveBeenCalled(); // No actual submission took place.
  expect(originalSubmit).not.toHaveBeenCalled();
  expect(f.snapshot.candidates[0]!.status).toBe('draft');
  const frozen = f.store.listPackages()[0]!;
  const durable = f.store.getMegaNovelRun(frozen.manifest.id, 1)!;
  expect(result.phase).toBe('reviewing');
  expect(result.reviewReceipt).toBeUndefined();
  expect(durable.phase).toBe('draft');
  expect(durable.packageId).toBe(reservation!.packageId);
  expect(durable.remoteChapterId).toBe(reservation!.remoteChapterId);
  expect(durable.revisionId).toBe(reservation!.revisionId);
  expect(frozen.manifest.id).toBe(reservation!.packageId);
  expect(frozen.manifest.chapters[0]!.revisionId).toBe(reservation!.revisionId);
  expect(result.revisionId).toBe(acceptedBeforeChange!.revisionId);
  expect(result.publicationStartedAt).toBe(acceptedBeforeChange!.publicationStartedAt);
  expect(result.publication).toEqual(acceptedBeforeChange!.publication);
  expect(result.reviewChecks).toBe(1); expect(result.reviewChecks).toBe(acceptedBeforeChange!.reviewChecks);
  expect(result.reviewAttempts).toBe(acceptedBeforeChange!.reviewAttempts);
  expect(result.reviewUnavailableChecks).toBe(acceptedBeforeChange!.reviewUnavailableChecks);
  expect(f.pipeline.reviewChapter).toHaveBeenCalledOnce();

  // Suspend publication after the new review, so recovery and final submission
  // are independently visible rather than hidden in one scheduler tick.
  f.pipeline.reviewChapter.mockImplementationOnce(async () => {
    const reviewInputs = await f.capture(), reviewPolicy = await f.capturePolicy(); f.pause();
    return { chapterNumber: 1, summary: 'Offline review after blocked CDP preflight.',
      observations: reviewPolicy.requireStoryClosure ? [closureObservation] : [], reviewInputs, reviewPolicy };
  });
  await f.restart();
  const resumed = await f.run(f.latest());
  expect(binding.submit).not.toHaveBeenCalled();
  expect(resumed.phase).toBe('publishing');
  expect(resumed.reviewReceipt?.inputs).toEqual(await f.capture());
  expect(resumed.reviewReceipt?.reviewPolicy).toEqual(await f.capturePolicy());
  expect(resumed.reviewChecks).toBe(2); expect(resumed.reviewAttempts).toBe(result.reviewAttempts);
  expect(resumed.revisionId).toBe(result.revisionId);
  expect(resumed.publicationStartedAt).toBe(result.publicationStartedAt);
  expect(f.pipeline.reviewChapter).toHaveBeenCalledTimes(2);
  expect(f.store.getMegaNovelRun(frozen.manifest.id, 1)?.phase).toBe('draft');
  expect(f.store.listPackages()).toHaveLength(1);

  f.resume(); const submitted = await f.run(resumed);
  expect(submitted.publication?.status).toBe('submitted');
  expect(submitted.publication?.remoteChapterId).toBe(durable.remoteChapterId);
  expect(binding.createDraft).toHaveBeenCalledOnce(); expect(originalCreate).toHaveBeenCalledOnce();
  expect(binding.submit).toHaveBeenCalledOnce(); expect(originalSubmit).toHaveBeenCalledOnce();
  const sent = vi.mocked(binding.submit).mock.calls[0]![1];
  expect(sent.packageId).toBe(durable.packageId); expect(sent.remoteChapterId).toBe(durable.remoteChapterId);
  expect(sent.revisionId).toBe(durable.revisionId);
  expect(f.store.listPackages()).toHaveLength(1);
  expect(f.store.listPackages()[0]!.manifest.id).toBe(frozen.manifest.id);
  expect(submitted.reviewChecks).toBe(2); expect(submitted.reviewAttempts).toBe(result.reviewAttempts);

  await f.restart(); const reconciled = await f.run(f.latest());
  expect(reconciled.publication?.status).toBe('submitted'); expect(binding.submit).toHaveBeenCalledOnce();
  f.snapshot.candidates[0]!.status = 'published'; f.advance();
  const completed = await f.run(reconciled); expect(completed.phase).toBe('completed');
  await f.restart(); expect(await f.run(f.latest())).toEqual(completed);
  expect(binding.createDraft).toHaveBeenCalledOnce(); expect(binding.submit).toHaveBeenCalledOnce();
  expect(f.pipeline.reviewChapter).toHaveBeenCalledTimes(2);
  console.log(JSON.stringify({ changed, phase: result.phase, reviewChecks: result.reviewChecks,
    durablePhase: durable.phase, packageId: durable.packageId, remoteChapterId: durable.remoteChapterId, revisionId: durable.revisionId,
    afterRestart: { phase: resumed.phase, reviewChecks: resumed.reviewChecks, receiptRetained: !!resumed.reviewReceipt },
    finalPhase: completed.phase, actualSubmissions: vi.mocked(binding.submit).mock.calls.length }));
});
