import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createInitialWorkManifestWrite, syncWorkSourceArtifacts } from '../harness/source-sync.js';
import { loadWorkManifest } from '../harness/work-store.js';
import { commitAtomicFileSet } from '../utils/atomic-file-set.js';
import { ManualPublishingAdapter, PublishingStore, listPublishingCapabilities, type PublishingManifest, type PublishingPackage } from '../publishing/index.js';
import type { PublishingPreparation } from '../publishing/store.js';

let root: string;
let store: PublishingStore;
let adapter: ManualPublishingAdapter;
const source = '# 第1章 初见\n\n这是明确选择的正文。\n';
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'inkos-publishing-'));
  const writes = [1, 2].map(number => ({relativePath: `works/book/source/chapters/${number}.md`, content: number === 1 ? source : '# 第2章 回家\n\n第二章正文。'}));
  const initial = createInitialWorkManifestWrite({workId: 'book', title: '测试书', profileId: 'long-form', language: 'zh', writes});
  await commitAtomicFileSet({rootDir: root, writes: [...writes, initial.write]});
  store = new PublishingStore(join(root, '.inkos', 'harness.sqlite'));
  adapter = new ManualPublishingAdapter(root, store);
});
afterEach(async () => { store.close(); await rm(root, {recursive: true, force: true}); });
async function prepare(number = 1, formats: Array<'txt'|'md'|'epub'> = ['txt', 'md']) {
  const target = await adapter.mapBook({workId: 'book', platform: 'fanqie', accountLabel: 'author-local-label', remoteBookId: 'platform-book-1'});
  const work = await loadWorkManifest(root, 'book');
  const artifact = work.artifacts.find(a => a.revisions.some(r => r.id === a.currentRevisionId && r.path.endsWith(`/${number}.md`)))!;
  return adapter.prepare({targetId: target.id, chapters: [{artifactId: artifact.id, revisionId: artifact.currentRevisionId!, number, title: number === 1 ? '初见' : '回家'}], formats});
}
function action(pkg: Awaited<ReturnType<typeof prepare>>, eventId = 'begin-1') {
  return {packageId: pkg.manifest.id, chapterNumber: 1, expectedVersion: pkg.version, eventId};
}

type Promotion = {
  finishPreparation(preparation: PublishingPreparation, root: string): Promise<PublishingPackage>;
  readExistingManifest(directory: string): Promise<PublishingManifest | undefined>;
  verifyExpectedManifest(directory: string, manifest: PublishingManifest): Promise<void>;
};
async function reserved(number = 1): Promise<PublishingPreparation> {
  const reserve = store.reservePreparation.bind(store);
  store.reservePreparation = (...args) => { reserve(...args); throw new Error('interrupted before promotion'); };
  try { await expect(prepare(number, ['txt', 'md', 'epub'])).rejects.toThrow('interrupted before promotion'); }
  finally { store.reservePreparation = reserve; }
  return store.listPreparations().find(item => item.manifest.chapters[0]!.number === number)!;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function waitUntilEntered(entered: ReturnType<typeof deferred>, task: Promise<PublishingPackage>) {
  await Promise.race([entered.promise, task.then(() => { throw new Error('Promotion completed without reaching the controlled staging read'); })]);
}

describe('manual publishing flow', () => {
  it('freezes exact revisions, reuses TXT/MD/EPUB export, and never claims publication', async () => {
    const before = await loadWorkManifest(root, 'book');
    const pkg = await prepare(1, ['txt', 'md', 'epub']);
    const verified = await adapter.verify(pkg.manifest.id);
    expect(pkg.chapters).toEqual([{number: 1, status: 'awaiting_submission', remoteChapterId: null, evidence: null, provenance: null}]);
    expect(pkg.remoteVerified).toBe(false);
    expect(await readFile(join(verified.directory, pkg.manifest.chapters[0]!.packagePath), 'utf8')).toBe(source);
    expect(await readFile(join(verified.directory, 'exports/book.txt'), 'utf8')).toContain(source.trim());
    expect((await readFile(join(verified.directory, 'exports/book.epub'))).subarray(0, 2).toString()).toBe('PK');
    expect(await loadWorkManifest(root, 'book')).toEqual(before);
    expect(pkg.manifest.chapters[0]).toMatchObject({revisionId: before.artifacts[0]!.currentRevisionId, artifactId: before.artifacts[0]!.id, sourcePath: before.artifacts[0]!.revisions[0]!.path});
    expect(listPublishingCapabilities().every(c => c.automaticSubmission === 'unavailable' && c.remoteVerification === 'unavailable')).toBe(true);
  });

  it('is idempotent and survives reopening SQLite without generating a new bundle', async () => {
    const pkg = await prepare();
    store.close();
    store = new PublishingStore(join(root, '.inkos', 'harness.sqlite'));
    adapter = new ManualPublishingAdapter(root, store);
    expect(await prepare()).toEqual(pkg);
    expect(store.listTargets()).toHaveLength(1);
    expect(store.listPackages()).toHaveLength(1);
  });

  it('keeps a prepared version unchanged when the author changes the source', async () => {
    const pkg = await prepare();
    await syncWorkSourceArtifacts({projectRoot: root, workId: 'book', accept: true,
      writes: [{relativePath: 'works/book/source/chapters/1.md', content: '# 第1章 初见\n\n修订后的正文。'}]});
    const next = await prepare();
    expect(next.manifest.id).not.toBe(pkg.manifest.id);
    expect(await readFile(join((await adapter.verify(pkg.manifest.id)).directory, pkg.manifest.chapters[0]!.packagePath), 'utf8')).toBe(source);
    expect(pkg.manifest.chapters[0]!.revisionId).not.toBe(next.manifest.chapters[0]!.revisionId);
  });

  it('allows an explicitly selected draft while rejecting missing, duplicate and non-text selections', async () => {
    const target = await adapter.mapBook({workId: 'book', platform: 'qidian', accountLabel: 'author', remoteBookId: 'qid-1'});
    const work = await syncWorkSourceArtifacts({projectRoot: root, workId: 'book', accept: false,
      writes: [{relativePath: 'works/book/source/chapters/1.md', content: 'Candidate'}, {relativePath: 'works/book/source/meta.json', content: '{}'}]});
    const candidate = work.artifacts.find(a => a.revisions.some(r => r.status === 'candidate' && r.path.endsWith('/1.md')))!;
    const selection = {artifactId: candidate.id, revisionId: candidate.revisions.find(r => r.status === 'candidate')!.id, number: 1, title: '一'};
    const draftPackage = await adapter.prepare({targetId: target.id, chapters: [selection]});
    expect(draftPackage.manifest.chapters[0]!.revisionId).toBe(selection.revisionId);
    expect((await loadWorkManifest(root,'book')).artifacts.find(a=>a.id===candidate.id)!.currentRevisionId).toBe(candidate.currentRevisionId);
    await expect(adapter.prepare({targetId: target.id, chapters: [{...selection, revisionId: 'missing'}]})).rejects.toMatchObject({code: 'ARTIFACT_NOT_FOUND'});
    await expect(adapter.prepare({targetId: target.id, chapters: [selection, selection]})).rejects.toThrow('only once');
    const accepted = await syncWorkSourceArtifacts({projectRoot: root, workId: 'book', accept: true});
    const json = accepted.artifacts.find(a => a.revisions.some(r => r.path.endsWith('meta.json')))!;
    await expect(adapter.prepare({targetId: target.id, chapters: [{...selection, artifactId: json.id, revisionId: json.currentRevisionId!}]}))
      .rejects.toMatchObject({code: 'PUBLISHING_SOURCE_UNSUPPORTED'});
  });

  it('does not recreate or begin submission with altered package files', async () => {
    const pkg = await prepare();
    const directory = (await adapter.verify(pkg.manifest.id)).directory;
    await writeFile(join(directory, 'exports/book.txt'), 'changed');
    await expect(prepare()).rejects.toMatchObject({code: 'PUBLISHING_PACKAGE_INTEGRITY'});
    await expect(adapter.beginSubmission(action(pkg))).rejects.toMatchObject({code: 'PUBLISHING_PACKAGE_INTEGRITY'});
    expect(store.getPackage(pkg.manifest.id).version).toBe(0);
  });

  it('keeps selected revision bytes after source drift and rejects package symlink substitution', async () => {
    const pkg = await prepare();
    const directory = (await adapter.verify(pkg.manifest.id)).directory;
    await rm(join(directory, 'exports/book.txt'));
    await symlink(join(root, 'works/book/source/chapters/1.md'), join(directory, 'exports/book.txt'));
    await expect(adapter.verify(pkg.manifest.id)).rejects.toMatchObject({code: 'PUBLISHING_UNSAFE_PATH'});
    await writeFile(join(root, 'works/book/source/chapters/1.md'), 'unregistered edit');
    await rm(join(directory, 'exports/book.txt'));
    const retained = pkg.manifest.files.find(file => file.path === 'exports/book.txt')!;
    await writeFile(join(directory, 'exports/book.txt'), Buffer.from(retained.contentBase64!, 'base64'));
    expect((await prepare()).manifest.id).toBe(pkg.manifest.id);
    expect(await readFile(join(directory,pkg.manifest.chapters[0]!.packagePath),'utf8')).toBe(source);
  });

  it('reconciles a complete orphaned package after a crash before database registration', async () => {
    const register = store.registerPackage.bind(store);
    store.registerPackage = () => { throw new Error('simulated process failure'); };
    await expect(prepare()).rejects.toThrow('simulated process failure');
    store.registerPackage = register;
    const recovered = await prepare();
    expect(recovered.version).toBe(0);
    expect(store.listPackages()).toHaveLength(1);
    await adapter.verify(recovered.manifest.id);
  });

  it('recovers reserved staging after interruption before directory promotion', async () => {
    const reserve = store.reservePreparation.bind(store);
    store.reservePreparation = (...args) => { reserve(...args); throw new Error('crash before promotion'); };
    await expect(prepare()).rejects.toThrow('crash before promotion');
    store.reservePreparation = reserve;
    expect((await readdir(join(root, '.inkos/publishing'))).every(name => name.startsWith('.prepare-'))).toBe(true);
    store.close(); store = new PublishingStore(join(root, '.inkos', 'harness.sqlite')); adapter = new ManualPublishingAdapter(root, store);
    const recovered = await prepare();
    await adapter.verify(recovered.manifest.id);
    expect(store.findPreparation(recovered.manifest.operationKey)).toBeUndefined();
  });

  it('rejects coordinated manifest and export tampering in a complete orphan package', async () => {
    const register = store.registerPackage.bind(store);
    store.registerPackage = () => { throw new Error('crash after promotion'); };
    await expect(prepare()).rejects.toThrow('crash after promotion');
    store.registerPackage = register;
    const id = (await readdir(join(root, '.inkos/publishing'))).find(name => name.startsWith('manual-'))!;
    const directory = join(root, '.inkos/publishing', id);
    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
    const unrelated = 'Unrelated text not present in the selected artifact.';
    await writeFile(join(directory, 'exports/book.txt'), unrelated);
    const file = manifest.files.find((file: {path: string}) => file.path === 'exports/book.txt');
    file.contentBase64 = Buffer.from(unrelated).toString('base64');
    file.byteLength = Buffer.byteLength(unrelated);
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
    await expect(prepare()).rejects.toMatchObject({code: 'PUBLISHING_PACKAGE_INTEGRITY'});
    expect(store.listPackages()).toHaveLength(0);
  });

  it('fails closed for an orphan directory without its authoritative database record', async () => {
    const pkg = await prepare();
    const {DatabaseSync} = await import('node:sqlite');
    const database = new DatabaseSync(join(root, '.inkos/harness.sqlite'));
    try { database.prepare('DELETE FROM publishing_chapters WHERE package_id=?').run(pkg.manifest.id);
      database.prepare('DELETE FROM publishing_packages WHERE id=?').run(pkg.manifest.id); }
    finally { database.close(); }
    await expect(prepare()).rejects.toMatchObject({code: 'PUBLISHING_PACKAGE_INTEGRITY'});
    expect(store.listPackages()).toHaveLength(0);
  });

  it('converges concurrent preparation on one authoritative export including EPUB bytes', async () => {
    const secondStore = new PublishingStore(join(root, '.inkos/harness.sqlite'));
    try {
      const target = await adapter.mapBook({workId: 'book', platform: 'qidian', accountLabel: 'author', remoteBookId: 'concurrent-book'});
      const artifact = (await loadWorkManifest(root, 'book')).artifacts[0]!;
      const input = {targetId: target.id, chapters: [{artifactId: artifact.id, revisionId: artifact.currentRevisionId!, number: 1, title: 'Concurrent'}]};
      const [first, second] = await Promise.all([adapter.prepare(input), new ManualPublishingAdapter(root, secondStore).prepare(input)]);
      expect(first).toEqual(second);
      await adapter.verify(first.manifest.id);
      expect(store.listPackages()).toHaveLength(1);
    } finally { secondStore.close(); }
  });

  it('serializes the full promotion across stores and independently checks each queued manifest', async () => {
    const pending = await reserved(), packageRoot = await realpath(join(root, '.inkos/publishing'));
    const staging = join(packageRoot, pending.stagingDirectory!);
    const secondStore = new PublishingStore(join(root, '.inkos/harness.sqlite'));
    const secondAdapter = new ManualPublishingAdapter(root, secondStore);
    const first = adapter as unknown as Promotion, second = secondAdapter as unknown as Promotion;
    const entered = deferred(), release = deferred();
    const verify = first.verifyExpectedManifest.bind(adapter);
    first.verifyExpectedManifest = async (directory, manifest) => {
      if (directory === staging) { entered.resolve(); await release.promise; }
      return verify(directory, manifest);
    };
    let secondReads = 0;
    const read = second.readExistingManifest.bind(secondAdapter);
    second.readExistingManifest = async directory => { secondReads++; return read(directory); };
    const tasks: Promise<PublishingPackage>[] = [];
    try {
      tasks.push(first.finishPreparation(pending, packageRoot));
      await waitUntilEntered(entered, tasks[0]!);
      tasks.push(second.finishPreparation(pending, packageRoot));
      tasks.push(second.finishPreparation({...pending, manifest: {...pending.manifest, title: 'Different expected title'}}, packageRoot));
      expect(secondReads).toBe(0);
      release.resolve();
      const [one, two, invalid] = await Promise.allSettled(tasks);
      expect(one.status).toBe('fulfilled'); expect(two.status).toBe('fulfilled');
      if (one.status !== 'fulfilled' || two.status !== 'fulfilled') throw new Error('Expected both valid promotions to finish');
      expect(one.value).toEqual(two.value);
      expect(secondReads).toBeGreaterThan(0);
      expect(invalid.status).toBe('rejected');
      if (invalid.status === 'rejected') expect(invalid.reason).toMatchObject({code: 'PUBLISHING_PACKAGE_INTEGRITY'});
      const result = await adapter.verify(one.value.manifest.id);
      for (const file of pending.manifest.files) expect(await readFile(join(result.directory, file.path))).toEqual(Buffer.from(file.contentBase64!, 'base64'));
      expect(store.listPackages()).toHaveLength(1);
    } finally { release.resolve(); await Promise.allSettled(tasks); secondStore.close(); }
  });

  it('preserves the original promotion error and releases a queued caller to recover retained staging', async () => {
    const pending = await reserved(), packageRoot = await realpath(join(root, '.inkos/publishing'));
    const staging = join(packageRoot, pending.stagingDirectory!);
    const secondStore = new PublishingStore(join(root, '.inkos/harness.sqlite'));
    const secondAdapter = new ManualPublishingAdapter(root, secondStore);
    const first = adapter as unknown as Promotion, second = secondAdapter as unknown as Promotion;
    const entered = deferred(), release = deferred();
    const failure = Object.assign(new Error('original permission failure'), {code: 'EPERM'});
    const verifyFirst = first.verifyExpectedManifest.bind(adapter);
    first.verifyExpectedManifest = async (directory, manifest) => {
      if (directory === staging) { entered.resolve(); await release.promise; throw failure; }
      return verifyFirst(directory, manifest);
    };
    let retained = false;
    const verifySecond = second.verifyExpectedManifest.bind(secondAdapter);
    second.verifyExpectedManifest = async (directory, manifest) => {
      if (directory === staging) { expect(store.findPreparation(pending.manifest.operationKey)).toEqual(pending); retained = true; }
      return verifySecond(directory, manifest);
    };
    const tasks: Promise<PublishingPackage>[] = [];
    try {
      tasks.push(first.finishPreparation(pending, packageRoot));
      await waitUntilEntered(entered, tasks[0]!);
      tasks.push(second.finishPreparation(pending, packageRoot));
      release.resolve();
      const [failed, recovered] = await Promise.allSettled(tasks);
      expect(failed.status).toBe('rejected');
      if (failed.status === 'rejected') expect(failed.reason).toBe(failure);
      expect(recovered.status).toBe('fulfilled'); expect(retained).toBe(true);
      if (recovered.status !== 'fulfilled') throw new Error('Expected retained staging recovery');
      expect(recovered.value.manifest.id).toBe(pending.manifest.id);
      await adapter.verify(recovered.value.manifest.id);
      expect(store.listPackages()).toHaveLength(1);
      expect(store.findPreparation(pending.manifest.operationKey)).toBeUndefined();
    } finally { release.resolve(); await Promise.allSettled(tasks); secondStore.close(); }
  });

  it('allows a different package promotion while one package is waiting', async () => {
    const pending = await reserved(1), other = await reserved(2);
    const packageRoot = await realpath(join(root, '.inkos/publishing'));
    const first = adapter as unknown as Promotion;
    const secondStore = new PublishingStore(join(root, '.inkos/harness.sqlite'));
    const secondAdapter = new ManualPublishingAdapter(root, secondStore);
    const second = secondAdapter as unknown as Promotion;
    const entered = deferred(), release = deferred();
    const verify = first.verifyExpectedManifest.bind(adapter);
    first.verifyExpectedManifest = async (directory, manifest) => {
      if (directory === join(packageRoot, pending.stagingDirectory!)) { entered.resolve(); await release.promise; }
      return verify(directory, manifest);
    };
    let secondReads = 0;
    const read = second.readExistingManifest.bind(secondAdapter);
    second.readExistingManifest = async directory => { secondReads++; return read(directory); };
    const tasks: Promise<PublishingPackage>[] = [];
    try {
      tasks.push(first.finishPreparation(pending, packageRoot));
      await waitUntilEntered(entered, tasks[0]!);
      const independent = second.finishPreparation(other, packageRoot); tasks.push(independent);
      // Yield the microtask queue without a timer: a mistaken global queue must
      // fail here and release the first gate instead of deadlocking this test.
      await nextTurn();
      expect(secondReads).toBeGreaterThan(0);
      expect((await independent).manifest.id).toBe(other.manifest.id);
      expect(store.findPreparation(pending.manifest.operationKey)).toEqual(pending);
      release.resolve(); await Promise.all(tasks);
      expect(store.listPackages()).toHaveLength(2);
    } finally { release.resolve(); await Promise.allSettled(tasks); secondStore.close(); }
  });

  it('rechecks SQLite when another preparer finishes between DB lookup and directory read', async () => {
    const secondStore = new PublishingStore(join(root, '.inkos/harness.sqlite'));
    let observed!: () => void;
    let proceed!: () => void;
    const reachedDirectory = new Promise<void>(resolve => { observed = resolve; });
    const continueRead = new Promise<void>(resolve => { proceed = resolve; });
    const filesystem = adapter as unknown as {readExistingManifest(directory: string): Promise<PublishingManifest | undefined>};
    const original = filesystem.readExistingManifest.bind(adapter);
    let firstRead = true;
    filesystem.readExistingManifest = async directory => {
      if (firstRead) { firstRead = false; observed(); await continueRead; }
      return original(directory);
    };
    try {
      const target = await adapter.mapBook({workId: 'book', platform: 'qidian', accountLabel: 'author', remoteBookId: 'racing-book'});
      const artifact = (await loadWorkManifest(root, 'book')).artifacts[0]!;
      const input = {targetId: target.id, chapters: [{artifactId: artifact.id, revisionId: artifact.currentRevisionId!, number: 1, title: 'Race'}]};
      const first = adapter.prepare(input);
      await reachedDirectory;
      const winner = await new ManualPublishingAdapter(root, secondStore).prepare(input);
      proceed();
      expect(await first).toEqual(winner);
      expect(store.listPackages()).toHaveLength(1);
    } finally { proceed(); secondStore.close(); }
  });

  it('retains uncertainty across restarts and blocks blind retries even with a new revision', async () => {
    const pkg = await prepare();
    const begun = await adapter.beginSubmission(action(pkg));
    expect(begun.chapters[0]!.status).toBe('awaiting_receipt');
    expect(await adapter.beginSubmission(action(pkg))).toEqual(begun);
    const unknown = adapter.recordReceipt({...action(begun, 'unknown'), receipt: {status: 'submission_unknown', evidence: 'Portal timed out after the manual click.'}});
    store.close(); store = new PublishingStore(join(root, '.inkos', 'harness.sqlite')); adapter = new ManualPublishingAdapter(root, store);
    await expect(adapter.beginSubmission(action(unknown, 'retry'))).rejects.toMatchObject({code: 'PUBLISHING_RECONCILIATION_REQUIRED'});
    await syncWorkSourceArtifacts({projectRoot: root, workId: 'book', accept: true, writes: [{relativePath: 'works/book/source/chapters/1.md', content: 'New revision'}]});
    const newer = await prepare();
    await expect(adapter.beginSubmission(action(newer, 'newer'))).rejects.toMatchObject({code: 'PUBLISHING_RECONCILIATION_REQUIRED'});
    const absent = adapter.recordReceipt({...action(unknown, 'checked-absent'), receipt: {status: 'not_submitted_reported', evidence: 'Author checked both drafts and review queue: no submission.'}});
    expect(absent.chapters[0]!.status).toBe('not_submitted_reported');
    expect((await adapter.beginSubmission(action(newer, 'newer-allowed'))).chapters[0]!.status).toBe('awaiting_receipt');
    await expect(adapter.beginSubmission(action(absent, 'old-version-retry'))).rejects.toMatchObject({code: 'PUBLISHING_RECONCILIATION_REQUIRED'});
  });

  it('blocks renumbering an unresolved artifact even across revisions and restarts', async () => {
    const pkg = await prepare();
    await adapter.beginSubmission(action(pkg));
    store.close(); store = new PublishingStore(join(root, '.inkos', 'harness.sqlite')); adapter = new ManualPublishingAdapter(root, store);
    await syncWorkSourceArtifacts({projectRoot: root, workId: 'book', accept: true, writes: [{relativePath: 'works/book/source/chapters/1.md', content: 'Changed manuscript'}]});
    const artifact = (await loadWorkManifest(root, 'book')).artifacts.find(a => a.id === pkg.manifest.chapters[0]!.artifactId)!;
    for (const revisionId of [pkg.manifest.chapters[0]!.revisionId, artifact.currentRevisionId!]) {
      const renumbered = await adapter.prepare({targetId: pkg.manifest.target.id, formats: ['txt'],
        chapters: [{artifactId: artifact.id, revisionId, number: 9, title: 'Renumbered'}]});
      await expect(adapter.beginSubmission({...action(renumbered, 'renumbered-attempt'), chapterNumber: 9}))
        .rejects.toMatchObject({code: 'PUBLISHING_RECONCILIATION_REQUIRED'});
    }
  });

  it('distinguishes submitted and published reports and never upgrades verification', async () => {
    const begun = await adapter.beginSubmission(action(await prepare()));
    const submitted = adapter.recordReceipt({...action(begun, 'submitted'), receipt: {status: 'submitted_reported', evidence: 'Author portal says pending review.', remoteChapterId: 'chapter-remote-1'}});
    expect(submitted.chapters[0]!.status).toBe('submitted_reported');
    expect(() => adapter.recordReceipt({...action(submitted, 'regress'), receipt: {status: 'submission_unknown', evidence: 'Try to clear it.'}})).toThrow('cannot be cleared');
    expect(() => adapter.recordReceipt({...action(submitted, 'publish-no-id'), receipt: {status: 'published_reported', evidence: 'Says published'}})).toThrow('chapter ID');
    const published = adapter.recordReceipt({...action(submitted, 'published'), receipt: {status: 'published_reported', evidence: 'Author checked the platform chapter status.', remoteChapterId: 'chapter-remote-1'}});
    expect(published.chapters[0]).toMatchObject({status: 'published_reported', provenance: 'user_reported', remoteChapterId: 'chapter-remote-1'});
    expect(published.remoteVerified).toBe(false);
    await expect(adapter.beginSubmission(action(published, 'again'))).rejects.toMatchObject({code: 'PUBLISHING_RECONCILIATION_REQUIRED'});
  });

  it('rejects stale writes, reused event IDs and changing established chapter mappings', async () => {
    const pkg = await prepare();
    const begun = await adapter.beginSubmission(action(pkg));
    await expect(adapter.beginSubmission(action(pkg, 'stale'))).rejects.toMatchObject({code: 'PUBLISHING_VERSION_CONFLICT'});
    expect(() => adapter.recordReceipt({...action(begun, 'begin-1'), receipt: {status: 'submission_unknown', evidence: 'Unknown'}})).toThrow('event ID');
    const input = {...action(begun, 'receipt-1'), receipt: {status: 'submitted_reported' as const, evidence: 'Pending review', remoteChapterId: 'r-1'}};
    const submitted = adapter.recordReceipt(input);
    expect(adapter.recordReceipt(input)).toEqual(submitted);
    expect(() => adapter.recordReceipt({...action(submitted, 'wrong-id'), receipt: {status: 'published_reported', evidence: 'Published', remoteChapterId: 'r-2'}})).toThrow('cannot change');
  });

  it('permits independent chapter progress but disallows mapping one remote chapter twice', async () => {
    const first = await adapter.beginSubmission(action(await prepare()));
    adapter.recordReceipt({...action(first, 'receipt'), receipt: {status: 'submitted_reported', evidence: 'Pending', remoteChapterId: 'same-id'}});
    const second = await prepare(2);
    const next = await adapter.beginSubmission({...action(second), chapterNumber: 2});
    expect(() => adapter.recordReceipt({...action(next, 'receipt'), chapterNumber: 2, receipt: {status: 'published_reported', evidence: 'Wrong remote chapter', remoteChapterId: 'same-id'}}))
      .toThrow('already mapped');
  });

  it('serializes competing store connections and rejects mapping a remote book to another work', async () => {
    const pkg = await prepare();
    const second = new PublishingStore(join(root, '.inkos', 'harness.sqlite'));
    try {
      second.beginSubmission(action(pkg));
      expect(() => store.beginSubmission(action(pkg, 'second-client'))).toThrow('state changed');
      expect(() => second.mapBook({...pkg.manifest.target, workId: 'other'} as never)).toThrow();
      const {platform, accountLabel, remoteBookId} = pkg.manifest.target;
      expect(() => second.mapBook({platform, accountLabel, remoteBookId, workId: 'other'})).toThrow('another Work');
    } finally { second.close(); }
  });

  it('does not follow a publishing-directory symlink outside the project', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'inkos-publishing-outside-'));
    try {
      await symlink(outside, join(root, '.inkos/publishing'));
      await expect(prepare()).rejects.toMatchObject({code: 'PUBLISHING_UNSAFE_PATH'});
    } finally { await rm(outside, {recursive: true, force: true}); }
  });
  it('does not let an unrelated damaged package block a new selection', async () => {
    await mkdir(join(root,'.inkos/publishing/manual-unrelated'),{recursive:true});
    await writeFile(join(root,'.inkos/publishing/manual-unrelated/manifest.json'),'broken JSON');
    const pkg=await prepare();
    expect(pkg.manifest.chapters[0]!.number).toBe(1);
    expect(store.listPackages()).toHaveLength(1);
  });

});
