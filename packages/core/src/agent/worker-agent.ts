import { Agent } from "../codex/agent.js";
import type { AgentTool, AgentToolResult } from "../codex/contracts.js";
import type { Api, AssistantMessage, Message, Model } from "@mariozechner/pi-ai";
import type { Static, TSchema } from "@sinclair/typebox";
import {
  createStreamMonitor,
  type LLMClient,
  type LLMMessage,
  type LLMResponse,
  type OnStreamProgress,
} from "../llm/provider.js";
import { resolveCodexModel } from "../codex/model.js";
import { recordExecutionEvidence } from "../harness/execution-evidence.js";
import { decodeWorkerOutput, workerOutputSchema } from "./worker-output.js";
import { decodeStructuredFields } from "./structured-arguments.js";
import { preserveToolArgumentTypes, toolArgumentIssues } from "./tool-arguments.js";

export interface WorkerAgentOptions {
  /** Resolve the same persisted Codex account/model settings as the parent workflow. */
  readonly projectRoot?: string;
  /** Total worker deadline, including correction turns; overrides INKOS_WORKER_TIMEOUT_MS (default: one hour). */
  readonly timeoutMs?: number;
  /** @deprecated Codex controls sampling; retained for source compatibility and not sent. */
  readonly temperature?: number;
  /** Estimated visible output/tool-argument limit enforced by InkOS before acceptance. */
  readonly maxTokens?: number;
  /** @deprecated Worker native web tools are disabled; use the host research capability. */
  readonly webSearch?: boolean;
  readonly onStreamProgress?: OnStreamProgress;
  readonly onTextDelta?: (text: string) => void;
  readonly signal?: AbortSignal;
  readonly onUsage?: (usage: LLMResponse["usage"]) => void;
}

export interface WorkerResultTool<TParameters extends TSchema> {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly parameters: TParameters;
  readonly validate?: (parameters: Static<TParameters>) => Static<TParameters> | Promise<Static<TParameters>>;
}

const EMPTY_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const MAX_RESULT_ATTEMPTS = 3;

function toAgentMessages(messages: ReadonlyArray<LLMMessage>, model: Model<Api>): Message[] {
  return messages
    .filter((message) => message.role !== "system")
    .map((message): Message => message.role === "user"
      ? { role: "user", content: message.content, timestamp: Date.now() }
      : {
          role: "assistant",
          content: [{ type: "text", text: message.content }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { ...EMPTY_COST, total: 0 } },
          stopReason: "stop",
          timestamp: Date.now(),
        });
}

function usageFrom(messages: ReadonlyArray<Message>): NonNullable<LLMResponse["usage"]> {
  return messages.reduce((usage, message) => {
    if (message.role === "assistant") {
      usage.promptTokens += message.usage.input;
      usage.completionTokens += message.usage.output;
      usage.totalTokens += message.usage.totalTokens;
    }
    return usage;
  }, { promptTokens: 0, completionTokens: 0, totalTokens: 0 });
}

function lastAssistant(messages: ReadonlyArray<Message>): AssistantMessage | undefined {
  return [...messages].reverse().find((message): message is AssistantMessage => message.role === "assistant");
}

function modelFailure(message: AssistantMessage | undefined): (Error & { code: string }) | undefined {
  if (!message) return;
  if (message.stopReason === "length") {
    return Object.assign(new Error("Worker output reached the configured model output limit"), { code: "MODEL_OUTPUT_LIMIT" });
  }
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    return Object.assign(new Error(message.errorMessage ?? `Worker Agent stopped: ${message.stopReason}`), {
      code: (message as AssistantMessage & { errorCode?: string }).errorCode ?? "WORKER_MODEL_ERROR",
    });
  }
}

function watchWorker(agent: Agent, options: WorkerAgentOptions, resultTool?: string): () => void {
  const monitor = createStreamMonitor(progress => {
    options.onStreamProgress?.(progress);
    recordExecutionEvidence("model-stream-progress", { ...(resultTool ? { resultTool } : {}), ...progress });
  });
  const abortAgent = () => agent.abort();
  options.signal?.addEventListener("abort", abortAgent, { once: true });
  const unsubscribe = agent.subscribe(event => {
    if (event.type === "tool_execution_start") monitor.onChunk(JSON.stringify(event.args));
    if (event.type !== "message_update") return;
    const update = event.assistantMessageEvent;
    if (update.type === "text_delta" || update.type === "toolcall_delta") monitor.onChunk(update.delta);
    if (update.type === "text_delta") options.onTextDelta?.(update.delta);
  });
  return () => {
    unsubscribe();
    monitor.stop();
    options.signal?.removeEventListener("abort", abortAgent);
  };
}

async function runTextWorker(
  client: LLMClient,
  _modelId: string,
  messages: ReadonlyArray<LLMMessage>,
  options: WorkerAgentOptions = {},
): Promise<LLMResponse> {
  options.signal?.throwIfAborted();
  const model = resolveCodexModel(client._codex?.settings);
  const promptMessages = toAgentMessages(messages, model);
  if (promptMessages.length === 0) throw new Error("Worker Agent requires at least one non-system message");
  const agent = new Agent({
    projectRoot: options.projectRoot ?? client._codex?.projectRoot ?? process.cwd(),
    signal: options.signal,
    maxOutputTokens: options.maxTokens ?? client.defaults?.maxTokens ?? 32_768,
    ...(client._codex?.settings ? { settings: client._codex.settings } : {}),
    initialState: {
      model,
      systemPrompt: messages.filter(message => message.role === "system").map(message => message.content).join("\n\n"),
      tools: [],
      messages: [],
    },
  });
  const stopWatching = watchWorker(agent, options);
  try {
    options.signal?.throwIfAborted();
    await agent.prompt(promptMessages);
    options.signal?.throwIfAborted();
    const responseMessages = agent.state.messages.slice(promptMessages.length);
    const final = lastAssistant(responseMessages);
    if (!final) throw new Error("Worker Agent completed without an assistant response");
    const failure = modelFailure(final);
    if (failure) throw failure;
    const usage = usageFrom(responseMessages);
    options.onUsage?.(usage);
    return {
      content: final.content.filter(part => part.type === "text").map(part => part.text).join(""),
      usage,
    };
  } catch (error) {
    options.signal?.throwIfAborted();
    throw error;
  } finally {
    stopWatching();
  }
}

/** Both declared result transports share the same schema and domain validation. */
async function runStructuredWorker<TParameters extends TSchema>(
  client: LLMClient,
  _modelId: string,
  messages: ReadonlyArray<LLMMessage>,
  resultTool: WorkerResultTool<TParameters>,
  options: WorkerAgentOptions = {},
): Promise<Static<TParameters>> {
  options.signal?.throwIfAborted();
  const model = resolveCodexModel(client._codex?.settings);
  const promptMessages = toAgentMessages(messages, model);
  if (promptMessages.length === 0) throw new Error("Structured Worker Agent requires at least one non-system message");
  let submitted: Static<TParameters> | undefined;
  let hasSubmitted = false;
  let modelTurns = 0;
  let resultAttempts = 0;
  let lastValidationError: (Error & { code?: string }) | undefined;
  const exhausted = () => resultAttempts >= MAX_RESULT_ATTEMPTS || modelTurns >= MAX_RESULT_ATTEMPTS;
  const { validate, ...toolDefinition } = resultTool;
  const tool: AgentTool<TParameters, Static<TParameters>> = {
    ...toolDefinition,
    prepareArguments: async params => {
      options.signal?.throwIfAborted();
      if (hasSubmitted || resultAttempts >= MAX_RESULT_ATTEMPTS) {
        throw Object.assign(new Error("Structured worker submission limit reached"), { code: "WORKER_RESULT_INVALID" });
      }
      resultAttempts += 1;
      const decodedPaths: string[] = [];
      const decoded = decodeStructuredFields(resultTool.parameters, params, decodedPaths);
      if (decodedPaths.length) recordExecutionEvidence("worker-arguments-decoded", { resultTool: resultTool.name, paths: decodedPaths });
      const issues = toolArgumentIssues(resultTool.parameters, decoded);
      if (issues.length) {
        const failure = { code: "WORKER_SCHEMA_INVALID", resultTool: resultTool.name, issues };
        recordExecutionEvidence("worker-result-invalid", failure);
        lastValidationError = Object.assign(new Error(JSON.stringify(failure)), { code: "WORKER_RESULT_INVALID" });
        throw lastValidationError;
      }
      return decoded as Static<TParameters>;
    },
    execute: async (_toolCallId, params): Promise<AgentToolResult<Static<TParameters>>> => {
      options.signal?.throwIfAborted();
      try {
        // prepareArguments has already validated without coercion. Preserve union
        // scalar types instead of converting the supplied JSON with Value.Parse.
        const result = validate ? await validate(params) : params;
        options.signal?.throwIfAborted();
        submitted = result;
        hasSubmitted = true;
      } catch (error) {
        lastValidationError = error instanceof Error ? error : new Error(String(error));
        recordExecutionEvidence("worker-result-invalid", {
          code: lastValidationError.code ?? "WORKER_DOMAIN_INVALID",
          resultTool: resultTool.name,
          message: lastValidationError.message,
        });
        throw error;
      }
      return { content: [{ type: "text", text: "Structured result received by the host." }], details: submitted! };
    },
  };
  const agent = new Agent({
    projectRoot: options.projectRoot ?? client._codex?.projectRoot ?? process.cwd(),
    signal: options.signal,
    maxOutputTokens: options.maxTokens ?? client.defaults?.maxTokens ?? 32_768,
    ...(client._codex?.settings ? { settings: client._codex.settings } : {}),
    initialState: {
      model,
      systemPrompt: [
        ...messages.filter(message => message.role === "system").map(message => message.content),
        `Return the complete result through the native outputSchema envelope: resultJson is a JSON-serialized argument object for ${resultTool.name}. The tool schema defines the required contents. Do not output prose or Markdown.`,
        `Result argument JSON Schema: ${JSON.stringify(resultTool.parameters)}`,
        `Alternatively, call ${resultTool.name} for immediate host validation. A successful submission completes this operation; never submit it again.`,
        "If the tool reports a validation error, correct the identified fields and resubmit the complete result.",
      ].join("\n\n"),
      tools: [tool],
      messages: [],
    },
    outputSchema: workerOutputSchema(resultTool.name),
    beforeToolCall: preserveToolArgumentTypes,
    onModelTurn: () => { modelTurns += 1; },
    // This is checked after each dynamic-tool response, including within a single
    // Codex turn, so repeated invalid submissions cannot create an unbounded loop.
    shouldStop: () => hasSubmitted || resultAttempts >= MAX_RESULT_ATTEMPTS,
  });
  const stopWatching = watchWorker(agent, options, resultTool.name);
  try {
    options.signal?.throwIfAborted();
    await agent.prompt(promptMessages);
    const acceptFinalOutput = async () => {
      options.signal?.throwIfAborted();
      const failure = modelFailure(lastAssistant(agent.state.messages));
      if (failure) throw Object.assign(failure, { resultTool: resultTool.name, attempts: Math.max(modelTurns, resultAttempts) });
      if (hasSubmitted || resultAttempts >= MAX_RESULT_ATTEMPTS || !agent.finalOutput?.trim()) return;
      try {
        const parameters = decodeWorkerOutput(agent.finalOutput);
        const prepared = await tool.prepareArguments!(parameters as Static<TParameters>);
        // Execute the host's result validator, not a simulated model tool call.
        await tool.execute("structured-output", prepared as Static<TParameters>, options.signal);
        recordExecutionEvidence("worker-result-accepted", { resultTool: resultTool.name, transport: "outputSchema" });
      } catch (error) {
        options.signal?.throwIfAborted();
        lastValidationError = error instanceof Error ? error : new Error(String(error));
      }
    };
    await acceptFinalOutput();
    while (!hasSubmitted && !exhausted()) {
      await agent.prompt(`No valid ${resultTool.name} result was accepted. Return the complete corrected result through the declared outputSchema envelope or the result tool.${lastValidationError ? ` Validation feedback: ${lastValidationError.message}` : ""}`);
      await acceptFinalOutput();
    }
    if (!hasSubmitted) {
      const last = lastAssistant(agent.state.messages);
      const failure = modelFailure(last) ?? lastValidationError;
      const rejectedTools = agent.state.messages.filter(message => message.role === "toolResult" && message.isError).length;
      throw Object.assign(new Error(failure?.message ?? `Worker completed without a valid ${resultTool.name} result (model turns: ${modelTurns}; submissions: ${resultAttempts}; rejected tools: ${rejectedTools})`), {
        code: failure?.code ?? (resultAttempts > 0 ? "WORKER_RESULT_INVALID" : "WORKER_RESULT_MISSING"),
        attempts: Math.max(modelTurns, resultAttempts),
        submissions: resultAttempts, rejectedTools,
        resultTool: resultTool.name,
        stopReason: last?.stopReason,
        lastToolError: [...agent.state.messages].reverse().find(message => message.role === "toolResult" && message.isError),
        lastAssistantText: last?.content.filter(part => part.type === "text").map(part => part.text).join(""),
      });
    }
    options.onUsage?.(usageFrom(agent.state.messages));
    return submitted!;
  } catch (error) {
    options.signal?.throwIfAborted();
    throw error;
  } finally {
    stopWatching();
  }
}

async function withWorkerDeadline<T>(options: WorkerAgentOptions, run: (bounded: WorkerAgentOptions) => Promise<T>): Promise<T> {
  // Resolve in the host, not the sanitized Codex child environment. Keep one
  // budget across correction turns rather than resetting it for every request.
  const configured = process.env.INKOS_WORKER_TIMEOUT_MS?.trim();
  const timeoutMs = options.timeoutMs ?? (configured ? Number(configured) : 60 * 60_000);
  // Node clamps overflowing timers to 1ms, which would immediately kill a worker.
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw new Error("Worker timeout (timeoutMs / INKOS_WORKER_TIMEOUT_MS) must be an integer between 1 and 2147483647 milliseconds");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(Object.assign(new Error("Worker exceeded its execution deadline"), {
    code: "WORKER_TIMEOUT",
  })), timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  try { return await run({ ...options, signal }); }
  finally { clearTimeout(timer); }
}

export function runWorkerAgent(client: LLMClient, modelId: string, messages: ReadonlyArray<LLMMessage>, options: WorkerAgentOptions = {}): Promise<LLMResponse> {
  return withWorkerDeadline(options, bounded => runTextWorker(client, modelId, messages, bounded));
}

export function runWorkerAgentTool<TParameters extends TSchema>(client: LLMClient, modelId: string,
  messages: ReadonlyArray<LLMMessage>, resultTool: WorkerResultTool<TParameters>, options: WorkerAgentOptions = {}): Promise<Static<TParameters>> {
  return withWorkerDeadline(options, bounded => runStructuredWorker(client, modelId, messages, resultTool, bounded));
}
