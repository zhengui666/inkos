import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { RadarAgent } from "../agents/radar.js";
import { MegaNovelSnapshotRadarSource } from "../agents/meganovel-radar-source.js";

// These tests exercise scan orchestration only. They do not run the model worker
// or validate its schema; those integration checks require the locked dependencies.
const submit = vi.hoisted(() => vi.fn());
vi.mock("../agents/base.js", () => ({ BaseAgent: class {
  constructor(readonly ctx: { signal?: AbortSignal }) {}
  submitStructured(...args: unknown[]) { return submit(...args); }
} }));
vi.mock("../agents/radar-tool.js", () => ({ RadarResultToolSchema: {} }));
const context = { client: {} as never, model: "fixture", projectRoot: "/tmp" };
const url = "https://www.meganovel.com/rankings";
const observed = "2026-10-06T02:35:03.775Z";
const fixtureHtml = () => readFile(new URL("./fixtures/meganovel-rankings-2026-10-06.html", import.meta.url), "utf8");
beforeEach(() => { vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-06T03:00:00Z")); });
afterEach(() => { vi.restoreAllMocks(); submit.mockReset(); });

describe("market scan evidence", () => {
  it("filters the source platform and language before any model call", async () => {
    const chinese = { name: "fanqie", fetch: async () => ({ platform: "番茄小说", language: "zh" as const,
      entries: [{ title: "榜单示例", author: "", category: "", extra: "" }] }) };
    await expect(new RadarAgent(context, [chinese]).scan({ targetPlatform: "meganovel", language: "en" })).rejects.toThrow("no source evidence");
    expect(submit).not.toHaveBeenCalled();
  });
  it("does not infer missing provenance for a source that merely claims the target market", async () => {
    const source = { name: "meganovel", fetch: async () => ({ platform: "meganovel", language: "en" as const,
      entries: [{ title: "Unverified claim", author: "", category: "", extra: "" }] }) };
    await expect(new RadarAgent(context, [source]).scan({ targetPlatform: "meganovel", language: "en" })).rejects.toThrow("no source evidence");
    expect(submit).not.toHaveBeenCalled();
  });
  it("rejects stale or future snapshots before invoking the model", async () => {
    for (const fetchedAt of ["2020-01-01T00:00:00Z", "2030-01-01T00:00:00Z"]) {
      const source = new MegaNovelSnapshotRadarSource({ html: await fixtureHtml(), sourceUrl: url, fetchedAt });
      await expect(new RadarAgent(context, [source]).scan({ targetPlatform: "meganovel", language: "en", maxSourceAgeMs: 60_000 })).rejects.toThrow("no source evidence");
    }
    expect(submit).not.toHaveBeenCalled();
  });
  it("persists host provenance even if the model attempts to replace it", async () => {
    const scan = { recommendations: [], marketSummary: "Source-derived market analysis" };
    submit.mockResolvedValue({ result: { ...scan, evidence: [], scanId: "model-selected-id" } });
    const source = new MegaNovelSnapshotRadarSource({ html: await fixtureHtml(), sourceUrl: url, fetchedAt: observed });
    const result = await new RadarAgent(context, [source]).scan({ targetPlatform: "meganovel", language: "en" });
    expect(result.evidence).toHaveLength(3);
    expect(result.evidence![0]).toMatchObject({ sourceUrl: url, fetchedAt: observed, acquisition: "snapshot" });
    expect(result.scanId).not.toBe("model-selected-id");
    expect(result.target).toEqual({ platform: "meganovel", language: "en" });
  });
});
