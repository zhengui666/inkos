import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StateManager } from '../state/manager.js';
import { createInitialRuntimeState, loadRuntimeStateSnapshot } from '../state/runtime-state-store.js';
import { prepareStateReplay, commitStateReplay, type StateReplayWorkers } from '../state/state-replay.js';
import { syncWorkSourceArtifacts } from '../harness/source-sync.js';
import { loadWorkManifest } from '../harness/work-store.js';
import { ManualPublishingAdapter, PublishingStore, type PublishingSelection } from '../publishing/index.js';

let root: string;
let state: StateManager;
let store: PublishingStore;
let adapter: ManualPublishingAdapter;
const originals = [1, 2].map(number => `# Chapter ${number}: Scene ${number}\r\n\r\nORIGINAL_${number} untouched prose.  \r\n`);
const sourcePath = (number: number) => `works/book/source/chapters/${String(number).padStart(4, '0')}_chapter.md`;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'inkos-publishing-replay-'));
  state = new StateManager(root);
  const now = '2026-10-05T00:00:00.000Z';
  await state.saveBookConfig('book', {id: 'book', title: 'Replay export fixture', platform: 'local',
    genre: 'general', status: 'active', targetChapters: 2, chapterWordCount: 100,
    language: 'en', createdAt: now, updatedAt: now});
  await createInitialRuntimeState({bookDir: state.bookDir('book'), language: 'en'});
  await state.snapshotState('book', 0);
  await state.saveChapterIndex('book', [1, 2].map(number => ({number, title: `Scene ${number}`,
    wordCount: 3, observations: [], provenance: 'generated', createdAt: now, updatedAt: now})));
  await syncWorkSourceArtifacts({projectRoot: root, workId: 'book', accept: true, writes: [
    ...originals.map((content, index) => ({relativePath: sourcePath(index + 1), content})),
    {relativePath: 'works/book/source/story/outline/story_frame.md', content: 'Preserve the recorded scenes.'},
    {relativePath: 'works/book/source/story/book_rules.md', content: 'Do not rewrite prose during state replay.'},
  ]});
  store = new PublishingStore(join(root, '.inkos/harness.sqlite'));
  adapter = new ManualPublishingAdapter(root, store);
});
afterEach(async () => { store.close(); await rm(root, {recursive: true, force: true}); });

async function selection(): Promise<PublishingSelection> {
  const work = await loadWorkManifest(root, 'book');
  return [1, 2].map(number => {
    const artifact = work.artifacts.find(item => item.revisions.some(revision => revision.id === item.currentRevisionId
      && revision.path === sourcePath(number).slice('works/book/'.length)))!;
    return {artifactId: artifact.id, revisionId: artifact.currentRevisionId!, number, title: `Scene ${number}`};
  });
}
async function prepare(chapters?: PublishingSelection) {
  const target = await adapter.mapBook({workId: 'book', platform: 'meganovel', accountLabel: 'same-author', remoteBookId: 'same-book'});
  return adapter.prepare({targetId: target.id, chapters: chapters ?? await selection(), formats: ['txt', 'md']});
}
const workers: StateReplayWorkers = {
  writer: {settleChapterState: async input => ({chapterNumber: input.chapterNumber, content: input.content,
    title: input.title, runtimeStateDelta: {chapter: input.chapterNumber,
      factOps: {upsert: [], expire: []}, hookOps: {upsert: [], mention: [], resolve: [], defer: []}, newHookCandidates: [],
      chapterSummary: {chapter: input.chapterNumber, title: input.title, characters: '',
        events: `Synthetic settled scene ${input.chapterNumber}`, stateChanges: '', hookActivity: '', mood: '', chapterType: 'scene'}},
    updatedState: '', updatedHooks: '', updatedChapterSummaries: '', wordCount: 3,
    runtimeStateApplied: true, runtimeStateSnapshot: await loadRuntimeStateSnapshot(input.bookDir),
    postSettlement: 'Synthetic settlement fixture'})},
  validator: {validate: async () => ({consistent: true, reconciliationRequired: false, observations: []})},
};

describe('receipt and replay export truthfulness', () => {
  it('cannot mark an export as published without an attempt and never treats a manual report as verification', async () => {
    const pkg = await prepare();
    const receipt = {status: 'published_reported' as const, remoteChapterId: 'synthetic-remote-chapter',
      evidence: 'Synthetic fixture; no upload or remote status check occurred.'};
    expect(() => adapter.recordReceipt({packageId: pkg.manifest.id, chapterNumber: 1,
      expectedVersion: 0, eventId: 'export-is-not-publication', receipt}))
      .toThrow('beginning of a manual submission');
    expect(store.getPackage(pkg.manifest.id)).toMatchObject({version: 0, remoteVerified: false,
      chapters: [{number: 1, status: 'awaiting_submission'}, {number: 2, status: 'awaiting_submission'}]});
    const attempt = {packageId: pkg.manifest.id, chapterNumber: 1, expectedVersion: 0, eventId: 'begin'};
    await adapter.beginSubmission(attempt);
    const recorded = adapter.recordReceipt({...attempt, expectedVersion: 1, eventId: 'reported', receipt});
    expect(recorded).toMatchObject({remoteVerified: false, chapters: [
      {number: 1, status: 'published_reported', provenance: 'user_reported'},
      {number: 2, status: 'awaiting_submission'},
    ]});
    expect(recorded.manifest.remoteVerified).toBe(false);
  });

  it('keeps exact frozen revisions while replay settles edited live chapters and rejects a stale replay retry', async () => {
    const selected = await selection();
    const frozen = await prepare(selected);
    const directory = (await adapter.verify(frozen.manifest.id)).directory;
    const frozenTxt = await readFile(join(directory, 'exports/book.txt'));
    const edits = originals.map(text => text.replace('ORIGINAL_', 'EDITED_'));
    await syncWorkSourceArtifacts({projectRoot: root, workId: 'book', accept: true,
      writes: edits.map((content, index) => ({relativePath: sourcePath(index + 1), content}))});
    const plan = await prepareStateReplay({projectRoot: root, bookId: 'book', baselineChapter: 0,
      createWorkers: () => workers});
    expect(plan.chapters.map(chapter => chapter.sourceText)).toEqual(edits);
    await commitStateReplay({projectRoot: root, plan, expectedPlanId: plan.id});
    for (const number of [1, 2]) expect(await readFile(join(root, sourcePath(number)), 'utf8')).toBe(edits[number - 1]);
    await expect(commitStateReplay({projectRoot: root, plan, expectedPlanId: plan.id}))
      .rejects.toMatchObject({code: 'STATE_REPLAY_VERSION_CHANGED'});
    for (const number of [1, 2]) expect(await readFile(join(root, sourcePath(number)), 'utf8')).toBe(edits[number - 1]);
    const oldAgain = await prepare(selected);
    expect(oldAgain.manifest.id).toBe(frozen.manifest.id);
    expect(await readFile(join(directory, 'exports/book.txt'))).toEqual(frozenTxt);
    for (const chapter of frozen.manifest.chapters) {
      expect(await readFile(join(directory, chapter.packagePath), 'utf8')).toBe(originals[chapter.number - 1]);
    }
    const edited = await prepare();
    const editedDir = (await adapter.verify(edited.manifest.id)).directory;
    expect(edited.manifest.id).not.toBe(frozen.manifest.id);
    const txt = await readFile(join(editedDir, 'exports/book.txt'), 'utf8');
    expect(txt).toContain('EDITED_1'); expect(txt).toContain('EDITED_2'); expect(txt).not.toContain('ORIGINAL_');
    expect(edited.chapters.every(chapter => chapter.status === 'awaiting_submission')).toBe(true);
    expect(edited.remoteVerified).toBe(false);
  });
});
