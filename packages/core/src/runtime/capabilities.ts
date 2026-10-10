import {
  HarnessCapabilityCatalogSchema, HarnessDescriptorSchema, HarnessPreferencesSchema,
  type HarnessCapabilityCatalog, type HarnessDescriptor, type HarnessId, type HarnessPreferences,
} from './contracts.js';

export class RuntimeCapabilityError extends Error {
  readonly code = 'RUNTIME_CAPABILITY_INVALID';
}

export function parseHarnessCapabilityCatalog(value: unknown, harnessId: HarnessId): HarnessCapabilityCatalog {
  const catalog = HarnessCapabilityCatalogSchema.parse(value);
  if (catalog.harnessId !== harnessId) throw new RuntimeCapabilityError('Capability catalog belongs to a different harness');
  return catalog;
}

export function resolveHarnessPreferences(preferences: HarnessPreferences, catalog: HarnessCapabilityCatalog): {
  modelId: string; effort: string | null; serviceTier: string | null;
} {
  const desired = HarnessPreferencesSchema.parse(preferences);
  catalog = parseHarnessCapabilityCatalog(catalog, catalog.harnessId);
  const modelId = desired.model ?? catalog.nativeDefaults.modelId;
  const model = catalog.models.find(candidate => candidate.modelId === modelId);
  if (!model) throw new RuntimeCapabilityError('Selected model is absent from this harness capability catalog');
  const effort = desired.effort ?? (desired.model === null ? catalog.nativeDefaults.effort : model.defaultEffort);
  const serviceTier = desired.speed ?? (desired.model === null ? catalog.nativeDefaults.serviceTier : model.defaultServiceTier);
  if (effort !== null && !model.efforts.includes(effort)) throw new RuntimeCapabilityError('Unsupported effort for selected model');
  if (serviceTier !== null && !model.serviceTiers.includes(serviceTier)) throw new RuntimeCapabilityError('Unsupported service tier for selected model');
  return { modelId, effort, serviceTier };
}

/** Desired native defaults can be persisted even before a harness is installed. */
export function validateHarnessPreferences(harnessId: HarnessId, preferences: HarnessPreferences, value?: unknown): void {
  const desired = HarnessPreferencesSchema.parse(preferences);
  if (desired.model === null && desired.effort === null && desired.speed === null) return;
  if (value === undefined || value === null) throw new RuntimeCapabilityError('Explicit preferences require this harness capability catalog');
  resolveHarnessPreferences(desired, parseHarnessCapabilityCatalog(value, harnessId));
}

export function getHarnessReadyReasons(value: HarnessDescriptor): string[] {
  // Inspect evidence even if an untrusted probe incorrectly claimed ready=true.
  // The public refined DTO schema rejects that contradictory claim.
  const descriptor = HarnessDescriptorSchema.innerType().parse(value);
  const reasons = [...descriptor.readyReasons];
  if (!descriptor.ready) reasons.push('adapter-not-ready');
  if (descriptor.installation !== 'installed') reasons.push('harness-not-installed');
  if (descriptor.deployment !== 'supported') reasons.push('deployment-not-supported');
  if (descriptor.runtimeVersion === null) reasons.push('unknown-runtime-version');
  if (!descriptor.capabilities) reasons.push('unknown-capabilities');
  else {
    try {
      const catalog = parseHarnessCapabilityCatalog(descriptor.capabilities, descriptor.harnessId);
      if (catalog.adapterVersion !== descriptor.adapterVersion) reasons.push('capability-version-mismatch');
      if (!catalog.supportsChatGptOauth) reasons.push('chatgpt-oauth-unsupported');
      if (!catalog.supportsTools) reasons.push('tools-unsupported');
      if (!catalog.supportsStreaming) reasons.push('streaming-unsupported');
    } catch { reasons.push('invalid-capabilities'); }
  }
  return [...new Set(reasons)];
}

export function isHarnessReady(descriptor: HarnessDescriptor): boolean {
  try { return getHarnessReadyReasons(descriptor).length === 0; }
  catch { return false; }
}
