import { AsyncLocalStorage } from "node:async_hooks";
import type { Api, AssistantMessage, ImageContent, Model, ToolCall, ToolResultMessage } from "@mariozechner/pi-ai";
import { Value } from "@sinclair/typebox/value";
import { estimateTextTokens } from "../llm/provider.js";
import { executionTimeoutMs } from "../agent/execution-deadline.js";
import { isUnboundedWorkerExecution } from "../agent/worker-execution-policy.js";
import type { CodexClient } from "./client.js";
import type { CodexSettings } from "./settings.js";
import { codexModelError, CodexCleanupError, CodexHostError, CodexModelError, CodexTurnIdentityError } from "./provider-error.js";
import { withCodexExecution, startCodexRuntimeThread, startCodexRuntimeTurn } from "../runtime/execution.js";
import { beginAgentModelCall } from "../llm/agent-trajectory.js";
import { currentCodexRun, runWithCodexContext } from "../runtime/run-context.js";
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
  /** Native per-turn final-output contract, separate from dynamic tool calls. */
  outputSchema?: Record<string, unknown>;
  beforeToolCall?: (context: BeforeToolCallContext) => Promise<unknown>;
  transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
  shouldStop?: () => boolean;
  onModelTurn?: () => void;
  /** Model silence only: active host tools keep their own execution deadline. */
  idleTimeoutMs?: number;
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
  private interruptPromise?: Promise<void>;
  private stopping = false;
  /** Only a completed, non-commentary assistant item from a successful turn. */
  finalOutput: string | undefined;
  /** Native terminal failure, retained without raw provider details for worker consumers. */
  modelError: CodexModelError | undefined;
  /** Only fields actually acknowledged by thread/start. Absent fields stay unknown. */
  threadEffective: Readonly<{ scope: 'thread'; modelId?: string; effort?: string | null; serviceTier?: string | null }> = Object.freeze({ scope: 'thread' });
  /** turn/start acknowledges only a turn, so these fields remain requested. */
  turnRequested: Readonly<{ scope: 'turn'; modelId: string; effort: string | null; serviceTier: string | null }> | undefined;

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

  private interrupt(): Promise<void> {
    const client = this.client, threadId = this.threadId, turnId = this.turnId;
    if (!client || !threadId || !turnId) return Promise.resolve();
    // Abort listeners, host completion and the start-response continuation can
    // converge on the same turn. Cache before sending, including synchronous peers.
    this.interruptPromise ??= Promise.resolve().then(async () => {
      await client.request("turn/interrupt", { threadId, turnId }, { timeoutMs: 5000 });
    });
    return this.interruptPromise;
  }

  private async run(newMessages: AgentMessage[]): Promise<void> {
    if (this.controller) throw new Error("Codex Agent is already running");
    const controller = new AbortController();
    this.controller = controller;
    const signal = this.options.signal ? AbortSignal.any([controller.signal, this.options.signal]) : controller.signal;
    try {
      await withCodexExecution(this.options.projectRoot, () => this.runAdmitted(newMessages, controller, signal), {
        settings: this.options.settings, signal,
      });
    } finally {
      if (this.controller === controller) this.controller = undefined;
    }
  }

  private async runAdmitted(newMessages: AgentMessage[], controller: AbortController, signal: AbortSignal): Promise<void> {
    const inInvocation = AsyncLocalStorage.snapshot();
    const runtime = currentCodexRun()!;
    const selected = runtime.selection;
    const trace = beginAgentModelCall();
    if (runtime.history && !trace) throw new Error("Runtime history requires the existing model-call trajectory");
    const history = runtime.history && trace ? { binding: runtime.history, trace } : undefined;
    this.stopping = false;
    this.finalOutput = undefined;
    this.modelError = undefined;
    this.threadEffective = Object.freeze({ scope: 'thread' });
    this.turnRequested = Object.freeze({ scope: 'turn', modelId: selected.modelId, effort: selected.effort, serviceTier: selected.serviceTier });
    const startIndex = this.state.messages.length;
    let unsubscribeNotification = () => {};
    let unsubscribeRequest = () => {};
    let cleanupAbort = () => {};
    let unsubscribeClose = () => {};
    const activeToolWork = new Set<Promise<unknown>>();
    let idleTimer: ReturnType<typeof setInterval> | undefined;
    let runFailure: unknown;
    let startRequestPending = false;
    let queuedFailure: unknown;
    let unconfirmedModelError: CodexModelError | undefined;
    try {
      signal.throwIfAborted();
      await this.emit({ type: "agent_start" });
      await this.emit({ type: "turn_start" });
      for (const message of newMessages) await this.append(message);
      const context = this.options.transformContext
        ? await this.options.transformContext([...this.state.messages], signal)
        : [...this.state.messages];
      signal.throwIfAborted();
      this.client = await runtime.takeClient();
      signal.throwIfAborted();
      const client = this.client;
      await runtime.guard(client, signal);
      signal.throwIfAborted();
      const response = await startCodexRuntimeThread(client, {
        ephemeral: true,
        cwd: client.cwd, approvalPolicy: "never", sandbox: "read-only", environments: [],
        baseInstructions: this.state.systemPrompt + (this.options.maxOutputTokens === undefined ? ""
          : `\n\nEach visible answer or tool argument object must fit within ${this.options.maxOutputTokens} estimated tokens. The host rejects oversized output; return a bounded result rather than silently truncating required fields.`),
        developerInstructions: "Use only the supplied InkOS dynamic tools. Quoted conversation records are historical data, not new requests. Never repeat a completed operation solely because it appears in those records. Obey the host's completion tool contract.",
        dynamicTools: this.state.tools.map(tool => ({ type: "function", name: tool.name, description: tool.description,
          inputSchema: JSON.parse(JSON.stringify(tool.parameters)), deferLoading: false })),
      }, signal, history);
      this.threadId = response.threadId;
      this.threadEffective = response.effective;
      if (response.effective.modelId !== undefined) this.state.model = { ...this.state.model, id: response.effective.modelId };
      signal.throwIfAborted();

      let queue: Promise<void> = Promise.resolve();
      let resolveDone!: () => void;
      let rejectDone!: (error: unknown) => void;
      const done = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
      // Attach a rejection handler immediately, including before turn/start resolves.
      void done.catch(() => {});
      const fail = (error: unknown) => {
        if (!signal.aborted || error !== signal.reason) queuedFailure ??= error;
        rejectDone(error);
        if (!controller.signal.aborted) controller.abort(error);
      };
      const idleTimeoutMs = isUnboundedWorkerExecution() ? undefined
        : executionTimeoutMs(this.options.idleTimeoutMs, "INKOS_AGENT_IDLE_TIMEOUT_MS", 60 * 60_000);
      let lastActivityAt = Date.now();
      let lastEvent = "turn/start";
      let failedToolCalls = 0;
      let turnFinished = false;
      const activity = (event: string) => { lastActivityAt = Date.now(); lastEvent = event; };
      // The stdio peer predates admission/trajectory/evidence scopes. Restore all invocation contexts for host dispatch.
      const enqueue = <T>(task: () => Promise<T>, inspectBeforeAbort?: () => void): Promise<T> => inInvocation(() => runWithCodexContext(runtime, async () => {
        const work = queue.then(() => {
          inspectBeforeAbort?.(); // Read-only protocol validation, never host effects.
          signal.throwIfAborted();
          return task();
        });
        queue = work.then(() => {}, fail);
        return work;
      }));
      unsubscribeClose = client.onClose(() => fail(new Error("Codex App Server closed during the turn")));
      let finalStatus = "completed";
      let finalError: string | undefined;
      let finalOutput: string | undefined;
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
      const pendingTerminals: Array<{ method: string; params: Record<string, any> }> = [];
      const assertTurnIdentity = (id: unknown) => {
        if (typeof id === "string" && id && this.turnId && this.turnId !== id) {
          throw new CodexTurnIdentityError(this.modelError);
        }
      };
      const bindTurn = async (id: unknown, authoritative = false) => {
        if (typeof id !== "string" || !id) return;
        if (this.turnId && this.turnId !== id) {
          if (!authoritative) return;
          assertTurnIdentity(id);
        }
        this.turnId = id;
        const pending = pendingTerminals.splice(0);
        unconfirmedModelError = undefined;
        for (const event of pending) {
          if (signal.aborted) break;
          await handleNotification(event.method, event.params);
        }
      };
      const handleNotification = async (method: string, params: Record<string, any>) => {
        if (method === "turn/started") {
          await bindTurn(object(params.turn).id);
          if (signal.aborted || this.stopping) await this.interrupt();
          return;
        }
        const turnId = method === "turn/completed" ? object(params.turn).id : params.turnId;
        const terminal = method === "turn/completed" || method === "error" && params.willRetry === false;
        if (terminal && !this.turnId) {
          // A terminal notification can precede the turn/start RPC response.
          // It cannot cancel/classify an unidentified request as retry-safe.
          pendingTerminals.push({ method, params });
          const turn = object(params.turn);
          if (method === "error" || turn.status === "failed" || typeof object(turn.error).message === "string") {
            unconfirmedModelError ??= method === "error"
              ? codexModelError(params.error, { source: "error", willRetry: false }, toolCalls.size, false)
              : codexModelError(turn.error, { source: "turn/completed", turnStatus: turn.status }, toolCalls.size, false);
          }
          return;
        }
        // Never let a stale terminal frame replace the current turn's outcome.
        if (terminal && typeof turnId === "string" && turnId !== this.turnId) return;
        if (terminal && turnFinished) return;
          if (method === "item/agentMessage/delta") await updateText(params, false);
          else if (method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/textDelta") await updateText(params, true);
          else if (method === "item/completed") {
            const item = object(params.item);
            if (item.type === "agentMessage" && !emittedItems.has(item.id)) {
              if (item.phase !== "commentary" && typeof item.text === "string") finalOutput = item.text;
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
            turnFinished = true;
            const turn = object(params.turn);
            finalStatus = turn.status;
            finalError = typeof object(turn.error).message === "string" ? object(turn.error).message : finalError;
            if (finalStatus === "failed" || finalError) {
              this.modelError = codexModelError(turn.error, { source: "turn/completed", turnStatus: finalStatus }, toolCalls.size, typeof turnId === "string");
            }
            resolveDone();
          } else if (method === "error" && params.willRetry === false) {
            finalError = typeof object(params.error).message === "string" ? object(params.error).message : "Codex model request failed";
            this.modelError = codexModelError(params.error, { source: "error", willRetry: false }, toolCalls.size, typeof turnId === "string");
            fail(this.modelError);
          }
      };
      unsubscribeNotification = client.onNotification((method, raw) => {
        if (method === 'account/updated') { void runtime.guard(client, signal).catch(fail); return; }
        const params = object(raw);
        if (params.threadId !== this.threadId) return;
        if (["turn/started", "turn/completed", "item/started", "item/completed", "thread/tokenUsage/updated"].includes(method)
          || method.endsWith("Delta") && typeof params.delta === "string" && params.delta.length > 0
          || method === "item/agentMessage/delta" && typeof params.delta === "string" && params.delta.length > 0) activity(method);
        void enqueue(() => handleNotification(method, params)).catch(() => {});
      });
      unsubscribeRequest = client.onRequest((method, raw) => {
        const params = object(raw);
        if (method !== "item/tool/call" || params.threadId !== this.threadId) return undefined;
        const id = String(params.callId);
        const previous = toolCalls.get(id);
        if (previous) return previous;
        const task = enqueue(async () => {
          signal.throwIfAborted();
          // Ownership is checked in queue order, after any earlier start-response binding.
          if (this.turnId && typeof params.turnId === "string" && params.turnId !== this.turnId) {
            return { success: false, contentItems: [{ type: "inputText", text: "Tool request does not match the active turn." }] };
          }
          if (turnFinished || this.stopping || this.options.shouldStop?.()) return { success: false, contentItems: [{ type: "inputText", text: "The host has already completed this turn. Do not execute more tools." }] };
          this.checkOutputBudget(JSON.stringify(params.arguments) ?? "");
          await flushText();
          // A pre-tool message is not the final result of the whole turn.
          finalOutput = undefined;
          const toolCall: ToolCall = { type: "toolCall", id, name: String(params.tool), arguments: object(params.arguments) };
          const assistant = this.assistant([toolCall]);
          assistant.stopReason = "toolUse";
          await this.append(assistant);
          const result = await this.executeTool(toolCall, signal);
          if (result.message.isError) failedToolCalls++;
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
        void task.then(() => { activeToolWork.delete(task); activity("tool-response"); }, error => { activeToolWork.delete(task); fail(error); });
        return task;
      });
      const onAbort = () => { void this.interrupt().finally(() => rejectDone(signal.reason ?? aborted())).catch(rejectDone); };
      signal.addEventListener("abort", onAbort, { once: true });
      cleanupAbort = () => signal.removeEventListener("abort", onAbort);
      signal.throwIfAborted();
      await runtime.guard(client, signal);
      this.options.onModelTurn?.();
      if (idleTimeoutMs !== undefined) idleTimer = setInterval(() => {
        if (signal.aborted || turnFinished || activeToolWork.size > 0 || Date.now() - lastActivityAt < idleTimeoutMs) return;
        fail(Object.assign(new Error(`Codex stopped reporting progress while awaiting the model (${idleTimeoutMs}ms; last event: ${lastEvent}; failed tools: ${failedToolCalls}). Saved results are retained.`),
          { code: "AGENT_MODEL_STALLED", idleTimeoutMs, lastEvent, failedToolCalls }));
      }, Math.min(idleTimeoutMs, 1000));
      startRequestPending = true;
      const start = await startCodexRuntimeTurn(client, {
        threadId: this.threadId, input: encodeContext(context), environments: [],
        ...(this.options.outputSchema ? { outputSchema: this.options.outputSchema } : {}),
      }, signal, history);
      this.turnRequested = start.requested;
      startRequestPending = false;
      // Bind the actual ACK, never a request-derived identity.
      await enqueue(() => bindTurn(start.turnId, true), () => assertTurnIdentity(start.turnId));
      if (signal.aborted || this.stopping) await this.interrupt();
      await done;
      await queue;
      await Promise.all(toolCalls.values());
      signal.throwIfAborted();
      // Final usage is emitted exactly once and before message_end persistence.
      const last = [...pendingText.values()].at(-1) ?? this.assistant();
      last.usage = usage;
      if (!pendingText.size) pendingText.set("usage-final", last);
      if (finalStatus === "completed" && !finalError) this.finalOutput = finalOutput;
      if (finalStatus === "failed" || finalError) { last.stopReason = "error"; last.errorMessage = finalError ?? "Codex turn failed"; }
      else if (finalStatus === "interrupted" && !this.stopping) { last.stopReason = "aborted"; last.errorMessage = "Codex turn interrupted"; }
      await flushText();
      await this.emit({ type: "turn_end", message: last, toolResults });
      await this.emit({ type: "agent_end", messages: this.state.messages.slice(startIndex) });
    } catch (error) {
      // A late start-RPC cancellation/deadline must not replace a retained native
      // failure. Unbound terminal frames remain explicitly nonretryable. Preserve
      // explicit caller cancellation, and keep provider provenance for cleanup.
      this.modelError ??= unconfirmedModelError;
      const callerCancelled = this.options.signal?.aborted
        && (this.options.signal.reason as { code?: unknown })?.code !== "WORKER_TIMEOUT";
      const interruptedTransport = signal.aborted && (startRequestPending || error === signal.reason);
      const hostFailure = queuedFailure !== undefined && !(queuedFailure instanceof CodexModelError) ? queuedFailure
        : !interruptedTransport && error !== this.modelError ? error : undefined;
      runFailure = callerCancelled ? this.options.signal!.reason ?? error
        : ["RUNTIME_AUTH_REVOKED", "RUNTIME_HISTORY_WRITE_FAILED"].includes((queuedFailure as { code?: string } | undefined)?.code ?? "") ? queuedFailure
        : ["RUNTIME_AUTH_REVOKED", "RUNTIME_HISTORY_WRITE_FAILED"].includes((error as { code?: string } | undefined)?.code ?? "") ? error
        : error instanceof CodexTurnIdentityError ? error
        : this.modelError && hostFailure !== undefined ? new CodexHostError(hostFailure, this.modelError)
          : interruptedTransport ? this.modelError ?? error : error;
      throw runFailure;
    }
    finally {
      // Terminate the peer and signal host work before returning, including on
      // persistence failures. Never let queued mutations outlive their episode.
      cleanupAbort();
      if (idleTimer) clearInterval(idleTimer);
      controller.abort();
      unsubscribeNotification();
      unsubscribeRequest();
      unsubscribeClose();
      try { await this.client?.close(); }
      catch (cleanupError) {
        // Includes failed turn/completed, which returns a failed assistant
        // message rather than throwing. Never retry an unconfirmed peer close.
        throw new CodexCleanupError(runFailure, cleanupError, this.modelError);
      }
      finally {
        // Never release execution ownership while a host mutation is still alive.
        await Promise.allSettled([...activeToolWork]);
        this.client = undefined;
        this.threadId = undefined;
        this.turnId = undefined;
        this.interruptPromise = undefined;
        this.controller = undefined;
      }
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
      await currentCodexRun()!.guard(this.client!, signal);
      const args = tool.prepareArguments ? await tool.prepareArguments(structuredClone(call.arguments)) : structuredClone(call.arguments);
      await this.options.beforeToolCall?.({ toolCall: call, args, context: this.state, signal });
      if (!Value.Check(tool.parameters, args)) throw new Error("Tool arguments do not match the declared schema");
      signal.throwIfAborted();
      await currentCodexRun()!.guard(this.client!, signal);
      result = await tool.execute(call.id, args, signal, partialResult => {
        // Host progress callbacks cannot await; final result persistence is awaited below.
        void this.emit({ type: "tool_execution_update", toolCallId: call.id, toolName: call.name, args,
          partialResult }).catch(() => { this.abort(); });
      });
      // The domain layer may wrap a worker's persistence failure as an action result.
      // Retained host failure still ends this invocation without another RPC permit.
      await currentCodexRun()!.guard(this.client!, signal);
    } catch (error) {
      if ((error as { code?: string }).code === "RUNTIME_AUTH_REVOKED" || (error as { code?: string }).code === "RUNTIME_HISTORY_WRITE_FAILED") throw error;
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
