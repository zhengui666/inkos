import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInitialWorkManifestWrite, syncWorkSourceArtifacts } from '../harness/source-sync.js';
import { loadWorkManifest } from '../harness/work-store.js';
import { commitAtomicFileSet } from '../utils/atomic-file-set.js';
import { ManualPublishingAdapter, PublishingStore, FanqiePublishingAdapter,
  type FanqieBrowserPort, type FanqieIntent, type FanqieSnapshot } from '../publishing/index.js';

let root: string;
let store: PublishingStore;
let packages: ManualPublishingAdapter;
let adapter: FanqiePublishingAdapter;
let intent: FanqieIntent;
let snapshot: FanqieSnapshot;
let browser: FanqieBrowserPort;
const content = '这是用户指定的已审单章正文。\n';
const scheduledFor = '2030-01-02T10:00:00+08:00';
const row = (): FanqieSnapshot['chapters'][number] => ({remoteChapterId: 'chapter-1', number: 1,
  title: '初见', content, aiAssisted: true, status: 'draft', scheduledFor: null,
  evidence: 'Fixture-only independent chapter details readback'});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'inkos-fanqie-'));
  const writes = [{relativePath: 'works/book/source/chapters/1.md', content}];
  const initial = createInitialWorkManifestWrite({workId: 'book', title: '测试书', profileId: 'long-form', language: 'zh', writes});
  await commitAtomicFileSet({rootDir: root, writes: [...writes, initial.write]});
  store = new PublishingStore(join(root, '.inkos', 'harness.sqlite'));
  packages = new ManualPublishingAdapter(root, store);
  const target = await packages.mapBook({workId: 'book', platform: 'fanqie', accountLabel: 'author', remoteBookId: 'book-123'});
  const artifact = (await loadWorkManifest(root, 'book')).artifacts[0]!;
  const pkg = await packages.prepare({targetId: target.id,
    chapters: [{artifactId: artifact.id, revisionId: artifact.currentRevisionId!, number: 1, title: '初见'}], formats: ['txt']});
  intent = {packageId: pkg.manifest.id, chapterNumber: 1, aiAssisted: true,
    scope: {sessionId: 'explicit-tab-1', accountId: 'account-123', accountLabel: 'author', remoteBookId: 'book-123'}};
  snapshot = {scope: intent.scope, origin: 'https://fanqienovel.com', blocker: 'none',
    schedulingAvailable: true, complete: true, chapters: []};
  browser = {
    snapshot: vi.fn(async () => structuredClone(snapshot)),
    createDraft: vi.fn(async input => {
      expect(store.getFanqieRun(intent.packageId, 1)?.phase).toBe('draft_unknown');
      expect(input.content).toBe(content);
      snapshot.chapters = [row()];
    }),
    schedule: vi.fn(async input => {
      expect(store.getFanqieRun(intent.packageId, 1)?.phase).toBe('schedule_unknown');
      snapshot.chapters[0] = {...row(), status: 'reviewing', scheduledFor: input.scheduledFor};
    }),
  };
  adapter = new FanqiePublishingAdapter(packages, store, browser);
});
afterEach(async () => { store.close(); await rm(root, {recursive: true, force: true}); });

describe('Fanqie single-chapter browser protocol (synthetic port, not live acceptance)', () => {
  it('freezes, saves once, schedules once, and reads actual publication separately', async () => {
    expect((await adapter.saveDraft(intent)).phase).toBe('draft');
    expect((await adapter.saveDraft(intent)).phase).toBe('draft');
    expect(browser.createDraft).toHaveBeenCalledTimes(1);
    expect((await adapter.schedule({...intent, scheduledFor})).phase).toBe('reviewing');
    expect((await adapter.schedule({...intent, scheduledFor})).phase).toBe('reviewing');
    expect(browser.schedule).toHaveBeenCalledTimes(1);
    snapshot.chapters[0]!.status = 'scheduled';
    expect((await adapter.reconcile(intent)).phase).toBe('scheduled');
    snapshot.chapters[0]!.status = 'published';
    snapshot.chapters[0]!.scheduledFor = null; // Terminal UI may omit the historically verified time.
    expect((await adapter.reconcile(intent)).phase).toBe('published');
    expect(store.getPackage(intent.packageId).remoteVerified).toBe(false);
    expect(store.getPackage(intent.packageId).chapters[0]!.provenance).toBeNull();
  });

  it('deduplicates an exact existing remote chapter without typing', async () => {
    snapshot.chapters = [row()];
    expect((await adapter.saveDraft(intent)).remoteChapterId).toBe('chapter-1');
    expect(browser.createDraft).not.toHaveBeenCalled();
  });

  it('never trusts a title-only match or duplicates', async () => {
    snapshot.chapters = [{...row(), content: 'A different manuscript'}];
    await expect(adapter.saveDraft(intent)).rejects.toMatchObject({code: 'FANQIE_CONTENT_CONFLICT'});
    snapshot.chapters = [row(), {...row(), remoteChapterId: 'other'}];
    await expect(adapter.saveDraft(intent)).rejects.toMatchObject({code: 'FANQIE_DUPLICATE_CHAPTER'});
    expect(browser.createDraft).not.toHaveBeenCalled();
  });

  it('blocks all writes on incomplete inventory or wrong session/account/book/origin', async () => {
    snapshot.complete = false;
    await expect(adapter.saveDraft(intent)).rejects.toMatchObject({code: 'FANQIE_INCOMPLETE_INVENTORY'});
    snapshot.complete = true;
    snapshot.scope = {...intent.scope, accountId: 'someone-else'};
    await expect(adapter.saveDraft(intent)).rejects.toMatchObject({code: 'FANQIE_SCOPE_CHANGED'});
    snapshot.scope = intent.scope;
    snapshot.origin = 'https://evil.example' as FanqieSnapshot['origin'];
    await expect(adapter.saveDraft(intent)).rejects.toThrow();
    expect(browser.createDraft).not.toHaveBeenCalled();
  });

  it.each(['login', 'captcha', 'agreement', 'risk_control', 'quota', 'unrecognized_ui'] as const)('stops at %s without interaction', async blocker => {
    snapshot.blocker = blocker;
    await expect(adapter.saveDraft(intent)).rejects.toMatchObject({code: 'FANQIE_BROWSER_BLOCKED'});
    expect(browser.createDraft).not.toHaveBeenCalled();
  });

  it('persists draft uncertainty over process restart and refuses blind retry even after a negative read', async () => {
    browser.createDraft = vi.fn(async () => { throw new Error('timeout before response'); });
    expect((await adapter.saveDraft(intent)).phase).toBe('draft_unknown');
    store.close(); store = new PublishingStore(join(root, '.inkos', 'harness.sqlite'));
    packages = new ManualPublishingAdapter(root, store);
    adapter = new FanqiePublishingAdapter(packages, store, browser);
    expect((await adapter.saveDraft(intent)).phase).toBe('draft_unknown');
    expect(browser.createDraft).toHaveBeenCalledTimes(1);
    snapshot.chapters = [row()];
    expect((await adapter.reconcile(intent)).phase).toBe('draft');
  });

  it('recovers a saved draft despite an action error using independent readback', async () => {
    browser.createDraft = vi.fn(async () => { snapshot.chapters = [row()]; throw new Error('lost save response'); });
    expect((await adapter.saveDraft(intent)).phase).toBe('draft');
    expect(browser.createDraft).toHaveBeenCalledTimes(1);
  });

  it('does not mistake a draft readback for failed scheduling or resubmit it', async () => {
    await adapter.saveDraft(intent);
    browser.schedule = vi.fn(async () => { throw new Error('ambiguous scheduling response'); });
    expect((await adapter.schedule({...intent, scheduledFor})).phase).toBe('schedule_unknown');
    expect((await adapter.schedule({...intent, scheduledFor})).phase).toBe('schedule_unknown');
    expect(browser.schedule).toHaveBeenCalledTimes(1);
    snapshot.chapters[0] = {...row(), status: 'scheduled', scheduledFor};
    expect((await adapter.reconcile(intent)).phase).toBe('scheduled');
  });

  it('requires an available scheduling UI and truthful declaration without a default No', async () => {
    await expect(adapter.saveDraft({...intent, aiAssisted: undefined} as unknown as FanqieIntent)).rejects.toThrow();
    await adapter.saveDraft(intent);
    snapshot.schedulingAvailable = false;
    await expect(adapter.schedule({...intent, scheduledFor})).rejects.toMatchObject({code: 'FANQIE_SCHEDULE_UNAVAILABLE'});
    snapshot.schedulingAvailable = true;
    snapshot.chapters[0]!.aiAssisted = null;
    await expect(adapter.schedule({...intent, scheduledFor})).rejects.toMatchObject({code: 'FANQIE_DECLARATION_UNVERIFIED'});
    snapshot.chapters[0]!.aiAssisted = false;
    await expect(adapter.schedule({...intent, scheduledFor})).rejects.toMatchObject({code: 'FANQIE_DECLARATION_UNVERIFIED'});
    expect(browser.schedule).not.toHaveBeenCalled();
  });

  it('will not mark a mismatched scheduled time or declaration as verified', async () => {
    await adapter.saveDraft(intent);
    browser.schedule = vi.fn(async () => {
      snapshot.chapters[0] = {...row(), status: 'scheduled', scheduledFor: '2030-01-03T10:00:00+08:00'};
    });
    await expect(adapter.schedule({...intent, scheduledFor})).rejects.toMatchObject({code: 'FANQIE_SCHEDULE_CONFLICT'});
    expect(store.getFanqieRun(intent.packageId, 1)?.phase).toBe('schedule_unknown');
    snapshot.chapters[0]!.scheduledFor = scheduledFor;
    snapshot.chapters[0]!.aiAssisted = false;
    await expect(adapter.reconcile(intent)).rejects.toMatchObject({code: 'FANQIE_DECLARATION_UNVERIFIED'});
  });

  it.each(['2030-01-02T10:00:00+99:99', '2030-01-02T10:00:00+24:00', '2030-01-02T10:00:00'])('rejects invalid or unzoned scheduled instant %s', async invalid => {
    await adapter.saveDraft(intent);
    await expect(adapter.schedule({...intent, scheduledFor: invalid})).rejects.toThrow();
    expect(browser.schedule).not.toHaveBeenCalled();
    expect(store.getFanqieRun(intent.packageId, 1)?.phase).toBe('draft');
  });

  it('does not accept session changes, past times, or requested schedule changes', async () => {
    await adapter.saveDraft(intent);
    await expect(adapter.reconcile({...intent, scope: {...intent.scope, sessionId: 'new-tab'}}))
      .rejects.toMatchObject({code: 'FANQIE_RUN_CONFLICT'});
    await expect(adapter.schedule({...intent, scheduledFor: '2000-01-01T00:00:00Z'}))
      .rejects.toMatchObject({code: 'FANQIE_INVALID_SCHEDULE'});
    await adapter.schedule({...intent, scheduledFor});
    await expect(adapter.schedule({...intent, scheduledFor: '2030-01-03T00:00:00Z'}))
      .rejects.toMatchObject({code: 'FANQIE_RUN_CONFLICT'});
  });

  it('preserves uncertainty when readback fails and rejects package tampering before browser access', async () => {
    browser.createDraft = vi.fn(async () => { snapshot.blocker = 'login'; });
    await expect(adapter.saveDraft(intent)).rejects.toMatchObject({code: 'FANQIE_BROWSER_BLOCKED'});
    expect(store.getFanqieRun(intent.packageId, 1)?.phase).toBe('draft_unknown');
    const {directory, package: pkg} = await packages.verify(intent.packageId);
    await writeFile(join(directory, pkg.manifest.chapters[0]!.packagePath), 'tampered');
    vi.mocked(browser.snapshot).mockClear();
    await expect(adapter.reconcile(intent)).rejects.toMatchObject({code: 'PUBLISHING_PACKAGE_INTEGRITY'});
    expect(browser.snapshot).not.toHaveBeenCalled();
  });

  it('serializes competing drafts by CAS before any content transfer', async () => {
    const outcomes = await Promise.allSettled([adapter.saveDraft(intent), adapter.saveDraft(intent)]);
    expect(outcomes.some(o => o.status === 'fulfilled')).toBe(true);
    expect(browser.createDraft).toHaveBeenCalledTimes(1);
  });

  it('does not allow manual absence receipts to clear a browser reservation', async () => {
    browser.createDraft = vi.fn(async () => { throw new Error('ambiguous'); });
    await adapter.saveDraft(intent);
    expect(() => store.recordReceipt({packageId: intent.packageId, chapterNumber: 1,
      expectedVersion: store.getPackage(intent.packageId).version, eventId: 'manual-clear',
      receipt: {status: 'not_submitted_reported', evidence: 'Author sees no row yet'}}))
      .toThrow('Manual receipts cannot clear');
    expect(store.getFanqieRun(intent.packageId, 1)?.phase).toBe('draft_unknown');
  });

  it('isolates a second actual account even when remote book and chapter IDs coincide', async () => {
    await adapter.saveDraft(intent);
    const selected = store.getPackage(intent.packageId).manifest.chapters[0]!;
    const target = await packages.mapBook({workId: 'book', platform: 'fanqie', accountLabel: 'other-account', remoteBookId: 'book-123'});
    const next = await packages.prepare({targetId: target.id, formats: ['txt'],
      chapters: [{artifactId: selected.artifactId, revisionId: selected.revisionId, number: 1, title: selected.title}]});
    snapshot.scope = {...intent.scope, accountLabel: 'other-account', accountId: 'different-actual-account'};
    snapshot.chapters = [row()];
    const observed = await adapter.saveDraft({...intent, packageId: next.manifest.id, scope: snapshot.scope});
    expect(observed.phase).toBe('draft');
    expect(observed.scope.accountId).toBe('different-actual-account');
    expect(store.getFanqieRun(intent.packageId, 1)?.scope.accountId).toBe('account-123');
    expect(browser.createDraft).toHaveBeenCalledTimes(1);
  });

  it('blocks renumbering the same artifact through a different local account label', async () => {
    await adapter.saveDraft(intent);
    const target = await packages.mapBook({workId: 'book', platform: 'fanqie', accountLabel: 'alias', remoteBookId: 'book-123'});
    const selected = store.getPackage(intent.packageId).manifest.chapters[0]!;
    const next = await packages.prepare({targetId: target.id, formats: ['txt'],
      chapters: [{artifactId: selected.artifactId, revisionId: selected.revisionId, number: 2, title: '初见'}]});
    await expect(adapter.saveDraft({...intent, packageId: next.manifest.id, chapterNumber: 2,
      scope: {...intent.scope, accountLabel: 'alias'}})).rejects.toMatchObject({code: 'FANQIE_SCOPE_CHANGED'});
    await expect(packages.beginSubmission({packageId: next.manifest.id, chapterNumber: 2,
      expectedVersion: next.version, eventId: 'alias-manual-replay'}))
      .rejects.toMatchObject({code: 'PUBLISHING_RECONCILIATION_REQUIRED'});
    snapshot.scope = {...intent.scope, accountLabel: 'alias'};
    await expect(adapter.saveDraft({...intent, packageId: next.manifest.id, chapterNumber: 2,
      scope: snapshot.scope})).rejects.toMatchObject({code: 'PUBLISHING_RECONCILIATION_REQUIRED'});
    expect(browser.createDraft).toHaveBeenCalledTimes(1);
  });

  it('blocks browser submission against an unresolved manual attempt under another label', async () => {
    await packages.beginSubmission({packageId: intent.packageId, chapterNumber: 1, expectedVersion: 0, eventId: 'manual-first'});
    const target = await packages.mapBook({workId: 'book', platform: 'fanqie', accountLabel: 'alias', remoteBookId: 'book-123'});
    const selected = store.getPackage(intent.packageId).manifest.chapters[0]!;
    const next = await packages.prepare({targetId: target.id, formats: ['txt'],
      chapters: [{artifactId: selected.artifactId, revisionId: selected.revisionId, number: 2, title: '初见'}]});
    snapshot.scope = {...intent.scope, accountLabel: 'alias'};
    await expect(adapter.saveDraft({...intent, packageId: next.manifest.id, chapterNumber: 2,
      scope: snapshot.scope})).rejects.toMatchObject({code: 'PUBLISHING_RECONCILIATION_REQUIRED'});
    expect(browser.createDraft).not.toHaveBeenCalled();
  });

  it('reserves a chapter against a new frozen revision and manual replay', async () => {
    await adapter.saveDraft(intent);
    await expect(packages.beginSubmission({packageId: intent.packageId, chapterNumber: 1,
      expectedVersion: store.getPackage(intent.packageId).version, eventId: 'manual-replay'}))
      .rejects.toMatchObject({code: 'PUBLISHING_RECONCILIATION_REQUIRED'});
    const work = await syncWorkSourceArtifacts({projectRoot: root, workId: 'book', accept: true,
      writes: [{relativePath: 'works/book/source/chapters/1.md', content: 'new revision'}]});
    const artifact = work.artifacts[0]!;
    const next = await packages.prepare({targetId: store.getPackage(intent.packageId).manifest.target.id,
      chapters: [{artifactId: artifact.id, revisionId: artifact.currentRevisionId!, number: 1, title: '初见'}], formats: ['txt']});
    snapshot.chapters = [];
    await expect(adapter.saveDraft({...intent, packageId: next.manifest.id}))
      .rejects.toMatchObject({code: 'PUBLISHING_RECONCILIATION_REQUIRED'});
    expect(browser.createDraft).toHaveBeenCalledTimes(1);
  });
});
