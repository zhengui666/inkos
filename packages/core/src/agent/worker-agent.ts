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
import { decodeStructuredFields } from "./structured-arguments.js";
import { preserveToolArgumentTypes, toolArgumentIssues } from "./tool-arguments.js";

export interface WorkerAgentOptions {
  /** Resolve the same persisted Codex account/model settings as the parent workflow. */
  readonly projectRoot?: string;
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

export async function runWorkerAgent(
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

/** Host-consumed state is accepted only through the validated Codex dynamic tool. */
export async function runWorkerAgentTool<TParameters extends TSchema>(
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
    maxOutputTokens: options.maxTokens ?? client.defaults?.maxTokens ?? 32_768,
    ...(client._codex?.settings ? { settings: client._codex.settings } : {}),
    initialState: {
      model,
      systemPrompt: [
        ...messages.filter(message => message.role === "system").map(message => message.content),
        `Finish by calling ${resultTool.name} exactly once. Do not print the result as prose or JSON.`,
        "If the tool reports a validation error, correct the identified fields and resubmit the complete result.",
      ].join("\n\n"),
      tools: [tool],
      messages: [],
    },
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
    options.signal?.throwIfAborted();
    while (!hasSubmitted && !exhausted()) {
      const failure = modelFailure(lastAssistant(agent.state.messages));
      if (failure) throw Object.assign(failure, { resultTool: resultTool.name, attempts: Math.max(modelTurns, resultAttempts) });
      await agent.prompt(`You did not call ${resultTool.name} successfully. Call it now with the complete corrected result.`);
      options.signal?.throwIfAborted();
    }
    if (!hasSubmitted) {
      const last = lastAssistant(agent.state.messages);
      const failure = lastValidationError ?? modelFailure(last);
      throw Object.assign(new Error(failure?.message ?? `Worker Agent completed without calling ${resultTool.name}`), {
        code: failure?.code ?? (resultAttempts > 0 ? "WORKER_RESULT_INVALID" : "WORKER_RESULT_MISSING"),
        attempts: Math.max(modelTurns, resultAttempts),
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
