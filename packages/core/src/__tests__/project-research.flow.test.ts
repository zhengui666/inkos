import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { runAgentSession, abortAgentSession } from "../agent/agent-session.js";
import { loadBookSession } from "../interaction/book-session-store.js";
import { CodexFixture } from "./codex-fixture.js";

const client = vi.hoisted(() => vi.fn());
vi.mock("../codex/client.js", () => ({ createCodexClient: client }));

it("finds and reads saved radar through the main Agent before a Work exists, without web research or re-upload", async () => {
  const root = await mkdtemp(join(tmpdir(), "inkos-local-research-flow-"));
  const path = "radar/scan-fixture.json";
  const source = { timestamp: "2026-10-01T09:17:43.622Z", recommendations: [], marketSummary: "Fixture observations: professional growth stories." };
  const completion = { status: "answered", message: "The saved October 1 radar identifies professional growth stories; this is saved evidence, not a live search." };
  const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network call"));
  const codex = new CodexFixture(({ step, messages, thread }) => {
    expect(thread.baseInstructions).toContain("workspace__list_research_reports");
    expect(thread.baseInstructions).toContain("Failed, empty and unverified reports");
    if (step === 1) return { calls: [{ name: "workspace__retrieve_material", args: { query: "market radar" } }] };
    if (step === 2) {
      expect(messages.at(-1)?.content).toContain("does not search saved radar");
      return { calls: [{ name: "workspace__list_research_reports", args: { kind: "market_radar" } }] };
    }
    if (step === 3) {
      const observation = JSON.parse(messages.at(-1)!.content);
      const report = JSON.parse(observation.content).reports[0];
      expect(report).toMatchObject({ path, generatedAt: source.timestamp, evidenceUsable: true });
      return { calls: [{ name: "workspace__read_research_report", args: { path: report.path } }] };
    }
    if (step === 4) {
      expect(messages.at(-1)?.content).toContain(source.marketSummary);
      return { text: JSON.stringify(completion) };
    }
    throw new Error("Unexpected replay");
  });
  client.mockImplementation(codex.createClient);
  try {
    await mkdir(join(root, "radar"));
    await writeFile(join(root, path), JSON.stringify(source));
    const result = await runAgentSession({ projectRoot: root, sessionId: "saved-radar", bookId: null,
      profileId: "workspace-default", sessionKind: "chat", language: "en", pipeline: {} as never },
    "Use the market radar already saved in this project to explain a direction.");
    expect(result.errorMessage).toBeUndefined();
    expect(result.completion).toEqual(completion);
    expect(codex.toolResponses.map(item => item.name)).toEqual([
      "workspace__retrieve_material", "workspace__list_research_reports", "workspace__read_research_report",
    ]);
    expect(codex.toolResponses.every(item => item.response.success)).toBe(true);
    expect(network).not.toHaveBeenCalled();
    const saved = await loadBookSession(root, "saved-radar");
    expect(saved?.messages.filter(message => message.role === "assistant" && message.content).map(message => message.content)).toEqual([completion.message]);
  } finally { network.mockRestore(); abortAgentSession(root, "saved-radar"); await rm(root, { recursive: true, force: true }); }
});
