import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Type } from "@sinclair/typebox";
import type { Api, AssistantMessage, Message, Model, ToolCall } from "@mariozechner/pi-ai";
import type { AgentEvent, AgentTool, BeforeToolCallContext } from "../codex/contracts.js";
import { runWorkerAgent, runWorkerAgentTool } from "../agent/worker-agent.js";
import { BaseAgent, type AgentContext } from "../agents/base.js";

const mocks = vi.hoisted(() => ({ run: vi.fn(), constructed: vi.fn(), abort: vi.fn(), legacyTransport: vi.fn() }));
vi.mock("../llm/provider.js", async importOriginal => ({
  ...await importOriginal<typeof import("../llm/provider.js")>(),
  chatCompletion: mocks.legacyTransport,
}));
vi.mock("../codex/agent.js", () => ({
  Agent: class {
    readonly state: Fixture["state"];
    readonly controller = new AbortController();
    readonly listeners = new Set<(event: AgentEvent) => void | Promise<void>>();
    constructor(readonly options: Fixture["options"]) {
      this.state = { ...options.initialState, messages: [...options.initialState.messages] };
      mocks.constructed(this);
    }
    async prompt(input: string | Message[]) {
      this.state.messages.push(...(typeof input === "string" ? [{ role: "user" as const, content: input, timestamp: Date.now() }] : input));
      this.options.onModelTurn?.();
      await mocks.run(this);
    }
    async emit(event: AgentEvent) { for (const listener of this.listeners) await listener(event); }
    subscribe(listener: (event: AgentEvent) => void | Promise<void>) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
    abort() { mocks.abort(); this.controller.abort(new DOMException("Codex interrupted", "AbortError")); }
  },
}));

type Fixture = {
  state: { model: Model<Api>; systemPrompt: string; tools: AgentTool[]; messages: Message[] };
  options: {
    projectRoot: string;
    settings?: { model?: string; reasoningEffort: string; serviceTier: string };
    initialState: Fixture["state"];
    beforeToolCall?: (context: BeforeToolCallContext) => Promise<unknown>;
    shouldStop?: () => boolean;
    onModelTurn?: () => void;
  };
  controller: AbortController;
  emit: (event: AgentEvent) => Promise<void>;
};

function client(): AgentContext["client"] {
  return {
    provider: "openai", apiFormat: "chat", stream: true,
    defaults: { temperature: 0.7, maxTokens: 4096, thinkingBudget: 0, extra: {} },
    _codex: { projectRoot: "/tmp/inkos-worker-test", settings: { model: "gpt-5.4", reasoningEffort: "high", serviceTier: "default" } },
  };
}

function response(agent: Fixture, content: AssistantMessage["content"] = [{ type: "text", text: "完成" }], usage = { input: 12, output: 3 }): AssistantMessage {
  return {
    role: "assistant", content, api: agent.state.model.api, provider: agent.state.model.provider,
    model: agent.state.model.id, timestamp: Date.now(), stopReason: content.some(part => part.type === "toolCall") ? "toolUse" : "stop",
    usage: { ...usage, totalTokens: usage.input + usage.output, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}

async function submit(agent: Fixture, args: Record<string, unknown>) {
  const tool = agent.state.tools[0]!;
  const call: ToolCall = { type: "toolCall", id: `result-${agent.state.messages.length}`, name: tool.name, arguments: args };
  const message = response(agent, [call]);
  agent.state.messages.push(message);
  await agent.emit({ type: "message_update", message, assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(args), partial: message } });
  let content: Array<{ type: "text"; text: string }>;
  let isError = false;
  try {
    const prepared = tool.prepareArguments ? await tool.prepareArguments(args) : args;
    await agent.options.beforeToolCall?.({ toolCall: call, args: prepared, context: agent.state });
    const result = await tool.execute(call.id, prepared, agent.controller.signal);
    content = result.content.filter(part => part.type === "text");
  } catch (error) {
    isError = true;
    content = [{ type: "text", text: error instanceof Error ? error.message : String(error) }];
  }
  agent.state.messages.push({ role: "toolResult", toolCallId: call.id, toolName: call.name, content, isError, timestamp: Date.now() });
}

const resultTool = {
  name: "submit_state", label: "Submit", description: "Submit host-consumed state",
  parameters: Type.Object({ value: Type.Union([Type.Number(), Type.String(), Type.Boolean()]) }),
};

class TwoStepWorker extends BaseAgent {
  get name(): string { return "two-step"; }
  async run() {
    await this.chat([{ role: "user", content: "第一步" }]);
    await this.chat([{ role: "user", content: "第二步" }]);
  }
}

describe("Codex worker harness", () => {
  beforeEach(() => { mocks.run.mockReset(); mocks.constructed.mockReset(); mocks.abort.mockReset(); mocks.legacyTransport.mockReset(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("uses Codex project settings and preserves assistant history without calling the provider transport", async () => {
    mocks.run.mockImplementation(async (agent: Fixture) => { agent.state.messages.push(response(agent)); });
    const result = await runWorkerAgent(client(), "legacy-deepseek-model", [
      { role: "system", content: "你是审稿员" }, { role: "user", content: "检查第一章" },
      { role: "assistant", content: "第一章需要补充动机" }, { role: "user", content: "复查修改" },
    ]);
    const agent = mocks.constructed.mock.calls[0]![0] as Fixture;
    expect(agent.options.projectRoot).toBe("/tmp/inkos-worker-test");
    expect(agent.options.settings).toEqual(client()._codex!.settings);
    expect(agent.state.systemPrompt).toBe("你是审稿员");
    expect(agent.state.messages.slice(0, 3).map(message => message.role)).toEqual(["user", "assistant", "user"]);
    expect(result).toEqual({ content: "完成", usage: { promptTokens: 12, completionTokens: 3, totalTokens: 15 } });
    expect(mocks.legacyTransport).not.toHaveBeenCalled();
  });

  it("surfaces Codex transport failures", async () => {
    mocks.run.mockRejectedValue(new Error("Codex app-server disconnected"));
    await expect(runWorkerAgent(client(), "legacy", [{ role: "user", content: "写作" }])).rejects.toThrow("Codex app-server disconnected");
  });

  it("emits streamed text and completes the progress monitor", async () => {
    const deltas: string[] = [], progress: string[] = [];
    mocks.run.mockImplementation(async (agent: Fixture) => {
      const message = response(agent, [{ type: "text", text: "完成" }], { input: 0, output: 0 });
      await agent.emit({ type: "message_update", message, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "完成", partial: message } });
      agent.state.messages.push(message);
    });
    const result = await runWorkerAgent(client(), "legacy", [{ role: "user", content: "写作" }], { onTextDelta: delta => deltas.push(delta), onStreamProgress: value => progress.push(value.status) });
    expect(result.usage?.totalTokens).toBe(0);
    expect(deltas).toEqual(["完成"]);
    expect(progress.at(-1)).toBe("done");
  });

  it("aborts the current worker, keeps the caller's reason, and never starts the next serial step", async () => {
    const controller = new AbortController();
    mocks.run.mockImplementationOnce((agent: Fixture) => new Promise((_resolve, reject) => {
      agent.controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
    }));
    const worker = new TwoStepWorker({ client: client(), model: "legacy", projectRoot: "/tmp/selected-project", signal: controller.signal });
    const running = worker.run();
    await vi.waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(1));
    controller.abort(new DOMException("user stopped", "AbortError"));
    await expect(running).rejects.toThrow("user stopped");
    expect(mocks.abort).toHaveBeenCalledTimes(1);
    expect(mocks.run).toHaveBeenCalledTimes(1);
    expect((mocks.constructed.mock.calls[0]![0] as Fixture).options.projectRoot).toBe("/tmp/selected-project");
  });

  it("does not start Codex when already cancelled", async () => {
    const controller = new AbortController(); controller.abort(new Error("cancelled before start"));
    await expect(runWorkerAgent(client(), "legacy", [{ role: "user", content: "写作" }], { signal: controller.signal })).rejects.toThrow("cancelled before start");
    expect(mocks.constructed).not.toHaveBeenCalled();
  });

  it.each([true, false, 1, 0, "1", "0"])("submits typed state %s through the dynamic tool without requiring a Pi model", async value => {
    mocks.run.mockImplementation(async (agent: Fixture) => { await submit(agent, { value }); expect(agent.options.shouldStop?.()).toBe(true); });
    await expect(runWorkerAgentTool(client(), "legacy", [{ role: "user", content: "登记状态" }], resultTool)).resolves.toEqual({ value });
    expect(mocks.run).toHaveBeenCalledTimes(1);
    expect(mocks.legacyTransport).not.toHaveBeenCalled();
  });

  it("decodes structured JSON fields, corrects domain-invalid submissions, and accumulates usage", async () => {
    const onUsage = vi.fn();
    mocks.run.mockImplementation(async (agent: Fixture) => {
      await submit(agent, { values: '["invalid"]' });
      expect(agent.options.shouldStop?.()).toBe(false);
      await submit(agent, { values: '["valid"]' });
      expect(agent.options.shouldStop?.()).toBe(true);
    });
    const result = await runWorkerAgentTool(client(), "legacy", [{ role: "user", content: "Submit" }], {
      ...resultTool, parameters: Type.Object({ values: Type.Array(Type.String()) }),
      validate: value => { if (value.values[0] !== "valid") throw Object.assign(new Error("Correct values[0]"), { code: "DOMAIN_INVALID" }); return value; },
    }, { onUsage });
    expect(result).toEqual({ values: ["valid"] });
    expect(onUsage).toHaveBeenCalledWith({ promptTokens: 24, completionTokens: 6, totalTokens: 30 });
  });

  it("bounds repeated invalid schema submissions within a single Codex turn to three", async () => {
    const feedback: string[] = [];
    mocks.run.mockImplementation(async (agent: Fixture) => {
      while (!agent.options.shouldStop?.()) {
        await submit(agent, { manuscript: "sensitive manuscript omitted from schema feedback" });
        const last = agent.state.messages.at(-1)!;
        if (last.role === "toolResult") feedback.push(last.content.filter(part => part.type === "text").map(part => part.text).join(""));
      }
    });
    await expect(runWorkerAgentTool(client(), "legacy", [{ role: "user", content: "Submit" }], resultTool)).rejects.toMatchObject({ code: "WORKER_RESULT_INVALID", attempts: 3 });
    expect(feedback).toHaveLength(3);
    expect(JSON.parse(feedback[0]!)).toMatchObject({ code: "WORKER_SCHEMA_INVALID", issues: expect.arrayContaining([expect.objectContaining({ path: "/value" })]) });
    expect(feedback.join("\n")).not.toContain("sensitive manuscript");
    expect(mocks.run).toHaveBeenCalledTimes(1);
  });

  it("retains the domain failure code when all three corrections fail", async () => {
    mocks.run.mockImplementation(async (agent: Fixture) => {
      while (!agent.options.shouldStop?.()) await submit(agent, { value: "wrong" });
    });
    await expect(runWorkerAgentTool(client(), "legacy", [{ role: "user", content: "Submit" }], {
      ...resultTool, validate: () => { throw Object.assign(new Error("A cited source is required"), { code: "REVIEW_SOURCE_REQUIRED" }); },
    })).rejects.toMatchObject({ code: "REVIEW_SOURCE_REQUIRED", attempts: 3, message: "A cited source is required" });
  });

  it("bounds missing-tool prose retries without scraping JSON from text", async () => {
    mocks.run.mockImplementation(async (agent: Fixture) => { agent.state.messages.push(response(agent, [{ type: "text", text: '{"value":"not submitted"}' }])); });
    await expect(runWorkerAgentTool(client(), "legacy", [{ role: "user", content: "Submit" }], resultTool)).rejects.toMatchObject({ code: "WORKER_RESULT_MISSING", attempts: 3 });
    expect(mocks.run).toHaveBeenCalledTimes(3);
  });
});
