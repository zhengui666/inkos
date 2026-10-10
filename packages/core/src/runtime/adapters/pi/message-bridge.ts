import type { PiAssistantMessage, PiEvent, PiHostMessage, PiMessage, PiRunResult, PiSdkAssistantMessage, PiSdkEvent, PiToolFailure, PiToolResult } from "./contracts.js";
import { projectToolError } from "./tool-bridge.js";

function projectToolMessage(message: Extract<PiMessage, { role: "toolResult" }>, failure?: PiToolFailure): Extract<PiMessage, { role: "toolResult" }> {
  const safe = projectToolError(message, failure);
  return { role: "toolResult", toolCallId: message.toolCallId, toolName: message.toolName,
    content: safe.content, details: safe.details, isError: true, timestamp: message.timestamp };
}

/** Clone at the boundary so SDK mutation and host listeners cannot edit each other's transcript. */
export function toPiMessages(messages: PiHostMessage[]): PiMessage[] {
  return messages.map(message => message.role === "toolResult" && message.isError ? projectToolMessage(message) : structuredClone(message));
}
export function toHostMessages(messages: PiMessage[], streaming = false, failures?: ReadonlyMap<string, PiToolFailure>): PiHostMessage[] {
  return messages.filter(message => message.role !== "system").map((message): PiHostMessage => {
    const copy = structuredClone(message);
    if (copy.role === "toolResult" && copy.isError) return projectToolMessage(copy, failures?.get(copy.toolCallId));
    if (copy.role !== "assistant") return copy;
    if (copy.errorMessage) copy.errorMessage = "Pi model response failed";
    const { stopReason, ...fields } = copy;
    if (stopReason === "pending" || stopReason === "deferred") {
      return { ...fields, stopReason: streaming && stopReason === "pending" ? "stop" : "error",
        ...(!streaming || stopReason === "deferred" ? { errorMessage: "Pi model response is not complete" } : {}) };
    }
    return { ...fields, stopReason };
  });
}
export function toHostEvent(event: PiSdkEvent, failures?: ReadonlyMap<string, PiToolFailure>): PiEvent | undefined {
  if (event.type === "tool_execution_update") {
    const result = event.partialResult as PiToolResult;
    return { ...event, partialResult: result.isError || result.failure ? projectToolError(result) : structuredClone(result) };
  }
  if (event.type === "tool_execution_end") return { ...event,
    result: event.isError ? projectToolError(event.result, failures?.get(event.toolCallId)) : structuredClone(event.result) };
  if (event.type === "message_start" || event.type === "message_end") {
    if (event.message.role === "system") return undefined;
    return { ...event, message: toHostMessages([event.message], event.type === "message_start", failures)[0] };
  }
  if (event.type === "agent_end") return { ...event, messages: toHostMessages(event.messages, false, failures) };
  if (event.type === "message_update") {
    // Provider diagnostics and raw response.failed payloads never escape to host listeners.
    const update = event.assistantMessageEvent;
    const clean = update && typeof update === "object" ? structuredClone(update) as Record<string, unknown> : {};
    if (clean.type === "error" || clean.type === "response.failed") {
      return { ...event, message: toHostMessages([event.message], true)[0] as PiAssistantMessage,
        assistantMessageEvent: { type: clean.type, error: "Pi model response failed" } };
    }
    if ("partial" in clean) clean.partial = toHostMessages([event.message], true)[0];
    if ("message" in clean) clean.message = toHostMessages([event.message], true)[0];
    return { ...event, message: toHostMessages([event.message], true)[0] as PiAssistantMessage, assistantMessageEvent: clean };
  }
  if (event.type === "turn_end") return { ...event, message: toHostMessages([event.message])[0] as PiAssistantMessage,
    toolResults: toHostMessages(event.toolResults, false, failures) as typeof event.toolResults };
  return structuredClone(event);
}

const keys = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const;
/** Message updates contain cumulative snapshots. Keep one latest snapshot per response, never sum deltas twice. */
export class PiUsageLedger {
  private readonly snapshots = new Map<string, PiRunResult["usage"]>();
  private readonly identities = new Map<string, string>();
  observe(message: PiSdkAssistantMessage, responseKey?: string, final = false): void {
    const fallback = JSON.stringify([message.provider, message.model, message.timestamp]);
    const id = (message.responseId ? this.identities.get(message.responseId) : undefined)
      ?? responseKey ?? message.responseId ?? fallback;
    const provisionalKey = responseKey ?? fallback;
    const provisional = message.responseId && provisionalKey !== id ? this.snapshots.get(provisionalKey) : undefined;
    // response.created can fill responseId after message_start; migrate its provisional snapshot.
    if (message.responseId) {
      if (provisionalKey !== id) this.snapshots.delete(provisionalKey);
      this.identities.set(message.responseId, id);
    }
    const previous = { ...provisional, ...this.snapshots.get(id) };
    // A terminal report is authoritative, including lower counts and missing fields.
    const next: NonNullable<PiRunResult["usage"]> = final ? {} : { ...previous };
    for (const key of keys) {
      const value = message.usage?.[key];
      const reported = (final ? [value] : [provisional?.[key], previous[key], value]).filter((count): count is number =>
        typeof count === "number" && Number.isFinite(count) && count >= 0);
      if (reported.length) next[key] = Math.max(...reported);
    }
    // An observed response without usage remains unknown even when another response reports it.
    this.snapshots.set(id, Object.keys(next).length ? next : undefined);
  }
  total(): PiRunResult["usage"] {
    if (!this.snapshots.size) return undefined;
    const total: NonNullable<PiRunResult["usage"]> = {};
    for (const key of keys) {
      const values = [...this.snapshots.values()].map(usage => usage?.[key]);
      if (values.every((value): value is number => value !== undefined)) total[key] = values.reduce((sum, value) => sum + value, 0);
    }
    return Object.keys(total).length ? total : undefined;
  }
}
