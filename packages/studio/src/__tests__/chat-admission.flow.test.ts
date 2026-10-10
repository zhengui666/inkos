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

it('retains the retry baseline and attachment submission after a rejected admission and server recreation', () => project(async root => {
  const fixture = new CodexFixture(() => ({ error: 'deterministic failure' }));
  createCodexClient.mockImplementation(fixture.createClient);
  const app = createStudioServer({} as never, root), store = new ChatRequestStore(root);
  const { session } = await (await app.request('/api/v1/sessions', post({ sessionKind: 'chat' }))).json();
  const instruction = 'Summarize the attached note.';
  const attachments = [{ id: 'note', filename: 'note.txt', mediaType: 'text/plain', size: 5, dataUrl: 'data:text/plain;base64,aGVsbG8=' }];
  const input = { sessionId: session.sessionId, instruction, sessionKind: 'chat', attachments,
    requestedSkills: [], disabledSkills: ['inkos-story-review'] };
  expect((await app.request('/api/v1/agent', post({ ...input, clientRequestId: 'first' }))).status).toBeGreaterThanOrEqual(400);
  const failed = await store.load(session.sessionId);
  expect(failed).toMatchObject({ requestId: 'first', status: 'failed', baselineWork: null,
    retry: { text: instruction, options: { retryOfRequestId: 'first', attachments, disabledSkills: input.disabledSkills } } });

  const restarted = createStudioServer({} as never, root);
  const mismatch = await restarted.request('/api/v1/agent', post({ ...input, instruction: 'A different instruction',
    clientRequestId: 'rejected', retryOfRequestId: 'first' }));
  expect(mismatch.status).toBe(409);
  expect((await mismatch.json()).error.code).toBe('CHAT_RETRY_CONFLICT');
  expect(await store.load(session.sessionId)).toEqual(failed);
  expect(fixture.requests.filter(x => x.method === 'turn/start')).toHaveLength(1);

  const retry = await restarted.request('/api/v1/agent', post({ ...input, clientRequestId: 'retry', retryOfRequestId: 'first' }));
  expect(retry.status).toBeGreaterThanOrEqual(400);
  expect(await store.load(session.sessionId)).toMatchObject({ requestId: 'retry', status: 'failed', baselineWork: null,
    retry: { text: instruction, options: { retryOfRequestId: 'retry', attachments, disabledSkills: input.disabledSkills } } });
  expect(fixture.requests.filter(x => x.method === 'turn/start')).toHaveLength(2);

  const duplicate = await restarted.request('/api/v1/agent', post({ ...input, clientRequestId: 'retry' }));
  expect(duplicate.status).toBe(409);
  expect((await duplicate.json()).error.code).toBe('CHAT_REQUEST_ID_REUSED');
  expect((await store.load(session.sessionId))?.requestId).toBe('retry');
  expect(fixture.requests.filter(x => x.method === 'turn/start')).toHaveLength(2);
}));

it('rejects a legacy retry without a baseline and releases admission for a fresh instruction', () => project(async root => {
  const fixture = new CodexFixture(() => ({ error: 'deterministic failure' }));
  createCodexClient.mockImplementation(fixture.createClient);
  const app = createStudioServer({} as never, root), store = new ChatRequestStore(root);
  const { session } = await (await app.request('/api/v1/sessions', post({ sessionKind: 'chat' }))).json();
  const instruction = 'Inspect the saved note.';
  await store.save({ sessionId: session.sessionId, requestId: 'legacy-failed', startedAt: 1, completedAt: 2, status: 'failed',
    error: { code: 'AGENT_LLM_ERROR', message: 'Legacy failure' }, retry: { text: instruction, options: {} } });
  const failed = await store.load(session.sessionId);
  const retry = await app.request('/api/v1/agent', post({ sessionId: session.sessionId, instruction,
    clientRequestId: 'missing-baseline', retryOfRequestId: 'legacy-failed' }));
  expect(retry.status).toBe(409);
  expect((await retry.json()).error.code).toBe('CHAT_RETRY_BASELINE_UNAVAILABLE');
  expect(await store.load(session.sessionId)).toEqual(failed);
  expect(fixture.requests.filter(x => x.method === 'turn/start')).toHaveLength(0);

  const fresh = await app.request('/api/v1/agent', post({ sessionId: session.sessionId, instruction, clientRequestId: 'fresh' }));
  expect(fresh.status).toBeGreaterThanOrEqual(400);
  expect(await store.load(session.sessionId)).toMatchObject({ requestId: 'fresh', status: 'failed', baselineWork: null });
  expect(fixture.requests.filter(x => x.method === 'turn/start')).toHaveLength(1);
}));

it('prevents model work when abort arrives before the first durable admission', () => project(async root => {
  const fixture = new CodexFixture(() => ({ error: 'Model work must not start' }));
  createCodexClient.mockImplementation(fixture.createClient);
  const app = createStudioServer({} as never, root), store = new ChatRequestStore(root);
  const { session } = await (await app.request('/api/v1/sessions', post({ sessionKind: 'chat' }))).json();
  let entered!: () => void, release!: () => void;
  const admissionStarted = new Promise<void>(resolve => { entered = resolve; });
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const admit = ChatRequestStore.prototype.admit;
  // Delay entry only; admission still runs the real store and ownership locks.
  const delayed = vi.spyOn(ChatRequestStore.prototype, 'admit').mockImplementation(async function (this: ChatRequestStore, snapshot, validate) {
    entered();
    await barrier;
    return admit.call(this, snapshot, validate);
  });
  const request = app.request('/api/v1/agent', post({ sessionId: session.sessionId, instruction: 'Inspect', clientRequestId: 'stopped' }));
  try {
    await admissionStarted;
    expect(await store.load(session.sessionId)).toBeNull();
    const stopped = await app.request(`/api/v1/sessions/${session.sessionId}/abort?scope=chat`, { method: 'POST' });
    expect(await stopped.json()).toMatchObject({ ok: true, aborted: true });
    release();
    await request;
    expect(await store.load(session.sessionId)).toMatchObject({ requestId: 'stopped', status: 'cancelled' });
    expect((await store.load(session.sessionId))?.retry).toBeUndefined();
    expect(fixture.requests.filter(x => x.method === 'turn/start')).toHaveLength(0);

    delayed.mockRestore();
    const fresh = await app.request('/api/v1/agent', post({ sessionId: session.sessionId, instruction: 'Inspect', clientRequestId: 'after-stop' }));
    expect(fresh.status).toBeGreaterThanOrEqual(400);
    expect((await store.load(session.sessionId))?.requestId).toBe('after-stop');
    expect(fixture.requests.filter(x => x.method === 'turn/start')).toHaveLength(1);
  } finally { release(); await request; }
}));
