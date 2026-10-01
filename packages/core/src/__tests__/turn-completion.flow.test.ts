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

it('accepts a native answered completion, exposes only validated text and restores its host receipt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inkos-native-completion-'));
  const completion = { status: 'answered', message: 'A scene is a unit of dramatic action.' };
  const codex = new CodexFixture(() => ({ text: JSON.stringify(completion) }));
  createClient.mockImplementation(codex.createClient);
  const deltas: string[] = [];
  try {
    const result = await runAgentSession({ ...configuration(root, 'native'), onEvent: event => {
      if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') deltas.push(event.assistantMessageEvent.delta);
    } }, 'Explain a scene.');
    expect(result).toMatchObject({ completion, responseText: completion.message });
    expect(result.errorMessage).toBeUndefined();
    expect(deltas).toEqual([completion.message]);
    expect(codex.toolResponses).toHaveLength(0);
    expect(codex.turns).toHaveLength(1);
    expect(codex.turns[0].turn.outputSchema).toMatchObject({ required: ['status', 'message'], additionalProperties: false });
    expect(codex.turns[0].thread.environments).toEqual([]);
    expect(codex.turns[0].turn.environments).toEqual([]);
    const events = await readTranscriptEvents(root, 'native');
    const receipt = events.find(event => event.type === 'message' && event.display?.completion);
    expect(receipt).toMatchObject({ type: 'message', role: 'assistant', display: { completion } });
    expect(events.at(-1)?.type).toBe('request_committed');
    expect((await loadBookSession(root, 'native'))?.messages.filter(message => message.role === 'assistant').map(message => message.content)).toEqual([completion.message]);
  } finally { abortAgentSession(root, 'native'); await rm(root, { recursive: true, force: true }); }
});

it.each(['needs_input', 'blocked'] as const)('preserves explicit native %s without inventing a delivery', async status => {
  const root = await mkdtemp(join(tmpdir(), 'inkos-native-blocked-'));
  const completion = { status, message: status === 'blocked' ? 'The required ranking source is unavailable.' : 'Which uploaded source should I use?' };
  const codex = new CodexFixture(() => ({ text: JSON.stringify(completion) }));
  createClient.mockImplementation(codex.createClient);
  try {
    expect(await runAgentSession(configuration(root, 'blocked'), 'Use the source.')).toMatchObject({ completion, responseText: completion.message });
    expect(await listWorkManifests(root)).toHaveLength(0);
    expect(codex.turns).toHaveLength(1);
  } finally { abortAgentSession(root, 'blocked'); await rm(root, { recursive: true, force: true }); }
});

it('rejects native delivered without receipts and returns bounded completion diagnostics', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inkos-unproven-native-'));
  const codex = new CodexFixture(() => ({ text: JSON.stringify({ status: 'delivered', message: 'The novel was saved.' }) }));
  createClient.mockImplementation(codex.createClient);
  try {
    const result = await runAgentSession(configuration(root, 'unproven'), 'Write and save a novel.');
    expect(result.responseText).toBe('');
    expect(result.completion).toBeUndefined();
    expect(result.completionDiagnostics).toEqual({ code: 'TURN_DELIVERY_UNPROVEN', modelTurns: 2, finalResponses: 2, completionCalls: 0, rejectedCompletionCalls: 0 });
    expect(codex.turns).toHaveLength(2);
    expect(await listWorkManifests(root)).toHaveLength(0);
    expect((await readTranscriptEvents(root, 'unproven')).at(-1)?.type).toBe('request_failed');
    expect((await loadBookSession(root, 'unproven'))?.messages.filter(message => message.role === 'assistant')).toEqual([]);
  } finally { abortAgentSession(root, 'unproven'); await rm(root, { recursive: true, force: true }); }
});

it('accepts native completion after an actual action and does not repeat its side effect on transition', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inkos-native-action-'));
  const codex = new CodexFixture(({ step }) => step === 1
    ? { calls: [{ name: 'workspace__create_work', args: { workId: 'native-work', profileId: 'script', title: 'Native Work', language: 'en', intent: 'Create an empty script Work.' } }] }
    : { text: JSON.stringify({ status: 'delivered', message: 'The empty script Work is saved.' }) });
  createClient.mockImplementation(codex.createClient);
  try {
    const result = await runAgentSession(configuration(root, 'action'), 'Create an empty script Work.');
    expect(result.errorMessage).toBeUndefined();
    expect(result.completion?.status).toBe('delivered');
    expect((await listWorkManifests(root)).map(work => work.id)).toEqual(['native-work']);
    expect(codex.toolResponses.map(response => response.name)).toEqual(['workspace__create_work']);
    expect(codex.turns).toHaveLength(2);
    expect((await loadBookSession(root, 'action'))?.messages.filter(message => message.role === 'assistant').map(message => message.content).filter(Boolean)).toEqual(['The empty script Work is saved.']);
  } finally { abortAgentSession(root, 'action'); await rm(root, { recursive: true, force: true }); }
});

it('does not turn failed native final output into a completion or retry the model', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inkos-native-error-'));
  const codex = new CodexFixture(() => ({ text: JSON.stringify({ status: 'answered', message: 'Must not be accepted.' }), status: 'failed', error: 'Fixture provider error' }));
  createClient.mockImplementation(codex.createClient);
  try {
    const result = await runAgentSession(configuration(root, 'failed'), 'Answer.');
    expect(result.errorMessage).toBe('Fixture provider error');
    expect(result.completion).toBeUndefined();
    expect(result.responseText).toBe('');
    expect(codex.turns).toHaveLength(1);
  } finally { abortAgentSession(root, 'failed'); await rm(root, { recursive: true, force: true }); }
});

it('retains exactly one display receipt when a dynamic finish is followed by model text', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inkos-completion-tail-'));
  const completion = { status: 'answered', message: 'The accepted response.' };
  const codex = new CodexFixture(() => ({ calls: [{ name: 'finish_turn', args: completion }] }));
  createClient.mockImplementation(async (path: string) => {
    const peer = await codex.createClient(path);
    const notices = new Set<(method: string, params: unknown) => void>();
    const subscribe = peer.onNotification.bind(peer);
    const handle = peer.onRequest.bind(peer);
    peer.onNotification = callback => { notices.add(callback); const cleanup = subscribe(callback); return () => { notices.delete(callback); cleanup(); }; };
    peer.onRequest = callback => handle(async (method, raw) => {
      const response = await callback(method, raw);
      const params = raw as Record<string, unknown>;
      if (method === 'item/tool/call' && params.tool === 'finish_turn') {
        for (const notice of notices) {
          notice('item/completed', { threadId: params.threadId, turnId: params.turnId, item: { id: 'tail', type: 'agentMessage', phase: 'final_answer', text: JSON.stringify(completion) } });
          notice('turn/completed', { threadId: params.threadId, turn: { id: params.turnId, status: 'completed' } });
        }
      }
      return response;
    });
    return peer;
  });
  try {
    const result = await runAgentSession(configuration(root, 'tail'), 'Answer a question.');
    expect(result.completion).toEqual(completion);
    expect(result.errorMessage).toBeUndefined();
    expect((await readTranscriptEvents(root, 'tail')).filter(event => event.type === 'message' && event.display?.completion)).toHaveLength(1);
    expect((await loadBookSession(root, 'tail'))?.messages.filter(message => message.role === 'assistant').map(message => message.content)).toEqual([completion.message]);
    expect(codex.toolResponses.filter(response => response.name === 'finish_turn')).toHaveLength(1);
  } finally { abortAgentSession(root, 'tail'); await rm(root, { recursive: true, force: true }); }
});
