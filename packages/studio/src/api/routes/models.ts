import type { Hono } from 'hono';
import type { RuntimeClient } from '@actalk/inkos-core';
import { proxyMethods } from '../proxy.js';

export function modelRoutes(app: Hono, client: RuntimeClient) {
  proxyMethods(app, client, [
    'models.list', 'models.set', 'models.login.start', 'models.login.status', 'models.login.respond', 'models.login.cancel', 'models.logout',
    ['login.start', 'models.login.start'], ['login.status', 'models.login.status'], ['login.respond', 'models.login.respond'], ['login.cancel', 'models.login.cancel'], ['logout', 'models.logout'],
  ]);
}
