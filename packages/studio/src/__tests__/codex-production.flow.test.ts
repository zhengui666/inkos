import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexFixture } from "../../../core/src/__tests__/codex-fixture.js";
import { FanqieRadarSource, QidianRadarSource } from "../../../core/src/agents/radar-source.js";
import { createStudioServer } from "../api/server.js";
import type { CodexAccountService } from "@actalk/inkos-core";

const createCodexClient = vi.hoisted(() => vi.fn());
vi.mock("../../../core/src/codex/client.js", () => ({ createCodexClient }));
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
beforeEach(() => {
  // Synthetic source snapshots remain fresh at acquisition time and carry host
  // provenance. They do not bypass the real source-evidence gate or use a network.
  vi.spyOn(FanqieRadarSource.prototype, "fetch").mockImplementation(async () => ({
    platform: "fanqie", language: "zh", acquisition: "snapshot", entries: [], fetchedAt: new Date().toISOString(),
  }));
  vi.spyOn(QidianRadarSource.prototype, "fetch").mockImplementation(async () => ({
    platform: "qidian", language: "zh", acquisition: "snapshot", sourceUrl: "https://www.qidian.com/rank/",
    fetchedAt: new Date().toISOString(),
    entries: [{ title: "Fixture ranking", author: "Fixture author", category: "fantasy", extra: "Synthetic rank 1", rank: 1 }],
  }));
});
const readerContract = {
  mode: "commercial-underdog", familiarPromise: "An overlooked clockmaker earns bargaining power through skill",
  distinctiveHook: "Broken clocks reveal faults in the city's time network", readingPleasure: "Earned practical gains and recognition",
  openingQuestion: "Can the apprentice save the workshop before its debt comes due?", proseApproach: "Clear Chinese scenes and concrete dialogue",
  riseRoute: { startingDisadvantage: "An indebted apprentice has no workshop access", desiredChange: "Keep the workshop open",
    opportunity: "A damaged clock reveals a repairable network fault", opportunityLimits: "Reading the fault consumes scarce repair parts",
    opposition: { force: "The workshop creditor", interest: "Seize the workshop", leverage: "Controls its tools and deadline" },
    protagonistContribution: "The apprentice tests the fault and negotiates using the proof", firstPayoff: "A paid repair secures one week's access",
    payoffMeaning: "The apprentice can work and bargain from evidence", escalation: "The repair reveals who profits from the faulty network" },
};
const radar = { recommendations: [{ platform: "qidian", language: "zh", evidenceIds: ["S2E1"], genre: "fantasy", concept: "A clockmaker's city", readerContract, reasoning: "Based on Fixture ranking", benchmarkTitles: ["Fixture ranking"] }], marketSummary: "Evidence-backed fixture market" };
const post = (body: unknown = {}) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
async function project(legacy = false) {
  const root = await mkdtemp(join(tmpdir(), "inkos-codex-production-")); roots.push(root);
  await writeFile(join(root, "inkos.json"), JSON.stringify({ name: "Codex only", version: "0.1.0", language: "en",
    ...(legacy ? { llm: { service: "google", services: [{ service: "google" }], defaultModel: "gpt-legacy", model: "old", baseUrl: "" }, modelOverrides: { radar: "legacy-provider-model" } } : {}),
  }));
  return root;
}

describe("Studio Codex-only production routes", () => {
  it.each([false, true])("executes and persists radar with no provider key (legacy config: %s), including server restart", async legacy => {
    const root = await project(legacy);
    const codex = new CodexFixture(() => ({ calls: [{ name: "submit_market_radar", args: radar }] }));
    createCodexClient.mockImplementation(codex.createClient);
    for (let restart = 0; restart < 2; restart++) {
      const app = createStudioServer({} as never, root);
      const response = await app.request("/api/v1/radar/scan", post());
      expect(response.status, await response.clone().text()).toBe(200);
      const result = await response.json();
      expect(result).toMatchObject(radar);
      expect(result.evidence).toEqual([expect.objectContaining({
        id: "S2E1", platform: "qidian", language: "zh", title: "Fixture ranking",
        sourceUrl: "https://www.qidian.com/rank/", acquisition: "snapshot", fetchedAt: expect.any(String),
      })]);
      const history = await (await app.request("/api/v1/radar/history")).json();
      expect(history.items.length).toBeGreaterThan(0);
    }
    expect(codex.turns).toHaveLength(2);
    expect(createCodexClient).toHaveBeenCalledWith(root);
    expect(codex.requests.filter(request => request.method === "thread/start")).toEqual(expect.arrayContaining([
      expect.objectContaining({ params: expect.objectContaining({ model: "gpt-6.1-sol", serviceTier: "priority" }) }),
    ]));
  });

  it("persists a native constrained result once and reports progress across navigation", async () => {
    const root = await project();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const codex = new CodexFixture(async () => { await gate; return { text: JSON.stringify({ resultJson: JSON.stringify(radar) }) }; });
    createCodexClient.mockImplementation(codex.createClient);
    const app = createStudioServer({} as never, root);
    const pending = app.request("/api/v1/radar/scan", post());
    await vi.waitFor(() => expect(codex.turns).toHaveLength(1));
    expect(await (await app.request("/api/v1/radar/status")).json()).toMatchObject({ running: true, phase: "analyzing" });
    expect((await app.request("/api/v1/radar/scan", post())).status).toBe(409);
    release();
    expect((await pending).status).toBe(200);
    expect(await (await app.request("/api/v1/radar/status")).json()).toMatchObject({ running: false, phase: "complete", result: radar });
    const restarted = createStudioServer({} as never, root);
    expect((await (await restarted.request("/api/v1/radar/history")).json()).items).toHaveLength(1);
    expect(codex.toolResponses).toHaveLength(0);
    expect(codex.turns).toHaveLength(1);
  });

  it("retains bounded result diagnostics and persists nothing after rejected tools", async () => {
    const root = await project();
    const codex = new CodexFixture(() => ({ calls: [{ name: "unknown_fixture_tool", args: { manuscript: "private fixture text" } }], complete: true }));
    createCodexClient.mockImplementation(codex.createClient);
    const app = createStudioServer({} as never, root);
    const response = await app.request("/api/v1/radar/scan", post());
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.diagnostics).toMatchObject({ code: "WORKER_RESULT_MISSING", attempts: 3, submissions: 0, rejectedTools: 3, resultTool: "submit_market_radar" });
    expect(JSON.stringify(body)).not.toContain("private fixture text");
    expect((await (await app.request("/api/v1/radar/history")).json()).items).toEqual([]);
    expect(await (await app.request("/api/v1/radar/status")).json()).toMatchObject({ running: false, phase: "error" });
  });

  it("executes the direct style worker with the saved model, effort and speed, then sees changed settings next request", async () => {
    const root = await project(true);
    await mkdir(join(root, ".inkos"));
    const settingsPath = join(root, ".inkos", "codex-config.json");
    await writeFile(settingsPath, JSON.stringify({ model: "fixture", reasoningEffort: "high", serviceTier: "fast" }));
    const codex = new CodexFixture(() => ({ text: "# Style guide\nUse the supplied evidence." }));
    createCodexClient.mockImplementation(async (path: string) => {
      const peer = await codex.createClient(path);
      const request = peer.request.bind(peer);
      return { ...peer, request: async (method: string, params: unknown, options: unknown) => method === "model/list"
        ? { data: [{ id: "fixture", model: "fixture", isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "high" }, { reasoningEffort: "medium" }], serviceTiers: [{ id: "fast" }] }], nextCursor: null }
        : request(method, params, options as never) };
    });
    const app = createStudioServer({} as never, root);
    const response = await app.request("/api/v1/style/analyze", post({ text: "A bell rang. He waited.", sourceName: "fixture" }));
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({ guide: "# Style guide\nUse the supplied evidence." });
    expect(codex.turns[0]?.turn).toMatchObject({ effort: "high", serviceTier: "fast", serviceTierForTurn: "fast" });
    await writeFile(settingsPath, JSON.stringify({ model: "fixture", reasoningEffort: "medium", serviceTier: "default" }));
    expect((await app.request("/api/v1/style/analyze", post({ text: "Another sample" }))).status).toBe(200);
    expect(codex.turns[1]?.turn).toMatchObject({ effort: "medium", serviceTier: null, serviceTierForTurn: "default" });
  });

  it("reports genuine missing ChatGPT auth instead of an unrelated API-key gate", async () => {
    const root = await project();
    const codex = new CodexFixture(() => { throw new Error("No inference should run"); });
    createCodexClient.mockImplementation(async (path: string) => {
      const peer = await codex.createClient(path);
      const request = peer.request.bind(peer);
      return { ...peer, request: async (method: string, params: unknown, options: unknown) => method === "account/read"
        ? { account: null, requiresOpenaiAuth: true } : request(method, params, options as never) };
    });
    const app = createStudioServer({} as never, root);
    const response = await app.request("/api/v1/radar/scan", post());
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toContain("Sign in with ChatGPT"); expect(body).not.toContain("API key");
    expect(codex.turns).toHaveLength(0);
  });

  it("doctor checks actual Codex account/catalog/settings and makes no provider inference", async () => {
    const root = await project();
    const service = { readAccount: vi.fn(async () => ({ connected: true, account: { type: "chatgpt" } })),
      readSettings: vi.fn(async () => ({ reasoningEffort: "medium", serviceTier: "default" })),
      listModels: vi.fn(async () => [{ id: "fixture", model: "fixture", isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "medium" }], serviceTiers: [] }]),
    } as unknown as CodexAccountService;
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No provider/network inference"));
    const app = createStudioServer({} as never, root, { codexAccountService: service });
    expect(await (await app.request("/api/v1/doctor")).json()).toMatchObject({ llmConnected: true });
    vi.mocked(service.readAccount).mockResolvedValue({ connected: false, account: null, requiresOpenaiAuth: true, login: null });
    expect(await (await app.request("/api/v1/doctor")).json()).toMatchObject({ llmConnected: false });
    expect(fetch).not.toHaveBeenCalled();
  });
});
