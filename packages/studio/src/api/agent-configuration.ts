import { Hono } from "hono";
import {
  AgentSettingsConflictError, AgentSettingsPatchSchema, RuntimeCapabilityError,
  parseHarnessCapabilityCatalog, readAgentSettings, updateAgentSettings,
  type HarnessCapabilityCatalog, type HarnessId,
} from "@actalk/inkos-core";
import { ApiError } from "./errors.js";
import { catalogMatchesState, unavailableHarnessState, validScope, type HarnessState, type SettingsUpdate } from "../shared/agent-configuration.js";

export interface AgentConfigurationRouteDependencies {
  // Trusted server dependency only: no context or catalog from the browser is accepted.
  readonly observeHarness?: (harnessId: HarnessId) => Promise<HarnessState>;
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

/** Mount only after Studio's Host/Origin guards. Authentication mutations are intentionally absent. */
export function createAgentConfigurationRoutes(projectRoot: string, dependencies: AgentConfigurationRouteDependencies = {}) {
  const app = new Hono();
  const observe = async (id: HarnessId): Promise<HarnessState> => {
    if (!dependencies.observeHarness) return unavailableHarnessState(id);
    const state = await dependencies.observeHarness(id);
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
      const state = await observe(id);
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
    return c.json({ state: await observe(id) });
  });
  return app;
}
