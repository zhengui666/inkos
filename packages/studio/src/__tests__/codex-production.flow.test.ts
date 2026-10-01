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
  vi.spyOn(FanqieRadarSource.prototype, "fetch").mockResolvedValue({ platform: "tomato", entries: [{ title: "Fixture ranking", category: "fantasy", extra: "Rank 1" }], fetchedAt: "2026-01-01" } as never);
  vi.spyOn(QidianRadarSource.prototype, "fetch").mockResolvedValue({ platform: "qidian", entries: [], fetchedAt: "2026-01-01" } as never);
});
const radar = { recommendations: [{ platform: "qidian", genre: "fantasy", concept: "A clockmaker's city", reasoning: "Based on Fixture ranking", benchmarkTitles: ["Fixture ranking"] }], marketSummary: "Evidence-backed fixture market" };
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
      expect(await response.json()).toMatchObject(radar);
      const history = await (await app.request("/api/v1/radar/history")).json();
      expect(history.items.length).toBeGreaterThan(0);
    }
    expect(codex.turns).toHaveLength(2);
    expect(createCodexClient).toHaveBeenCalledWith(root);
    expect(codex.requests.filter(request => request.method === "thread/start")).toEqual(expect.arrayContaining([
      expect.objectContaining({ params: expect.objectContaining({ model: "fixture" }) }),
    ]));
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
    await writeFile(settingsPath, JSON.stringify({ reasoningEffort: "medium", serviceTier: "default" }));
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
