import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { findPackageJSON } from "node:module";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCodexAccountService, readAgentSettings, updateAgentSettings, withRuntimeExecution } from "@actalk/inkos-core";
import { createStudioServer, shutdownStudioServer } from "./server.js";
import { catalogMatchesState, type HarnessState } from "../shared/agent-configuration.js";

// Vitest 3 lacks import.meta.resolve. Forward the unchanged source loader rather
// than replacing native storage, observations, account services or catalogs.
vi.mock("../../../core/src/runtime/auth/pi-native-store-compat.js", async () => {
  const { createRequire } = await import("node:module");
  return createRequire(import.meta.url)("../../../core/src/runtime/auth/pi-native-store-compat.ts");
});

// The SDK is Core's declared dependency. Observe that same installed module
// without adding an undeclared direct dependency to Studio.
const sdkManifest = findPackageJSON("@earendil-works/pi-coding-agent", new URL("../../../core/src/index.ts", import.meta.url));
if (!sdkManifest) throw new Error("Core's installed Pi SDK must be available for this integration test");
const { ModelRuntime, SettingsManager } = await import(pathToFileURL(join(dirname(sdkManifest), "dist/index.js")).href);

const native = { model: null, effort: null, speed: null };
const prefix = "/api/v1/agent-configuration";
const oauth = (suffix = "first") => ({ type: "oauth", access: `synthetic-access-${suffix}`, refresh: `synthetic-refresh-${suffix}`, expires: Date.now() + 3_600_000 });
async function disk(root: string): Promise<Record<string, string | null>> {
  const value: Record<string, string | null> = {};
  async function walk(path: string, prefix = "") {
    for (const item of await readdir(path, { withFileTypes: true })) {
      const name = prefix + item.name;
      if (item.isDirectory()) { value[name + "/"] = null; await walk(join(path, item.name), name + "/"); }
      else value[name] = (await readFile(join(path, item.name))).toString("base64");
    }
  }
  await walk(root); return value;
}

describe("production Pi GET maps only public local evidence", () => {
  let root: string, project: string, agent: string, app: ReturnType<typeof createStudioServer>;
  let factory: ReturnType<typeof vi.fn>, network: ReturnType<typeof vi.fn>;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-studio-pi-observation-")); project = join(root, "project"); agent = join(root, "agent");
    await mkdir(project); vi.stubEnv("PI_CODING_AGENT_DIR", agent);
    factory = vi.fn(async () => { throw new Error("Pi must not create a Codex peer"); });
    network = vi.fn(async () => { throw new Error("GET must not resolve OAuth or call a model"); }); vi.stubGlobal("fetch", network);
    const service = createCodexAccountService({ projectDir: project, clientFactory: factory });
    app = createStudioServer({} as never, project, { codexAccountService: service });
  });
  afterEach(async () => {
    expect(factory).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
    await shutdownStudioServer(app); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true });
  });
  async function credentials(auth: unknown = { openai: oauth() }, settings: unknown = { defaultProvider: "openai", defaultModel: "gpt-5.4", defaultThinkingLevel: "low" }) {
    await mkdir(agent); await writeFile(join(agent, "auth.json"), typeof auth === "string" ? auth : JSON.stringify(auth));
    await writeFile(join(agent, "settings.json"), typeof settings === "string" ? settings : JSON.stringify(settings));
  }
  async function state() {
    const before = await disk(root);
    const getAuth = vi.spyOn(ModelRuntime.prototype, "getAuth");
    const fileSettings = vi.spyOn(SettingsManager, "create");
    const { loadPiNativeAuthStorage } = await import("../../../core/src/runtime/auth/pi-native-store-compat.js");
    const { AuthStorage } = await loadPiNativeAuthStorage();
    const create = vi.spyOn(AuthStorage, "create"), modify = vi.spyOn(AuthStorage.prototype, "modify"), remove = vi.spyOn(AuthStorage.prototype, "delete");
    const response = await app.request(`${prefix}/harnesses/pi/state`);
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    const value: HarnessState = (await response.json()).state;
    for (const operation of [getAuth, fileSettings, create, modify, remove]) { expect(operation).not.toHaveBeenCalled(); operation.mockRestore(); }
    expect(await disk(root)).toEqual(before);
    expect(value.account).toBeNull(); expect(value.execution).toBeNull();
    for (const privateValue of [root, "synthetic-access", "synthetic-refresh", "credentialRef", "clientId", "email", "subject"]) expect(JSON.stringify(value)).not.toContain(privateValue);
    return value;
  }
  it("reports installed but missing local OAuth without creating the native directory", async () => {
    const observed = await state();
    expect(observed).toMatchObject({ harnessId: "pi", installation: "installed", localAuthentication: "missing", catalog: null });
    expect(observed.scope).toMatchObject({ harnessId: "pi", ownerGeneration: null });
  });
  it("maps the actual cold native catalog and defaults with null owner generation and no invented speed", async () => {
    await credentials(); const observed = await state();
    expect(observed).toMatchObject({ localAuthentication: "oauth-present", installation: "installed" });
    expect(observed.scope).toMatchObject({ harnessId: "pi", ownerGeneration: null, adapterVersion: "inkos-pi-1.1.0" });
    expect(catalogMatchesState(observed)).toBe(true);
    expect(observed.catalog!.value.nativeDefaults).toEqual({ modelId: "gpt-5.4", effort: "low", serviceTier: null });
    expect(Object.values(observed.catalog!.speedSupport).every(value => value === "unsupported")).toBe(true);
    expect(observed.catalog!.value.models.every(model => model.efforts.length > 0 && model.serviceTiers.length === 0)).toBe(true);
  });
  it("keeps locally observed OAuth when official native catalog parsing fails", async () => {
    await credentials(undefined, "{invalid settings");
    expect(await state()).toMatchObject({ localAuthentication: "oauth-present", catalog: null, execution: null });
  });
  it.each(["{invalid auth", { openai: { type: "api_key", key: "synthetic-key" } }, { openai: { type: "oauth", access: "synthetic-access" } }])("keeps invalid or non-OAuth native auth unverified (%j)", async auth => {
    await credentials(auth);
    expect(await state()).toMatchObject({ localAuthentication: "unknown", catalog: null });
  });
  it("projects a real admitted owner generation but rejects replaced native OAuth without settling it", async () => {
    await credentials(); await updateAgentSettings(project, { selectedHarnessId: "pi", harnessPreferences: { pi: native } }, { expectedRevision: 0 });
    // Empty public admission creates the real owner. It is not an inference test.
    await withRuntimeExecution(project, async () => undefined);
    const warm = await state(); expect(warm.scope!.ownerGeneration).toBeGreaterThanOrEqual(0); expect(catalogMatchesState(warm)).toBe(true);
    await writeFile(join(agent, "auth.json"), JSON.stringify({ openai: oauth("replacement") }));
    const replaced = await state();
    expect(replaced).toMatchObject({ localAuthentication: "unknown", catalog: null });
    expect(replaced.scope!.ownerGeneration).toBeNull(); expect((await readAgentSettings(project)).selectedHarnessId).toBe("pi");
  });
  it("accepts real scoped model/effort CAS and rejects unsupported speed without changing the saved Pi selection", async () => {
    await credentials(); const observed = await state();
    const model = observed.catalog!.value.models.find(item => item.modelId === "gpt-5.4")!;
    const put = (expectedRevision: number, preferences: unknown) => app.request(`${prefix}/settings`, { method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedRevision, patch: { selectedHarnessId: "pi", harnessPreferences: { pi: preferences } } }) });
    const saved = await put(0, { model: model.modelId, effort: model.efforts[0], speed: null }); expect(saved.status).toBe(200);
    const settings = (await saved.json()).settings;
    const blocked = await put(settings.revision, { model: model.modelId, effort: model.efforts[0], speed: "fast" }); expect(blocked.status).toBe(422);
    expect(await readAgentSettings(project)).toEqual(settings);
    const conflict = await put(0, native); expect(conflict.status).toBe(409); expect(await readAgentSettings(project)).toEqual(settings);
  });
});
