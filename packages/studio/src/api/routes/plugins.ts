import type { Hono } from 'hono';
import type { RuntimeClient } from '@actalk/inkos-core';
import { proxyMethods } from '../proxy.js';

export function pluginRoutes(app: Hono, client: RuntimeClient) {
  proxyMethods(app, client, ['plugins.list', 'plugins.configure']);
}
