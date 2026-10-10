import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Type } from "@sinclair/typebox";
import { createPiAdapter } from "../adapter.js";
import { createOfficialPiSdkPort } from "../official-sdk.js";
import { PiHostToolError, type PiEvent, type PiHostTool, type PiRunSpec, type PiToolResult } from "../contracts.js";
import { assistant, deferred } from "../__fixtures__/fake-sdk.js";
import { officialModelFixture } from "../__fixtures__/official-model.js";

const result = () => ({ content: [{ type: "text" as const, text: "saved" }], details: { receipt: "persisted" } });
const tool = (name: string): PiHostTool => ({ name, label: name, description: "host fixture", parameters: Type.Object({ value: Type.String() }),
  execute: vi.fn(async () => result()) });
const call = (id: string, name: string, args: Record<string, unknown> = { value: "x" }) => ({ type: "toolCall" as const, id, name, arguments: args });
const response = (content: NonNullable<Parameters<typeof assistant>[0]>, id: string) => assistant(content, { responseId: id,
  stopReason: content.some(part => part.type === "toolCall") ? "toolUse" : "stop",
  usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
async function setup(responses: ReturnType<typeof response>[], tools: PiHostTool[], options: Partial<PiRunSpec> = {}, chunks?: string[]) {
  const model = officialModelFixture(responses, chunks);
  const sdk = createOfficialPiSdkPort();
  let created!: Awaited<ReturnType<typeof sdk.createAgentSession>>["session"];
  let manager!: ReturnType<typeof sdk.sessionInMemory>;
  const create = sdk.createAgentSession.bind(sdk), inMemory = sdk.sessionInMemory.bind(sdk);
  sdk.sessionInMemory = () => (manager = inMemory());
  sdk.createAgentSession = async args => { const result = await create(args); created = result.session; return result; };
  const handle = await createPiAdapter({ provider: "openai", modelId: "fixture-model", thinkingLevel: "off", systemPrompt: "host-only prompt",
    initialMessages: [], tools, ...options }, { sdk, modelRuntime: model.runtime });
  return { handle, model, manager, session: created };
}

describe("createPiAdapter with official SDK 1.1.0 session and deterministic model", () => {
  let network: ReturnType<typeof vi.fn>;
  beforeEach(() => { network = vi.fn(async () => { throw new Error("Network forbidden"); }); vi.stubGlobal("fetch", network); });
  afterEach(() => { expect(network).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });

  it("restores canonical session context, awaits receipts, and blocks same-batch actions after completion", async () => {
    const save = tool("host_save"), finish = { ...tool("host_finish"), completesRun: () => true }, effect = tool("host_effect");
    const entered = deferred(), release = deferred(), ended = deferred(), endRelease = deferred();
    const initialMessages = [{ role: "user" as const, content: "committed user", timestamp: 1 }, response([{ type: "text", text: "committed assistant" }], "committed")];
    const { handle, model, manager, session } = await setup([response([call("save", "host_save"), call("finish", "host_finish"), call("after", "host_effect", { value: 7 })], "run")],
      [save, finish, effect], { initialMessages });
    handle.subscribe(async event => {
      if (event.type === "tool_execution_start" && event.toolCallId === "save") { entered.resolve(); await release.promise; }
      if (event.type === "agent_end") { ended.resolve(); await endRelease.promise; }
    });
    try {
      const run = handle.prompt("finish"); await entered.promise; expect(save.execute).not.toHaveBeenCalled(); release.resolve();
      await ended.promise; let settled = false; const waiting = handle.waitForSettled().then(() => { settled = true; });
      await Promise.resolve(); expect(settled).toBe(false); endRelease.resolve();
      const outcome = await run; await waiting; expect(outcome.status).toBe("completed"); expect(effect.execute).not.toHaveBeenCalled();
      expect(model.observed).toHaveLength(1); expect(JSON.stringify(model.observed)).toContain("committed assistant");
      expect(session.agent.toolExecution).toBe("sequential"); expect(JSON.stringify(manager.buildSessionContext())).toContain("persisted");
    } finally { release.resolve(); endRelease.resolve(); await handle.dispose(); }
  });
  it("lets a rejected structured result be corrected by the next actual model response", async () => {
    const finish: PiHostTool = { ...tool("host_finish"), completesRun: () => true,
      execute: vi.fn(async (_id, args, _signal, onUpdate) => {
        if (args.value !== "bad") return result();
        const rejected: PiToolResult = { content: [{ type: "text", text: "api_key=sk-demo-secret" }],
          details: { receipt: "validation-rejected", apiKey: "demo-key" }, isError: true,
          failure: { kind: "recoverable", category: "validation", feedback: "Correct the section" } };
        onUpdate?.(rejected); return rejected;
      }) };
    const effect = tool("host_effect");
    const { handle, model } = await setup([
      response([call("wrong", "host_finish", { value: "bad" })], "wrong"),
      response([call("corrected", "host_finish"), call("after", "host_effect")], "corrected"),
    ], [finish, effect]);
    try {
      expect((await handle.prompt("finish")).status).toBe("completed"); expect(model.observed).toHaveLength(2);
      expect(finish.execute).toHaveBeenCalledTimes(2); expect(effect.execute).not.toHaveBeenCalled();
      expect(JSON.stringify(model.observed[1])).toContain("Correct the section");
      expect(JSON.stringify(model.observed[1])).not.toContain("demo-secret");
      expect(JSON.stringify(model.observed[1])).not.toContain("demo-key");
    } finally { await handle.dispose(); }
  });
  it("allows an explicitly recoverable read and terminates a typed fatal auth failure", async () => {
    const query: PiHostTool = { ...tool("host_query"), classifyFailure: () => ({ kind: "recoverable", category: "read", feedback: "Refine query" }),
      execute: vi.fn(async (_id, args) => { if (args.value === "bad") throw new Error("private read error"); return result(); }) };
    const fatal: PiHostTool = { ...tool("host_fatal"), classifyFailure: () => ({ kind: "recoverable", category: "read" }),
      execute: async () => { throw new PiHostToolError({ kind: "fatal", category: "auth" }); } };
    const effect = tool("host_effect");
    const { handle, model } = await setup([response([call("q1", "host_query", { value: "bad" }), call("q2", "host_query"), call("fatal", "host_fatal"), call("after", "host_effect")], "query")], [query, fatal, effect]);
    try {
      expect((await handle.prompt("query")).status).toBe("failed"); expect(query.execute).toHaveBeenCalledTimes(2);
      expect(effect.execute).not.toHaveBeenCalled(); expect(model.observed).toHaveLength(1);
    } finally { await handle.dispose(); }
  });
  it.each([true, false])("uses synchronous structural decoding and prevents native scalar coercion (valid=%s)", async valid => {
    const prepare = vi.fn(async (args: unknown) => args);
    const save: PiHostTool = { ...tool("host_save"), parameters: Type.Object({ values: Type.Array(Type.Number()) }), prepareArguments: prepare, completesRun: () => true };
    const { handle } = await setup([response([call("save", "host_save", { values: valid ? "[1,2]" : '["1"]' })], "schema")], [save]);
    try {
      expect((await handle.prompt("save")).status).toBe(valid ? "completed" : "failed");
      expect(prepare).toHaveBeenCalledTimes(valid ? 1 : 0); expect(save.execute).toHaveBeenCalledTimes(valid ? 1 : 0);
    } finally { await handle.dispose(); }
  });
  it("stops the actual stream at the budget and keeps legal partial plus final usage", async () => {
    const effect = tool("host_effect");
    const { handle, model } = await setup([response([], "budget")], [effect], { maxOutputTokens: 1 }, ["x", "x".repeat(100), "must not escape"]);
    const events: PiEvent[] = []; handle.subscribe(event => { events.push(event); });
    try {
      const outcome = await handle.prompt("stream");
      expect(outcome).toMatchObject({ status: "failed", error: { code: "PI_OUTPUT_LIMIT" }, usage: { input: 3, output: 2 } });
      expect(model.emittedChunks).toBe(2); expect(model.observed).toHaveLength(1); expect(effect.execute).not.toHaveBeenCalled();
      expect(JSON.stringify({ events, outcome })).not.toContain("must not escape");
      expect(JSON.stringify(outcome.messages)).not.toContain("x".repeat(100));
      expect(outcome.messages).toEqual(expect.arrayContaining([expect.objectContaining({ content: [{ type: "text", text: "x" }] })]));
      await handle.continue(); expect(model.observed).toHaveLength(1);
    } finally { await handle.dispose(); }
  });
  it("waits for the actual core listener while cancellation and disposal race", async () => {
    const effect = tool("host_effect"), entered = deferred(), release = deferred();
    const { handle } = await setup([response([call("effect", "host_effect")], "cancel")], [effect]);
    handle.subscribe(async event => { if (event.type === "tool_execution_start") { entered.resolve(); await release.promise; } });
    try {
      const run = handle.prompt("cancel"); await entered.promise; let disposed = false;
      const cancel = handle.abort(), dispose = handle.dispose().then(() => { disposed = true; });
      await Promise.resolve(); expect(disposed).toBe(false); release.resolve();
      expect((await run).status).toBe("cancelled"); expect((await cancel).status).toBe("cancelled"); await dispose;
      expect(effect.execute).not.toHaveBeenCalled(); await handle.dispose();
    } finally { release.resolve(); await handle.dispose(); }
  });
  it("bounds a second idless response in actual turn and agent snapshots", async () => {
    const save = tool("host_save"), excessive = "x".repeat(100);
    const first = response([call("save", "host_save")], "first"), second = response([{ type: "text", text: excessive }], "second");
    delete first.responseId; delete second.responseId;
    const { handle, model } = await setup([first, second], [save], { maxOutputTokens: 8 });
    const events: PiEvent[] = []; handle.subscribe(event => { events.push(event); });
    try {
      const outcome = await handle.prompt("save then answer");
      expect(outcome).toMatchObject({ status: "failed", error: { code: "PI_OUTPUT_LIMIT" }, usage: { input: 6, output: 4 } });
      expect(model.observed).toHaveLength(2); expect(save.execute).toHaveBeenCalledOnce();
      expect(events.filter(event => event.type === "turn_end")).toHaveLength(2);
      expect(events.filter(event => event.type === "turn_end").at(-1)).toMatchObject({ message: { content: [], stopReason: "aborted" } });
      expect(JSON.stringify({ events, outcome })).not.toContain(excessive);
    } finally { await handle.dispose(); }
  });
  it("keeps actual listener persistence failure fatal before side effects", async () => {
    const effect = tool("host_effect"); const { handle, model } = await setup([response([call("effect", "host_effect")], "persist")], [effect]);
    handle.subscribe(event => { if (event.type === "tool_execution_start") throw new Error("Bearer secret /home/private/receipt"); });
    try {
      const outcome = await handle.prompt("persist"); expect(outcome).toMatchObject({ status: "failed", error: { code: "PI_LISTENER_FAILED" } });
      expect(effect.execute).not.toHaveBeenCalled(); expect(model.observed).toHaveLength(1); expect(JSON.stringify(outcome)).not.toContain("Bearer secret");
    } finally { await handle.dispose(); }
  });
  it.each(["isError", "throw"] as const)("projects an error partial before an actual SDK %s terminal failure", async terminal => {
    const diagnostic: PiToolResult = { content: [{ type: "text", text: "Bearer demo-secret api_key=sk-demo-secret /home/private/auth.json C:\\private\\auth.json" }],
      details: { receipt: "error-receipt", feedback: "Public error feedback", apiKey: "demo-key", password: "demo-password",
        authPath: "C:\\private\\auth.json", nested: { password: "nested-password" } }, isError: true };
    const fail: PiHostTool = { ...tool("host_fail"), execute: async (_id, _args, _signal, onUpdate) => {
      onUpdate?.(diagnostic);
      if (terminal === "throw") throw new Error("Bearer demo-secret api_key=sk-demo-secret C:\\private\\auth.json");
      return diagnostic;
    } };
    const effect = tool("host_effect"), { handle, model } = await setup([
      response([call("fail", "host_fail"), call("after", "host_effect")], "error"),
    ], [fail, effect]);
    const events: PiEvent[] = []; handle.subscribe(event => { events.push(event); });
    try {
      const outcome = await handle.prompt("fail safely");
      expect(outcome).toMatchObject({ status: "failed", error: { code: "PI_TOOL_FAILED" } });
      expect(effect.execute).not.toHaveBeenCalled(); expect(model.observed).toHaveLength(1);
      expect(events.find(event => event.type === "tool_execution_update")).toMatchObject({
        partialResult: { content: [{ type: "text", text: "Public error feedback" }], details: { receipt: "error-receipt", feedback: "Public error feedback" }, isError: true },
      });
      const serialized = JSON.stringify({ events, outcome });
      for (const secret of ["demo-secret", "demo-key", "demo-password", "nested-password", "/home/private", "C:\\\\private", "authPath", "apiKey", "password"]) {
        expect(serialized).not.toContain(secret);
      }
    } finally { await handle.dispose(); }
  });
  it("preserves ordinary successful business content and partial details", async () => {
    const ordinary = { content: [{ type: "text" as const, text: "business api_key=example /home/report.txt C:\\reports\\summary.txt" }],
      details: { apiKey: "business-column", password: "business-label", authPath: "C:\\reports\\summary.txt", nested: { value: 7 } } };
    const save: PiHostTool = { ...tool("host_save"), completesRun: () => true,
      execute: async (_id, _args, _signal, onUpdate) => { onUpdate?.(ordinary); return ordinary; } };
    const { handle } = await setup([response([call("save", "host_save")], "business")], [save]);
    const events: PiEvent[] = []; handle.subscribe(event => { events.push(event); });
    try {
      const outcome = await handle.prompt("save"); expect(outcome.status).toBe("completed");
      expect(events.find(event => event.type === "tool_execution_update")).toMatchObject({ partialResult: ordinary });
      expect(outcome.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: "toolResult", ...ordinary })]));
    } finally { await handle.dispose(); }
  });
  it.each(["recoverable", "success"] as const)("cannot downgrade a fatal partial with a later %s result", async terminal => {
    const fail: PiHostTool = { ...tool("host_fail"), completesRun: () => true,
      classifyFailure: () => ({ kind: "recoverable", category: "read", feedback: "Retry the query" }),
      execute: async (_id, _args, _signal, onUpdate) => {
        const fatal: PiToolResult = { ...result(), isError: true, failure: { kind: "fatal", category: "auth" } };
        onUpdate?.(fatal);
        return terminal === "success" ? result() : { ...result(), isError: true };
      } };
    const effect = tool("host_effect"), { handle, model } = await setup([
      response([call("fail", "host_fail"), call("after", "host_effect")], "fatal-partial"),
    ], [fail, effect]);
    try {
      expect(await handle.prompt("fail")).toMatchObject({ status: "failed", error: { code: "PI_TOOL_FAILED" } });
      expect(effect.execute).not.toHaveBeenCalled(); expect(model.observed).toHaveLength(1);
    } finally { await handle.dispose(); }
  });
  it("preserves approved synchronous preparation feedback in events, transcript and restored session", async () => {
    const feedback = "Use a string for value", prepare = vi.fn(async (args: unknown) => args);
    const finish: PiHostTool = { ...tool("host_finish"), completesRun: () => true, prepareArguments: prepare,
      classifyFailure: (_error, phase) => phase === "prepare" ? { kind: "recoverable", category: "validation",
        feedback: `${feedback}; Bearer demo-secret /home/private/auth.json` } : undefined };
    const { handle, model } = await setup([
      response([call("wrong", "host_finish", { value: 7 })], "wrong"),
      response([call("corrected", "host_finish")], "corrected"),
    ], [finish]);
    const events: PiEvent[] = []; handle.subscribe(event => { events.push(event); });
    try {
      const outcome = await handle.prompt("finish"); expect(outcome.status).toBe("completed");
      expect(prepare).toHaveBeenCalledOnce(); expect(finish.execute).toHaveBeenCalledOnce(); expect(model.observed).toHaveLength(2);
      const rejected = outcome.messages.find(message => message.role === "toolResult" && message.toolCallId === "wrong");
      expect(rejected).toMatchObject({ isError: true, content: [{ type: "text", text: expect.stringContaining(feedback) }],
        details: { feedback: expect.stringContaining(feedback) } });
      expect(events.find(event => event.type === "tool_execution_end" && event.toolCallId === "wrong")).toMatchObject({
        result: { content: [{ type: "text", text: expect.stringContaining(feedback) }], details: { feedback: expect.stringContaining(feedback) } },
      });
      expect(JSON.stringify(model.observed[1])).toContain(feedback);
      const restored = await setup([response([{ type: "text", text: "resumed" }], "restored")], [], { initialMessages: outcome.messages });
      try {
        await restored.handle.prompt("resume");
        expect(JSON.stringify(restored.manager.buildSessionContext())).toContain(feedback);
        expect(JSON.stringify(restored.model.observed[0])).toContain(feedback);
        const serialized = JSON.stringify({ events, outcome, restored: restored.model.observed });
        expect(serialized).not.toContain("demo-secret"); expect(serialized).not.toContain("/home/private");
      } finally { await restored.handle.dispose(); }
    } finally { await handle.dispose(); }
  });
});
