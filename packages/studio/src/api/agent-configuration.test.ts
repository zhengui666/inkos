import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { AGENT_CONFIG_FILE, readAgentSettings } from "@actalk/inkos-core";
import { createAgentConfigurationRoutes, type AgentConfigurationRouteDependencies } from "./agent-configuration.js";
import type { HarnessState } from "../shared/agent-configuration.js";

const native = { model: null, effort: null, speed: null };
const scope = { harnessId: "pi" as const, authContextRef: "actual-owner-context", ownerGeneration: 7, adapterVersion: "1", catalogVersion: "3" };
const observed: HarnessState = { harnessId: "pi", availability: "available", scope, installation: "installed", account: { type: "chatgpt" }, execution: null,
  catalog: { scope, speedSupport: { "native-model": "backend" }, value: { harnessId: "pi", adapterVersion: "1", supportsChatGptOauth: true, supportsTools: true, supportsStreaming: true,
    models: [{ modelId: "native-model", efforts: ["high"], serviceTiers: ["fast"], defaultEffort: "high", defaultServiceTier: null }],
    nativeDefaults: { modelId: "native-model", effort: "high", serviceTier: null } } } };
let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "inkos-studio-configuration-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
function app(dependencies?: AgentConfigurationRouteDependencies) { return new Hono().route("/api/v1/agent-configuration", createAgentConfigurationRoutes(root, dependencies)); }
function put(server: Hono, body: unknown) {
  return server.request("/api/v1/agent-configuration/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
const update = (expectedRevision = 0) => ({ expectedRevision, patch: { selectedHarnessId: "pi", harnessPreferences: { pi: native } } });

describe("real configuration storage routes", () => {
  it("GET on a fresh project creates no config directory", async () => {
    expect((await app().request("/api/v1/agent-configuration/settings")).status).toBe(200);
    expect(await readdir(root)).toEqual([]);
  });
  it("GET maps legacy settings without creating or migrating files", async () => {
    await mkdir(join(root, ".inkos"));
    const legacy = '{"model":null,"reasoningEffort":"high","serviceTier":"priority"}';
    await writeFile(join(root, ".inkos/codex-config.json"), legacy);
    const response = await app().request("/api/v1/agent-configuration/settings");
    expect(response.status).toBe(200);
    expect((await response.json()).settings.harnessPreferences.codex).toEqual({ model: null, effort: "high", speed: "priority" });
    expect(await readdir(join(root, ".inkos"))).toEqual(["codex-config.json"]);
    expect(await readFile(join(root, ".inkos/codex-config.json"), "utf8")).toBe(legacy);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("does not fall back from a bad new file to a valid legacy file", async () => {
    await mkdir(join(root, ".inkos"));
    await writeFile(join(root, ".inkos", AGENT_CONFIG_FILE), "bad-new-file");
    await writeFile(join(root, ".inkos/codex-config.json"), '{"model":"legacy-model"}');
    const response = await app().request("/api/v1/agent-configuration/settings");
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain("legacy-model");
    expect(await readFile(join(root, ".inkos", AGENT_CONFIG_FILE), "utf8")).toBe("bad-new-file");
  });
  it("performs real CAS: concurrent saves with one expected revision produce one success and one conflict", async () => {
    const server = app();
    const responses = await Promise.all([put(server, update()), put(server, update())]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
    const stored = await readAgentSettings(root);
    expect(stored.revision).toBe(1);
    expect(stored.selectedHarnessId).toBe("pi");
    expect(stored.harnessPreferences.pi).toEqual(native);
    expect(JSON.parse(await readFile(join(root, ".inkos", AGENT_CONFIG_FILE), "utf8"))).toEqual(stored);
  });
  it("roundtrips all three nulls without any directory or live observation", async () => {
    const server = app({ observeHarness: async () => { throw new Error("no owner"); } });
    expect((await put(server, update())).status).toBe(200);
    expect((await (await server.request("/api/v1/agent-configuration/settings")).json()).settings.harnessPreferences.pi).toEqual(native);
  });
  it.each(["modelConnectionRef", "provider", "authMethod", "admission", "catalog", "ready", "authGeneration", "effective"])("rejects %s at the request and patch boundaries", async field => {
    const server = app();
    expect((await put(server, { ...update(), [field]: "forbidden" })).status).toBe(400);
    expect((await put(server, { ...update(), patch: { ...update().patch, [field]: "forbidden" } })).status).toBe(400);
    expect((await readAgentSettings(root)).revision).toBe(0);
  });
  it("rejects nested auth fields and invalid revisions", async () => {
    expect((await put(app(), { expectedRevision: -1, patch: update().patch })).status).toBe(400);
    expect((await put(app(), { expectedRevision: 0, patch: { harnessPreferences: { pi: { ...native, provider: "chatgpt" } } } })).status).toBe(400);
  });
  it("rejects explicit overrides without evidence while retaining stored values", async () => {
    const response = await put(app(), { expectedRevision: 0, patch: { harnessPreferences: { pi: { model: "native-model" } } } });
    expect(response.status).toBe(422);
    expect((await readAgentSettings(root)).revision).toBe(0);
    expect((await readAgentSettings(root)).harnessPreferences.pi).toEqual(native);
  });
  it("validates native-model overrides with genuine server-side catalog provenance", async () => {
    const server = app({ observeHarness: async () => observed });
    const response = await put(server, { expectedRevision: 0, patch: { selectedHarnessId: "pi", harnessPreferences: { pi: { model: null, effort: "high", speed: "fast" } } } });
    expect(response.status).toBe(200);
    expect((await readAgentSettings(root)).harnessPreferences.pi).toEqual({ model: null, effort: "high", speed: "fast" });
    expect((await put(server, { expectedRevision: 1, patch: { harnessPreferences: { pi: { effort: "unsupported" } } } })).status).toBe(422);
    expect((await readAgentSettings(root)).revision).toBe(1);
  });
  it.each(["context", "generation", "adapter", "catalog-version", "speed-unknown"])("rejects mismatched or missing %s evidence", async mismatch => {
    const catalog = observed.catalog!;
    const bad: HarnessState = { ...observed, catalog: { ...catalog,
      scope: { ...scope, ...(mismatch === "context" ? { authContextRef: "elsewhere" } : mismatch === "generation" ? { ownerGeneration: 8 } : mismatch === "adapter" ? { adapterVersion: "2" } : mismatch === "catalog-version" ? { catalogVersion: "4" } : {}) },
      speedSupport: mismatch === "speed-unknown" ? {} : catalog.speedSupport } };
    const response = await put(app({ observeHarness: async () => bad }), { expectedRevision: 0, patch: { harnessPreferences: { pi: { model: null, effort: "high", speed: "fast" } } } });
    expect(response.status).toBe(422);
    expect((await readAgentSettings(root)).revision).toBe(0);
  });
  it("keeps Pi unavailable and leaves authentication mutations unmounted", async () => {
    const server = app();
    const state = (await (await server.request("/api/v1/agent-configuration/harnesses/pi/state")).json()).state;
    expect(state).toMatchObject({ harnessId: "pi", availability: "unavailable", scope: null, catalog: null, execution: null, account: null });
    for (const action of ["bind", "login", "login/cancel", "logout"]) {
      expect((await server.request(`/api/v1/agent-configuration/harnesses/pi/${action}`, { method: "POST", headers: { "Content-Type": "application/json" } })).status).toBe(404);
    }
  });
  it("projects only public observation fields and drops an unobserved account type", async () => {
    const internal = { ...observed, privateOwnerField: "must-not-leak", account: { type: "chatgpt" as const, label: "public", token: "must-not-leak" } };
    const response = await app({ observeHarness: async () => internal }).request("/api/v1/agent-configuration/harnesses/pi/state");
    const body = await response.json();
    expect(body.state.account).toEqual({ type: "chatgpt", label: "public" });
    expect(JSON.stringify(body)).not.toContain("must-not-leak");
  });
  it("rejects cross-site writes and non-JSON writes", async () => {
    expect((await app().request("/api/v1/agent-configuration/settings", { method: "PUT" })).status).toBe(415);
    expect((await app().request("/api/v1/agent-configuration/settings", { headers: { "Sec-Fetch-Site": "cross-site" } })).status).toBe(403);
  });
});
