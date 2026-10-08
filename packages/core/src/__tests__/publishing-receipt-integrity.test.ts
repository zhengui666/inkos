import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createInitialWorkManifestWrite} from '../harness/source-sync.js';
import {loadWorkManifest} from '../harness/work-store.js';
import {commitAtomicFileSet} from '../utils/atomic-file-set.js';
import {FanqiePublishingAdapter, FanqieRunSchema, ManualPublishingAdapter, PublishingStore,
  type FanqieBrowserPort, type FanqieIntent, type FanqieSnapshot} from '../publishing/index.js';

let root: string, store: PublishingStore, packages: ManualPublishingAdapter;
const body = 'Independent receipt fixture body.\n';
const scope = {sessionId: 'fixture-tab', accountId: 'actual-account', accountLabel: 'author', remoteBookId: 'remote-book'};
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'inkos-receipt-integrity-'));
  const writes = [1, 2].map(number => ({relativePath: `works/book/source/chapters/${number}.md`, content: body}));
  const initial = createInitialWorkManifestWrite({workId: 'book', title: 'Fixture', profileId: 'long-form', language: 'en', writes});
  await commitAtomicFileSet({rootDir: root, writes: [...writes, initial.write]});
  store = new PublishingStore(join(root, '.inkos/harness.sqlite'));
  packages = new ManualPublishingAdapter(root, store);
});
afterEach(async () => {store.close(); await rm(root, {recursive: true, force: true});});

async function fixture(number: number, accountLabel = 'author', accountId = 'actual-account', platform: 'fanqie' | 'meganovel' = 'fanqie') {
  const target = await packages.mapBook({workId: 'book', platform, accountLabel, remoteBookId: scope.remoteBookId});
  const artifact = (await loadWorkManifest(root, 'book')).artifacts.find(item =>
    item.revisions.some(revision => revision.path === `source/chapters/${number}.md`))!;
  const pkg = await packages.prepare({targetId: target.id, formats: ['txt'], chapters: [{artifactId: artifact.id,
    revisionId: artifact.currentRevisionId!, number, title: `Chapter ${number}`}]});
  const intent: FanqieIntent = {packageId: pkg.manifest.id, chapterNumber: number, aiAssisted: true,
    scope: {...scope, accountLabel, accountId}};
  const snapshot: FanqieSnapshot = {scope: intent.scope, origin: 'https://fanqienovel.com', blocker: 'none',
    schedulingAvailable: true, complete: true, chapters: [{remoteChapterId: 'one-remote-chapter', number,
      title: `Chapter ${number}`, content: body, status: 'published', aiAssisted: true, scheduledFor: null,
      evidence: 'Synthetic independently reopened detail; not platform publication.'}]};
  const browser: FanqieBrowserPort = {snapshot: vi.fn(async () => structuredClone(snapshot)),
    createDraft: vi.fn(async () => {throw new Error('Synthetic lost response');}), schedule: vi.fn()};
  const adapter = new FanqiePublishingAdapter(packages, store, browser);
  return {pkg, intent, snapshot, browser, adapter};
}

describe('Fanqie remote receipt integrity using real frozen packages and SQLite', () => {
  it.each(['author', 'same-account-alias'])('rejects a remote ID reused by another chapter after restart (%s)', async label => {
    const first = await fixture(1);
    expect((await first.adapter.saveDraft(first.intent)).phase).toBe('published');
    store.close(); store = new PublishingStore(join(root, '.inkos/harness.sqlite'));
    packages = new ManualPublishingAdapter(root, store);
    const second = await fixture(2, label);
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(second.adapter.saveDraft(second.intent)).rejects.toMatchObject({code: 'PUBLISHING_CHAPTER_MAPPING_CONFLICT'});
    }
    expect(store.getFanqieRun(second.intent.packageId, 2)).toBeUndefined();
    expect(store.getPackage(second.intent.packageId).version).toBe(second.pkg.version);
    expect(store.getFanqieRun(first.intent.packageId, 1)?.phase).toBe('published');
    expect(second.browser.createDraft).not.toHaveBeenCalled();
    expect(second.browser.schedule).not.toHaveBeenCalled();
  });

  it('rejects a remote ID already claimed by a manual receipt on the same target', async () => {
    const first = await fixture(1);
    await packages.beginSubmission({packageId: first.intent.packageId, chapterNumber: 1, expectedVersion: 0, eventId: 'manual-begin'});
    store.recordReceipt({packageId: first.intent.packageId, chapterNumber: 1, expectedVersion: 1, eventId: 'manual-receipt',
      receipt: {status: 'published_reported', remoteChapterId: 'one-remote-chapter', evidence: 'User-reported fixture receipt'}});
    const second = await fixture(2);
    await expect(second.adapter.saveDraft(second.intent)).rejects.toMatchObject({code: 'PUBLISHING_CHAPTER_MAPPING_CONFLICT'});
    expect(store.getPackage(first.intent.packageId).chapters[0]!.provenance).toBe('user_reported');
    expect(second.browser.createDraft).not.toHaveBeenCalled();
  });

  it('rejects a later manual receipt that reuses a browser-observed remote ID on the same target', async () => {
    const first = await fixture(1);
    await first.adapter.saveDraft(first.intent);
    const second = await fixture(2);
    await packages.beginSubmission({packageId: second.intent.packageId, chapterNumber: 2, expectedVersion: 0, eventId: 'manual-begin'});
    expect(() => store.recordReceipt({packageId: second.intent.packageId, chapterNumber: 2, expectedVersion: 1, eventId: 'manual-receipt',
      receipt: {status: 'published_reported', remoteChapterId: 'one-remote-chapter', evidence: 'User-reported fixture receipt'}}))
      .toThrowError(expect.objectContaining({code: 'PUBLISHING_CHAPTER_MAPPING_CONFLICT'}));
    expect(store.getPackage(second.intent.packageId).chapters[0]!.status).toBe('awaiting_receipt');
    expect(store.getFanqieRun(first.intent.packageId, 1)?.phase).toBe('published');
  });

  it('also protects a MegaNovel browser receipt from a later conflicting manual report', async () => {
    const first = await fixture(1, 'author', 'actual-account', 'meganovel');
    store.writeMegaNovelRun({run: {...first.intent, revisionId: first.pkg.manifest.chapters[0]!.revisionId,
      phase: 'published', remoteChapterId: 'one-remote-chapter', evidence: 'Synthetic independently observed receipt'},
      expectedVersion: 0, eventId: 'browser-receipt'});
    const second = await fixture(2, 'author', 'actual-account', 'meganovel');
    await packages.beginSubmission({packageId: second.intent.packageId, chapterNumber: 2, expectedVersion: 0, eventId: 'manual-begin'});
    expect(() => store.recordReceipt({packageId: second.intent.packageId, chapterNumber: 2, expectedVersion: 1, eventId: 'manual-receipt',
      receipt: {status: 'published_reported', remoteChapterId: 'one-remote-chapter', evidence: 'User-reported fixture receipt'}}))
      .toThrowError(expect.objectContaining({code: 'PUBLISHING_CHAPTER_MAPPING_CONFLICT'}));
    expect(store.getPackage(second.intent.packageId).chapters[0]!.status).toBe('awaiting_receipt');
  });

  it('preserves a lost-response reservation when delayed readback reuses another chapter ID', async () => {
    const first = await fixture(1);
    await first.adapter.saveDraft(first.intent);
    const second = await fixture(2);
    const observed = second.snapshot.chapters;
    second.snapshot.chapters = [];
    expect((await second.adapter.saveDraft(second.intent)).phase).toBe('draft_unknown');
    second.snapshot.chapters = observed;
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(second.adapter.saveDraft(second.intent)).rejects.toMatchObject({code: 'PUBLISHING_CHAPTER_MAPPING_CONFLICT'});
    }
    expect(store.getFanqieRun(second.intent.packageId, 2)?.phase).toBe('draft_unknown');
    expect(second.browser.createDraft).toHaveBeenCalledTimes(1);
    expect(second.browser.schedule).not.toHaveBeenCalled();
  });

  it('keeps equal remote IDs isolated across independently identified actual accounts', async () => {
    const first = await fixture(1);
    await first.adapter.saveDraft(first.intent);
    const other = await fixture(2, 'another-author', 'different-actual-account');
    expect((await other.adapter.saveDraft(other.intent)).phase).toBe('published');
    expect(other.browser.createDraft).not.toHaveBeenCalled();
  });

  it.each(['draft', 'reviewing', 'scheduled', 'published', 'rejected'] as const)('rejects %s without a remote ID or nonempty evidence', async phase => {
    const {pkg, intent} = await fixture(1);
    const run = {...intent, revisionId: pkg.manifest.chapters[0]!.revisionId, phase,
      scheduledFor: null, remoteChapterId: 'one-remote-chapter', evidence: 'Synthetic observation'};
    for (const missing of [{remoteChapterId: null}, {evidence: null}, {evidence: '  '}]) {
      expect(FanqieRunSchema.safeParse({...run, ...missing}).success).toBe(false);
      expect(() => store.writeFanqieRun({run: {...run, ...missing}, expectedVersion: 0, eventId: 'invalid-receipt'})).toThrow();
    }
    expect(store.getFanqieRun(intent.packageId, 1)).toBeUndefined();
    expect(store.getPackage(intent.packageId).version).toBe(0);
  });

  it.each(['draft_unknown', 'schedule_unknown'] as const)('permits durable %s without claiming a receipt', async phase => {
    const {pkg, intent} = await fixture(1);
    expect(FanqieRunSchema.safeParse({...intent, revisionId: pkg.manifest.chapters[0]!.revisionId, phase,
      scheduledFor: null, remoteChapterId: null, evidence: null}).success).toBe(true);
  });
});
