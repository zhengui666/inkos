import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInitialWorkManifestWrite } from '../harness/source-sync.js';
import { loadWorkManifest } from '../harness/work-store.js';
import { commitAtomicFileSet } from '../utils/atomic-file-set.js';
import { ManualPublishingAdapter, PublishingStore, FanqiePublishingAdapter, MegaNovelPublishingAdapter,
  type FanqieBrowserPort, type FanqieSnapshot, type MegaNovelBrowserPort, type MegaNovelSnapshot } from '../publishing/index.js';
let root: string, store: PublishingStore, packages: ManualPublishingAdapter;
const content = 'Independently reviewed fixture content.\n';
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'inkos-independent-publishing-'));
  const writes = [{ relativePath: 'works/work/source/chapters/8.md', content }];
  const initial = createInitialWorkManifestWrite({ workId: 'work', title: 'Fixture', profileId: 'long-form', language: 'en', writes });
  await commitAtomicFileSet({ rootDir: root, writes: [...writes, initial.write] });
  store = new PublishingStore(join(root, '.inkos/harness.sqlite')); packages = new ManualPublishingAdapter(root, store);
});
afterEach(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
async function pkg(platform: 'fanqie' | 'meganovel', accountLabel: string, number = 8) {
  const target = await packages.mapBook({ workId: 'work', platform, accountLabel, remoteBookId: 'shared-remote-book' });
  const artifact = (await loadWorkManifest(root, 'work')).artifacts[0]!;
  return packages.prepare({ targetId: target.id, formats: ['txt'], chapters: [{ artifactId: artifact.id, revisionId: artifact.currentRevisionId!, number, title: 'Fixture chapter' }] });
}
function scope(accountLabel: string, accountId: string) { return { accountLabel, accountId, sessionId: `fixture-tab-${accountLabel}`, remoteBookId: 'shared-remote-book' }; }
async function platformFixture(platform: 'fanqie' | 'meganovel', accountLabel: string, accountId: string) {
  const prepared = await pkg(platform, accountLabel); const intent = { packageId: prepared.manifest.id, chapterNumber: 8, aiAssisted: true, scope: scope(accountLabel, accountId) };
  const createDraft = vi.fn(async () => { throw new Error('synthetic indeterminate network response'); });
  if (platform === 'fanqie') {
    const snapshot: FanqieSnapshot = { scope: intent.scope, origin: 'https://fanqienovel.com', blocker: 'none', complete: true, chapters: [], schedulingAvailable: true };
    const port: FanqieBrowserPort = { snapshot: vi.fn(async () => structuredClone(snapshot)), createDraft, schedule: vi.fn() };
    return { intent, createDraft, snapshot, adapter: new FanqiePublishingAdapter(packages, store, port) };
  }
  const snapshot: MegaNovelSnapshot = { scope: intent.scope, origin: 'https://www.meganovel.com', blocker: 'none', chapterNumber: 8, complete: true, candidates: [] };
  const port: MegaNovelBrowserPort = { probe: vi.fn(async () => ({ scope: snapshot.scope, origin: snapshot.origin, blocker: snapshot.blocker })), snapshot: vi.fn(async () => structuredClone(snapshot)), createDraft, submit: vi.fn() };
  return { intent, createDraft, snapshot, adapter: new MegaNovelPublishingAdapter(packages, store, port) };
}

describe('independent account isolation and uncertainty review', () => {
  it.each(['fanqie', 'meganovel'] as const)('%s permits separate verified accounts but blocks same-account aliases across restart', async platform => {
    const first = await platformFixture(platform, 'primary-label', 'actual-account-a');
    expect((await first.adapter.saveDraft(first.intent)).phase).toBe('draft_unknown');
    expect((await first.adapter.saveDraft(first.intent)).phase).toBe('draft_unknown');
    expect(first.createDraft).toHaveBeenCalledTimes(1);
    store.close(); store = new PublishingStore(join(root, '.inkos/harness.sqlite')); packages = new ManualPublishingAdapter(root, store);
    const different = await platformFixture(platform, 'second-label', 'actual-account-b');
    expect((await different.adapter.saveDraft(different.intent)).phase).toBe('draft_unknown');
    expect(different.createDraft).toHaveBeenCalledTimes(1);
    const alias = await platformFixture(platform, 'alias-of-a', 'actual-account-a');
    await expect(alias.adapter.saveDraft(alias.intent)).rejects.toMatchObject({ code: 'PUBLISHING_RECONCILIATION_REQUIRED' });
    expect(alias.createDraft).not.toHaveBeenCalled();
  });

  it.each(['fanqie', 'meganovel'] as const)('%s preserves account-unidentified manual uncertainty across labels and restart', async platform => {
    const old = await pkg(platform, 'manual-label');
    await packages.beginSubmission({ packageId: old.manifest.id, chapterNumber: 8, expectedVersion: old.version, eventId: 'manual-unknown' });
    store.close(); store = new PublishingStore(join(root, '.inkos/harness.sqlite')); packages = new ManualPublishingAdapter(root, store);
    const attempt = await platformFixture(platform, 'fresh-label', 'new-actual-account');
    await expect(attempt.adapter.saveDraft(attempt.intent)).rejects.toMatchObject({ code: 'PUBLISHING_RECONCILIATION_REQUIRED' });
    expect(attempt.createDraft).not.toHaveBeenCalled();
  });

  it.each(['negative', 'draft-only', 'wrong-body', 'wrong-account'] as const)('keeps historical manual ownership conservative after %s readback', async observed => {
    const old = await platformFixture('meganovel', 'manual-label', 'claimed-account-a');
    await packages.beginSubmission({ packageId: old.intent.packageId, chapterNumber: 8, expectedVersion: 0, eventId: 'historical-manual-unknown' });
    const snapshot = old.snapshot as MegaNovelSnapshot;
    if (observed === 'draft-only' || observed === 'wrong-body') snapshot.candidates = [{ remoteChapterId: 'observed-chapter', number: 8, title: 'Fixture chapter', content: observed === 'wrong-body' ? 'different body' : content, status: observed === 'draft-only' ? 'draft' : 'published', aiDisclosure: 'declared_ai', evidence: 'independently opened fixture detail' }];
    if (observed === 'wrong-account') snapshot.scope = { ...snapshot.scope, accountId: 'observed-different-account' };
    if (observed === 'wrong-body') await expect(old.adapter.reconcile(old.intent)).rejects.toMatchObject({ code: 'MEGANOVEL_CONTENT_CONFLICT' });
    else if (observed === 'wrong-account') await expect(old.adapter.reconcile(old.intent)).rejects.toMatchObject({ code: 'MEGANOVEL_SCOPE_CHANGED' });
    else expect((await old.adapter.reconcile(old.intent)).phase).toBe('submit_unknown');
    expect(store.hasUnverifiedManualOrigin(old.intent.packageId, 8)).toBe(true);
    store.close(); store = new PublishingStore(join(root, '.inkos/harness.sqlite')); packages = new ManualPublishingAdapter(root, store);
    const attempt = await platformFixture('meganovel', 'another-label', 'actual-account-b');
    await expect(attempt.adapter.saveDraft(attempt.intent)).rejects.toMatchObject({ code: 'PUBLISHING_RECONCILIATION_REQUIRED' });
    expect(attempt.createDraft).not.toHaveBeenCalled();
  });

  it('precise published readback identifies a historical manual account without unlocking aliases of it', async () => {
    const old = await platformFixture('meganovel', 'manual-label', 'actual-account-a');
    await packages.beginSubmission({ packageId: old.intent.packageId, chapterNumber: 8, expectedVersion: 0, eventId: 'historical-manual-unknown' });
    (old.snapshot as MegaNovelSnapshot).candidates = [{ remoteChapterId: 'observed-chapter', number: 8, title: 'Fixture chapter', content, status: 'published', aiDisclosure: 'declared_ai', evidence: 'independently opened fixture detail' }];
    expect((await old.adapter.reconcile(old.intent)).phase).toBe('published');
    expect(store.hasUnverifiedManualOrigin(old.intent.packageId, 8)).toBe(false);
    expect(old.createDraft).not.toHaveBeenCalled();
    store.close(); store = new PublishingStore(join(root, '.inkos/harness.sqlite')); packages = new ManualPublishingAdapter(root, store);
    const different = await platformFixture('meganovel', 'other-account-label', 'actual-account-b');
    expect((await different.adapter.saveDraft(different.intent)).phase).toBe('draft_unknown');
    expect(different.createDraft).toHaveBeenCalledTimes(1);
    const alias = await platformFixture('meganovel', 'alias-label', 'actual-account-a');
    await expect(alias.adapter.saveDraft(alias.intent)).rejects.toMatchObject({ code: 'PUBLISHING_RECONCILIATION_REQUIRED' });
    expect(alias.createDraft).not.toHaveBeenCalled();
  });

  it('does not release unidentified manual uncertainty after failed MegaNovel account verification', async () => {
    const old = await platformFixture('meganovel', 'manual-label', 'unverified-account-claim');
    await packages.beginSubmission({ packageId: old.intent.packageId, chapterNumber: 8, expectedVersion: 0, eventId: 'historical-manual-unknown' });
    old.snapshot.blocker = 'login';
    await expect(old.adapter.reconcile(old.intent)).rejects.toMatchObject({ code: 'MEGANOVEL_BROWSER_BLOCKED' });
    store.close(); store = new PublishingStore(join(root, '.inkos/harness.sqlite')); packages = new ManualPublishingAdapter(root, store);
    const attempt = await platformFixture('meganovel', 'another-label', 'actual-account-b');
    await expect(attempt.adapter.saveDraft(attempt.intent)).rejects.toMatchObject({ code: 'PUBLISHING_RECONCILIATION_REQUIRED' });
    expect(attempt.createDraft).not.toHaveBeenCalled();
  });
});
