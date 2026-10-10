import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import {
  AgentSettingsConflictError, AgentSettingsPatchSchema, RuntimeCapabilityError,
  RuntimeAuthenticationError, observeCodexRuntime, bindCodexModelConnection,
  parseHarnessCapabilityCatalog, readAgentSettings, updateAgentSettings,
  type HarnessCapabilityCatalog, type HarnessId, type CodexAccountService,
} from "@actalk/inkos-core";
import { ApiError } from "./errors.js";
import { catalogMatchesState, unavailableHarnessState, validScope, type HarnessState, type SettingsUpdate } from "../shared/agent-configuration.js";
import { isCodexVerificationUrl, type StudioCodexLogin } from "../shared/codex.js";

export interface AgentConfigurationRouteDependencies {
  // Trusted server dependency only: no context or catalog from the browser is accepted.
  readonly observeHarness?: (harnessId: HarnessId, signal?: AbortSignal) => Promise<HarnessState>;
  readonly accountService?: CodexAccountService;
  readonly bindConnection?: (expectedRevision: number, signal?: AbortSignal) => ReturnType<typeof bindCodexModelConnection>;
}
const LOGIN_FAILURE = "ChatGPT sign-in did not complete. Check the current attempt before retrying.";
function publicLogin(login: StudioCodexLogin | null): StudioCodexLogin | null {
  if (!login) return null;
  return { loginId: login.loginId, status: login.status,
    ...(login.status === "pending" && login.verificationUrl && isCodexVerificationUrl(login.verificationUrl)
      ? { verificationUrl: login.verificationUrl, userCode: login.userCode } : {}),
    ...(login.status === "failed" ? { error: LOGIN_FAILURE } : {}) };
}

/** Borrow the service's peer; the account service alone manages its lifecycle. */
export function createAgentConfigurationDependencies(projectRoot: string, accountService: CodexAccountService): AgentConfigurationRouteDependencies {
  return {
    accountService,
    bindConnection: async (expectedRevision, signal) => bindCodexModelConnection(projectRoot, await accountService.getRuntimeClient(), { expectedRevision, signal }),
    observeHarness: async (id, signal) => {
      if (id === "pi") return unavailableHarnessState(id);
      signal?.throwIfAborted();
      const status = await accountService.readAccount();
      signal?.throwIfAborted();
      const client = await accountService.getRuntimeClient();
      const observation = await observeCodexRuntime(client, signal);
      // A fresh probe tag binds these catalogue values to this observation only.
      const scope = { harnessId: id, authContextRef: observation.authContextRef, ownerGeneration: observation.owner?.authGeneration ?? null,
        adapterVersion: observation.descriptor?.adapterVersion ?? "unobserved", catalogVersion: `probe-${randomUUID()}` };
      const catalog = observation.descriptor?.capabilities;
      const ownership = observation.catalogOwnership;
      const matched = catalog && ownership && ownership.authContextRef === scope.authContextRef
        && ownership.authGeneration === scope.ownerGeneration && ownership.adapterVersion === scope.adapterVersion;
      const login = publicLogin(status.login);
      // These reasons follow two matching live ChatGPT reads; only owner admission remains blocked.
      const connected = !!observation.account || (status.connected && status.account?.type === "chatgpt"
        && observation.readyReasons.some(reason => reason === "owner-disconnected" || reason === "owner-unknown"));
      const phase = observation.account ? "signed-in" : login?.status === "pending" ? "signing-in" : connected ? "signed-in"
        : login?.status === "failed" ? "failed" : status.connected ? "uncertain" : "signed-out";
      return { harnessId: id, availability: "available", scope, installation: client.closed ? "unknown" : "installed",
        account: connected ? { type: "chatgpt", ...(observation.account?.planType ? { label: `ChatGPT · ${observation.account.planType}` } : {}) } : null,
        connection: { phase, login, connectionRef: observation.owner?.connectionRef ?? null },
        catalog: matched ? { scope, value: catalog, speedSupport: Object.fromEntries(catalog.models.map(model => [model.modelId, "backend" as const])) } : null,
        // Account/catalog probes and successful binding do not verify inference.
        execution: null };
    },
  };
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function parseUpdate(value: unknown): SettingsUpdate {
  if (!object(value) || Object.keys(value).some(key => !["expectedRevision", "patch"].includes(key))
    || !Number.isSafeInteger(value.expectedRevision) || (value.expectedRevision as number) < 0
    || !object(value.patch) || !Object.keys(value.patch).length
    || Object.keys(value.patch).some(key => !["selectedHarnessId", "harnessPreferences"].includes(key))) {
    throw new ApiError(400, "AGENT_CONFIGURATION_INVALID_REQUEST", "Expected a revision and a narrow settings patch.");
  }
  const patch = AgentSettingsPatchSchema.safeParse(value.patch);
  if (!patch.success) throw new ApiError(400, "AGENT_CONFIGURATION_INVALID_REQUEST", "Invalid harness preferences.");
  return { expectedRevision: value.expectedRevision as number, patch: patch.data };
}

/** Mounted after Studio's Host/Origin guards. HTTP never selects an auth directory or reference. */
export function createAgentConfigurationRoutes(projectRoot: string, dependencies: AgentConfigurationRouteDependencies = {}) {
  const app = new Hono();
  const observe = async (id: HarnessId, signal?: AbortSignal): Promise<HarnessState> => {
    if (!dependencies.observeHarness) return unavailableHarnessState(id);
    const state = await dependencies.observeHarness(id, signal);
    if (state.harnessId !== id || (state.scope && (!validScope(state.scope) || state.scope.harnessId !== id))) return unavailableHarnessState(id);
    // Explicit projection keeps accidental owner-only fields out of the HTTP response.
    const scope = state.scope ? { harnessId: state.scope.harnessId, authContextRef: state.scope.authContextRef, ownerGeneration: state.scope.ownerGeneration,
      adapterVersion: state.scope.adapterVersion, catalogVersion: state.scope.catalogVersion } : null;
    let catalog: HarnessState["catalog"] = null;
    if (catalogMatchesState(state)) {
      const value = parseHarnessCapabilityCatalog(state.catalog!.value, id);
      catalog = { scope: { ...scope! }, value, speedSupport: Object.fromEntries(value.models.map(model => [model.modelId, state.catalog!.speedSupport[model.modelId] ?? "unknown"])) };
    }
    return { harnessId: id, availability: state.availability, scope, installation: state.installation,
      account: state.account?.type === "chatgpt" ? { type: "chatgpt", ...(state.account.label ? { label: state.account.label } : {}) } : null,
      ...(state.connection ? { connection: { phase: state.connection.phase, login: publicLogin(state.connection.login), connectionRef: state.connection.connectionRef } } : {}),
      catalog, execution: state.execution ? { scope: { harnessId: state.execution.scope.harnessId, authContextRef: state.execution.scope.authContextRef,
        ownerGeneration: state.execution.scope.ownerGeneration, adapterVersion: state.execution.scope.adapterVersion, catalogVersion: state.execution.scope.catalogVersion },
        preferences: { model: state.execution.preferences.model, effort: state.execution.preferences.effort, speed: state.execution.preferences.speed }, phase: state.execution.phase } : null };
  };
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    if (c.req.header("Sec-Fetch-Site") === "cross-site") throw new ApiError(403, "AGENT_CONFIGURATION_CROSS_SITE", "Cross-site configuration access is forbidden.");
    if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method) && c.req.header("Content-Type")?.split(";")[0].trim() !== "application/json") {
      throw new ApiError(415, "AGENT_CONFIGURATION_JSON_REQUIRED", "Configuration changes require application/json.");
    }
    await next();
  });
  app.onError((error, c) => {
    if (error instanceof ApiError) return c.json({ error: { code: error.code, message: error.message } }, error.status as 400);
    if (error instanceof AgentSettingsConflictError) return c.json({ error: { code: error.code, message: "Settings changed. Read the latest settings and review your draft." } }, 409);
    if (error instanceof RuntimeCapabilityError) return c.json({ error: { code: error.code, message: "Preferences require a matching verified harness catalog." } }, 422);
    if (error instanceof RuntimeAuthenticationError) return c.json({ error: { code: error.code, message: "The ChatGPT connection cannot be bound in the current project context." } }, 422);
    return c.json({ error: { code: "AGENT_CONFIGURATION_UNAVAILABLE", message: "Configuration evidence or storage is unavailable." } }, 503);
  });
  app.get("/settings", async c => c.json({ settings: await readAgentSettings(projectRoot) }));
  app.put("/settings", async c => {
    const request = parseUpdate(await c.req.json().catch(() => null));
    const current = await readAgentSettings(projectRoot);
    const catalogs: Partial<Record<HarnessId, HarnessCapabilityCatalog>> = {};
    const ids = new Set<HarnessId>(Object.keys(request.patch.harnessPreferences ?? {}) as HarnessId[]);
    if (request.patch.selectedHarnessId) ids.add(request.patch.selectedHarnessId);
    for (const id of ids) {
      const preferences = { ...current.harnessPreferences[id], ...request.patch.harnessPreferences?.[id] };
      if (preferences.model === null && preferences.effort === null && preferences.speed === null) continue;
      const state = await observe(id, c.req.raw.signal);
      if (catalogMatchesState(state)) {
        const catalog = parseHarnessCapabilityCatalog(state.catalog!.value, id);
        // Core validates model/effort/tier membership; speed support needs independent evidence.
        if (preferences.speed !== null) {
          const modelId = preferences.model ?? catalog.nativeDefaults.modelId;
          if (state.catalog!.speedSupport[modelId] !== "backend") throw new RuntimeCapabilityError("Speed capability is unverified");
        }
        catalogs[id] = catalog;
      }
    }
    const settings = await updateAgentSettings(projectRoot, request.patch, { expectedRevision: request.expectedRevision, catalogs });
    return c.json({ settings });
  });
  app.get("/harnesses/:harness/state", async c => {
    const id = c.req.param("harness");
    if (id !== "codex" && id !== "pi") throw new ApiError(404, "AGENT_CONFIGURATION_UNKNOWN_HARNESS", "Unknown harness.");
    return c.json({ state: await observe(id, c.req.raw.signal) });
  });
  const service = () => {
    if (!dependencies.accountService) throw new ApiError(503, "AGENT_CONFIGURATION_UNAVAILABLE", "The ChatGPT account service is unavailable.");
    return dependencies.accountService;
  };
  const body = async (request: Request, allowed: readonly string[]) => {
    const value: unknown = await request.json().catch(() => null);
    if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new ApiError(400, "AGENT_CONFIGURATION_INVALID_REQUEST", "Invalid configuration action.");
    return value;
  };
  app.post("/harnesses/codex/bind", async c => {
    const value = await body(c.req.raw, ["expectedRevision"]);
    if (!Number.isSafeInteger(value.expectedRevision) || (value.expectedRevision as number) < 0) throw new ApiError(400, "AGENT_CONFIGURATION_INVALID_REQUEST", "A valid revision is required.");
    if (!dependencies.bindConnection) throw new ApiError(503, "AGENT_CONFIGURATION_UNAVAILABLE", "Connection binding is unavailable.");
    const current = await readAgentSettings(projectRoot);
    if (current.revision !== value.expectedRevision) throw new AgentSettingsConflictError(value.expectedRevision as number, current.revision);
    if (current.selectedHarnessId !== "codex") throw new RuntimeAuthenticationError("Binding requires the selected Codex harness");
    return c.json({ settings: await dependencies.bindConnection(value.expectedRevision as number, c.req.raw.signal) });
  });
  app.post("/harnesses/codex/login", async c => {
    await body(c.req.raw, []);
    const login = await service().startDeviceLogin();
    if (!isCodexVerificationUrl(login.verificationUrl)) throw new ApiError(502, "AGENT_CONFIGURATION_INVALID_LOGIN", LOGIN_FAILURE);
    return c.json({ login: publicLogin({ ...login, status: "pending" }) });
  });
  app.post("/harnesses/codex/login/cancel", async c => {
    const value = await body(c.req.raw, ["loginId"]);
    if (typeof value.loginId !== "string" || !value.loginId || value.loginId.length > 256) throw new ApiError(400, "AGENT_CONFIGURATION_INVALID_REQUEST", "A valid login ID is required.");
    const account = service(), status = await account.readAccount();
    if (status.login?.loginId !== value.loginId) throw new ApiError(409, "AGENT_CONFIGURATION_LOGIN_CHANGED", "The sign-in attempt changed. Check current status.");
    if (status.login.status === "pending") await account.cancelLogin(value.loginId);
    return c.json({ ok: true });
  });
  app.post("/harnesses/codex/logout", async c => {
    await body(c.req.raw, []); await service().logout(); return c.json({ ok: true });
  });
  return app;
}
