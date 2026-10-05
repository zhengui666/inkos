import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeEditTransaction, readChapterEditRevision, type EditExecutionDeps } from '../interaction/edit-controller.js';
import { mergeChapterReviewObservations, type ChapterMeta } from '../models/chapter.js';
import { createInitialWorkManifestWrite, syncWorkSourceArtifacts } from '../harness/source-sync.js';
import { loadWorkManifest } from '../harness/work-store.js';
import { commitAtomicFileSet } from '../utils/atomic-file-set.js';
import { listChapterVersions } from '../state/chapter-workspace.js';
import { chapterGoalInput, createChapterGoalAdapter } from '../goals/chapters.js';
import { GoalStore } from '../goals/store.js';
import { PipelineRunner } from '../pipeline/runner.js';

let root: string, source: string, deps: EditExecutionDeps, originalRevision: string;
const filename = '0001_First.md';
const original = '# Chapter 1: First\n\nWait here.\n';
const canonical = '{"lastAppliedChapter":1,"sentinel":"verified-before-edit"}\n';
const stamp = '2026-01-01T00:00:00.000Z';
const index = (): ChapterMeta[] => [{number: 1, title: 'First', wordCount: 2, createdAt: stamp, updatedAt: stamp,
  provenance: 'generated', observations: [{code: 'KEEP_REVIEW', summary: 'Keep this review.', evidence: []}]}];
const readIndex = async (): Promise<ChapterMeta[]> => JSON.parse(await readFile(join(source, 'chapters/index.json'), 'utf8'));
async function inventory(directory: string): Promise<Record<string, Buffer>> {
  const result: Record<string, Buffer> = {};
  const walk = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, {withFileTypes: true})) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await walk(child);
      else result[relative(directory, child)] = await readFile(child);
    }
  };
  await walk(directory); return result;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'inkos-chapter-save-'));
  source = join(root, 'works/book/source');
  const files = {
    [`chapters/${filename}`]: original,
    'chapters/index.json': JSON.stringify(index()),
    'book.json': JSON.stringify({language: 'en'}),
    'story/state/manifest.json': canonical,
    'story/snapshots/1/state/manifest.json': canonical,
    'story/runtime/chapter-0001.context.json': '{}',
    'story/runtime/chapter-0001.state-replay.json': '{"oldReceipt":true}',
    'story/runtime/chapter-0001.user-brief.md': 'Keep the author brief.',
  };
  const writes = Object.entries(files).map(([path, content]) => ({relativePath: `works/book/source/${path}`, content}));
  const initial = createInitialWorkManifestWrite({workId: 'book', title: 'Fixture', profileId: 'long-form', language: 'en', writes});
  await commitAtomicFileSet({rootDir: root, writes: [...writes, initial.write]});
  await syncWorkSourceArtifacts({projectRoot: root, workId: 'book', accept: true});
  originalRevision = (await readChapterEditRevision(root, 'book', filename))!.revisionId;
  deps = {projectRoot: root, bookDir: () => source, loadChapterIndex: readIndex,
    saveChapterIndex: async (_id, value) => { await writeFile(join(source, 'chapters/index.json'), JSON.stringify(value)); }};
});
afterEach(async () => { await rm(root, {recursive: true, force: true}); });
const replace = (content: string, expectedRevisionId?: string) => executeEditTransaction(deps,
  {kind: 'chapter-replace', bookId: 'book', chapterNumber: 1, fullText: content, expectedRevisionId, versionSource: 'manual'});

describe('native manual chapter save', () => {
  it('counts English prose, preserves history and canonical state, and marks only derived state unverified', async () => {
    const result = await replace('# Chapter 1: First\n\nWait outside now.', originalRevision);
    expect(result).toMatchObject({wordCount: 3, stateNeedsSync: true, previousRevisionId: originalRevision});
    expect(result.revisionId).not.toBe(originalRevision);
    const saved = await readFile(join(source, 'chapters', filename), 'utf8');
    expect(saved).toBe('# Chapter 1: First\n\nWait outside now.\n');
    const meta = (await readIndex())[0]!;
    expect(meta).toMatchObject({number: 1, title: 'First', wordCount: 3, createdAt: stamp, provenance: 'edited'});
    expect(meta.observations.map(value => value.code)).toEqual(['KEEP_REVIEW', 'manual-edit-review', 'state-sync-required']);
    expect(await readFile(join(source, 'story/state/manifest.json'), 'utf8')).toBe(canonical);
    expect(await readFile(join(source, 'story/snapshots/1/state/manifest.json'), 'utf8')).toBe(canonical);
    expect(await readFile(join(source, 'story/runtime/chapter-0001.user-brief.md'), 'utf8')).toBe('Keep the author brief.');
    await expect(readFile(join(source, 'story/runtime/chapter-0001.context.json'))).rejects.toMatchObject({code: 'ENOENT'});
    await expect(readFile(join(source, 'story/runtime/chapter-0001.state-replay.json'))).rejects.toMatchObject({code: 'ENOENT'});
    expect(await listChapterVersions(source, 1)).toHaveLength(1);
    const work = await loadWorkManifest(root, 'book');
    const artifact = work.artifacts.find(value => value.revisions.some(rev => rev.id === originalRevision))!;
    const previous = artifact.revisions.find(value => value.id === originalRevision)!;
    expect(await readFile(join(root, 'works/book', previous.snapshotPath!), 'utf8')).toBe(original);
    const current = artifact.revisions.find(value => value.id === result.revisionId)!;
    expect(await readFile(join(root, 'works/book', current.snapshotPath!), 'utf8')).toBe(saved);
  });

  it('rejects an obsolete revision before any archive, deletion or source write', async () => {
    const before = await inventory(join(root, 'works/book'));
    await expect(replace('A different chapter.', 'rev-obsolete')).rejects.toMatchObject({code: 'ARTIFACT_REVISION_CONFLICT'});
    expect(await inventory(join(root, 'works/book'))).toEqual(before);
  });

  it('rejects source drift even if the manifest revision id is still the same', async () => {
    await writeFile(join(source, 'chapters', filename), original + 'Unregistered disk edit.\n');
    const before = await inventory(join(root, 'works/book'));
    await expect(replace('Another edit.', originalRevision)).rejects.toMatchObject({code: 'ARTIFACT_REVISION_CONFLICT'});
    expect(await inventory(join(root, 'works/book'))).toEqual(before);
  });

  it('keeps the content-only request compatible', async () => {
    expect(await replace('# Chapter 1: First\n\nOne two three four.')).toMatchObject({wordCount: 4, stateNeedsSync: true});
  });

  it('uses the configured Chinese counting mode and excludes headings', async () => {
    deps = {...deps, loadBookLanguage: async () => 'zh'};
    expect(await replace('# 第1章 初见\n\n他抬头看天。', originalRevision)).toMatchObject({wordCount: 6});
  });

  it('does not accumulate the pending-state marker across successive edits', async () => {
    const first = await replace('One two three.', originalRevision);
    await replace('One two three four.', first.revisionId);
    expect((await readIndex())[0]!.observations.filter(value => value.code === 'state-sync-required')).toHaveLength(1);
  });

  it('keeps pending state after a later quality review replaces its observations', async () => {
    await replace('One two three.', originalRevision);
    const reviewed = (await readIndex()).map(chapter => ({...chapter,
      observations: mergeChapterReviewObservations(chapter.observations, [{code: 'NEW_REVIEW', summary: 'Reviewed prose.', evidence: []}]),
    }));
    await deps.saveChapterIndex('book', reviewed);
    expect(reviewed[0]!.observations.map(value => value.code)).toEqual(['state-sync-required', 'NEW_REVIEW']);
    expect(await readFile(join(source, 'story/state/manifest.json'), 'utf8')).toBe(canonical);
  });

  it('prevents a persistent goal from treating edited prose as settled without starting a writer', async () => {
    await replace('One two three.', originalRevision);
    const writer = vi.fn();
    const adapter = createChapterGoalAdapter({projectRoot: root, pipeline: {
      writeChapters: writer, runWithAbortSignal: async (_signal, task) => task(),
    }});
    const store = new GoalStore(join(root, '.inkos/goal-test.sqlite'));
    try {
      const goal = store.create(chapterGoalInput({id: 'test-next', workId: 'book', intent: 'Fixture only',
        startChapter: 1, endChapter: 1, expiresAt: Date.now() + 60000, maxAttemptsPerChapter: 1}));
      const result = await adapter.reconcile({goal, step: goal.steps[0]!, signal: new AbortController().signal});
      expect(result).toMatchObject({status: 'unknown', error: {code: 'CHAPTER_STATE_SYNC_REQUIRED'}});
      expect(writer).not.toHaveBeenCalled();
      expect(store.get(goal.id)).toEqual(goal);
    } finally { store.close(); }
  });

  it('reports the needed state-recovery range without starting unrequested model work', async () => {
    await replace('One two three.', originalRevision);
    const methods = PipelineRunner.prototype as unknown as {
      reconcileEditedChaptersForWrite(id: string): Promise<void>;
    };
    await expect(methods.reconcileEditedChaptersForWrite.call({
      state: { loadChapterIndex: readIndex }, operationContext: { getStore: () => undefined }, currentAbortSignal: () => undefined,
    }, 'book')).rejects.toMatchObject({code: 'CHAPTER_STATE_RECOVERY_REQUIRED', requiredRange: {startChapter: 1, endChapter: 1}});
  });
});
