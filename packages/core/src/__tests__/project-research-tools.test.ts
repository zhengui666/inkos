import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createListResearchReportsTool, createReadResearchReportTool } from "../agent/project-research-tools.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "inkos-saved-research-"));
  await mkdir(join(root, "radar"));
  await mkdir(join(root, ".inkos", "research"), { recursive: true });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const radar = (timestamp: string) => ({ timestamp, recommendations: [], marketSummary: "Saved platform observations" });
const report = (status: string, sourceCount: number, body = "Evidence excerpt") => [
  `<!-- inkos-research ${JSON.stringify({ version: 1, status, generatedAt: "2026-10-01T10:00:00Z", sourceCount })} -->`,
  "# Research: Saved market", "", "## Summary", body, "", "## Sources",
  sourceCount ? "### [S1] Source\nhttps://example.test/report\nEvidence" : "No sources collected.",
  "", "## Partial failures", status === "failed" || status === "partial" ? "- Search failed." : "- None.",
].join("\n");

it("discovers saved radar without a Work/material archive and returns real paths ordered by report date", async () => {
  await writeFile(join(root, "radar", "scan-old.json"), JSON.stringify(radar("2026-09-01T00:00:00Z")));
  await writeFile(join(root, "radar", "scan-new.json"), JSON.stringify(radar("2026-10-01T00:00:00Z")));
  const result = await createListResearchReportsTool(root).execute("list", { kind: "market_radar", limit: 1 });
  expect(result.details).toMatchObject({ reports: [{ path: "radar/scan-new.json", kind: "market_radar", status: "complete",
    generatedAt: "2026-10-01T00:00:00.000Z", sourceCount: null, evidenceUsable: true }], truncated: true });
  const read = await createReadResearchReportTool(root).execute("read", { path: "radar/scan-new.json" });
  expect(read.details).toMatchObject({ path: "radar/scan-new.json", kind: "project_research_read", reportKind: "market_radar", contentScope: "full_report", nextRead: null });
  expect(read.content).toEqual([{ type: "text", text: expect.stringContaining("Saved platform observations") }]);
});

it.each(["complete", "partial", "empty", "failed"])("preserves %s research evidence status, including legacy reports", async status => {
  const sourceCount = status === "complete" || status === "partial" ? 1 : 0;
  const text = report(status, sourceCount);
  await writeFile(join(root, ".inkos/research", "new.md"), text);
  await writeFile(join(root, ".inkos/research", "legacy.md"), text.slice(text.indexOf("\n") + 1));
  const result = await createListResearchReportsTool(root).execute("list", {});
  expect((result.details as any).reports).toHaveLength(2);
  for (const item of (result.details as any).reports) expect(item).toMatchObject({ status, sourceCount, evidenceUsable: sourceCount > 0 });
  expect((result.details as any).reports.find((item: any) => item.path.endsWith("legacy.md")).generatedAt).toBeNull();
});

it("keeps malformed/contradictory reports unverified and paginates full content with bounded summaries", async () => {
  await writeFile(join(root, "radar", "scan-broken.json"), "not json");
  await writeFile(join(root, ".inkos/research", "contradictory.md"), report("complete", 0));
  const text = report("complete", 1, "Evidence ".repeat(2_000));
  await writeFile(join(root, ".inkos/research", "long.md"), text);
  const catalog = (await createListResearchReportsTool(root).execute("list", {})).details as any;
  expect(catalog.reports.every((item: any) => item.summary.length <= 180)).toBe(true);
  expect(catalog.reports.filter((item: any) => item.status === "unverified")).toHaveLength(2);
  const reader = createReadResearchReportTool(root);
  const first = await reader.execute("read-1", { path: ".inkos/research/long.md" });
  expect(first.details).toMatchObject({ contentScope: "page_excerpt", totalChars: text.length, nextRead: { path: ".inkos/research/long.md", offset: 12_000 } });
  const second = await reader.execute("read-2", (first.details as any).nextRead);
  expect(second.details).toMatchObject({ nextRead: null, offset: 12_000 });
});

it.each([
  report("complete", 1).replace("## Sources", "## Missing sources"),
  report("partial", 2),
  report("complete", 1).replace("### [S1] Source\nhttps://example.test/report\nEvidence", "No sources collected."),
  report("complete", 1).replace("https://example.test/report", "missing-url"),
])("does not trust successful metadata without matching source records", async text => {
  await writeFile(join(root, ".inkos/research", "inconsistent.md"), text);
  const catalog = (await createListResearchReportsTool(root).execute("list", {})).details as any;
  expect(catalog.reports).toEqual([expect.objectContaining({ status: "unverified", evidenceUsable: false })]);
  expect((await createReadResearchReportTool(root).execute("read", { path: ".inkos/research/inconsistent.md" })).details)
    .toMatchObject({ status: "unverified", evidenceUsable: false });
});

it("rejects paths outside the report catalog, directories, and oversized reports", async () => {
  const reader = createReadResearchReportTool(root);
  for (const path of ["../outside.md", "inkos.json", ".inkos/research/../../outside.md", ".inkos/research", "/tmp/scan-test.json"])
    await expect(reader.execute("read", { path })).rejects.toMatchObject({ code: "RESEARCH_REPORT_PATH_INVALID" });
  await writeFile(join(root, "radar", "scan-large.json"), "x".repeat(1024 * 1024 + 1));
  await expect(reader.execute("large", { path: "radar/scan-large.json" })).rejects.toThrow("1 MiB");
  expect((await createListResearchReportsTool(root).execute("list", {})).details).toMatchObject({ reports: [], skipped: 1 });
});

it.skipIf(process.platform === "win32")("does not follow report-file or parent-directory symlinks", async () => {
  const outside = await mkdtemp(join(tmpdir(), "inkos-research-outside-"));
  try {
    await writeFile(join(outside, "scan-outside.json"), JSON.stringify(radar("2026-10-01T00:00:00Z")));
    await symlink(join(outside, "scan-outside.json"), join(root, "radar", "scan-link.json"));
    await expect(createReadResearchReportTool(root).execute("link", { path: "radar/scan-link.json" })).rejects.toThrow();
    expect((await createListResearchReportsTool(root).execute("list", {})).details).toMatchObject({ reports: [] });
    await rm(join(root, "radar"), { recursive: true });
    await symlink(outside, join(root, "radar"));
    await expect(createReadResearchReportTool(root).execute("parent", { path: "radar/scan-outside.json" })).rejects.toThrow();
    expect((await createListResearchReportsTool(root).execute("list", {})).details).toMatchObject({ reports: [], skipped: 1 });
  } finally { await rm(outside, { recursive: true, force: true }); }
});
