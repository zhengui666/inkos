import { CODEX_APP_SERVER_VERSION, type CodexClient } from '../../../codex/app-server.js';
import { readCodexModels } from '../../../codex/account.js';
import type { CodexModel } from '../../../codex/types.js';
import { HarnessDescriptorSchema, type HarnessDescriptor, type HarnessPreferences } from '../../contracts.js';
import type { HarnessAdapter } from '../../registry.js';

export const CODEX_ADAPTER_VERSION = `codex-app-server-${CODEX_APP_SERVER_VERSION}-v1`;
export interface CodexNativeDefaultsEvidence {
  readonly model: 'config/read' | 'model/list-default';
  readonly effort: 'config/read' | 'model/list-default';
  readonly serviceTier: 'config/read' | 'model/list-default';
}
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};

/** Catalog/config probes only; no Pi implementation or provider fallback. */
export class CodexRuntimeAdapter implements HarnessAdapter {
  readonly harnessId = 'codex' as const;
  readonly adapterVersion = CODEX_ADAPTER_VERSION;
  private models: CodexModel[] = [];
  nativeDefaultsEvidence: Readonly<CodexNativeDefaultsEvidence> | null = null;
  constructor(private readonly client: CodexClient, private readonly signal?: AbortSignal) {}
  async describe(): Promise<HarnessDescriptor> {
    this.models = await readCodexModels(this.client, this.signal);
    const response = object(await this.client.request('config/read', { includeLayers: false }, { signal: this.signal }));
    const config = object(response.config);
    const defaults = this.models.filter(model => model.isDefault);
    const native = typeof config.model === 'string' && config.model
      ? this.models.find(model => model.model === config.model || model.id === config.model)
      : new Set(defaults.map(model => model.model)).size === 1 ? defaults[0] : undefined;
    if (!native) throw new Error('Codex did not advertise an unambiguous native model');
    const effort = typeof config.model_reasoning_effort === 'string' ? config.model_reasoning_effort : native.defaultReasoningEffort || null;
    const tier = typeof config.service_tier === 'string' ? config.service_tier : native.defaultServiceTier;
    this.nativeDefaultsEvidence = Object.freeze({ model: typeof config.model === 'string' && config.model ? 'config/read' : 'model/list-default',
      effort: typeof config.model_reasoning_effort === 'string' ? 'config/read' : 'model/list-default',
      serviceTier: typeof config.service_tier === 'string' ? 'config/read' : 'model/list-default' });
    return HarnessDescriptorSchema.parse({ harnessId: 'codex', adapterVersion: this.adapterVersion,
      runtimeVersion: CODEX_APP_SERVER_VERSION, installation: 'installed', deployment: 'supported', ready: true, readyReasons: [],
      capabilities: { harnessId: 'codex', adapterVersion: this.adapterVersion,
        supportsChatGptOauth: true, supportsTools: true, supportsStreaming: true,
        models: [...new Map(this.models.map(model => [model.model, model])).values()].map(model => ({ modelId: model.model,
          efforts: model.supportedReasoningEfforts.map(option => option.reasoningEffort),
          // Standard is explicitly specified by the pinned turn protocol, not a guessed Fast tier.
          serviceTiers: [...new Set(['default', ...model.serviceTiers.map(option => option.id)])],
          defaultEffort: model.defaultReasoningEffort || null, defaultServiceTier: model.defaultServiceTier,
        })), nativeDefaults: { modelId: native.model, effort, serviceTier: tier },
      },
    });
  }
  canonicalPreferences(preferences: HarnessPreferences): HarnessPreferences {
    const model = preferences.model === null ? null
      : this.models.find(model => model.model === preferences.model || model.id === preferences.model)?.model ?? preferences.model;
    return { ...preferences, model };
  }
}
