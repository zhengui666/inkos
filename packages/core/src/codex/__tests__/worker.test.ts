import { beforeEach, describe, expect, it, vi } from "vitest";
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
