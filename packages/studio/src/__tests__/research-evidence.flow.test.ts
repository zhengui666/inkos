import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { CodexFixture } from "../../../core/src/__tests__/codex-fixture.js";
const client = vi.hoisted(() => vi.fn());
vi.mock("../../../core/src/codex/client.js", () => ({ createCodexClient: client }));
import { createStudioServer } from "../api/server.js";
import { evictAgentCache } from "@actalk/inkos-core";

it("marks unavailable research as a failed tool through Codex, SSE, HTTP and restored cards", async () => {
  const root = await mkdtemp(join(tmpdir(), "inkos-research-api-"));
  const completion = { status: "blocked", message: "New web evidence is unavailable; existing saved reports can still be read." };
  const codex = new CodexFixture(({ step, messages }) => {
    if (step === 1) return { calls: [{ name: "workspace__research_web", args: { topic: "Fixture market", purpose: "Compare sources", depth: "quick" } }] };
    const failed = JSON.parse(messages.at(-1)!.content);
    expect(failed).toMatchObject({ status: "error", code: "RESEARCH_SEARCH_FAILED", recovery: { status: "failed", sourceCount: 0 } });
    return { text: JSON.stringify(completion) };
  });
  client.mockImplementation(codex.createClient);
  vi.stubEnv("TAVILY_API_KEY", "");
  const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected external request"));
  let sessionId: string | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    await writeFile(join(root, "inkos.json"), JSON.stringify({ name: "fixture", version: "0.1.0", language: "en" }));
    const app = createStudioServer({} as never, root);
    const post = (body: unknown) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    sessionId = (await (await app.request("/api/v1/sessions", post({ sessionKind: "chat" }))).json()).session.sessionId;
    reader = (await app.request(`/api/v1/events?sessionId=${sessionId}`)).body!.getReader();
    const streamed = (async () => {
      let text = "";
      const decoder = new TextDecoder();
      while (true) {
        const chunk = await reader!.read();
        if (chunk.done) return text;
        text += decoder.decode(chunk.value, { stream: true });
        if (text.includes('"completionStatus":"blocked"')) return text;
      }
    })();
    const reply = await app.request("/api/v1/agent", post({ sessionId, instruction: "Research the fixture market online." }));
    expect(reply.status).toBe(422);
    const body = await reply.json();
    expect(body.details.toolExecutions).toEqual([expect.objectContaining({ tool: "research_web", status: "error" })]);
    const sse = await streamed;
    const end = sse.split("\n\n").filter(event => event.startsWith("event: tool:end")).map(event => JSON.parse(event.split("\ndata: ")[1]!));
    expect(end).toEqual([expect.objectContaining({ tool: "workspace__research_web", isError: true })]);
    const listed = await (await app.request("/api/v1/sessions?bookId=null")).json();
    expect(listed.sessions).toEqual([expect.objectContaining({ sessionId })]);
    expect(listed.sessions.every((summary: Record<string, unknown>) => !("messages" in summary))).toBe(true);
    const restored = await (await app.request(`/api/v1/sessions/${sessionId}`)).json();
    expect(restored.session.messages.flatMap((message: any) => message.toolExecutions ?? [])).toEqual([
      expect.objectContaining({ tool: "research_web", status: "error" }),
    ]);
    const failure = JSON.parse(codex.toolResponses[0]!.response.contentItems[0].text);
    expect(await readFile(join(root, failure.recovery.reportPath), "utf8")).toContain('"status":"failed"');
    expect(network).not.toHaveBeenCalled();
    expect(codex.toolResponses.map(item => item.response.success)).toEqual([false]);
  } finally { await reader?.cancel(); if (sessionId) evictAgentCache(sessionId); network.mockRestore(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
}, 15_000);
