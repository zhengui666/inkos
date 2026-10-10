import { HarnessIdSchema, type HarnessDescriptor, type HarnessId } from './contracts.js';

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
