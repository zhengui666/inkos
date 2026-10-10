import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CodexAuthenticationOwner, createCodexAccountService, readAgentSettings, updateAgentSettings,
  type CodexClient, type CodexAccountService,
} from "@actalk/inkos-core";
import { createStudioServer, shutdownStudioServer } from "./server.js";
import { createAgentConfigurationController, createAgentConfigurationTransport } from "../hooks/agent-configuration-controller";
import { adaptAgentConfiguration, toSelection } from "../pages/agent-configuration-adapter";

// Protocol fixture only: no native process, OAuth, provider credential or inference.
class ProtocolPeer implements CodexClient {
  readonly codexHome: string;
  closed = false;
  closeCount = 0;
  retirementFinished = false;
  authenticated = true;
  cancelResponse: unknown = { status: "canceled" };
  nativeLoginResponse?: unknown;
  readonly calls: Array<{ method: string; params: unknown }> = [];
  beforeRequest?: (method: string) => Promise<void>;
  beforeClose?: () => Promise<void>;
  private nextLogin = 0;
  private readonly notifications = new Set<(method: string, params: unknown) => void>();
  private readonly closes = new Set<() => void>();
  constructor(readonly cwd: string) { this.codexHome = join(cwd, ".inkos", "codex", "home"); }
  async request<T = unknown>(method: string, params: unknown = {}, options?: { signal?: AbortSignal }): Promise<T> {
    this.calls.push({ method, params });
    options?.signal?.throwIfAborted();
    await this.beforeRequest?.(method);
    options?.signal?.throwIfAborted();
    if (this.closed) throw new Error("synthetic-private-RPC-error");
    let result: unknown;
    switch (method) {
      case "account/read":
        result = { account: this.authenticated ? { type: "chatgpt", email: "private@example.test", planType: "fixture" } : null,
          requiresOpenaiAuth: true, accessToken: "synthetic-private-token", workspaceRouting: { chatgptAccountId: "synthetic-private-account" } };
        break;
      case "model/list":
        result = { data: ["gpt-6.1-sol", "other-model"].map((model, index) => ({ id: model, model, isDefault: index === 0,
          defaultReasoningEffort: "ultra", defaultServiceTier: "priority",
          supportedReasoningEfforts: ["low", "high", "ultra"].map(reasoningEffort => ({ reasoningEffort })),
          serviceTiers: [{ id: "fast" }, { id: "priority" }], accessToken: "synthetic-private-token" })), nextCursor: null };
        break;
      case "config/read": result = { config: {}, privateRpc: "synthetic-private-token" }; break;
      case "account/login/start":
        result = this.nativeLoginResponse ?? { type: "chatgptDeviceCode", loginId: `login-${++this.nextLogin}`,
          verificationUrl: "https://auth.openai.com/codex/device", userCode: "FIXTURE-CODE", accessToken: "synthetic-private-token" };
        break;
      case "account/login/cancel": result = this.cancelResponse; break;
      case "account/logout": this.authenticated = false; result = {}; break;
      default: throw new Error(`Unexpected protocol fixture method: ${method}`);
    }
    return result as T;
  }
  onNotification(listener: (method: string, params: unknown) => void) { this.notifications.add(listener); return () => { this.notifications.delete(listener); }; }
  onRequest() { return () => {}; }
  onClose(listener: () => void) { this.closes.add(listener); return () => { this.closes.delete(listener); }; }
  notify(method: string, params: unknown) { for (const listener of this.notifications) listener(method, params); }
  disconnect() { if (!this.closed) { this.closed = true; for (const listener of this.closes) listener(); } }
  async close() { this.closeCount++; this.disconnect(); await this.beforeClose?.(); this.retirementFinished = true; }
  count(method: string) { return this.calls.filter(call => call.method === method).length; }
}

const prefix = "/api/v1/agent-configuration";
const native = { model: null, effort: null, speed: null };
const post = (body: unknown = {}) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const put = (body: unknown) => ({ ...post(body), method: "PUT" });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

describe("mounted Studio routes with real Core account/attempt/SQLite owner and offline protocol peer", () => {
  let root: string;
  let peer: ProtocolPeer;
  let service: CodexAccountService;
  let factory: ReturnType<typeof vi.fn<(projectDir: string) => Promise<CodexClient>>>;
  let app: ReturnType<typeof createStudioServer>;
  const additionalApps: ReturnType<typeof createStudioServer>[] = [];
  const additionalRoots: string[] = [];
  const controllers: ReturnType<typeof createAgentConfigurationController>[] = [];
  beforeEach(async () => {
    vi.stubEnv("INKOS_CODEX_HOME", ""); delete process.env.INKOS_CODEX_HOME;
    vi.stubEnv("INKOS_CODEX_STATE_ROOT", ""); delete process.env.INKOS_CODEX_STATE_ROOT;
    root = await mkdtemp(join(tmpdir(), "inkos-studio-real-bridge-"));
    await mkdir(join(root, ".inkos", "codex", "home"), { recursive: true, mode: 0o700 });
    peer = new ProtocolPeer(root);
    factory = vi.fn(async (_projectDir: string): Promise<CodexClient> => { if (peer.closed) peer = new ProtocolPeer(root); return peer; });
    service = createCodexAccountService({ projectDir: root, clientFactory: factory });
    app = createStudioServer({} as never, root, { codexAccountService: service });
  });
  afterEach(async () => {
    for (const controller of controllers.splice(0)) controller.dispose();
    await shutdownStudioServer(app);
    await Promise.all(additionalApps.splice(0).map(server => shutdownStudioServer(server)));
    await rm(root, { recursive: true, force: true });
    await Promise.all(additionalRoots.splice(0).map(path => rm(path, { recursive: true, force: true })));
    vi.unstubAllEnvs();
  });
  const state = async () => {
    const response = await app.request(`${prefix}/harnesses/codex/state`);
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    return (await response.json()).state;
  };
  const owner = () => new CodexAuthenticationOwner(peer);
  const bind = (expectedRevision = 0) => app.request(`${prefix}/harnesses/codex/bind`, post({ expectedRevision }));
  const reserveAttempt = async () => {
    const response = await app.request(`${prefix}/harnesses/codex/login/reserve`, post());
    expect(response.status).toBe(200); return (await response.json()).reservation.attemptHandle as string;
  };
  const startAttempt = async (handle?: string) => app.request(`${prefix}/harnesses/codex/login`, post({ attemptHandle: handle ?? await reserveAttempt() }));
  const closeAttempt = (handle: string) => app.request(`${prefix}/harnesses/codex/login/close`, post({ attemptHandle: handle }));
  const ui = () => {
    const httpCalls: Array<{ method: string; path: string; status: number }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const request = input instanceof Request ? new Request(input, init) : new Request(new URL(String(input), "http://localhost"), init);
      const response = await app.request(request);
      httpCalls.push({ method: request.method, path: new URL(request.url).pathname, status: response.status });
      return response;
    };
    const controller = createAgentConfigurationController(createAgentConfigurationTransport(fetchImpl)); controllers.push(controller);
    const edit = (model: string | null) => controller.edit({ action: "choose-option", target: controller.getSnapshot().target, field: "model", choiceKey: model });
    const save = () => controller.save({ action: "save-defaults", target: controller.getSnapshot().target, selection: toSelection(controller.getSnapshot().draft) });
    const view = () => { const snapshot = controller.getSnapshot(); return adaptAgentConfiguration({ ...snapshot,
      saved: snapshot.baseline?.harnessPreferences[snapshot.target.harness] ?? null, submitted: snapshot.submitted?.preferences }); };
    return { controller, httpCalls, edit, save, view };
  };

  it("mounts the production GET settings without a peer, login, configuration write or owner admission", async () => {
    const response = await app.request(`${prefix}/settings`);
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await response.json()).settings).toMatchObject({ revision: 0, selectedHarnessId: "codex", modelConnectionRef: null });
    expect(factory).not.toHaveBeenCalled(); expect(peer.calls).toEqual([]);
    expect(existsSync(join(root, ".inkos", "agent-config.json"))).toBe(false);
    expect(existsSync(join(peer.codexHome, "inkos-connection.json"))).toBe(false);
  });

  it("uses the actual public attempt contract and rejects a foreign handle without borrowing a peer", async () => {
    const handle = await reserveAttempt(); expect(handle).toMatch(/^[0-9a-f-]{36}$/);
    expect((await startAttempt("foreign-attempt")).status).toBe(503);
    expect(await (await closeAttempt("foreign-attempt")).json()).toEqual({ result: {
      attemptHandle: "foreign-attempt", state: "unknown-or-expired", cleanup: "not-applicable",
    } });
    expect(factory).not.toHaveBeenCalled(); expect(peer.calls).toEqual([]); expect(owner().snapshot()).toBeUndefined();
    expect((await readAgentSettings(root)).modelConnectionRef).toBeNull();
  });

  it("real reserve and cached Close before start create no peer, owner operation or OAuth request", async () => {
    const handle = await reserveAttempt();
    expect(factory).not.toHaveBeenCalled(); expect(owner().snapshot()).toBeUndefined();
    expect(await (await closeAttempt(handle)).json()).toEqual({ result: { attemptHandle: handle, state: "closed", cleanup: "not-started" } });
    expect(await (await closeAttempt(handle)).json()).toEqual({ result: { attemptHandle: handle, state: "closed", cleanup: "not-started" } });
    expect((await startAttempt(handle)).status).toBe(503);
    expect(factory).not.toHaveBeenCalled(); expect(peer.calls).toEqual([]); expect(owner().snapshot()).toBeUndefined();
  });

  it("fences an aborted held start immediately and shares exact-ID Close settlement after the native ID arrives", async () => {
    peer.authenticated = false; const handle = await reserveAttempt();
    const entered = deferred<void>(); const release = deferred<void>(); const abort = new AbortController();
    peer.beforeRequest = async method => { if (method === "account/login/start") { entered.resolve(); await release.promise; } };
    const pending = app.request(new Request(`http://localhost${prefix}/harnesses/codex/login`, { ...post({ attemptHandle: handle }), signal: abort.signal }));
    await entered.promise; const before = owner().snapshot()!; abort.abort();
    const closed = closeAttempt(handle), repeated = closeAttempt(handle);
    try {
      await vi.waitFor(() => expect(owner().snapshot()).toMatchObject({ localState: "unknown", operationId: null, authGeneration: before.authGeneration }));
      expect(peer.count("account/login/cancel")).toBe(0);
    } finally { release.resolve(); }
    expect((await pending).status).toBe(503);
    const receipt = { result: { attemptHandle: handle, state: "closed", cleanup: "cancel-acknowledged" } };
    expect(await (await closed).json()).toEqual(receipt); expect(await (await repeated).json()).toEqual(receipt);
    expect(await (await closeAttempt(handle)).json()).toEqual(receipt);
    expect(peer.calls.filter(call => call.method === "account/login/cancel").map(call => call.params)).toEqual([{ loginId: "login-1" }]);
    expect(owner().snapshot()).toMatchObject({ localState: "unknown", operationId: null, authGeneration: before.authGeneration });
    expect((await state()).connection.login.status).toBe("cancelled");
    expect(peer.count("account/login/start")).toBe(1); expect((await readAgentSettings(root)).modelConnectionRef).toBeNull();
  });

  it("observes the actual peer catalogue without binding, creating an owner, exposing identity or claiming inference", async () => {
    const observed = await state();
    expect(observed).toMatchObject({ harnessId: "codex", availability: "available", installation: "installed",
      scope: { ownerGeneration: null }, account: { type: "chatgpt", label: "ChatGPT · fixture" },
      connection: { phase: "signed-in", login: null, connectionRef: null }, execution: null });
    expect(observed.catalog.value.nativeDefaults).toMatchObject({ modelId: "gpt-6.1-sol", effort: "ultra", serviceTier: "priority" });
    expect(observed.catalog.scope).toEqual(observed.scope);
    expect(JSON.stringify(observed)).not.toMatch(/private@example|synthetic-private|codexHome|identityRef|workspaceRouting|raw|request/);
    expect(peer.calls.map(call => call.method).sort()).toEqual(["account/read", "account/read", "account/read", "account/read", "config/read", "model/list"]);
    expect(owner().snapshot()).toBeUndefined(); expect((await readAgentSettings(root)).modelConnectionRef).toBeNull();
    expect(peer.closeCount).toBe(0); expect(factory).toHaveBeenCalledTimes(1);
  });

  it("shares one peer between old account routes, new observation and actual CAS binding", async () => {
    expect((await app.request("/api/v1/codex/account")).status).toBe(200);
    await state();
    const response = await bind(); expect(response.status).toBe(200);
    const bound = (await response.json()).settings;
    expect(bound).toMatchObject({ revision: 1, selectedHarnessId: "codex", modelConnectionRef: owner().snapshot()!.connectionRef });
    expect(await readAgentSettings(root)).toEqual(bound);
    expect(JSON.parse(readFileSync(join(root, ".inkos", "agent-config.json"), "utf8"))).toEqual(bound);
    expect(factory).toHaveBeenCalledTimes(1); expect(factory).toHaveBeenCalledWith(root);
    expect(await service.getRuntimeClient()).toBe(peer); expect(peer.closeCount).toBe(0);
    expect((await state()).execution).toBeNull();
  });

  it("rejects a stale bind revision before RPC or owner mutation", async () => {
    await updateAgentSettings(root, { selectedHarnessId: "pi" }, { expectedRevision: 0 });
    const before = await readAgentSettings(root);
    const response = await bind(0); expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("AGENT_SETTINGS_REVISION_CONFLICT");
    expect(await readAgentSettings(root)).toEqual(before); expect(peer.calls).toEqual([]); expect(owner().snapshot()).toBeUndefined();
  });

  it("performs the second real CAS after account probes instead of overwriting another writer", async () => {
    let raced = false;
    peer.beforeRequest = async method => { if (method === "account/read" && !raced) { raced = true;
      await updateAgentSettings(root, { selectedHarnessId: "pi" }, { expectedRevision: 0 }); } };
    const response = await bind(); expect(response.status).toBe(409);
    expect(await readAgentSettings(root)).toMatchObject({ revision: 1, selectedHarnessId: "pi", modelConnectionRef: null });
    expect(peer.count("account/read")).toBe(2); expect(owner().snapshot()?.localState).toBe("ready");
  });

  it("rejects explicit binding while signed out and preserves unbound settings", async () => {
    peer.authenticated = false; const response = await bind(); expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe("RUNTIME_AUTH_REVOKED");
    expect(await readAgentSettings(root)).toMatchObject({ revision: 0, modelConnectionRef: null });
    expect(owner().snapshot()?.localState).toBe("disconnected");
    expect(peer.count("account/login/start")).toBe(0);
  });

  it("keeps Pi saved and unavailable without using the Codex peer or falling back", async () => {
    const response = await app.request(`${prefix}/settings`, put({ expectedRevision: 0, patch: { selectedHarnessId: "pi", harnessPreferences: { pi: native } } }));
    expect(response.status).toBe(200); expect((await response.json()).settings.selectedHarnessId).toBe("pi");
    const pi = await app.request(`${prefix}/harnesses/pi/state`);
    expect(await pi.json()).toEqual({ state: { harnessId: "pi", availability: "unavailable", scope: null, installation: "unknown", account: null, catalog: null, execution: null } });
    expect((await bind(1)).status).toBe(422);
    expect((await app.request(`${prefix}/settings`, put({ expectedRevision: 1, patch: { harnessPreferences: { pi: { model: "gpt-6.1-sol" } } } }))).status).toBe(422);
    expect((await readAgentSettings(root)).selectedHarnessId).toBe("pi");
    expect(peer.calls).toEqual([]); expect(owner().snapshot()).toBeUndefined();
    expect((await app.request(`${prefix}/harnesses/pi/login`, post())).status).toBe(404);
  });

  it("rejects another trusted project's peer before RPC or either owner's admission", async () => {
    const foreignRoot = await mkdtemp(join(tmpdir(), "inkos-studio-other-project-")); additionalRoots.push(foreignRoot);
    await mkdir(join(foreignRoot, ".inkos", "codex", "home"), { recursive: true, mode: 0o700 });
    const foreignPeer = new ProtocolPeer(foreignRoot);
    const foreignService = createCodexAccountService({ projectDir: foreignRoot, clientFactory: async () => foreignPeer });
    const wrongApp = createStudioServer({} as never, root, { codexAccountService: foreignService }); additionalApps.push(wrongApp);
    const response = await wrongApp.request(`${prefix}/harnesses/codex/bind`, post({ expectedRevision: 0 }));
    expect(response.status).toBe(422); expect(foreignPeer.calls).toEqual([]);
    expect(new CodexAuthenticationOwner(foreignPeer).snapshot()).toBeUndefined(); expect(owner().snapshot()).toBeUndefined();
    expect((await readAgentSettings(root)).modelConnectionRef).toBeNull();
    expect(existsSync(join(foreignRoot, ".inkos", "agent-config.json"))).toBe(false);
  });

  it.each([
    ["/harnesses/codex/bind", { expectedRevision: 0, authContextRef: "browser-ref" }],
    ["/harnesses/codex/bind", { expectedRevision: 0, codexHome: "/browser/home" }],
    ["/harnesses/codex/login", { projectRoot: "/browser/project" }],
    ["/harnesses/codex/login/reserve", { projectRoot: "/browser/project" }],
    ["/harnesses/codex/login/close", { attemptHandle: "fixture-attempt", authGeneration: 3 }],
    ["/harnesses/codex/logout", { connectionRef: "browser-ref" }],
  ])("rejects browser authority fields on mounted %s before creating a peer", async (path, body) => {
    expect((await app.request(`${prefix}${path}`, post(body))).status).toBe(400);
    expect(factory).not.toHaveBeenCalled(); expect(peer.calls).toEqual([]);
  });

  it.each(["/harnesses/codex/login/reserve", "/harnesses/codex/login", "/harnesses/codex/logout", "/harnesses/codex/bind", "/harnesses/codex/login/close", "/settings"])("enforces real Host/Origin/Sec-Fetch/JSON guards on %s before RPC", async path => {
    const request = path === "/settings" ? put({ expectedRevision: 0, patch: { selectedHarnessId: "pi" } }) : post(path.endsWith("/bind") ? { expectedRevision: 0 } : path.endsWith("/close") || path.endsWith("/login") ? { attemptHandle: "fixture-attempt" } : {});
    expect((await app.request(`http://evil.test${prefix}${path}`, request)).status).toBe(403);
    expect((await app.request(`${prefix}${path}`, { ...request, headers: { "Content-Type": "application/json", Origin: "https://evil.test" } })).status).toBe(403);
    expect((await app.request(`${prefix}${path}`, { ...request, headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "cross-site" } })).status).toBe(403);
    expect((await app.request(`${prefix}${path}`, { ...request, headers: { "Content-Type": "text/plain" } })).status).toBe(415);
    expect(factory).not.toHaveBeenCalled(); expect(peer.calls).toEqual([]); expect(owner().snapshot()).toBeUndefined();
    expect((await readAgentSettings(root)).revision).toBe(0);
  });

  it("rejects foreign-host/origin and cross-site GET before passive observation RPC", async () => {
    const path = `${prefix}/harnesses/codex/state`;
    expect((await app.request(`http://evil.test${path}`)).status).toBe(403);
    expect((await app.request(path, { headers: { Origin: "https://evil.test" } })).status).toBe(403);
    expect((await app.request(path, { headers: { "Sec-Fetch-Site": "cross-site" } })).status).toBe(403);
    expect(factory).not.toHaveBeenCalled(); expect(peer.calls).toEqual([]);
  });

  it("honors explicit self-hosted Origin configuration without creating a URL-based readiness gate", async () => {
    const remoteApp = createStudioServer({} as never, root, { codexAccountService: service, hostname: "0.0.0.0", allowedOrigins: ["https://personal.example.test"] });
    additionalApps.push(remoteApp);
    const response = await remoteApp.request(`https://personal.example.test${prefix}/harnesses/codex/state`, { headers: { Origin: "https://personal.example.test" } });
    expect(response.status).toBe(200); expect((await response.json()).state.execution).toBeNull();
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("deduplicates parallel logins and recovers the pending attempt through a subsequent GET", async () => {
    peer.authenticated = false;
    const handle = await reserveAttempt(); const starts = await Promise.all([startAttempt(handle), startAttempt(handle)]);
    expect(starts.map(response => response.status)).toEqual([200, 200]);
    const results = await Promise.all(starts.map(response => response.json()));
    expect(results[0]).toEqual(results[1]); expect(results[0].login).toMatchObject({ loginId: "login-1", status: "pending", userCode: "FIXTURE-CODE" });
    expect(peer.count("account/login/start")).toBe(1); expect(factory).toHaveBeenCalledTimes(1);
    expect((await state()).connection).toMatchObject({ phase: "signing-in", login: { loginId: "login-1", status: "pending" } });
    expect(owner().snapshot()?.localState).toBe("transitioning"); expect((await readAgentSettings(root)).modelConnectionRef).toBeNull();
  });

  it("unknown Close cannot cancel the pending owner and cached exact Close fences late success without a new generation", async () => {
    peer.authenticated = false;
    const handle = await reserveAttempt(); await startAttempt(handle); const pending = owner().snapshot()!;
    const unknown = await closeAttempt("unknown"); expect(unknown.status).toBe(200);
    expect(await unknown.json()).toEqual({ result: { attemptHandle: "unknown", state: "unknown-or-expired", cleanup: "not-applicable" } });
    expect(peer.count("account/login/cancel")).toBe(0); expect(owner().snapshot()).toEqual(pending);
    const receipt = { result: { attemptHandle: handle, state: "closed", cleanup: "cancel-acknowledged" } };
    expect(await (await closeAttempt(handle)).json()).toEqual(receipt); expect(await (await closeAttempt(handle)).json()).toEqual(receipt);
    const cancelled = owner().snapshot()!; expect(cancelled).toMatchObject({ localState: "unknown", operationId: null, authGeneration: pending.authGeneration });
    peer.authenticated = true; peer.notify("account/login/completed", { loginId: "login-1", success: true, accessToken: "synthetic-private-token" });
    const observed = await state(); expect(observed.account).toEqual({ type: "chatgpt" }); expect(observed.catalog).toBeNull(); expect(observed.execution).toBeNull();
    expect(observed.connection.login.status).toBe("cancelled"); expect(owner().snapshot()).toEqual(cancelled);
    expect(peer.count("account/login/cancel")).toBe(1); expect((await readAgentSettings(root)).modelConnectionRef).toBeNull();
    expect((await startAttempt()).status).toBe(200); const newer = owner().snapshot()!, calls = [...peer.calls];
    expect(await (await closeAttempt(handle)).json()).toEqual(receipt);
    expect(owner().snapshot()).toEqual(newer); expect(peer.calls).toEqual(calls); expect(peer.count("account/login/start")).toBe(2);
  });

  it("settles a successful login in the same owner without automatically binding settings or verifying execution", async () => {
    peer.authenticated = false; const handle = await reserveAttempt(); await startAttempt(handle); const pending = owner().snapshot()!;
    peer.authenticated = true; peer.notify("account/login/completed", { loginId: "login-1", success: true });
    const observed = await state();
    expect(owner().snapshot()).toMatchObject({ localState: "ready", authGeneration: pending.authGeneration, operationId: null });
    expect(observed).toMatchObject({ scope: { ownerGeneration: pending.authGeneration }, connection: { phase: "signed-in", login: { status: "completed" } }, execution: null });
    expect((await readAgentSettings(root)).modelConnectionRef).toBeNull();
    const ready = owner().snapshot()!, calls = [...peer.calls];
    const receipt = { result: { attemptHandle: handle, state: "already-terminal", cleanup: "not-applicable" } };
    expect(await (await closeAttempt(handle)).json()).toEqual(receipt); expect(await (await closeAttempt(handle)).json()).toEqual(receipt);
    expect(owner().snapshot()).toEqual(ready); expect(peer.calls).toEqual(calls);
    expect(peer.count("account/login/cancel")).toBe(0); expect(peer.count("account/logout")).toBe(0); expect(peer.closeCount).toBe(0);
    expect(existsSync(join(peer.codexHome, ".write.lock.guard.sqlite"))).toBe(true);
    expect((await bind()).status).toBe(200); expect(factory).toHaveBeenCalledTimes(1);
  });

  it("pending logout revokes late completion and unlocks a fresh handle on the same healthy peer", async () => {
    peer.authenticated = false; const handle = await reserveAttempt(); await startAttempt(handle); const pending = owner().snapshot()!;
    expect((await app.request(`${prefix}/harnesses/codex/logout`, post())).status).toBe(200);
    const loggedOut = owner().snapshot()!; expect(loggedOut).toMatchObject({ localState: "disconnected", authGeneration: pending.authGeneration + 1, operationId: null });
    expect(peer.calls.filter(call => call.method === "account/login/cancel").map(call => call.params)).toEqual([{ loginId: "login-1" }]);
    expect(peer.count("account/logout")).toBe(1);
    peer.authenticated = true; peer.notify("account/login/completed", { loginId: "login-1", success: true });
    expect((await state()).connection.login).toBeNull(); expect(owner().snapshot()).toEqual(loggedOut);
    expect((await readAgentSettings(root)).modelConnectionRef).toBeNull();
    peer.authenticated = false; const nextHandle = await reserveAttempt();
    const nextResponse = await startAttempt(nextHandle);
    if (nextResponse.status === 503) {
      // Confirm the genuine Core cause, rather than treating a generic HTTP
      // unavailable envelope as proof that every failure is an attempt deadlock.
      await expect(service.startDeviceLogin({ attemptHandle: nextHandle })).rejects.toMatchObject({ code: "CODEX_LOGIN_ATTEMPT_BUSY" });
    }
    expect(nextResponse.status).toBe(200);
    expect(peer.count("account/login/start")).toBe(2); expect(peer.count("account/login/cancel")).toBe(1);
    expect(peer.count("account/logout")).toBe(1); expect(peer.closeCount).toBe(0); expect(factory).toHaveBeenCalledTimes(1);
    expect(owner().snapshot()).toMatchObject({ localState: "transitioning", authGeneration: loggedOut.authGeneration + 1 });
    const nextOwner = owner().snapshot()!, oldCalls = [...peer.calls];
    expect(await (await closeAttempt(handle)).json()).toEqual({ result: { attemptHandle: handle, state: "superseded", cleanup: "not-applicable" } });
    expect(owner().snapshot()).toEqual(nextOwner); expect(peer.calls).toEqual(oldCalls); expect(peer.closeCount).toBe(0);
  });

  it.each(["native failure", "signed-out completion", "account read failure"])("settles %s as non-ready, caches terminal Close and unlocks the next exact handle", async failure => {
    peer.authenticated = false; const handle = await reserveAttempt(); await startAttempt(handle);
    const pending = owner().snapshot()!;
    if (failure === "account read failure") {
      let failOnce = true;
      peer.beforeRequest = async method => { if (method === "account/read" && failOnce) { failOnce = false; throw new Error("synthetic-private-account-read"); } };
    }
    peer.notify("account/login/completed", { loginId: "login-1", success: failure !== "native failure" });
    const observed = await state(), settled = owner().snapshot()!;
    expect(settled).toMatchObject({ localState: failure === "signed-out completion" ? "disconnected" : "unknown", operationId: null, authGeneration: pending.authGeneration });
    expect(observed.connection.login.status).toBe("failed"); expect(observed.account).toBeNull(); expect(observed.catalog).toBeNull(); expect(observed.execution).toBeNull();
    const calls = [...peer.calls], receipt = { result: { attemptHandle: handle, state: "closed", cleanup: "not-applicable" } };
    expect(await (await closeAttempt(handle)).json()).toEqual(receipt); expect(await (await closeAttempt(handle)).json()).toEqual(receipt);
    expect(peer.calls).toEqual(calls); expect(owner().snapshot()).toEqual(settled); expect(peer.closeCount).toBe(0);
    expect((await readAgentSettings(root)).modelConnectionRef).toBeNull();
    expect((await startAttempt()).status).toBe(200); expect(peer.count("account/login/start")).toBe(2); expect(factory).toHaveBeenCalledTimes(1);
    const newer = owner().snapshot()!, nativeCalls = [...peer.calls];
    expect(await (await closeAttempt(handle)).json()).toEqual(receipt); expect(owner().snapshot()).toEqual(newer); expect(peer.calls).toEqual(nativeCalls);
  });

  it("keeps an unconfirmed cached Close busy until the original peer retirement settles, without mutating a fresh peer", async () => {
    peer.authenticated = false; peer.cancelResponse = {}; const oldPeer = peer;
    const handle = await reserveAttempt(); await startAttempt(handle); const pending = owner().snapshot()!;
    const receipt = { result: { attemptHandle: handle, state: "closed", cleanup: "unconfirmed" } };
    expect(await (await closeAttempt(handle)).json()).toEqual(receipt); const fenced = owner().snapshot()!;
    expect(fenced).toMatchObject({ localState: "unknown", operationId: null, authGeneration: pending.authGeneration });
    const next = await reserveAttempt(); expect((await startAttempt(next)).status).toBe(503);
    expect(await (await closeAttempt(handle)).json()).toEqual(receipt); expect(peer.count("account/login/cancel")).toBe(1);
    const entered = deferred<void>(), retirement = deferred<void>();
    oldPeer.beforeClose = async () => { entered.resolve(); await retirement.promise; };
    oldPeer.disconnect(); await entered.promise;
    try {
      const observed = await state(); expect(peer).not.toBe(oldPeer); expect(factory).toHaveBeenCalledTimes(2);
      expect(observed).toMatchObject({ catalog: null, execution: null }); expect(owner().snapshot()).toEqual(fenced);
      const newCalls = [...peer.calls], oldCalls = [...oldPeer.calls];
      expect((await startAttempt(next)).status).toBe(503);
      expect(await (await closeAttempt(handle)).json()).toEqual(receipt);
      expect(peer.calls).toEqual(newCalls); expect(oldPeer.calls).toEqual(oldCalls); expect(owner().snapshot()).toEqual(fenced);
      expect(oldPeer.retirementFinished).toBe(false); expect(oldPeer.closeCount).toBe(1);
    } finally { retirement.resolve(); }
    await vi.waitFor(() => expect(oldPeer.retirementFinished).toBe(true));
    expect((await startAttempt(next)).status).toBe(200);
    const newer = owner().snapshot()!, oldCalls = [...oldPeer.calls], newCalls = [...peer.calls];
    oldPeer.notify("account/login/completed", { loginId: "login-1", success: true });
    expect(await (await closeAttempt(handle)).json()).toEqual(receipt);
    expect(owner().snapshot()).toEqual(newer); expect(oldPeer.calls).toEqual(oldCalls); expect(peer.calls).toEqual(newCalls);
    expect(oldPeer.closeCount).toBe(1); expect(peer.count("account/login/start")).toBe(1); expect(peer.count("account/logout")).toBe(0);
    expect((await readAgentSettings(root)).modelConnectionRef).toBeNull();
  });

  it("a peer failure marks the pending attempt failed and borrows a fresh peer without restoring ready", async () => {
    peer.authenticated = false; await startAttempt(); const oldPeer = peer; const pending = owner().snapshot()!;
    oldPeer.disconnect();
    const observed = await state();
    expect(factory).toHaveBeenCalledTimes(2); expect(peer).not.toBe(oldPeer);
    expect(owner().snapshot()).toMatchObject({ localState: "unknown", operationId: null, authGeneration: pending.authGeneration });
    expect(observed).toMatchObject({ account: { type: "chatgpt" }, catalog: null, execution: null, connection: { phase: "signed-in", login: { status: "failed" } } });
    expect(JSON.stringify(observed)).not.toContain("synthetic-private");
    oldPeer.notify("account/login/completed", { loginId: "login-1", success: true });
    expect((await state()).connection.login.status).toBe("failed");
    expect(owner().snapshot()?.localState).toBe("unknown");
  });

  it("production shutdown settles a pending ticket and closes the owned peer once, fencing late completion", async () => {
    peer.authenticated = false; await startAttempt(); const pending = owner().snapshot()!;
    await shutdownStudioServer(app); const settled = owner().snapshot()!;
    expect(settled).toMatchObject({ localState: "unknown", operationId: null, authGeneration: pending.authGeneration });
    expect(peer.closed).toBe(true); expect(peer.closeCount).toBe(1);
    peer.authenticated = true; peer.notify("account/login/completed", { loginId: "login-1", success: true });
    expect(owner().snapshot()).toEqual(settled); await expect(service.getRuntimeClient()).rejects.toThrow("closed");
    await shutdownStudioServer(app); expect(peer.closeCount).toBe(1);
  });

  it.each(["RPC failure", "invalid reply"])("sanitizes %s, settles unknown and retires the original peer before unlocking retry", async failure => {
    const oldPeer = peer;
    if (failure === "RPC failure") peer.beforeRequest = async method => { if (method === "account/login/start") throw new Error("synthetic-private-RPC-error"); };
    else peer.nativeLoginResponse = { type: "chatgptDeviceCode", accessToken: "synthetic-private-token" };
    const response = await startAttempt();
    expect(response.status).toBe(503); expect(await response.text()).not.toContain("synthetic-private");
    expect(owner().snapshot()).toMatchObject({ localState: "unknown", operationId: null }); expect(peer.closeCount).toBe(1);
    expect((await readAgentSettings(root)).modelConnectionRef).toBeNull();
    expect(oldPeer.retirementFinished).toBe(true); const originalCalls = [...oldPeer.calls];
    expect((await startAttempt()).status).toBe(200); expect(peer).not.toBe(oldPeer); expect(factory).toHaveBeenCalledTimes(2);
    expect(oldPeer.calls).toEqual(originalCalls); expect(oldPeer.closeCount).toBe(1);
  });

  it("an aborted bind cannot commit or admit after the account RPC returns", async () => {
    const entered = deferred<void>(); const release = deferred<void>(); const abort = new AbortController();
    peer.beforeRequest = async method => { if (method === "account/read") { entered.resolve(); await release.promise; } };
    const request = app.request(new Request(`http://localhost${prefix}/harnesses/codex/bind`, { ...post({ expectedRevision: 0 }), signal: abort.signal }));
    await entered.promise; abort.abort(); release.resolve();
    expect((await request).status).toBe(503); expect((await readAgentSettings(root)).modelConnectionRef).toBeNull();
    expect(owner().snapshot()).toBeUndefined(); expect(peer.count("account/read")).toBe(1);
  });

  it("invalidates catalogue evidence when the same owner generation changes during a mounted probe", async () => {
    expect((await bind()).status).toBe(200); const before = owner().snapshot()!; let changed = false;
    peer.beforeRequest = async method => { if (method === "model/list" && !changed) { changed = true; owner().disconnect(); } };
    const observed = await state();
    expect(owner().snapshot()).toMatchObject({ localState: "disconnected", authGeneration: before.authGeneration + 1 });
    expect(observed.account).toBeNull(); expect(observed.catalog).toBeNull(); expect(observed.execution).toBeNull();
    expect((await readAgentSettings(root)).revision).toBe(1);
    expect(peer.count("account/login/start")).toBe(0);
  });

  it("carries actual UI intents through production HTTP, owner login/cancel, explicit binding, save CAS and retained conflict", async () => {
    peer.authenticated = false; const { controller, edit, save, view, httpCalls } = ui(); await controller.refresh();
    expect(view().connection.phase).toBe("signed-out");
    const intent = { action: "connect" as const, target: controller.getSnapshot().target };
    controller.connectionIntent(intent); controller.connectionIntent(intent);
    await vi.waitFor(() => expect(controller.getSnapshot().state?.connection?.login?.status).toBe("pending"));
    expect(peer.count("account/login/start")).toBe(1); expect(view().connection.phase).toBe("signing-in");
    controller.closeConnection();
    await vi.waitFor(() => expect(controller.getSnapshot().state?.connection?.login?.status).toBe("cancelled"));
    const cancelled = owner().snapshot()!; peer.authenticated = true;
    peer.notify("account/login/completed", { loginId: "login-1", success: true }); await controller.refreshState();
    expect(owner().snapshot()).toEqual(cancelled); expect(view().execution.phase).toBe("unverified");
    expect((await readAgentSettings(root)).modelConnectionRef).toBeNull();
    await controller.bindConnection();
    expect((await readAgentSettings(root)).modelConnectionRef).toBe(owner().snapshot()!.connectionRef);
    expect(controller.getSnapshot().revision).toBe(1); expect(view().execution.phase).toBe("unverified");
    edit("other-model"); await save();
    expect((await readAgentSettings(root)).harnessPreferences.codex.model).toBe("other-model");
    expect(controller.getSnapshot().savePhase).toBe("saved");
    edit("gpt-6.1-sol");
    expect((await app.request(`${prefix}/settings`, put({ expectedRevision: 2, patch: { selectedHarnessId: "pi" } }))).status).toBe(200);
    await save();
    expect(controller.getSnapshot()).toMatchObject({ revision: 2, draft: { model: "gpt-6.1-sol" }, savePhase: "conflict", reviewable: true, canSave: false,
      baseline: { revision: 3, selectedHarnessId: "pi", harnessPreferences: { codex: { model: "other-model" } } } });
    const rejectedCount = httpCalls.filter(call => call.method === "PUT").length;
    await save(); expect(httpCalls.filter(call => call.method === "PUT")).toHaveLength(rejectedCount);
    controller.reviewLatest(); await save();
    expect(await readAgentSettings(root)).toMatchObject({ revision: 4, selectedHarnessId: "codex", harnessPreferences: { codex: { model: "gpt-6.1-sol" } } });
    expect(httpCalls).toContainEqual({ method: "POST", path: `${prefix}/harnesses/codex/bind`, status: 200 });
    expect(httpCalls).toContainEqual({ method: "PUT", path: `${prefix}/settings`, status: 409 });
    expect(factory).toHaveBeenCalledTimes(1); expect(view().execution.phase).toBe("unverified");
  });

  it("Close during a delayed UI login cancels only its returned ID once through the same production owner", async () => {
    peer.authenticated = false; const { controller } = ui(); await controller.refresh();
    const entered = deferred<void>(); const release = deferred<void>();
    peer.beforeRequest = async method => { if (method === "account/login/start") { entered.resolve(); await release.promise; } };
    const intent = { action: "connect" as const, target: controller.getSnapshot().target };
    controller.connectionIntent(intent); await entered.promise; controller.closeConnection(); controller.closeConnection();
    controller.connectionIntent(intent); release.resolve();
    await vi.waitFor(() => expect(controller.getSnapshot().state?.connection?.login?.status).toBe("cancelled"));
    expect(peer.count("account/login/start")).toBe(1);
    expect(peer.calls.filter(call => call.method === "account/login/cancel").map(call => call.params)).toEqual([{ loginId: "login-1" }]);
    expect(owner().snapshot()).toMatchObject({ localState: "unknown", operationId: null });
    expect((await readAgentSettings(root)).modelConnectionRef).toBeNull();
  });

  it("ignores a navigation-away login reply, keeps Pi unavailable and recovers the same pending owner on return", async () => {
    peer.authenticated = false; const { controller, httpCalls, view } = ui(); await controller.refresh();
    const entered = deferred<void>(); const release = deferred<void>();
    peer.beforeRequest = async method => { if (method === "account/login/start") { entered.resolve(); await release.promise; } };
    controller.connectionIntent({ action: "connect", target: controller.getSnapshot().target }); await entered.promise;
    controller.selectTarget({ harness: "pi", contextKey: "unobserved" }); await controller.refresh(); release.resolve();
    await vi.waitFor(() => expect(httpCalls).toContainEqual({ method: "POST", path: `${prefix}/harnesses/codex/login`, status: 200 }));
    expect(controller.getSnapshot().target.harness).toBe("pi"); expect(controller.getSnapshot().state?.availability).toBe("unavailable");
    expect(view().connection.phase).toBe("unverified"); expect(view().execution.phase).toBe("unverified");
    expect(controller.getSnapshot().authBusy).toBeNull(); expect(peer.count("account/login/start")).toBe(1);
    controller.selectTarget({ harness: "codex", contextKey: "unobserved" }); await controller.refresh();
    expect(controller.getSnapshot().state?.connection?.login).toMatchObject({ loginId: "login-1", status: "pending" });
    expect(view().connection.phase).toBe("signing-in"); expect(peer.count("account/login/start")).toBe(1);
    controller.closeConnection(); await vi.waitFor(() => expect(controller.getSnapshot().state?.connection?.login?.status).toBe("cancelled"));
    expect(peer.count("account/login/cancel")).toBe(1); expect(factory).toHaveBeenCalledTimes(1);
  });

  it("keeps edits made during the real catalogue-backed PUT after its committed response", async () => {
    const { controller, edit, save } = ui(); await controller.refresh(); edit("other-model");
    const entered = deferred<void>(); const release = deferred<void>(); let waiting = true;
    peer.beforeRequest = async method => { if (method === "model/list" && waiting) { waiting = false; entered.resolve(); await release.promise; } };
    const pending = save(); await entered.promise;
    controller.edit({ action: "choose-option", target: controller.getSnapshot().target, field: "reasoning", choiceKey: "high" });
    release.resolve(); await pending;
    expect(await readAgentSettings(root)).toMatchObject({ revision: 1, harnessPreferences: { codex: { model: "other-model", effort: "ultra", speed: "priority" } } });
    expect(controller.getSnapshot()).toMatchObject({ revision: 1, draft: { model: "other-model", effort: "high", speed: "priority" }, hasChanges: true, canSave: true });
  });
});
