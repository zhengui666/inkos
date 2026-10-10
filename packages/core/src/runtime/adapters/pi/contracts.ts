import type { AssistantMessage, ImageContent, TextContent, ToolCall, ToolResultMessage } from "@mariozechner/pi-ai";
import type { AgentEvent, AgentMessage, AgentTool, AgentToolResult } from "../../../codex/contracts.js";

export type { AgentTool, AgentToolResult } from "../../../codex/contracts.js";

/** No auth, paths or environment enter this boundary; the dependency owner supplies the runtime. */
export type PiModelRuntime = object;
export type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export interface PiAssistantMessage extends Omit<AssistantMessage, "usage"> {
  usage?: AssistantMessage["usage"];
  responseId?: string;
}
export interface PiSdkAssistantMessage extends Omit<PiAssistantMessage, "stopReason"> {
  stopReason: PiAssistantMessage["stopReason"] | "pending" | "deferred";
}
export type PiHostMessage = Exclude<AgentMessage, AssistantMessage> | PiAssistantMessage;
export interface PiSystemMessage {
  role: "system"; content?: string | TextContent[]; sections?: Record<string, string | null>;
  toolsAdded?: unknown[]; toolsRemoved?: { name: string }[]; timestamp: number;
}
export type PiMessage = Exclude<PiHostMessage, PiAssistantMessage> | PiSdkAssistantMessage | PiSystemMessage;
export type PiEvent =
  | Exclude<AgentEvent, { type: "agent_end" | "turn_end" | "message_start" | "message_update" | "message_end" }>
  | { type: "agent_end"; messages: PiHostMessage[] }
  | { type: "turn_end"; message: PiAssistantMessage; toolResults: ToolResultMessage[] }
  | { type: "message_start"; message: PiHostMessage }
  | { type: "message_end"; message: PiHostMessage }
  | { type: "message_update"; message: PiAssistantMessage; assistantMessageEvent: unknown };
export type PiSdkEvent =
  | Exclude<PiEvent, { type: "agent_end" | "message_start" | "message_end" | "message_update" | "turn_end" }>
  | { type: "agent_end"; messages: PiMessage[] }
  | { type: "message_start"; message: PiMessage }
  | { type: "message_end"; message: PiMessage }
  | { type: "message_update"; message: PiSdkAssistantMessage; assistantMessageEvent: unknown }
  | { type: "turn_end"; message: PiSdkAssistantMessage; toolResults: ToolResultMessage[] };
export type PiToolFailure =
  | { kind: "recoverable"; category: "validation" | "read"; feedback?: string }
  | { kind: "fatal"; category: "owner" | "guard" | "persistence" | "auth" | "cancelled" | "uncertain" | "tool"; feedback?: string };
/** Only explicitly reviewed host feedback, never arbitrary Error.message, may reach the model. */
export class PiHostToolError extends Error {
  constructor(readonly failure: PiToolFailure) { super("Pi host tool failed"); }
}
export interface PiToolResult extends AgentToolResult { isError?: boolean; failure?: PiToolFailure }
export interface PiHostTool extends AgentTool {
  /** Host declares completion semantics; success is latched only after execute resolves. */
  completesRun?: (result: PiToolResult) => boolean;
  classifyFailure?: (errorOrResult: unknown, phase: "prepare" | "execute") => PiToolFailure | undefined;
}
export interface PiRunSpec {
  provider: "openai";
  modelId: string;
  thinkingLevel: PiThinkingLevel;
  systemPrompt: string;
  initialMessages: PiHostMessage[];
  tools: PiHostTool[];
  /** Estimated visible text/tool-argument guard per response; never forwarded as a service-side hard limit. */
  maxOutputTokens?: number;
  signal?: AbortSignal;
}
export interface PiToolContext {
  toolCall: ToolCall;
  args: unknown;
  context: { messages: PiMessage[] };
}
export interface PiSdkTool extends Omit<AgentTool, "execute" | "prepareArguments"> {
  executionMode: "sequential";
  prepareArguments(args: unknown): unknown;
  execute(id: string, args: unknown, signal?: AbortSignal, onUpdate?: (result: AgentToolResult) => void): Promise<PiToolResult>;
}
/** Structural port, not an ambient SDK declaration. Bind it explicitly after installing the official package. */
export interface PiSdkPort {
  version: "1.1.0";
  resolveModel(runtime: PiModelRuntime, provider: "openai", modelId: string): unknown;
  createExtensionRuntime(): unknown;
  settingsInMemory(settings: {
    cacheWarming: "off"; retry: { enabled: false; provider: { maxRetries: 0 } };
    compaction: { enabled: false }; enableSkillCommands: false;
  }): unknown;
  sessionInMemory(): PiSessionManager;
  createAgentSession(options: {
    modelRuntime: PiModelRuntime; model: unknown; thinkingLevel: PiThinkingLevel;
    resourceLoader: PiResourceLoader; settingsManager: unknown; sessionManager: PiSessionManager;
    tools: string[]; customTools: PiSdkTool[];
  }): Promise<{ session: PiSdkSession }>;
}
export interface PiResourceLoader {
  getExtensions(): { extensions: never[]; errors: never[]; runtime: unknown };
  getSkills(): { skills: never[]; diagnostics: never[] };
  getPrompts(): { prompts: never[]; diagnostics: never[] };
  getThemes(): { themes: never[]; diagnostics: never[] };
  getAgentsFiles(): { agentsFiles: never[] };
  getSystemPrompt(): string;
  getSystemPromptSource(): undefined;
  getAppendSystemPrompt(): never[];
  getAppendSystemPromptSources(): never[];
  extendResources(paths: unknown): void;
  reload(): Promise<void>;
}
export interface PiSessionManager {
  appendMessage(message: PiMessage): unknown;
  buildSessionContext(): { messages: PiMessage[] };
}
export interface PiSdkSession {
  agent: {
    state: { messages: PiMessage[]; errorMessage?: string };
    toolExecution: "sequential" | "parallel";
    beforeToolCall?: (context: PiToolContext, signal?: AbortSignal) => Promise<{ block?: boolean; reason?: string; terminate?: boolean } | undefined>;
    finishTurn?: (turn: unknown, signal?: AbortSignal) => { action: "end" | "continue" } | void | Promise<{ action: "end" | "continue" } | void>;
    subscribe(listener: (event: PiSdkEvent, signal: AbortSignal) => void | Promise<void>): () => void;
    continue(): Promise<void>;
    abort(): void;
    /** Direct continuation bypasses AgentSession's prompt activity tracking. */
    waitForIdle(): Promise<void>;
  };
  prompt(text: string, options: { expandPromptTemplates: false; images?: ImageContent[] }): Promise<void>;
  abort(): Promise<void>;
  waitForIdle(): Promise<void>;
  dispose(): void | Promise<void>;
}
export interface PiAdapterDeps {
  sdk: PiSdkPort;
  modelRuntime: PiModelRuntime;
  beforeToolCall?: (context: PiToolContext, signal: AbortSignal) => void | Promise<void>;
}
export type PiErrorCode = "PI_LISTENER_FAILED" | "PI_TOOL_FAILED" | "PI_MODEL_FAILED" | "PI_OUTPUT_LIMIT" | "PI_SDK_FAILED";
export interface PiRunResult {
  status: "completed" | "cancelled" | "failed";
  messages: PiHostMessage[];
  usage?: Partial<Pick<AssistantMessage["usage"], "input" | "output" | "cacheRead" | "cacheWrite" | "totalTokens">>;
  error?: { code: PiErrorCode; message: string };
}
export interface PiRunHandle {
  subscribe(listener: (event: PiEvent) => void | Promise<void>): () => void;
  prompt(text: string, images?: ImageContent[]): Promise<PiRunResult>;
  continue(): Promise<PiRunResult>;
  abort(): Promise<PiRunResult>;
  waitForSettled(): Promise<PiRunResult>;
  dispose(): Promise<void>;
}
