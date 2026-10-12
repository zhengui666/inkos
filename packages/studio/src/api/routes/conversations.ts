import type { Hono } from 'hono';
import type { RuntimeClient } from '@actalk/inkos-core';
import { proxyMethods } from '../proxy.js';

export function conversationRoutes(app: Hono, client: RuntimeClient) {
  proxyMethods(app, client, [
    'conversations.list', 'conversations.create', 'conversations.get',
    'conversations.submit', 'conversations.configure', 'conversations.abort',
    'submissions.get', 'submissions.wait', 'submissions.abort',
  ]);
}
