import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { createCodexClient } from '../app-server.js';

/** Actual pinned runtime + loopback fixture, with no credentials or external inference.
 * Run with INKOS_CODEX_INTEGRATION=1 after installing @openai/codex. */
describe.skipIf(process.env.INKOS_CODEX_INTEGRATION !== '1')('Codex native tool isolation', () => {
  it.each([true, false])('offers only the declared Inkos dynamic tools (tools enabled: %s)', async (withTools) => {
    const root = await mkdtemp(join(tmpdir(), 'inkos-codex-integration-'));
    const require = createRequire(import.meta.url);
    const packageRoot = dirname(require.resolve('@openai/codex/package.json'));
    let resolveRequest!: (request: Record<string, unknown>) => void;
    let rejectRequest!: (error: Error) => void;
    const captured = new Promise<Record<string, unknown>>((resolve, reject) => { resolveRequest = resolve; rejectRequest = reject; });
    // Mark the rejection handled even if initialization fails before awaiting capture.
    void captured.catch(() => undefined);
    const timeout = setTimeout(() => rejectRequest(new Error('No fixture model request received')), 20_000);
    const server = createServer((request, response) => {
      if (request.method !== 'POST') { response.writeHead(404).end(); return; }
      const chunks: Buffer[] = [];
      request.on('data', chunk => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        try { resolveRequest(JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>); }
        catch { rejectRequest(new Error('Invalid fixture request body')); }
        response.writeHead(400, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'Fixture stopped after capturing tools' } }));
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No loopback fixture address');
    let client: Awaited<ReturnType<typeof createCodexClient>> | undefined;
    try {
      client = await createCodexClient(root, {
        stateRoot: join(root, 'state'), command: process.execPath,
        args: [join(packageRoot, 'bin', 'codex.js'),
          '-c', 'features.enable_request_compression=false',
          '-c', 'model_provider="fixture"', '-c', 'model="gpt-5.3-codex"',
          '-c', `model_providers.fixture={name="Fixture",base_url="http://127.0.0.1:${address.port}/v1",wire_api="responses",requires_openai_auth=false,supports_websockets=false,request_max_retries=0,stream_max_retries=0}`],
      });
      const result = await client.request<{ thread: { id: string } }>('thread/start', {
        cwd: client.cwd, ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only',
        baseInstructions: 'Use only the Inkos tools.',
        dynamicTools: withTools ? [{ name: 'inkos_probe', description: 'Read story state', inputSchema: { type: 'object', properties: {} } }] : [],
      });
      await client.request('turn/start', { threadId: result.thread.id, input: [{ type: 'text', text: 'Read story state' }] });
      const body = await captured;
      expect(body.tools ?? []).toEqual(withTools ? [expect.objectContaining({ type: 'function', name: 'inkos_probe' })] : []);
      expect(JSON.stringify(body)).not.toContain('AGENTS.md');
    } finally {
      clearTimeout(timeout);
      await client?.close();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('executes an actual dynamic call and returns its receipt to the model', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inkos-codex-loop-'));
    const require = createRequire(import.meta.url);
    const packageRoot = dirname(require.resolve('@openai/codex/package.json'));
    const bodies: Array<Record<string, unknown>> = [];
    let resolveDone!: (value: Record<string, any>) => void;
    let rejectDone!: (error: Error) => void;
    const done = new Promise<Record<string, any>>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
    void done.catch(() => {});
    const timeout = setTimeout(() => rejectDone(new Error('Codex loop did not complete')), 20_000);
    const server = createServer((request, response) => {
      if (request.method !== 'POST') { response.writeHead(404).end(); return; }
      const chunks: Buffer[] = [];
      request.on('data', chunk => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
        const n = bodies.length;
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const send = (value: Record<string, unknown>) => response.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
        const item = n === 1
          ? { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'inkos_probe', arguments: '{"value":"1"}', status: 'completed' }
          : { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Receipt accepted.', annotations: [] }] };
        send({ type: 'response.created', response: { id: `resp_${n}`, object: 'response', status: 'in_progress', output: [] } });
        send({ type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress' } });
        if (n > 1) send({ type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'Receipt accepted.' });
        send({ type: 'response.output_item.done', output_index: 0, item });
        send({ type: 'response.completed', response: { id: `resp_${n}`, object: 'response', status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 } } });
        response.end();
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No fixture address');
    let client: Awaited<ReturnType<typeof createCodexClient>> | undefined;
    try {
      client = await createCodexClient(root, { stateRoot: join(root, 'state'), command: process.execPath,
        args: [join(packageRoot, 'bin', 'codex.js'), '-c', 'features.enable_request_compression=false',
          '-c', 'model_provider="fixture"', '-c', 'model="gpt-5.3-codex"',
          '-c', `model_providers.fixture={name="Fixture",base_url="http://127.0.0.1:${address.port}/v1",wire_api="responses",requires_openai_auth=false,supports_websockets=false,request_max_retries=0,stream_max_retries=0}`] });
      const calls: unknown[] = [];
      client.onRequest((method, params) => {
        if (method !== 'item/tool/call') return undefined;
        calls.push(params);
        return { success: true, contentItems: [{ type: 'inputText', text: 'host-receipt-typed-string' }] };
      });
      client.onNotification((method, params) => {
        if (method === 'turn/completed') resolveDone(params as Record<string, any>);
      });
      const started = await client.request<{ thread: { id: string } }>('thread/start', {
        cwd: client.cwd, ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only',
        baseInstructions: 'Use Inkos tools only.', dynamicTools: [{ name: 'inkos_probe', description: 'Read story state',
          inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } }],
      });
      await client.request('turn/start', { threadId: started.thread.id, input: [{ type: 'text', text: 'Read the state.' }] });
      const completed = await done;
      expect(completed.turn.status).toBe('completed');
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ tool: 'inkos_probe', arguments: { value: '1' }, callId: 'call_1' });
      expect(bodies).toHaveLength(2);
      expect(JSON.stringify(bodies[1]!.input)).toContain('host-receipt-typed-string');
    } finally {
      clearTimeout(timeout);
      await client?.close();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

});
