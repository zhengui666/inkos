import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Type } from "@sinclair/typebox";
import { runWorkerAgent, runWorkerAgentTool } from "../../agent/worker-agent.js";
import type { LLMClient } from "../../llm/provider.js";

const mocks = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("../client.js", () => ({ createCodexClient: mocks.create }));

class WorkerClient {
  readonly cwd = "/isolated/codex-work";
  readonly notices = new Set<(method: string, value: unknown) => void>();
  handler?: (method: string, value: unknown) => unknown;
  run: () => Promise<void> = async () => {};
  request = vi.fn(async (method: string, _params?: unknown) => {
    if (method === "account/read") return { account: { type: "chatgpt", email: "fixture@example.test", planType: "plus" }, requiresOpenaiAuth: false };
    if (method === "model/list") return { data: [{ id: "codex-fixture", model: "codex-fixture", isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "high" }] }] };
    if (method === "thread/start") return { thread: { id: "thread" }, model: "codex-fixture" };
    if (method === "turn/start") {
      queueMicrotask(() => { void this.run(); });
      return { turn: { id: "turn" } };
    }
    if (method === "turn/interrupt") { this.finish("interrupted"); return {}; }
    throw new Error(`Unexpected request ${method}`);
  });
  onNotification(handler: (method: string, value: unknown) => void) { this.notices.add(handler); return () => { this.notices.delete(handler); }; }
  onRequest(handler: (method: string, value: unknown) => unknown) { this.handler = handler; return () => { this.handler = undefined; }; }
  onClose() { return () => {}; }
  close = vi.fn(async () => {});
  notify(method: string, value: object) { for (const handler of this.notices) handler(method, { threadId: "thread", ...value }); }
  async tool(id: string, args: unknown) {
    return await this.handler!("item/tool/call", { threadId: "thread", turnId: "turn", callId: id, tool: "submit", arguments: args }) as { success: boolean; contentItems: Array<{ text: string }> };
  }
  finish(status = "completed") { this.notify("turn/completed", { turn: { id: "turn", status } }); }
}

const llmClient: LLMClient = {
  provider: "openai", apiFormat: "chat", stream: false,
  defaults: { temperature: 0.7, maxTokens: 4096, thinkingBudget: 0, extra: {} },
  _codex: { projectRoot: "/selected-project", settings: { model: "codex-fixture", reasoningEffort: "high", serviceTier: "default" } },
};
const resultTool = { name: "submit", label: "Submit", description: "Submit typed state", parameters: Type.Object({ value: Type.Integer() }) };
let client: WorkerClient;
beforeEach(() => { client = new WorkerClient(); mocks.create.mockReset().mockResolvedValue(client); });

describe("Codex worker runtime integration", () => {
  it("validates and corrects dynamic-tool arguments in one turn, then retains usage when the host interrupts", async () => {
    const results: boolean[] = [], onUsage = vi.fn();
    client.run = async () => {
      results.push((await client.tool("wrong", { value: "7" })).success);
      client.notify("thread/tokenUsage/updated", { tokenUsage: { total: { inputTokens: 20, outputTokens: 8, totalTokens: 28 } } });
      results.push((await client.tool("fixed", { value: 7 })).success);
    };
    await expect(runWorkerAgentTool(llmClient, "ignored-legacy-model", [{ role: "user", content: "Submit seven" }], resultTool, { onUsage })).resolves.toEqual({ value: 7 });
    expect(results).toEqual([false, true]);
    expect(onUsage).toHaveBeenCalledWith({ promptTokens: 20, completionTokens: 8, totalTokens: 28 });
    expect(mocks.create).toHaveBeenCalledWith("/selected-project");
    expect(client.request.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(1);
    expect(client.request.mock.calls.find(([method]) => method === "thread/start")?.[1]).toMatchObject({ model: "codex-fixture", dynamicTools: [{ name: "submit" }] });
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("interrupts after three invalid dynamic submissions, with bounded schema feedback", async () => {
    const feedback: string[] = [];
    client.run = async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        feedback.push((await client.tool(String(attempt), { value: "wrong", draft: "private long manuscript" })).contentItems[0]!.text);
      }
    };
    await expect(runWorkerAgentTool(llmClient, "legacy", [{ role: "user", content: "Submit" }], resultTool)).rejects.toMatchObject({ code: "WORKER_RESULT_INVALID", attempts: 3 });
    expect(feedback).toHaveLength(3);
    expect(feedback.join("\n")).not.toContain("private long manuscript");
    expect(client.request.mock.calls.filter(([method]) => method === "turn/interrupt")).toHaveLength(1);
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("uses Codex text output and sends assistant context as quoted role-preserving history", async () => {
    client.run = async () => {
      client.notify("item/agentMessage/delta", { itemId: "answer", delta: "Updated answer" });
      client.finish();
    };
    const result = await runWorkerAgent(llmClient, "legacy", [{ role: "assistant", content: "Earlier answer" }, { role: "user", content: "Update it" }]);
    expect(result.content).toBe("Updated answer");
    const start = client.request.mock.calls.find(([method]) => method === "turn/start")?.[1] as { input: Array<{ text: string }> };
    expect(start.input[0]!.text).toContain('"role":"assistant"');
    expect(start.input[1]!.text).toBe("Update it");
  });
});

function completeOutput(value: unknown, phase = "final_answer") {
  client.notify("item/completed", { item: { id: "final", type: "agentMessage", phase,
    text: JSON.stringify({ resultJson: JSON.stringify(value) }) } });
  client.finish();
}

describe("native structured worker results", () => {
  it("accepts the declared native output envelope through the same domain validator", async () => {
    const validate = vi.fn((value: { value: number }) => ({ value: value.value + 1 }));
    client.run = async () => completeOutput({ value: 7 });
    await expect(runWorkerAgentTool(llmClient, "ignored", [{ role: "user", content: "Submit" }], { ...resultTool, validate })).resolves.toEqual({ value: 8 });
    expect(validate).toHaveBeenCalledExactlyOnceWith({ value: 7 });
    expect(client.request.mock.calls.find(([method]) => method === "turn/start")?.[1]).toMatchObject({ outputSchema: { required: ["resultJson"], additionalProperties: false } });
    expect(client.request.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(1);
  });
  it("corrects a schema-invalid native result without coercing scalar types", async () => {
    let turn = 0;
    const validate = vi.fn((value: { value: number }) => value);
    client.run = async () => completeOutput({ value: ++turn === 1 ? "7" : 7 });
    await expect(runWorkerAgentTool(llmClient, "ignored", [{ role: "user", content: "Submit" }], { ...resultTool, validate })).resolves.toEqual({ value: 7 });
    expect(turn).toBe(2);
    expect(validate).toHaveBeenCalledExactlyOnceWith({ value: 7 });
  });
  it("does not execute a result twice when a dynamic submission already succeeded", async () => {
    const validate = vi.fn((value: { value: number }) => value);
    client.run = async () => { await client.tool("submit-once", { value: 3 }); completeOutput({ value: 9 }); };
    await expect(runWorkerAgentTool(llmClient, "ignored", [{ role: "user", content: "Submit" }], { ...resultTool, validate })).resolves.toEqual({ value: 3 });
    expect(validate).toHaveBeenCalledOnce();
  });
  it("rejects commentary, fenced JSON and JSON outside the declared envelope", async () => {
    client.run = async () => completeOutput({ value: 7 }, "commentary");
    await expect(runWorkerAgentTool(llmClient, "ignored", [{ role: "user", content: "Submit" }], resultTool)).rejects.toMatchObject({ code: "WORKER_RESULT_MISSING" });
    for (const text of ['{"value":7}', '```json\n{"resultJson":"{\\"value\\":7}"}\n```']) {
      client.run = async () => { client.notify("item/completed", { item: { id: "final", type: "agentMessage", text } }); client.finish(); };
      await expect(runWorkerAgentTool(llmClient, "ignored", [{ role: "user", content: "Submit" }], resultTool)).rejects.toMatchObject({ code: "WORKER_RESULT_INVALID" });
    }
  });
  it("retains a non-retryable error even when a later notification says completed", async () => {
    const validate = vi.fn((value: { value: number }) => value);
    client.run = async () => {
      client.notify("error", { willRetry: false, error: { message: "Fixture model request failed" } });
      completeOutput({ value: 7 });
    };
    await expect(runWorkerAgentTool(llmClient, "ignored", [{ role: "user", content: "Submit" }], { ...resultTool, validate })).rejects.toMatchObject({ code: "WORKER_MODEL_ERROR", message: "Fixture model request failed" });
    expect(validate).not.toHaveBeenCalled();
    expect(client.request.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(1);
  });
  it("times out a silent peer and closes it without correction turns", async () => {
    await expect(runWorkerAgentTool(llmClient, "ignored", [{ role: "user", content: "Submit" }], resultTool, { timeoutMs: 20 })).rejects.toMatchObject({ code: "WORKER_TIMEOUT" });
    expect(client.close).toHaveBeenCalledOnce();
    expect(client.request.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(1);
  });
});

describe("long-running worker deadlines", () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

  it.each(["text", "structured"])("allows a %s worker past ten minutes and releases its timer", async kind => {
    vi.useFakeTimers();
    vi.stubEnv("INKOS_WORKER_TIMEOUT_MS", "");
    const progress = vi.fn();
    const pending = kind === "text"
      ? runWorkerAgent(llmClient, "ignored", [{ role: "user", content: "Write" }], { onTextDelta: progress })
      : runWorkerAgentTool(llmClient, "ignored", [{ role: "user", content: "Write" }], resultTool);
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    expect(client.close).not.toHaveBeenCalled();
    if (kind === "text") {
      client.notify("item/agentMessage/delta", { itemId: "answer", delta: "Manuscript" });
      client.finish();
      await expect(pending).resolves.toMatchObject({ content: "Manuscript" });
      expect(progress).toHaveBeenCalledWith("Manuscript");
    } else {
      completeOutput({ value: 7 });
      await expect(pending).resolves.toEqual({ value: 7 });
    }
    expect(client.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("propagates the default hour deadline through the Codex turn and closes the peer", async () => {
    vi.useFakeTimers(); vi.stubEnv("INKOS_WORKER_TIMEOUT_MS", "");
    const pending = runWorkerAgent(llmClient, "ignored", [{ role: "user", content: "Write" }]);
    const rejected = expect(pending).rejects.toMatchObject({ code: "WORKER_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(60 * 60_000 - 1);
    expect(client.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); await rejected;
    expect(client.request.mock.calls.some(([method]) => method === "turn/interrupt")).toBe(true);
    expect(client.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps one configured budget across correction turns", async () => {
    vi.useFakeTimers(); vi.stubEnv("INKOS_WORKER_TIMEOUT_MS", "2000");
    let turn = 0;
    client.run = async () => { if (++turn === 1) setTimeout(() => completeOutput({ value: "invalid" }), 1500); };
    const pending = runWorkerAgentTool(llmClient, "ignored", [{ role: "user", content: "Write" }], resultTool);
    const rejected = expect(pending).rejects.toMatchObject({ code: "WORKER_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(1999);
    expect(turn).toBe(2);
    await vi.advanceTimersByTimeAsync(1); await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("lets an explicit deadline override the environment", async () => {
    vi.useFakeTimers(); vi.stubEnv("INKOS_WORKER_TIMEOUT_MS", "1");
    const pending = runWorkerAgent(llmClient, "ignored", [{ role: "user", content: "Write" }], { timeoutMs: 2000 });
    const rejected = expect(pending).rejects.toMatchObject({ code: "WORKER_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(1999); expect(client.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); await rejected;
  });

  it("preserves user cancellation rather than reporting timeout during the extended budget", async () => {
    vi.useFakeTimers(); vi.stubEnv("INKOS_WORKER_TIMEOUT_MS", "7200000");
    const controller = new AbortController();
    const reason = Object.assign(new Error("User cancelled"), { code: "USER_CANCELLED" });
    const pending = runWorkerAgentTool(llmClient, "ignored", [{ role: "user", content: "Write" }], resultTool, { signal: controller.signal });
    const rejected = expect(pending).rejects.toBe(reason);
    await vi.advanceTimersByTimeAsync(11 * 60_000); controller.abort(reason);
    await rejected;
    expect(client.close).toHaveBeenCalledOnce();
    expect(client.notices.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["0", "-1", "NaN", "Infinity", "2147483648", "1.5", "nonsense"])("rejects invalid environment timeout %s before starting a peer", async value => {
    vi.stubEnv("INKOS_WORKER_TIMEOUT_MS", value);
    await expect(runWorkerAgent(llmClient, "ignored", [{ role: "user", content: "Write" }])).rejects.toThrow("must be an integer");
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
