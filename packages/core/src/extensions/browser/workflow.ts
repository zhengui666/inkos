import type { Context } from '@earendil-works/chord';
import { configure, type ConversationId, type TaskRuntime, type Tx } from '@earendil-works/pi-durable';
import type { InkExtension } from '../../runtime/plugins.js';
import type { DistributionTaskInput, DistributionCheckpoint, DistributionResult, PublishingTarget, DistributionRequest, BrowserObservation } from '../../publishing/contracts.js';
import { emptyRemote } from '../../publishing/contracts.js';
import { ProjectDoc } from '../../works/documents.js';
import { BrowserRunDoc } from './documents.js';

export type DistributionRuntime = TaskRuntime<DistributionTaskInput, DistributionCheckpoint, DistributionResult, object>;
export async function createBrowserConversation(tx: Tx, runtime: DistributionRuntime, target: PublishingTarget,
  distributionId: string, request: DistributionRequest, mode: 'observe' | 'mutate'): Promise<ConversationId> {
  const extensions = runtime.registry.installed().filter(extension => extension.tools?.some(tool => tool.name === 'inkos_browser_call')
    || (extension as InkExtension).publishers?.some(publisher => publisher.id === target.platform));
  const tools = extensions.flatMap(extension => extension.tools ?? []).filter(tool =>
    ['inkos_browser_tools', 'inkos_browser_call', 'inkos_browser_report'].includes(tool.name));
  const project = await tx.doc(ProjectDoc);
  const conversation = await tx.createConversation({ ownership: { kind: 'task', taskId: runtime.taskId } });
  await configure(tx, conversation.id, { extensions, tools, ...(project.model ? { model: project.model } : {}) });
  const doc = await tx.doc(BrowserRunDoc, conversation.id);
  Object.assign(doc, { target, distributionId, mode, operation: request.operation, mcpCalls: 0, report: null });
  return conversation.id;
}
export async function runBrowserConversation(runtime: DistributionRuntime, conversationId: ConversationId,
  prompt: string, context: Context): Promise<BrowserObservation> {
  const conversation = await runtime.conversation(conversationId, context);
  if (!conversation) throw new Error('Owned browser conversation is missing');
  const submission = await conversation.submit({ type: 'input', content: prompt, requestId: 'browser-workflow', whenBusy: 'reject' }, context);
  await submission.wait(context);
  await conversation.waitForIdle(context);
  const run = await runtime.snapshot(BrowserRunDoc, conversationId, context);
  return run?.report ?? { state: 'unknown', accountId: null, remote: emptyRemote(), title: null, body: null,
    complete: false, notApplied: false, evidence: 'Owned browser conversation produced no MCP-backed observation.', observedAt: runtime.now() };
}
export async function stopBrowserConversation(runtime: DistributionRuntime, id: number | null, context: Context): Promise<void> {
  if (id === null) return;
  const conversation = await runtime.conversation(id as ConversationId, context);
  await conversation?.abort(context);
}
