import {mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {PublishingManifestSchema, type PublishingPlatform} from '../publishing/contracts.js';
import {PublishingStore} from '../publishing/store.js';
import {RemoteWorkStore} from '../publishing/work-creation-store.js';

// Contract probe only: synthetic SQLite records, no source books, exports or remote ports.
let root: string, databasePath: string, store: PublishingStore;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'inkos-sol-receipt-alias-probe-'));
  databasePath = join(root, 'publishing.sqlite');
  store = new PublishingStore(databasePath);
});
afterEach(() => {store.close(); rmSync(root, {recursive: true, force: true});});
function restart() {store.close(); store = new PublishingStore(databasePath);}

function fixture(platform: 'fanqie' | 'meganovel', accountLabel: string, number: number,
  accountId = 'actual-account-a', remoteBookId = 'account-local-book', artifactId = `chapter-${number}`) {
  const target = store.mapBook({workId: 'fixture-work', platform, accountLabel, remoteBookId});
  const id = `${platform}-${accountLabel}-${number}`;
  const manifest = PublishingManifestSchema.parse({
    version: 1, adapter: 'manual', id, operationKey: id, createdAt: target.createdAt, target,
    title: 'Synthetic contract fixture', language: 'en',
    chapters: [{artifactId, revisionId: `revision-${number}`, number, title: `Chapter ${number}`,
      sourcePath: `source/chapters/${number}.md`, packagePath: `chapters/${number}_chapter.md`}],
    formats: ['txt'], files: [{path: `chapters/${number}_chapter.md`, contentBase64: 'Zml4dHVyZQ==', byteLength: 7}],
    remoteVerified: false,
  });
  store.reservePreparation(manifest, '.prepare-probe');
  const pkg = store.registerPackage(manifest);
  return {pkg, scope: {accountLabel, accountId, remoteBookId, sessionId: `synthetic-${accountLabel}`}};
}
type Fixture = ReturnType<typeof fixture>;
function write(f: Fixture, remoteChapterId: string | null, expectedVersion = 0, eventId = 'observed') {
  const chapter = f.pkg.manifest.chapters[0]!;
  const run = {packageId: f.pkg.manifest.id, chapterNumber: chapter.number, revisionId: chapter.revisionId,
    scope: f.scope, aiAssisted: true, remoteChapterId,
    evidence: remoteChapterId ? 'Synthetic independent account/book/chapter readback.' : null,
    phase: remoteChapterId ? 'published' as const : 'draft_unknown' as const};
  return f.pkg.manifest.target.platform === 'fanqie'
    ? store.writeFanqieRun({run: {...run, scheduledFor: null}, expectedVersion, eventId})
    : store.writeMegaNovelRun({run, expectedVersion, eventId});
}
function read(f: Fixture) {
  const {id, target, chapters} = f.pkg.manifest;
  return target.platform === 'fanqie' ? store.getFanqieRun(id, chapters[0]!.number)
    : store.getMegaNovelRun(id, chapters[0]!.number);
}

describe('independent account-alias receipt contract probe', () => {
  describe.each(['fanqie', 'meganovel'] as const)('%s', platform => {
    it('rejects one observed remote chapter claimed by different local chapters through account aliases', () => {
      const first = fixture(platform, 'primary-label', 1);
      write(first, 'account-local-chapter');
      restart();
      const alias = fixture(platform, 'alias-label', 2);
      expect(alias.scope.accountId).toBe(read(first)!.scope.accountId);
      expect(alias.scope.remoteBookId).toBe(read(first)!.scope.remoteBookId);
      for (let attempt = 0; attempt < 2; attempt++) {
        expect(() => write(alias, 'account-local-chapter'))
          .toThrowError(expect.objectContaining({code: 'PUBLISHING_CHAPTER_MAPPING_CONFLICT'}));
      }
      expect(read(alias)).toBeUndefined();
      expect(store.getPackage(alias.pkg.manifest.id).version).toBe(0);
      expect(read(first)?.phase).toBe('published');
    });

    it('keeps identical book/chapter IDs, numbers and artifacts isolated across actual accounts', () => {
      const first = fixture(platform, 'primary-label', 1);
      write(first, 'account-local-chapter');
      restart();
      const separate = fixture(platform, 'different-label', 1, 'actual-account-b');
      write(separate, 'account-local-chapter');
      expect(read(first)?.scope.accountId).toBe('actual-account-a');
      expect(read(separate)).toMatchObject({phase: 'published', scope: {accountId: 'actual-account-b'}});
    });

    it('does not treat a chapter ID as globally unique across remote books', () => {
      const first = fixture(platform, 'primary-label', 1);
      write(first, 'book-local-chapter');
      const otherBook = fixture(platform, 'alias-label', 1, 'actual-account-a', 'another-remote-book');
      write(otherBook, 'book-local-chapter');
      expect(read(otherBook)).toMatchObject({phase: 'published', remoteChapterId: 'book-local-chapter'});
    });

    it('retains a lost-response alias reservation when delayed readback conflicts', () => {
      const first = fixture(platform, 'primary-label', 1);
      write(first, 'account-local-chapter');
      const alias = fixture(platform, 'alias-label', 2);
      write(alias, null, 0, 'reserve-before-response');
      restart();
      const reserved = read(alias);
      for (let attempt = 0; attempt < 2; attempt++) {
        expect(() => write(alias, 'account-local-chapter', 1, 'delayed-readback'))
          .toThrowError(expect.objectContaining({code: 'PUBLISHING_CHAPTER_MAPPING_CONFLICT'}));
      }
      expect(read(alias)).toEqual(reserved);
      expect(store.getPackage(alias.pkg.manifest.id).version).toBe(1);
      expect(() => store.recordReceipt({packageId: alias.pkg.manifest.id, chapterNumber: 2,
        expectedVersion: 1, eventId: 'manual-clear',
        receipt: {status: 'not_submitted_reported', evidence: 'Synthetic negative lookup.'}}))
        .toThrowError(expect.objectContaining({code: 'PUBLISHING_RECONCILIATION_REQUIRED'}));
      const replay = fixture(platform, 'replay-label', 3, 'actual-account-a', 'account-local-book', 'chapter-2');
      expect(() => write(replay, null))
        .toThrowError(expect.objectContaining({code: 'PUBLISHING_RECONCILIATION_REQUIRED'}));
      expect(read(replay)).toBeUndefined();
    });

    it.each([1, 2])('keeps unidentified manual uncertainty reserved against alias replay at number %s', number => {
      const manual = fixture(platform, 'manual-label', 1);
      store.beginSubmission({packageId: manual.pkg.manifest.id, chapterNumber: 1, expectedVersion: 0, eventId: 'manual-begin'});
      store.recordReceipt({packageId: manual.pkg.manifest.id, chapterNumber: 1, expectedVersion: 1,
        eventId: 'manual-lost-response', receipt: {status: 'submission_unknown', evidence: 'Synthetic lost response.'}});
      restart();
      const alias = fixture(platform, 'alias-label', number, 'independently-different-account',
        'account-local-book', number === 1 ? 'other-artifact' : 'chapter-1');
      expect(() => write(alias, null)).toThrowError(expect.objectContaining({code: 'PUBLISHING_RECONCILIATION_REQUIRED'}));
      expect(store.getTarget(manual.pkg.manifest.target.id)).toMatchObject({verification: 'user_supplied'});
      expect(store.getTarget(manual.pkg.manifest.target.id).observedAccountId).toBeUndefined();
      expect(store.getPackage(manual.pkg.manifest.id).chapters[0]!.status).toBe('submission_unknown');
      expect(read(alias)).toBeUndefined();
    });
  });

  it('does not permit manual labels to invent observed account identity', () => {
    const target = {workId: 'fixture-work', platform: 'meganovel' as const, accountLabel: 'manual', remoteBookId: 'remote-book'};
    expect(() => store.mapBook({...target, observedAccountId: 'invented-account',
      verification: 'independently_observed', creationOperationId: 'invented-operation'} as never)).toThrow();
    expect(store.listTargets()).toEqual([]);
  });

  it.each(['fanqie', 'meganovel'] as const)('%s mapping construction rejects duplicate actual-account book bindings across aliases', platform => {
    const creations = new RemoteWorkStore(databasePath);
    function observe(workId: string, accountLabel: string, accountId = 'actual-account-a', destinationPlatform: PublishingPlatform = platform) {
      const reserved = creations.reserve({workId, destination: {provider: 'synthetic-port', platform: destinationPlatform,
        accountLabel, accountId, sessionId: `synthetic-${accountLabel}`},
        metadata: {title: 'Synthetic', blurb: 'Synthetic', genre: 'Fantasy', language: 'en', aiAssisted: true}});
      const attempted = creations.beginCreation(reserved.id, reserved.version);
      return creations.recordObserved(attempted.id, attempted.version, {operationId: attempted.id,
        destination: attempted.input.destination, metadata: attempted.input.metadata, remoteBookId: 'account-local-book',
        observedAt: attempted.attemptedAt!, evidence: 'Synthetic independent creation readback.', provenance: 'independently_observed'});
    }
    try {
      const first = observe('first-work', 'primary-label');
      const bound = creations.bindObserved(first.id, first.version);
      const alias = observe('second-work', 'alias-label');
      expect(() => creations.bindObserved(alias.id, alias.version))
        .toThrowError(expect.objectContaining({code: 'REMOTE_WORK_BINDING_CONFLICT'}));
      expect(store.listTargets()).toHaveLength(1);
      expect(store.getTarget(bound.targetId!)).toMatchObject({verification: 'independently_observed', observedAccountId: 'actual-account-a'});
      const separate = observe('third-work', 'different-label', 'actual-account-b');
      expect(creations.bindObserved(separate.id, separate.version).phase).toBe('bound');
      const otherPlatform = observe('fourth-work', 'primary-label', 'actual-account-a', platform === 'fanqie' ? 'meganovel' : 'fanqie');
      expect(creations.bindObserved(otherPlatform.id, otherPlatform.version).phase).toBe('bound');
      expect(store.listTargets()).toHaveLength(3);
    } finally {creations.close();}
  });
});
