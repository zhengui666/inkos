import type { Context } from '@earendil-works/chord';
import { contentText } from '@earendil-works/pi-ai';
import type { ConversationId, EntryId, ContextView } from '@earendil-works/pi-durable';

type Reader = { context(conversationId: ConversationId, context: Context, options?: { at?: EntryId }): Promise<ContextView> };
/** A task's entry() is parent-conversation scoped. Always read the exact answer in its owned conversation. */
export async function readConversationEntry(reader: Reader, conversationId: ConversationId, answerId: EntryId, context: Context) {
  return (await reader.context(conversationId, context, { at: answerId })).entries.find(entry => entry.id === answerId);
}
export async function readModelAnswer(reader: Reader, conversationId: ConversationId, answerId: EntryId, context: Context): Promise<string> {
  const entry = await readConversationEntry(reader, conversationId, answerId, context);
  const answer = entry?.model?.find(message => message.role === 'assistant');
  if (!answer || answer.role !== 'assistant') throw new Error('Model step has no assistant answer');
  const text = contentText(answer.content).trim();
  if (!text) throw new Error('Model step returned an empty answer');
  return text;
}
/** Recover a completed owned response without submitting another input. */
export async function latestModelAnswer(reader: Reader, conversationId: ConversationId, context: Context) {
  const entry = [...(await reader.context(conversationId, context)).entries].reverse().find(entry => entry.kind === 'pi.assistant' && entry.model?.some(message => message.role === 'assistant' && message.stopReason === 'stop'));
  return entry ? { entryId: entry.id, text: await readModelAnswer(reader, conversationId, entry.id, context) } : undefined;
}
