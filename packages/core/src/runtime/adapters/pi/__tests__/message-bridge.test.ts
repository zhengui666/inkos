import { describe, expect, it } from "vitest";
import type { PiAssistantMessage, PiMessage, PiSdkEvent, PiToolResult } from "../contracts.js";
import { PiUsageLedger, toHostEvent, toHostMessages, toPiMessages } from "../message-bridge.js";
import { assistant, fakeSdk } from "../__fixtures__/fake-sdk.js";
import { createPiAdapter } from "../adapter.js";

const usage = (output: number): NonNullable<PiAssistantMessage["usage"]> => ({
  input: 10, output, cacheRead: 2, cacheWrite: 0, totalTokens: 12 + output,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});
describe("Pi offline fixture message and usage contract", () => {
  it("preserves text, thinking, image, tool call ids and durable receipt details", () => {
    const messages: PiMessage[] = [
      { role: "system", content: "Pi private system projection", timestamp: 0 },
      { role: "user", content: [{ type: "text", text: "hello" }, { type: "image", data: "YWJj", mimeType: "image/png" }], timestamp: 1 },
      assistant([{ type: "thinking", thinking: "reason", thinkingSignature: "replay-signature" },
        { type: "text", text: "answer", textSignature: "phase-signature" },
        { type: "toolCall", id: "call-id", name: "host_effect", arguments: { value: "x" } }]),
      { role: "toolResult", toolCallId: "call-id", toolName: "host_effect", content: [{ type: "text", text: "saved" }],
        details: { receipt: "committed" }, isError: false, timestamp: 2 },
    ];
    const host = toHostMessages(messages); expect(host).toEqual(messages.slice(1));
    expect(toPiMessages(host)).toEqual(host); host[0].content = "host changed";
    expect(messages[1].content).toBeInstanceOf(Array);
  });
  it("filters Pi system lifecycle events and retains host transcript events", () => {
    const system = { role: "system" as const, content: "native", timestamp: 0 };
    expect(toHostEvent({ type: "message_start", message: system })).toBeUndefined();
    expect(toHostEvent({ type: "message_end", message: system })).toBeUndefined();
    expect(toHostEvent({ type: "agent_end", messages: [system, assistant()] })).toEqual({ type: "agent_end", messages: [assistant()] });
  });
  it("never manufactures zero usage for missing reports", () => {
    const ledger = new PiUsageLedger(); ledger.observe(assistant());
    expect(ledger.total()).toBeUndefined(); expect(toHostMessages([assistant()])[0]).not.toHaveProperty("usage");
  });
  it("deduplicates cumulative streaming updates, terminal events and response snapshots", () => {
    const ledger = new PiUsageLedger();
    for (const output of [1, 3, 3, 5, 5, 4]) ledger.observe(assistant([], { responseId: "r1", usage: usage(output) }));
    ledger.observe(assistant([], { timestamp: 101, responseId: "r2", usage: usage(7) }));
    expect(ledger.total()).toEqual({ input: 20, output: 12, cacheRead: 4, cacheWrite: 0, totalTokens: 36 });
  });
  it("handles the same fallback response identity without a responseId", () => {
    const ledger = new PiUsageLedger(); ledger.observe(assistant([], { usage: usage(2) }));
    ledger.observe(structuredClone(assistant([], { usage: usage(4) }))); expect(ledger.total()?.output).toBe(4);
  });
  it.each([undefined, usage(2)])("migrates an early snapshot when responseId arrives", earlyUsage => {
    const ledger = new PiUsageLedger(); ledger.observe(assistant([], { usage: earlyUsage }));
    ledger.observe(assistant([], { responseId: "late-id", usage: usage(5) }));
    ledger.observe(assistant([], { responseId: "late-id", usage: usage(5) }));
    expect(ledger.total()).toEqual({ input: 10, output: 5, cacheRead: 2, cacheWrite: 0, totalTokens: 17 });
  });
  it("keeps unreported responses unknown across a mixed run", () => {
    const ledger = new PiUsageLedger(); ledger.observe(assistant([], { responseId: "known", usage: usage(2) }));
    ledger.observe(assistant([], { responseId: "unknown" })); expect(ledger.total()).toBeUndefined();
  });
  it("does not count a zero placeholder when finalized usage is absent", () => {
    const ledger = new PiUsageLedger(); ledger.observe(assistant([], { usage: usage(0) }), "response:1");
    ledger.observe(assistant(), "response:1", true); expect(ledger.total()).toBeUndefined();
  });
  it("replaces a partial snapshot with lower authoritative terminal counts", () => {
    const ledger = new PiUsageLedger(); ledger.observe(assistant([], { responseId: "r", usage: usage(9) }), "r");
    ledger.observe(assistant([], { responseId: "r", usage: usage(2) }), "r", true);
    expect(ledger.total()).toEqual({ input: 10, output: 2, cacheRead: 2, cacheWrite: 0, totalTokens: 14 });
  });
  it("does not borrow a missing final field from its partial snapshot", () => {
    const ledger = new PiUsageLedger(); ledger.observe(assistant([], { usage: usage(9) }), "r");
    const terminal = usage(2); delete (terminal as Partial<typeof terminal>).output;
    ledger.observe(assistant([], { usage: terminal }), "r", true);
    expect(ledger.total()).toEqual({ input: 10, cacheRead: 2, cacheWrite: 0, totalTokens: 14 });
  });
  it("keeps mixed known/unknown final fields unknown across responses", () => {
    const ledger = new PiUsageLedger(); ledger.observe(assistant([], { responseId: "a", usage: usage(3) }), "a", true);
    const terminal = usage(2); delete (terminal as Partial<typeof terminal>).input;
    ledger.observe(assistant([], { responseId: "b", usage: usage(9) }), "b");
    ledger.observe(assistant([], { responseId: "b", usage: terminal }), "b", true);
    expect(ledger.total()).toEqual({ output: 5, cacheRead: 4, cacheWrite: 0, totalTokens: 29 });
  });
  it("accepts SDK system content arrays and adapts pending streaming messages without finalizing them", () => {
    expect(toHostEvent({ type: "message_start", message: { role: "system", content: [{ type: "text", text: "native prompt" }], timestamp: 1 } })).toBeUndefined();
    const pending = { ...assistant(), stopReason: "pending" as const };
    expect(toHostEvent({ type: "message_update", message: pending, assistantMessageEvent: { type: "start", partial: pending } })).toMatchObject({ type: "message_update", message: { stopReason: "stop" } });
    expect(toHostMessages([pending])[0]).toMatchObject({ stopReason: "error" });
    expect(JSON.stringify(toHostMessages([{ ...pending, errorMessage: "Bearer secret" }], true))).not.toContain("secret");
  });
  it("ignores invalid numbers instead of inventing a report", () => {
    const ledger = new PiUsageLedger(); const invalid = usage(2);
    invalid.input = NaN; invalid.output = -1; invalid.totalTokens = Infinity;
    ledger.observe(assistant([], { usage: invalid })); expect(ledger.total()).toEqual({ cacheRead: 2, cacheWrite: 0 });
  });
  it("counts an actual streaming fixture run only once", async () => {
    const fake = fakeSdk(async session => {
      for (const count of [1, 4, 7]) {
        const message = assistant([], { responseId: "response", usage: usage(count) });
        await session.emit({ type: "message_update", message, assistantMessageEvent: { type: "text_delta", partial: message, delta: "x" } });
      }
      await session.append(assistant([{ type: "text", text: "answer" }], { responseId: "response", usage: usage(7) }));
    });
    const handle = await createPiAdapter({ provider: "openai", modelId: "fixture-model", thinkingLevel: "off", systemPrompt: "host", initialMessages: [], tools: [] }, { sdk: fake.port, modelRuntime: {} });
    expect((await handle.prompt("test")).usage).toEqual({ input: 10, output: 7, cacheRead: 2, cacheWrite: 0, totalTokens: 19 });
    await handle.dispose();
  });
  it("counts separate assistant responses with the same timestamp and no responseId", async () => {
    const fake = fakeSdk(async session => {
      await session.append(assistant([], { usage: usage(3) }));
      await session.append(assistant([], { usage: usage(4) }));
    });
    const handle = await createPiAdapter({ provider: "openai", modelId: "fixture-model", thinkingLevel: "off", systemPrompt: "host", initialMessages: [], tools: [] }, { sdk: fake.port, modelRuntime: {} });
    expect((await handle.prompt("test")).usage).toEqual({ input: 20, output: 7, cacheRead: 4, cacheWrite: 0, totalTokens: 31 });
    await handle.dispose();
  });
  it("scrubs model errors in terminal messages and stream errors", () => {
    const message = assistant([], { stopReason: "error", errorMessage: "Bearer secret /auth.json" });
    const event = toHostEvent({ type: "message_update", message, assistantMessageEvent: { type: "error", error: message, privateToken: "secret" } });
    expect(JSON.stringify(event)).not.toContain("secret");
    expect(toHostMessages([message])[0]).toMatchObject({ errorMessage: "Pi model response failed" });
  });
  it("projects untrusted tool error payloads in every event and transcript boundary", () => {
    const result: PiToolResult = { content: [{ type: "text", text: "api_key=sk-demo-secret Bearer demo-secret" }],
      details: { receipt: "public-receipt", feedback: "Correct the input", apiKey: "demo-key", password: "demo-password", authPath: "C:\\private\\auth.json" }, isError: true,
      failure: { kind: "recoverable", category: "validation", feedback: "Correct the input; api_key=sk-demo-secret password=demo-password C:\\private\\auth.json Bearer demo-secret /home/private/auth.json" } };
    const message = { role: "toolResult" as const, toolCallId: "call", toolName: "host_fail", ...result, isError: true, timestamp: 1 };
    const events: PiSdkEvent[] = [
      { type: "tool_execution_update", toolCallId: "call", toolName: "host_fail", args: {}, partialResult: result },
      { type: "tool_execution_end", toolCallId: "call", toolName: "host_fail", result, isError: true },
      { type: "message_start", message }, { type: "message_end", message },
      { type: "turn_end", message: assistant(), toolResults: [message] }, { type: "agent_end", messages: [message] },
    ];
    const projections = { events: events.map(event => toHostEvent(event)), host: toHostMessages([message]), sdk: toPiMessages([message]) };
    const serialized = JSON.stringify(projections);
    for (const secret of ["demo-secret", "demo-key", "demo-password", "authPath", "apiKey", "password", "private"]) expect(serialized).not.toContain(secret);
    expect(serialized).toContain("public-receipt"); expect(serialized).toContain("Correct the input");
    for (const receipt of ["C:\\private\\auth.json", "/home/private/auth.json", "api_key=sk-demo-secret", "sk-demo-secret"]) {
      const projected = toHostMessages([{ ...message, details: { receipt } }])[0];
      expect("details" in projected ? projected.details : undefined).not.toHaveProperty("receipt");
    }
    expect(toHostMessages(toHostMessages([message]))).toEqual(toHostMessages([message]));
  });
});
