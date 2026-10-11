import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Type } from "@sinclair/typebox";
import type { AssistantMessage, Message } from "@mariozechner/pi-ai";
import type { CodexAgentOptions } from "../codex/agent.js";
import type { LLMClient } from "../llm/provider.js";
import { runWorkerAgent, runWorkerAgentTool, type WorkerAgentOptions } from "../agent/worker-agent.js";
import { isUnboundedWorkerExecution, withUnboundedWorkerExecution } from "../agent/worker-execution-policy.js";
import { currentRuntimeRun } from "../runtime/run-context.js";
import type { RuntimeSelection } from "../runtime/contracts.js";
import { CodexRuntimeFixtureScope } from "./fixtures/codex-runtime-fixture.js";

const mocks = vi.hoisted(() => ({ run: vi.fn(), constructed: vi.fn(), abort: vi.fn(), createClient: vi.fn() }));
vi.mock("../codex/client.js", () => ({ createCodexClient: mocks.createClient }));
vi.mock("../codex/agent.js", () => ({
  Agent: class {
    readonly state: CodexAgentOptions["initialState"];
    readonly selection: RuntimeSelection | undefined;
    invocation = "";
    constructor(readonly options: CodexAgentOptions) {
      this.selection = currentRuntimeRun()?.selection;
      this.state = { ...options.initialState, messages: [...options.initialState.messages] };
      mocks.constructed(this);
    }
    async prompt(input: string | Message[]) {
      this.invocation = typeof input === "string" ? input : input.filter(message => message.role === "user")
        .map(message => typeof message.content === "string" ? message.content : "").join("\n");
      this.state.messages.push(...(typeof input === "string" ? [{ role: "user" as const, content: input, timestamp: Date.now() }] : input));
      this.options.onModelTurn?.();
      await mocks.run(this);
    }
    subscribe() { return () => {}; }
    abort() { mocks.abort(); }
  },
}));
type Fixture = { state: CodexAgentOptions["initialState"]; options: CodexAgentOptions; selection: RuntimeSelection | undefined; invocation: string };
const settings = { model: "gpt-6.1-sol", reasoningEffort: "ultra" as const, serviceTier: "priority" as const };
let root: string, scope: CodexRuntimeFixtureScope, project: ReturnType<CodexRuntimeFixtureScope["registerProject"]>;
const client = (maxTokens?: number): LLMClient => ({
  provider: "openai", apiFormat: "chat", stream: true,
  ...(maxTokens === undefined ? {} : { defaults: { temperature: 0, maxTokens, thinkingBudget: 0, extra: {} } }),
  _codex: { projectRoot: root, settings },
// Exercise the existing runtime fallback for older clients without defaults.
} as LLMClient);
const messages = [{ role: "user" as const, content: "Continue creating the requested story" }];
const resultTool = { name: "submit_result", label: "Submit", description: "Return result", parameters: Type.Object({ text: Type.String() }) };
function response(agent: Fixture, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
  return { role: "assistant", content: [{ type: "text", text: "created" }], api: agent.state.model.api,
    provider: agent.state.model.provider, model: agent.state.model.id, timestamp: Date.now(), stopReason,
    usage: { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
async function complete(agent: Fixture) {
  const tool = agent.state.tools[0];
  if (tool) await tool.execute("result", await tool.prepareArguments!({ text: "created" }), agent.options.signal);
  agent.state.messages.push(response(agent));
}
const run = async (structured: boolean, selectedClient = client(4096), options: WorkerAgentOptions = {}, request = messages) => {
  if (structured) return await scope.run(signal => {
      const workerOptions = { ...options, projectRoot: root, signal: options.signal ?? signal };
      return runWorkerAgentTool(selectedClient, "ignored", request, resultTool, workerOptions);
    });
  return await scope.run(signal => {
    const workerOptions = { ...options, projectRoot: root, signal: options.signal ?? signal };
    return runWorkerAgent(selectedClient, "ignored", request, workerOptions);
  });
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

beforeEach(async () => {
  mocks.run.mockReset(); mocks.constructed.mockReset(); mocks.abort.mockReset(); mocks.run.mockImplementation(complete);
  vi.stubEnv("INKOS_CODEX_HOME", undefined); vi.stubEnv("INKOS_CODEX_STATE_ROOT", undefined);
  root = await mkdtemp(join(tmpdir(), "inkos-worker-policy-"));
  scope = new CodexRuntimeFixtureScope(); project = scope.registerProject(root);
  mocks.createClient.mockReset().mockImplementation(scope.createClient);
});
afterEach(async () => {
  try {
    await scope.drain();
    expect(project.fixture.pendingTaskCount).toBe(0);
    expect(project.fixture.peers.every(peer => peer.closed && peer.closeCount === 1)).toBe(true);
  } finally {
    mocks.createClient.mockReset();
    vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});

describe.each([false, true])("worker application execution policy, structured=%s", structured => {
  it.each([
    { maxTokens: 17, defaults: 4096, expected: 17 },
    { maxTokens: undefined, defaults: 4096, expected: 4096 },
    { maxTokens: undefined, defaults: undefined, expected: 32768 },
  ])("keeps the existing output cap $expected outside the creation scope", async ({ maxTokens, defaults, expected }) => {
    await run(structured, client(defaults), { maxTokens });
    const agent = mocks.constructed.mock.calls[0]![0] as Fixture;
    expect(agent.options.maxOutputTokens).toBe(expected);
    expect(agent.selection).toMatchObject({ harnessId: "codex", modelId: settings.model, effort: settings.reasoningEffort, serviceTier: settings.serviceTier });
    expect(agent.state.model.id).toBe(settings.model);
    expect(agent.options.signal).toBeInstanceOf(AbortSignal);
  });

  it("omits the host output cap and deadline signal while preserving caller settings and signal", async () => {
    const controller = new AbortController();
    await withUnboundedWorkerExecution(() => run(structured, client(1), { maxTokens: 1, timeoutMs: 1, signal: controller.signal }));
    const agent = mocks.constructed.mock.calls[0]![0] as Fixture;
    expect(agent.options).not.toHaveProperty("maxOutputTokens");
    expect(agent.options.signal).toBe(controller.signal);
    expect(agent.selection).toMatchObject({ harnessId: "codex", modelId: settings.model, effort: settings.reasoningEffort, serviceTier: settings.serviceTier });
    expect(agent.state.model.id).toBe("gpt-6.1-sol");
    expect(isUnboundedWorkerExecution()).toBe(false);
  });

  it("does not construct for early cancellation and aborts once after prompt entry", async () => {
    const stopped = new AbortController(); stopped.abort(new Error("user stopped before construction"));
    await expect(withUnboundedWorkerExecution(() => run(structured, client(), { signal: stopped.signal })))
      .rejects.toThrow("user stopped before construction");
    expect(mocks.constructed).not.toHaveBeenCalled();
    expect(mocks.abort).not.toHaveBeenCalled();

    const controller = new AbortController();
    const entered = deferred(); let agent!: Fixture;
    mocks.run.mockImplementation((current: Fixture) => new Promise<void>((_resolve, reject) => {
      agent = current;
      entered.resolve();
      agent.options.signal!.addEventListener("abort", () => reject(agent.options.signal!.reason), { once: true });
    }));
    const running = withUnboundedWorkerExecution(() => run(structured, client(), { signal: controller.signal }));
    try {
      const reachedPrompt = await Promise.race([entered.promise.then(() => true), running.then(() => false, () => false)]);
      expect(reachedPrompt).toBe(true);
      expect(agent.options.signal).toBe(controller.signal);
      controller.abort(new Error("user stopped creation"));
      await expect(running).rejects.toThrow("user stopped creation");
      expect(mocks.abort).toHaveBeenCalledOnce();
    } finally {
      controller.abort(new Error("test cleanup"));
      await Promise.allSettled([running]);
    }
  });

  it("preserves intrinsic model output-limit errors", async () => {
    mocks.run.mockImplementation(async (agent: Fixture) => { agent.state.messages.push(response(agent, "length")); });
    await expect(withUnboundedWorkerExecution(() => run(structured))).rejects.toMatchObject({ code: "MODEL_OUTPUT_LIMIT" });
    expect(mocks.run).toHaveBeenCalledOnce();
  });
});

describe("async-local worker policy isolation", () => {
  it("keeps a concurrent default worker bounded while nested creation work survives long elapsed time", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubEnv("INKOS_WORKER_TIMEOUT_MS", "50");
    const drain = deferred(), scopedSignal = new AbortController(), boundedSignal = new AbortController();
    const enteredCreation = deferred(), enteredBounded = deferred();
    let creationAgent!: Fixture, boundedAgent!: Fixture;
    mocks.run.mockImplementation(async (agent: Fixture) => {
      if (agent.invocation === "unbounded invocation") {
        creationAgent = agent; enteredCreation.resolve(); await drain.promise; return complete(agent);
      }
      boundedAgent = agent; enteredBounded.resolve();
      await new Promise<void>((_resolve, reject) => agent.options.signal!.addEventListener("abort", () => reject(agent.options.signal!.reason), { once: true }));
    });
    const creation = withUnboundedWorkerExecution(async () => {
      await Promise.resolve();
      expect(isUnboundedWorkerExecution()).toBe(true);
      return withUnboundedWorkerExecution(() => run(false, client(1), { signal: scopedSignal.signal, timeoutMs: 1 }, [{ role: "user", content: "unbounded invocation" }]));
    });
    const bounded = run(false, client(4096), { signal: boundedSignal.signal }, [{ role: "user", content: "bounded invocation" }]).then(() => null, error => error);
    try {
      const entries = Promise.all([enteredCreation.promise, enteredBounded.promise]).then(() => true);
      const endedEarly = Promise.race([creation, bounded]).then(() => false, () => false);
      expect(await Promise.race([entries, endedEarly])).toBe(true);
      const constructed = mocks.constructed.mock.calls.map(([agent]) => agent as Fixture);
      expect(constructed).toHaveLength(2);
      expect(constructed.filter(agent => agent.invocation === "unbounded invocation")).toHaveLength(1);
      expect(constructed.filter(agent => agent.invocation === "bounded invocation")).toHaveLength(1);
      expect(creationAgent.options.maxOutputTokens).toBeUndefined();
      expect(boundedAgent.options.maxOutputTokens).toBe(4096);
      expect(creationAgent.options.signal).toBe(scopedSignal.signal);
      await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
      expect(await bounded).toMatchObject({ code: "WORKER_TIMEOUT" });
      expect(scopedSignal.signal.aborted).toBe(false);
      expect(mocks.abort).toHaveBeenCalledOnce();
      drain.resolve();
      await expect(creation).resolves.toMatchObject({ content: "created" });
      expect(isUnboundedWorkerExecution()).toBe(false);
      mocks.run.mockImplementation(complete);
      await run(false);
      expect((mocks.constructed.mock.calls.at(-1)![0] as Fixture).options.maxOutputTokens).toBe(4096);
    } finally {
      drain.resolve(); scopedSignal.abort(new Error("test cleanup")); boundedSignal.abort(new Error("test cleanup"));
      await Promise.allSettled([creation, bounded]);
    }
  });

  it("restores the policy after a nested scope rejects", async () => {
    await expect(withUnboundedWorkerExecution(async () => {
      await Promise.resolve();
      await withUnboundedWorkerExecution(async () => { expect(isUnboundedWorkerExecution()).toBe(true); });
      expect(isUnboundedWorkerExecution()).toBe(true);
      throw new Error("creation failed");
    })).rejects.toThrow("creation failed");
    expect(isUnboundedWorkerExecution()).toBe(false);
    await run(false);
    expect((mocks.constructed.mock.calls[0]![0] as Fixture).options.maxOutputTokens).toBe(4096);
  });

  it("ignores disabled deadline configuration only inside the unbounded scope", async () => {
    vi.stubEnv("INKOS_WORKER_TIMEOUT_MS", "invalid");
    await withUnboundedWorkerExecution(() => run(false));
    await expect(run(false)).rejects.toThrow("Worker timeout");
    expect(mocks.constructed).toHaveBeenCalledOnce();
  });

  it("retains the three-attempt structured validation safeguard inside the creation scope", async () => {
    mocks.run.mockImplementation(async (agent: Fixture) => { agent.state.messages.push(response(agent)); });
    await expect(withUnboundedWorkerExecution(() => run(true))).rejects.toMatchObject({ code: "WORKER_RESULT_MISSING", attempts: 3 });
    expect(mocks.run).toHaveBeenCalledTimes(3);
  });
});
