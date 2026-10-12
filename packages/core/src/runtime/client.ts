import { spawn } from 'node:child_process';
import { readFile, realpath, open, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type RuntimeEndpoint = { pid: number; rootDir: string; url: string; token: string };
export type RuntimeEvent = { type: string; data?: any };
export class RuntimeClient {
  constructor(readonly endpoint: RuntimeEndpoint) {}
  static async connect(rootDir: string, options: { start?: boolean } = {}): Promise<RuntimeClient> {
    rootDir = await realpath(rootDir);
    const existing = await RuntimeClient.find(rootDir);
    if (existing) return existing;
    if (options.start === false) throw new Error('Runtime is not running. Use inkos up.');
    await mkdir(join(rootDir, '.inkos'), { recursive: true });
    const log = await open(join(rootDir, '.inkos', 'runtime.log'), 'a', 0o600);
    try {
      const child = spawn(process.execPath, [fileURLToPath(new URL('./service-main.js', import.meta.url)), '--root', rootDir], {
        cwd: rootDir, detached: true, stdio: ['ignore', log.fd, log.fd], env: process.env,
      });
      child.unref();
    } finally { await log.close(); }
    for (let attempt = 0; attempt < 150; attempt++) {
      const client = await RuntimeClient.find(rootDir); if (client) return client;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Runtime did not start; see ${join(rootDir, '.inkos', 'runtime.log')}\n${await readFile(join(rootDir, '.inkos', 'runtime.log'), 'utf8')}`);
  }
  static async find(rootDir: string): Promise<RuntimeClient | undefined> {
    let endpoint: RuntimeEndpoint;
    try { endpoint = JSON.parse(await readFile(join(rootDir, '.inkos', 'runtime.json'), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return undefined; throw error; }
    try {
      const response = await fetch(`${endpoint.url}/health`, { headers: { authorization: `Bearer ${endpoint.token}` }, signal: AbortSignal.timeout(1000) });
      const health = await response.json() as { rootDir: string; pid: number };
      if (response.ok && health.rootDir === rootDir && health.pid === endpoint.pid) return new RuntimeClient(endpoint);
    } catch { /* The lock, not the stale endpoint file, decides ownership during startup. */ }
    return undefined;
  }
  async rpc<T = any>(method: string, params: any = {}): Promise<T> {
    const response = await fetch(`${this.endpoint.url}/rpc`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${this.endpoint.token}` },
      body: JSON.stringify({ method, params }),
    });
    const text = await response.text();
    let body: { result?: T; error?: string };
    try { body = JSON.parse(text); }
    catch (error) { throw new Error(`${method}: invalid runtime response (HTTP ${response.status}): ${text}`, { cause: error }); }
    if (!response.ok) throw new Error(body.error ?? `Runtime request failed: ${response.status}`);
    return body.result as T;
  }
  async events(listener: (event: RuntimeEvent) => void, options: { conversationId?: number; signal?: AbortSignal } = {}): Promise<void> {
    const query = options.conversationId === undefined ? '' : `?conversationId=${options.conversationId}`;
    const response = await fetch(`${this.endpoint.url}/events${query}`, { headers: { authorization: `Bearer ${this.endpoint.token}` }, signal: options.signal });
    if (!response.ok || !response.body) throw new Error('Runtime event connection failed');
    let buffer = ''; const decoder = new TextDecoder();
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let end: number;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
        if (data) listener(JSON.parse(data));
      }
    }
  }
  async stop(): Promise<void> { await this.rpc('runtime.stop'); }
}
