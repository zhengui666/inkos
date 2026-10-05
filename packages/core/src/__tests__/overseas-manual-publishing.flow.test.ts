import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createInitialWorkManifestWrite } from '../harness/source-sync.js';
import { loadWorkManifest } from '../harness/work-store.js';
import { commitAtomicFileSet } from '../utils/atomic-file-set.js';
import {
  ManualPublishingAdapter, PublishingPlatformSchema, PublishingStore, listPublishingCapabilities,
} from '../publishing/index.js';

const overseasPlatforms = ['meganovel', 'goodnovel', 'dreame'] as const;
const content = '# Chapter 1: The First Gate\n\nNell opened the gate and stepped through.\n';
let root: string;
let store: PublishingStore;
let adapter: ManualPublishingAdapter;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'inkos-overseas-manual-'));
  const writes = [{relativePath: 'works/book/source/chapters/1.md', content}];
  const initial = createInitialWorkManifestWrite({workId: 'book', title: 'The First Gate',
    profileId: 'long-form', language: 'en', writes});
  await commitAtomicFileSet({rootDir: root, writes: [...writes, initial.write]});
  store = new PublishingStore(join(root, '.inkos', 'harness.sqlite'));
  adapter = new ManualPublishingAdapter(root, store);
});
afterEach(async () => {
  store.close();
  await rm(root, {recursive: true, force: true});
});

describe('overseas manual publishing targets', () => {
  it('keeps domestic platforms and rejects unknown platforms', () => {
    for (const platform of ['fanqie', 'qidian', 'qimao']) {
      expect(PublishingPlatformSchema.parse(platform)).toBe(platform);
    }
    expect(() => PublishingPlatformSchema.parse('unknown-platform')).toThrow();
  });

  it.each(overseasPlatforms)('prepares and tracks %s without claiming remote submission', async platform => {
    expect(PublishingPlatformSchema.parse(platform)).toBe(platform);
    const capability = listPublishingCapabilities().find(item => item.platform === platform);
    expect(capability).toMatchObject({adapter: 'manual', preparePackage: 'available',
      automaticSubmission: 'unavailable', remoteVerification: 'unavailable'});
    expect(capability?.guidance.length).toBeGreaterThan(0);
    expect(capability?.sources.every(url => url.startsWith('https://'))).toBe(true);

    const target = await adapter.mapBook({workId: 'book', platform,
      accountLabel: 'author-test-label', remoteBookId: 'existing-remote-book'});
    const workBefore = await loadWorkManifest(root, 'book');
    const chapter = workBefore.artifacts[0]!;
    const input = {targetId: target.id, chapters: [{artifactId: chapter.id,
      revisionId: chapter.currentRevisionId!, number: 1, title: 'The First Gate'}],
      formats: ['txt', 'md'] as Array<'txt' | 'md'>};
    const prepared = await adapter.prepare(input);
    const duplicate = await adapter.prepare(input);
    expect(duplicate.manifest.id).toBe(prepared.manifest.id);
    expect(prepared.manifest.target.platform).toBe(platform);
    expect(prepared.manifest.formats).toEqual(['md', 'txt']);
    expect(prepared.remoteVerified).toBe(false);
    expect(prepared.chapters[0]).toMatchObject({status: 'awaiting_submission',
      remoteChapterId: null, evidence: null, provenance: null});
    const verified = await adapter.verify(prepared.manifest.id);
    expect(await readFile(join(verified.directory, prepared.manifest.chapters[0]!.packagePath), 'utf8')).toBe(content);
    expect(await loadWorkManifest(root, 'book')).toEqual(workBefore);

    const begun = await adapter.beginSubmission({packageId: prepared.manifest.id, chapterNumber: 1,
      expectedVersion: prepared.version, eventId: 'manual-begin'});
    const published = adapter.recordReceipt({packageId: prepared.manifest.id, chapterNumber: 1,
      expectedVersion: begun.version, eventId: 'manual-receipt',
      receipt: {status: 'published_reported', remoteChapterId: 'author-observed-chapter',
        evidence: 'Synthetic author-reported receipt; no platform request occurred.'}});
    expect(published.chapters[0]).toMatchObject({status: 'published_reported', provenance: 'user_reported'});
    expect(published.remoteVerified).toBe(false);
    await expect(adapter.beginSubmission({packageId: prepared.manifest.id, chapterNumber: 1,
      expectedVersion: published.version, eventId: 'duplicate-begin'}))
      .rejects.toMatchObject({code: 'PUBLISHING_RECONCILIATION_REQUIRED'});
  });
});
