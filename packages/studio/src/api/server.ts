import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { RuntimeClient } from '@actalk/inkos-core';
import { dirname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { conversationRoutes } from './routes/conversations.js';
import { taskRoutes } from './routes/tasks.js';
import { workRoutes } from './routes/works.js';
import { publishingRoutes } from './routes/publishing.js';
import { modelRoutes } from './routes/models.js';
import { pluginRoutes } from './routes/plugins.js';

export function createStudioApp(client: RuntimeClient, options: { staticDir?: string } = {}) {
  const app = new Hono();
  const api = new Hono();
  const watches = new Set<AbortController>();
  api.onError((error, c) => c.json({ error: error.message }, error instanceof SyntaxError ? 400 : 502));
  api.get('/status', async c => c.json(await client.rpc('status')));
  api.post('/status', async c => c.json(await client.rpc('status')));
  api.get('/events', c => {
    const conversationId = c.req.query('conversationId');
    if (conversationId !== undefined && !/^\d+$/.test(conversationId)) {
      return c.json({ error: 'conversationId must be a native numeric ID' }, 400);
    }
    return streamSSE(c, async stream => {
      const watch = new AbortController();
      watches.add(watch);
      stream.onAbort(() => watch.abort());
      const heartbeat = setInterval(() => {
        void stream.writeSSE({ event: 'ping', data: '{}' }).catch(() => watch.abort());
      }, 15_000);
      // Serialise writes, not execution. This is only a projection subscription.
      let writes = Promise.resolve();
      try {
        await client.events(event => {
          writes = writes.then(() => stream.writeSSE({ data: JSON.stringify(event) }));
          void writes.catch(() => watch.abort());
        }, { signal: watch.signal, ...(conversationId === undefined ? {} : { conversationId: Number(conversationId) }) });
        await writes;
      } catch (error) {
        if (!watch.signal.aborted) {
          await stream.writeSSE({ event: 'runtime-error', data: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) });
        }
      } finally {
        clearInterval(heartbeat);
        watch.abort();
        watches.delete(watch);
      }
    });
  });
  conversationRoutes(api, client);
  taskRoutes(api, client);
  workRoutes(api, client);
  publishingRoutes(api, client);
  modelRoutes(api, client);
  pluginRoutes(api, client);
  api.notFound(c => c.json({ error: 'Unknown Studio API route' }, 404));
  app.route('/api/v1', api);
  app.all('/api/v1/*', c => c.json({ error: 'Unknown Studio API route' }, 404));
  if (options.staticDir) {
    app.use('/*', serveStatic({ root: options.staticDir }));
    app.get('*', serveStatic({ root: options.staticDir, path: 'index.html' }));
  }
  return { app, disconnect: () => { for (const watch of watches) watch.abort(); } };
}

export async function startStudio(rootDir: string, options: { port?: number; host?: string } = {}) {
  const client = await RuntimeClient.connect(resolve(rootDir), { start: true });
  const parent = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const staticDir = basename(parent) === 'src' ? resolve(parent, '../dist') : parent;
  const { app, disconnect } = createStudioApp(client, { staticDir });
  const host = options.host ?? '127.0.0.1';
  const server = serve({ fetch: app.fetch, port: options.port ?? 4567, hostname: host });
  await new Promise<void>((res, rej) => {
    if (server.listening) res();
    else server.once('listening', res);
    server.once('error', rej);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Studio did not bind a TCP address');
  const url = `http://${host.includes(':') ? `[${host}]` : host}:${address.port}`;
  let closing: Promise<void> | undefined;
  return {
    url, server,
    close(): Promise<void> {
      closing ??= new Promise<void>((res, rej) => {
        disconnect();
        server.close(error => error ? rej(error) : res());
        // Watches are transport connections; closing them never aborts native work.
        if ('closeAllConnections' in server) server.closeAllConnections();
      });
      return closing;
    },
  };
}
