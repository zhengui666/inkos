import type { AgentSettings, HarnessCapabilityCatalog, HarnessId, HarnessPreferences } from "@actalk/inkos-core";
import type { StudioCodexLogin } from "./codex.js";

export type { AgentSettings, HarnessId, HarnessPreferences };
export interface SettingsUpdate {
  readonly expectedRevision: number;
  readonly patch: {
    readonly selectedHarnessId?: HarnessId;
    readonly harnessPreferences?: Partial<Record<HarnessId, Partial<HarnessPreferences>>>;
  };
}

// Studio's credential-free observation envelope. The server owner supplies every scope field.
// Scope and catalogue tags describe one server observation, not execution admission.
export interface EvidenceScope {
  readonly harnessId: HarnessId;
  readonly authContextRef: string;
  readonly ownerGeneration: number | null;
  readonly adapterVersion: string;
  readonly catalogVersion: string;
}
export interface HarnessState {
  readonly harnessId: HarnessId;
  readonly availability: "available" | "unavailable";
  readonly scope: EvidenceScope | null;
  readonly installation: "installed" | "missing" | "unknown";
  readonly account: { readonly type: "chatgpt"; readonly label?: string } | null;
  readonly connection?: {
    readonly phase: "signed-out" | "signing-in" | "signed-in" | "failed" | "uncertain";
    readonly login: StudioCodexLogin | null;
    readonly connectionRef: string | null;
  };
  readonly catalog: {
    readonly scope: EvidenceScope;
    readonly value: HarnessCapabilityCatalog;
    readonly speedSupport: Readonly<Record<string, "backend" | "unsupported" | "unknown">>;
  } | null;
  // This requires an actual execution observation; descriptor.ready and resolver success cannot fill it.
  readonly execution: {
    readonly scope: EvidenceScope;
    readonly preferences: HarnessPreferences;
    readonly phase: "ready" | "blocked" | "failed" | "unknown";
  } | null;
}

export function unavailableHarnessState(harnessId: HarnessId): HarnessState {
  return { harnessId, availability: "unavailable", scope: null, installation: "unknown", account: null, catalog: null, execution: null };
}
export function sameScope(a: EvidenceScope, b: EvidenceScope): boolean {
  return a.harnessId === b.harnessId && a.authContextRef === b.authContextRef
    && a.ownerGeneration === b.ownerGeneration && a.adapterVersion === b.adapterVersion && a.catalogVersion === b.catalogVersion;
}
export function validScope(scope: EvidenceScope): boolean {
  return (scope.harnessId === "codex" || scope.harnessId === "pi") && typeof scope.authContextRef === "string" && scope.authContextRef.length > 0
    && (scope.ownerGeneration === null || (Number.isSafeInteger(scope.ownerGeneration) && scope.ownerGeneration >= 0))
    && typeof scope.adapterVersion === "string" && scope.adapterVersion.length > 0 && typeof scope.catalogVersion === "string" && scope.catalogVersion.length > 0;
}
export function catalogMatchesState(state: HarnessState): boolean {
  return state.availability === "available" && state.scope !== null && validScope(state.scope) && state.scope.harnessId === state.harnessId
    && state.catalog !== null && sameScope(state.scope, state.catalog.scope)
    && state.catalog.value.harnessId === state.harnessId && state.catalog.value.adapterVersion === state.scope.adapterVersion;
}
export function samePreferences(a: HarnessPreferences, b: HarnessPreferences): boolean {
  return a.model === b.model && a.effort === b.effort && a.speed === b.speed;
}

export interface DeviceLoginAttemptReservation {
  readonly attemptHandle: string;
  readonly expiresAt: number;
}
export interface DeviceLoginAttemptCloseResult {
  readonly attemptHandle: string;
  readonly state: "closed" | "already-terminal" | "unknown-or-expired" | "superseded";
  readonly cleanup: "not-started" | "cancel-acknowledged" | "unconfirmed" | "not-applicable";
}
