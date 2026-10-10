import { describe, expect, it } from 'vitest';
import { AgentSettingsSchema, HarnessDescriptorSchema, ModelConnectionAdmissionSchema, ModelConnectionSchema, type AgentSettings, type HarnessDescriptor } from '../contracts.js';
import { getHarnessReadyReasons, isHarnessReady, parseHarnessCapabilityCatalog, validateHarnessPreferences } from '../capabilities.js';
import { matchesRuntimeAuthentication, resolveRuntimeSelection } from '../selection.js';
import { createHarnessRegistry } from '../registry.js';
import { DEFAULT_AGENT_SETTINGS } from '../settings.js';
import { admission, authContext, catalog, descriptor } from './fixtures.js';

function settings(harnessId: 'codex' | 'pi' = 'codex'): AgentSettings {
  return { ...AgentSettingsSchema.parse(DEFAULT_AGENT_SETTINGS), revision: 42, selectedHarnessId: harnessId, modelConnectionRef: admission().connection.connectionRef };
}

describe('runtime admission selection', () => {
  it('freezes the actual values and separates configuration revision from authentication generation', () => {
    const desired = settings(), harness = descriptor('codex'), connection = admission(), context = authContext();
    const selected = resolveRuntimeSelection({ settings: desired, harness, authContext: context, connection });
    expect(selected).toEqual({ harnessId: 'codex', adapterVersion: 'codex-adapter-test-v1', authContextRef: 'fixture-codex-auth-context', connectionRef: 'opaque-test-connection', authGeneration: 7, modelId: 'gpt-6.1-sol', effort: 'ultra', serviceTier: 'priority', configRevision: 42 });
    expect(Object.isFrozen(selected)).toBe(true);
    desired.revision++; desired.selectedHarnessId = 'pi'; desired.harnessPreferences.codex.model = 'changed';
    harness.adapterVersion = 'changed'; harness.capabilities!.models[0].modelId = 'changed';
    context.authContextRef = 'changed';
    expect(selected.modelId).toBe('gpt-6.1-sol'); expect(selected.configRevision).toBe(42);
    expect(selected.authContextRef).toBe('fixture-codex-auth-context');
    expect(matchesRuntimeAuthentication(selected, connection)).toBe(true);
    expect(() => { (selected as { modelId: string }).modelId = 'changed'; }).toThrow();
    connection.authGeneration++;
    expect(selected.authGeneration).toBe(7); expect(matchesRuntimeAuthentication(selected, connection)).toBe(false);
  });

  it('resolves model:null to the harness native model and native effort/tier', () => {
    const desired = settings('pi');
    expect(resolveRuntimeSelection({ settings: desired, harness: descriptor('pi'), authContext: authContext('pi'), connection: admission('pi') })).toMatchObject({ harnessId: 'pi', modelId: 'pi-native-model', effort: 'low', serviceTier: 'default' });
    desired.harnessPreferences.codex = { model: null, effort: 'ultra', speed: 'priority' };
    desired.selectedHarnessId = 'codex';
    const codex = descriptor('codex');
    codex.capabilities!.models.push({ ...codex.capabilities!.models[0], modelId: 'codex-native-other' });
    codex.capabilities!.nativeDefaults.modelId = 'codex-native-other';
    expect(resolveRuntimeSelection({ settings: desired, harness: codex, authContext: authContext(), connection: admission() })).toMatchObject({ modelId: 'codex-native-other', effort: 'ultra', serviceTier: 'priority' });
  });

  it('rejects wrong harnesses, model catalogs and unknown Pi readiness without fallback', () => {
    const desired = settings('pi');
    expect(() => resolveRuntimeSelection({ settings: desired, harness: descriptor('codex'), authContext: authContext('pi'), connection: admission('pi') })).toThrow('matching descriptor');
    const pi = descriptor('pi');
    pi.capabilities = catalog('codex');
    expect(isHarnessReady(pi)).toBe(false);
    expect(() => resolveRuntimeSelection({ settings: desired, harness: pi, authContext: authContext('pi'), connection: admission('pi') })).toThrow('not ready');
    pi.capabilities = null;
    expect(HarnessDescriptorSchema.safeParse(pi).success).toBe(false);
    expect(getHarnessReadyReasons(pi)).toContain('unknown-capabilities'); expect(isHarnessReady(pi)).toBe(false);
    expect(() => resolveRuntimeSelection({ settings: desired, harness: pi, authContext: authContext('pi'), connection: admission('pi') })).toThrow('unknown-capabilities');
    pi.capabilities = catalog('pi'); pi.capabilities.adapterVersion = 'old-version';
    expect(getHarnessReadyReasons(pi)).toContain('capability-version-mismatch');
  });

  it('requires installation, supported deployment, real runtime version and all needed capabilities', () => {
    const patches: Partial<HarnessDescriptor>[] = [{ installation: 'missing' }, { deployment: 'unknown' }, { runtimeVersion: null }, { ready: false }, { readyReasons: ['probe-failed'] }];
    for (const patch of patches) {
      expect(isHarnessReady({ ...descriptor('pi'), ...patch })).toBe(false);
    }
    for (const capability of ['supportsChatGptOauth', 'supportsTools', 'supportsStreaming'] as const) {
      const pi = descriptor('pi'); pi.capabilities![capability] = false; expect(isHarnessReady(pi)).toBe(false);
    }
  });

  it('checks actual model-specific efforts and service tiers', () => {
    const desired = settings('pi');
    desired.harnessPreferences.pi = { model: 'gpt-6.1-sol', effort: null, speed: null };
    expect(() => resolveRuntimeSelection({ settings: desired, harness: descriptor('pi'), authContext: authContext('pi'), connection: admission('pi') })).toThrow('absent from this harness');
    desired.harnessPreferences.pi = { model: 'pi-native-model', effort: 'invented', speed: null };
    expect(() => resolveRuntimeSelection({ settings: desired, harness: descriptor('pi'), authContext: authContext('pi'), connection: admission('pi') })).toThrow('Unsupported effort');
    desired.harnessPreferences.pi = { model: 'pi-native-model', effort: null, speed: 'invented' };
    expect(() => resolveRuntimeSelection({ settings: desired, harness: descriptor('pi'), authContext: authContext('pi'), connection: admission('pi') })).toThrow('Unsupported service tier');
    desired.harnessPreferences.pi = { model: 'pi-native-model', effort: null, speed: null };
    expect(resolveRuntimeSelection({ settings: desired, harness: descriptor('pi'), authContext: authContext('pi'), connection: admission('pi') })).toMatchObject({ effort: 'low', serviceTier: 'default' });
  });

  it('rejects incomplete and ambiguous catalogs rather than guessing their defaults', () => {
    const value = catalog('pi'); value.nativeDefaults.modelId = 'unknown';
    expect(() => parseHarnessCapabilityCatalog(value, 'pi')).toThrow('Native defaults');
    value.nativeDefaults.modelId = 'pi-native-model'; value.models.push({ ...value.models[0] });
    expect(() => parseHarnessCapabilityCatalog(value, 'pi')).toThrow('Duplicate model');
    value.models.pop(); value.models[0].defaultEffort = 'unknown';
    expect(() => parseHarnessCapabilityCatalog(value, 'pi')).toThrow('Model defaults');
    expect(() => validateHarnessPreferences('pi', { model: null, effort: null, speed: null })).not.toThrow();
    expect(() => validateHarnessPreferences('pi', { model: null, effort: 'low', speed: null })).toThrow('require');
  });

  it('rejects mismatched, disconnected or changed authentication independently', () => {
    const desired = settings(); const input = { settings: desired, harness: descriptor('codex'), authContext: authContext(), connection: admission() };
    desired.modelConnectionRef = null; expect(() => resolveRuntimeSelection(input)).toThrow('matching admission');
    desired.modelConnectionRef = 'different'; expect(() => resolveRuntimeSelection(input)).toThrow('matching admission');
    desired.modelConnectionRef = admission().connection.connectionRef; input.connection.ready = false;
    expect(() => resolveRuntimeSelection(input)).toThrow('not ready');
    input.connection.ready = true; input.connection.readyReasons = ['revoked'];
    expect(() => resolveRuntimeSelection(input)).toThrow('not ready');
    input.connection = admission(); const selected = resolveRuntimeSelection(input);
    input.connection.connection.connectionRef = 'different'; expect(matchesRuntimeAuthentication(selected, input.connection)).toBe(false);
  });

  it('accepts only ChatGPT OAuth references and rejects all credential fields', () => {
    const connection = admission().connection;
    expect(ModelConnectionSchema.parse(connection)).toEqual(connection);
    for (const patch of [{ provider: 'openai' }, { authMethod: 'apiKey' }, { accessToken: 'test-secret' }, { refreshToken: 'test-secret' }, { apiKey: 'test-secret' }, { auth: {} }]) {
      expect(ModelConnectionSchema.safeParse({ ...connection, ...patch }).success).toBe(false);
    }
    const selected = resolveRuntimeSelection({ settings: settings(), harness: descriptor('codex'), authContext: authContext(), connection: admission() });
    expect(Object.keys(selected).sort()).toEqual(['adapterVersion', 'authContextRef', 'authGeneration', 'configRevision', 'connectionRef', 'effort', 'harnessId', 'modelId', 'serviceTier'].sort());
    expect(JSON.stringify(selected)).not.toMatch(/token|secret|apiKey/i);
  });

  it('rejects a Codex-only login on Pi even when the connection ref and generation match', () => {
    const codexLogin = admission();
    const piLogin = admission('pi');
    expect(codexLogin.connection.connectionRef).toBe(piLogin.connection.connectionRef);
    expect(codexLogin.authGeneration).toBe(piLogin.authGeneration);
    expect(() => resolveRuntimeSelection({ settings: settings('pi'), harness: descriptor('pi'), authContext: authContext('pi'), connection: codexLogin })).toThrow('different harness');
    expect(() => resolveRuntimeSelection({ settings: settings('pi'), harness: descriptor('pi'), authContext: authContext(), connection: piLogin })).toThrow('different harness');
  });

  it('rejects another actual authentication context rather than trusting an admission ref alone', () => {
    const input = { settings: settings(), harness: descriptor('codex'), authContext: authContext(), connection: admission() };
    input.authContext.authContextRef = 'another-actual-context';
    expect(() => resolveRuntimeSelection(input)).toThrow('different authentication context');
    input.authContext = authContext(); input.connection.authContextRef = 'stale-admission-context';
    expect(() => resolveRuntimeSelection(input)).toThrow('different authentication context');
  });

  it.each(['codex', 'pi'] as const)('admits a ready connection bound to the actual %s context', harnessId => {
    const selected = resolveRuntimeSelection({ settings: settings(harnessId), harness: descriptor(harnessId), authContext: authContext(harnessId), connection: admission(harnessId) });
    expect(selected).toMatchObject({ harnessId, authContextRef: authContext(harnessId).authContextRef, connectionRef: admission(harnessId).connection.connectionRef });
    expect(matchesRuntimeAuthentication(selected, admission(harnessId))).toBe(true);
  });

  it('requires explicit owner bindings and keeps both admission and context credential-free', () => {
    const connection = admission();
    for (const patch of [{ harnessId: undefined }, { authContextRef: undefined }, { authContextRef: '' }, { apiKey: 'synthetic-secret' }, { accessToken: 'synthetic-secret' }]) {
      expect(ModelConnectionAdmissionSchema.safeParse({ ...connection, ...patch }).success).toBe(false);
    }
    const input = { settings: settings(), harness: descriptor('codex'), authContext: authContext(), connection };
    expect(() => resolveRuntimeSelection({ ...input, authContext: undefined as never })).toThrow();
    expect(() => resolveRuntimeSelection({ ...input, authContext: { ...input.authContext, apiKey: 'synthetic-secret' } as never })).toThrow();
  });

  it('revokes the authentication guard on harness or context changes without a generation change', () => {
    const connection = admission();
    const selected = resolveRuntimeSelection({ settings: settings(), harness: descriptor('codex'), authContext: authContext(), connection });
    connection.harnessId = 'pi';
    expect(matchesRuntimeAuthentication(selected, connection)).toBe(false);
    connection.harnessId = 'codex'; connection.authContextRef = 'replacement-context';
    expect(matchesRuntimeAuthentication(selected, connection)).toBe(false);
    expect(selected.authContextRef).toBe(authContext().authContextRef);
    expect(selected.authGeneration).toBe(connection.authGeneration);
  });

  it('registers only actual adapters and never supplies a Pi implementation implicitly', () => {
    const adapter = { harnessId: 'codex' as const, adapterVersion: 'test-v1', describe: async () => descriptor('codex') };
    const registry = createHarnessRegistry([adapter]);
    expect(registry.get('codex')).toBe(adapter); expect(registry.get('pi')).toBeUndefined();
    expect(Object.isFrozen(registry.list())).toBe(true);
    expect(() => createHarnessRegistry([adapter, adapter])).toThrow('Duplicate');
  });
});
