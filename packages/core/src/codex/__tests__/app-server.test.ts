import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { CODEX_ISOLATED_CONFIG, createCodexEnvironment, StdioCodexClient } from '../app-server.js';

function fixture() {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: vi.fn(() => { queueMicrotask(() => child.emit('close', 0)); return true; }) });
  const sent: Array<Record<string, unknown>> = [];
  child.stdin.on('data', chunk => sent.push(JSON.parse(chunk.toString())));
  const cleanup = vi.fn(async () => undefined);
  const client = new StdioCodexClient(child as unknown as ChildProcessWithoutNullStreams, '/isolated', '/auth', cleanup, 1000);
  const response = (value: unknown) => child.stdout.write(`${JSON.stringify(value)}\n`);
  return { child, sent, cleanup, client, response };
}

describe('Codex stdio JSON-RPC', () => {
  it('correlates out-of-order chunked responses and isolates notifications', async () => {
    const { client, child, response } = fixture();
    const listener = vi.fn();
    client.onNotification(() => { throw new Error('consumer exception'); }); client.onNotification(listener);
    const one = client.request('one'); const two = client.request('two');
    child.stdout.write('{"id":2,"result":'); child.stdout.write('"two"}\n');
    response({ method: 'thread/updated', params: { ok: true } }); response({ id: 1, result: 'one' });
    expect(await one).toBe('one'); expect(await two).toBe('two'); expect(listener).toHaveBeenCalledOnce();
    await client.close();
  });
  it('answers only handled server requests and returns safe errors for failures', async () => {
    const { client, response, sent } = fixture();
    client.onRequest(method => method === 'item/tool/call' ? { success: true } : undefined);
    response({ id: 'server1', method: 'item/tool/call', params: {} });
    response({ id: 'server2', method: 'unexpected/native', params: {} });
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent).toContainEqual({ id: 'server1', result: { success: true } });
    expect(sent).toContainEqual({ id: 'server2', error: { code: -32601, message: 'This capability is not exposed by Inkos' } });
    await client.close();
  });
  it('cancels local waits, ignores late replies, and times out without leaking pending requests', async () => {
    const { client, response } = fixture(); const controller = new AbortController();
    const pending = client.request('cancel', {}, { signal: controller.signal }); controller.abort();
    await expect(pending).rejects.toThrow('cancelled'); response({ id: 1, result: 'late' });
    await expect(client.request('timeout', {}, { timeoutMs: 1 })).rejects.toThrow('timed out');
    await client.close();
  });
  it('immediately rejects pending work on exit and closes idempotently', async () => {
    const { client, child, cleanup } = fixture(); const onClose = vi.fn(); client.onClose(onClose);
    const pending = client.request('active'); child.emit('close', 1);
    await expect(pending).rejects.toThrow('closed'); expect(onClose).toHaveBeenCalledOnce();
    await Promise.all([client.close(), client.close()]); expect(cleanup).toHaveBeenCalledOnce();
    const lateClose = vi.fn(); client.onClose(lateClose); await Promise.resolve(); expect(lateClose).toHaveBeenCalledOnce();
  });
  it('fails closed on malformed transport frames without exposing raw account errors', async () => {
    const { client, child, response } = fixture();
    const error = client.request('account/read');
    response({ id: 1, error: { code: -1, message: 'secret-access-token', data: { token: 'secret' } } });
    await expect(error).rejects.toThrow('Codex request account/read failed (RPC -1)');
    const malformed = client.request('next'); child.stdout.write('bad-json\n');
    await expect(malformed).rejects.toThrow('Invalid Codex'); await client.close();
  });
  it('does not forward developer credentials, endpoint overrides, or config', () => {
    vi.stubEnv('OPENAI_API_KEY', 'secret'); vi.stubEnv('CODEX_HOME', '/developer');
    vi.stubEnv('OPENAI_BASE_URL', 'https://untrusted'); vi.stubEnv('NODE_OPTIONS', '--require=/untrusted');
    const env = createCodexEnvironment('/isolated/home', '/isolated/codex');
    expect(env).not.toHaveProperty('OPENAI_API_KEY'); expect(env).not.toHaveProperty('OPENAI_BASE_URL');
    expect(env).not.toHaveProperty('NODE_OPTIONS'); expect(env.CODEX_HOME).toBe('/isolated/codex');
    expect(CODEX_ISOLATED_CONFIG['features.shell_tool']).toBe(false);
    expect(CODEX_ISOLATED_CONFIG['features.apps']).toBe(false);
    expect(CODEX_ISOLATED_CONFIG.project_doc_max_bytes).toBe(0);
    vi.unstubAllEnvs();
  });
});
