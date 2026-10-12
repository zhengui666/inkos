import { createServer, type ServerResponse } from 'node:http';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { RuntimeHost } from './host.js';
import { watchRuntime } from './events.js';
import { commitAtomicFileSet } from '../utils/atomic-file-set.js';

export async function startRuntimeService(rootDir: string, options: { port?: number } = {}) {
  const host = await RuntimeHost.open(rootDir);
  const token = randomUUID(); const viewers = new Set<ServerResponse>(); let closing = false;
  const json = (res: ServerResponse, status: number, body: unknown) => { const text = JSON.stringify(body); res.writeHead(status, { 'content-type': 'application/json' }); res.end(text); };
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) { json(res, 401, { error: 'Project runtime connection required' }); return; }
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (url.pathname === '/health') { json(res, 200, { pid: process.pid, rootDir: host.rootDir }); return; }
      if (url.pathname === '/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        viewers.add(res); let stop: (() => Promise<void>) | undefined;
        res.on('close', () => { viewers.delete(res); void stop?.(); });
        stop = await watchRuntime(host, event => { if (!res.destroyed) res.write(`data: ${JSON.stringify(event)}\n\n`); }, url.searchParams.has('conversationId') ? Number(url.searchParams.get('conversationId')) : undefined);
        if (res.destroyed) await stop(); return;
      }
      if (url.pathname !== '/rpc' || req.method !== 'POST') { json(res, 404, { error: 'Route not found' }); return; }
      let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 32 * 1024 * 1024) throw new Error('Request exceeds artifact input limit'); }
      const { method, params } = JSON.parse(body);
      if (method === 'runtime.stop') { json(res, 200, { result: { stopping: true } }); setImmediate(() => { void close(); }); return; }
      json(res, 200, { result: await host.rpc(method, params) });
    } catch (error) { console.error('[runtime request]', error); if (!res.headersSent) json(res, 400, { error: error instanceof Error ? error.message : String(error) }); else res.end(); }
  });
  await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(options.port ?? 0, '127.0.0.1', () => { server.removeListener('error', reject); accept(); }); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Runtime address unavailable');
  const endpoint = { pid: process.pid, rootDir: host.rootDir, url: `http://127.0.0.1:${address.port}`, token };
  await commitAtomicFileSet({ rootDir: join(host.rootDir, '.inkos'), writes: [{ relativePath: 'runtime.json', content: JSON.stringify(endpoint) }] });
  async function close() {
    if (closing) return; closing = true;
    for (const res of viewers) res.end();
    const stopped = new Promise<void>(accept => server.close(() => accept()));
    await host.close();
    server.closeIdleConnections();
    await stopped;
    const path = join(host.rootDir, '.inkos', 'runtime.json');
    try { if (JSON.parse(await readFile(path, 'utf8')).token === token) await rm(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return { host, endpoint, server, close };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const index = process.argv.indexOf('--root'); const rootDir = index >= 0 ? process.argv[index + 1]! : process.cwd();
  void startRuntimeService(rootDir).then(service => {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void service.close(); });
    console.log(`InkOS runtime ${service.endpoint.url} (${service.endpoint.rootDir})`);
  }).catch(error => { console.error(error); process.exitCode = 1; });
}
