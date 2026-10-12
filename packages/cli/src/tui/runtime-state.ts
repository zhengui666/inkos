import type { RuntimeClient } from "../runtime.js";
import type { ConversationRecord, ConversationView, RuntimeEvent, RuntimeStatus, TaskGraph } from "../runtime-view.js";

export type RuntimeTuiState = {
  status?: RuntimeStatus; graph: TaskGraph; conversations: ConversationRecord[];
  conversation?: ConversationView; agentEvents: any[];
};
export const emptyRuntimeState = (): RuntimeTuiState => ({ graph: { tasks: {} }, conversations: [], agentEvents: [] });

export async function loadRuntimeState(client: Pick<RuntimeClient, "rpc">, conversationId?: number): Promise<RuntimeTuiState> {
  const [status, conversations, conversation] = await Promise.all([
    client.rpc<RuntimeStatus>("status"), client.rpc<ConversationRecord[]>("conversations.list"),
    conversationId === undefined ? undefined : client.rpc<ConversationView>("conversations.get", { id: conversationId }),
  ]);
  return { status, graph: status.taskGraph, conversations, conversation, agentEvents: [] };
}

/** Events update read-only views. They never carry an instruction to submit or abort. */
export function applyRuntimeEvent(state: RuntimeTuiState, event: RuntimeEvent): RuntimeTuiState {
  switch (event.type) {
    case "snapshot": return { ...state, status: event.data, graph: event.data.taskGraph };
    case "taskGraph": return { ...state, graph: event.data };
    case "agentEvents": return { ...state, agentEvents: [...state.agentEvents, ...(Array.isArray(event.data) ? event.data : [event.data])].slice(-40) };
    default: return state;
  }
}

export function eventRequiresRefresh(event: RuntimeEvent): boolean {
  return event.type === "changed" || event.type === "snapshot" || event.type === "agentEvents";
}
