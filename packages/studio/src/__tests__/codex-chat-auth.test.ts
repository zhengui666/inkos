import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

const spies = vi.hoisted(() => ({ run: vi.fn(), resolveProvider: vi.fn() }));
vi.mock("@actalk/inkos-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@actalk/inkos-core")>();
  return { ...actual, runAgentSession: spies.run, resolveServiceModel: spies.resolveProvider };
});
import { createStudioServer } from "../api/server.js";

it("reaches the Codex agent without a legacy API key even with an old session provider selection", async () => {
  const root = await mkdtemp(join(tmpdir(), "inkos-codex-no-api-key-"));
  spies.run.mockResolvedValue({ responseText: "Codex answer", completion: { status: "answered", message: "Codex answer" } });
  spies.resolveProvider.mockRejectedValue(new Error("Legacy provider resolution must not run"));
  try {
    await writeFile(join(root, "inkos.json"), JSON.stringify({ name: "codex-only", version: "0.1.0", language: "en" }));
    const app = createStudioServer({} as never, root);
    const post = (body: unknown) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const created = await app.request("/api/v1/sessions", post({ sessionKind: "chat" }));
    expect(created.status).toBe(200);
    const { session } = await created.json();
    const response = await app.request("/api/v1/agent", post({ sessionId: session.sessionId, instruction: "Help with a scene", service: "old-provider", model: "old-model" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ response: "Codex answer", completionStatus: "answered" });
    expect(spies.resolveProvider).not.toHaveBeenCalled();
    expect(spies.run.mock.calls[0][0]).not.toHaveProperty("apiKey");
    expect(spies.run).toHaveBeenCalledWith(expect.objectContaining({ projectRoot: root }), "Help with a scene");
  } finally { await rm(root, { recursive: true, force: true }); }
});
