import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createResearchWebTool } from "../agent/agent-tools.js";
import { actionFailureFacts, actionResultFacts } from "../harness/action-observation.js";
import { createBuiltInWorkProfileRegistry } from "../harness/builtin-profiles.js";
import { createSingleToolCapabilityRegistry } from "../harness/production-capabilities.js";
import { createCapabilityPiTools } from "../harness/pi-tools.js";
import { CreativeHarnessRuntime } from "../harness/runtime.js";
import { CreativeEpisodeStore } from "../harness/episode-store.js";

const parameters = { topic: "Archive records", purpose: "fact-check", depth: "quick" as const };
const roots: string[] = [];

async function project(configured = false): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "inkos-research-status-"));
  roots.push(root);
  if (configured) await writeFile(join(root, "inkos.json"), JSON.stringify({ researchSearch: { enabled: true, apiKey: "fixture-only-key" } }));
  return root;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("research_web outcome semantics", () => {
  it("records missing configuration as a failed harness action with a saved diagnostic", async () => {
    vi.stubEnv("TAVILY_API_KEY", undefined);
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const root = await project();
    const ledger = new CreativeEpisodeStore(join(root, ".inkos/harness.sqlite"));
    try {
      const profiles = createBuiltInWorkProfileRegistry();
      const profile = profiles.require("workspace-default");
      const registry = createSingleToolCapabilityRegistry({
        binding: { capabilityId: "workspace", actionId: "research_web", profileId: profile.id, risk: "read" },
        tool: createResearchWebTool(root),
      });
      const runtime = new CreativeHarnessRuntime(root, registry, profiles, ledger);
      const handle = runtime.startEpisode({ profileId: profile.id });
      const tool = createCapabilityPiTools({ registry, profile: { ...profile, capabilityIds: ["workspace"] },
        executeAction: (capabilityId, actionId, params) => runtime.executeAction({ handle, capabilityId, actionId, parameters: params, source: "explicit", confirmed: true }),
      })[0]!;
      const error = await tool.execute("research", parameters).then(() => null, error => error);
      expect(error).toBeInstanceOf(Error);
      const observation = JSON.parse(error.message);
      expect(observation).toMatchObject({ status: "error", code: "RESEARCH_SEARCH_FAILED", recovery: {
        action: "workspace__research_web", status: "failed", sourceCount: 0, queryCount: 1, successfulQueries: 0, failedQueries: 1,
      } });
      expect(observation.recovery.reportPath).toMatch(/^\.inkos\/research\/[^/]+\.md$/);
      const saved = await readFile(join(root, observation.recovery.reportPath), "utf-8");
      expect(saved).toMatch(/^<!-- inkos-research \{"version":1,"status":"failed",/);
      expect(saved).toContain("not research evidence");
      expect(saved).toContain("Configure Studio research search");
      expect(fetch).not.toHaveBeenCalled();
      expect(ledger.listEvents(handle.episode.id).find(event => event.type === "action-failed")?.payload)
        .toMatchObject({ code: "RESEARCH_SEARCH_FAILED", recovery: { reportPath: observation.recovery.reportPath, status: "failed" } });
      expect(ledger.listEvents(handle.episode.id).some(event => event.type === "action-completed")).toBe(false);
      runtime.finishEpisode(handle, "failed");
    } finally { ledger.close(); }
  });

  it("does not leak a failed provider response through the error or diagnostic report", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("token=secret-fixture https://provider.invalid/?key=secret-fixture", { status: 503 })));
    const root = await project(true);
    const failure = await createResearchWebTool(root).execute("research", parameters).then(() => null, actionFailureFacts);
    expect(failure).toMatchObject({ code: "RESEARCH_SEARCH_FAILED", recovery: { status: "failed", sourceCount: 0 } });
    const [file] = await readdir(join(root, ".inkos/research"));
    const saved = await readFile(join(root, ".inkos/research", file!), "utf-8");
    expect(saved).toContain("HTTP 503");
    expect(JSON.stringify(failure) + saved).not.toMatch(/secret-fixture|provider\.invalid|fixture-only-key/);
  });

  it("preserves a safe diagnostic when the saved search configuration is invalid", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const root = await project();
    await writeFile(join(root, "inkos.json"), '{"researchSearch":"invalid-secret-fixture');
    const failure = await createResearchWebTool(root).execute("research", parameters).then(() => null, actionFailureFacts);
    expect(failure).toMatchObject({ code: "RESEARCH_SEARCH_FAILED", recovery: { status: "failed", successfulQueries: 0, failedQueries: 1 } });
    const [file] = await readdir(join(root, ".inkos/research"));
    const saved = await readFile(join(root, ".inkos/research", file!), "utf-8");
    expect(saved).toContain("configuration could not be read");
    expect(JSON.stringify(failure) + saved).not.toContain("invalid-secret-fixture");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves the environment-key fallback when no Studio search configuration is enabled", async () => {
    vi.stubEnv("TAVILY_API_KEY", "fixture-environment-key");
    const fetch = vi.fn(async () => Response.json({ results: [] }));
    vi.stubGlobal("fetch", fetch);
    const result = await createResearchWebTool(await project()).execute("research", parameters);
    expect(actionResultFacts(result.details)).toMatchObject({ status: "empty", successfulQueries: 1 });
    expect(fetch).toHaveBeenCalledWith("https://api.tavily.com/search", expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer fixture-environment-key" }),
    }));
  });

  it("returns an explicit empty outcome for a successful search with zero matches", async () => {
    const fetch = vi.fn(async () => Response.json({ results: [] }));
    vi.stubGlobal("fetch", fetch);
    const root = await project(true);
    const result = await createResearchWebTool(root).execute("research", parameters);
    expect(actionResultFacts(result.details)).toMatchObject({ kind: "research_report", status: "empty", sourceCount: 0, successfulQueries: 1, failedQueries: 0 });
    expect(result.content).toEqual([expect.objectContaining({ text: expect.stringContaining("no matching sources") })]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("retains source evidence and precise status when fetch failure is %s", async (fetchFails) => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url === "https://api.tavily.com/search"
      ? Response.json({ results: [{ title: "Archive", url: "https://example.com/archive", content: "Verified search snippet" }] })
      : new Response(fetchFails ? "restricted" : "Archive source excerpt", { status: fetchFails ? 403 : 200 })));
    const root = await project(true);
    const result = await createResearchWebTool(root).execute("research", parameters);
    expect(actionResultFacts(result.details)).toMatchObject({ kind: "research_report", status: fetchFails ? "partial" : "complete", sourceCount: 1, successfulQueries: 1, failedQueries: 0, failedFetches: fetchFails ? 1 : 0 });
    const details = result.details as { reportPath: string; sources: unknown[] };
    expect(details.reportPath).toMatch(/^\.inkos\/research\/[^/]+\.md$/);
    expect(details.sources).toHaveLength(1);
    expect(await readFile(join(root, details.reportPath), "utf-8")).toContain(fetchFails ? "Verified search snippet" : "Archive source excerpt");
  });
});
