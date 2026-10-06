import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { RadarResult } from "../agents/radar.js";
import { collectRadarEvidence } from "../agents/radar-evidence.js";
import { MegaNovelRadarSource, MegaNovelSnapshotRadarSource, parseMegaNovelRankingSnapshot } from "../agents/meganovel-radar-source.js";
import { TextRadarSource } from "../agents/radar-source.js";
import { selectRadarRecommendation } from "../agents/radar-selection.js";
import { persistRadarScan } from "../agents/radar-store.js";

const promotion = vi.hoisted(() => ({ fail: false }));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, link: async (...args: Parameters<typeof actual.link>) => {
    if (promotion.fail) throw new Error("Simulated interruption before promotion");
    return actual.link(...args);
  } };
});

const url = "https://www.meganovel.com/rankings";
const observed = "2026-10-06T02:35:03.775Z";
const now = Date.parse("2026-10-06T03:00:00.000Z");
const options = { platform: "meganovel", language: "en" as const, maxAgeMs: 60 * 60_000, now };
const fixtureHtml = () => readFile(new URL("./fixtures/meganovel-rankings-2026-10-06.html", import.meta.url), "utf8");
async function scanFixture(): Promise<RadarResult> {
  const source = parseMegaNovelRankingSnapshot({ html: await fixtureHtml(), sourceUrl: url, fetchedAt: observed });
  return {
    scanId: "scan-fixture", timestamp: observed, marketSummary: "English fantasy ranking observations",
    evidence: collectRadarEvidence([source]),
    recommendations: [{ platform: "meganovel", language: "en", title: "The Cartographer of Borrowed Suns",
      genre: "fantasy", concept: "An original mapmaker bargains with forgotten stars.", reasoning: "Fantasy appears in the supplied ranking.",
      evidenceIds: ["S1E1"], benchmarkTitles: [source.entries[0]!.title] }],
  };
}
afterEach(() => { vi.restoreAllMocks(); promotion.fail = false; });

describe("MegaNovel public ranking snapshots", () => {
  it("parses the reduced real public response, preserving rank, category, language and acquisition time", async () => {
    const rankings = parseMegaNovelRankingSnapshot({ html: await fixtureHtml(), sourceUrl: url, fetchedAt: observed });
    expect(rankings).toMatchObject({ platform: "meganovel", language: "en", sourceUrl: url, fetchedAt: observed });
    expect(rankings.entries).toHaveLength(3);
    expect(rankings.entries[0]).toMatchObject({ title: "The Founder Of Qi Cultivation, Reincarnates?",
      author: "TSETH", category: "Fantasy", rank: 1,
      url: "https://www.meganovel.com/story/The-Founder-Of-Qi-Cultivation-Reincarnates_31000258606" });
  });
  it("does not evaluate script code or treat an unrelated page or unlabelled-language row as evidence", async () => {
    const html = await fixtureHtml();
    expect(() => parseMegaNovelRankingSnapshot({ html: '<script>window.__INITIAL_STATE__=alert("bad")</script>', sourceUrl: url, fetchedAt: observed })).toThrow();
    expect(() => parseMegaNovelRankingSnapshot({ html, sourceUrl: "https://unrelated.example/rankings", fetchedAt: observed })).toThrow("official HTTPS");
    expect(() => parseMegaNovelRankingSnapshot({ html, sourceUrl: `${url}?pageIndex=2`, fetchedAt: observed })).toThrow("page does not match");
    expect(parseMegaNovelRankingSnapshot({ html: html.replaceAll('"ENGLISH"', '"CHINESE"'), sourceUrl: url, fetchedAt: observed }).entries).toEqual([]);
    expect(() => parseMegaNovelRankingSnapshot({ html, sourceUrl: url, fetchedAt: "unknown" })).toThrow("acquisition time");
  });
  it("keeps imported snapshot timestamps and never fetches the network", async () => {
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected network"));
    const source = new MegaNovelSnapshotRadarSource({ html: await fixtureHtml(), sourceUrl: url, fetchedAt: observed });
    const first = await source.fetch();
    expect(first.fetchedAt).toBe(observed);
    (first.entries as unknown[]).pop();
    expect((await source.fetch()).entries).toHaveLength(3);
    expect(network).not.toHaveBeenCalled();
  });
  it("live adapter uses the official endpoint and fails closed on HTTP or changed-page failures", async () => {
    const network = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(await fixtureHtml(), { status: 200 }));
    expect(await new MegaNovelRadarSource().fetch()).toMatchObject({ platform: "meganovel", language: "en", acquisition: "live", entries: expect.any(Array) });
    expect(network.mock.calls[0]![0]).toBe(url);
    network.mockResolvedValueOnce(new Response("blocked", { status: 403 }));
    await expect(new MegaNovelRadarSource().fetch()).rejects.toThrow("403");
    network.mockResolvedValueOnce(new Response("<html>Login required</html>", { status: 200 }));
    await expect(new MegaNovelRadarSource().fetch()).rejects.toThrow("no supported ranking data");
  });
});

describe("source-grounded market selection", () => {
  it("selects an original English concept with the exact cited provenance", async () => {
    const scan = await scanFixture();
    expect(selectRadarRecommendation(scan, options)).toMatchObject({ status: "selected", index: 0,
      recommendation: { title: "The Cartographer of Borrowed Suns", platform: "meganovel", language: "en" },
      evidence: [{ id: "S1E1", sourceUrl: url, fetchedAt: observed, rank: 1 }] });
  });
  it("rejects absent, stale, future, wrong-platform, wrong-language, missing and invented citations", async () => {
    const scan = await scanFixture();
    const bad: RadarResult[] = [
      { ...scan, evidence: undefined },
      { ...scan, timestamp: "2020-01-01T00:00:00Z" },
      { ...scan, evidence: scan.evidence!.map(item => ({ ...item, fetchedAt: "2020-01-01T00:00:00Z" })) },
      { ...scan, evidence: scan.evidence!.map(item => ({ ...item, fetchedAt: "2030-01-01T00:00:00Z" })) },
      { ...scan, evidence: scan.evidence!.map(item => ({ ...item, platform: "fanqie" })) },
      { ...scan, evidence: scan.evidence!.map(item => ({ ...item, language: "zh" as const })) },
      { ...scan, evidence: scan.evidence!.map(item => ({ ...item, sourceUrl: "https://www.qidian.com/rank/" })) },
      { ...scan, recommendations: scan.recommendations.map(item => ({ ...item, evidenceIds: [] })) },
      { ...scan, recommendations: scan.recommendations.map(item => ({ ...item, evidenceIds: ["invented"] })) },
      { ...scan, recommendations: scan.recommendations.map(item => ({ ...item, benchmarkTitles: ["invented"] })) },
      { ...scan, recommendations: scan.recommendations.map(item => ({ ...item, title: item.benchmarkTitles[0] })) },
      { ...scan, recommendations: scan.recommendations.map(item => ({ ...item, language: "zh" as const })) },
    ];
    for (const invalid of bad) expect(selectRadarRecommendation(invalid, options).status).toBe("blocked");
  });
  it("does not convert external text into timestamped remote evidence", async () => {
    expect(collectRadarEvidence([await new TextRadarSource("A popular English story", "meganovel").fetch()])).toEqual([]);
  });

});

describe("durable radar history", () => {
  it("keeps interrupted writes out of official history and retries the same scan successfully", async () => {
    const root = await mkdtemp(join(tmpdir(), "radar-interrupted-"));
    try {
      const scan = await scanFixture();
      promotion.fail = true;
      await expect(persistRadarScan(root, scan)).rejects.toThrow("interruption");
      expect(await readdir(join(root, "radar"))).toEqual([]);
      promotion.fail = false;
      const saved = await persistRadarScan(root, scan);
      expect(JSON.parse(await readFile(saved.path, "utf8"))).toEqual(saved.result);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("survives readback and permits same-scan retries without rewriting observations", async () => {
    const root = await mkdtemp(join(tmpdir(), "radar-history-"));
    try {
      const scan = await scanFixture();
      const saved = await persistRadarScan(root, scan);
      expect(JSON.parse(await readFile(saved.path, "utf8"))).toEqual(saved.result);
      expect(await persistRadarScan(root, scan)).toEqual(saved);
      await expect(persistRadarScan(root, { ...scan, marketSummary: "replacement" })).rejects.toThrow("different content");
      expect(JSON.parse(await readFile(saved.path, "utf8")).marketSummary).toBe(scan.marketSummary);
      await expect(persistRadarScan(root, { ...scan, scanId: "../../outside" })).rejects.toThrow("safe filename");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("does not follow a radar history symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "radar-symlink-"));
    const outside = await mkdtemp(join(tmpdir(), "radar-outside-"));
    try {
      await symlink(outside, join(root, "radar"));
      await expect(persistRadarScan(root, await scanFixture())).rejects.toThrow("symbolic link");
    } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
  });
});
