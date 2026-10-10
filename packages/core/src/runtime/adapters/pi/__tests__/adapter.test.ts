import { describe, expect, it, vi } from "vitest";
import { Type } from "@sinclair/typebox";
import { createHostResourceLoader, createPiAdapter } from "../adapter.js";
import type { PiHostTool, PiRunSpec } from "../contracts.js";
import { assistant, deferred, fakeSdk, type FakePlan } from "../__fixtures__/fake-sdk.js";

const spec = (tools: PiHostTool[] = []): PiRunSpec => ({ provider: "openai", modelId: "fixture-model", thinkingLevel: "high",
  systemPrompt: "host instructions", initialMessages: [], tools });
const result = () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} });
const tool = (name = "host_effect", execute = vi.fn(async () => result())): PiHostTool => ({
  name, label: name, description: "host tool", parameters: Type.Object({ value: Type.String() }), execute,
});
async function setup(plan?: FakePlan, options: Partial<PiRunSpec> = {}, guard?: () => Promise<void>) {
  const fake = fakeSdk(plan);
  const runtime = Object.freeze({ opaque: true });
  const handle = await createPiAdapter({ ...spec(), ...options }, { sdk: fake.port, modelRuntime: runtime, beforeToolCall: guard });
  return { fake, handle, runtime };
}

describe("Pi offline fixture lifecycle contract", () => {
  it("supplies only host tools, empty resources, in-memory settings and opaque runtime", async () => {
    const { fake, handle, runtime } = await setup(undefined, { tools: [tool()] });
    expect(fake.session.options).toMatchObject({ modelRuntime: runtime, model: { provider: "openai", id: "fixture-model" }, thinkingLevel: "high", tools: ["host_effect"] });
    expect(fake.session.agent.toolExecution).toBe("sequential");
    expect(fake.session.options.customTools[0].executionMode).toBe("sequential");
    expect(fake.settings).toEqual([{ cacheWarming: "off", retry: { enabled: false, provider: { maxRetries: 0 } }, compaction: { enabled: false }, enableSkillCommands: false }]);
    const loader = fake.session.options.resourceLoader;
    expect(loader.getExtensions().extensions).toEqual([]);
    expect(loader.getSkills().skills).toEqual([]); expect(loader.getPrompts().prompts).toEqual([]);
    expect(loader.getThemes().themes).toEqual([]); expect(loader.getAgentsFiles().agentsFiles).toEqual([]);
    expect(loader.getSystemPrompt()).toBe("host instructions");
    expect(loader.getSystemPromptSource()).toBeUndefined(); expect(loader.getAppendSystemPrompt()).toEqual([]);
    expect(loader.getAppendSystemPromptSources()).toEqual([]);
    expect(() => loader.extendResources({})).toThrow("disabled"); await loader.reload();
    await handle.dispose();
  });
  it("restores committed history through SessionManager and retains tool receipts without replay", async () => {
    const execute = vi.fn(async () => result());
    const initialMessages: PiRunSpec["initialMessages"] = [
      { role: "user", content: "history", timestamp: 1 },
      assistant([{ type: "toolCall", id: "old", name: "host_effect", arguments: { value: "old" } }]),
      { role: "toolResult", toolCallId: "old", toolName: "host_effect", content: [{ type: "text", text: "committed receipt" }], details: { persisted: true }, isError: false, timestamp: 2 },
    ];
    const { fake, handle } = await setup(async session => {
      expect(session.options.sessionManager.buildSessionContext().messages).toEqual(initialMessages);
      await session.append(assistant([{ type: "text", text: "continued" }], { timestamp: 101 }));
    }, { initialMessages, tools: [tool("host_effect", execute)] });
    initialMessages[0].content = "host mutation";
    expect(fake.session.agent.state.messages[0].content).toBe("history");
    // Original host input is mutable; use the restored canonical copy in the assertion above.
    initialMessages[0].content = "history";
    expect((await handle.continue()).status).toBe("completed"); expect(execute).not.toHaveBeenCalled();
    await handle.dispose();
  });
  it("awaits tool-start persistence and host guard before side effects", async () => {
    const listenerEntered = deferred(), listenerRelease = deferred(), guardEntered = deferred(), guardRelease = deferred();
    const execute = vi.fn(async () => result());
    const { handle } = await setup(async session => { await session.call("host_effect", "new", { value: "x" }); },
      { tools: [tool("host_effect", execute)] }, async () => { guardEntered.resolve(); await guardRelease.promise; });
    handle.subscribe(async event => { if (event.type === "tool_execution_start") { listenerEntered.resolve(); await listenerRelease.promise; } });
    const run = handle.prompt("hello"); await listenerEntered.promise;
    expect(execute).not.toHaveBeenCalled(); listenerRelease.resolve(); await guardEntered.promise;
    expect(execute).not.toHaveBeenCalled(); guardRelease.resolve(); expect((await run).status).toBe("completed");
    expect(execute).toHaveBeenCalledOnce(); await handle.dispose();
  });
  it("rejects every later call in the completion batch and ends the official turn", async () => {
    const finish = { ...tool("host_finish"), completesRun: () => true }, effect = tool();
    const { handle, fake } = await setup(async session => {
      await session.call("host_finish", "f", { value: "done" });
      expect((await session.call("host_effect", "e", { value: "forbidden" })).isError).toBe(true);
    }, { tools: [finish, effect] });
    expect((await handle.prompt("finish")).status).toBe("completed");
    expect(effect.execute).not.toHaveBeenCalled(); expect(fake.session.finishDecision).toEqual({ action: "end" });
    await handle.continue(); expect(fake.session.runCount).toBe(1); await handle.dispose();
  });
  it("does not latch completion when a completion tool throws", async () => {
    const finish = { ...tool("host_finish", vi.fn(async () => { throw new Error("Bearer secret /private/token"); })), completesRun: () => true };
    const effect = tool();
    const { handle } = await setup(async session => {
      await session.call("host_finish", "f", { value: "done" }); await session.call("host_effect", "e", { value: "x" });
    }, { tools: [finish, effect] });
    const outcome = await handle.prompt("finish"); expect(outcome).toMatchObject({ status: "failed", error: { code: "PI_TOOL_FAILED" } });
    expect(JSON.stringify(outcome)).not.toContain("secret"); expect(effect.execute).not.toHaveBeenCalled(); await handle.dispose();
  });
  it("keeps partial tool failure failed even if the fixture emits a later successful answer", async () => {
    const failing = tool("host_effect", vi.fn(async () => ({ ...result(), isError: true })));
    const { handle } = await setup(async session => { await session.call("host_effect", "e", { value: "x" }); await session.append(assistant()); }, { tools: [failing] });
    expect(await handle.prompt("test")).toMatchObject({ status: "failed", error: { code: "PI_TOOL_FAILED" } }); await handle.dispose();
  });
  it("does not execute unknown/native tools", async () => {
    const execute = vi.fn(async () => result());
    const { handle } = await setup(async session => { await session.call("bash", "bad", { value: "x" }); }, { tools: [tool("host_effect", execute)] });
    expect((await handle.prompt("test")).status).toBe("failed"); expect(execute).not.toHaveBeenCalled(); await handle.dispose();
  });
  it.each(["bash", "read", "codemode", "tool_search", "host_*", "+host", "host-name"])("rejects unsafe allowlist name %s", async name => {
    await expect(setup(undefined, { tools: [tool(name)] })).rejects.toThrow("tool names");
  });
  it("rejects duplicate tool names", async () => { await expect(setup(undefined, { tools: [tool(), tool()] })).rejects.toThrow("tool names"); });
  it.each([{ value: 7 }, { value: "x", extra: "no" }, {}, { value: null }])("rejects strict raw arguments %j without coercion", async args => {
    const execute = vi.fn(async () => result());
    const { handle } = await setup(async session => { await session.call("host_effect", "bad", args); }, { tools: [tool("host_effect", execute)] });
    expect((await handle.prompt("test")).status).toBe("failed"); expect(execute).not.toHaveBeenCalled(); await handle.dispose();
  });
  it("checks nested object parameters", async () => {
    const nested = { ...tool(), parameters: Type.Object({ nested: Type.Object({ value: Type.String() }) }) };
    const { handle } = await setup(async session => { await session.call("host_effect", "bad", { nested: { value: "x", extra: 1 } }); }, { tools: [nested] });
    expect((await handle.prompt("test")).status).toBe("failed"); expect(nested.execute).not.toHaveBeenCalled(); await handle.dispose();
  });
  it("checks nested tuple object parameters", async () => {
    const nested = { ...tool(), parameters: Type.Object({ pair: Type.Tuple([Type.Object({ value: Type.String() })]) }) };
    const { handle } = await setup(async session => { await session.call("host_effect", "bad", { pair: [{ value: "x", extra: 1 }] }); }, { tools: [nested] });
    expect((await handle.prompt("test")).status).toBe("failed"); expect(nested.execute).not.toHaveBeenCalled(); await handle.dispose();
  });
  it.each([true, false])("intersection parameters preserve sibling fields and reject extras (valid=%s)", async valid => {
    const nested = { ...tool(), parameters: Type.Intersect([Type.Object({ a: Type.String() }), Type.Object({ b: Type.String() })]) };
    const args = { a: "x", b: "y", ...(valid ? {} : { extra: "forbidden" }) };
    const { handle } = await setup(async session => { await session.call("host_effect", "call", args); }, { tools: [nested] });
    expect((await handle.prompt("test")).status).toBe(valid ? "completed" : "failed");
    expect(nested.execute).toHaveBeenCalledTimes(valid ? 1 : 0); await handle.dispose();
  });
  it("validates host-prepared arguments and awaits asynchronous preparation", async () => {
    const execute = vi.fn(async () => result());
    const prepared = { ...tool("host_effect", execute), prepareArguments: async () => ({ value: 3 }) };
    const { handle } = await setup(async session => { await session.call("host_effect", "bad", { value: "x" }); }, { tools: [prepared] });
    expect((await handle.prompt("test")).status).toBe("failed"); expect(execute).not.toHaveBeenCalled(); await handle.dispose();
  });
  it("records persistence rejection even when the SDK absorbs it", async () => {
    const execute = vi.fn(async () => result());
    const { handle } = await setup(async session => { await session.call("host_effect", "bad", { value: "x" }); }, { tools: [tool("host_effect", execute)] });
    handle.subscribe(async event => { if (event.type === "tool_execution_start") throw new Error("private receipt write failed"); });
    const outcome = await handle.prompt("test"); expect(outcome).toMatchObject({ status: "failed", error: { code: "PI_LISTENER_FAILED" } });
    expect(execute).not.toHaveBeenCalled(); expect(JSON.stringify(outcome.error)).not.toContain("private"); await handle.dispose();
  });
  it("records a host guard rejection", async () => {
    const execute = vi.fn(async () => result());
    const { handle } = await setup(async session => { await session.call("host_effect", "bad", { value: "x" }); }, { tools: [tool("host_effect", execute)] }, async () => { throw new Error("secret"); });
    expect(await handle.prompt("test")).toMatchObject({ status: "failed", error: { code: "PI_TOOL_FAILED" } });
    expect(execute).not.toHaveBeenCalled(); await handle.dispose();
  });
  it("agent_end is not settled and dispose waits for the last receipt listener", async () => {
    const entered = deferred(), release = deferred();
    const { handle, fake } = await setup();
    handle.subscribe(async event => { if (event.type === "agent_end") { entered.resolve(); await release.promise; } });
    const run = handle.prompt("test"); await entered.promise;
    let disposed = false; const disposing = handle.dispose().then(() => { disposed = true; });
    await Promise.resolve(); expect(disposed).toBe(false); expect(fake.session.disposeCount).toBe(0);
    release.resolve(); expect((await run).status).toBe("cancelled"); await disposing;
    expect(fake.session.log.indexOf("disposed")).toBeGreaterThan(fake.session.log.indexOf("settled"));
    await handle.dispose(); expect(fake.session.disposeCount).toBe(1);
  });
  it("cancelled tools must drain before dispose and later side effects never start", async () => {
    const entered = deferred(), release = deferred();
    const first = tool("host_slow", vi.fn(async () => { entered.resolve(); await release.promise; return result(); }));
    const later = tool();
    const { handle, fake } = await setup(async session => { await session.call("host_slow", "s", { value: "x" }); await session.call("host_effect", "e", { value: "x" }); }, { tools: [first, later] });
    const run = handle.prompt("test"); await entered.promise;
    const disposing = handle.dispose(); await Promise.resolve(); expect(fake.session.disposeCount).toBe(0);
    release.resolve(); expect((await run).status).toBe("cancelled"); await disposing;
    expect(later.execute).not.toHaveBeenCalled(); expect(fake.session.disposeCount).toBe(1);
  });
  it("cancellation during the awaited host guard prevents execute", async () => {
    const entered = deferred(), release = deferred(), execute = vi.fn(async () => result());
    const { handle } = await setup(async session => { await session.call("host_effect", "e", { value: "x" }); }, { tools: [tool("host_effect", execute)] }, async () => { entered.resolve(); await release.promise; });
    const run = handle.prompt("test"); await entered.promise; const cancel = handle.abort(); release.resolve();
    expect((await run).status).toBe("cancelled"); await cancel; expect(execute).not.toHaveBeenCalled(); await handle.dispose();
  });
  it("accepts an already-cancelled parent without starting a run", async () => {
    const controller = new AbortController(); controller.abort();
    const { handle, fake } = await setup(undefined, { signal: controller.signal });
    expect((await handle.prompt("test")).status).toBe("cancelled"); expect(fake.session.runCount).toBe(0); await handle.dispose();
  });
  it("cancels between scheduling and prompt without launching the model", async () => {
    const { handle, fake } = await setup(); const run = handle.prompt("test"); const cancel = handle.abort();
    expect((await run).status).toBe("cancelled"); await cancel; expect(fake.session.runCount).toBe(0); await handle.dispose();
  });
  it("aborts a fresh core started after cancellation during SDK prompt preflight", async () => {
    const entered = deferred(), release = deferred(), streamed = vi.fn();
    const { handle, fake } = await setup();
    fake.session.abort = async () => { fake.session.abortCount++; };
    fake.session.agent.abort = () => { fake.session.controller.abort(); };
    fake.session.prompt = async () => {
      entered.resolve(); await release.promise;
      await fake.session.emit({ type: "agent_start" });
      // Official loop may call a stream even with an aborted signal; startup rejection is the barrier.
      streamed();
    };
    const run = handle.prompt("test"); await entered.promise; const abort = handle.abort(); release.resolve();
    expect((await run).status).toBe("cancelled"); await abort; expect(streamed).not.toHaveBeenCalled(); await handle.dispose();
  });
  it("drains direct continuation even when session idle tracking returns early", async () => {
    const entered = deferred(), release = deferred();
    const { handle, fake } = await setup(async session => {
      entered.resolve(); await release.promise;
      await session.emit({ type: "message_update", message: assistant([], { stopReason: "aborted" }),
        assistantMessageEvent: { type: "error", reason: "aborted", error: "private abort detail" } });
    });
    fake.session.waitForIdle = async () => {};
    fake.session.agent.waitForIdle = async () => { await release.promise; };
    const run = handle.continue(); await entered.promise;
    const dispose = handle.dispose(); await Promise.resolve(); expect(fake.session.disposeCount).toBe(0);
    release.resolve(); expect((await run).status).toBe("cancelled"); await dispose;
    expect(fake.session.disposeCount).toBe(1);
  });
  it("late disposal preserves an already-settled successful result", async () => {
    const { handle } = await setup(); const completed = await handle.prompt("test");
    await handle.dispose(); expect(await handle.waitForSettled()).toEqual(completed);
  });
  it("serializes runs and makes dispose idempotent", async () => {
    const release = deferred(); const { handle, fake } = await setup(async () => { await release.promise; });
    const run = handle.prompt("test"); await expect(handle.continue()).rejects.toThrow("already running");
    release.resolve(); await run; const a = handle.dispose(), b = handle.dispose(); expect(a).toBe(b); await a;
    expect(fake.session.disposeCount).toBe(1); await expect(handle.prompt("again")).rejects.toThrow("disposed");
  });
  it.each(["error", "aborted", "length"] as const)("never completes a %s response", async stopReason => {
    const { handle } = await setup(async session => { await session.append(assistant([], { stopReason, errorMessage: "Bearer private /path" })); });
    const outcome = await handle.prompt("test"); expect(outcome.status).toBe("failed"); expect(JSON.stringify(outcome)).not.toContain("Bearer"); await handle.dispose();
  });
  it("retains response.failed despite a successful terminal message", async () => {
    const { handle } = await setup(async session => {
      const message = assistant(); await session.emit({ type: "message_update", message, assistantMessageEvent: { type: "response.failed", error: "secret" } });
      await session.append(message);
    });
    const updates: unknown[] = []; handle.subscribe(event => { updates.push(event); });
    expect((await handle.prompt("test")).status).toBe("failed"); expect(JSON.stringify(updates)).not.toContain("secret"); await handle.dispose();
  });
  it("scrubs SDK rejection and idle failures", async () => {
    const { handle, fake } = await setup(async () => { throw new Error("token=secret"); });
    fake.session.waitForIdle = async () => { throw new Error("private path"); };
    const outcome = await handle.prompt("test"); expect(outcome).toMatchObject({ status: "failed", error: { code: "PI_SDK_FAILED" } });
    expect(JSON.stringify(outcome.error)).not.toContain("secret");
    fake.session.waitForIdle = async () => {}; await handle.dispose();
  });
  it("idle failure still drains asynchronous event writes before disposing", async () => {
    const entered = deferred(), release = deferred();
    const { handle, fake } = await setup(async () => {});
    const run = await handle.prompt("test"); expect(run.status).toBe("completed");
    fake.session.agent.waitForIdle = async () => { throw new Error("private idle error"); };
    fake.session.waitForIdle = async () => { throw new Error("private idle error"); };
    handle.subscribe(async event => { if (event.type === "message_end") { entered.resolve(); await release.promise; } });
    const write = fake.session.emit({ type: "message_end", message: assistant() }); await entered.promise;
    const dispose = handle.dispose(); await Promise.resolve(); expect(fake.session.disposeCount).toBe(0);
    release.resolve(); await write; await dispose;
    expect(fake.session.disposeCount).toBe(1);
    expect(await handle.waitForSettled()).toMatchObject({ status: "failed", error: { code: "PI_SDK_FAILED" } });
  });
  it("reports a scrubbed cleanup failure once and retains the failed settlement", async () => {
    const { handle, fake } = await setup(); await handle.prompt("test");
    fake.session.dispose = () => { fake.session.disposeCount++; throw new Error("secret cleanup path"); };
    const dispose = handle.dispose(); await expect(dispose).rejects.toThrow("Pi SDK lifecycle failed");
    expect(handle.dispose()).toBe(dispose); expect(fake.session.disposeCount).toBe(1);
    expect(await handle.waitForSettled()).toMatchObject({ status: "failed", error: { code: "PI_SDK_FAILED" } });
  });
  it("enforces an estimated host output guard without forwarding maxOutputTokens", async () => {
    const { handle, fake } = await setup(async session => { await session.append(assistant([{ type: "text", text: "x".repeat(100) }])); }, { maxOutputTokens: 1 });
    expect(fake.session.options).not.toHaveProperty("maxOutputTokens");
    expect(await handle.prompt("test")).toMatchObject({ status: "failed", error: { code: "PI_OUTPUT_LIMIT" } }); await handle.dispose();
  });
  it("disables native prompt expansion and passes images", async () => {
    const { handle, fake } = await setup(); const images = [{ type: "image" as const, mimeType: "image/png", data: "YWJj" }];
    await handle.prompt("/native-command", images); expect(fake.session.promptOptions).toEqual({ expandPromptTemplates: false, images }); await handle.dispose();
  });
  it("rejects speed and malformed output budgets before session creation", async () => {
    await expect(setup(undefined, { speed: "fast" } as Partial<PiRunSpec>)).rejects.toThrow("speed");
    await expect(setup(undefined, { maxOutputTokens: 0 })).rejects.toThrow("positive integer");
  });
  it("rejects incompatible SDK and missing model without falling back", async () => {
    const fake = fakeSdk(); fake.port.version = "0.9" as "1.1.0";
    await expect(createPiAdapter(spec(), { sdk: fake.port, modelRuntime: {} })).rejects.toThrow("1.1.0");
    fake.port.version = "1.1.0"; fake.port.resolveModel = () => undefined;
    await expect(createPiAdapter(spec(), { sdk: fake.port, modelRuntime: {} })).rejects.toThrow("unavailable");
  });
  it.each(["sessionInMemory", "resolveModel", "settingsInMemory", "createExtensionRuntime", "createAgentSession"] as const)("scrubs SDK initialization failure in %s", async method => {
    const fake = fakeSdk(); fake.port[method] = () => { throw new Error("Bearer secret /auth.json"); };
    await expect(createPiAdapter(spec(), { sdk: fake.port, modelRuntime: {} })).rejects.toThrow("Pi SDK lifecycle failed");
  });
  it("scrubs SessionManager restore failure", async () => {
    const fake = fakeSdk(); fake.port.sessionInMemory = () => ({ appendMessage: () => { throw new Error("secret transcript path"); }, buildSessionContext: () => ({ messages: [] }) });
    await expect(createPiAdapter({ ...spec(), initialMessages: [{ role: "user", content: "history", timestamp: 1 }] }, { sdk: fake.port, modelRuntime: {} })).rejects.toThrow("Pi SDK lifecycle failed");
  });
  it.each(["pending", "deferred"] as const)("cannot complete a terminal %s SDK response", async stopReason => {
    const { handle } = await setup(async session => { await session.append({ ...assistant(), stopReason }); });
    expect(await handle.prompt("test")).toMatchObject({ status: "failed", messages: expect.arrayContaining([expect.objectContaining({ role: "assistant", stopReason: "error" })]) });
    await handle.dispose();
  });
  it("loader performs no discovery on reload", async () => { const loader = createHostResourceLoader("host", {}); await loader.reload(); expect(loader.getExtensions().extensions).toEqual([]); });
});
