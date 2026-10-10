import { describe, expect, it, vi } from "vitest";
import { Type } from "@sinclair/typebox";
import { createPiAdapter } from "../adapter.js";
import { PiHostToolError, type PiEvent, type PiHostTool, type PiRunSpec } from "../contracts.js";
import { assistant, deferred, fakeSdk, type FakePlan } from "../__fixtures__/fake-sdk.js";

const ok = () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} });
const tool = (name = "host_effect"): PiHostTool => ({ name, label: name, description: name,
  parameters: Type.Object({ value: Type.String() }), execute: vi.fn(async () => ok()) });
async function setup(plan: FakePlan, tools: PiHostTool[], options: Partial<PiRunSpec> = {}) {
  const fake = fakeSdk(plan);
  const handle = await createPiAdapter({ provider: "openai", modelId: "fixture-model", thinkingLevel: "off",
    systemPrompt: "host", initialMessages: [], tools, ...options }, { sdk: fake.port, modelRuntime: {} });
  return { fake, handle };
}

describe("Pi repair fixture contracts", () => {
  it("keeps a recoverable structured-result receipt and latches only accepted completion", async () => {
    let accepted = false;
    const finish: PiHostTool = { ...tool("host_finish"), completesRun: () => true,
      execute: vi.fn(async (_id, args) => args.value === "invalid" ? {
        ...ok(), isError: true, details: { receipt: "rejected-result" },
        failure: { kind: "recoverable", category: "validation", feedback: "Result is missing the required section" },
      } : (accepted = true, ok())) };
    const later = tool();
    const { handle, fake } = await setup(async session => {
      await session.call("host_finish", "wrong", { value: "invalid" });
      expect(accepted).toBe(false);
      await session.call("host_finish", "corrected", { value: "valid" });
      await session.call("host_effect", "after", { value: "forbidden" });
    }, [finish, later]);
    const outcome = await handle.prompt("finish");
    expect(outcome.status).toBe("completed"); expect(finish.execute).toHaveBeenCalledTimes(2);
    expect(outcome.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: "toolResult", isError: true,
      details: expect.objectContaining({ receipt: "rejected-result" }) })]));
    expect(later.execute).not.toHaveBeenCalled(); expect(fake.session.finishDecision).toEqual({ action: "end" });
    await handle.dispose();
  });
  it("allows an explicitly classified failed read followed by a valid query", async () => {
    const read: PiHostTool = { ...tool("host_query"), classifyFailure: () => ({ kind: "recoverable", category: "read", feedback: "Query unavailable; refine the query" }),
      execute: vi.fn(async (_id, args) => { if (args.value === "bad") throw new Error("private read failure"); return ok(); }) };
    const { handle } = await setup(async session => {
      await session.call("host_query", "failed-read", { value: "bad" });
      await session.call("host_query", "valid-read", { value: "valid" });
    }, [read]);
    expect((await handle.prompt("query")).status).toBe("completed"); expect(read.execute).toHaveBeenCalledTimes(2);
    await handle.dispose();
  });
  it("does not run a preparer or invalidate accepted completion for a malformed later action", async () => {
    const finish = { ...tool("host_finish"), completesRun: () => true };
    const prepare = vi.fn(async (args: unknown) => args), effect = { ...tool(), prepareArguments: prepare };
    const { handle } = await setup(async session => {
      await session.call("host_finish", "finish", { value: "x" }); await session.call("host_effect", "after", { value: 7 });
    }, [finish, effect]);
    expect((await handle.prompt("finish")).status).toBe("completed"); expect(prepare).not.toHaveBeenCalled();
    expect(effect.execute).not.toHaveBeenCalled(); await handle.dispose();
  });
  it("keeps an uncertain completion decision fatal after tool execution", async () => {
    const finish: PiHostTool = { ...tool("host_finish"), completesRun: () => { throw new Error("private completion state"); },
      classifyFailure: () => ({ kind: "recoverable", category: "validation" }) };
    const effect = tool(); const { handle } = await setup(async session => {
      await session.call("host_finish", "finish", { value: "x" }); await session.call("host_effect", "later", { value: "x" });
    }, [finish, effect]);
    expect((await handle.prompt("finish")).status).toBe("failed"); expect(effect.execute).not.toHaveBeenCalled(); await handle.dispose();
  });
  it.each(["owner", "guard", "persistence", "auth", "uncertain"] as const)("cannot downgrade fatal %s or start another side effect", async category => {
    const fatal: PiHostTool = { ...tool("host_fatal"),
      classifyFailure: () => ({ kind: "recoverable", category: "read" }),
      execute: async () => { throw new PiHostToolError({ kind: "fatal", category }); } };
    const effect = tool();
    const { handle } = await setup(async session => {
      await session.call("host_fatal", "fatal", { value: "x" });
      await session.call("host_effect", "later", { value: "x" });
    }, [fatal, effect]);
    expect((await handle.prompt("test")).status).toBe("failed"); expect(effect.execute).not.toHaveBeenCalled(); await handle.dispose();
  });
  it("clones and synchronously decodes nested object/array strings before preparing exactly once", async () => {
    const raw = { nested: '{"list":"[1,2]"}', rows: '[{"item":"{\\"value\\":\\"x\\"}"}]' };
    const original = structuredClone(raw);
    const prepare = vi.fn(async (args: unknown) => args);
    const execute = vi.fn(async () => ok());
    const structured: PiHostTool = { ...tool(), parameters: Type.Object({
      nested: Type.Object({ list: Type.Array(Type.Number()) }), rows: Type.Array(Type.Object({ item: Type.Object({ value: Type.String() }) })),
    }), prepareArguments: prepare, execute };
    const { handle, fake } = await setup(async session => { await session.call("host_effect", "decoded", raw); }, [structured]);
    const syncArgs = fake.session.options.customTools[0].prepareArguments(raw);
    expect(syncArgs).toEqual({ nested: { list: [1, 2] }, rows: [{ item: { value: "x" } }] });
    expect(syncArgs).not.toBeInstanceOf(Promise); expect(prepare).not.toHaveBeenCalled();
    expect((await handle.prompt("test")).status).toBe("completed"); expect(prepare).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith("decoded", syncArgs, expect.any(AbortSignal), expect.any(Function)); expect(raw).toEqual(original); await handle.dispose();
  });
  it.each(['{"value":"x"}', { value: "x" }])("accepts a complete JSON object without mutating it", async raw => {
    const effect = tool(); const { handle } = await setup(async session => { await session.call("host_effect", "json", raw); }, [effect]);
    expect((await handle.prompt("test")).status).toBe("completed"); expect(effect.execute).toHaveBeenCalledWith("json", { value: "x" }, expect.any(AbortSignal), expect.any(Function));
    await handle.dispose();
  });
  it.each([{ numbers: "[1,2,]" }, { numbers: '["1"]' }, { numbers: "1" }])("rejects illegal JSON and scalar coercion %j", async raw => {
    const effect = { ...tool(), parameters: Type.Object({ numbers: Type.Array(Type.Number()) }) };
    const { handle } = await setup(async session => { await session.call("host_effect", "bad", raw); }, [effect]);
    expect((await handle.prompt("test")).status).toBe("failed"); expect(effect.execute).not.toHaveBeenCalled(); await handle.dispose();
  });
  it.each([false, true])("projects preparer failures safely in every event and final transcript (recoverable=%s)", async recoverable => {
    const execute = vi.fn(async () => ok());
    const prepared: PiHostTool = { ...tool(), execute,
      prepareArguments: async () => { throw new Error("Bearer private-token /home/private/auth.json"); },
      ...(recoverable ? { classifyFailure: () => ({ kind: "recoverable" as const, category: "validation" as const,
        feedback: "Correct the required field; Bearer private-token /home/private/auth.json" }) } : {}) };
    const { handle } = await setup(async session => { await session.call("host_effect", "bad", { value: "x" }); }, [prepared]);
    const events: PiEvent[] = []; handle.subscribe(event => { events.push(event); });
    const outcome = await handle.prompt("test"); expect(outcome.status).toBe(recoverable ? "completed" : "failed");
    const serialized = JSON.stringify({ events, outcome }); expect(serialized).not.toContain("private-token"); expect(serialized).not.toContain("/home/private");
    if (recoverable) expect(serialized).toContain("Correct the required field");
    expect(execute).not.toHaveBeenCalled(); await handle.dispose();
  });
  it("aborts a continuing stream immediately, retains legal partial/usage, and closes subsequent actions", async () => {
    const effect = tool();
    const { handle, fake } = await setup(async session => {
      const partial = assistant([{ type: "text", text: "x" }], { responseId: "budget" });
      await session.emit({ type: "message_start", message: partial });
      await session.emit({ type: "message_update", message: partial, assistantMessageEvent: { type: "text_delta", delta: "x" } });
      const over = assistant([{ type: "text", text: "x".repeat(100) }], { responseId: "budget" });
      await session.emit({ type: "message_update", message: over, assistantMessageEvent: { type: "text_delta", delta: "over" } });
      expect(session.controller.signal.aborted).toBe(true);
      await session.emit({ type: "message_update", message: over, assistantMessageEvent: { type: "text_delta", delta: "must not escape" } });
      await session.call("host_effect", "forbidden", { value: "x" });
      const final = { ...over, stopReason: "aborted" as const, usage: { input: 3, output: 8, cacheRead: 0, cacheWrite: 0, totalTokens: 11,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      session.agent.state.messages.push(final);
      await session.emit({ type: "message_end", message: final });
    }, [effect], { maxOutputTokens: 1 });
    const events: PiEvent[] = []; handle.subscribe(event => { events.push(event); });
    const outcome = await handle.prompt("stream");
    expect(outcome).toMatchObject({ status: "failed", error: { code: "PI_OUTPUT_LIMIT" }, usage: { input: 3, output: 8 } });
    expect(JSON.stringify(events)).not.toContain("must not escape"); expect(JSON.stringify(outcome)).not.toContain("x".repeat(100));
    expect(outcome.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: "assistant", content: [{ type: "text", text: "x" }] })]));
    expect(effect.execute).not.toHaveBeenCalled(); await handle.continue(); expect(fake.session.runCount).toBe(1); await handle.dispose();
  });
  it("drains output-limit, cancellation and disposal concurrently without awaiting its own listener", async () => {
    const entered = deferred(), release = deferred();
    const { handle, fake } = await setup(async session => {
      const message = assistant([{ type: "text", text: "x".repeat(100) }]);
      await session.append(message);
    }, [], { maxOutputTokens: 1 });
    handle.subscribe(async event => { if (event.type === "message_end") { entered.resolve(); await release.promise; } });
    const run = handle.prompt("stream"); await entered.promise;
    const cancel = handle.abort(), dispose = handle.dispose();
    await Promise.resolve(); expect(fake.session.disposeCount).toBe(0); release.resolve();
    expect((await run).error?.code).toBe("PI_OUTPUT_LIMIT"); expect((await cancel).error?.code).toBe("PI_OUTPUT_LIMIT");
    await dispose; expect(fake.session.disposeCount).toBe(1); await handle.dispose();
  });
});
