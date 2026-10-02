import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { CodexFixture } from "../../../core/src/__tests__/codex-fixture.js";
const createCodexClient = vi.hoisted(() => vi.fn());
vi.mock("../../../core/src/codex/client.js", () => ({ createCodexClient }));
import { readTranscriptEvents } from "@actalk/inkos-core";
import { createStudioServer } from "../api/server.js";
import { ChatRequestStore } from "../api/chat-request-store.js";

it("retains a failed submission across server recreation and exposes an interrupted request without replaying it", async () => {
  const root = await mkdtemp(join(tmpdir(), "inkos-chat-recovery-"));
  let calls = 0;
  const codex = new CodexFixture(() => { calls++; return { error: "Fixture rejected the request." }; });
  createCodexClient.mockImplementation(codex.createClient);
  try {
    await mkdir(join(root, ".inkos"));
    await writeFile(join(root, "inkos.json"), JSON.stringify({ name: "fixture", version: "0.1.0", language: "en" }));
    const app = createStudioServer({} as never, root);
    const post = (body: unknown) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const { session } = await (await app.request("/api/v1/sessions", post({ sessionKind: "chat" }))).json();
    const instruction = "Summarize the attached note.";
    const attachments = [{ id: "note", filename: "note.txt", mediaType: "text/plain", size: 5, dataUrl: "data:text/plain;base64,aGVsbG8=" }];
    const response = await app.request("/api/v1/agent", post({ instruction, sessionId: session.sessionId, clientRequestId: "recovery-request",
      sessionKind: "chat", requestedSkills: [], disabledSkills: ["inkos-story-review"], attachments,
      service: "custom:fixture", model: "fixture-model" }));
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(calls).toBe(1);
    const transcript = await readTranscriptEvents(root, session.sessionId);
    const userEvent = transcript.find(event => event.type === "message" && event.role === "user");
    expect(userEvent?.type === "message" && userEvent.display?.userInput).toEqual({
      text: instruction, language: "en", attachments: [{ filename: "note.txt" }],
    });
    const rawUserMessage = JSON.stringify(userEvent?.type === "message" ? userEvent.message : null);
    const recreated = createStudioServer({} as never, root);
    const detail = await (await recreated.request(`/api/v1/sessions/${session.sessionId}`)).json();
    expect(detail.chatRequest).toMatchObject({ requestId: "recovery-request", status: "failed",
      error: { code: "AGENT_LLM_ERROR" }, retry: { text: instruction, options: { attachments, disabledSkills: ["inkos-story-review"] } } });
    expect(calls).toBe(1);
    expect(detail.session.messages[0].content.split("\n")[0]).toBe(instruction);
    const restoredTranscript = await readTranscriptEvents(root, session.sessionId);
    const restoredUser = restoredTranscript.find(event => event.type === "message" && event.role === "user");
    expect(JSON.stringify(restoredUser?.type === "message" ? restoredUser.message : null)).toBe(rawUserMessage);

    // A process can disappear after saving its submission but before terminal persistence.
    const store = new ChatRequestStore(root);
    await store.save({ ...detail.chatRequest, status: "running", completedAt: undefined, error: undefined });
    const restarted = createStudioServer({} as never, root);
    const interrupted = await (await restarted.request(`/api/v1/sessions/${session.sessionId}`)).json();
    expect(interrupted.chatRequest).toMatchObject({ status: "failed", error: { code: "CHAT_REQUEST_INTERRUPTED" }, retry: detail.chatRequest.retry });
    expect(await store.load(session.sessionId)).toEqual(interrupted.chatRequest);
    expect(calls).toBe(1);
    const stopped = await (await restarted.request(`/api/v1/sessions/${session.sessionId}/abort`, { method: "POST" })).json();
    expect(stopped).toMatchObject({ aborted: true });
    expect((await store.load(session.sessionId))?.status).toBe("cancelled");
    expect((await store.load(session.sessionId))?.retry).toBeUndefined();
    const cancelledRestart = createStudioServer({} as never, root);
    const cancelled = await (await cancelledRestart.request(`/api/v1/sessions/${session.sessionId}`)).json();
    expect(cancelled.chatRequest.status).toBe("cancelled");
    expect(calls).toBe(1);
    await restarted.request(`/api/v1/sessions/${session.sessionId}`, { method: "DELETE" });
    expect(await store.load(session.sessionId)).toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 20000);

it("settles the entire request when a failed tool is followed by a silent model", async () => {
  const root = await mkdtemp(join(tmpdir(), "inkos-chat-stalled-"));
  vi.stubEnv("INKOS_AGENT_IDLE_TIMEOUT_MS", "80");
  let calls = 0;
  const codex = new CodexFixture(() => ++calls === 1
    ? { calls: [{ name: "missing_fixture_tool", args: {} }] }
    : { hold: true });
  createCodexClient.mockImplementation(codex.createClient);
  try {
    await mkdir(join(root, ".inkos"));
    await writeFile(join(root, "inkos.json"), JSON.stringify({ name: "fixture", version: "0.1.0", language: "en" }));
    const app = createStudioServer({} as never, root);
    const post = (body: unknown) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const { session } = await (await app.request("/api/v1/sessions", post({ sessionKind: "chat" }))).json();
    const response = await app.request("/api/v1/agent", post({ sessionId: session.sessionId, instruction: "Inspect the fixture", clientRequestId: "stalled" }));
    expect(response.status).toBe(500);
    expect((await response.json()).error.code).toBe("AGENT_MODEL_STALLED");
    const store = new ChatRequestStore(root);
    expect(await store.load(session.sessionId)).toMatchObject({ status: "failed", error: { code: "AGENT_MODEL_STALLED" } });
    expect((await readTranscriptEvents(root, session.sessionId)).at(-1)).toMatchObject({ type: "request_failed", code: "AGENT_MODEL_STALLED" });
    expect(codex.requests.filter(r => r.method === "turn/start")).toHaveLength(1);
    expect(calls).toBe(2);
  } finally { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
});
