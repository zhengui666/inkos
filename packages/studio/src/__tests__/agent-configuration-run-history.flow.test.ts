import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CodexFixture } from "../../../core/src/__tests__/codex-fixture.js";
const createCodexClient = vi.hoisted(() => vi.fn());
vi.mock("../../../core/src/codex/client.js", () => ({ createCodexClient }));
// Vitest 3's transformed import.meta has no resolve. Execute the unchanged
// audited loader through Node; the official SDK/storage methods remain real.
vi.mock("../../../core/src/runtime/auth/pi-native-store-compat.js", async () => {
  const { createRequire } = await import("node:module");
  return createRequire(import.meta.url)("../../../core/src/runtime/auth/pi-native-store-compat.ts");
});
import { CreativeEpisodeStore, createCodexAccountService, currentCodexRun, evictAgentCache,
  projectRunHistory, readAgentSettings, readTranscriptEvents, RUN_HISTORY_EVENT_TYPE } from "@actalk/inkos-core";
import { createStudioServer, shutdownStudioServer } from "../api/server.js";
beforeEach(() => {
  vi.stubEnv("INKOS_CODEX_HOME", ""); delete process.env.INKOS_CODEX_HOME;
  vi.stubEnv("INKOS_CODEX_STATE_ROOT", ""); delete process.env.INKOS_CODEX_STATE_ROOT;
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

// The actual Studio chat caller, Core queue, request snapshot and durable stores
// run unchanged. Only the native protocol peer is offline; this is not inference.
it("the production Studio chat caller records its frozen Codex configuration after saving Pi and blocks the next request without fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "inkos-studio-run-history-"));
  // The newly saved Pi default has no credential in its explicitly isolated
  // native directory, even if the developer's ambient Pi home is authenticated.
  vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "missing-pi-home"));
  const network = vi.fn(async () => { throw new Error("External network forbidden"); });
  vi.stubGlobal("fetch", network);
  createCodexClient.mockClear();
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let runningRevision = -1;
  const fixture = new CodexFixture(async () => {
    const run = currentCodexRun();
    if (!run) throw new Error("Expected the actual admitted request context");
    runningRevision = run.selection.configRevision;
    entered(); await gate;
    return { text: JSON.stringify({ status: "answered", message: "Offline production caller answer" }) };
  });
  createCodexClient.mockImplementation(fixture.createClient);
  const service = createCodexAccountService({ projectDir: root, clientFactory: fixture.createClient });
  const app = createStudioServer({} as never, root, { codexAccountService: service });
  const post = (body: unknown) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  let sessionId: string | undefined;
  let pending: Promise<Response> | undefined;
  try {
    await writeFile(join(root, "inkos.json"), JSON.stringify({ name: "Offline caller", version: "0.1.0", language: "en" }));
    const { session } = await (await app.request("/api/v1/sessions", post({ sessionKind: "chat" }))).json();
    sessionId = session.sessionId;
    const running = Promise.resolve(app.request("/api/v1/agent", post({ sessionId, instruction: "Answer from this request configuration" })));
    pending = running;
    await started;
    const oldDefault = await readAgentSettings(root);
    expect(oldDefault.selectedHarnessId).toBe("codex"); expect(oldDefault.revision).toBe(runningRevision);
    const savedResponse = await app.request("/api/v1/agent-configuration/settings", { ...post({ expectedRevision: oldDefault.revision, patch: { selectedHarnessId: "pi" } }), method: "PUT" });
    expect(savedResponse.status, await savedResponse.clone().text()).toBe(200);
    expect((await savedResponse.json()).settings).toMatchObject({ selectedHarnessId: "pi", revision: oldDefault.revision + 1 });
    release(); expect((await running).status).toBe(200);

    const store = new CreativeEpisodeStore(join(root, ".inkos", "harness.sqlite"));
    let episodes: ReturnType<typeof store.listEpisodes>, events: ReturnType<typeof store.listEvents>;
    try { episodes = store.listEpisodes(); events = episodes.flatMap(episode => store.listEvents(episode.id)); }
    finally { store.close(); }
    expect(events.filter(event => event.type === RUN_HISTORY_EVENT_TYPE).length).toBeGreaterThanOrEqual(5);
    const transcript = await readTranscriptEvents(root, sessionId!);
    const history = projectRunHistory({ sessionId: sessionId!, transcript, episodes, events });
    expect(history.issues).toEqual([]); expect(history.requests).toHaveLength(1);
    expect(history.requests[0]).toMatchObject({ transcriptStatus: "committed", recording: "recorded",
      selection: { saved: { harnessId: "codex", revision: oldDefault.revision }, selection: { harnessId: "codex", configRevision: oldDefault.revision } } });
    expect(history.requests[0]!.dispatches.map(dispatch => dispatch.operation)).toEqual(["codex-thread-start", "codex-turn-start"]);
    expect(history.requests[0]!.observations.every(observation => observation.linked)).toBe(true);
    expect(JSON.stringify(history)).not.toContain("connectionRef"); expect(JSON.stringify(history)).not.toContain("authContextRef");
    const beforeNext = { peers: createCodexClient.mock.calls.length, rpc: fixture.requests.length, turns: fixture.turns.length };
    const blocked = await app.request("/api/v1/agent", post({ sessionId, instruction: "Use the newly saved Pi default" }));
    expect(blocked.status).toBe(500);
    expect(await blocked.json()).toMatchObject({ error: { code: "INKOS_ACTION_ERROR",
      message: expect.stringContaining("Pi requires an existing ChatGPT OAuth credential") } });
    expect({ peers: createCodexClient.mock.calls.length, rpc: fixture.requests.length, turns: fixture.turns.length }).toEqual(beforeNext);
    expect(network).not.toHaveBeenCalled();
    expect((await readAgentSettings(root)).selectedHarnessId).toBe("pi");
    const restored = await (await app.request(`/api/v1/sessions/${sessionId}`)).json();
    expect(restored.session.messages.some((message: { content: string }) => message.content === "Offline production caller answer")).toBe(true);
    expect(history.requests[0]!.selection!.selection.harnessId).toBe("codex");
  } finally {
    release(); await pending?.catch(() => undefined);
    if (sessionId) evictAgentCache(sessionId);
    await shutdownStudioServer(app); vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  }
});
