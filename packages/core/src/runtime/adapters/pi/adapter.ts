import { estimateTextTokens } from "../../../llm/provider.js";
import type {
  PiAdapterDeps, PiErrorCode, PiEvent, PiResourceLoader, PiRunHandle, PiRunResult,
  PiRunSpec, PiSdkEvent, PiSdkSession, PiToolFailure, PiSdkAssistantMessage,
} from "./contracts.js";
import { PiUsageLedger, toHostEvent, toHostMessages, toPiMessages } from "./message-bridge.js";
import { bridgeTools } from "./tool-bridge.js";

/** An explicit empty loader bypasses all native discovery, including extension and MCP startup. */
export function createHostResourceLoader(systemPrompt: string, runtime: unknown): PiResourceLoader {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => { throw new Error("Pi native resource discovery is disabled"); },
    reload: async () => {},
  };
}

const errorMessages: Record<PiErrorCode, string> = {
  PI_LISTENER_FAILED: "Pi host event persistence failed",
  PI_TOOL_FAILED: "Pi host tool failed",
  PI_MODEL_FAILED: "Pi model response failed",
  PI_OUTPUT_LIMIT: "Pi output exceeded the host estimated token budget",
  PI_SDK_FAILED: "Pi SDK lifecycle failed",
};

export async function createPiAdapter(spec: PiRunSpec, deps: PiAdapterDeps): Promise<PiRunHandle> {
  if (spec.provider !== "openai" || !spec.modelId || !(deps.modelRuntime && typeof deps.modelRuntime === "object")) {
    throw new Error("Pi requires an explicitly resolved OpenAI model and runtime");
  }
  if ("speed" in spec) throw new Error("Pi speed must be rejected by the host configuration layer");
  if (deps.sdk.version !== "1.1.0") throw new Error("Pi SDK port requires version 1.1.0");
  if (spec.maxOutputTokens !== undefined && (!Number.isInteger(spec.maxOutputTokens) || spec.maxOutputTokens < 1)) {
    throw new Error("Pi host output budget must be a positive integer");
  }
  const listeners = new Set<(event: PiEvent) => void | Promise<void>>();
  const controller = new AbortController();
  const signal = spec.signal ? AbortSignal.any([spec.signal, controller.signal]) : controller.signal;
  const hostWork = new Set<Promise<unknown>>();
  const suppressedCalls = new Set<string>();
  const toolFailures = new Map<string, PiToolFailure>();
  const settledToolFailures = new Map<string, PiToolFailure>();
  const preparedFailures = new Map<string, PiToolFailure[]>();
  let eventQueue: Promise<void> = Promise.resolve();
  let failure: PiErrorCode | undefined;
  let completion = false;
  let disposed = false;
  let closing = false;
  let session: PiSdkSession | undefined;
  let active: Promise<PiRunResult> | undefined;
  let last: PiRunResult | undefined;
  let abortWork: Promise<void> | undefined;
  let disposeWork: Promise<void> | undefined;
  let usage = new PiUsageLedger();
  let responseSequence = 0;
  let responseKey: string | undefined;
  type Response = { accepted?: PiSdkAssistantMessage; limited?: boolean };
  let responses: Response[] = [];
  let currentResponse: Response | undefined;
  const messageResponses = new WeakMap<object, Response>();
  const identifiedResponses = new Map<string, Response>();
  let runStart = 0;
  let budgetStopped = false;

  const fail = (code: PiErrorCode) => { failure ??= code; };
  const blocked = () => completion || failure !== undefined || signal.aborted || closing;
  const drainEvents = async () => {
    // An SDK event or host update can append while a prior queue item is awaited.
    let tail: Promise<void>;
    do { tail = eventQueue; await tail; } while (tail !== eventQueue);
  };
  const track = <T>(work: Promise<T>): Promise<T> => {
    hostWork.add(work);
    void work.then(() => hostWork.delete(work), () => hostWork.delete(work));
    return work;
  };
  const drainHost = async () => {
    while (hostWork.size) await Promise.allSettled([...hostWork]);
    await drainEvents();
  };
  const customTools = bridgeTools(spec.tools, {
    signal: () => signal, blocked, drainEvents, track,
    context: () => ({ messages: structuredClone(session?.agent.state.messages ?? []) }),
    guard: async (context, toolSignal) => {
      try { await deps.beforeToolCall?.(context, toolSignal); }
      catch { if (!signal.aborted) fail("PI_TOOL_FAILED"); throw new Error(errorMessages.PI_TOOL_FAILED); }
    },
    complete: () => { completion = true; },
    reportFailure(name, id, toolFailure) {
      if (id) toolFailures.set(id, toolFailure);
      else preparedFailures.set(name, [...(preparedFailures.get(name) ?? []), toolFailure]);
      if (toolFailure.kind === "fatal" && !blocked()) fail("PI_TOOL_FAILED");
    },
  });
  let sessionManager: ReturnType<PiAdapterDeps["sdk"]["sessionInMemory"]>;
  let model: unknown;
  try {
    sessionManager = deps.sdk.sessionInMemory();
    // Reconstruct the official session tree from InkOS's committed transcript, never just agent.state.
    for (const message of toPiMessages(spec.initialMessages)) sessionManager.appendMessage(message);
    model = deps.sdk.resolveModel(deps.modelRuntime, spec.provider, spec.modelId);
  } catch { throw new Error(errorMessages.PI_SDK_FAILED); }
  if (!model) throw new Error("Pi resolved model is unavailable");
  try {
    ({ session } = await deps.sdk.createAgentSession({
      modelRuntime: deps.modelRuntime, model, thinkingLevel: spec.thinkingLevel,
      settingsManager: deps.sdk.settingsInMemory({ cacheWarming: "off", retry: { enabled: false, provider: { maxRetries: 0 } },
        compaction: { enabled: false }, enableSkillCommands: false }),
      sessionManager, resourceLoader: createHostResourceLoader(spec.systemPrompt, deps.sdk.createExtensionRuntime()),
      tools: customTools.map(tool => tool.name), customTools,
    }));
  } catch { throw new Error(errorMessages.PI_SDK_FAILED); }
  const sdkSession = session;
  sdkSession.agent.toolExecution = "sequential";
  const previousBefore = sdkSession.agent.beforeToolCall;
  sdkSession.agent.beforeToolCall = async (context, sdkSignal) => {
    if (blocked()) {
      suppressedCalls.add(context.toolCall.id);
      return { block: true, reason: "Pi host tool execution is closed", terminate: true };
    }
    return previousBefore?.(context, sdkSignal);
  };
  const previousFinish = sdkSession.agent.finishTurn;
  sdkSession.agent.finishTurn = async (turn, sdkSignal) => {
    const previous = await previousFinish?.(turn, sdkSignal);
    return blocked() ? { action: "end" } : previous;
  };

  const requestAbort = (): Promise<void> => {
    // Never await idle/session.abort from the core's own awaited listener.
    try { sdkSession.agent.abort(); } catch { fail("PI_SDK_FAILED"); }
    abortWork ??= Promise.resolve().then(() => sdkSession.abort()).catch(() => { fail("PI_SDK_FAILED"); });
    return abortWork;
  };

  const boundedMessages = (messages: typeof sdkSession.agent.state.messages, start = 0, firstResponse = 0) => {
    let responseIndex = firstResponse;
    return messages.map((message, index) => {
      if (message.role !== "assistant" || index < start) return message;
      const record = messageResponses.get(message) ?? (message.responseId ? identifiedResponses.get(message.responseId) : undefined)
        ?? responses[responseIndex];
      responseIndex++;
      if (!record?.limited) return message;
      return { ...message, content: structuredClone(record.accepted?.content ?? []), stopReason: "aborted" as const,
        errorMessage: errorMessages.PI_OUTPUT_LIMIT };
    });
  };

  const observe = (event: PiSdkEvent) => {
    const messages = event.type === "agent_end" ? event.messages
      : "message" in event ? [event.message] : [];
    for (const message of messages) if (message.role === "assistant") {
      if (event.type === "message_start") {
        responseKey = `response:${++responseSequence}`;
        currentResponse = message.responseId ? identifiedResponses.get(message.responseId) : undefined;
        if (!currentResponse) { currentResponse = {}; responses.push(currentResponse); }
      }
      // Full turn/agent snapshots repeat already observed messages and may have no provider responseId.
      if (event.type === "message_start" || event.type === "message_update" || event.type === "message_end") {
        responseKey ??= `response:${++responseSequence}`;
        if (!currentResponse) { currentResponse = {}; responses.push(currentResponse); }
        messageResponses.set(message, currentResponse);
        if (message.responseId) identifiedResponses.set(message.responseId, currentResponse);
        usage.observe(message, responseKey, event.type === "message_end");
      }
      if (message.stopReason === "error") fail("PI_MODEL_FAILED");
      if (message.stopReason === "length" && event.type === "message_end") fail("PI_MODEL_FAILED");
      if ((event.type === "message_end" || event.type === "agent_end" || event.type === "turn_end")
        && (message.stopReason === "pending" || message.stopReason === "deferred")) fail("PI_MODEL_FAILED");
      if (message.stopReason === "aborted" && !signal.aborted) fail("PI_MODEL_FAILED");
      if (spec.maxOutputTokens !== undefined) {
        const text = message.content.map(block => block.type === "text" ? block.text
          : block.type === "toolCall" ? JSON.stringify(block.arguments) : "").join("");
        if (estimateTextTokens(text) > spec.maxOutputTokens || budgetStopped) {
          if (currentResponse) currentResponse.limited = true;
          fail("PI_OUTPUT_LIMIT");
          if (!budgetStopped) { budgetStopped = true; void requestAbort(); }
        } else if (currentResponse && ["message_start", "message_update", "message_end"].includes(event.type)) {
          currentResponse.accepted = structuredClone(message);
        }
      }
      if (event.type === "message_end") { responseKey = undefined; currentResponse = undefined; }
    }
    if (event.type === "message_update" && event.assistantMessageEvent && typeof event.assistantMessageEvent === "object") {
      const update = event.assistantMessageEvent as { type?: string; reason?: string };
      if (update.type === "response.failed" || (update.type === "error" && !(signal.aborted && update.reason === "aborted"))) fail("PI_MODEL_FAILED");
    }
    if (event.type === "tool_execution_end") {
      const pending = preparedFailures.get(event.toolName);
      const toolFailure = toolFailures.get(event.toolCallId) ?? pending?.shift();
      toolFailures.delete(event.toolCallId);
      // The SDK wraps sync preparation errors into content and drops their classification.
      // Retain the host classification by call id, never infer trusted feedback from that content.
      if (event.isError && toolFailure) settledToolFailures.set(event.toolCallId, toolFailure);
      else settledToolFailures.delete(event.toolCallId);
      if (event.isError && !suppressedCalls.has(event.toolCallId) && !blocked() && toolFailure?.kind !== "recoverable") fail("PI_TOOL_FAILED");
    }
  };
  const unsubscribe = sdkSession.agent.subscribe((event) => {
    const work = eventQueue.then(async () => {
      // AgentSession.prompt may still be in async preflight when the first abort finds an idle core.
      if (event.type === "agent_start" && signal.aborted) {
        sdkSession.agent.abort();
        // The official loop still invokes streamFn with an aborted signal unless startup is interrupted.
        throw new Error("Pi run cancelled before model startup");
      }
      observe(event);
      if (budgetStopped && ["message_start", "message_update", "tool_execution_start", "tool_execution_update"].includes(event.type)) return;
      const bounded = budgetStopped && event.type === "agent_end" ? { ...event, messages: boundedMessages(event.messages) }
        : budgetStopped && (event.type === "message_end" || event.type === "turn_end")
          // Single-message terminal snapshots belong to the latest response, even when the SDK clones it without an id.
          ? { ...event, message: boundedMessages([event.message], 0, responses.length - 1)[0] } : event;
      let translated: PiEvent | undefined;
      try { translated = toHostEvent(bounded as PiSdkEvent, settledToolFailures); }
      catch { fail("PI_SDK_FAILED"); throw new Error(errorMessages.PI_SDK_FAILED); }
      if (!translated) return;
      for (const listener of [...listeners]) {
        try { await listener(structuredClone(translated)); }
        catch { fail("PI_LISTENER_FAILED"); throw new Error(errorMessages.PI_LISTENER_FAILED); }
      }
    });
    // Retain the failure separately even if the official loop absorbs listener rejection.
    eventQueue = work.catch(() => {});
    return work;
  });
  const result = (): PiRunResult => ({
    status: failure ? "failed" : signal.aborted ? "cancelled" : "completed",
    messages: toHostMessages(boundedMessages(sdkSession.agent.state.messages, runStart), false, settledToolFailures), usage: usage.total(),
    ...(failure ? { error: { code: failure, message: errorMessages[failure] } } : {}),
  });
  const onAbort = () => { void requestAbort(); };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) await requestAbort();

  const settle = async () => {
    if (abortWork) await abortWork;
    // Idle failures must not skip host work or durable event writes.
    try { await sdkSession.agent.waitForIdle(); } catch { fail("PI_SDK_FAILED"); }
    try { await sdkSession.waitForIdle(); } catch { fail("PI_SDK_FAILED"); }
    await drainHost();
  };

  const run = (operation: () => Promise<void>): Promise<PiRunResult> => {
    if (disposed || closing) return Promise.reject(new Error("Pi adapter is disposed"));
    if (active) return Promise.reject(new Error("Pi adapter is already running"));
    if (failure || completion || signal.aborted) return Promise.resolve(last ?? result());
    usage = new PiUsageLedger();
    responseKey = undefined;
    responses = []; currentResponse = undefined; identifiedResponses.clear();
    runStart = sdkSession.agent.state.messages.length;
    active = (async () => {
      // Reserve active before any operation/abort callback may run.
      await Promise.resolve();
      try { if (!signal.aborted) await operation(); }
      catch { if (!signal.aborted && !failure) fail("PI_SDK_FAILED"); }
      await settle();
      if (sdkSession.agent.state.errorMessage && !signal.aborted) fail("PI_MODEL_FAILED");
      return last = result();
    })();
    const pending = active;
    void pending.then(() => { active = undefined; }, () => { active = undefined; });
    return pending;
  };
  const waitForSettled = async () => {
    if (active) return active;
    await settle();
    if (!last && !signal.aborted) throw new Error("No Pi run has started");
    if (failure) return last = result();
    return last ?? (last = result());
  };
  const abort = async () => {
    controller.abort();
    await requestAbort();
    return waitForSettled();
  };
  return {
    subscribe(listener) {
      if (disposed || closing) throw new Error("Pi adapter is disposed");
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    prompt: (text, images) => run(() => sdkSession.prompt(text, { expandPromptTemplates: false, images })),
    continue: () => run(() => sdkSession.agent.continue()),
    abort, waitForSettled,
    dispose() {
      if (disposeWork) return disposeWork;
      closing = true;
      disposeWork = (async () => {
        await abort();
        await drainHost();
        unsubscribe();
        signal.removeEventListener("abort", onAbort);
        listeners.clear();
        try { await sdkSession.dispose(); }
        catch { fail("PI_SDK_FAILED"); throw new Error(errorMessages.PI_SDK_FAILED); }
        finally { disposed = true; }
      })();
      return disposeWork;
    },
  };
}
