import type { Hono } from 'hono';
import type { RuntimeClient } from '@actalk/inkos-core';

/** A transport adapter only: results, identity and state belong to the runtime. */
export function proxyMethods(app: Hono, client: RuntimeClient, methods: readonly (string | readonly [string, string])[]) {
  for (const entry of methods) {
    const [route, method] = typeof entry === 'string' ? [entry, entry] : entry;
    app.post(`/${route.split('.').join('/')}`, async c => {
      const params = await c.req.json();
      const result = await client.rpc(method, params);
      return c.json(result ?? null);
    });
  }
}
