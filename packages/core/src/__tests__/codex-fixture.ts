import { mkdir, realpath, lstat } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveCodexHome } from "../codex/app-server.js";
import type { CodexClient, CodexNotificationListener, CodexRequestListener, CodexRequestOptions } from '../codex/client.js';

export interface FixtureMessage { role: string; content: string; tool_calls?: unknown[]; tool_call_id?: string }
export interface FixtureTurn {
  thread: Record<string, any>;
  turn: Record<string, any>;
  messages: FixtureMessage[];
  tools: Array<{ type: 'function'; function: { name: string; description: string; parameters: any } }>;
  step: number;
  /** Close/interrupt cancels cooperative reply work; drain still waits for settlement. */
  signal: AbortSignal;
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

export type FixtureAccountResponse = unknown | (() => unknown | Promise<unknown>);
export interface CodexFixtureOptions {
  accountResponse?: FixtureAccountResponse;
  /** Native config/read evidence, independent of application settings. */
  config?: Record<string, unknown>;
}
export interface FixtureRequest { method: string; params: any; peerId: string }
export interface FixturePeerEvidence {
  readonly id: string;
  readonly projectRoot: string;
  readonly client: CodexClient;
  readonly requests: FixtureRequest[];
  readonly closed: boolean;
  readonly closeCount: number;
}
export const syntheticChatGptAccount = (email = 'fixture@example.test') => ({
  account: { type: 'chatgpt', email, planType: 'unknown' }, requiresOpenaiAuth: true,
});

/**
 * Deterministic App Server peer. Only the CodexClient transport is mocked: the
 * real Agent, host tools, validation, domain pipeline and persistence all run.
 * `requests` contains untouched host RPC parameters. `messages`/`tools` are a
 * convenient decoded view for domain fixtures, not a provider wire payload.
 */
export class CodexFixture {
  readonly requests: FixtureRequest[] = [];
  readonly peers: FixturePeerEvidence[] = [];
  private readonly accounts = new Map<string, FixtureAccountResponse>();
  private readonly pending = new Set<Promise<void>>();
  private readonly failures: unknown[] = [];
  get pendingTaskCount(): number { return this.pending.size; }
  readonly turns: FixtureTurn[] = [];
  readonly toolResponses: Array<{ name: string; args: unknown; id: string; response: any }> = [];
  private nextClient = 0;
  private nextStep = 0;
  constructor(readonly reply: (turn: FixtureTurn) => FixtureReply | Promise<FixtureReply> = () => {
    throw new Error('Unexpected model dispatch in offline fixture');
  }, private readonly options: CodexFixtureOptions = {}) {}

  setAccountResponse(projectRoot: string, response: FixtureAccountResponse): void {
    this.accounts.set(realpathSync(projectRoot), response);
  }

  async close(): Promise<void> { await Promise.all(this.peers.map(peer => peer.client.close())); }
  async drain(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
    if (this.failures.length) throw new AggregateError(this.failures.splice(0), 'Offline fixture task failed');
  }

  createClient = async (projectRoot: string): Promise<CodexClient> => {
    const fixture = this;
    projectRoot = await realpath(projectRoot);
    const configuredHome = resolveCodexHome(projectRoot);
    // Never create a home inherited from a real user/deployment override.
    if (resolve(configuredHome) !== join(projectRoot, '.inkos', 'codex', 'home')) {
      throw new Error('Offline fixture requires a project-private Codex home');
    }
    // Validate each existing ancestor before creating below it. recursive mkdir
    // would otherwise follow a linked .inkos/codex and mutate another project.
    let directory = projectRoot;
    for (const name of ['.inkos', 'codex', 'home']) {
      directory = join(directory, name);
      let entry;
      try { entry = await lstat(directory); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        try { await mkdir(directory, { mode: 0o700 }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        entry = await lstat(directory);
      }
      if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error('Offline fixture home must be canonical');
    }
    const codexHome = await realpath(configuredHome);
    if (codexHome !== configuredHome) throw new Error('Offline fixture home must be canonical');
    const homeStat = await lstat(codexHome);
    if (process.platform !== 'win32' && ((homeStat.mode & 0o077) !== 0
      || (process.getuid && homeStat.uid !== process.getuid()))) throw new Error('Offline fixture home must be private');
    if (!fixture.accounts.has(projectRoot)) fixture.accounts.set(projectRoot,
      Object.hasOwn(fixture.options, 'accountResponse') ? fixture.options.accountResponse : syntheticChatGptAccount());
    const threadId = `fixture-thread-${++this.nextClient}`;
    const turnId = `${threadId}-turn`;
    const peerId = `${projectRoot}:${threadId}`;
    const peerRequests: FixtureRequest[] = [];
    const controller = new AbortController();
    let closeCount = 0;
    const notifications = new Set<CodexNotificationListener>();
    const requests = new Set<CodexRequestListener>();
    const closeListeners = new Set<() => void>();
    let closed = false;
    let interrupted = false;
    let finished = false;
    let thread: Record<string, any> = {};
    const notify = (method: string, params: Record<string, unknown>) => {
      if (closed || (interrupted && method !== 'turn/completed')) return;
      for (const listener of notifications) {
        if (closed || (interrupted && method !== 'turn/completed')) break;
        listener(method, { threadId, turnId, ...params });
      }
    };
    const finish = (status: string, error?: string) => {
      if (finished || closed) return;
      finished = true;
      notify('turn/completed', { turn: { id: turnId, status, ...(error ? { error: { message: error } } : {}) } });
    };
    const run = async (turn: Record<string, any>) => {
      try {
        if (closed || interrupted) return;
        notify('turn/started', { turn: { id: turnId } });
        const messages = decodeInput(turn.input);
        const tools: FixtureTurn['tools'] = (thread.dynamicTools ?? []).map((tool: any) => ({ type: 'function', function: {
          name: tool.name, description: tool.description, parameters: tool.inputSchema,
        } }));
        for (let iteration = 0; iteration < 100 && !interrupted && !closed; iteration++) {
          const view: FixtureTurn = { thread, turn, messages: structuredClone(messages), tools, step: ++fixture.nextStep, signal: controller.signal };
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
            if (closed || interrupted) return;
            const callId = call.id ?? `${threadId}-call-${view.step}-${index}`;
            const params = { threadId, turnId, callId, tool: call.name, arguments: call.args };
            let response: any;
            for (const listener of requests) {
              if (closed || interrupted) return;
              const result = listener('item/tool/call', params);
              if (result !== undefined) { response = await result; break; }
            }
            if (closed || interrupted) return;
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
      } catch (error) {
        if (closed || finished) {
          // An ended peer cannot receive another terminal failure; preserve it for drain.
          if (!controller.signal.aborted || error !== controller.signal.reason) fixture.failures.push(error);
        } else finish('failed', error instanceof Error ? error.message : String(error));
      }
    };
    const client: CodexClient = {
      cwd: projectRoot, codexHome,
      get closed() { return closed; },
      async request<T>(method: string, raw: unknown = {}, options: CodexRequestOptions = {}): Promise<T> {
        if (closed) throw new Error('Codex app-server is closed');
        options.signal?.throwIfAborted();
        const params = raw as Record<string, any>;
        const request: FixtureRequest = { method, params: structuredClone(raw), peerId };
        fixture.requests.push(request); peerRequests.push(request);
        if (method === 'account/read') {
          const source = fixture.accounts.get(projectRoot);
          const response = typeof source === 'function' ? await source() : source;
          options.signal?.throwIfAborted();
          if (closed) throw new Error('Codex app-server is closed');
          return structuredClone(response) as T;
        }
        if (method === 'config/read') return { config: structuredClone(fixture.options.config ?? {}) } as T;
        if (method === 'model/list') return { data: [
          { id: 'fixture', model: 'fixture', displayName: 'Offline fixture',
            description: 'Deterministic synthetic offline model', hidden: false, isDefault: true,
            defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Synthetic medium effort' }] },
          { id: 'gpt-6.1-sol', model: 'gpt-6.1-sol', displayName: 'Synthetic gpt-6.1-sol',
            description: 'Synthetic model selection contract', hidden: false, isDefault: false,
            defaultReasoningEffort: 'ultra', supportedReasoningEfforts: [{ reasoningEffort: 'ultra', description: 'Synthetic ultra effort' }],
            serviceTiers: [{ id: 'priority', name: 'Priority', description: 'Synthetic priority tier' },
              { id: 'fast', name: 'Fast', description: 'Synthetic fast alias' }] },
        ], nextCursor: null } as T;
        if (method === 'thread/start') { thread = params; return { thread: { id: threadId }, model: params.model ?? 'fixture' } as T; }
        if (method === 'turn/start') {
          const task = new Promise<void>(resolve => setImmediate(resolve)).then(() => run(params));
          fixture.pending.add(task);
          // Install an immediate rejection observer; drain surfaces any transport-task failure.
          void task.then(() => fixture.pending.delete(task), error => {
            fixture.pending.delete(task); fixture.failures.push(error);
          });
          return { turn: { id: turnId } } as T;
        }
        if (method === 'turn/interrupt') { interrupted = true; controller.abort(new Error('Fixture turn interrupted')); finish('interrupted'); return {} as T; }
        throw new Error(`Unexpected fixture RPC: ${method}`);
      },
      onNotification(listener) { notifications.add(listener); return () => { notifications.delete(listener); }; },
      onRequest(listener) { requests.add(listener); return () => { requests.delete(listener); }; },
      onClose(listener) {
        closeListeners.add(listener);
        if (closed) queueMicrotask(() => {
          if (closeListeners.delete(listener)) {
            try { listener(); } catch (error) { fixture.failures.push(error); }
          }
        });
        return () => { closeListeners.delete(listener); };
      },
      async close() {
        if (closed) return;
        closed = true; closeCount++; controller.abort(new Error('Fixture peer closed'));
        for (const listener of closeListeners) {
          try { listener(); } catch (error) { fixture.failures.push(error); }
        }
        closeListeners.clear(); notifications.clear(); requests.clear();
      },
    };
    fixture.peers.push({ id: peerId, projectRoot, client, requests: peerRequests,
      get closed() { return closed; }, get closeCount() { return closeCount; } });
    return client;
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
