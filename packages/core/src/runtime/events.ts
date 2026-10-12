import { watchEvents, type ConversationId } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { RuntimeHost } from './host.js';
import type { RuntimeEvent } from './client.js';

/** Disposable native watches; disconnecting a viewer never cancels the durable work. */
export async function watchRuntime(host: RuntimeHost, send: (event: RuntimeEvent) => void, conversationId?: number) {
  const graph = await host.harness.watchTaskGraph(BACKGROUND_CONTEXT);
  send({ type: 'snapshot', data: await host.status() });
  graph.start(async value => { send({ type: 'taskGraph', data: value }); });
  const unsubscribe = host.harness.subscribeCommits(() => { send({ type: 'changed' }); });
  const agent = conversationId === undefined ? undefined : await watchEvents(host.harness, conversationId as ConversationId, BACKGROUND_CONTEXT);
  if (agent) { send({ type: 'agentEvents', data: [agent.snapshot] }); agent.start(async events => { send({ type: 'agentEvents', data: events }); }); }
  return async () => { unsubscribe(); await graph.stop(); await agent?.stop(); };
}
