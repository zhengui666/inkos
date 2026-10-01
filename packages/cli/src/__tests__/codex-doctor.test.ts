import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@actalk/inkos-core", async importOriginal => ({
  ...await importOriginal<typeof import("@actalk/inkos-core")>(), createCodexAccountService: mocks.create,
}));
import { doctorCommand } from "../commands/doctor.js";
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
it("default CLI doctor checks Codex readiness with no legacy API key or billed provider request", async () => {
  const root = await mkdtemp(join(tmpdir(), "inkos-codex-doctor-")); roots.push(root);
  await writeFile(join(root, "inkos.json"), JSON.stringify({ name: "Codex only", version: "0.1.0" }));
  vi.spyOn(process, "cwd").mockReturnValue(root);
  const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No inference permitted"));
  const service = {
    readAccount: vi.fn(async () => ({ connected: true, account: { type: "chatgpt" } })),
    readSettings: vi.fn(async () => ({ reasoningEffort: "medium", serviceTier: "default" })),
    listModels: vi.fn(async () => [{ id: "fixture", model: "fixture", isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "medium" }], serviceTiers: [] }]),
    dispose: vi.fn(async () => {}),
  };
  mocks.create.mockReturnValue(service);
  await doctorCommand.parseAsync([], { from: "user" });
  const text = output.mock.calls.map(call => call[0]).join("");
  expect(text).toContain("ChatGPT account ready; model=fixture");
  expect(text).not.toContain("LLM API Key");
  expect(text).not.toContain("API Connectivity");
  expect(text).not.toContain("config set-global");
  expect(service.dispose).toHaveBeenCalledOnce();
  expect(fetch).not.toHaveBeenCalled();
});
