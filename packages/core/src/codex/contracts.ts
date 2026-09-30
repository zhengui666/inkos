import type {
  AssistantMessage,
  AssistantMessageEvent,
  ImageContent,
  Message,
  TextContent,
  ToolCall,
  ToolResultMessage,
} from "@mariozechner/pi-ai";
import type { Static, TSchema } from "@sinclair/typebox";

/** InkOS's persisted message shape, independent of an agent-loop implementation. */
export type AgentMessage = Message;

export interface AgentToolResult<TDetails = unknown> {
  content: Array<TextContent | ImageContent>;
  details: TDetails;
}

export type AgentToolUpdateCallback<TDetails = unknown> = (partialResult: AgentToolResult<TDetails>) => void;

/** Host-owned domain tools exposed to Codex as dynamic tools. */
export interface AgentTool<TParameters extends TSchema = TSchema, TDetails = unknown> {
  name: string;
  label: string;
  description: string;
  parameters: TParameters;
  prepareArguments?: (argumentsValue: unknown) => Static<TParameters> | Promise<Static<TParameters>>;
  execute(
    toolCallId: string,
    params: Static<TParameters>,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<TDetails>,
  ): Promise<AgentToolResult<TDetails>>;
}

export interface BeforeToolCallContext {
  toolCall: ToolCall;
  args: unknown;
  context: {
    systemPrompt?: string;
    messages: AgentMessage[];
    tools?: AgentTool[];
  };
  signal?: AbortSignal;
}

/** Stable SSE/transcript events; the Codex adapter is responsible for translation. */
export type AgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[] }
  | { type: "turn_start" }
  | { type: "turn_end"; message: AssistantMessage; toolResults: ToolResultMessage[] }
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; message: AssistantMessage; assistantMessageEvent: AssistantMessageEvent }
  | { type: "message_end"; message: AgentMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: unknown; partialResult: AgentToolResult }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: AgentToolResult; isError: boolean };
