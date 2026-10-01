import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { CodexFixture } from "../../../core/dist/__tests__/codex-fixture.js";
import { FanqieRadarSource, QidianRadarSource } from "../../../core/dist/agents/radar-source.js";
import { loadConfig, loadConfigWithDiagnostics, createClient } from "../utils.js";
import { radarCommand } from "../commands/radar.js";

const createCodexClient = vi.hoisted(() => vi.fn());
vi.mock("../../../core/dist/codex/client.js", () => ({ createCodexClient }));
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it("CLI radar reaches the actual Codex worker from a fresh project without provider keys or env", async () => {
  const root = await mkdtemp(join(tmpdir(), "inkos-cli-codex-")); roots.push(root);
  await writeFile(join(root, "inkos.json"), JSON.stringify({ name: "codex-only", version: "0.1.0", language: "en" }));
  const codex = new CodexFixture(() => ({ calls: [{ name: "submit_market_radar", args: { recommendations: [], marketSummary: "Fixture market evidence" } }] }));
  createCodexClient.mockImplementation(codex.createClient);
  vi.spyOn(FanqieRadarSource.prototype, "fetch").mockResolvedValue({ platform: "tomato", entries: [{ title: "Fixture title", extra: "Rank 1" }] } as never);
  vi.spyOn(QidianRadarSource.prototype, "fetch").mockResolvedValue({ platform: "qidian", entries: [] } as never);
  vi.spyOn(process, "cwd").mockReturnValue(root);
  vi.spyOn(process, "exit").mockImplementation(code => { throw new Error(`Unexpected CLI exit: ${code}`); });
  const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  await radarCommand.parseAsync(["scan", "--json"], { from: "user" });
  expect(codex.turns).toHaveLength(1);
  expect(createCodexClient).toHaveBeenCalledWith(root);
  expect(await readdir(join(root, "radar"))).toHaveLength(1);
  expect(output.mock.calls.map(call => call[0]).join("")).toContain("Fixture market evidence");
  const config = await loadConfig({ projectRoot: root });
  expect(createClient(config, root)._codex?.projectRoot).toBe(root);
  expect((await loadConfigWithDiagnostics({ projectRoot: root })).diagnostics.configMode).toBe("codex");
  await expect(loadConfig({ projectRoot: root, purpose: "provider" })).rejects.toMatchObject({ code: "MISSING_API_KEY" });
});
