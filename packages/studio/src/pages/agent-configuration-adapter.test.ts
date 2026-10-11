import { describe, expect, it } from "vitest";
import { adaptAgentConfiguration } from "./agent-configuration-adapter";
import { isExecutionReady, selectionIssues } from "../components/agent-configuration-ui/display-state";
import { unavailableHarnessState, type HarnessState } from "../shared/agent-configuration";

const scope = { harnessId: "codex" as const, authContextRef: "real-context", ownerGeneration: 3, adapterVersion: "1", catalogVersion: "2" };
const target = { harness: "codex" as const, contextKey: scope.authContextRef };
const draft = { model: null, effort: "high", speed: "fast" };
const state: HarnessState = { harnessId: "codex", availability: "available", scope, installation: "installed", account: { type: "chatgpt", label: "observed@example.test" }, execution: null,
  catalog: { scope, speedSupport: { native: "backend" }, value: { harnessId: "codex", adapterVersion: "1", supportsChatGptOauth: true, supportsTools: true, supportsStreaming: true,
    models: [{ modelId: "other", efforts: [], serviceTiers: [], defaultEffort: null, defaultServiceTier: null }, { modelId: "native", efforts: ["high"], serviceTiers: ["fast"], defaultEffort: null, defaultServiceTier: null }],
    nativeDefaults: { modelId: "native", effort: null, serviceTier: null } } } };
function adapt(candidate: HarnessState | null = state, generation: number | null = 3) {
  return adaptAgentConfiguration({ target, ownerGeneration: generation, state: candidate, draft, saved: draft, savePhase: "saved" });
}
describe("pure owner evidence mapping", () => {
  it.each(["installed", "missing"] as const)("keeps target-matched installation %s independent of unavailable auth scope", installation => {
    const candidate = { ...unavailableHarnessState("pi"), installation };
    const view = adaptAgentConfiguration({ target: { harness: "pi", contextKey: "unobserved" }, ownerGeneration: null,
      state: candidate, draft, saved: draft, savePhase: "saved" });
    expect(view.installation.phase).toBe(installation);
    expect(view.connection.phase).toBe("unverified"); expect(view.connection.accountLabel).toBeUndefined();
    expect(view.catalog.models).toEqual([]); expect(view.execution.phase).toBe("unverified");
    expect(adaptAgentConfiguration({ target: { harness: "codex", contextKey: "unobserved" }, ownerGeneration: null,
      state: candidate, draft, saved: draft, savePhase: "saved" }).installation.phase).toBe("unverified");
  });
  it("uses only matching native evidence, retaining null preferences and actual account observation", () => {
    const view = adapt();
    expect(view.selection.modelKey).toBeNull();
    expect(view.save.selection.modelKey).toBeNull();
    expect(view.catalog.nativeDefaults?.modelKey).toBe("native");
    expect(selectionIssues(target, view.catalog, view.selection)).toEqual([]);
    expect(view.connection.phase).toBe("signed-in");
    expect(view.connection.accountLabel).toBe("observed@example.test");
    expect(isExecutionReady(view)).toBe(false);
  });
  it.each(["context", "generation", "adapter", "version", "missing-model"])("ignores mismatched %s native evidence", mismatch => {
    const catalog = state.catalog!;
    const bad: HarnessState = { ...state, catalog: { ...catalog,
      scope: { ...scope, ...(mismatch === "context" ? { authContextRef: "other" } : mismatch === "generation" ? { ownerGeneration: 2 } : mismatch === "adapter" ? { adapterVersion: "2" } : mismatch === "version" ? { catalogVersion: "old" } : {}) },
      value: { ...catalog.value, nativeDefaults: { ...catalog.value.nativeDefaults, modelId: mismatch === "missing-model" ? "absent" : "native" } } } };
    const view = adapt(bad);
    expect(view.catalog.nativeDefaults).toBeUndefined();
    expect(view.catalog.models).toEqual([]);
    expect(selectionIssues(target, view.catalog, view.selection)).toHaveLength(2);
    expect(isExecutionReady(view)).toBe(false);
  });
  it("rejects another owner generation or account context without leaking the account", () => {
    expect(adapt(state, 4).connection.accountLabel).toBeUndefined();
    expect(adapt({ ...state, scope: { ...scope, authContextRef: "old-context" } }).connection.accountLabel).toBeUndefined();
  });
  it("retains a pending attempt and hides the prior account label while admission is pending", () => {
    const view = adapt({ ...state, connection: { phase: "signing-in", login: { loginId: "current-attempt", status: "pending" }, connectionRef: null } });
    expect(view.connection.phase).toBe("signing-in");
    expect(view.connection.attemptKey).toBe("current-attempt");
    expect(view.connection.accountLabel).toBeUndefined();
  });
  it("requires an actual chatgpt account type rather than inferring login from other evidence", () => {
    const other = { ...state, account: { type: "apiKey", label: "do-not-show" } } as unknown as HarnessState;
    expect(adapt(other).connection.phase).toBe("unverified");
    expect(adapt(other).connection.accountLabel).toBeUndefined();
    expect(isExecutionReady(adapt({ ...other, execution: { scope, phase: "ready", preferences: draft } }))).toBe(false);
  });
  it.each(["unknown", "unsupported", "backend"] as const)("keeps speed support %s independent from empty tiers", support => {
    const value = { ...state.catalog!.value, models: state.catalog!.value.models.map(model => ({ ...model, serviceTiers: [] })) };
    const view = adapt({ ...state, catalog: { ...state.catalog!, value, speedSupport: { native: support } } });
    expect(view.catalog.models.find(model => model.key === "native")?.speed.evidence).toBe(support === "unknown" ? "unverified" : support);
    expect(view.catalog.models.find(model => model.key === "native")?.speed.options).toEqual([]);
  });
  it("requires a matching execution observation in addition to installation, authentication and catalog", () => {
    const ready = { ...state, execution: { scope, preferences: draft, phase: "ready" as const } };
    expect(isExecutionReady(adapt(ready))).toBe(true);
    expect(isExecutionReady(adapt({ ...ready, account: null }))).toBe(false);
    expect(isExecutionReady(adapt({ ...ready, execution: { ...ready.execution, scope: { ...scope, ownerGeneration: 2 } } }))).toBe(false);
    expect(isExecutionReady(adapt({ ...ready, execution: { ...ready.execution, preferences: { ...draft, effort: null } } }))).toBe(false);
    const unsupported = { ...ready, catalog: { ...state.catalog!, speedSupport: { native: "unknown" as const } } };
    expect(adapt(unsupported).execution.phase).toBe("unverified");
    expect(isExecutionReady(adapt({ ...ready, catalog: { ...state.catalog!, value: { ...state.catalog!.value, supportsTools: false } } }))).toBe(false);
  });
  it("keeps unavailable Pi independent from Codex without fallback or readiness", () => {
    const piTarget = { harness: "pi" as const, contextKey: "unobserved" };
    const view = adaptAgentConfiguration({ target: piTarget, ownerGeneration: null, state: unavailableHarnessState("pi"), draft, saved: draft, savePhase: "saved" });
    expect(view.target.harness).toBe("pi");
    expect(view.connection.phase).toBe("unverified");
    expect(view.catalog.models).toEqual([]);
    expect(isExecutionReady(view)).toBe(false);
  });
  it.each(["missing", "oauth-present", "unknown"] as const)("keeps Pi local authentication %s separate from account and execution", localAuthentication => {
    const piScope = { ...scope, harnessId: "pi" as const, ownerGeneration: null };
    const piTarget = { harness: "pi" as const, contextKey: piScope.authContextRef };
    const observed: HarnessState = { ...state, harnessId: "pi", scope: piScope, localAuthentication, account: null, catalog: null };
    const view = adaptAgentConfiguration({ target: piTarget, ownerGeneration: null, state: observed, draft, saved: draft, savePhase: "saved" });
    expect(view.connection.phase).toBe(localAuthentication === "missing" ? "signed-out" : localAuthentication === "oauth-present" ? "oauth-present" : "unverified");
    expect(view.connection.accountLabel).toBeUndefined(); expect(isExecutionReady(view)).toBe(false); expect(view.execution.phase).toBe("unverified");
    const otherContext = adaptAgentConfiguration({ target: { ...piTarget, contextKey: "different" }, ownerGeneration: null,
      state: observed, draft, saved: draft, savePhase: "saved" });
    expect(otherContext.connection.phase).toBe("unverified"); expect(otherContext.connection.accountLabel).toBeUndefined();
  });
});
