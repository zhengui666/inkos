import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { CodexClient, CodexNotificationListener, CodexRequestListener } from '../codex/client.js';

export interface FixtureMessage { role: string; content: string; tool_calls?: unknown[]; tool_call_id?: string }
export interface FixtureTurn {
  thread: Record<string, any>;
  turn: Record<string, any>;
  messages: FixtureMessage[];
  tools: Array<{ type: 'function'; function: { name: string; description: string; parameters: any } }>;
  step: number;
}
export interface FixtureReply {
  text?: string;
  thinking?: string;
  calls?: Array<{ name: string; args: unknown; id?: string }>;
  error?: string;
  status?: 'completed' | 'failed' | 'interrupted';
  usage?: { input: number; output: number; total: number };
  notifications?: Array<{ method: string; params: Record<string, unknown> }>;
  hold?: boolean;
  complete?: boolean;
}

/**
 * Deterministic App Server peer. Only the CodexClient transport is mocked: the
 * real Agent, host tools, validation, domain pipeline and persistence all run.
 * `requests` contains untouched host RPC parameters. `messages`/`tools` are a
 * convenient decoded view for domain fixtures, not a provider wire payload.
 */
export class CodexFixture {
  readonly requests: Array<{ method: string; params: any }> = [];
  readonly turns: FixtureTurn[] = [];
  readonly toolResponses: Array<{ name: string; args: unknown; id: string; response: any }> = [];
  private nextClient = 0;
  private nextStep = 0;
  constructor(readonly reply: (turn: FixtureTurn) => FixtureReply | Promise<FixtureReply>) {}

  createClient = async (projectRoot: string): Promise<CodexClient> => {
    const fixture = this;
    const codexHome = join(projectRoot, ".inkos", "codex", "home");
    await mkdir(codexHome, { recursive: true, mode: 0o700 });
    const threadId = `fixture-thread-${++this.nextClient}`;
    const turnId = `${threadId}-turn`;
    const notifications = new Set<CodexNotificationListener>();
    const requests = new Set<CodexRequestListener>();
    const closeListeners = new Set<() => void>();
    let closed = false;
    let interrupted = false;
    let finished = false;
    let thread: Record<string, any> = {};
    const notify = (method: string, params: Record<string, unknown>) => {
      for (const listener of notifications) listener(method, { threadId, turnId, ...params });
    };
    const finish = (status: string, error?: string) => {
      if (finished || closed) return;
      finished = true;
      notify('turn/completed', { turn: { id: turnId, status, ...(error ? { error: { message: error } } : {}) } });
    };
    const run = async (turn: Record<string, any>) => {
      try {
        notify('turn/started', { turn: { id: turnId } });
        const messages = decodeInput(turn.input);
        const tools: FixtureTurn['tools'] = (thread.dynamicTools ?? []).map((tool: any) => ({ type: 'function', function: {
          name: tool.name, description: tool.description, parameters: tool.inputSchema,
        } }));
        for (let iteration = 0; iteration < 100 && !interrupted && !closed; iteration++) {
          const view: FixtureTurn = { thread, turn, messages: structuredClone(messages), tools, step: ++fixture.nextStep };
          fixture.turns.push(view);
          const reply = await fixture.reply(view);
          if (closed || interrupted) return;
          for (const event of reply.notifications ?? []) notify(event.method, event.params);
          const itemId = `${turnId}-item-${view.step}`;
          if (reply.thinking) notify('item/reasoning/summaryTextDelta', { itemId: `${itemId}-reasoning`, delta: reply.thinking });
          if (reply.text !== undefined) {
            notify('item/agentMessage/delta', { itemId, delta: reply.text });
            notify('item/completed', { item: { id: itemId, type: 'agentMessage', text: reply.text } });
            messages.push({ role: 'assistant', content: reply.text });
          }
          if (reply.usage) notify('thread/tokenUsage/updated', { tokenUsage: { last: {
            inputTokens: reply.usage.input, outputTokens: reply.usage.output, totalTokens: reply.usage.total,
          } } });
          if (reply.error || reply.status) { finish(reply.status ?? 'failed', reply.error); return; }
          for (const [index, call] of (reply.calls ?? []).entries()) {
            const callId = call.id ?? `${threadId}-call-${view.step}-${index}`;
            const params = { threadId, turnId, callId, tool: call.name, arguments: call.args };
            let response: any;
            for (const listener of requests) {
              const result = listener('item/tool/call', params);
              if (result !== undefined) { response = await result; break; }
            }
            if (response === undefined) throw new Error(`Unanswered fixture dynamic tool: ${call.name}`);
            fixture.toolResponses.push({ name: call.name, args: call.args, id: callId, response });
            messages.push({ role: 'assistant', content: '', tool_calls: [{ id: callId, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] });
            messages.push({ role: 'tool', tool_call_id: callId, content: response.contentItems?.filter((part: any) => part.type === 'inputText').map((part: any) => part.text).join('\n') ?? '' });
            // Match the App Server response/interrupt ordering. The host stops
            // immediately after its accepted completion or exhausted retries.
            await new Promise<void>(resolve => setImmediate(resolve));
            if (interrupted || closed) return;
          }
          if (reply.hold) return;
          if (reply.complete || !reply.calls?.length) { finish('completed'); return; }
        }
        if (!interrupted && !closed) throw new Error('Fixture exceeded 100 dynamic calls');
      } catch (error) { finish('failed', error instanceof Error ? error.message : String(error)); }
    };
    return {
      cwd: `/tmp/inkos-codex-fixture-${fixture.nextClient}`, codexHome,
      get closed() { return closed; },
      async request<T>(method: string, raw: unknown = {}): Promise<T> {
        const params = raw as Record<string, any>;
        fixture.requests.push({ method, params: structuredClone(params) });
        if (method === 'account/read') return { account: { type: 'chatgpt', email: 'fixture@example.test', planType: 'plus' }, requiresOpenaiAuth: false } as T;
        if (method === 'config/read') return { config: {} } as T;
        if (method === 'model/list') return { data: [
          { id: 'fixture', model: 'fixture', isDefault: true,
            defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] },
          { id: 'gpt-6.1-sol', model: 'gpt-6.1-sol', isDefault: false,
            defaultReasoningEffort: 'ultra', supportedReasoningEfforts: [{ reasoningEffort: 'ultra' }], serviceTiers: [{ id: 'priority' }, { id: 'fast' }] },
        ], nextCursor: null } as T;
        if (method === 'thread/start') { thread = params; return { thread: { id: threadId }, model: params.model ?? 'fixture' } as T; }
        if (method === 'turn/start') { setImmediate(() => { void run(params); }); return { turn: { id: turnId } } as T; }
        if (method === 'turn/interrupt') { interrupted = true; finish('interrupted'); return {} as T; }
        throw new Error(`Unexpected fixture RPC: ${method}`);
      },
      onNotification(listener) { notifications.add(listener); return () => { notifications.delete(listener); }; },
      onRequest(listener) { requests.add(listener); return () => { requests.delete(listener); }; },
      onClose(listener) { closeListeners.add(listener); return () => { closeListeners.delete(listener); }; },
      async close() { closed = true; for (const listener of closeListeners) listener(); },
    };
  };
}

function decodeInput(input: Array<Record<string, any>>): FixtureMessage[] {
  const messages: FixtureMessage[] = [];
  for (const item of input) {
    if (item.type !== 'text') continue;
    if (item.text.startsWith('Prior conversation records (')) {
      const records = JSON.parse(item.text.slice(item.text.indexOf('\n') + 1));
      for (const record of records) messages.push({
        role: record.role === 'toolResult' ? 'tool' : record.role,
        content: typeof record.content === 'string' ? record.content : record.content.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n'),
        ...(record.role === 'toolResult' ? { tool_call_id: record.toolCallId } : {}),
      });
    } else if (!item.text.startsWith('Continue from the recorded state.')) messages.push({ role: 'user', content: item.text });
  }
  return messages;
}

/** Reuse buffered domain example data without running the retired HTTP agent. */
export async function bufferedFixtureReply(response: Response): Promise<FixtureReply> {
  const body = await response.json() as any;
  if (!response.ok) return { error: body.error?.message ?? `Fixture error ${response.status}` };
  const choice = body.choices?.[0];
  if (choice?.finish_reason === 'length') return { error: 'Model output limit reached before the tool call completed' };
  const message = choice?.message ?? {};
  return {
    ...(message.content !== undefined ? { text: message.content } : {}),
    ...(message.reasoning_content ? { thinking: message.reasoning_content } : {}),
    ...(message.tool_calls ? { calls: message.tool_calls.map((call: any) => ({ name: call.function.name, args: JSON.parse(call.function.arguments) })) } : {}),
    ...(body.usage ? { usage: { input: body.usage.prompt_tokens ?? 0, output: body.usage.completion_tokens ?? 0, total: body.usage.total_tokens ?? 0 } } : {}),
  };
}
