import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexFixture } from '../../../core/src/__tests__/codex-fixture.js';
const createCodexClient = vi.hoisted(() => vi.fn());
vi.mock('../../../core/src/codex/client.js', () => ({ createCodexClient }));
import { createStudioServer } from '../api/server.js';
import { ChatRequestStore } from '../api/chat-request-store.js';
const post = (body: unknown) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
afterEach(() => vi.restoreAllMocks());

async function project(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'inkos-chat-admission-'));
  try {
    await mkdir(join(root, '.inkos'));
    await writeFile(join(root, 'inkos.json'), JSON.stringify({ name: 'fixture', version: '0.1.0', language: 'en' }));
    await run(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

it('uses durable ownership instead of a previous local terminal cache for GET and admission', () => project(async root => {
  const fixture = new CodexFixture(() => ({ error: 'deterministic failure' }));
  createCodexClient.mockImplementation(fixture.createClient);
  const app = createStudioServer({} as never, root), store = new ChatRequestStore(root), owner = store.createOwner();
  try {
    const { session } = await (await app.request('/api/v1/sessions', post({ sessionKind: 'chat' }))).json();
    const input = { sessionId: session.sessionId, instruction: 'Inspect' };
    expect((await app.request('/api/v1/agent', post({ ...input, clientRequestId: 'first' }))).status).toBeGreaterThanOrEqual(400);
    await store.save({ sessionId: session.sessionId, requestId: 'foreign-running', startedAt: Date.now(), status: 'running', owner });
    const detail = await (await app.request(`/api/v1/sessions/${session.sessionId}`)).json();
    expect(detail.chatRequest).toMatchObject({ requestId: 'foreign-running', status: 'running' });
    const second = await app.request('/api/v1/agent', post({ ...input, clientRequestId: 'second' }));
    expect(second.status).toBe(409);
    expect((await second.json()).error.code).toBe('CHAT_REQUEST_ALREADY_RUNNING');
    expect((await store.load(session.sessionId))?.requestId).toBe('foreign-running');
    expect(fixture.requests.filter(x => x.method === 'turn/start')).toHaveLength(1);
  } finally { store.releaseOwner(owner); }
}));

it('allows only one concurrent cold-server admission before any model work', () => project(async root => {
  const fixture = new CodexFixture(() => ({ hold: true }));
  createCodexClient.mockImplementation(fixture.createClient);
  const first = createStudioServer({} as never, root), second = createStudioServer({} as never, root);
  const { session } = await (await first.request('/api/v1/sessions', post({ sessionKind: 'chat' }))).json();
  const input = { sessionId: session.sessionId, instruction: 'Inspect' };
  const firstRequest = first.request('/api/v1/agent', post({ ...input, clientRequestId: 'first' }));
  const secondRequest = second.request('/api/v1/agent', post({ ...input, clientRequestId: 'second' }));
  const rejected = await Promise.race([firstRequest, secondRequest]);
  expect(rejected.status).toBe(409);
  const saved = await new ChatRequestStore(root).load(session.sessionId);
  expect(saved?.status).toBe('running');
  // Stop only the admitted owner; no real model or artifact mutation is involved.
  const owner = saved?.requestId === 'first' ? first : second;
  await owner.request(`/api/v1/sessions/${session.sessionId}/abort`, { method: 'POST' });
  await Promise.all([firstRequest, secondRequest]);
  expect(fixture.requests.filter(x => x.method === 'turn/start').length).toBeLessThanOrEqual(1);
  expect((await new ChatRequestStore(root).load(session.sessionId))?.requestId).toBe(saved?.requestId);
}));
