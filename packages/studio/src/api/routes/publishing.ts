import type { Hono } from 'hono';
import type { RuntimeClient } from '@actalk/inkos-core';
import { proxyMethods } from '../proxy.js';

export function publishingRoutes(app: Hono, client: RuntimeClient) {
  proxyMethods(app, client, [
    'publishing.targets', 'publishing.createTarget', 'publishing.updateTarget',
    'publishing.list', 'publishing.queue', 'publishing.resume', 'publishing.observe',
  ]);
}
