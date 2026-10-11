import type {
  PiAssistantMessage, PiMessage, PiSdkEvent, PiSdkPort, PiSdkSession, PiToolResult,
} from "../contracts.js";

export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export function assistant(content: PiAssistantMessage["content"] = [], extra: Partial<PiAssistantMessage> = {}): PiAssistantMessage {
  return { role: "assistant", content, api: "openai-responses", provider: "openai", model: "fixture-model",
    timestamp: 100, stopReason: "stop", ...extra };
}
export type FakePlan = (session: FakeSession) => Promise<void>;

/** Fixture contract only. It deliberately models awaited core listeners and non-awaited session listeners. */
export class FakeSession implements PiSdkSession {
  readonly controller = new AbortController();
  readonly listeners = new Set<(event: PiSdkEvent, signal: AbortSignal) => void | Promise<void>>();
  readonly sessionListeners = new Set<(event: PiSdkEvent) => void>();
  readonly log: string[] = [];
  disposeCount = 0;
  abortCount = 0;
  runCount = 0;
  finishDecision: unknown;
  promptOptions: unknown;
  private running?: Promise<void>;
  agent: PiSdkSession["agent"];
  constructor(readonly options: Parameters<PiSdkPort["createAgentSession"]>[0], readonly plan: FakePlan) {
    this.agent = {
      state: { messages: structuredClone(options.sessionManager.buildSessionContext().messages) },
      toolExecution: "parallel",
      subscribe: listener => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; },
      continue: () => this.run(),
      abort: () => { this.controller.abort(); },
      waitForIdle: () => this.waitForIdle(),
    };
  }
  subscribe(listener: (event: PiSdkEvent) => void): () => void {
    this.sessionListeners.add(listener); return () => { this.sessionListeners.delete(listener); };
  }
  async emit(event: PiSdkEvent) {
    this.log.push(event.type);
    for (const listener of this.sessionListeners) listener(event);
    for (const listener of this.listeners) await listener(event, this.controller.signal);
  }
  async append(message: PiMessage) {
    await this.emit({ type: "message_start", message });
    this.agent.state.messages.push(message);
    this.options.sessionManager.appendMessage(message);
    await this.emit({ type: "message_end", message });
  }
  async call(name: string, id: string, raw: unknown): Promise<PiToolResult> {
    const tool = this.options.customTools.find(tool => tool.name === name && this.options.tools.includes(name));
    const toolCall = { type: "toolCall" as const, id, name, arguments: raw as Record<string, unknown> };
    let result: PiToolResult;
    try {
      if (!tool) throw new Error("Fixture tool outside allowlist");
      const args = tool.prepareArguments(raw);
      const before = await this.agent.beforeToolCall?.({ toolCall, args, context: { messages: this.agent.state.messages } }, this.controller.signal);
      if (before?.block) throw new Error(before.reason);
      await this.emit({ type: "tool_execution_start", toolCallId: id, toolName: name, args });
      result = await tool.execute(id, args, this.controller.signal, partialResult => {
        void this.emit({ type: "tool_execution_update", toolCallId: id, toolName: name, args, partialResult }).catch(() => {});
      });
    } catch (error) {
      result = { content: [{ type: "text", text: error instanceof Error ? error.message : "Fixture failure" }], details: {}, isError: true };
    }
    await this.emit({ type: "tool_execution_end", toolCallId: id, toolName: name, result, isError: !!result.isError });
    await this.append({ role: "toolResult", toolCallId: id, toolName: name, content: result.content,
      details: result.details, isError: !!result.isError, timestamp: 200 });
    return result;
  }
  prompt(text: string, options: Parameters<PiSdkSession["prompt"]>[1]) {
    this.promptOptions = options;
    return this.run({ role: "user", content: options.images?.length ? [{ type: "text", text }, ...options.images] : text, timestamp: 50 });
  }
  private run(input?: PiMessage): Promise<void> {
    this.runCount++;
    const start = this.agent.state.messages.length;
    this.running = (async () => {
      await this.emit({ type: "agent_start" });
      await this.emit({ type: "turn_start" });
      if (input) await this.append(input);
      await this.plan(this);
      this.finishDecision = await this.agent.finishTurn?.({}, this.controller.signal);
      await this.emit({ type: "agent_end", messages: this.agent.state.messages.slice(start) });
      this.log.push("settled");
    })();
    return this.running;
  }
  async abort() { this.abortCount++; this.controller.abort(); await this.waitForIdle(); }
  async waitForIdle() { if (this.running) await this.running.catch(() => {}); }
  dispose() { this.disposeCount++; this.log.push("disposed"); }
}

export function fakeSdk(plan: FakePlan = async session => { await session.append(assistant([{ type: "text", text: "fixture answer" }])); }) {
  let session!: FakeSession;
  const restored: PiMessage[] = [];
  const settings: unknown[] = [];
  const port: PiSdkPort = {
    version: "1.1.0", resolveModel: (_runtime, provider, modelId) => ({ provider, id: modelId }),
    createExtensionRuntime: () => ({ fixture: true }),
    settingsInMemory: value => { settings.push(value); return value; },
    sessionInMemory: () => ({
      appendMessage: message => { restored.push(structuredClone(message)); },
      buildSessionContext: () => ({ messages: structuredClone(restored) }),
    }),
    createAgentSession: async options => { session = new FakeSession(options, plan); return { session }; },
  };
  return { port, settings, restored, get session() { return session; } };
}
