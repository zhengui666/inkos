import type { Hono } from 'hono';
import type { RuntimeClient } from '@actalk/inkos-core';
import { proxyMethods } from '../proxy.js';

export function taskRoutes(app: Hono, client: RuntimeClient) {
  proxyMethods(app, client, [
    'tasks.list', 'tasks.get', 'tasks.pause', 'tasks.abort', 'tasks.retry', 'tasks.wait',
    'creation.start', 'creation.produce', ['produce', 'creation.produce'],
  ]);
}
