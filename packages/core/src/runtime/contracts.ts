import { z } from 'zod';

export const HarnessIdSchema = z.enum(['codex', 'pi']);
export type HarnessId = z.infer<typeof HarnessIdSchema>;
export const RuntimeIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/);
const ConnectionRefSchema = z.string().min(1).max(512).regex(/^[^\s\u0000-\u001f]+$/);
export const RuntimeRevisionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const VersionSchema = z.string().min(1).max(128).refine(value => value.trim().length > 0, 'Version must not be blank');

/** A credential-free reference. Authentication storage belongs to the connection owner. */
export const ModelConnectionSchema = z.object({
  provider: z.literal('chatgpt'),
  authMethod: z.literal('oauth'),
  connectionRef: ConnectionRefSchema,
}).strict();
export type ModelConnection = z.infer<typeof ModelConnectionSchema>;

/** null means the selected harness's native default, never another harness's default. */
export const HarnessPreferencesSchema = z.object({
  model: RuntimeIdSchema.nullable(),
  effort: RuntimeIdSchema.nullable(),
  speed: RuntimeIdSchema.nullable(),
}).strict();
export type HarnessPreferences = z.infer<typeof HarnessPreferencesSchema>;

export const AGENT_SETTINGS_SCHEMA_VERSION = 1;
export const AgentSettingsSchema = z.object({
  schemaVersion: z.literal(AGENT_SETTINGS_SCHEMA_VERSION),
  revision: RuntimeRevisionSchema,
  selectedHarnessId: HarnessIdSchema,
  modelConnectionRef: ConnectionRefSchema.nullable(),
  harnessPreferences: z.object({
    codex: HarnessPreferencesSchema,
    pi: HarnessPreferencesSchema,
  }).strict(),
}).strict();
export type AgentSettings = z.infer<typeof AgentSettingsSchema>;

export const HarnessModelCapabilitySchema = z.object({
  modelId: RuntimeIdSchema,
  efforts: z.array(RuntimeIdSchema),
  serviceTiers: z.array(RuntimeIdSchema),
  defaultEffort: RuntimeIdSchema.nullable(),
  defaultServiceTier: RuntimeIdSchema.nullable(),
}).strict();
export type HarnessModelCapability = z.infer<typeof HarnessModelCapabilitySchema>;

export const HarnessCapabilityCatalogSchema = z.object({
  harnessId: HarnessIdSchema,
  adapterVersion: VersionSchema,
  supportsChatGptOauth: z.boolean(),
  supportsTools: z.boolean(),
  supportsStreaming: z.boolean(),
  models: z.array(HarnessModelCapabilitySchema).min(1),
  nativeDefaults: z.object({
    modelId: RuntimeIdSchema,
    effort: RuntimeIdSchema.nullable(),
    serviceTier: RuntimeIdSchema.nullable(),
  }).strict(),
}).strict().superRefine((catalog, context) => {
  const invalid = (message: string) => context.addIssue({ code: z.ZodIssueCode.custom, message });
  const ids = catalog.models.map(model => model.modelId);
  if (new Set(ids).size !== ids.length) invalid('Duplicate model IDs in capability catalog');
  for (const model of catalog.models) {
    if (new Set(model.efforts).size !== model.efforts.length || new Set(model.serviceTiers).size !== model.serviceTiers.length) {
      invalid('Duplicate effort or service tier in capability catalog');
    }
    if ((model.defaultEffort !== null && !model.efforts.includes(model.defaultEffort))
      || (model.defaultServiceTier !== null && !model.serviceTiers.includes(model.defaultServiceTier))) {
      invalid('Model defaults are absent from capability catalog');
    }
  }
  const native = catalog.models.find(model => model.modelId === catalog.nativeDefaults.modelId);
  if (!native || (catalog.nativeDefaults.effort !== null && !native.efforts.includes(catalog.nativeDefaults.effort))
    || (catalog.nativeDefaults.serviceTier !== null && !native.serviceTiers.includes(catalog.nativeDefaults.serviceTier))) {
    invalid('Native defaults are absent from capability catalog');
  }
});
export type HarnessCapabilityCatalog = z.infer<typeof HarnessCapabilityCatalogSchema>;

/** Observed installation/version/capabilities, supplied by an actual adapter probe. */
export const HarnessDescriptorSchema = z.object({
  harnessId: HarnessIdSchema,
  adapterVersion: VersionSchema,
  runtimeVersion: VersionSchema.nullable(),
  installation: z.enum(['installed', 'missing', 'unknown']),
  deployment: z.enum(['supported', 'unsupported', 'unknown']),
  capabilities: HarnessCapabilityCatalogSchema.nullable(),
  ready: z.boolean(),
  readyReasons: z.array(z.string().min(1)),
}).strict().superRefine((descriptor, context) => {
  const capabilities = descriptor.capabilities;
  if (descriptor.ready && (descriptor.installation !== 'installed' || descriptor.deployment !== 'supported'
    || descriptor.runtimeVersion === null || descriptor.readyReasons.length !== 0 || capabilities === null
    || capabilities.harnessId !== descriptor.harnessId || capabilities.adapterVersion !== descriptor.adapterVersion
    || !capabilities.supportsChatGptOauth || !capabilities.supportsTools || !capabilities.supportsStreaming)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['ready'], message: 'Harness is not ready: inconsistent readiness evidence' });
  }
});
export type HarnessDescriptor = z.infer<typeof HarnessDescriptorSchema>;

/** The authentication owner supplies the actual harness/context binding.
 * These references contain no credentials and cannot establish login by themselves.
 * Authentication generation is independent of configuration revision.
 */
export const ModelConnectionAdmissionSchema = z.object({
  harnessId: HarnessIdSchema,
  authContextRef: ConnectionRefSchema,
  connection: ModelConnectionSchema,
  authGeneration: RuntimeRevisionSchema,
  ready: z.boolean(),
  readyReasons: z.array(z.string().min(1)),
}).strict();
export type ModelConnectionAdmission = z.infer<typeof ModelConnectionAdmissionSchema>;

export interface RuntimeSelection {
  readonly harnessId: HarnessId;
  readonly adapterVersion: string;
  readonly authContextRef: string;
  readonly connectionRef: string;
  readonly authGeneration: number;
  readonly modelId: string;
  readonly effort: string | null;
  readonly serviceTier: string | null;
  readonly configRevision: number;
}
