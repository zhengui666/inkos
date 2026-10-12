import type { Hono } from 'hono';
import type { RuntimeClient } from '@actalk/inkos-core';
import { proxyMethods } from '../proxy.js';

export function workRoutes(app: Hono, client: RuntimeClient) {
  proxyMethods(app, client, [
    'works.list', 'works.create', 'works.get', 'works.update', 'works.pause',
    'artifacts.read', 'artifacts.save', 'artifacts.edit', 'artifacts.export',
    'materials.ingest', 'materials.query', 'materials.list', 'work.migrate',
  ]);
}
