import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import { createLoopbackCodexClient } from './loopback-client.js';
import { CODEX_APP_SERVER_VERSION, CODEX_ISOLATED_CONFIG } from '../app-server.js';

/** Actual pinned App Server + credential-free loopback responses. No production auth exemption. */
it('observes 0.159.2 native omit/null/Standard semantics and real ACK fields without startup model overrides', async () => {
  expect(createRequire(import.meta.url)('@openai/codex/package.json').version).toBe(CODEX_APP_SERVER_VERSION);
  for (const field of ['model', 'model_reasoning_effort', 'service_tier']) expect(CODEX_ISOLATED_CONFIG).not.toHaveProperty(field);
  const root = await mkdtemp(join(tmpdir(), 'inkos-native-defaults-'));
  const bodies: Array<Record<string, any>> = [];
  const waiters: Array<(body: Record<string, any>) => void> = [];
  const server = createServer((request, response) => {
    if (request.method !== 'POST') { response.writeHead(404).end(); return; }
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString()); bodies.push(body); waiters.shift()?.(body);
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const item = { type: 'message', id: `msg-${bodies.length}`, role: 'assistant', phase: 'final_answer', status: 'completed',
        content: [{ type: 'output_text', text: 'Loopback result', annotations: [] }] };
      const send = (event: Record<string, unknown>) => response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      send({ type: 'response.created', response: { id: `r-${bodies.length}`, object: 'response', status: 'in_progress', output: [] } });
      send({ type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress' } });
      send({ type: 'response.output_item.done', output_index: 0, item });
      send({ type: 'response.completed', response: { id: `r-${bodies.length}`, object: 'response', status: 'completed', output: [item],
        usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 } } });
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No loopback fixture address');
  let peer: Awaited<ReturnType<typeof createLoopbackCodexClient>> | undefined;
  try {
    peer = await createLoopbackCodexClient(root, ['-c', 'features.enable_request_compression=false', '-c', 'model_provider="fixture"',
      '-c', 'model="gpt-5.3-codex"', '-c', `model_providers.fixture={name="Fixture",base_url="http://127.0.0.1:${address.port}/v1",wire_api="responses",requires_openai_auth=false,supports_websockets=false,request_max_retries=0,stream_max_retries=0}`]);
    const config = await peer.request<{ config: Record<string, unknown> }>('config/read', { includeLayers: false });
    expect(config.config.model).toBe('gpt-5.3-codex');
    expect(config.config.model_reasoning_effort).not.toBe('ultra');
    expect(config.config.service_tier).not.toBe('fast');
    for (const value of ['omit', null, 'default'] as const) {
      const thread = await peer.request<Record<string, any>>('thread/start', { cwd: peer.cwd, ephemeral: true,
        approvalPolicy: 'never', sandbox: 'read-only', environments: [], dynamicTools: [], serviceTier: 'priority' });
      expect(thread.model).toBe('gpt-5.3-codex');
      // The credential-free custom provider reports null in the real ACK for this request.
      expect(thread.serviceTier).toBeNull();
      expect(thread.reasoningEffort).toBeNull();
      const body = new Promise<Record<string, any>>(resolve => waiters.push(resolve));
      let completed!: () => void;
      const terminal = new Promise<void>(resolve => { completed = resolve; });
      const off = peer.onNotification((method, params) => { if (method === 'turn/completed' && (params as any).threadId === thread.thread.id) completed(); });
      try {
        const turn = await peer.request<Record<string, any>>('turn/start', { threadId: thread.thread.id,
          input: [{ type: 'text', text: 'Return one loopback result' }], environments: [], ...(value === 'omit' ? {} : { serviceTierForTurn: value }) });
        expect(Object.keys(turn)).toEqual(['turn']);
        expect(turn.turn.id).toEqual(expect.any(String));
        expect(turn).not.toHaveProperty('model'); expect(turn).not.toHaveProperty('effort'); expect(turn).not.toHaveProperty('serviceTier');
        const sent = await body;
        expect(sent.model).toBe(thread.model);
        // Requested priority above is not effective evidence. All three native variants are accepted,
        // and the observed provider tier stays null rather than being filled from request values.
        expect(sent.service_tier ?? null).toBeNull();
        await terminal;
      } finally { off(); }
    }
    expect(bodies).toHaveLength(3);
  } finally {
    await peer?.close(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
