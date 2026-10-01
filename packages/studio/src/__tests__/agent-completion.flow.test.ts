import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { CodexFixture } from "../../../core/src/__tests__/codex-fixture.js";
const createCodexClient = vi.hoisted(() => vi.fn());
vi.mock("../../../core/src/codex/client.js", () => ({ createCodexClient }));
import { evictAgentCache } from "@actalk/inkos-core";
import { createStudioServer } from "../api/server.js";

it("keeps answered and blocked outcomes distinct through API delivery and session reload", async () => {
  const root = await mkdtemp(join(tmpdir(), "inkos-api-completion-"));
  const outcomes = [{ status: "answered", message: "A concise answer." }, { status: "blocked", message: "The requested source is unavailable." }];
  let calls = 0;
  let sessionId: string | undefined;
  const codex = new CodexFixture(() => ({ calls: [{ name: "finish_turn", args: outcomes[calls++] }] }));
  createCodexClient.mockImplementation(codex.createClient);
  try {
    await mkdir(join(root, ".inkos"));
    await writeFile(join(root, "inkos.json"), JSON.stringify({ name: "fixture", version: "0.1.0", language: "en" }));
    const app = createStudioServer({} as never, root);
    const post = (body: unknown) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const { session } = await (await app.request("/api/v1/sessions", post({ sessionKind: "chat" }))).json();
    sessionId = session.sessionId;
    const first = await app.request("/api/v1/agent", post({ sessionId: session.sessionId, instruction: "Explain a scene.", model: "fixture-model", service: "custom:fixture" }));
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ completionStatus: "answered", response: outcomes[0].message });
    const second = await app.request("/api/v1/agent", post({ sessionId: session.sessionId, instruction: "Use the missing source.", model: "fixture-model", service: "custom:fixture" }));
    expect(second.status).toBe(422);
    expect(await second.json()).toMatchObject({ completionStatus: "blocked", error: { code: "AGENT_TASK_INCOMPLETE" } });
    const detail = await (await app.request(`/api/v1/sessions/${session.sessionId}`)).json();
    expect(detail.chatRequest).toMatchObject({ status: "failed", completionStatus: "blocked", error: { code: "AGENT_TASK_INCOMPLETE" }, retry: { text: "Use the missing source." } });
    expect(detail.session.messages.filter((m: { role: string }) => m.role === "assistant").map((m: { content: string }) => m.content)).toEqual(outcomes.map(x => x.message));
    expect(calls).toBe(2);
  } finally {
    if (sessionId) evictAgentCache(sessionId);
    await rm(root, { recursive: true, force: true });
  }
}, 15000);

it("returns a genuine native blocker with its explanation and no fictional action receipts", async () => {
  const root = await mkdtemp(join(tmpdir(), "inkos-native-blocked-api-"));
  const completion = { status: "blocked", message: "The required ranking evidence is unavailable; no work has been created." };
  const codex = new CodexFixture(() => ({ text: JSON.stringify(completion) }));
  createCodexClient.mockImplementation(codex.createClient);
  let sessionId: string | undefined;
  try {
    await writeFile(join(root, "inkos.json"), JSON.stringify({ name: "fixture", version: "0.1.0", language: "en" }));
    const app = createStudioServer({} as never, root);
    const post = (body: unknown) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    sessionId = (await (await app.request("/api/v1/sessions", post({ sessionKind: "chat" }))).json()).session.sessionId;
    const response = await app.request("/api/v1/agent", post({ sessionId, instruction: "Use the unavailable ranking evidence." }));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ completionStatus: "blocked", response: completion.message, error: { code: "AGENT_TASK_INCOMPLETE" }, details: { toolExecutions: [] } });
    expect(codex.turns).toHaveLength(1);
    const detail = await (await app.request(`/api/v1/sessions/${sessionId}`)).json();
    expect(detail.chatRequest).toMatchObject({ status: "failed", completionStatus: "blocked" });
    expect(detail.session.messages.filter((message: {role: string}) => message.role === 'assistant').map((message: {content: string}) => message.content)).toEqual([completion.message]);
  } finally { if (sessionId) evictAgentCache(sessionId); await rm(root, { recursive: true, force: true }); }
});
