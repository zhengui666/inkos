import { beforeEach, describe, expect, it, vi } from "vitest";
import { Type } from "@sinclair/typebox";
import { Agent, encodeContext } from "../agent.js";
import { resolveCodexModel } from "../model.js";
import type { AgentEvent, AgentToolResult } from "../contracts.js";
import type { CodexClient } from "../client.js";

const mocks = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("../client.js", () => ({ createCodexClient: mocks.create }));
vi.mock("../settings.js", () => ({ readCodexSettings: async () => ({ reasoningEffort: "medium", serviceTier: "default" }) }));

class FakeClient {
  cwd = "/isolated/work";
  codexHome = "/isolated/auth";
  closed = false;
  notifications = new Set<(method: string, params: unknown) => void>();
  requests = new Set<(method: string, params: unknown) => unknown>();
  closes = new Set<() => void>();
  run: () => Promise<void> = async () => { this.finish(); };
  request = vi.fn(async (method: string, _params?: unknown) => {
    if (method === "account/read") return { account: { type: "chatgpt" }, requiresOpenaiAuth: true };
    if (method === "model/list") return { data: [{ id: "fixture", model: "fixture", isDefault: true,
      supportedReasoningEfforts: [{ reasoningEffort: "medium" }], serviceTiers: [{ id: "fast" }] }] };
    if (method === "thread/start") return { thread: { id: "thread-1" }, model: "fixture" };
    if (method === "turn/start") {
      queueMicrotask(() => { void this.run(); });
      return { turn: { id: "turn-1" } };
    }
    if (method === "turn/interrupt") { this.finish("interrupted"); return {}; }
    return {};
  });
  onNotification = (fn: (method: string, params: unknown) => void) => { this.notifications.add(fn); return () => { this.notifications.delete(fn); }; };
  onRequest = (fn: (method: string, params: unknown) => unknown) => { this.requests.add(fn); return () => { this.requests.delete(fn); }; };
  onClose = (fn: () => void) => { this.closes.add(fn); return () => { this.closes.delete(fn); }; };
  close = vi.fn(async () => { this.closed = true; for (const fn of this.closes) fn(); });
  notify(method: string, params: object) { for (const fn of this.notifications) fn(method, { threadId: "thread-1", ...params }); }
  async tool(id: string, args = { value: "1" }) {
    const params = { threadId: "thread-1", turnId: "turn-1", callId: id, tool: "submit", arguments: args };
    for (const fn of this.requests) {
      const result = fn("item/tool/call", params);
      if (result !== undefined) return result;
    }
    throw new Error("No handler");
  }
  finish(status = "completed") { this.notify("turn/completed", { turn: { id: "turn-1", status } }); }
  text(text: string) {
    this.notify("item/agentMessage/delta", { itemId: "text-1", delta: text });
    this.notify("item/completed", { item: { id: "text-1", type: "agentMessage", text } });
  }
}

let client: FakeClient;
beforeEach(() => { client = new FakeClient(); mocks.create.mockReset().mockResolvedValue(client as unknown as CodexClient); });
const make = (execute: (_id: string, args: { value: string }) => Promise<AgentToolResult> = vi.fn(async (_id: string, args: { value: string }) => ({ content: [{ type: "text" as const, text: args.value }], details: args }))) => new Agent({
  projectRoot: "/project", initialState: { model: resolveCodexModel(), systemPrompt: "Host rules", messages: [],
    tools: [{ name: "submit", label: "Submit", description: "Submit", parameters: Type.Object({ value: Type.String() }), execute }] },
});

describe("Codex Agent bridge", () => {
  it("emits the complete reasoning lifecycle consumed by Studio's stream store", async () => {
    const agent = make();
    const events: string[] = [];
    agent.subscribe(event => { if (event.type === "message_update") events.push(event.assistantMessageEvent.type); });
    client.run = async () => {
      client.notify("item/reasoning/summaryTextDelta", { itemId: "reasoning-1", delta: "Checking context" });
      client.notify("item/completed", { item: { id: "reasoning-1", type: "reasoning" } });
      client.text("Answer"); client.finish();
    };
    await agent.prompt("Go");
    expect(events).toEqual(["thinking_start", "thinking_delta", "thinking_end", "text_start", "text_delta", "text_end"]);
  });

  it("interrupts oversized streamed answers instead of accepting an ignored output budget", async () => {
    const agent = new Agent({ projectRoot: "/project", initialState: make().state, maxOutputTokens: 4 });
    client.run = async () => { client.text("x".repeat(100)); client.finish(); };
    await expect(agent.prompt("Go")).rejects.toMatchObject({ code: "MODEL_OUTPUT_LIMIT", stopReason: "length" });
    expect(client.closed).toBe(true);
  });

  it("rejects oversized generated arguments before any domain tool executes", async () => {
    const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "done" }], details: {} }));
    const agent = new Agent({ projectRoot: "/project", initialState: make(execute).state, maxOutputTokens: 8 });
    client.run = async () => { await client.tool("huge", { value: "x".repeat(100) }).catch(() => {}); };
    await expect(agent.prompt("Go")).rejects.toMatchObject({ code: "MODEL_OUTPUT_LIMIT" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("executes each call exactly once, preserves tool types/results and persists final usage in order", async () => {
    const execute = vi.fn(async (_id: string, args: { value: string }) => ({ content: [{ type: "text" as const, text: args.value }], details: { source: "receipt" } }));
    const agent = make(execute);
    const events: AgentEvent[] = [];
    agent.subscribe(async event => { await Promise.resolve(); events.push(structuredClone(event)); });
    client.run = async () => {
      const [first, duplicate] = await Promise.all([client.tool("call-1"), client.tool("call-1")]);
      expect(first).toEqual(duplicate);
      expect(first).toEqual({ success: true, contentItems: [{ type: "inputText", text: "1" }] });
      client.text("Ready");
      client.notify("thread/tokenUsage/updated", { tokenUsage: { total: { inputTokens: 11, cachedInputTokens: 2, outputTokens: 5, totalTokens: 16 } } });
      client.finish();
    };
    await agent.prompt("Go");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[1]).toEqual({ value: "1" });
    const messages = events.filter(event => event.type === "message_end").map(event => event.message);
    expect(messages.map(message => message.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
    expect(messages.at(-1)).toMatchObject({ usage: { input: 11, output: 5, totalTokens: 16 } });
    expect(messages[2]).toMatchObject({ details: { source: "receipt" } });
    expect(client.request.mock.calls.find(([method]) => method === "turn/start")?.[1]).toMatchObject({ serviceTierForTurn: "default" });
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("serializes concurrent dynamic calls and blocks calls after host completion", async () => {
    let active = 0; let completed = false;
    const execute = vi.fn(async () => { expect(active++).toBe(0); await Promise.resolve(); active--; completed = true;
      return { content: [{ type: "text" as const, text: "done" }], details: {} }; });
    const agent = new Agent({ projectRoot: "/project", initialState: make(execute).state, shouldStop: () => completed });
    client.run = async () => { await Promise.all([client.tool("one"), client.tool("two")]); client.finish(); };
    await agent.prompt("Go");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(agent.state.messages.filter(message => message.role === "toolResult")).toHaveLength(1);
  });

  it("never calls a tool when durable transcript persistence fails", async () => {
    const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "done" }], details: {} }));
    const agent = make(execute);
    agent.subscribe(event => { if (event.type === "message_end" && event.message.role === "assistant") throw new Error("disk full"); });
    client.run = async () => { await client.tool("call-1").catch(() => {}); };
    await expect(agent.prompt("Go")).rejects.toThrow("disk full");
    expect(execute).not.toHaveBeenCalled();
    expect(client.closed).toBe(true);
  });

  it("aborts queued tool mutations after an earlier transcript failure", async () => {
    const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "done" }], details: {} }));
    const agent = make(execute);
    agent.subscribe(event => { if (event.type === "message_end" && event.message.role === "assistant") throw new Error("disk full"); });
    client.run = async () => { await Promise.allSettled([client.tool("first"), client.tool("second")]); };
    await expect(agent.prompt("Go")).rejects.toThrow("disk full");
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(execute).not.toHaveBeenCalled();
  });

  it("signals and drains in-flight host work when the Codex peer exits", async () => {
    let settled = false;
    const agent = new Agent({ projectRoot: "/project", initialState: { ...make().state, tools: [{
      name: "submit", label: "Submit", description: "Submit", parameters: Type.Object({ value: Type.String() }),
      async execute(_id, _args, signal) {
        await new Promise<void>(resolve => signal!.addEventListener("abort", () => { settled = true; resolve(); }, { once: true }));
        throw signal!.reason;
      },
    }] } });
    const executionStarted = new Promise<void>(resolve => agent.subscribe(event => {
      if (event.type === "tool_execution_start") setImmediate(() => { resolve(); });
    }));
    client.run = async () => { void client.tool("one").catch(() => {}); await executionStarted; await client.close(); };
    await expect(agent.prompt("Go")).rejects.toThrow("closed during the turn");
    expect(settled).toBe(true);
  });

  it("closes the process on cancellation during setup without starting a turn", async () => {
    let release!: () => void;
    mocks.create.mockImplementation(() => new Promise<FakeClient>(resolve => { release = () => resolve(client); }));
    const agent = make();
    const running = agent.prompt("Go");
    while (!release) await Promise.resolve();
    agent.abort(); release();
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    expect(client.request.mock.calls.some(([method]) => method === "turn/start")).toBe(false);
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("fails instead of hanging when the child exits after turn/start", async () => {
    client.run = async () => { await client.close(); };
    await expect(make().prompt("Go")).rejects.toThrow("closed during the turn");
  });

  it("rejects unsupported effort/speed without invoking the model", async () => {
    const agent = new Agent({ projectRoot: "/project", initialState: make().state,
      settings: { model: "fixture", reasoningEffort: "ultra", serviceTier: "fast" } });
    await expect(agent.prompt("Go")).rejects.toMatchObject({ code: "CODEX_SETTINGS_UNSUPPORTED" });
    expect(client.request.mock.calls.some(([method]) => method === "turn/start")).toBe(false);
  });

  it("fails closed for malformed account replies instead of treating process connectivity as login", async () => {
    const original = client.request.getMockImplementation()!;
    client.request.mockImplementation(async (method, params) => method === "account/read" ? {} : original(method, params));
    await expect(make().prompt("Go")).rejects.toMatchObject({ code: "CODEX_AUTH_REQUIRED" });
    expect(client.request.mock.calls.some(([method]) => method === "thread/start")).toBe(false);
    expect(client.closed).toBe(true);
  });

  it("keeps assistant history as quoted records and sends current images as multimodal input", () => {
    const assistant = { ...resolveCodexModel(), role: "assistant", content: [{ type: "text", text: "Earlier answer" }] } as never;
    const input = encodeContext([assistant, { role: "user", content: [{ type: "text", text: "Continue" }, { type: "image", mimeType: "image/png", data: "AA==" }], timestamp: 1 }]);
    expect(input[0]?.text).toContain('"role":"assistant"');
    expect(input[1]).toMatchObject({ type: "text", text: "Continue" });
    expect(input[2]).toEqual({ type: "image", url: "data:image/png;base64,AA==" });
  });
});
