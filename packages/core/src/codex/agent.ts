import type { Api, AssistantMessage, ImageContent, Model, ToolCall, ToolResultMessage } from "@mariozechner/pi-ai";
import { Value } from "@sinclair/typebox/value";
import { estimateTextTokens } from "../llm/provider.js";
import { createCodexClient, type CodexClient } from "./client.js";
import { readCodexSettings, type CodexSettings } from "./settings.js";
import type { AgentEvent, AgentMessage, AgentTool, AgentToolResult, BeforeToolCallContext } from "./contracts.js";

interface AgentState {
  model: Model<Api>;
  systemPrompt: string;
  tools: AgentTool[];
  messages: AgentMessage[];
}

export interface CodexAgentOptions {
  projectRoot: string;
  initialState: AgentState;
  settings?: CodexSettings;
  signal?: AbortSignal;
  /** Host-enforced estimated visible-output budget; not an unsupported Codex API parameter. */
  maxOutputTokens?: number;
  beforeToolCall?: (context: BeforeToolCallContext) => Promise<unknown>;
  transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
  shouldStop?: () => boolean;
  onModelTurn?: () => void;
}

const emptyUsage = (): AssistantMessage["usage"] => ({
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});
const object = (value: unknown): Record<string, any> => value && typeof value === "object" ? value as Record<string, any> : {};
const aborted = () => new DOMException("Agent turn aborted", "AbortError");

/**
 * Codex owns the model/tool loop; InkOS owns tools, permissions and persistence.
 * Each invocation gets an ephemeral, isolated thread. Prior messages are quoted
 * records, never re-executed calls. The committed InkOS transcript is canonical.
 */
export class Agent {
  readonly state: AgentState;
  private readonly listeners = new Set<(event: AgentEvent) => void | Promise<void>>();
  private controller?: AbortController;
  private client?: CodexClient;
  private threadId?: string;
  private turnId?: string;
  private stopping = false;

  constructor(private readonly options: CodexAgentOptions) {
    if (options.maxOutputTokens !== undefined && (!Number.isInteger(options.maxOutputTokens) || options.maxOutputTokens < 1)) {
      throw new Error("Codex output budget must be a positive integer");
    }
    this.state = { ...options.initialState, messages: [...options.initialState.messages] };
  }

  private checkOutputBudget(text: string): void {
    if (this.options.maxOutputTokens !== undefined && estimateTextTokens(text) > this.options.maxOutputTokens) {
      throw Object.assign(new Error("Worker output exceeded the host's configured estimated token budget"), {
        code: "MODEL_OUTPUT_LIMIT", stopReason: "length",
      });
    }
  }

  subscribe(listener: (event: AgentEvent) => void | Promise<void>): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  abort(): void {
    this.controller?.abort(aborted());
    void this.interrupt().catch(() => { /* Closing the transport below also stops the turn. */ });
  }

  clearAllQueues(): void { /* Runs have no queued model input. */ }

  async prompt(input: string | AgentMessage[], images: ImageContent[] = []): Promise<void> {
    const messages: AgentMessage[] = typeof input === "string"
      ? [{ role: "user", content: images.length ? [{ type: "text", text: input }, ...images] : input, timestamp: Date.now() }]
      : input;
    await this.run(messages);
  }

  async continue(): Promise<void> { await this.run([]); }

  private async emit(event: AgentEvent): Promise<void> {
    // Persistence listeners are awaited before tool execution/turn completion.
    // A listener failure fails this run rather than losing durable receipts.
    for (const listener of this.listeners) await listener(event);
  }

  private assistant(content: AssistantMessage["content"] = []): AssistantMessage {
    return { role: "assistant", content, api: "openai-responses", provider: "openai",
      model: this.state.model.id, timestamp: Date.now(), stopReason: "stop", usage: emptyUsage() };
  }

  private async append(message: AgentMessage, started = false): Promise<void> {
    if (!started) await this.emit({ type: "message_start", message });
    this.state.messages.push(message);
    await this.emit({ type: "message_end", message });
  }

  private async interrupt(): Promise<void> {
    if (this.client && this.threadId && this.turnId) {
      await this.client.request("turn/interrupt", { threadId: this.threadId, turnId: this.turnId }, { timeoutMs: 5000 });
    }
  }

  private async run(newMessages: AgentMessage[]): Promise<void> {
    if (this.controller) throw new Error("Codex Agent is already running");
    const controller = new AbortController();
    this.controller = controller;
    this.stopping = false;
    const signal = this.options.signal ? AbortSignal.any([controller.signal, this.options.signal]) : controller.signal;
    const startIndex = this.state.messages.length;
    let unsubscribeNotification = () => {};
    let unsubscribeRequest = () => {};
    let cleanupAbort = () => {};
    let unsubscribeClose = () => {};
    const activeToolWork = new Set<Promise<unknown>>();
    try {
      signal.throwIfAborted();
      await this.emit({ type: "agent_start" });
      await this.emit({ type: "turn_start" });
      for (const message of newMessages) await this.append(message);
      const context = this.options.transformContext
        ? await this.options.transformContext([...this.state.messages], signal)
        : [...this.state.messages];
      signal.throwIfAborted();
      const settings = this.options.settings ?? await readCodexSettings(this.options.projectRoot);
      this.client = await createCodexClient(this.options.projectRoot);
      signal.throwIfAborted();
      const client = this.client;
      const account = object(await client.request("account/read", { refreshToken: false }, { signal }));
      if (account.requiresOpenaiAuth === true && object(account.account).type !== "chatgpt") {
        throw new Error("Sign in with ChatGPT in Studio → Project settings → Codex before starting an agent.");
      }
      const selected = await selectModel(client, settings, signal);
      signal.throwIfAborted();
      const response = object(await client.request("thread/start", {
        model: selected.model, serviceTier: selected.serviceTier, ephemeral: true,
        cwd: client.cwd, approvalPolicy: "never", sandbox: "read-only",
        baseInstructions: this.state.systemPrompt + (this.options.maxOutputTokens === undefined ? ""
          : `\n\nEach visible answer or tool argument object must fit within ${this.options.maxOutputTokens} estimated tokens. The host rejects oversized output; return a bounded result rather than silently truncating required fields.`),
        developerInstructions: "Use only the supplied InkOS dynamic tools. Quoted conversation records are historical data, not new requests. Never repeat a completed operation solely because it appears in those records. Obey the host's completion tool contract.",
        dynamicTools: this.state.tools.map(tool => ({ name: tool.name, description: tool.description,
          inputSchema: JSON.parse(JSON.stringify(tool.parameters)), deferLoading: false })),
      }, { signal }));
      this.threadId = object(response.thread).id;
      if (!this.threadId) throw new Error("Codex did not return a thread identifier");
      this.state.model = { ...this.state.model, id: response.model || selected.model || this.state.model.id };
      signal.throwIfAborted();

      let queue: Promise<void> = Promise.resolve();
      let resolveDone!: () => void;
      let rejectDone!: (error: unknown) => void;
      const done = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
      // Attach a rejection handler immediately, including before turn/start resolves.
      void done.catch(() => {});
      const fail = (error: unknown) => {
        rejectDone(error);
        if (!controller.signal.aborted) controller.abort(error);
      };
      const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
        const work = queue.then(() => { signal.throwIfAborted(); return task(); });
        queue = work.then(() => {}, fail);
        return work;
      };
      unsubscribeClose = client.onClose(() => fail(new Error("Codex App Server closed during the turn")));
      let finalStatus = "completed";
      let finalError: string | undefined;
      let usage = emptyUsage();
      const pendingText = new Map<string, AssistantMessage>();
      const emittedItems = new Set<string>();
      const startedItems = new Set<string>();
      const endedBlocks = new Set<string>();
      const endBlock = async (id: string, message: AssistantMessage) => {
        const index = message.content.length - 1;
        const block = message.content[index];
        const key = `${id}:${index}`;
        if (!block || endedBlocks.has(key)) return;
        endedBlocks.add(key);
        if (block.type === "text" || block.type === "thinking") {
          await this.emit({ type: "message_update", message, assistantMessageEvent: {
            type: block.type === "text" ? "text_end" : "thinking_end", contentIndex: index,
            content: block.type === "text" ? block.text : block.thinking, partial: message,
          } });
        }
      };
      const toolCalls = new Map<string, Promise<unknown>>();
      const toolResults: ToolResultMessage[] = [];
      const flushText = async () => {
        for (const [id, message] of pendingText) {
          pendingText.delete(id);
          if (emittedItems.has(id)) continue;
          emittedItems.add(id);
          await endBlock(id, message);
          await this.append(message, startedItems.has(id));
        }
      };
      const updateText = async (params: Record<string, any>, thinking: boolean) => {
        const id = String(params.itemId ?? "assistant");
        if (emittedItems.has(id)) return;
        let message = pendingText.get(id);
        if (!message) {
          message = this.assistant(); pendingText.set(id, message); startedItems.add(id);
          await this.emit({ type: "message_start", message });
        }
        const delta = typeof params.delta === "string" ? params.delta : "";
        const last = message.content.at(-1);
        const kind = thinking ? "thinking" : "text";
        if (last?.type !== kind || endedBlocks.has(`${id}:${message.content.length - 1}`)) {
          await endBlock(id, message);
          message.content.push(thinking ? { type: "thinking", thinking: "" } : { type: "text", text: "" });
          await this.emit({ type: "message_update", message, assistantMessageEvent: {
            type: thinking ? "thinking_start" : "text_start", contentIndex: message.content.length - 1, partial: message,
          } });
        }
        const block = message.content.at(-1)!;
        if (block.type === "thinking") block.thinking += delta;
        else if (block.type === "text") block.text += delta;
        this.checkOutputBudget(message.content.filter(part => part.type === "text").map(part => part.text).join(""));
        await this.emit({ type: "message_update", message,
          assistantMessageEvent: { type: thinking ? "thinking_delta" : "text_delta", contentIndex: message.content.length - 1, delta, partial: message } });
      };
      unsubscribeNotification = client.onNotification((method, raw) => {
        const params = object(raw);
        if (params.threadId !== this.threadId) return;
        void enqueue(async () => {
          if (method === "turn/started") {
            this.turnId = object(params.turn).id;
            if (signal.aborted || this.stopping) await this.interrupt();
          } else if (method === "item/agentMessage/delta") await updateText(params, false);
          else if (method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/textDelta") await updateText(params, true);
          else if (method === "item/completed") {
            const item = object(params.item);
            if (item.type === "agentMessage" && !emittedItems.has(item.id)) {
              const message = pendingText.get(item.id) ?? this.assistant();
              this.checkOutputBudget(typeof item.text === "string" ? item.text : "");
              message.content = [{ type: "text", text: typeof item.text === "string" ? item.text : "" }];
              pendingText.set(item.id, message);
              await endBlock(item.id, message);
            } else if (item.type === "reasoning") {
              const message = pendingText.get(item.id);
              if (message) await endBlock(item.id, message);
            }
          } else if (method === "thread/tokenUsage/updated") {
            const tokens = object(object(params.tokenUsage).total ?? object(params.tokenUsage).last);
            usage = { ...emptyUsage(), input: Number(tokens.inputTokens) || 0, output: Number(tokens.outputTokens) || 0,
              cacheRead: Number(tokens.cachedInputTokens) || 0, cacheWrite: Number(tokens.cacheWriteInputTokens) || 0,
              totalTokens: Number(tokens.totalTokens) || 0 };
          } else if (method === "turn/completed") {
            const turn = object(params.turn);
            finalStatus = turn.status;
            finalError = typeof object(turn.error).message === "string" ? object(turn.error).message : undefined;
            resolveDone();
          } else if (method === "error" && params.willRetry === false) {
            finalError = typeof object(params.error).message === "string" ? object(params.error).message : "Codex model request failed";
          }
        }).catch(() => {});
      });
      unsubscribeRequest = client.onRequest((method, raw) => {
        const params = object(raw);
        if (method !== "item/tool/call" || params.threadId !== this.threadId) return undefined;
        const id = String(params.callId);
        const previous = toolCalls.get(id);
        if (previous) return previous;
        const task = enqueue(async () => {
          signal.throwIfAborted();
          if (this.stopping || this.options.shouldStop?.()) return { success: false, contentItems: [{ type: "inputText", text: "The host has already completed this turn. Do not execute more tools." }] };
          this.checkOutputBudget(JSON.stringify(params.arguments) ?? "");
          await flushText();
          const toolCall: ToolCall = { type: "toolCall", id, name: String(params.tool), arguments: object(params.arguments) };
          const assistant = this.assistant([toolCall]);
          assistant.stopReason = "toolUse";
          await this.append(assistant);
          const result = await this.executeTool(toolCall, signal);
          toolResults.push(result.message);
          await this.append(result.message);
          if (this.options.shouldStop?.()) {
            this.stopping = true;
            // Schedule after the JSON-RPC tool response has been written.
            setImmediate(() => { void this.interrupt().catch(fail); });
          }
          return result.response;
        });
        toolCalls.set(id, task);
        activeToolWork.add(task);
        void task.then(() => { activeToolWork.delete(task); }, error => { activeToolWork.delete(task); fail(error); });
        return task;
      });
      const onAbort = () => { void this.interrupt().finally(() => rejectDone(signal.reason ?? aborted())).catch(rejectDone); };
      signal.addEventListener("abort", onAbort, { once: true });
      cleanupAbort = () => signal.removeEventListener("abort", onAbort);
      signal.throwIfAborted();
      this.options.onModelTurn?.();
      const start = object(await client.request("turn/start", {
        threadId: this.threadId, input: encodeContext(context),
        ...(selected.effort ? { effort: selected.effort } : {}),
        serviceTier: selected.serviceTier,
        // Some catalog models default to Fast. Explicit Standard must override
        // that default rather than merely clearing the sticky thread setting.
        serviceTierForTurn: selected.serviceTier ?? "default",
      }, { signal }));
      this.turnId = object(start.turn).id ?? this.turnId;
      if (signal.aborted || this.stopping) await this.interrupt();
      await done;
      await queue;
      await Promise.all(toolCalls.values());
      signal.throwIfAborted();
      // Final usage is emitted exactly once and before message_end persistence.
      const last = [...pendingText.values()].at(-1) ?? this.assistant();
      last.usage = usage;
      if (!pendingText.size) pendingText.set("usage-final", last);
      if (finalStatus === "failed") { last.stopReason = "error"; last.errorMessage = finalError ?? "Codex turn failed"; }
      else if (finalStatus === "interrupted" && !this.stopping) { last.stopReason = "aborted"; last.errorMessage = "Codex turn interrupted"; }
      await flushText();
      await this.emit({ type: "turn_end", message: last, toolResults });
      await this.emit({ type: "agent_end", messages: this.state.messages.slice(startIndex) });
    } finally {
      // Terminate the peer and signal host work before returning, including on
      // persistence failures. Never let queued mutations outlive their episode.
      cleanupAbort();
      controller.abort();
      unsubscribeNotification();
      unsubscribeRequest();
      unsubscribeClose();
      await this.client?.close();
      await Promise.allSettled([...activeToolWork]);
      this.client = undefined;
      this.threadId = undefined;
      this.turnId = undefined;
      this.controller = undefined;
    }
  }

  private async executeTool(call: ToolCall, signal: AbortSignal): Promise<{ message: ToolResultMessage; response: unknown }> {
    const tool = this.state.tools.find(candidate => candidate.name === call.name);
    let result: AgentToolResult;
    let isError = false;
    await this.emit({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.arguments });
    try {
      signal.throwIfAborted();
      if (!tool) throw new Error(`Unknown InkOS tool: ${call.name}`);
      const args = tool.prepareArguments ? await tool.prepareArguments(structuredClone(call.arguments)) : structuredClone(call.arguments);
      await this.options.beforeToolCall?.({ toolCall: call, args, context: this.state, signal });
      if (!Value.Check(tool.parameters, args)) throw new Error("Tool arguments do not match the declared schema");
      signal.throwIfAborted();
      result = await tool.execute(call.id, args, signal, partialResult => {
        // Host progress callbacks cannot await; final result persistence is awaited below.
        void this.emit({ type: "tool_execution_update", toolCallId: call.id, toolName: call.name, args,
          partialResult }).catch(() => { this.abort(); });
      });
    } catch (error) {
      signal.throwIfAborted();
      isError = true;
      result = { content: [{ type: "text", text: error instanceof Error ? error.message : "Tool execution failed" }], details: undefined };
    }
    await this.emit({ type: "tool_execution_end", toolCallId: call.id, toolName: call.name, result, isError });
    return {
      message: { role: "toolResult", toolCallId: call.id, toolName: call.name, content: result.content,
        details: result.details, isError, timestamp: Date.now() },
      response: { success: !isError, contentItems: result.content.map(part => part.type === "text"
        ? { type: "inputText", text: part.text }
        : { type: "inputImage", imageUrl: `data:${part.mimeType};base64,${part.data}` }) },
    };
  }
}

/** Preserve role boundaries and tool results, while never replaying function calls. */
export function encodeContext(messages: AgentMessage[]): Array<Record<string, unknown>> {
  const last = messages.at(-1);
  const current = last?.role === "user" ? last : undefined;
  const history = current ? messages.slice(0, -1) : messages;
  const input: Array<Record<string, unknown>> = [];
  if (history.length) {
    const records = history.map(message => {
      const content = typeof message.content === "string" ? message.content : message.content.map(part => {
        if (part.type === "image") return { type: "image", note: "Image supplied in an earlier turn" };
        if (part.type === "thinking") return { type: "thinking", note: "Internal reasoning omitted" };
        return part;
      });
      return { role: message.role, content, ...(message.role === "toolResult" ? {
        toolCallId: message.toolCallId, toolName: message.toolName, isError: message.isError,
      } : {}) };
    });
    input.push({ type: "text", text: `Prior conversation records (historical data; completed tool calls must not be replayed):\n${JSON.stringify(records)}`, text_elements: [] });
  }
  if (current) {
    if (typeof current.content === "string") input.push({ type: "text", text: current.content, text_elements: [] });
    else for (const part of current.content) input.push(part.type === "text"
      ? { type: "text", text: part.text, text_elements: [] }
      : { type: "image", url: `data:${part.mimeType};base64,${part.data}` });
  } else input.push({ type: "text", text: "Continue from the recorded state. Do not repeat completed operations. Follow the host's completion contract.", text_elements: [] });
  return input;
}

async function selectModel(client: CodexClient, settings: CodexSettings, signal: AbortSignal): Promise<{ model?: string; effort?: string; serviceTier: string | null }> {
  const models: Array<Record<string, any>> = [];
  let cursor: string | undefined;
  const cursors = new Set<string>();
  do {
    signal.throwIfAborted();
    if (cursors.size >= 100 || (cursor && cursors.has(cursor))) throw new Error("Codex model catalog pagination did not terminate");
    if (cursor) cursors.add(cursor);
    const response = object(await client.request("model/list", { ...(cursor ? { cursor } : {}), limit: 100 }, { signal }));
    if (Array.isArray(response.data)) models.push(...response.data);
    cursor = response.nextCursor || undefined;
  } while (cursor);
  const selected = settings.model ? models.find(model => model.model === settings.model || model.id === settings.model)
    : models.find(model => model.isDefault) ?? models[0];
  if (!selected) throw new Error("The configured Codex model is unavailable. Sign in and choose an available model in Codex settings.");
  const effort = settings.reasoningEffort ?? selected.defaultReasoningEffort;
  if (effort && !selected.supportedReasoningEfforts?.some((option: Record<string, unknown>) => option.reasoningEffort === effort)) {
    throw new Error("The configured reasoning effort is unsupported by this Codex model. Update Codex settings.");
  }
  const tier = settings.serviceTier;
  if (tier && tier !== "default" && !selected.serviceTiers?.some((option: Record<string, unknown>) => option.id === tier)
    && !selected.additionalSpeedTiers?.includes(tier)) throw new Error("The configured speed is unsupported by this Codex model. Update Codex settings.");
  return { model: selected.model, effort, serviceTier: !tier || tier === "default" ? null : tier };
}
