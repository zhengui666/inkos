import { fetchUrl, searchWeb, type SearchResult } from "../utils/web-search.js";

export type ResearchPurpose = string;
export type ResearchDepth = "quick" | "standard" | "deep";
export type ResearchStatus = "complete" | "partial" | "empty" | "failed";

export interface ResearchInput {
  readonly topic: string;
  readonly purpose: ResearchPurpose;
  readonly depth: ResearchDepth;
}

export interface ResearchSource {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  readonly excerpt?: string;
}

export interface ResearchReport {
  readonly status: ResearchStatus;
  readonly generatedAt: string;
  readonly sourceCount: number;
  readonly queryCount: number;
  readonly successfulQueries: number;
  readonly failedQueries: number;
  readonly failedFetches: number;
  readonly summary: string;
  readonly sources: readonly ResearchSource[];
  readonly queryLog: readonly string[];
  readonly partialFailures: readonly string[];
  readonly markdown: string;
}

export interface ResearchDeps {
  readonly search?: (query: string, maxResults: number) => Promise<ReadonlyArray<SearchResult>>;
  readonly fetch?: (url: string) => Promise<string>;
}

export async function runResearchReport(
  input: ResearchInput,
  deps: ResearchDeps = {},
): Promise<ResearchReport> {
  const topic = input.topic.trim();
  if (!topic) throw new Error("research topic is required.");
  const search = deps.search ?? searchWeb;
  const fetch = deps.fetch ?? fetchUrl;
  const depth = depthConfig(input.depth);
  const queries = buildQueries(topic, input.purpose, input.depth);
  const queryLog: string[] = [];
  const partialFailures: string[] = [];
  const found = new Map<string, SearchResult>();
  let successfulQueries = 0;
  let failedQueries = 0;
  let failedFetches = 0;

  for (const query of queries) {
    queryLog.push(query);
    try {
      const results = await search(query, depth.maxResults);
      for (const result of results) {
        if (!result.url || found.has(result.url)) continue;
        found.set(result.url, result);
      }
      successfulQueries += 1;
    } catch (error) {
      failedQueries += 1;
      partialFailures.push(`Search query ${queryLog.length} failed: ${safeResearchFailure(error, "search")}`);
    }
  }

  const sources: ResearchSource[] = [];
  for (const result of [...found.values()].slice(0, depth.fetchCount)) {
    let excerpt: string | undefined;
    try {
      excerpt = await fetch(result.url);
    } catch (error) {
      failedFetches += 1;
      partialFailures.push(`Source S${sources.length + 1} could not be fetched; search snippet retained. ${safeResearchFailure(error, "fetch")}`);
    }
    sources.push({
      id: `S${sources.length + 1}`,
      title: result.title || result.url,
      url: result.url,
      snippet: result.snippet,
      ...(excerpt ? { excerpt } : {}),
    });
  }

  const status: ResearchStatus = successfulQueries === 0 ? "failed"
    : sources.length === 0 ? "empty"
    : partialFailures.length > 0 ? "partial" : "complete";
  const summary = status === "failed"
    ? "Research failed: every search request failed. This saved diagnostic is not research evidence. Check Studio research search configuration and provider availability before retrying."
    : status === "empty"
      ? "Research search completed with no matching sources. No evidence was collected; try a different query."
      : `Research collected ${sources.length} source(s) for "${topic}" (${input.purpose}, ${input.depth}).${status === "partial" ? " Results are partial; review the warnings before using this evidence." : ""}`;
  const report: Omit<ResearchReport, "markdown"> = {
    status,
    generatedAt: new Date().toISOString(),
    sourceCount: sources.length,
    queryCount: queryLog.length,
    successfulQueries,
    failedQueries,
    failedFetches,
    summary,
    sources,
    queryLog,
    partialFailures,
  };
  return {
    ...report,
    markdown: renderResearchMarkdown(topic, input, report),
  };
}

/** Provider errors can contain credentials, request URLs, or response bodies. */
function safeResearchFailure(error: unknown, phase: "search" | "fetch"): string {
  const message = error instanceof Error ? error.message : "";
  if (phase === "search" && message.endsWith("not set. Configure Studio research search or set the env var to enable web search.")) {
    return "Search API key is not configured. Configure Studio research search or set the search provider API key environment variable.";
  }
  if (phase === "search" && error instanceof Error && "code" in error && error.code === "RESEARCH_CONFIGURATION_INVALID") {
    return "Research search configuration could not be read. Review Studio research search settings before retrying.";
  }
  const httpStatus = message.match(/^(?:Tavily search failed|Fetch failed): ([1-5]\d{2})\b/)?.[1];
  if (httpStatus) return `${phase === "search" ? "Search" : "Fetch"} request failed (HTTP ${httpStatus}).`;
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return `${phase === "search" ? "Search" : "Fetch"} request timed out or was interrupted.`;
  }
  return `${phase === "search" ? "Search" : "Fetch"} request failed. Check provider availability and retry.`;
}

function depthConfig(depth: ResearchDepth): { maxResults: number; fetchCount: number } {
  if (depth === "deep") return { maxResults: 8, fetchCount: 6 };
  if (depth === "standard") return { maxResults: 5, fetchCount: 4 };
  return { maxResults: 3, fetchCount: 2 };
}

function buildQueries(topic: string, _purpose: ResearchPurpose, _depth: ResearchDepth): string[] {
  return [topic];
}

function renderResearchMarkdown(
  topic: string,
  input: ResearchInput,
  report: Omit<ResearchReport, "markdown">,
): string {
  // Keep one bounded, versioned line for inventory readers, followed by the
  // existing human-readable report structure. Never include provider errors.
  const metadata = {
    version: 1,
    status: report.status,
    generatedAt: report.generatedAt,
    sourceCount: report.sourceCount,
    queryCount: report.queryCount,
    successfulQueries: report.successfulQueries,
    failedQueries: report.failedQueries,
    failedFetches: report.failedFetches,
  };
  return [
    `<!-- inkos-research ${JSON.stringify(metadata)} -->`,
    `# Research: ${topic}`,
    "",
    `- Status: ${report.status}`,
    `- Purpose: ${input.purpose}`,
    `- Depth: ${input.depth}`,
    "## Summary",
    report.summary,
    "",
    "## Sources",
    ...(report.sources.length > 0
      ? report.sources.map((source) => [
          `### [${source.id}] ${source.title}`,
          source.url,
          "",
          source.excerpt || source.snippet || "",
        ].join("\n"))
      : ["No sources collected."]),
    "",
    "## Query log",
    ...report.queryLog.map((query) => `- ${query}`),
    "",
    "## Partial failures",
    ...(report.partialFailures.length > 0 ? report.partialFailures.map((item) => `- ${item}`) : ["- None."]),
    "",
  ].join("\n");
}
