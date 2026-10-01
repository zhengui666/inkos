import { describe, expect, it, vi } from "vitest";
import { runResearchReport } from "../agents/researcher.js";

describe("ResearcherAgent", () => {
  it("builds a traceable research report without mutating story state", async () => {
    const report = await runResearchReport(
      {
        topic: "宋代县衙巡检职责",
        purpose: "worldbuilding",
        depth: "quick",
      },
      {
        search: async (query, maxResults) => {
          expect(query).toContain("宋代县衙巡检职责");
          expect(maxResults).toBeGreaterThan(0);
          return [
            {
              title: "宋代地方治安资料",
              url: "https://example.com/song-policing",
              snippet: "巡检负责地方治安、缉捕盗贼，并与县衙形成协作关系。",
            },
          ];
        },
        fetch: async (url) => {
          expect(url).toBe("https://example.com/song-policing");
          return "巡检司常设于要冲，职责包括巡逻、缉盗、盘查交通要道。";
        },
      },
    );

    expect({
      sourceIds: report.sources.map((source) => source.id),
      sourceUrls: report.sources.map((source) => source.url),
      queries: report.queryLog,
      failures: report.partialFailures,
    }).toEqual({
      sourceIds: ["S1"],
      sourceUrls: ["https://example.com/song-policing"],
      queries: ["宋代县衙巡检职责"],
      failures: [],
    });
    expect(report).toMatchObject({ status: "complete", sourceCount: 1, queryCount: 1, successfulQueries: 1, failedQueries: 0, failedFetches: 0 });
    expect(report.markdown).toMatch(/^<!-- inkos-research \{"version":1,"status":"complete",/);
    const metadata = JSON.parse(report.markdown.split("\n")[0]!.slice("<!-- inkos-research ".length, -" -->".length));
    expect(metadata).toEqual({ version: 1, status: "complete", generatedAt: report.generatedAt, sourceCount: 1, queryCount: 1, successfulQueries: 1, failedQueries: 0, failedFetches: 0 });
    expect(new Date(metadata.generatedAt).toISOString()).toBe(metadata.generatedAt);
  });

  it("distinguishes a successful search with no matches from a failed search", async () => {
    const fetch = vi.fn();
    const report = await runResearchReport({ topic: "No matching records", purpose: "fact-check", depth: "quick" }, {
      search: async () => [], fetch,
    });
    expect(report).toMatchObject({ status: "empty", sourceCount: 0, successfulQueries: 1, failedQueries: 0, partialFailures: [] });
    expect(report.summary).toContain("no matching sources");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("marks all-search failure as diagnostic and excludes provider error bodies and URLs", async () => {
    const fetch = vi.fn();
    const report = await runResearchReport({ topic: "Source records", purpose: "fact-check", depth: "deep" }, {
      search: async () => { throw new Error("Tavily search failed: 503 token=secret-fixture https://provider.invalid/?api_key=secret-fixture"); }, fetch,
    });
    expect(report).toMatchObject({ status: "failed", sourceCount: 0, queryCount: 1, successfulQueries: 0, failedQueries: 1 });
    expect(report.summary).toContain("not research evidence");
    expect(report.partialFailures[0]).toContain("HTTP 503");
    expect(report.markdown).not.toContain("secret-fixture");
    expect(report.markdown).not.toContain("provider.invalid");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("retains real search evidence with a partial status when source fetching fails", async () => {
    const report = await runResearchReport({ topic: "Source records", purpose: "fact-check", depth: "standard" }, {
      search: async () => [{ title: "Archive", url: "https://example.com/record", snippet: "Search excerpt" }],
      fetch: async () => { throw new Error("Fetch failed: 403 secret-fixture https://proxy.invalid/?token=secret-fixture"); },
    });
    expect(report).toMatchObject({ status: "partial", sourceCount: 1, successfulQueries: 1, failedQueries: 0, failedFetches: 1 });
    expect(report.sources).toEqual([{ id: "S1", title: "Archive", url: "https://example.com/record", snippet: "Search excerpt" }]);
    expect(report.markdown).toContain("Search excerpt");
    expect(report.markdown).not.toContain("secret-fixture");
    expect(report.markdown).not.toContain("proxy.invalid");
  });

  it.each([new Error("secret-fixture https://provider.invalid/?token=secret-fixture"), "secret-fixture"])("bounds unrecognized provider failures", async (failure) => {
    const report = await runResearchReport({ topic: "Source records", purpose: "fact-check", depth: "quick" }, {
      search: async () => { throw failure; },
    });
    expect(report.status).toBe("failed");
    expect(report.partialFailures).toEqual(["Search query 1 failed: Search request failed. Check provider availability and retry."]);
    expect(report.markdown).not.toContain("secret-fixture");
  });
});
