import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { AGENT_CONFIG_FILE, readAgentSettings, type CodexAccountService } from "@actalk/inkos-core";
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
  it("keeps an absent observation dependency unavailable and leaves Pi authentication mutations unmounted", async () => {
    const server = app();
    const state = (await (await server.request("/api/v1/agent-configuration/harnesses/pi/state")).json()).state;
    expect(state).toMatchObject({ harnessId: "pi", availability: "unavailable", scope: null, catalog: null, execution: null, account: null });
    for (const action of ["bind", "login/reserve", "login", "login/close", "login/cancel", "logout"]) {
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

describe("offline trusted sign-in attempt service contract routes (Core integration pending)", () => {
  const path = "/api/v1/agent-configuration/harnesses/codex";
  const post = (value: unknown = {}) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
  const fixture = () => {
    const account = {
      reserveDeviceLoginAttempt: vi.fn(() => ({ attemptHandle: "fixture-attempt", expiresAt: Date.now() + 60_000, secret: "PRIVATE" })),
      startDeviceLogin: vi.fn(async (_options: { attemptHandle: string }) => ({ type: "chatgptDeviceCode", loginId: "fixture-login", userCode: "FIXTURE-CODE", verificationUrl: "https://auth.openai.com/codex/device", secret: "PRIVATE" })),
      closeDeviceLoginAttempt: vi.fn(async (handle: string) => ({ attemptHandle: handle, state: "closed", cleanup: "not-started", secret: "PRIVATE" })),
      getRuntimeClient: vi.fn(), readAccount: vi.fn(), cancelLogin: vi.fn(), logout: vi.fn(),
    };
    return { account, server: app({ accountService: account as unknown as CodexAccountService }) };
  };
  it("reserves in memory and projects only the opaque handle and expiry without touching account/peer/auth methods", async () => {
    const { account, server } = fixture();
    const response = await server.request(`${path}/login/reserve`, post());
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(Object.keys(body.reservation).sort()).toEqual(["attemptHandle", "expiresAt"]);
    expect(body.reservation).toMatchObject({ attemptHandle: "fixture-attempt", expiresAt: expect.any(Number) });
    expect(account.reserveDeviceLoginAttempt).toHaveBeenCalledOnce();
    for (const fn of [account.startDeviceLogin, account.closeDeviceLoginAttempt, account.getRuntimeClient, account.readAccount, account.cancelLogin, account.logout]) expect(fn).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
  });
  it("starts only the exact handle on the trusted service and exposes the validated device-code DTO", async () => {
    const { account, server } = fixture();
    const response = await server.request(`${path}/login`, post({ attemptHandle: "fixture-attempt" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ login: { loginId: "fixture-login", status: "pending", userCode: "FIXTURE-CODE", verificationUrl: "https://auth.openai.com/codex/device" } });
    expect(account.startDeviceLogin).toHaveBeenCalledWith({ attemptHandle: "fixture-attempt" });
    expect(account.reserveDeviceLoginAttempt).not.toHaveBeenCalled(); expect(account.readAccount).not.toHaveBeenCalled();
  });
  it.each(["closed", "already-terminal", "unknown-or-expired", "superseded"] as const)("projects the exact close state %s without cancel-current/logout fallback", async state => {
    const { account, server } = fixture();
    for (const cleanup of ["not-started", "cancel-acknowledged", "unconfirmed", "not-applicable"] as const) {
      account.closeDeviceLoginAttempt.mockResolvedValueOnce({ attemptHandle: "fixture-attempt", state, cleanup, secret: "PRIVATE" });
      const response = await server.request(`${path}/login/close`, post({ attemptHandle: "fixture-attempt" }));
      expect(response.status).toBe(200); expect(await response.json()).toEqual({ result: { attemptHandle: "fixture-attempt", state, cleanup } });
    }
    expect(account.closeDeviceLoginAttempt).toHaveBeenCalledTimes(4);
    expect(account.closeDeviceLoginAttempt).toHaveBeenCalledWith("fixture-attempt");
    for (const fn of [account.startDeviceLogin, account.readAccount, account.cancelLogin, account.logout, account.getRuntimeClient]) expect(fn).not.toHaveBeenCalled();
  });
  it.each([
    { state: "success" }, { cleanup: "cancelled" }, { attemptHandle: "another-attempt" },
    { state: null }, { cleanup: null }, { state: { toString: (): string => "closed" } },
  ])("rejects malformed close output rather than claiming cleanup: %j", async change => {
    const { account, server } = fixture();
    account.closeDeviceLoginAttempt.mockResolvedValueOnce({ attemptHandle: "fixture-attempt", state: "closed", cleanup: "not-started", ...change } as never);
    const response = await server.request(`${path}/login/close`, post({ attemptHandle: "fixture-attempt" }));
    expect(response.status).toBe(502); expect(await response.text()).not.toContain("PRIVATE");
    expect(account.cancelLogin).not.toHaveBeenCalled(); expect(account.logout).not.toHaveBeenCalled();
  });
  it.each([{}, { attemptHandle: "" }, { attemptHandle: " padded " }, { attemptHandle: "x".repeat(257) }, { attemptHandle: 4 }, { loginId: "fixture-login" },
    { attemptHandle: "fixture-attempt", loginId: "fixture-login" }, { attemptHandle: "fixture-attempt", authContextRef: "browser" }])("strictly rejects invalid start/close bodies %j", async body => {
    const { account, server } = fixture();
    expect((await server.request(`${path}/login`, post(body))).status).toBe(400);
    expect((await server.request(`${path}/login/close`, post(body))).status).toBe(400);
    expect(account.startDeviceLogin).not.toHaveBeenCalled(); expect(account.closeDeviceLoginAttempt).not.toHaveBeenCalled();
  });
  it("rejects reserve authority fields and never remounts login-ID cancel as Close", async () => {
    const { account, server } = fixture();
    expect((await server.request(`${path}/login/reserve`, post({ attemptHandle: "browser" }))).status).toBe(400);
    expect((await server.request(`${path}/login/cancel`, post({ loginId: "fixture-login" }))).status).toBe(404);
    expect(account.reserveDeviceLoginAttempt).not.toHaveBeenCalled(); expect(account.cancelLogin).not.toHaveBeenCalled();
  });
  it.each([{ attemptHandle: "", expiresAt: Date.now() + 60_000 }, { attemptHandle: "fixture-attempt", expiresAt: 0 },
    { attemptHandle: "fixture-attempt", expiresAt: "later" }])("rejects invalid reservation outputs %j", async reservation => {
    const { account, server } = fixture(); account.reserveDeviceLoginAttempt.mockReturnValueOnce(reservation as never);
    expect((await server.request(`${path}/login/reserve`, post())).status).toBe(502);
    expect(account.startDeviceLogin).not.toHaveBeenCalled();
  });
  it("does not treat the old Core start/cancel/logout methods as a safe attempt contract", async () => {
    const { account } = fixture();
    const legacy = { startDeviceLogin: account.startDeviceLogin, cancelLogin: account.cancelLogin, logout: account.logout, readAccount: account.readAccount };
    const server = app({ accountService: legacy as unknown as CodexAccountService });
    for (const [action, body] of [["login/reserve", {}], ["login", { attemptHandle: "fixture-attempt" }], ["login/close", { attemptHandle: "fixture-attempt" }]] as const) {
      const response = await server.request(`${path}/${action}`, post(body)); expect(response.status).toBe(503);
      expect((await response.json()).error.code).toBe("AGENT_CONFIGURATION_ATTEMPT_CONTRACT_UNAVAILABLE");
    }
    for (const fn of Object.values(legacy)) expect(fn).not.toHaveBeenCalled();
  });
});
