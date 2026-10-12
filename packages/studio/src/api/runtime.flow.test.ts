import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { RuntimeClient, startRuntimeService } from '@actalk/inkos-core';
import { startStudio } from './server.js';

describe('Studio against the real durable service', () => {
  let root: string;
  let runtime: Awaited<ReturnType<typeof startRuntimeService>>;
  let studio: Awaited<ReturnType<typeof startStudio>>;
  let client: RuntimeClient;
  async function api(method: string, params: object = {}) {
    const response = await fetch(`${studio.url}/api/v1/${method.split('.').join('/')}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params) });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error);
    return value;
  }
  beforeAll(async () => {
    root = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), 'inkos-studio-service-'));
    runtime = await startRuntimeService(root);
    studio = await startStudio(root, { port: 0 });
    client = await RuntimeClient.connect(root, { start: false });
  });
  afterAll(async () => { await studio?.close(); await runtime?.close(); if (root) await rm(root, { recursive: true, force: true }); });
  it('persists a platform-free ja work and immutable artifact revisions', async () => {
    const work = await api('works.create', { title: 'Offline manuscript', profile: 'article', locale: 'ja' });
    expect(work.locale).toBe('ja'); expect(work.targetIds).toEqual([]);
    const first = await api('artifacts.save', { workId: work.id, title: 'Letter', content: '日本語の原稿。', format: 'md' });
    const second = await api('artifacts.save', { workId: work.id, artifactId: first.artifactId, title: 'Letter revised', content: '日本語の改稿。', format: 'md' });
    expect(second.id).not.toBe(first.id);
    expect((await api('artifacts.read', { id: first.artifactId, revisionId: first.id })).content).toBe('日本語の原稿。');
    expect((await api('artifacts.read', { id: first.artifactId })).revision.id).toBe(second.id);
    const exported = await api('artifacts.export', { artifactId: first.artifactId, format: 'md' });
    expect(await readFile(resolve(root, exported.path), 'utf8')).toContain('日本語の改稿。');
    expect((await stat(join(root, '.inkos', 'durable.sqlite'))).size).toBeGreaterThan(0);
  });
  it('stores an offline note once through native submissions', async () => {
    const conversation = await api('conversations.create');
    const draft = { type: 'write', requestId: 'offline-note-once', entry: { kind: 'inkos.note', data: { text: 'No model required' } } };
    const receipt = await api('conversations.submit', { id: conversation.id, draft });
    await api('submissions.wait', { id: receipt.id });
    const again = await api('conversations.submit', { id: conversation.id, draft });
    expect(again.id).toBe(receipt.id);
    const view = await api('conversations.get', { id: conversation.id });
    expect(view.entries.filter((entry: any) => entry.kind === 'inkos.note')).toHaveLength(1);
  });
  it('disconnects SSE and closes Studio without stopping the same runtime', async () => {
    const before = await client.rpc('status');
    const controller = new AbortController();
    const response = await fetch(`${studio.url}/api/v1/events`, { signal: controller.signal });
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body!.getReader();
    const frame = await reader.read(); expect(new TextDecoder().decode(frame.value)).toContain('snapshot');
    controller.abort(); await reader.cancel().catch(() => {});
    await studio.close();
    expect((await client.rpc('status')).pid).toBe(before.pid);
    expect((await RuntimeClient.find(root))?.endpoint.pid).toBe(before.pid);
    studio = await startStudio(root, { port: 0 });
    expect((await api('status')).pid).toBe(before.pid);
  });
  it('rejects unknown routes rather than accepting arbitrary execution RPC', async () => {
    const response = await fetch(`${studio.url}/api/v1/runtime/stop`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(response.status).toBe(404);
    expect((await api('status')).rootDir).toBe(root);
  });
});
