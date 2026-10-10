import {
  AgentSettingsSchema, HarnessDescriptorSchema, ModelConnectionAdmissionSchema,
  type AgentSettings, type HarnessDescriptor, type ModelConnectionAdmission, type RuntimeSelection,
} from './contracts.js';
import { getHarnessReadyReasons, parseHarnessCapabilityCatalog, resolveHarnessPreferences } from './capabilities.js';

export class RuntimeSelectionError extends Error {
  readonly code = 'RUNTIME_SELECTION_BLOCKED';
}

/** Pure admission resolution: no auth reads, adapter execution, fallback or writes. */
export function resolveRuntimeSelection(input: {
  settings: AgentSettings;
  harness: HarnessDescriptor;
  /** Actual context of the selected harness, resolved independently by its auth owner.
   * Do not infer this from a ref string, environment key, or the incoming admission.
   */
  authContext: Pick<ModelConnectionAdmission, 'harnessId' | 'authContextRef'>;
  connection: ModelConnectionAdmission;
}): Readonly<RuntimeSelection> {
  const settings = AgentSettingsSchema.parse(input.settings);
  // Inspect structural evidence first so an incorrect ready claim reports its
  // concrete blockers; the public descriptor schema also rejects such claims.
  const harness = HarnessDescriptorSchema.innerType().parse(input.harness);
  const authContext = ModelConnectionAdmissionSchema.pick({ harnessId: true, authContextRef: true }).strict().parse(input.authContext);
  const connection = ModelConnectionAdmissionSchema.parse(input.connection);
  if (harness.harnessId !== settings.selectedHarnessId) throw new RuntimeSelectionError('Selected harness has no matching descriptor');
  const reasons = getHarnessReadyReasons(harness);
  if (reasons.length) throw new RuntimeSelectionError(`Harness is not ready: ${reasons.join(', ')}`);
  if (authContext.harnessId !== harness.harnessId || connection.harnessId !== harness.harnessId) {
    throw new RuntimeSelectionError('Model connection admission belongs to a different harness');
  }
  if (connection.authContextRef !== authContext.authContextRef) {
    throw new RuntimeSelectionError('Model connection admission belongs to a different authentication context');
  }
  if (!connection.ready || connection.readyReasons.length) throw new RuntimeSelectionError('Model connection is not ready');
  if (settings.modelConnectionRef === null || settings.modelConnectionRef !== connection.connection.connectionRef) {
    throw new RuntimeSelectionError('Selected model connection has no matching admission');
  }
  const catalog = parseHarnessCapabilityCatalog(harness.capabilities, harness.harnessId);
  const resolved = resolveHarnessPreferences(settings.harnessPreferences[harness.harnessId], catalog);
  return Object.freeze({
    harnessId: harness.harnessId,
    adapterVersion: harness.adapterVersion,
    authContextRef: authContext.authContextRef,
    connectionRef: connection.connection.connectionRef,
    authGeneration: connection.authGeneration,
    ...resolved,
    configRevision: settings.revision,
  });
}

/** Settings edits do not revoke admitted work. Auth changes have their own guard. */
export function matchesRuntimeAuthentication(selection: RuntimeSelection, value: ModelConnectionAdmission): boolean {
  const current = ModelConnectionAdmissionSchema.parse(value);
  return current.ready && current.readyReasons.length === 0
    && current.harnessId === selection.harnessId
    && current.authContextRef === selection.authContextRef
    && current.connection.connectionRef === selection.connectionRef
    && current.authGeneration === selection.authGeneration;
}
