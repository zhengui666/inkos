import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { runAgentSession, abortAgentSession } from '../agent/agent-session.js';
import { loadBookSession } from '../interaction/book-session-store.js';
import { readTranscriptEvents } from '../interaction/session-transcript.js';
import { listWorkManifests } from '../harness/work-store.js';
import type { Model } from '@mariozechner/pi-ai';
import { CodexFixture } from './codex-fixture.js';

const createClient = vi.hoisted(() => vi.fn());
vi.mock('../codex/client.js', () => ({ createCodexClient: createClient }));
const model: Model<'openai-responses'> = { id: 'fixture', name: 'Fixture', provider: 'openai', api: 'openai-responses',
  baseUrl: '', input: ['text'], reasoning: true, contextWindow: 128000, maxTokens: 8192,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const configuration = (root: string, sessionId: string) => ({ projectRoot: root, sessionId, bookId: null, workId: null,
  profileId: 'workspace-default', sessionKind: 'chat' as const, language: 'en' as const, model, pipeline: {} as never });

it('answers a question, rejects an unevidenced delivery, creates a Work and restores its explicit completion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inkos-turn-completion-'));
  const replies = [
    { name: 'finish_turn', args: { status: 'answered', message: 'A scene is a unit of dramatic action.' } },
    { name: 'finish_turn', args: { status: 'delivered', message: 'Created.' } },
    { name: 'workspace__create_work', args: { workId: 'gallery', profileId: 'script', title: 'Gallery', language: 'en', intent: 'Create an empty script Work.' } },
    { name: 'finish_turn', args: { status: 'delivered', message: 'The Gallery Work is ready.' } },
  ];
  const codex = new CodexFixture(({ step }) => {
    const reply = replies[step - 1];
    if (!reply) throw new Error('Unexpected additional Codex response');
    return { calls: [reply] };
  });
  createClient.mockImplementation(codex.createClient);
  const config = configuration(root, 'completion');
  try {
    const answer = await runAgentSession(config, 'Explain a scene in one sentence.');
    expect(answer.completion?.status).toBe('answered');
    expect(answer.errorMessage).toBeUndefined();
    expect(await listWorkManifests(root)).toHaveLength(0);
    expect((await loadBookSession(root, config.sessionId))?.messages.filter(m => m.role === 'assistant').map(m => m.content)).toEqual([answer.responseText]);
    const delivery = await runAgentSession(config, 'Create an empty script Work called Gallery.');
    expect(delivery).toMatchObject({ workId: 'gallery', profileId: 'script', completion: { status: 'delivered' } });
    expect(delivery.errorMessage).toBeUndefined();
    expect(await listWorkManifests(root)).toHaveLength(1);
    expect(codex.turns).toHaveLength(4);
    const threads = codex.requests.filter(request => request.method === 'thread/start');
    expect(threads.every(request => request.params.dynamicTools.some((tool: any) => tool.name === 'finish_turn'))).toBe(true);
    expect(threads.every(request => request.params.developerInstructions.includes('completion tool contract'))).toBe(true);
    expect(codex.toolResponses.map(result => result.response.success)).toEqual([true, false, true, true]);
    const events = await readTranscriptEvents(root, config.sessionId);
    const rejected = events.filter(e => e.type === 'message' && e.role === 'toolResult').map(e => e.type === 'message' ? e.message as any : null);
    expect(rejected.some(message => message.toolName === 'finish_turn' && message.isError === true)).toBe(true);
    const restored = await loadBookSession(root, config.sessionId);
    expect(restored?.messages.filter(m => m.role === 'assistant' && m.content).map(m => m.content)).toEqual([answer.responseText, delivery.responseText]);
    expect(restored?.messages.flatMap(m => m.toolExecutions ?? []).filter(t => t.tool === 'create_work')).toHaveLength(1);
  } finally {
    abortAgentSession(root, config.sessionId);
    await rm(root, { recursive: true, force: true });
  }
}, 20000);

it('keeps a nonterminal Codex response out of the completed answer after the bounded protocol retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inkos-missing-completion-'));
  const codex = new CodexFixture(() => ({ text: 'I will do the work.' }));
  createClient.mockImplementation(codex.createClient);
  try {
    const result = await runAgentSession(configuration(root, 'missing'), 'Create an empty script Work.');
    expect(codex.requests.filter(request => request.method === 'turn/start')).toHaveLength(2);
    expect(result.errorMessage).toBeTruthy();
    expect(result.responseText).toBe('');
    expect(result.completion).toBeUndefined();
    expect((await readTranscriptEvents(root, 'missing')).at(-1)?.type).toBe('request_failed');
    expect(await listWorkManifests(root)).toHaveLength(0);
  } finally {
    abortAgentSession(root, 'missing');
    await rm(root, { recursive: true, force: true });
  }
}, 15000);

it('ignores provisional tool notifications and persists the completed receipt before continuing with the bound Work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inkos-provisional-call-'));
  let receiptVisibleAtContinuation = false;
  const codex = new CodexFixture(async ({ step }) => {
    if (step === 1) return {
      notifications: [{ method: 'item/started', params: { item: { type: 'dynamicToolCall', id: 'provisional-call', tool: 'workspace__create_work',
        arguments: { workId: 'provisional', profileId: 'script', title: 'Provisional', language: 'en' }, status: 'inProgress' } } }],
      calls: [{ name: 'workspace__create_work', args: { workId: 'gallery', profileId: 'script', title: 'Gallery', language: 'en', intent: 'Create an empty script Work.' } }],
    };
    const events = await readTranscriptEvents(root, 'provisional');
    receiptVisibleAtContinuation = events.some(event => event.type === 'message' && event.role === 'toolResult'
      && (event.message as any).toolName === 'workspace__create_work' && !(event.message as any).isError);
    return { calls: [{ name: 'finish_turn', args: { status: 'delivered', message: 'The Work is ready.' } }] };
  });
  createClient.mockImplementation(codex.createClient);
  try {
    const request = 'Create an empty script Work called Gallery.';
    const result = await runAgentSession(configuration(root, 'provisional'), request);
    expect(result).toMatchObject({ workId: 'gallery', completion: { status: 'delivered' } });
    expect(result.errorMessage).toBeUndefined();
    expect((await listWorkManifests(root)).map(work => work.id)).toEqual(['gallery']);
    expect(codex.turns).toHaveLength(2);
    expect(receiptVisibleAtContinuation).toBe(true);
    expect(codex.turns[1].messages.filter(message => message.role === 'user' && message.content === request)).toHaveLength(1);
    const continuation=codex.requests.filter(message=>message.method==='turn/start')[1].params.input;
    const quoted=continuation.find((item:any)=>item.type==='text' && item.text.startsWith('Prior conversation records (')).text;
    const records=JSON.parse(quoted.slice(quoted.indexOf('\n')+1));
    expect(records.filter((record:any)=>record.role==='user' && record.content===request)).toHaveLength(1);
    expect(records).toEqual(expect.arrayContaining([expect.objectContaining({role:'toolResult',toolName:'workspace__create_work',isError:false})]));
    expect(result.messages.filter(m => m.role === 'assistant').flatMap(m => (m as any).content).some(part => part.type === 'toolCall' && part.id === 'provisional-call')).toBe(false);
    const restored = await loadBookSession(root, 'provisional');
    expect(restored?.messages.flatMap(m => m.toolExecutions ?? []).filter(t => t.tool === 'create_work')).toHaveLength(1);
  } finally {
    abortAgentSession(root, 'provisional');
    await rm(root, { recursive: true, force: true });
  }
}, 20000);

it('interrupts a live Codex turn on cancellation without creating a Work from provisional arguments', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inkos-cancel-provisional-'));
  const cancellation = new AbortController();
  let sawPartial!: () => void;
  const partial = new Promise<void>(resolve => { sawPartial = resolve; });
  const codex = new CodexFixture(() => {
    setImmediate(sawPartial);
    return { text: 'Preparing the creation request', hold: true,
      notifications: [{ method: 'item/started', params: { item: { type: 'dynamicToolCall', id: 'partial-call', tool: 'workspace__create_work',
        arguments: { workId: 'provisional', profileId: 'script', title: 'Provisional', language: 'en' }, status: 'inProgress' } } }],
    };
  });
  createClient.mockImplementation(codex.createClient);
  try {
    const result = runAgentSession({ ...configuration(root, 'cancelled'), signal: cancellation.signal }, 'Create a script Work.');
    await Promise.race([partial, result.then(() => { throw new Error('Codex turn ended before cancellation'); })]);
    cancellation.abort();
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(codex.requests.some(request => request.method === 'turn/interrupt')).toBe(true);
    expect(codex.toolResponses).toHaveLength(0);
    expect(await listWorkManifests(root)).toHaveLength(0);
    expect((await readTranscriptEvents(root, 'cancelled')).at(-1)?.type).toBe('request_failed');
  } finally {
    abortAgentSession(root, 'cancelled');
    await rm(root, { recursive: true, force: true });
  }
}, 15000);
