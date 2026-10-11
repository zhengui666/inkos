import { HarnessIdSchema, type HarnessDescriptor, type HarnessId } from './contracts.js';
import type { PiRuntimeContext } from './adapters/pi/runtime-context.js';

/** Implementations probe their real harness. This contract supplies no Pi adapter. */
export interface HarnessAdapter {
  readonly harnessId: HarnessId;
  readonly adapterVersion: string;
  describe(): Promise<HarnessDescriptor>;
}

export interface HarnessRegistry {
  get(harnessId: HarnessId): HarnessAdapter | undefined;
  list(): readonly HarnessAdapter[];
}

/** Capabilities are observed from real per-model sessions in the installed SDK. */
export class PiRuntimeAdapter implements HarnessAdapter {
  readonly harnessId = 'pi' as const;
  readonly adapterVersion = 'inkos-pi-1.1.0';
  constructor(private readonly runtime: PiRuntimeContext) {}
  async describe(): Promise<HarnessDescriptor> {
    const native = await this.runtime.observeDefaults();
    if (!native.model) throw new Error('Pi native default model was not observed');
    const models = [];
    for (const model of this.runtime.getModels()) {
      const observation = model.id === native.model.modelId ? native : await this.runtime.observeDefaults(undefined, model.id);
      if (observation.model?.modelId !== model.id || !observation.availableThinkingLevels.length) throw new Error('Pi model capabilities were not observed');
      models.push({ modelId: model.id, efforts: [...observation.availableThinkingLevels], serviceTiers: [],
        defaultEffort: observation.thinkingLevel, defaultServiceTier: null });
    }
    return { harnessId: 'pi', adapterVersion: this.adapterVersion, runtimeVersion: '1.1.0', installation: 'installed',
      deployment: 'supported', ready: true, readyReasons: [], capabilities: { harnessId: 'pi', adapterVersion: this.adapterVersion,
        supportsChatGptOauth: true, supportsTools: true, supportsStreaming: true, models,
        nativeDefaults: { modelId: native.model.modelId, effort: native.thinkingLevel, serviceTier: null } } };
  }
}

export function createHarnessRegistry(adapters: readonly HarnessAdapter[]): HarnessRegistry {
  const entries = new Map<HarnessId, HarnessAdapter>();
  for (const adapter of adapters) {
    HarnessIdSchema.parse(adapter.harnessId);
    if (!adapter.adapterVersion.trim()) throw new Error('Harness adapter version is required');
    if (entries.has(adapter.harnessId)) throw new Error('Duplicate harness adapter');
    entries.set(adapter.harnessId, adapter);
  }
  const list = Object.freeze([...entries.values()]);
  return Object.freeze({ get: (harnessId: HarnessId) => entries.get(harnessId), list: () => list });
}
