import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {mkdtemp, mkdir, readFile, readdir, rm, writeFile, symlink, link} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {StateManager} from '../state/manager.js';
import {syncWorkSourceArtifacts} from '../harness/source-sync.js';
import {loadWorkManifest} from '../harness/work-store.js';
import {PublishingStore} from '../publishing/store.js';
import {ManualPublishingAdapter} from '../publishing/manual-adapter.js';
import {runPublishingPreflight, PublishingPreflightRegistry, observeMegaNovelPreflight,
  publishingPreflightFailure, createDefaultPublishingPreflightRegistry} from '../publishing/preflight.js';
import {MegaNovelSnapshotRequestSchema, type MegaNovelSnapshot, type MegaNovelObservationPort} from '../publishing/meganovel-contracts.js';

let root: string, snapshot: MegaNovelSnapshot, registry: PublishingPreflightRegistry;
let browser: MegaNovelObservationPort, observe: ReturnType<typeof vi.fn>;
const scope = {sessionId: 'synthetic-tab', accountId: '42', accountLabel: 'fixture', remoteBookId: '99'};
const body = 'A synthetic retained paragraph.\n', document = '# Chapter 1: Scene\n\n' + body;
const path = 'works/book/source/chapters/0001_Scene.md';
const configuration = {version: 1, bindings: [{provider: 'synthetic', workId: 'book', configuration: {}}]};
async function tree(directory = root): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const item of await readdir(directory, {withFileTypes: true})) {
    const entry = join(directory, item.name), key = entry.slice(root.length);
    if (item.isDirectory()) { files[key + '/'] = 'directory'; Object.assign(files, await tree(entry)); }
    else files[key] = (await readFile(entry)).toString('base64');
  }
  return files;
}
async function selected() {
  const work = await loadWorkManifest(root, 'book');
  const artifact = work.artifacts.find(item => item.revisions.some(revision => revision.path.endsWith('0001_Scene.md')))!;
  return {work, artifact};
}
const run = () => runPublishingPreflight({projectRoot: root, configuration, chapterNumber: 1, workId: 'book'}, registry);
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'inkos-rebuilt-preflight-'));
  const state = new StateManager(root), now = new Date().toISOString();
  await state.saveBookConfig('book', {id: 'book', title: 'Synthetic book', platform: 'meganovel', genre: 'fantasy', status: 'active',
    targetChapters: 10, chapterWordCount: 1000, language: 'en', createdAt: now, updatedAt: now});
  await state.saveChapterIndex('book', [{number: 1, title: 'Scene', wordCount: 5, provenance: 'generated', observations: [], createdAt: now, updatedAt: now}]);
  await syncWorkSourceArtifacts({projectRoot: root, workId: 'book', accept: true, writes: [{relativePath: path, content: document}]});
  snapshot = {scope, origin: 'https://www.meganovel.com', blocker: 'none', chapterNumber: 1, complete: true,
    candidates: [{remoteChapterId: '101', number: 1, title: 'Scene', content: body, status: 'submitted',
      aiDisclosure: 'not_present', evidence: 'Private synthetic remote evidence'}]};
  browser = {probe: vi.fn(async () => ({scope, origin: 'https://www.meganovel.com' as const, blocker: 'none' as const})),
    snapshot: vi.fn(async () => structuredClone(snapshot))};
  observe = vi.fn(async (_configuration, chapter, options) => observeMegaNovelPreflight(browser, scope, chapter, options));
  registry = new PublishingPreflightRegistry().register({provider: 'synthetic', parseConfiguration: value => value, observe});
});
afterEach(async () => {vi.restoreAllMocks(); await rm(root, {recursive: true, force: true});});

describe('rebuilt observation-only preflight, synthetic fixtures only', () => {
  it('matches the true current retained revision without opening SQLite or creating a package', async () => {
    const before = await tree(), result = await run();
    expect(result).toMatchObject({observationOnly: true, publicationAuthorized: false, targetMappingChecked: false,
      retainedAttemptsChecked: false, revisionId: (await selected()).artifact.currentRevisionId, matchesCurrentRevision: true,
      accountMatches: true, bookMatches: true, contentMatches: true, remoteStatus: 'submitted', errors: []});
    expect(browser.snapshot).toHaveBeenCalledWith({scope, chapterNumber: 1, expectedTitle: 'Scene'}, expect.any(Object));
    expect(JSON.stringify(result)).not.toContain(body.trim()); expect(JSON.stringify(result)).not.toContain('Private synthetic');
    expect(await tree()).toEqual(before);
  });
  it.each(['body', 'title', 'number', 'duplicate', 'incomplete', 'account', 'book', 'chapter', 'blocker', 'absent'] as const)
  ('returns a nonmatching result for %s, preserving the whole project tree', async mismatch => {
    if (mismatch === 'body') snapshot.candidates[0]!.content = 'Different body';
    if (mismatch === 'title') snapshot.candidates[0]!.title = 'Different';
    if (mismatch === 'number') snapshot.candidates[0]!.number = 2;
    if (mismatch === 'duplicate') snapshot.candidates.push({...snapshot.candidates[0]!, remoteChapterId: '102'});
    if (mismatch === 'incomplete') snapshot.complete = false;
    if (mismatch === 'account') snapshot.scope = {...scope, accountId: 'other'};
    if (mismatch === 'book') snapshot.scope = {...scope, remoteBookId: 'other'};
    if (mismatch === 'chapter') snapshot.chapterNumber = 2;
    if (mismatch === 'blocker') snapshot.blocker = 'agreement';
    if (mismatch === 'absent') snapshot.candidates = [];
    const before = await tree(), result = await run();
    expect(result.matchesCurrentRevision).toBe(false); expect(result.errors.length).toBeGreaterThan(0);
    expect(await tree()).toEqual(before);
  });
  it('rejects a manifest for another Work before observing', async () => {
    const {work} = await selected(); await writeFile(join(root, 'works/book/work.json'), JSON.stringify({...work, id: 'other'}));
    await expect(run()).rejects.toMatchObject({code: 'PUBLISHING_WORK_IDENTITY_CONFLICT'}); expect(observe).not.toHaveBeenCalled();
  });
  it('requires independent retained bytes, while accepting actual initial inline bytes', async () => {
    const {work, artifact} = await selected(), revision = artifact.revisions.find(item => item.id === artifact.currentRevisionId)!;
    delete revision.snapshotPath; delete revision.contentBase64;
    await writeFile(join(root, 'works/book/work.json'), JSON.stringify(work));
    await expect(run()).rejects.toMatchObject({code: 'ARTIFACT_SNAPSHOT_UNAVAILABLE'}); expect(observe).not.toHaveBeenCalled();
    revision.contentBase64 = Buffer.from(document).toString('base64');
    await writeFile(join(root, 'works/book/work.json'), JSON.stringify(work));
    expect((await run()).matchesCurrentRevision).toBe(true);
  });
  it.each(['same-path', 'symlink', 'hardlink'] as const)('rejects %s snapshot evidence that is the live file itself', async kind => {
    const {work, artifact} = await selected(), revision = artifact.revisions.find(item => item.id === artifact.currentRevisionId)!;
    if (kind === 'same-path') revision.snapshotPath = revision.path;
    else {
      revision.snapshotPath = 'retained-alias.md';
      await (kind === 'symlink' ? symlink : link)(join(root, path), join(root, 'works/book/retained-alias.md'));
    }
    await writeFile(join(root, 'works/book/work.json'), JSON.stringify(work));
    await writeFile(join(root, path), '# Chapter 1: Scene\n\nUnregistered body.');
    snapshot.candidates[0]!.content = 'Unregistered body.';
    await expect(run()).rejects.toMatchObject({code: 'ARTIFACT_SNAPSHOT_UNAVAILABLE'}); expect(observe).not.toHaveBeenCalled();
  });
  it('rejects unregistered live edits before observation', async () => {
    await writeFile(join(root, path), 'Unsynchronized edit');
    await expect(run()).rejects.toMatchObject({code: 'CHAPTER_REVISION_CHANGED'}); expect(observe).not.toHaveBeenCalled();
  });
  it('reads an accepted newer revision and rechecks after the remote observation', async () => {
    await syncWorkSourceArtifacts({projectRoot: root, workId: 'book', accept: true,
      writes: [{relativePath: path, content: '# Chapter 1: Scene\n\nNew retained body.'}]});
    snapshot.candidates[0]!.content = 'New retained body.';
    expect((await run()).matchesCurrentRevision).toBe(true);
    observe.mockImplementationOnce(async (_config, chapter, options) => {
      const value = await observeMegaNovelPreflight(browser, scope, chapter, options);
      await writeFile(join(root, path), 'Changed during observation'); return value;
    });
    await expect(run()).rejects.toMatchObject({code: 'CHAPTER_REVISION_CHANGED'});
  });
  it('preserves pending atomic transactions instead of recovering or deleting them', async () => {
    const txn = join(root, '.inkos-file-txn-fixture'); await mkdir(txn);
    await writeFile(join(txn, 'journal.json'), JSON.stringify({version: 1, pid: 0, phase: 'prepared', entries: []}));
    const before = await tree(); await expect(run()).rejects.toMatchObject({code: 'PUBLISHING_LOCAL_RECOVERY_REQUIRED'});
    expect(await tree()).toEqual(before); expect(observe).not.toHaveBeenCalled();
  });
  it('leaves existing submission_unknown records byte-identical over repeated observations', async () => {
    const store = new PublishingStore(join(root, '.inkos/harness.sqlite')), manual = new ManualPublishingAdapter(root, store);
    const target = await manual.mapBook({workId: 'book', platform: 'meganovel', accountLabel: scope.accountLabel, remoteBookId: scope.remoteBookId});
    const {artifact} = await selected();
    const pkg = await manual.prepare({targetId: target.id, formats: ['txt'], chapters: [{artifactId: artifact.id, revisionId: artifact.currentRevisionId!, number: 1, title: 'Scene'}]});
    await manual.beginSubmission({packageId: pkg.manifest.id, chapterNumber: 1, expectedVersion: 0, eventId: 'fixture-begin'});
    manual.recordReceipt({packageId: pkg.manifest.id, chapterNumber: 1, expectedVersion: 1, eventId: 'fixture-unknown',
      receipt: {status: 'submission_unknown', evidence: 'Synthetic lost receipt'}}); store.close();
    const before = await tree(); await run(); await run(); expect(await tree()).toEqual(before);
  });
  it('does not observe after cancellation or retry a failed observation', async () => {
    const controller = new AbortController(); controller.abort(new Error('stop'));
    await expect(runPublishingPreflight({projectRoot: root, configuration, chapterNumber: 1, signal: controller.signal}, registry)).rejects.toThrow('stop');
    expect(observe).not.toHaveBeenCalled(); observe.mockRejectedValueOnce(new Error('Provider failure'));
    await expect(run()).rejects.toThrow('Provider failure'); expect(observe).toHaveBeenCalledOnce();
  });
  it('rejects duplicate routing and keeps unselected providers untouched', async () => {
    await expect(runPublishingPreflight({projectRoot: root, chapterNumber: 1,
      configuration: {version: 1, bindings: [...configuration.bindings, ...configuration.bindings]}}, registry))
      .rejects.toMatchObject({code: 'PUBLISHING_BINDING_CONFLICT'}); expect(observe).not.toHaveBeenCalled();
    const other = vi.fn(async () => {throw new Error('Wrong provider');});
    registry.register({provider: 'other', parseConfiguration: input => input, observe: other});
    expect((await runPublishingPreflight({projectRoot: root, workId: 'book', chapterNumber: 1,
      configuration: {version: 1, bindings: [...configuration.bindings, {provider: 'other', workId: 'other-work', configuration: {}}]}}, registry)).matchesCurrentRevision).toBe(true);
    expect(other).not.toHaveBeenCalled();
  });
  it('supports only native MegaNovel by default and rejects fabricated observation intent', async () => {
    const defaults = createDefaultPublishingPreflightRegistry(); expect(defaults.list()).toEqual(['meganovel']);
    for (const provider of ['qidian', 'qimao', 'fanqie', 'goodnovel', 'dreame', 'manual']) {
      await expect(runPublishingPreflight({projectRoot: root, chapterNumber: 1, configuration: {version: 1,
        bindings: [{provider, workId: 'book', configuration: {}}]}}, defaults)).rejects.toMatchObject({code: 'PUBLISHING_PREFLIGHT_UNSUPPORTED'});
    }
    expect(() => MegaNovelSnapshotRequestSchema.parse({scope, chapterNumber: 1, packageId: 'fake', aiAssisted: true})).toThrow();
    expect(JSON.stringify(publishingPreflightFailure(Object.assign(new Error('secret'), {code: 'SECRET_TOKEN'})))).not.toMatch(/secret|SECRET_TOKEN/);
  });
  it.each(['success', 'failure', 'cancel'] as const)('closes the native transport without mutation on %s', async outcome => {
    const controller = new AbortController(), close = vi.fn(async () => {}), legacy = vi.fn(), mutation = vi.fn();
    if (outcome === 'failure') vi.mocked(browser.snapshot).mockRejectedValueOnce(new Error('private exception'));
    if (outcome === 'cancel') vi.mocked(browser.snapshot).mockImplementationOnce(async () => {controller.abort(); return snapshot;});
    const connect = vi.fn(async () => ({probe: browser.probe, observeSnapshot: browser.snapshot, snapshot: legacy, createDraft: mutation, submit: mutation, close}));
    vi.doMock('../publishing/meganovel-cdp.js', () => ({connectMegaNovelCdpPort: connect}));
    try {
      const native = {version: 1, bindings: [{provider: 'meganovel', workId: 'book', configuration: {
        scope, endpointURL: 'http://127.0.0.1:9222', lockDirectory: join(root, 'browser-locks'),
        authorization: {automation: {provenance: 'user_reported', reference: 'Synthetic permission'},
          aiAssistedContent: {provenance: 'user_reported', reference: 'Synthetic declaration'}}}}]};
      const before = await tree(), result = runPublishingPreflight({projectRoot: root, configuration: native, chapterNumber: 1, signal: controller.signal});
      if (outcome === 'success') expect((await result).matchesCurrentRevision).toBe(true); else await expect(result).rejects.toThrow();
      expect(connect).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce(); expect(legacy).not.toHaveBeenCalled(); expect(mutation).not.toHaveBeenCalled();
      expect(await tree()).toEqual(before);
    } finally {vi.doUnmock('../publishing/meganovel-cdp.js');}
  });
});
