import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RemoteWorkStore } from '@actalk/inkos-core';
import { registerCreationTaskRoutes } from './creation-tasks.js';
const roots: string[] = []; const handles: ReturnType<typeof registerCreationTaskRoutes>[] = [];
afterEach(async () => { handles.splice(0).forEach(handle => handle.close()); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const config = { language: 'zh', daemon: { market: { platform: 'meganovel', language: 'en' } } } as any;
async function setup(root?: string, projectConfig = config) {
  if (!root) { root = await mkdtemp(join(tmpdir(), 'inkos-creation-api-')); roots.push(root); }
  const app = new Hono(), start = vi.fn().mockResolvedValue(undefined);
  const handle = registerCreationTaskRoutes(app, { root, loadConfig: async () => projectConfig, start, status: () => ({ running: false }) });
  handles.push(handle); return { app, start, handle, root };
}
const json = (body: unknown) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
describe('creation task API', () => {
  it.each([undefined, 'a-configured-path-that-has-not-been-verified.json'])
  ('discloses built-in publication limits without treating a configuration path as readiness (%s)', async publisherConfig => {
    const f = await setup(undefined, {...config, daemon: {...config.daemon, publisherConfig}});
    const board = await (await f.app.request('/api/v1/creation-tasks')).json();
    expect(board.publication).toMatchObject({
      configured: Boolean(publisherConfig), configurationStatus: publisherConfig ? 'path_provided' : 'missing',
      automaticChapterProviders: ['meganovel'], remoteBookCreation: false, remoteBookCreationProtocol: true,
      emptyBookFirstChapter: false, requiresExistingRemoteBook: true,
    });
    expect(f.start).not.toHaveBeenCalled();
    expect(board.tasks).toEqual([]);
  });

  it('accepts only two creative inputs and converges repeated concurrent submissions', async () => {
    const f = await setup(); const input = { id: randomUUID(), kind: 'short', brief: 'A detective receives a letter from her future self.' };
    const responses = await Promise.all([f.app.request('/api/v1/creation-tasks', json(input)), f.app.request('/api/v1/creation-tasks', json(input))]);
    expect(responses.map(res => res.status)).toEqual([201, 201]);
    const board = await (await f.app.request('/api/v1/creation-tasks')).json();
    expect(board.tasks).toHaveLength(1); expect(board.tasks[0].plan).toMatchObject({ language: 'en', targetChapters: 1 });
    expect(board.publication.remoteBookCreation).toBe(false);
  });
  it('restores exactly the same task on server restart and leaves paused work paused', async () => {
    const f = await setup(); const input = { id: randomUUID(), kind: 'long', brief: 'A city loses its memories one street at a time.' };
    const { task } = await (await f.app.request('/api/v1/creation-tasks', json(input))).json();
    await f.app.request(`/api/v1/creation-tasks/${task.id}/pause`, json({ version: task.version }));
    f.handle.close(); handles.splice(handles.indexOf(f.handle), 1);
    const restarted = await setup(f.root); await restarted.handle.recover();
    expect(restarted.start).not.toHaveBeenCalled();
    const board = await (await restarted.app.request('/api/v1/creation-tasks')).json();
    expect(board.tasks[0]).toMatchObject({ id: task.id, workId: task.workId, status: 'paused' });
  });
  it('retains intake even if runtime startup fails, with an honest blocker', async () => {
    const f = await setup(); f.start.mockRejectedValue(new Error('Model account must be configured'));
    const response = await f.app.request('/api/v1/creation-tasks', json({ id: randomUUID(), kind: 'short', brief: 'An old lighthouse starts sending warnings from the future.' }));
    expect(response.status).toBe(201); expect((await response.json()).runtimeError).toContain('configured');
    expect((await (await f.app.request('/api/v1/creation-tasks')).json()).tasks).toHaveLength(1);
  });
  it('rejects stale pause and forbids user-supplied existing work IDs', async () => {
    const f = await setup(); const input = { id: randomUUID(), kind: 'short', brief: 'An apprentice attempts to repair a broken moon.' };
    expect((await f.app.request('/api/v1/creation-tasks', json({ ...input, workId: 'old-book' }))).status).toBe(400);
    const { task } = await (await f.app.request('/api/v1/creation-tasks', json(input))).json();
    expect((await f.app.request(`/api/v1/creation-tasks/${task.id}/pause`, json({ version: task.version }))).status).toBe(200);
    expect((await f.app.request(`/api/v1/creation-tasks/${task.id}/resume`, json({ version: task.version }))).status).toBe(409);
  });
  it('exposes remote-creation blockers without counting them as chapter publication', async () => {
    const f = await setup();
    const { task } = await (await f.app.request('/api/v1/creation-tasks', json({id: randomUUID(), kind: 'short', brief: 'An isolated fixture about a debt and a locksmith.'}))).json();
    const store = new RemoteWorkStore(join(f.root, '.inkos/harness.sqlite'));
    try {
      const run = store.reserve({workId: task.workId, destination: {provider: 'meganovel', platform: 'meganovel', accountId: 'fixture-account', accountLabel: 'fixture', sessionId: 'fixture-session'},
        metadata: {title: 'Fixture', blurb: 'An original test story.', genre: 'fantasy', language: 'en', aiAssisted: true}});
      store.setBlocker(run.id, run.version, {status: 'unsupported', code: 'REMOTE_WORK_UNSUPPORTED', message: 'No verified new-book adapter is installed.'});
    } finally { store.close(); }
    const board = await (await f.app.request('/api/v1/creation-tasks')).json();
    expect(board.tasks[0].remoteWork).toMatchObject({phase: 'ready', status: 'unsupported', attempts: 0, receipt: null});
    expect(board.tasks[0].publishedChapters).toBe(0);
    expect(board.publication.remoteBookCreation).toBe(false);
    expect(board.publication.remoteBookCreationProtocol).toBe(true);
  });

});
