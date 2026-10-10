import { access, mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPiRuntimeContext } from "../runtime-context.js";
import { createPiAdapter } from "../adapter.js";
import { createOfficialPiSdkPort, type PiOfficialSessionObservation } from "../official-sdk.js";
import { officialModelFixture } from "../__fixtures__/official-model.js";

// Load the actual compatibility module in Node, where import.meta.resolve is available.
// This replaces only Vitest's module loader, without substituting credentials or SDK behavior.
vi.mock("../../../auth/pi-native-store-compat.js", async () => {
  const { createRequire } = await import("node:module");
  return createRequire(import.meta.url)("../../../auth/pi-native-store-compat.ts");
});

const dirs: string[] = [];
const credential = { type: "oauth", access: "fake-access", refresh: "fake-refresh", expires: Date.now() + 3_600_000 };
async function fixture(settings: unknown = {}, project?: unknown, auth: unknown = { openai: credential }) {
  const dir = await mkdtemp(join(tmpdir(), "inkos-pi-context-")); dirs.push(dir);
  const cwd = join(dir, "project"), agentDir = join(dir, "agent");
  await mkdir(join(cwd, ".pi"), { recursive: true }); await mkdir(agentDir);
  await writeFile(join(agentDir, "settings.json"), typeof settings === "string" ? settings : JSON.stringify(settings));
  if (project !== undefined) await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify(project));
  const authPath = join(agentDir, "auth.json"); if (auth !== null) await writeFile(authPath, JSON.stringify(auth));
  return { cwd, agentDir, authPath, projectTrusted: true };
}
let network: ReturnType<typeof vi.fn>;
beforeEach(() => { network = vi.fn(async () => { throw new Error("Network forbidden"); }); vi.stubGlobal("fetch", network); });
afterEach(async () => { expect(network).not.toHaveBeenCalled(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

describe("Pi runtime context with actual SDK and temporary settings/auth", () => {
  it("creates a real runtime, restricts catalog/auth capability to official openai OAuth", async () => {
    const context = await createPiRuntimeContext(await fixture());
    const runtime = context.modelRuntime as ModelRuntime;
    expect(runtime).toBeInstanceOf(ModelRuntime);
    expect(context.authCapability).toEqual({ providerId: "openai", type: "oauth", isSubscription: true });
    expect((await runtime.getAvailable()).every(model => model.provider === "openai")).toBe(true);
    expect(runtime.getProvider("openai")?.auth.oauth?.isSubscription).toBe(true);
    expect(runtime.getProvider("openai")?.auth.apiKey).toBeUndefined();
    expect(context.getModels().length).toBeGreaterThan(0);
    expect(context.getModels().every(model => model.provider === "openai" && model.type === "chat")).toBe(true);
    expect(() => context.resolveModel("fake")).toThrow("openai");
    await expect(runtime.getAuth("anthropic")).rejects.toThrow("openai");
  });
  it("observes actual global/project defaults, thinking levels, and native entry IDs", async () => {
    const options = await fixture({ defaultProvider: "openai", defaultModel: "gpt-5.4", defaultThinkingLevel: "low", cacheWarming: "idle", retry: { enabled: true } },
      { defaultModel: "gpt-5.2", modelThinkingLevels: { "openai/gpt-5.2": "high" } });
    const context = await createPiRuntimeContext(options);
    const modelEntries = vi.spyOn(SessionManager.prototype, "appendModelChange"), thinkingEntries = vi.spyOn(SessionManager.prototype, "appendThinkingLevelChange");
    const before = await readFile(options.authPath, "utf8"), settingsBefore = await readFile(join(options.agentDir, "settings.json"), "utf8");
    const observed = await context.observeDefaults();
    expect(observed).toMatchObject({ model: { provider: "openai", modelId: "gpt-5.2" }, thinkingLevel: "high", speed: null });
    expect(observed.sessionId).toBeTruthy(); expect(observed.changes.map(change => change.type)).toEqual(["model_change", "thinking_level_change"]);
    expect(observed.changes.every(change => typeof change.entryId === "string" && change.entryId.length > 0)).toBe(true);
    expect(observed.changes.map(change => change.entryId)).toEqual([modelEntries.mock.results[0].value, thinkingEntries.mock.results[0].value]);
    expect(observed.availableThinkingLevels).toContain("high"); expect(observed.activeToolNames).toEqual([]); expect(observed.resourceCounts).toEqual({ extensions: 0, skills: 0, prompts: 0, themes: 0, agentsFiles: 0 });
    expect(await readFile(options.authPath, "utf8")).toBe(before); expect(await readFile(join(options.agentDir, "settings.json"), "utf8")).toBe(settingsBefore);
    const untrusted = await createPiRuntimeContext({ ...options, projectTrusted: false });
    expect(await untrusted.observeDefaults()).toMatchObject({ model: { modelId: "gpt-5.4" }, thinkingLevel: "low" });
  });
  it("uses native default selection when settings omit a model", async () => {
    const context = await createPiRuntimeContext(await fixture({ defaultThinkingLevel: "low" }));
    const observed = await context.observeDefaults();
    expect(context.getModels().some(model => model.id === observed.model?.modelId)).toBe(true);
    expect(observed.thinkingLevel).toBe("low");
  });
  it("returns independent deeply frozen model snapshots", async () => {
    const options = await fixture(); const context = await createPiRuntimeContext(options);
    const model = context.getModels()[0], native = (context.modelRuntime as ModelRuntime).getModel("openai", model.id)!;
    const before = structuredClone(native);
    expect(() => { (model as { baseUrl: string }).baseUrl = "https://example.invalid"; }).toThrow(TypeError);
    expect(() => { model.cost.input = 999; }).toThrow(TypeError);
    const resolved = context.resolveModel(model.id);
    expect(resolved).not.toBe(native); expect(Object.isFrozen(resolved.cost)).toBe(true);
    expect(native).toEqual(before);
    const second = await createPiRuntimeContext(options); expect(second.resolveModel(model.id)).toEqual(before);
  });
  it("retains the verified observation paths and trust when the caller changes options", async () => {
    const options = await fixture({ defaultProvider: "openai", defaultModel: "gpt-5.4", defaultThinkingLevel: "low" },
      { defaultModel: "gpt-5.2", defaultThinkingLevel: "high" });
    options.projectTrusted = false; const context = await createPiRuntimeContext(options);
    options.cwd = "relative-other-project"; options.agentDir = "relative-other-agent"; options.projectTrusted = true;
    expect(await context.observeDefaults()).toMatchObject({ model: { modelId: "gpt-5.4" }, thinkingLevel: "low" });
  });
  it("cannot use an environment key after the OAuth entry disappears", async () => {
    const options = await fixture(); const context = await createPiRuntimeContext(options);
    await writeFile(options.authPath, "{}"); vi.stubEnv("OPENAI_API_KEY", "fake-environment-key");
    const runtime = context.modelRuntime as ModelRuntime;
    expect(await runtime.checkAuth("openai")).toBeUndefined(); expect(await runtime.getAuth("openai")).toBeUndefined();
    await expect(runtime.getAuth("openai", { apiKey: "fake-explicit-key" })).rejects.toThrow("API key overrides");
    await expect(context.observeDefaults()).rejects.toThrow("OAuth");
  });
  it.each([{ defaultProvider: "anthropic", defaultModel: "claude" }, { defaultProvider: "openai", defaultModel: "unknown" }])("fails clearly on disallowed saved default %j", async settings => {
    const context = await createPiRuntimeContext(await fixture(settings));
    await expect(context.observeDefaults()).rejects.toThrow("default model");
  });
  it("fails clearly on settings parse errors", async () => {
    const context = await createPiRuntimeContext(await fixture("{invalid"));
    await expect(context.observeDefaults()).rejects.toThrow("settings");
  });
  it("never creates missing auth or falls back to an environment key", async () => {
    const options = await fixture({}, undefined, null); vi.stubEnv("OPENAI_API_KEY", "fake-environment-key");
    await expect(createPiRuntimeContext(options)).rejects.toThrow("OAuth");
    await expect(access(options.authPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("observes expired fake OAuth without refreshing it", async () => {
    const options = await fixture({}, undefined, { openai: { ...credential, expires: 1 } });
    const before = await readFile(options.authPath, "utf8");
    const context = await createPiRuntimeContext(options); expect((await context.observeDefaults()).model?.provider).toBe("openai");
    expect(await readFile(options.authPath, "utf8")).toBe(before);
  });
  it("persists one fake OAuth refresh through the actual Models auth loop and native lock", async () => {
    const options = await fixture({}, undefined, { openai: { ...credential, expires: 1 } });
    const first = await createPiRuntimeContext(options), second = await createPiRuntimeContext(options);
    const refresh = vi.fn(async (current: typeof credential) => {
      await new Promise(resolve => setTimeout(resolve, 15));
      return { ...current, type: "oauth" as const, access: "fake-rotated-access", refresh: "fake-rotated-refresh", expires: Date.now() + 3_600_000 };
    });
    const runtimes = [first, second].map(context => context.modelRuntime as ModelRuntime);
    for (const runtime of runtimes) {
      const oauth = runtime.getProvider("openai")!.auth.oauth!;
      oauth.refresh = current => refresh(current as typeof credential);
      oauth.toAuth = async current => ({ apiKey: current.access });
    }
    const auth = await Promise.all(runtimes.map(runtime => runtime.getAuth("openai")));
    expect(refresh).toHaveBeenCalledOnce(); expect(auth.map(result => result?.auth.apiKey)).toEqual(["fake-rotated-access", "fake-rotated-access"]);
    expect(JSON.parse(await readFile(options.authPath, "utf8")).openai).toMatchObject({ access: "fake-rotated-access", refresh: "fake-rotated-refresh" });
  });
  it("accepts official lazy OAuth.toAuth transport apiKey but blocks explicit request API keys", async () => {
    const context = await createPiRuntimeContext(await fixture()); const runtime = context.modelRuntime as ModelRuntime;
    expect(await runtime.getAuth("openai")).toMatchObject({ source: "OAuth", auth: { apiKey: "fake-access" } });
    await expect(runtime.getAuth("openai", { apiKey: "request-api-key-sentinel" })).rejects.toThrow("API key overrides");
    const provider = runtime.getProvider("openai")!, request = vi.spyOn(provider, "streamSimple");
    const model = runtime.getModel("openai", context.getModels()[0].id)!;
    const response = await runtime.completeSimple(model, { messages: [] }, { apiKey: "request-api-key-sentinel" });
    expect(response.stopReason).toBe("error"); expect(response.errorMessage).toContain("API key overrides");
    expect(response.errorMessage).not.toContain("request-api-key-sentinel"); expect(request).not.toHaveBeenCalled();
  });
  it("rejects explicit speed and does not expose provider registration", async () => {
    const options = await fixture(); await expect(createPiRuntimeContext({ ...options, speed: "fast" })).rejects.toThrow("speed");
    const context = await createPiRuntimeContext(options);
    expect("registerProvider" in context).toBe(false);
    expect(context.getModels().every(model => model.provider === "openai")).toBe(true);
  });
  it("disposes the observed native session when the host hook fails", async () => {
    const context = await createPiRuntimeContext(await fixture()); const dispose = vi.spyOn(AgentSession.prototype, "dispose");
    await expect(context.observeDefaults(async () => { throw new Error("host hook failure"); })).rejects.toThrow("host hook failure");
    expect(dispose).toHaveBeenCalledOnce();
  });
});

describe("official SDK explicit session observation extension", () => {
  it("exposes native session and actual change entry IDs through a live read-only projection", async () => {
    const options = await fixture(); let observe!: () => PiOfficialSessionObservation;
    const host = { cwd: options.cwd, agentDir: options.agentDir, onSessionCreated: (read: () => PiOfficialSessionObservation) => { observe = read; } };
    const sdk = createOfficialPiSdkPort(host);
    host.cwd = "relative-caller-change"; host.agentDir = "relative-caller-change";
    host.onSessionCreated = () => { throw new Error("caller changed hook"); };
    const handle = await createPiAdapter({ provider: "openai", modelId: "fixture-model", thinkingLevel: "off", systemPrompt: "", initialMessages: [], tools: [] },
      { sdk, modelRuntime: officialModelFixture([]).runtime });
    try { const actual = observe(); expect(actual.sessionId).toBeTruthy(); expect(actual.changes.map(entry => entry.type)).toEqual(["model_change", "thinking_level_change"]); expect(Object.isFrozen(actual.changes)).toBe(true); }
    finally { await handle.dispose(); }
  });
  it("disposes a newly created native run session when its observation hook fails", async () => {
    const options = await fixture(); const dispose = vi.spyOn(AgentSession.prototype, "dispose");
    const sdk = createOfficialPiSdkPort({ cwd: options.cwd, agentDir: options.agentDir, onSessionCreated: async () => { throw new Error("host hook failure"); } });
    await expect(createPiAdapter({ provider: "openai", modelId: "fixture-model", thinkingLevel: "off", systemPrompt: "", initialMessages: [], tools: [] },
      { sdk, modelRuntime: officialModelFixture([]).runtime })).rejects.toThrow();
    expect(dispose).toHaveBeenCalledOnce();
  });
});
