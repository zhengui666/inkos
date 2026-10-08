import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInitialWorkManifestWrite, syncWorkSourceArtifacts } from '../harness/source-sync.js';
import { loadWorkManifest } from '../harness/work-store.js';
import { commitAtomicFileSet } from '../utils/atomic-file-set.js';
import { ManualPublishingAdapter, PublishingStore, MegaNovelPublishingAdapter,
  type MegaNovelBrowserPort, type MegaNovelIntent, type MegaNovelSnapshot } from '../publishing/index.js';

let root: string;
let store: PublishingStore;
let packages: ManualPublishingAdapter;
let adapter: MegaNovelPublishingAdapter;
let intent: MegaNovelIntent;
let snapshot: MegaNovelSnapshot;
let browser: MegaNovelBrowserPort;
const content = 'The reviewed chapter body.\n';
const row = (): MegaNovelSnapshot['candidates'][number] => ({remoteChapterId: 'chapter-1', number: 1,
  title: 'The First Chapter', content, aiDisclosure: 'declared_ai', status: 'draft',
  evidence: 'Synthetic reopened chapter detail, not platform acceptance'});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'inkos-meganovel-'));
  const writes = [{relativePath: 'works/book/source/chapters/1.md', content}];
  const initial = createInitialWorkManifestWrite({workId: 'book', title: 'Test book', profileId: 'long-form', language: 'en', writes});
  await commitAtomicFileSet({rootDir: root, writes: [...writes, initial.write]});
  store = new PublishingStore(join(root, '.inkos', 'harness.sqlite'));
  packages = new ManualPublishingAdapter(root, store);
  const target = await packages.mapBook({workId: 'book', platform: 'meganovel', accountLabel: 'author', remoteBookId: 'book-123'});
  const artifact = (await loadWorkManifest(root, 'book')).artifacts[0]!;
  const pkg = await packages.prepare({targetId: target.id,
    chapters: [{artifactId: artifact.id, revisionId: artifact.currentRevisionId!, number: 1, title: 'The First Chapter'}], formats: ['txt']});
  intent = {packageId: pkg.manifest.id, chapterNumber: 1, aiAssisted: true,
    scope: {sessionId: 'target-1', accountId: 'account-123', accountLabel: 'author', remoteBookId: 'book-123'}};
  snapshot = {scope: intent.scope, origin: 'https://www.meganovel.com', blocker: 'none', chapterNumber: 1, complete: true, candidates: []};
  browser = {
    probe: vi.fn(async () => ({scope: snapshot.scope, origin: snapshot.origin, blocker: snapshot.blocker})),
    snapshot: vi.fn(async () => structuredClone(snapshot)),
    createDraft: vi.fn(async input => {
      expect(store.getMegaNovelRun(intent.packageId, 1)?.phase).toBe('draft_unknown');
      expect(input.content).toBe(content);
      snapshot.candidates = [row()];
    }),
    submit: vi.fn(async () => {
      expect(store.getMegaNovelRun(intent.packageId, 1)?.phase).toBe('submit_unknown');
      snapshot.candidates = [{...row(), status: 'reviewing'}];
    }),
  };
  adapter = new MegaNovelPublishingAdapter(packages, store, browser);
});
afterEach(async () => { store.close(); await rm(root, {recursive: true, force: true}); });

describe('MegaNovel durable browser protocol (synthetic port, not live publication)', () => {
  it.each(['draft', 'submitted', 'reviewing', 'published', 'rejected'] as const)(
    'requires fresh readback when an observed %s chapter disappears, preserving its run until read-only recovery', async status => {
    snapshot.candidates = [{...row(), status}];
    const retained = await adapter.reconcile(intent);
    const retainedPackage = store.getPackage(intent.packageId);
    store.close(); store = new PublishingStore(join(root, '.inkos', 'harness.sqlite'));
    packages = new ManualPublishingAdapter(root, store);
    adapter = new MegaNovelPublishingAdapter(packages, store, browser);
    snapshot.candidates = [];
    for (const entry of ['reconcile', 'saveDraft', 'submit'] as const) {
      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(adapter[entry](intent)).rejects.toMatchObject({code: 'MEGANOVEL_READBACK_REQUIRED'});
        expect(store.getMegaNovelRun(intent.packageId, 1)).toEqual(retained);
        expect(store.getPackage(intent.packageId)).toEqual(retainedPackage);
      }
    }
    snapshot.complete = false;
    await expect(adapter.reconcile(intent)).rejects.toMatchObject({code: 'MEGANOVEL_INCOMPLETE_LOOKUP'});
    snapshot.complete = true;
    for (const conflict of [{remoteChapterId: 'different-id'}, {content: 'different body'}]) {
      snapshot.candidates = [{...row(), status, ...conflict}];
      for (const entry of ['reconcile', 'saveDraft', 'submit'] as const) {
        await expect(adapter[entry](intent)).rejects.toMatchObject({code: 'MEGANOVEL_CONTENT_CONFLICT'});
        expect(store.getMegaNovelRun(intent.packageId, 1)).toEqual(retained);
        expect(store.getPackage(intent.packageId)).toEqual(retainedPackage);
      }
    }
    const evidence = 'Synthetic independently reopened detail after delayed visibility';
    snapshot.candidates = [{...row(), status, evidence}];
    expect(await adapter.reconcile(intent)).toEqual({...retained, evidence});
    expect(await adapter.saveDraft(intent)).toEqual({...retained, evidence});
    if (status !== 'draft') expect(await adapter.submit(intent)).toEqual({...retained, evidence});
    expect(browser.createDraft).not.toHaveBeenCalled();
    expect(browser.submit).not.toHaveBeenCalled();
  });
  it.each(['draft_unknown', 'submit_unknown'] as const)(
    'keeps a complete negative readback %s at all three entries without retrying mutations', async phase => {
    browser.createDraft = vi.fn(async () => { throw new Error('Synthetic lost draft response'); });
    browser.submit = vi.fn(async () => { snapshot.candidates = []; throw new Error('Synthetic lost submit response'); });
    if (phase === 'submit_unknown') {
      snapshot.candidates = [row()];
      await adapter.saveDraft(intent);
      await adapter.submit(intent);
    } else await adapter.saveDraft(intent);
    const retained = store.getMegaNovelRun(intent.packageId, 1)!;
    const retainedPackage = store.getPackage(intent.packageId);
    expect(retained.phase).toBe(phase);
    for (const entry of ['reconcile', 'saveDraft', 'submit'] as const) {
      for (let attempt = 0; attempt < 2; attempt++) expect(await adapter[entry](intent)).toEqual(retained);
    }
    expect(store.getMegaNovelRun(intent.packageId, 1)).toEqual(retained);
    expect(store.getPackage(intent.packageId)).toEqual(retainedPackage);
    snapshot.candidates = [{...row(), status: 'published'}];
    expect((await adapter.reconcile(intent)).phase).toBe('published');
    expect(browser.createDraft).toHaveBeenCalledTimes(phase === 'draft_unknown' ? 1 : 0);
    expect(browser.submit).toHaveBeenCalledTimes(phase === 'submit_unknown' ? 1 : 0);
  });
  it('readiness never creates a remote draft or local run', async () => {
    await adapter.ready(intent.scope);
    expect(browser.createDraft).not.toHaveBeenCalled();
    expect(browser.submit).not.toHaveBeenCalled();
    expect(store.getMegaNovelRun(intent.packageId, 1)).toBeUndefined();
  });
  it('saves/submits once; review and public release remain separate observations', async () => {
    expect((await adapter.saveDraft(intent)).phase).toBe('draft');
    expect((await adapter.saveDraft(intent)).phase).toBe('draft');
    expect((await adapter.submit(intent)).phase).toBe('reviewing');
    expect((await adapter.submit(intent)).phase).toBe('reviewing');
    expect(browser.createDraft).toHaveBeenCalledTimes(1);
    expect(browser.submit).toHaveBeenCalledTimes(1);
    snapshot.candidates[0]!.status = 'published';
    expect((await adapter.reconcile(intent)).phase).toBe('published');
    expect(store.getPackage(intent.packageId).remoteVerified).toBe(false);
    expect(store.getPackage(intent.packageId).chapters[0]!.provenance).toBeNull();
  });
  it('adopts an independently observed existing remote chapter without transferring text', async () => {
    snapshot.candidates = [{...row(), status: 'published'}];
    expect((await adapter.reconcile(intent)).remoteChapterId).toBe('chapter-1');
    expect(browser.createDraft).not.toHaveBeenCalled();
    expect(browser.submit).not.toHaveBeenCalled();
  });
  it('a first read-only reconciliation reserves historical uncertainty, never creating a draft', async () => {
    expect((await adapter.reconcile(intent)).phase).toBe('draft_unknown');
    expect((await adapter.saveDraft(intent)).phase).toBe('draft_unknown');
    expect(browser.createDraft).not.toHaveBeenCalled();
  });
  it('takes over a manual unknown for readback only and does not retry a still-visible draft', async () => {
    await packages.beginSubmission({packageId: intent.packageId, chapterNumber: 1, expectedVersion: 0, eventId: 'manual-first'});
    snapshot.candidates = [row()];
    expect((await adapter.reconcile(intent)).phase).toBe('submit_unknown');
    expect((await adapter.submit(intent)).phase).toBe('submit_unknown');
    snapshot.candidates = [{...row(), status: 'submitted'}];
    expect((await adapter.reconcile(intent)).phase).toBe('submitted');
    expect(browser.createDraft).not.toHaveBeenCalled();
    expect(browser.submit).not.toHaveBeenCalled();
  });
  it('does not let saveDraft adopt a manual unknown as a fresh draft', async () => {
    await packages.beginSubmission({packageId: intent.packageId, chapterNumber: 1, expectedVersion: 0, eventId: 'manual-first'});
    snapshot.candidates = [row()];
    await expect(adapter.saveDraft(intent)).rejects.toMatchObject({code: 'PUBLISHING_RECONCILIATION_REQUIRED'});
    expect(browser.createDraft).not.toHaveBeenCalled();
  });
  it('keeps draft uncertainty across process restart and delayed visibility', async () => {
    browser.createDraft = vi.fn(async () => { throw new Error('timeout'); });
    expect((await adapter.saveDraft(intent)).phase).toBe('draft_unknown');
    store.close(); store = new PublishingStore(join(root, '.inkos', 'harness.sqlite'));
    packages = new ManualPublishingAdapter(root, store);
    adapter = new MegaNovelPublishingAdapter(packages, store, browser);
    expect((await adapter.saveDraft(intent)).phase).toBe('draft_unknown');
    expect(browser.createDraft).toHaveBeenCalledTimes(1);
    snapshot.candidates = [row()];
    expect((await adapter.reconcile(intent)).phase).toBe('draft');
  });
  it('recovers from a lost write response by readback, without replay', async () => {
    browser.createDraft = vi.fn(async () => { snapshot.candidates = [row()]; throw new Error('lost response'); });
    expect((await adapter.saveDraft(intent)).phase).toBe('draft');
    expect(browser.createDraft).toHaveBeenCalledTimes(1);
  });
  it('does not mistake a visible draft after a publish timeout for permission to resend', async () => {
    await adapter.saveDraft(intent);
    browser.submit = vi.fn(async () => { throw new Error('timeout'); });
    expect((await adapter.submit(intent)).phase).toBe('submit_unknown');
    expect((await adapter.submit(intent)).phase).toBe('submit_unknown');
    expect(browser.submit).toHaveBeenCalledTimes(1);
    snapshot.candidates = [{...row(), status: 'published'}];
    expect((await adapter.reconcile(intent)).phase).toBe('published');
  });
  it.each(['draft', 'submit'] as const)('retains %s uncertainty through session expiry, restart and repeated recovery', async effect => {
    if (effect === 'submit') await adapter.saveDraft(intent);
    const operation = vi.fn(async () => {
      snapshot.blocker = 'login';
      throw new Error('Synthetic session expired after the effect started');
    });
    if (effect === 'draft') browser.createDraft = operation;
    else browser.submit = operation;
    const invoke = () => effect === 'draft' ? adapter.saveDraft(intent) : adapter.submit(intent);
    await expect(invoke()).rejects.toMatchObject({code: 'MEGANOVEL_BROWSER_BLOCKED'});
    expect(store.getMegaNovelRun(intent.packageId, 1)?.phase).toBe(`${effect}_unknown`);
    store.close(); store = new PublishingStore(join(root, '.inkos', 'harness.sqlite'));
    packages = new ManualPublishingAdapter(root, store);
    adapter = new MegaNovelPublishingAdapter(packages, store, browser);
    await expect(invoke()).rejects.toMatchObject({code: 'MEGANOVEL_BROWSER_BLOCKED'});
    snapshot.blocker = 'none';
    snapshot.scope = {...intent.scope, accountId: 'wrong-after-relogin'};
    await expect(invoke()).rejects.toMatchObject({code: 'MEGANOVEL_SCOPE_CHANGED'});
    snapshot.scope = intent.scope;
    expect((await invoke()).phase).toBe(`${effect}_unknown`);
    expect((await invoke()).phase).toBe(`${effect}_unknown`);
    expect(operation).toHaveBeenCalledTimes(1);
  });
  it.each(['login', 'captcha', 'agreement', 'risk_control', 'quota', 'unrecognized_ui'] as const)('stops at %s', async blocker => {
    snapshot.blocker = blocker;
    await expect(adapter.ready(intent.scope)).rejects.toMatchObject({code: 'MEGANOVEL_BROWSER_BLOCKED'});
    await expect(adapter.saveDraft(intent)).rejects.toMatchObject({code: 'MEGANOVEL_BROWSER_BLOCKED'});
    expect(browser.createDraft).not.toHaveBeenCalled();
  });
  it('refuses missing/false AI disclosure and permits an observed absence of a declaration field', async () => {
    await expect(adapter.saveDraft({...intent, aiAssisted: undefined} as unknown as MegaNovelIntent)).rejects.toThrow();
    await adapter.saveDraft(intent);
    snapshot.candidates[0]!.aiDisclosure = 'unverified';
    await expect(adapter.submit(intent)).rejects.toMatchObject({code: 'MEGANOVEL_DISCLOSURE_UNVERIFIED'});
    snapshot.candidates[0]!.aiDisclosure = 'declared_human';
    await expect(adapter.submit(intent)).rejects.toMatchObject({code: 'MEGANOVEL_DISCLOSURE_UNVERIFIED'});
    snapshot.candidates[0]!.aiDisclosure = 'not_present';
    expect((await adapter.submit(intent)).phase).toBe('reviewing');
    expect(browser.submit).toHaveBeenCalledTimes(1);
  });
  it('rejects duplicate, wrong-content, wrong-scope, incomplete and wrong-chapter observations', async () => {
    snapshot.complete = false;
    await expect(adapter.saveDraft(intent)).rejects.toMatchObject({code: 'MEGANOVEL_INCOMPLETE_LOOKUP'});
    snapshot.complete = true; snapshot.candidates = [row(), {...row(), remoteChapterId: 'other'}];
    await expect(adapter.saveDraft(intent)).rejects.toMatchObject({code: 'MEGANOVEL_DUPLICATE_CHAPTER'});
    snapshot.candidates = [{...row(), content: 'different'}];
    await expect(adapter.saveDraft(intent)).rejects.toMatchObject({code: 'MEGANOVEL_CONTENT_CONFLICT'});
    snapshot.candidates = []; snapshot.scope = {...intent.scope, accountId: 'wrong'};
    await expect(adapter.saveDraft(intent)).rejects.toMatchObject({code: 'MEGANOVEL_SCOPE_CHANGED'});
    snapshot.scope = intent.scope; snapshot.chapterNumber = 2;
    await expect(adapter.saveDraft(intent)).rejects.toMatchObject({code: 'MEGANOVEL_SCOPE_CHANGED'});
    expect(browser.createDraft).not.toHaveBeenCalled();
  });
  it('rejects package tampering before any browser access', async () => {
    const {directory, package: pkg} = await packages.verify(intent.packageId);
    await writeFile(join(directory, pkg.manifest.chapters[0]!.packagePath), 'tampered');
    await expect(adapter.saveDraft(intent)).rejects.toMatchObject({code: 'PUBLISHING_PACKAGE_INTEGRITY'});
    expect(browser.snapshot).not.toHaveBeenCalled();
  });
  it('only one competing caller can reserve a mutation', async () => {
    const outcomes = await Promise.allSettled([adapter.saveDraft(intent), adapter.saveDraft(intent)]);
    expect(outcomes.some(o => o.status === 'fulfilled')).toBe(true);
    expect(browser.createDraft).toHaveBeenCalledTimes(1);
  });
  it('a new revision, account label or renumbering cannot bypass the first reservation', async () => {
    await adapter.saveDraft(intent);
    const work = await syncWorkSourceArtifacts({projectRoot: root, workId: 'book', accept: true,
      writes: [{relativePath: 'works/book/source/chapters/1.md', content: 'new revision'}]});
    const target = await packages.mapBook({workId: 'book', platform: 'meganovel', accountLabel: 'alias', remoteBookId: 'book-123'});
    const artifact = work.artifacts[0]!;
    const next = await packages.prepare({targetId: target.id, formats: ['txt'],
      chapters: [{artifactId: artifact.id, revisionId: artifact.currentRevisionId!, number: 2, title: 'Another title'}]});
    snapshot.candidates = []; snapshot.chapterNumber = 2; snapshot.scope = {...intent.scope, accountLabel: 'alias'};
    await expect(adapter.saveDraft({...intent, packageId: next.manifest.id, chapterNumber: 2, scope: snapshot.scope}))
      .rejects.toMatchObject({code: 'PUBLISHING_RECONCILIATION_REQUIRED'});
    expect(browser.createDraft).toHaveBeenCalledTimes(1);
  });
  it('cannot bypass an unidentified historical manual reservation by changing the local label', async () => {
    await packages.beginSubmission({packageId: intent.packageId, chapterNumber: 1, expectedVersion: 0, eventId: 'legacy-manual'});
    const target = await packages.mapBook({workId: 'book', platform: 'meganovel', accountLabel: 'new-label', remoteBookId: 'book-123'});
    const artifact = (await loadWorkManifest(root, 'book')).artifacts[0]!;
    const next = await packages.prepare({targetId: target.id, formats: ['txt'], chapters: [{artifactId: artifact.id,
      revisionId: artifact.currentRevisionId!, number: 1, title: 'The First Chapter'}]});
    snapshot.scope = {...intent.scope, accountLabel: 'new-label'};
    await expect(adapter.saveDraft({...intent, packageId: next.manifest.id, scope: snapshot.scope}))
      .rejects.toMatchObject({code: 'PUBLISHING_RECONCILIATION_REQUIRED'});
    expect(browser.createDraft).not.toHaveBeenCalled();
    expect(browser.submit).not.toHaveBeenCalled();
  });
  it('manual receipts cannot release a browser reservation', async () => {
    await adapter.saveDraft(intent);
    expect(() => store.recordReceipt({packageId: intent.packageId, chapterNumber: 1,
      expectedVersion: store.getPackage(intent.packageId).version, eventId: 'clear',
      receipt: {status: 'not_submitted_reported', evidence: 'No row noticed'}})).toThrow('Manual receipts cannot clear');
  });
  it('reconciles a new tab after restart without changing stable submission identity or retrying', async () => {
    browser.createDraft = vi.fn(async () => { throw new Error('timeout'); });
    await adapter.saveDraft(intent);
    const rebound = {...intent, scope: {...intent.scope, sessionId: 'target-reopened'}};
    snapshot.scope = rebound.scope;
    await expect(adapter.saveDraft(rebound)).rejects.toMatchObject({code: 'MEGANOVEL_RUN_CONFLICT'});
    expect((await adapter.reconcile(rebound)).phase).toBe('draft_unknown');
    snapshot.candidates = [{...row(), status: 'reviewing'}];
    expect((await adapter.reconcile(rebound)).scope.sessionId).toBe('target-reopened');
    expect(store.getMegaNovelRun(intent.packageId, 1)?.scope.accountId).toBe(intent.scope.accountId);
    expect(browser.createDraft).toHaveBeenCalledTimes(1);
    expect(browser.submit).not.toHaveBeenCalled();
  });
  it('cannot map the same remote ID onto another local chapter', async () => {
    await adapter.saveDraft(intent);
    const work = await syncWorkSourceArtifacts({projectRoot: root, workId: 'book', accept: true,
      writes: [{relativePath: 'works/book/source/chapters/2.md', content}]});
    const firstArtifactId = store.getPackage(intent.packageId).manifest.chapters[0]!.artifactId;
    const artifact = work.artifacts.find(a => a.id !== firstArtifactId)!;
    const next = await packages.prepare({targetId: store.getPackage(intent.packageId).manifest.target.id, formats: ['txt'],
      chapters: [{artifactId: artifact.id, revisionId: artifact.currentRevisionId!, number: 2, title: 'Second'}]});
    snapshot.chapterNumber = 2;
    snapshot.candidates = [{...row(), number: 2, title: 'Second'}];
    await expect(adapter.reconcile({...intent, packageId: next.manifest.id, chapterNumber: 2}))
      .rejects.toMatchObject({code: 'PUBLISHING_CHAPTER_MAPPING_CONFLICT'});
    expect(browser.createDraft).toHaveBeenCalledTimes(1);
  });
  it('keeps a historical manual receipt separate from the independent browser observation', async () => {
    await packages.beginSubmission({packageId: intent.packageId, chapterNumber: 1, expectedVersion: 0, eventId: 'manual-first'});
    store.recordReceipt({packageId: intent.packageId, chapterNumber: 1, expectedVersion: 1, eventId: 'manual-receipt',
      receipt: {status: 'published_reported', remoteChapterId: 'chapter-1', evidence: 'User-reported historical publication'}});
    snapshot.candidates = [{...row(), status: 'published'}];
    expect((await adapter.reconcile(intent)).phase).toBe('published');
    const original = store.getPackage(intent.packageId);
    expect(original.chapters[0]!.status).toBe('published_reported');
    expect(original.chapters[0]!.provenance).toBe('user_reported');
    expect(original.chapters[0]!.evidence).toBe('User-reported historical publication');
    expect(original.remoteVerified).toBe(false);
  });
  it('reserves a formerly absent manual receipt against browser alias replay after read-only adoption', async () => {
    await packages.beginSubmission({packageId: intent.packageId, chapterNumber: 1, expectedVersion: 0, eventId: 'manual-first'});
    store.recordReceipt({packageId: intent.packageId, chapterNumber: 1, expectedVersion: 1, eventId: 'manual-absent',
      receipt: {status: 'not_submitted_reported', evidence: 'User previously reported no submission'}});
    expect((await adapter.reconcile(intent)).phase).toBe('draft_unknown');
    expect(store.getPackage(intent.packageId).chapters[0]!.status).toBe('awaiting_receipt');
    const selected = store.getPackage(intent.packageId).manifest.chapters[0]!;
    const target = await packages.mapBook({workId: 'book', platform: 'meganovel', accountLabel: 'alias', remoteBookId: 'book-123'});
    const next = await packages.prepare({targetId: target.id, formats: ['txt'],
      chapters: [{artifactId: selected.artifactId, revisionId: selected.revisionId, number: 2, title: 'Alias'}]});
    snapshot.chapterNumber = 2; snapshot.scope = {...intent.scope, accountLabel: 'alias'};
    await expect(adapter.saveDraft({...intent, packageId: next.manifest.id, chapterNumber: 2, scope: snapshot.scope}))
      .rejects.toMatchObject({code: 'PUBLISHING_RECONCILIATION_REQUIRED'});
  });
  it('does not assume book or chapter IDs are globally unique across actual accounts', async () => {
    await adapter.saveDraft(intent);
    const selected = store.getPackage(intent.packageId).manifest.chapters[0]!;
    const target = await packages.mapBook({workId: 'book', platform: 'meganovel', accountLabel: 'other-account', remoteBookId: 'book-123'});
    const next = await packages.prepare({targetId: target.id, formats: ['txt'],
      chapters: [{artifactId: selected.artifactId, revisionId: selected.revisionId, number: 1, title: selected.title}]});
    snapshot.scope = {...intent.scope, accountLabel: 'other-account', accountId: 'different-actual-account'};
    snapshot.candidates = [row()];
    const observed = await adapter.saveDraft({...intent, packageId: next.manifest.id, scope: snapshot.scope});
    expect(observed.phase).toBe('draft');
    expect(observed.scope.accountId).toBe('different-actual-account');
    expect(browser.createDraft).toHaveBeenCalledTimes(1);
  });
  it('uses the separate-title body transform for writes and readback without modifying the frozen document', async () => {
    const document = '# Chapter 1: The First Chapter\n\n' + content;
    const work = await syncWorkSourceArtifacts({projectRoot: root, workId: 'book', accept: true,
      writes: [{relativePath: 'works/book/source/chapters/1.md', content: document}]});
    const selected = work.artifacts[0]!;
    const pkg = await packages.prepare({targetId: store.getPackage(intent.packageId).manifest.target.id, formats: ['txt'],
      chapters: [{artifactId: selected.id, revisionId: selected.currentRevisionId!, number: 1, title: 'The First Chapter'}]});
    intent = {...intent, packageId: pkg.manifest.id};
    expect((await adapter.saveDraft(intent)).phase).toBe('draft');
    expect(vi.mocked(browser.createDraft).mock.calls[0]![0]).toMatchObject({title: 'The First Chapter', content, revisionId: selected.currentRevisionId});
    expect((await adapter.submit(intent)).phase).toBe('reviewing');
    expect(vi.mocked(browser.submit).mock.calls[0]![0].content).toBe(content);
    const verified = await packages.verify(pkg.manifest.id);
    expect(verified.package.manifest.chapters[0]!.revisionId).toBe(selected.currentRevisionId);
    expect(Buffer.from(verified.package.manifest.files.find(file => file.path === verified.package.manifest.chapters[0]!.packagePath)!.contentBase64!, 'base64').toString('utf8')).toBe(document);
  });
  it('does not begin editor input when stop arrives during the preceding readback', async () => {
    const controller = new AbortController();
    browser.snapshot = vi.fn(async () => { controller.abort(); return structuredClone(snapshot); });
    await expect(adapter.saveDraft(intent, {signal: controller.signal})).rejects.toMatchObject({name: 'AbortError'});
    expect(browser.createDraft).not.toHaveBeenCalled();
    expect(store.getMegaNovelRun(intent.packageId, 1)).toBeUndefined();
  });
  it('does not click submit when stop arrives during draft verification', async () => {
    await adapter.saveDraft(intent);
    const controller = new AbortController();
    browser.snapshot = vi.fn(async () => { controller.abort(); return structuredClone(snapshot); });
    await expect(adapter.submit(intent, {signal: controller.signal})).rejects.toMatchObject({name: 'AbortError'});
    expect(browser.submit).not.toHaveBeenCalled();
    expect(store.getMegaNovelRun(intent.packageId, 1)?.phase).toBe('draft');
  });
  it('drains a started draft and independent readback when stop arrives during the effect', async () => {
    const controller = new AbortController();
    browser.createDraft = vi.fn(async () => { controller.abort(); snapshot.candidates = [row()]; });
    expect((await adapter.saveDraft(intent, {signal: controller.signal})).phase).toBe('draft');
    expect(browser.createDraft).toHaveBeenCalledTimes(1);
    expect(browser.snapshot).toHaveBeenCalledTimes(2);
    expect(browser.submit).not.toHaveBeenCalled();
  });
});
