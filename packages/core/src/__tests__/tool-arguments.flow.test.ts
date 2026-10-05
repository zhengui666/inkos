import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../codex/agent.js";
import { type ToolCall } from "@mariozechner/pi-ai";
import { expect, it, vi } from "vitest";
import { preserveToolArgumentTypes } from "../agent/tool-arguments.js";
import { createAddVariableTool, createConnectChoiceTool, createSetWorldAnchorTool } from "../agent/film-authoring-tools.js";
import { createLLMClient } from "../llm/provider.js";
import { loadStoryGraph } from "../interactive-film/graph-store.js";
import { initVarState, applyEffects, visibleChoices } from "../interactive-film/evaluator.js";

let fixtureCalls: ToolCall[] = [];
vi.mock("../codex/client.js", () => ({ createCodexClient: async () => createFixtureClient() }));

function createFixtureClient() {
  const notifications = new Set<(method: string, params: unknown) => void>();
  let handleRequest: ((method: string, params: unknown) => unknown) | undefined;
  const notify = (method: string, params: unknown) => { for (const handler of notifications) handler(method, params); };
  return {
    cwd: "/tmp/isolated-codex-fixture",
    onNotification(handler: (method: string, params: unknown) => void) { notifications.add(handler); return () => notifications.delete(handler); },
    onRequest(handler: (method: string, params: unknown) => unknown) { handleRequest = handler; return () => { handleRequest = undefined; }; },
    onClose() { return () => {}; },
    async close() {},
    async request(method: string) {
      if (method === "account/read") return { account: { type: "chatgpt", email: "fixture@example.test", planType: "plus" }, requiresOpenaiAuth: false };
    if (method === "model/list") return { data: [{ id: "fixture", model: "fixture", isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "medium" }] }] };
      if (method === "thread/start") return { thread: { id: "thread-fixture" }, model: "fixture" };
      if (method === "turn/start") {
        queueMicrotask(() => { void (async () => {
          notify("turn/started", { threadId: "thread-fixture", turn: { id: "turn-fixture" } });
          for (const call of fixtureCalls) await handleRequest?.("item/tool/call", { threadId: "thread-fixture", turnId: "turn-fixture", callId: call.id, tool: call.name, arguments: call.arguments });
          notify("turn/completed", { threadId: "thread-fixture", turn: { id: "turn-fixture", status: "completed" } });
        })(); });
        return { turn: { id: "turn-fixture" } };
      }
      throw new Error(`Unexpected Codex fixture request: ${method}`);
    },
  };
}

it("persists original scalar types through Codex and rejects coercible invalid input before mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "inkos-tool-arguments-"));
  try {
    const values = [true, false, 1, 0, "1", "0"];
    const node = {
      id: "opening", title: "Opening", type: "start", act: "one",
      sceneDesc: "A door opens.", dialogue: [],
      choices: [{
        id: "enter", text: "Enter", targetNodeId: "opening",
        condition: { var: "v1", op: "==", value: false },
        effects: [{ var: "v1", op: "set", value: true }],
      }],
    };
    const calls: ToolCall[] = values.map((value, index) => ({
      type: "toolCall", id: "variable-" + index, name: "add_variable",
      arguments: { name: "v" + index, type: "story-value", default: value },
    }));
    calls.push({ type: "toolCall", id: "node", name: "connect_choice", arguments: { node } });
    calls.push({ type: "toolCall", id: "invalid", name: "set_world_anchor", arguments: { durationMinutes: "12" } });
    const client = createLLMClient({
      service: "custom", provider: "openai", configSource: "studio", model: "fixture",
      baseUrl: "https://example.invalid/v1", apiKey: "fixture", apiFormat: "chat",
      temperature: 0, stream: true, thinkingBudget: 0,
    });
    fixtureCalls = calls;
    const agent = new Agent({
      projectRoot: root,
      settings: { model: "fixture", reasoningEffort: "medium", serviceTier: "default" },
      initialState: { model: client._piModel!, systemPrompt: "Apply fixture tools", messages: [], tools: [
        createAddVariableTool(root, "film"), createConnectChoiceTool(root, "film"),
        createSetWorldAnchorTool(root, "film"),
      ] },
      beforeToolCall: preserveToolArgumentTypes,
    });
    await agent.prompt("Apply the supplied fixture changes.");
    const graph = (await loadStoryGraph(root, "film"))!;
    expect(graph.variables.map(variable => variable.default)).toEqual(values);
    expect(graph.nodes[0]?.choices).toEqual(node.choices);
    const state = initVarState(graph.variables);
    expect(visibleChoices(graph.nodes[0]!, state).map(choice => choice.id)).toEqual(["enter"]);
    expect(visibleChoices(graph.nodes[0]!, applyEffects(state, graph.nodes[0]!.choices[0]!.effects))).toEqual([]);
    const results = agent.state.messages.filter(message => message.role === "toolResult");
    expect(results.filter(result => result.isError)).toHaveLength(1);
    const failure = results.find(result => result.toolCallId === "invalid")!;
    expect(JSON.parse(failure.content.filter(part => part.type === "text").map(part => part.text).join("")))
      .toMatchObject({ code: "TOOL_SCHEMA_INVALID", issues: [{ path: "/durationMinutes" }] });
    expect(graph.worldAnchor).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
