import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { createLoopbackCodexClient } from './loopback-client.js';
import { abortAgentSession, runAgentSession } from '../../agent/agent-session.js';
import { listWorkManifests } from '../../harness/work-store.js';
import { loadBookSession } from '../../interaction/book-session-store.js';
import { readTranscriptEvents } from '../../interaction/session-transcript.js';
import type { Model } from '@mariozechner/pi-ai';

const factory = vi.hoisted(() => vi.fn());
vi.mock('../client.js', () => ({ createCodexClient: factory }));

/** Full main-agent path: real pinned binary, real code-mode cell, real host
 * action/receipt/Work transition and transcript projection; loopback inference. */
describe.skipIf(process.env.INKOS_CODEX_INTEGRATION !== '1')('Codex main-agent code-mode completion', () => {
  it.each(['native', 'dynamic'])('creates once through two real host tools and completes via %s', async mode => {
    const root = await mkdtemp(join(tmpdir(), 'inkos-main-wire-'));
    const bodies: Array<Record<string, any>> = [];
    const calls: Array<Record<string, any>> = [];
    const starts: Array<Record<string, any>> = [];
    const completion = { status: 'delivered', message: 'The empty script Work is saved.' };
    let session = 0;
    const server = createServer((request, response) => {
      if (request.method !== 'POST') { response.writeHead(404).end(); return; }
      const chunks: Buffer[] = [];
      request.on('data', chunk => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
        if (bodies.length > 5) { response.writeHead(400).end('{"error":{"message":"Unexpected fixture repetition"}}'); return; }
        const item = session === 1
          ? { type: 'custom_tool_call', id: 'create_cell', call_id: 'create_cell', namespace: 'functions', name: 'exec', status: 'completed',
              input: `text(await tools.workspace__list_work_profiles({})); text(await tools.workspace__create_work({workId:"wire-work",profileId:"script",title:"Wire Work",language:"en",intent:"Create one empty script Work."}));` }
          : mode === 'dynamic'
            ? { type: 'custom_tool_call', id: 'finish_cell', call_id: 'finish_cell', namespace: 'functions', name: 'exec', status: 'completed', input: `text(await tools.finish_turn(${JSON.stringify(completion)}));` }
            : { type: 'message', id: 'final', role: 'assistant', phase: 'final_answer', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(completion), annotations: [] }] };
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const send = (event: Record<string, unknown>) => response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        send({ type: 'response.created', response: { id: `response_${bodies.length}`, object: 'response', status: 'in_progress', output: [] } });
        send({ type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress' } });
        send({ type: 'response.output_item.done', output_index: 0, item });
        send({ type: 'response.completed', response: { id: `response_${bodies.length}`, object: 'response', status: 'completed', output: [item], usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 } } });
        response.end();
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing loopback address');
    factory.mockImplementation(async () => {
      session++;
      const peer = await createLoopbackCodexClient(root, [ '-c', 'features.enable_request_compression=false',
          '-c', 'model_provider="fixture"', '-c', 'model="gpt-6.1-sol"',
          '-c', `model_providers.fixture={name="Fixture",base_url="http://127.0.0.1:${address.port}/v1",wire_api="responses",requires_openai_auth=false,supports_websockets=false,request_max_retries=0,stream_max_retries=0}`]);
      peer.onRequest((method, params) => { if (method === 'item/tool/call') calls.push(params as Record<string, any>); return undefined; });
      const request = peer.request.bind(peer);
      peer.request = async (method, params, options) => {
        if (method === 'thread/start') starts.push(params as Record<string, any>);
        return request(method, params, options);
      };
      return peer;
    });
    const model: Model<'openai-responses'> = { id: 'gpt-6.1-sol', name: 'Fixture', provider: 'openai', api: 'openai-responses', baseUrl: '', input: ['text'], reasoning: true,
      contextWindow: 128000, maxTokens: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Main-agent loopback deadline exceeded')), 20_000);
    try {
      await mkdir(join(root, '.inkos'));
      await writeFile(join(root, '.inkos/codex-config.json'), JSON.stringify({ model: 'gpt-6.1-sol', reasoningEffort: 'xhigh', serviceTier: 'default' }));
      const result = await runAgentSession({ projectRoot: root, sessionId: 'main-wire', bookId: null, workId: null, profileId: 'workspace-default',
        sessionKind: 'chat', language: 'en', model, pipeline: {} as never, signal: controller.signal }, 'Create one empty script Work called Wire Work.');
      expect(result.errorMessage).toBeUndefined();
      expect(result.completion).toEqual(completion);
      expect((await listWorkManifests(root)).map(work => work.id)).toEqual(['wire-work']);
      expect(calls.map(call => call.tool)).toEqual(['workspace__list_work_profiles', 'workspace__create_work', ...(mode === 'dynamic' ? ['finish_turn'] : [])]);
      expect(starts).toHaveLength(2);
      expect(starts.every(start => start.environments.length === 0)).toBe(true);
      expect(bodies.every(body => body.text.format.type === 'json_schema' && body.text.format.strict === true)).toBe(true);
      const displayed = (await loadBookSession(root, 'main-wire'))?.messages.filter(message => message.role === 'assistant').map(message => message.content).filter(Boolean);
      expect(displayed).toEqual([completion.message]);
      const events = await readTranscriptEvents(root, 'main-wire');
      expect(events.filter(event => event.type === 'message' && event.display?.completion)).toHaveLength(1);
      expect(events.at(-1)?.type).toBe('request_committed');
    } finally {
      clearTimeout(timer);
      abortAgentSession(root, 'main-wire');
      factory.mockReset();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
