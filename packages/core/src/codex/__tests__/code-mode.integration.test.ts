import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { createLoopbackCodexClient } from './loopback-client.js';

/** Exercise the advertised functions.exec path, not an injected direct function
 * call that bypasses the code-mode host. No login or external inference. */
describe.skipIf(process.env.INKOS_CODEX_INTEGRATION !== '1')('Codex code-mode dynamic tool transport', () => {
  it.each([false, true])('runs the actual multi-tool cell only with a host (enabled=%s)', async enabled => {
    const root = await mkdtemp(join(tmpdir(), 'inkos-code-mode-'));
    const bodies: Array<Record<string, any>> = [];
    const calls: Array<Record<string, any>> = [];
    let resolveDone!: (result: any) => void;
    let rejectDone!: (error: Error) => void;
    const done = new Promise<any>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
    void done.catch(() => {});
    const timer = setTimeout(() => rejectDone(new Error('Code-mode loopback did not finish')), 20_000);
    const server = createServer((request, response) => {
      if (request.method !== 'POST') { response.writeHead(404).end(); return; }
      const chunks: Buffer[] = [];
      request.on('data', chunk => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
        const item = bodies.length === 1
          ? { type: 'custom_tool_call', id: 'exec_cell', call_id: 'exec_cell', namespace: 'functions', name: 'exec', status: 'completed', input: `text({available: ALL_TOOLS.map(tool => tool.name).sort(), process: typeof process, require: typeof require, fetch: typeof fetch}); text(await tools.inkos_probe({value:"1"})); text(await tools.inkos_probe_two({value:true}));` }
          : { type: 'message', id: 'final', role: 'assistant', phase: 'final_answer', status: 'completed', content: [{ type: 'output_text', text: 'Fixture completed.', annotations: [] }] };
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const send = (event: Record<string, unknown>) => response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        send({ type: 'response.created', response: { id: `response_${bodies.length}`, object: 'response', status: 'in_progress', output: [] } });
        send({ type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress' } });
        send({ type: 'response.output_item.done', output_index: 0, item });
        send({ type: 'response.completed', response: { id: `response_${bodies.length}`, object: 'response', status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 } } });
        response.end();
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture address');
    let client: Awaited<ReturnType<typeof createLoopbackCodexClient>> | undefined;
    try {
      client = await createLoopbackCodexClient(root, [ '-c', 'features.enable_request_compression=false',
          ...(enabled ? [] : ['-c', 'features.code_mode_host=false']), '-c', 'model_provider="fixture"', '-c', 'model="gpt-6.1-sol"',
          '-c', `model_providers.fixture={name="Fixture",base_url="http://127.0.0.1:${address.port}/v1",wire_api="responses",requires_openai_auth=false,supports_websockets=false,request_max_retries=0,stream_max_retries=0}`]);
      client.onRequest((method, params) => {
        if (method !== 'item/tool/call') return undefined;
        calls.push(params as Record<string, any>);
        return { success: true, contentItems: [{ type: 'inputText', text: 'verified-host-receipt' }] };
      });
      client.onNotification((method, params) => { if (method === 'turn/completed') resolveDone(params); });
      const started = await client.request<{ thread: { id: string } }>('thread/start', {
        model: 'gpt-6.1-sol', cwd: client.cwd, ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only', environments: [],
        baseInstructions: 'Use only the supplied Inkos tools.',
        dynamicTools: ['inkos_probe', 'inkos_probe_two'].map((name, index) => ({ type: 'function', name, description: 'Fixture host operation',
          inputSchema: { type: 'object', properties: { value: { type: index ? 'boolean' : 'string' } }, required: ['value'], additionalProperties: false } })),
      });
      await client.request('turn/start', { threadId: started.thread.id, environments: [], input: [{ type: 'text', text: 'Use both fixture tools.' }] });
      expect((await done).turn.status).toBe('completed');
      expect(bodies).toHaveLength(2);
      const surface = bodies[0]!.tools ?? bodies[0]!.input.filter((item: any) => item.type === 'additional_tools').flatMap((item: any) => item.tools);
      const rendered = JSON.stringify(surface);
      expect(rendered).toContain('inkos_probe');
      expect(rendered).toContain('inkos_probe_two');
      for (const forbidden of ['apply_patch', 'exec_command', 'write_stdin', 'view_image', 'read_mcp_resource', 'spawn_agent']) {
        expect(rendered).not.toContain(`### \`${forbidden}\``);
        expect(rendered).not.toContain(`"name":"${forbidden}"`);
      }
      const receipt = JSON.stringify(bodies[1]!.input.filter((item: any) => item.type === 'custom_tool_call_output'));
      if (!enabled) {
        expect(calls).toHaveLength(0);
        expect(receipt).toContain('code-mode host is disabled');
      } else {
        expect(calls).toEqual([
          expect.objectContaining({ tool: 'inkos_probe', arguments: { value: '1' } }),
          expect.objectContaining({ tool: 'inkos_probe_two', arguments: { value: true } }),
        ]);
        expect(receipt).toContain('verified-host-receipt');
        expect(receipt.match(/undefined/g)).toHaveLength(3);
        for (const forbidden of ['apply_patch', 'exec_command', 'write_stdin', 'view_image', 'read_mcp_resource', 'spawn_agent']) expect(receipt).not.toContain(forbidden);
        expect(receipt).not.toContain('code-mode host is disabled');
      }
    } finally {
      clearTimeout(timer);
      await client?.close();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
