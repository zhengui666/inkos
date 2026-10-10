import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StateManager } from '../state/manager.js';
import { syncWorkSourceArtifacts } from '../harness/source-sync.js';
import { loadWorkManifest } from '../harness/work-store.js';
import { SchedulerStore, type ScheduledChapter } from '../pipeline/scheduler-store.js';
import { AutonomousChapterRunner } from '../pipeline/autonomous-chapters.js';
import { ChapterReviewInputsSchema, readChapterReviewInputs, sameChapterReviewInputs } from '../pipeline/review-inputs.js';
import { PublishingStore } from '../publishing/store.js';
import { ManualPublishingAdapter } from '../publishing/manual-adapter.js';
import { createMegaNovelSchedulerPublisher } from '../publishing/scheduler-publisher.js';
import type { MegaNovelBrowserPort, MegaNovelSnapshot } from '../publishing/meganovel-contracts.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); cdp.connect.mockReset(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const signal = () => new AbortController().signal;
const scope = { sessionId: 'offline', accountId: '700', accountLabel: 'Synthetic author', remoteBookId: '99' };
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
    createDraft: vi.fn(async input => { snapshot.candidates = [{ remoteChapterId: '102', number: 1, title: input.title,
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

async function approvedButUnsubmitted(f: Awaited<ReturnType<typeof setup>>) {
  f.pipeline.reviewChapter.mockImplementationOnce(async () => {
    const reviewInputs = await f.capture(), reviewPolicy = await f.capturePolicy(); f.pause();
    return { chapterNumber: 1, summary: 'Offline reviewed inputs.', observations: reviewPolicy.requireStoryClosure ? [closureObservation] : [], reviewInputs, reviewPolicy };
  });
  const accepted = await f.run(f.job); f.resume();
  expect(accepted.phase).toBe('publishing'); expect(accepted.reviewReceipt?.inputs).toEqual(await f.capture());
  expect(f.browser.createDraft).not.toHaveBeenCalled();
  return accepted;
}


import { EventEmitter } from 'node:events';
import { connectMegaNovelCdpPort, type MegaNovelDomBinding } from '../publishing/meganovel-cdp.js';
const cdp = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock('playwright-core', () => ({ chromium: { connectOverCDP: cdp.connect } }));


const readBoundary = vi.hoisted(() => ({ hook: undefined as undefined | ((path: unknown) => Promise<void>) }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: async (...args: Parameters<typeof actual.readFile>) => {
    const data = await actual.readFile(...args);
    await readBoundary.hook?.(args[0]);
    return data;
  } };
});
afterEach(() => { readBoundary.hook = undefined; });

import type { Page } from 'playwright-core';
import { createMegaNovelDomBinding } from '../publishing/meganovel-dom-binding.js';
const origin = 'https://www.meganovel.com';
type Identity = 'correct' | 'wrong' | 'unknown' | 'logged_out';
type Transition = {at: 'new_chapter' | 'publish_dialog' | 'typing_batch'; identity: Identity};

function locator(options: {
  count?: () => number; text?: () => string; value?: () => string;
  click?: (options?: {trial?: boolean}) => void; fill?: (value: string) => void;
  locator?: (selector: string) => unknown; getByText?: (text: string | RegExp) => unknown;
  nth?: (index: number) => unknown; texts?: () => string[]; evaluate?: () => unknown;
  checked?: () => boolean; press?: () => void;
} = {}) {
  const count = () => options.count?.() ?? 1;
  const result = {
    count: async () => count(), isVisible: async () => count() > 0,
    waitFor: async () => { if (!count()) throw new Error('Synthetic visible control is absent'); },
    filter: () => result, innerText: async () => options.text?.() ?? '',
    inputValue: async () => options.value?.() ?? '',
    click: async (input?: {trial?: boolean}) => { options.click?.(input); },
    fill: async (value: string) => { if (!options.fill) throw new Error('Unexpected fill'); options.fill(value); },
    locator: (selector: string) => options.locator?.(selector),
    getByText: (text: string | RegExp) => options.getByText?.(text), nth: (index: number) => options.nth?.(index),
    allTextContents: async () => options.texts?.() ?? [], evaluate: async () => options.evaluate?.(),
    isChecked: async () => options.checked?.() ?? false,
    press: async () => { options.press?.(); },
    elementHandle: async () => ({dispose: async () => undefined}),
  };
  return result;
}

function domFixture(initial: Identity = 'correct', transition?: Transition, accountDelayMs = 0) {
  const state = {identity: initial, url: `${origin}/create_chapter/99?chapterId=102`,
    title: 'Second', body: 'Synthetic body.', dialog: false, now: false,
    inputs: 0, saves: 0, publishes: 0, accountReads: 0, accountClosed: 0};
  const entered = () => {
    state.inputs++;
    if (transition?.at === 'typing_batch' && state.inputs >= 5) state.identity = transition.identity;
  };
  const absent = () => locator({count: () => 0});
  const body = locator({text: () => state.body, fill: value => { state.body = value; entered(); },
    evaluate: () => true, press: () => { state.body += '\n'; entered(); }});
  const title = locator({value: () => state.title, fill: value => { state.title = value; entered(); }});
  const row = (index: number) => locator({text: () => `${2 - index}\n${index ? 'First' : 'Second'}\nUnpublished`,
    locator: () => absent(), getByText: text => locator({count: () => Number(text === 'Unpublished')})});
  const accountPage = {
    goto: async (url: string) => {
      expect(url).toBe(`${origin}/uc`); state.accountReads++;
      if (accountDelayMs) await new Promise(resolve => setTimeout(resolve, accountDelayMs));
    },
    locator: (selector: string) => selector === '.user-center div.user-center-top'
      ? locator({count: () => Number(state.identity !== 'logged_out'), locator: () => locator({texts: () =>
        state.identity === 'unknown' ? [] : [`ID: ${state.identity === 'wrong' ? '701' : scope.accountId}`]})})
      : absent(),
    close: async () => { state.accountClosed++; },
  };
  const page = {
    url: () => state.url, goto: async (url: string) => { state.url = url; },
    frames: () => [{locator: () => body}], context: () => ({newPage: async () => accountPage}),
    keyboard: {insertText: async (value: string) => { state.body += value; entered(); }},
    waitForURL: async (predicate: (url: URL) => boolean) => { expect(predicate(new URL(state.url))).toBe(true); },
    getByRole: () => locator({checked: () => state.now}),
    getByText: (text: string | RegExp) => {
      if (typeof text !== 'string') return absent();
      return locator({count: () => Number(state.dialog), evaluate: () => ({text: 'Publish Schedule Now Later Confirm CANCEL', extraFields: false}),
        click: () => { if (text === 'Now') state.now = true; if (text === 'Confirm') state.publishes++; }});
    },
    locator: (selector: string) => {
      if (selector.startsWith('input[')) return title;
      if (selector === 'ul.episode-list') return locator({evaluate: () => ({scrollHeight: 100, clientHeight: 150, scrollTop: 0})});
      if (selector === 'ul.episode-list li.episode-unit') return locator({count: () => 2, nth: row});
      if (selector === '[role="dialog"], [aria-modal="true"], dialog[open]') return absent();
      if (selector === 'div.top div.side-bar-title') return locator({click: () => {
        state.url = `${origin}/create_chapter/99`; state.title = ''; state.body = '';
        if (transition?.at === 'new_chapter') state.identity = transition.identity;
      }});
      if (selector === 'div.menu-publish.menu_save') return locator({click: () => {
        state.saves++; state.url = `${origin}/create_chapter/99?chapterId=103`;
      }});
      if (selector === 'div.menu-publish.menu_pub') return locator({click: () => {
        state.dialog = true; if (transition?.at === 'publish_dialog') state.identity = transition.identity;
      }});
      throw new Error(`Unexpected synthetic selector: ${selector}`);
    },
  };
  const input = {packageId: 'auth-fixture-package', chapterNumber: 2, scope, aiAssisted: true,
    title: 'Second', content: 'Synthetic body.', revisionId: 'auth-fixture-revision', remoteChapterId: '102'};
  return {state, page: page as unknown as Page, input, binding: createMegaNovelDomBinding({uiTimeoutMs: 100}),
    signal: new AbortController().signal};
}


// Actual production DOM submit runs against Page doubles copied from the repository auth-guard test.
// Inject the concurrent change during the final guard immediately before Confirm.
it.each(['language', 'closure', 'styleGuide'] as const)('rejects %s changing while the final guard awaits the retained snapshot', async kind => {
  const f = await setup();
  const dom = domFixture(); dom.state.title = 'Scene'; dom.state.body = content;
  const events = new EventEmitter();
  let connected = true, inFinalGuard = false, snapshotReads = 0, changed = false;
  let retained: { job: ScheduledChapter; packageId: string; remoteChapterId: string; revisionId: string } | undefined;
  const submissionAuthorizations: MockInstance<() => void>[] = [];
  const page = Object.assign(dom.page, {isClosed: () => false,
    setDefaultTimeout: vi.fn(), setDefaultNavigationTimeout: vi.fn()});
  const context = { pages: () => [page], newCDPSession: async () => ({
    send: async () => ({ targetInfo: { targetId: scope.sessionId } }), detach: vi.fn() }) };
  cdp.connect.mockResolvedValue({ once: events.once.bind(events),
    close: vi.fn(async () => { connected = false; events.emit('disconnected'); }),
    isConnected: () => connected, contexts: () => [context] });
  const originalCreate = f.browser.createDraft;
  const originalSubmit = f.browser.submit;
  const binding: MegaNovelDomBinding = { protocol: 'inkos-meganovel-dom-v1',
    calibration: { observedAt: '2026-10-06T00:00:00Z', evidence: 'Offline independent boundary fixture only.' },
    probe: vi.fn(async () => ({ scope, origin: 'https://www.meganovel.com' as const, blocker: 'none' as const })),
    snapshot: vi.fn(async () => structuredClone(f.snapshot)),
    createDraft: vi.fn(async (_page, input, signal, beforeMutation) => originalCreate(input, { signal, beforeMutation })),
    submit: vi.fn(async (_page, input, signal, beforeMutation) => {
      if (!beforeMutation?.authorizeSubmission) throw new Error('Final submit requires the forwarded synchronous authority guard.');
      submissionAuthorizations.push(vi.spyOn(beforeMutation, 'authorizeSubmission'));
      inFinalGuard = true;
      await dom.binding.submit(dom.page, input, signal, beforeMutation);
      inFinalGuard = false;
      await originalSubmit(input, { signal });
    }),
  };
  readBoundary.hook = async path => {
    if (!inFinalGuard || !dom.state.now || changed || !String(path).includes('/revisions/') || !String(path).endsWith('.md')) return;
    snapshotReads++;
    // The autonomous callback checks this snapshot first, then reads language.
    // The publisher wrapper checks it again AFTER that policy check.
    if (snapshotReads === 2) {
      const pkg = f.store.listPackages()[0]!;
      const run = f.store.getMegaNovelRun(pkg.manifest.id, 1)!;
      expect(run.remoteChapterId).toBe('102');
      retained = { job: structuredClone(f.latest()), packageId: pkg.manifest.id,
        remoteChapterId: run.remoteChapterId!, revisionId: run.revisionId };
      changed = true;
      if (kind === 'language') await f.setLanguage('zh');
      else if (kind === 'closure') f.setClosure(true);
      else await writeFile(f.paths.styleGuide, 'Changed during last awaited snapshot read.');
    }
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
  console.log(JSON.stringify({ kind, changed, snapshotReads, phase: result.phase, receiptPolicy: retained?.job.reviewReceipt?.reviewPolicy,
    currentPolicy: await f.capturePolicy(), authorityStillMatches: sameChapterReviewInputs(retained?.job.reviewReceipt?.inputs, await f.capture()),
    receiptRetainedAfterStop: Boolean(result.reviewReceipt), remoteStatus: f.snapshot.candidates[0]?.status,
    confirmClicks: dom.state.publishes, actualSubmissions: vi.mocked(originalSubmit).mock.calls.length }));
  expect(changed).toBe(true);
  expect(originalSubmit).not.toHaveBeenCalled();
  expect(dom.state.publishes).toBe(0);
  expect(retained).toBeDefined();
  expect(result.phase).toBe('reviewing');
  expect(result.reviewReceipt).toBeUndefined();
  expect(result.revisionId).toBe(retained!.revisionId);
  expect(result.publicationStartedAt).toBe(retained!.job.publicationStartedAt);
  expect(result.publication).toEqual(retained!.job.publication);
  expect(result.reviewChecks).toBe(retained!.job.reviewChecks);
  expect(result.reviewAttempts).toBe(retained!.job.reviewAttempts);
  expect(result.reviewUnavailableChecks).toBe(retained!.job.reviewUnavailableChecks);
  expect(f.latest()).toEqual(result);
  expect(originalCreate).toHaveBeenCalledOnce();
  expect(f.snapshot.candidates).toHaveLength(1);
  expect(f.snapshot.candidates[0]).toMatchObject({ remoteChapterId: retained!.remoteChapterId, status: 'draft' });
  expect(f.store.listPackages()).toHaveLength(1);
  expect(f.store.listPackages()[0]!.manifest.id).toBe(retained!.packageId);
  expect(f.store.getMegaNovelRun(retained!.packageId, 1)).toMatchObject({ phase: 'draft',
    remoteChapterId: retained!.remoteChapterId, revisionId: retained!.revisionId });

  await f.restart();
  expect(f.latest()).toEqual(result);
  const resumed = await f.run(f.latest());
  expect(resumed.phase).toBe('publishing');
  expect(resumed.publication).toMatchObject({ status: 'submitted', remoteChapterId: retained!.remoteChapterId });
  expect(resumed.reviewReceipt?.inputs).toEqual(await f.capture());
  expect(resumed.reviewReceipt?.reviewPolicy).toEqual(await f.capturePolicy());
  expect(resumed.reviewChecks).toBe((retained!.job.reviewChecks ?? 0) + 1);
  expect(resumed.reviewAttempts).toBe(retained!.job.reviewAttempts);
  expect(resumed.reviewUnavailableChecks).toBe(retained!.job.reviewUnavailableChecks);
  expect(resumed.revisionId).toBe(retained!.revisionId);
  expect(resumed.publicationStartedAt).toBe(retained!.job.publicationStartedAt);
  expect(f.pipeline.reviewChapter).toHaveBeenCalledTimes(2);
  expect(f.pipeline.writeChapters).not.toHaveBeenCalled();
  expect(f.pipeline.reviseDraft).not.toHaveBeenCalled();
  expect(originalCreate).toHaveBeenCalledOnce();
  expect(originalSubmit).toHaveBeenCalledOnce();
  expect(dom.state.publishes).toBe(1);
  expect(submissionAuthorizations).toHaveLength(2);
  expect(submissionAuthorizations[1]).toHaveBeenCalled();
  expect(f.store.listPackages()).toHaveLength(1);
  expect(f.store.listPackages()[0]!.manifest.id).toBe(retained!.packageId);
  expect(f.store.listPackages()[0]!.manifest.chapters[0]!.revisionId).toBe(retained!.revisionId);
  expect(f.store.getMegaNovelRun(retained!.packageId, 1)).toMatchObject({ phase: 'reviewing',
    remoteChapterId: retained!.remoteChapterId, revisionId: retained!.revisionId });

  await f.restart();
  const afterSubmittedRestart = await f.run(f.latest());
  expect(afterSubmittedRestart.publication).toMatchObject({ status: 'submitted', remoteChapterId: retained!.remoteChapterId });
  expect(afterSubmittedRestart.reviewChecks).toBe(resumed.reviewChecks);
  expect(f.pipeline.reviewChapter).toHaveBeenCalledTimes(2);
  expect(originalCreate).toHaveBeenCalledOnce();
  expect(originalSubmit).toHaveBeenCalledOnce();
  expect(dom.state.publishes).toBe(1);
  expect(f.store.listPackages()).toHaveLength(1);
  expect(f.store.listPackages()[0]!.manifest.id).toBe(retained!.packageId);
  console.log(JSON.stringify({ kind, afterReapprovalAndSubmittedRestart: {
    samePackageId: f.store.listPackages()[0]!.manifest.id === retained!.packageId,
    sameRevisionId: afterSubmittedRestart.revisionId === retained!.revisionId,
    remoteChapterId: afterSubmittedRestart.publication?.remoteChapterId,
    packageCount: f.store.listPackages().length, draftCalls: vi.mocked(originalCreate).mock.calls.length,
    confirmClicks: dom.state.publishes, actualSubmissions: vi.mocked(originalSubmit).mock.calls.length,
    reviewChecks: afterSubmittedRestart.reviewChecks, reviewAttempts: afterSubmittedRestart.reviewAttempts,
    reviewCalls: f.pipeline.reviewChapter.mock.calls.length,
  } }));
});
