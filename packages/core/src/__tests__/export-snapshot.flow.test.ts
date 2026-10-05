import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const interleave = vi.hoisted(() => ({
  readPath: '', afterRead: undefined as undefined | (() => Promise<void>),
  writePath: '', beforeWrite: undefined as undefined | (() => Promise<void>),
}));
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return {...fs,
    readFile: async (...args: Parameters<typeof fs.readFile>) => {
      const bytes = await fs.readFile(...args);
      if (String(args[0]) === interleave.readPath && interleave.afterRead) {
        const action = interleave.afterRead; interleave.afterRead = undefined; await action();
      }
      return bytes;
    },
    writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
      if (String(args[0]) === interleave.writePath && interleave.beforeWrite) {
        const action = interleave.beforeWrite; interleave.beforeWrite = undefined; await action();
      }
      return fs.writeFile(...args);
    },
  };
});
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateManager } from '../state/manager.js';
import { createInitialWorkManifestWrite, syncWorkSourceArtifacts } from '../harness/source-sync.js';
import { commitAtomicFileSet } from '../utils/atomic-file-set.js';
import { withWorkMutationScope } from '../utils/work-mutation-scope.js';
import { buildExportArtifact, writeExportArtifact } from '../interaction/export-artifact.js';

let root: string;
let state: StateManager;
const path = (number: number) => `works/book/source/chapters/${String(number).padStart(4, '0')}_chapter.md`;
const bodies = (version: string) => [1, 2].map(number => ({relativePath: path(number),
  content: `# Chapter ${number}: Scene ${number}\r\n\r\nVERSION_${version}_CHAPTER_${number}.  \r\n`}));

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'inkos-export-snapshot-'));
  state = new StateManager(root);
  const now = '2026-10-05T00:00:00.000Z';
  const writes = [...bodies('A'),
    {relativePath: 'works/book/source/book.json', content: JSON.stringify({id: 'book', title: 'Snapshot fixture',
      language: 'en', platform: 'local', genre: 'general', status: 'active', targetChapters: 2,
      chapterWordCount: 100, createdAt: now, updatedAt: now})},
    {relativePath: 'works/book/source/chapters/index.json', content: JSON.stringify([1, 2].map(number => ({
      number, title: `Scene ${number}`, wordCount: 1, observations: [], provenance: 'generated',
      createdAt: now, updatedAt: now,
    })))},
  ];
  const initial = createInitialWorkManifestWrite({workId: 'book', title: 'Snapshot fixture', profileId: 'long-form', language: 'en', writes});
  await commitAtomicFileSet({rootDir: root, writes: [...writes, initial.write]});
});
afterEach(async () => {
  interleave.afterRead = undefined; interleave.beforeWrite = undefined;
  await rm(root, {recursive: true, force: true});
});
async function edit() {
  const release = await new StateManager(root).acquireBookLock('book');
  try { await syncWorkSourceArtifacts({projectRoot: root, workId: 'book', accept: true, writes: bodies('B')}); }
  finally { await release(); }
}

it.each(['txt', 'md'] as const)('keeps one version during %s export and permits an edit/retry afterward', async format => {
  interleave.readPath = join(root, path(1));
  interleave.afterRead = async () => { await expect(edit()).rejects.toMatchObject({code: 'BOOK_BUSY'}); };
  const first = await buildExportArtifact(state, 'book', {format});
  expect(first.payload).toContain('VERSION_A_CHAPTER_1.  \r\n');
  expect(first.payload).toContain('VERSION_A_CHAPTER_2.  \r\n');
  expect(first.payload).not.toContain('VERSION_B_');
  await edit();
  const second = await buildExportArtifact(state, 'book', {format});
  expect(second.payload).toContain('VERSION_B_CHAPTER_1');
  expect(second.payload).toContain('VERSION_B_CHAPTER_2');
  expect(second.payload).not.toContain('VERSION_A_');
  expect(second).toMatchObject({chaptersExported: 2, totalWords: 2, format});
});

it('keeps an existing delivery unchanged when a writer is active and releases ownership afterward', async () => {
  const outputPath = join(root, 'delivery.txt');
  await writeFile(outputPath, 'Existing delivery');
  const release = await state.acquireBookLock('book');
  try {
    await expect(writeExportArtifact(new StateManager(root), 'book', {format: 'txt', outputPath}))
      .rejects.toMatchObject({code: 'BOOK_BUSY'});
    expect(await readFile(outputPath, 'utf8')).toBe('Existing delivery');
  } finally { await release(); }
  await writeExportArtifact(state, 'book', {format: 'txt', outputPath});
  expect(await readFile(outputPath, 'utf8')).toContain('VERSION_A_CHAPTER_2');
});

it('releases the source lock before writing the export and keeps the captured document intact', async () => {
  const outputPath = join(root, 'delivery.txt');
  interleave.writePath = outputPath;
  interleave.beforeWrite = edit;
  await writeExportArtifact(state, 'book', {format: 'txt', outputPath});
  const delivery = await readFile(outputPath, 'utf8');
  expect(delivery).toContain('VERSION_A_CHAPTER_1'); expect(delivery).toContain('VERSION_A_CHAPTER_2');
  expect(delivery).not.toContain('VERSION_B_');
  expect(await readFile(join(root, path(2)), 'utf8')).toContain('VERSION_B_CHAPTER_2');
});

it('includes the latest unregistered prose instead of silently substituting an older manifest revision', async () => {
  await writeFile(join(root, path(2)), '# Chapter 2: Scene 2\n\nUnregistered author edit.\n');
  const exported = await buildExportArtifact(state, 'book', {format: 'txt'});
  expect(exported.payload).toContain('Unregistered author edit.');
  expect(exported.payload).not.toContain('VERSION_A_CHAPTER_2');
});

it('releases the lock on incomplete chapter sources and can export after repair', async () => {
  await rm(join(root, path(2)));
  await expect(buildExportArtifact(state, 'book', {format: 'txt'})).rejects.toMatchObject({code: 'CHAPTER_EXPORT_SOURCE_MISMATCH'});
  await edit();
  expect((await buildExportArtifact(state, 'book', {format: 'txt'})).chaptersExported).toBe(2);
});

it('reuses an existing capability mutation scope without reacquiring its writer lock', async () => {
  const result = await withWorkMutationScope(root, 'book', () => state.acquireBookLock('book'),
    () => buildExportArtifact(state, 'book', {format: 'txt'}));
  expect(result.payload).toContain('VERSION_A_CHAPTER_2');
  await edit();
});

it('does not create a missing Work directory while trying to export it', async () => {
  await expect(buildExportArtifact(state, 'missing', {format: 'txt'})).rejects.toMatchObject({code: 'ENOENT'});
  await expect(access(state.bookDir('missing'))).rejects.toMatchObject({code: 'ENOENT'});
});
