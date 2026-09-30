import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { CodexFixture } from "../../../core/src/__tests__/codex-fixture.js";
const createCodexClient = vi.hoisted(() => vi.fn());
vi.mock("../../../core/src/codex/client.js", () => ({ createCodexClient }));
import { evictAgentCache } from "@actalk/inkos-core";
import { createStudioServer } from "../api/server.js";

it("delivers a complete Codex reasoning lifecycle over Studio SSE", async () => {
  const root = await mkdtemp(join(tmpdir(), "inkos-codex-sse-"));
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let sessionId: string | undefined;
  const codex = new CodexFixture(() => ({ thinking: "Check the scene constraints.", calls: [
    { name: "finish_turn", args: { status: "answered", message: "Ready to write." } },
  ] }));
  createCodexClient.mockImplementation(codex.createClient);
  try {
    await writeFile(join(root, "inkos.json"), JSON.stringify({ name: "fixture", version: "0.1.0", language: "en" }));
    const app = createStudioServer({} as never, root);
    const post = (body: unknown) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const { session } = await (await app.request("/api/v1/sessions", post({ sessionKind: "chat" }))).json();
    sessionId = session.sessionId;
    const stream = await app.request(`/api/v1/events?sessionId=${sessionId}`);
    reader = stream.body!.getReader();
    const events = (async () => {
      let text = "";
      const decoder = new TextDecoder();
      while (true) {
        const chunk = await reader!.read();
        if (chunk.done) return text;
        text += decoder.decode(chunk.value, { stream: true });
        if (text.includes("event: agent:complete")) return text;
      }
    })();
    const response = await app.request("/api/v1/agent", post({ sessionId, instruction: "Explain the scene." }));
    expect(response.status).toBe(200);
    const text = await events;
    expect(text).toContain("event: thinking:start");
    expect(text).toContain("event: thinking:delta");
    expect(text).toContain("Check the scene constraints.");
    expect(text).toContain("event: thinking:end");
    expect(text.indexOf("event: thinking:start")).toBeLessThan(text.indexOf("event: thinking:delta"));
    expect(text.indexOf("event: thinking:delta")).toBeLessThan(text.indexOf("event: thinking:end"));
    expect(text.indexOf("event: thinking:end")).toBeLessThan(text.indexOf("event: agent:complete"));
  } finally {
    await reader?.cancel();
    if (sessionId) evictAgentCache(sessionId);
    await rm(root, { recursive: true, force: true });
  }
});
