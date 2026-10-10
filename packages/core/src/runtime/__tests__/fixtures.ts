import type { HarnessCapabilityCatalog, HarnessDescriptor, ModelConnectionAdmission } from '../contracts.js';

export function catalog(harnessId: 'codex' | 'pi'): HarnessCapabilityCatalog {
  const modelId = harnessId === 'codex' ? 'gpt-6.1-sol' : 'pi-native-model';
  return {
    harnessId, adapterVersion: `${harnessId}-adapter-test-v1`,
    supportsChatGptOauth: true, supportsTools: true, supportsStreaming: true,
    models: [{ modelId, efforts: ['low', 'ultra'], serviceTiers: ['default', 'priority'], defaultEffort: 'low', defaultServiceTier: 'default' }],
    nativeDefaults: { modelId, effort: 'low', serviceTier: 'default' },
  };
}

export function descriptor(harnessId: 'codex' | 'pi'): HarnessDescriptor {
  return {
    harnessId, adapterVersion: `${harnessId}-adapter-test-v1`, runtimeVersion: 'fixture-1.0.0',
    installation: 'installed', deployment: 'supported', capabilities: catalog(harnessId), ready: true, readyReasons: [],
  };
}

export function admission(): ModelConnectionAdmission {
  return { connection: { provider: 'chatgpt', authMethod: 'oauth', connectionRef: 'opaque-test-connection' }, authGeneration: 7, ready: true, readyReasons: [] };
}
