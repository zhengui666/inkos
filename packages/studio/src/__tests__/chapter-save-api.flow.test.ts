import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commitAtomicFileSet, createInitialWorkManifestWrite, syncWorkSourceArtifacts, loadWorkManifest, StateManager,
  type CodexAccountService, type ProjectConfig } from '@actalk/inkos-core';
import { createStudioServer } from '../api/server.js';

let root: string;
let app: ReturnType<typeof createStudioServer>;
const stamp = '2026-01-01T00:00:00.000Z';
const original = '# Chapter 1: First\n\nWait here.\n';
const route = '/api/v1/books/book/chapters/1';
const put = (body: unknown) => app.request(route, {method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'inkos-chapter-save-api-'));
  const book = {id: 'book', title: 'Fixture', platform: 'other', genre: 'other', status: 'active', targetChapters: 24,
    chapterWordCount: 2000, language: 'en', createdAt: stamp, updatedAt: stamp};
  const index = [{number: 1, title: 'First', wordCount: 2, createdAt: stamp, updatedAt: stamp, provenance: 'generated', observations: []}];
  const writes = [
    {relativePath: 'works/book/source/book.json', content: JSON.stringify(book)},
    {relativePath: 'works/book/source/chapters/0001_First.md', content: original},
    {relativePath: 'works/book/source/chapters/index.json', content: JSON.stringify(index)},
    {relativePath: 'works/book/source/story/state/manifest.json', content: '{"lastAppliedChapter":1}'},
  ];
  const initial = createInitialWorkManifestWrite({workId: 'book', title: 'Fixture', profileId: 'long-form', language: 'en', writes});
  await commitAtomicFileSet({rootDir: root, writes: [...writes, initial.write]});
  await syncWorkSourceArtifacts({projectRoot: root, workId: 'book', accept: true});
  const account = new Proxy({}, {get: () => () => { throw new Error('Account/model access is forbidden in chapter-save tests.'); }}) as CodexAccountService;
  app = createStudioServer({language: 'en'} as ProjectConfig, root, {codexAccountService: account});
});
afterEach(async () => { await rm(root, {recursive: true, force: true}); });

describe('chapter GET/PUT optimistic revision contract', () => {
  it('returns a read revision and a new committed revision with the correct English count', async () => {
    const opened = await (await app.request(route)).json();
    const registered = (await loadWorkManifest(root, 'book')).artifacts.find(artifact =>
      artifact.revisions.some(revision => revision.id === artifact.currentRevisionId && revision.path === 'source/chapters/0001_First.md'))!;
    expect(opened.revisionId).toBe(registered.currentRevisionId);
    expect(typeof opened.revisionId).toBe('string');
    expect(opened.revisionId.length).toBeGreaterThan(0);
    const response = await put({content: '# Chapter 1: First\n\nWait outside now.', expectedRevisionId: opened.revisionId});
    expect(response.status).toBe(200);
    const saved = await response.json();
    expect(saved.result).toMatchObject({wordCount: 3, stateNeedsSync: true, previousRevisionId: opened.revisionId});
    const current = await (await app.request(route)).json();
    expect(current.revisionId).toBe(saved.result.revisionId);
    expect(current.stateNeedsSync).toBe(true);
    expect(current.content).toBe('# Chapter 1: First\n\nWait outside now.\n');
    expect(await readFile(join(root, 'works/book/source/story/state/manifest.json'), 'utf8')).toBe('{"lastAppliedChapter":1}');
  });

  it('accepts the older content-only payload', async () => {
    const response = await put({content: 'One two three.'});
    expect(response.status).toBe(200);
    expect((await response.json()).result.wordCount).toBe(3);
  });

  it('keeps reads available under the native book lock and prevents concurrent stale saves', async () => {
    const release = await new StateManager(root).acquireBookLock('book');
    try {
      const readable = await app.request(route);
      expect(readable.status).toBe(200);
      expect((await readable.json()).content).toBe(original);
      const busy = await put({content: 'Must not save while busy.'});
      expect(busy.status).toBe(409);
      expect((await busy.json()).code).toBe('BOOK_BUSY');
    } finally { await release(); }
    const opened = await (await app.request(route)).json();
    const responses = await Promise.all([
      put({content: 'One changed chapter.', expectedRevisionId: opened.revisionId}),
      put({content: 'Another changed chapter.', expectedRevisionId: opened.revisionId}),
    ]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
    const conflict = responses.find(response => response.status === 409)!;
    expect(['BOOK_BUSY', 'ARTIFACT_REVISION_CONFLICT']).toContain((await conflict.json()).code);
    const before = await readFile(join(root, 'works/book/source/chapters/0001_First.md'), 'utf8');
    const stale = await put({content: 'Old opened revision must not replace the winner.', expectedRevisionId: opened.revisionId});
    expect(stale.status).toBe(409);
    expect((await stale.json()).code).toBe('ARTIFACT_REVISION_CONFLICT');
    expect(await readFile(join(root, 'works/book/source/chapters/0001_First.md'), 'utf8')).toBe(before);
  });

  it('uses exact opened text even when a legacy revision is unavailable', async () => {
    const opened = await (await app.request(route)).json();
    const first = await put({content: 'First saved text.', expectedContent: opened.content});
    expect(first.status).toBe(200);
    const stale = await put({content: 'Do not overwrite first.', expectedContent: opened.content});
    expect(stale.status).toBe(409);
    expect((await stale.json()).code).toBe('ARTIFACT_REVISION_CONFLICT');
    expect((await (await app.request(route)).json()).content).toBe('First saved text.\n');
  });

  it('rejects invalid payloads before writing', async () => {
    for (const body of [{content: 3}, {content: 'Text', expectedRevisionId: ''}, {content: 'Text', expectedRevisionId: null}, {content: 'Text', expectedContent: 7}]) {
      expect((await put(body)).status).toBe(400);
    }
    for (const number of ['0', '1extra', '1.5']) {
      const response = await app.request(`/api/v1/books/book/chapters/${number}`, {
        method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({content: 'Text'}),
      });
      expect(response.status).toBe(400);
    }
    expect(await readFile(join(root, 'works/book/source/chapters/0001_First.md'), 'utf8')).toBe(original);
    // Direct opened-text comparison permits intentional edits after an external edit without losing a later change.
    await writeFile(join(root, 'works/book/source/chapters/0001_First.md'), original + 'External change.');
    const mismatched = await (await app.request(route)).json();
    expect(mismatched.content).toContain('External change.');
    expect(typeof mismatched.revisionId).toBe("string");
    expect(mismatched.stateNeedsSync).toBe(true);
  });
});
