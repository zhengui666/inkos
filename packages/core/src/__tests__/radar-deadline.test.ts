import { describe, expect, it, vi } from "vitest";
import { RadarAgent } from "../agents/radar.js";
import type { RadarSource } from "../agents/radar-source.js";
import { CodexFixture } from "./codex-fixture.js";
import type { LLMClient } from "../llm/provider.js";
const factory = vi.hoisted(() => vi.fn());
vi.mock("../codex/client.js", () => ({ createCodexClient: factory }));
const client: LLMClient = { provider: "openai", apiFormat: "chat", stream: false,
  defaults: { temperature: 0.7, maxTokens: 4096, thinkingBudget: 0, extra: {} }, _codex: { projectRoot: "/tmp", settings: { reasoningEffort: "medium", serviceTier: "default" } } };
const source: RadarSource = { name: "slow", fetch: async () => new Promise(() => {}) };
const context = { client, model: "fixture", projectRoot: "/tmp" };

describe("radar source deadlines", () => {
  it("bounds a custom source that ignores cancellation and never invents evidence", async () => {
    factory.mockReset();
    await expect(new RadarAgent(context, [source]).scan({ sourceTimeoutMs: 10 })).rejects.toThrow("no source evidence");
    expect(factory).not.toHaveBeenCalled();
  });
  it("uses only available evidence and reports phases before native result validation", async () => {
    const result = { recommendations: [], marketSummary: "Based on Fixture ranking" };
    const fixture = new CodexFixture(() => ({ text: JSON.stringify({ resultJson: JSON.stringify(result) }) }));
    factory.mockImplementation(fixture.createClient);
    const phases: string[] = [];
    const evidence = { name: "available", fetch: async () => ({ platform: "qidian", entries: [{ title: "Fixture ranking", author: "", category: "", extra: "rank 1" }] }) };
    await expect(new RadarAgent(context, [source, evidence]).scan({ sourceTimeoutMs: 10, onProgress: phase => phases.push(phase) })).resolves.toMatchObject(result);
    expect(phases).toEqual(["fetching", "analyzing"]);
    expect(fixture.turns).toHaveLength(1);
  });
  it("propagates parent cancellation instead of treating it as an unavailable source", async () => {
    const controller = new AbortController();
    const reason = new Error("fixture cancelled");
    const work = new RadarAgent({ ...context, signal: controller.signal }, [source]).scan();
    controller.abort(reason);
    await expect(work).rejects.toBe(reason);
  });
});
