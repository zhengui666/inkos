import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../codex/agent.js";
import { type ToolCall } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { preserveToolArgumentTypes } from "../agent/tool-arguments.js";
import { createAddVariableTool, createConnectChoiceTool, createSetWorldAnchorTool } from "../agent/film-authoring-tools.js";
import { createLLMClient } from "../llm/provider.js";
import { loadStoryGraph } from "../interactive-film/graph-store.js";
import { initVarState, applyEffects, visibleChoices } from "../interactive-film/evaluator.js";
import { CodexRuntimeFixtureScope } from "./fixtures/codex-runtime-fixture.js";

const codex = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock("../codex/client.js", () => ({ createCodexClient: codex.createClient }));

let root = "";
let scope: CodexRuntimeFixtureScope | undefined;

beforeEach(async () => {
  vi.stubEnv("INKOS_CODEX_HOME", undefined);
  vi.stubEnv("INKOS_CODEX_STATE_ROOT", undefined);
  root = await mkdtemp(join(tmpdir(), "inkos-tool-arguments-"));
  scope = new CodexRuntimeFixtureScope();
});

afterEach(async () => {
  try { await scope?.drain(); }
  finally {
    codex.createClient.mockReset();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
    root = "";
    scope = undefined;
  }
});

it("persists original scalar types through Codex and rejects coercible invalid input before mutation", async () => {
  const projectRoot = root;
  const fixtureScope = scope!;
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
  let replyStage = 0;
  const project = fixtureScope.registerProject(projectRoot, {
    reply: () => {
      if (replyStage++ === 0) return { calls: calls.map(call => ({ id: call.id, name: call.name, args: call.arguments })) };
      if (replyStage === 2) return { text: "Fixture tools applied.", complete: true };
      throw new Error("Unexpected fixture model dispatch after tool batch completion");
    },
  });
  codex.createClient.mockReset().mockImplementation(fixtureScope.createClient);
  const client = createLLMClient({
    service: "custom", provider: "openai", configSource: "studio", model: "fixture",
    baseUrl: "https://example.invalid/v1", apiKey: "fixture", apiFormat: "chat",
    temperature: 0, stream: true, thinkingBudget: 0,
  });
  const agent = new Agent({
    projectRoot,
    settings: { model: "fixture", reasoningEffort: "medium", serviceTier: "default" },
    initialState: { model: client._piModel!, systemPrompt: "Apply fixture tools", messages: [], tools: [
      createAddVariableTool(projectRoot, "film"), createConnectChoiceTool(projectRoot, "film"),
      createSetWorldAnchorTool(projectRoot, "film"),
    ] },
    beforeToolCall: preserveToolArgumentTypes,
  });
  await fixtureScope.run(() => agent.prompt("Apply the supplied fixture changes."));
  const graph = (await loadStoryGraph(projectRoot, "film"))!;
  expect(project.fixture.toolResponses.map(({ id, name, args }) => ({ id, name, args })))
    .toEqual(calls.map(call => ({ id: call.id, name: call.name, args: call.arguments })));
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
});
