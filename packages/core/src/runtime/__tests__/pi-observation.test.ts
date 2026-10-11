import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { observePiRuntime, type PiRuntimeObservation } from '../../index.js';
import { PiRuntimeAdapter } from '../registry.js';
import { PiAuthenticationOwner } from '../auth/pi-owner.js';
import { createPiRuntimeContext } from '../adapters/pi/runtime-context.js';
import * as nativeStore from '../auth/pi-native-store-compat.js';

const installation = vi.hoisted(() => ({ missing: false, unsupported: false }));
vi.mock('node:module', async importOriginal => {
  const actual = await importOriginal<typeof import('node:module')>();
  return { ...actual, findPackageJSON: (...args: Parameters<typeof actual.findPackageJSON>) =>
    installation.missing && args[0] === '@earendil-works/pi-coding-agent' ? undefined : actual.findPackageJSON(...args) };
});
vi.mock('../auth/pi-native-store-compat.js', async () => {
  const { createRequire } = await import('node:module');
  const actual = createRequire(import.meta.url)('../auth/pi-native-store-compat.ts');
  return { ...actual, loadPiNativeAuthStorage: async () => {
    if (installation.unsupported) throw new Error('Unsupported SDK API');
    return actual.loadPiNativeAuthStorage();
  } };
});
const codex = vi.hoisted(() => vi.fn(async () => { throw new Error('Codex observation forbidden'); }));
vi.mock('../../codex/client.js', () => ({ createCodexClient: codex }));

let root: string, project: string, agentDir: string, network: ReturnType<typeof vi.fn>;
type CallSpy = { mockClear(): unknown };
let createStorage: CallSpy, modifyStorage: CallSpy, deleteStorage: CallSpy;
let getAuth: CallSpy, externalRefresh: boolean;
const oauth = (suffix = 'first', expires = Date.now() + 3_600_000) => ({ type: 'oauth', access: `synthetic-access-${suffix}`, refresh: `synthetic-refresh-${suffix}`, expires });
async function disk(path = root): Promise<Record<string, string | null>> {
  const result: Record<string, string | null> = {};
  async function walk(directory: string, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isDirectory()) { result[name + '/'] = null; await walk(join(directory, entry.name), name + '/'); }
      else result[name] = (await readFile(join(directory, entry.name))).toString('base64');
    }
  }
  await walk(path); return result;
}
async function credentials(value: unknown = { openai: oauth() }) {
  await mkdir(agentDir); await writeFile(join(agentDir, 'auth.json'), typeof value === 'string' ? value : JSON.stringify(value));
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'openai', defaultModel: 'gpt-5.4', defaultThinkingLevel: 'low' }));
}
async function readyOwner() {
  const owner = await PiAuthenticationOwner.create(project), admitted = await owner.admit();
  createStorage.mockClear(); modifyStorage.mockClear(); deleteStorage.mockClear();
  return { owner, admitted, recordPath: join(agentDir, 'inkos-connection.json') };
}
function noSecrets(value: PiRuntimeObservation) {
  const text = JSON.stringify(value);
  for (const forbidden of [root, 'credentialRef', 'synthetic-access', 'synthetic-refresh', 'clientId', 'email', 'subject']) expect(text).not.toContain(forbidden);
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'inkos-pi-observe-')); project = join(root, 'project'); agentDir = join(root, 'agent');
  await mkdir(project); vi.stubEnv('PI_CODING_AGENT_DIR', agentDir); installation.missing = false; installation.unsupported = false; externalRefresh = false;
  network = vi.fn(async () => { throw new Error('Network forbidden'); }); vi.stubGlobal('fetch', network); codex.mockClear();
  const { AuthStorage } = await nativeStore.loadPiNativeAuthStorage();
  createStorage = vi.spyOn(AuthStorage, 'create'); modifyStorage = vi.spyOn(AuthStorage.prototype, 'modify'); deleteStorage = vi.spyOn(AuthStorage.prototype, 'delete');
  getAuth = vi.spyOn(ModelRuntime.prototype, 'getAuth');
});
afterEach(async () => {
  expect(network).not.toHaveBeenCalled(); expect(codex).not.toHaveBeenCalled(); expect(createStorage).not.toHaveBeenCalled();
  expect(deleteStorage).not.toHaveBeenCalled();
  if (!externalRefresh) { expect(modifyStorage).not.toHaveBeenCalled(); expect(getAuth).not.toHaveBeenCalled(); }
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true });
});

describe('public Pi installation, local OAuth and scoped catalog observation', () => {
  it('separates a missing SDK entry from authentication and creates no files', async () => {
    installation.missing = true; const before = await disk();
    const value: PiRuntimeObservation = await observePiRuntime(project);
    expect(value).toMatchObject({ harnessId: 'pi', installation: 'missing', authentication: 'unknown', authContextRef: null,
      owner: null, descriptor: null, catalogOwnership: null, ready: false });
    expect(value.readyReasons).toContain('pi-sdk-missing'); expect(await disk()).toEqual(before);
  });
  it('keeps failed SDK API inspection unknown rather than missing authentication', async () => {
    installation.unsupported = true;
    const before = await disk(), value = await observePiRuntime(project);
    expect(value.installation).toBe('unknown'); expect(value.authentication).toBe('unknown'); expect(value.ready).toBe(false);
    expect(value.owner).toBeNull(); expect(value.descriptor).toBeNull(); expect(await disk()).toEqual(before);
  });
  it('reports installed SDK and missing auth without creating the absent native directory', async () => {
    const before = await disk(), value = await observePiRuntime(project);
    expect(value).toMatchObject({ installation: 'installed', authentication: 'missing', owner: null, descriptor: null, catalogOwnership: null, ready: false });
    expect(value.authContextRef).toMatch(/^pi-context-/); expect(await disk()).toEqual(before); noSecrets(value);
  });
  it('has no trusted scope when the project root cannot be resolved', async () => {
    const before = await disk(), value = await observePiRuntime(join(root, 'missing-project'));
    expect(value).toMatchObject({ installation: 'installed', authContextRef: null, authentication: 'unknown', owner: null, descriptor: null, ready: false });
    expect(await disk()).toEqual(before);
  });
  it.each([{}, { other: { type: 'api_key', key: 'synthetic-other' } }])('reports missing OpenAI auth only from a readable native object (%j)', async value => {
    await credentials(value); const before = await disk(), observed = await observePiRuntime(project);
    expect(observed).toMatchObject({ installation: 'installed', authentication: 'missing', owner: null, descriptor: null, ready: false });
    expect(await disk()).toEqual(before); noSecrets(observed);
  });
  it.each(['{bad JSON', 'null', [], { openai: { type: 'api_key', key: 'synthetic-key' } }, { openai: { type: 'oauth', access: 'synthetic-access' } }])('keeps malformed or non-OAuth auth unknown (%j)', async value => {
    await credentials(value); const before = await disk(), observed = await observePiRuntime(project);
    expect(observed).toMatchObject({ installation: 'installed', authentication: 'unknown', owner: null, descriptor: null, ready: false });
    expect(observed.authContextRef).toMatch(/^pi-context-/); expect(await disk()).toEqual(before); noSecrets(observed);
  });
  it('publishes real per-model thinking/defaults in OAuth cold state with no manufactured owner', async () => {
    await credentials(); const before = await disk(), value: PiRuntimeObservation = await observePiRuntime(project);
    expect(value).toMatchObject({ installation: 'installed', authentication: 'oauth-present', owner: null, ready: true, readyReasons: [] });
    expect(value.descriptor).toMatchObject({ harnessId: 'pi', runtimeVersion: '1.1.0', adapterVersion: 'inkos-pi-1.1.0' });
    expect(value.descriptor!.capabilities!.nativeDefaults).toEqual({ modelId: 'gpt-5.4', effort: 'low', serviceTier: null });
    for (const model of value.descriptor!.capabilities!.models) { expect(model.efforts.length).toBeGreaterThan(0); expect(model.serviceTiers).toEqual([]); }
    expect(value.catalogOwnership).toEqual({ harnessId: 'pi', authContextRef: value.authContextRef, authGeneration: null, adapterVersion: 'inkos-pi-1.1.0' });
    expect(Object.isFrozen(value)).toBe(true); expect(Object.isFrozen(value.descriptor!.capabilities!.models)).toBe(true);
    expect(await disk()).toEqual(before); noSecrets(value);
  });
  it('publishes the actual ready owner and catalog from one stable envelope without writes', async () => {
    await credentials(); const { admitted } = await readyOwner(), before = await disk(), value = await observePiRuntime(project);
    expect(value.owner).toEqual(admitted); expect(value.catalogOwnership?.authGeneration).toBe(admitted.authGeneration);
    expect(value.catalogOwnership?.authContextRef).toBe(admitted.authContextRef); expect(value.ready).toBe(true);
    expect(Object.isFrozen(value.owner!.connection)).toBe(true); expect(Object.isFrozen(value.owner!.readyReasons)).toBe(true);
    expect(await disk()).toEqual(before); noSecrets(value);
  });
  it('uses official settings parsing without entering native file settings locks', async () => {
    await credentials();
    const before = await disk();
    const fileSettings = vi.spyOn(SettingsManager, 'create').mockImplementation(() => { throw new Error('Native settings locks forbidden during observation'); });
    const memorySettings = vi.spyOn(SettingsManager, 'fromStorage');
    const value = await observePiRuntime(project);
    expect(value).toMatchObject({ authentication: 'oauth-present', owner: null, ready: true });
    expect(value.descriptor!.capabilities!.nativeDefaults).toEqual({ modelId: 'gpt-5.4', effort: 'low', serviceTier: null });
    expect(memorySettings).toHaveBeenCalled(); expect(fileSettings).not.toHaveBeenCalled();
    expect(await disk()).toEqual(before); noSecrets(value);
  });
  it('retains official BOM parsing and ignores untrusted project defaults without creating locks', async () => {
    await credentials();
    await writeFile(join(agentDir, 'settings.json'), '\uFEFF' + JSON.stringify({ defaultProvider: 'openai', defaultModel: 'gpt-5.4', defaultThinkingLevel: 'low' }));
    await mkdir(join(project, '.pi')); await writeFile(join(project, '.pi', 'settings.json'), '{invalid untrusted project settings');
    const before = await disk();
    const fileSettings = vi.spyOn(SettingsManager, 'create').mockImplementation(() => { throw new Error('Native settings locks forbidden during observation'); });
    const value = await observePiRuntime(project);
    expect(value.ready).toBe(true); expect(value.descriptor!.capabilities!.nativeDefaults).toEqual({ modelId: 'gpt-5.4', effort: 'low', serviceTier: null });
    expect(fileSettings).not.toHaveBeenCalled(); expect(await disk()).toEqual(before); noSecrets(value);
  });
  it('fails closed on malformed global settings while retaining independently observed local OAuth', async () => {
    await credentials(); await writeFile(join(agentDir, 'settings.json'), '{malformed global settings');
    const before = await disk();
    const fileSettings = vi.spyOn(SettingsManager, 'create').mockImplementation(() => { throw new Error('Native settings locks forbidden during observation'); });
    const value = await observePiRuntime(project);
    expect(value).toMatchObject({ authentication: 'oauth-present', owner: null, descriptor: null, catalogOwnership: null, ready: false, readyReasons: ['pi-catalog-unverified'] });
    expect(fileSettings).not.toHaveBeenCalled(); expect(await disk()).toEqual(before); noSecrets(value);
  });
  it.each([false, true])('retains stable OAuth evidence when the native catalog fails (owner=%s)', async warm => {
    await credentials(); const admitted = warm ? (await readyOwner()).admitted : null;
    await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'other-provider', defaultModel: 'unobserved-model' }));
    const before = await disk(), value = await observePiRuntime(project);
    expect(value).toMatchObject({ installation: 'installed', authentication: 'oauth-present', descriptor: null, catalogOwnership: null, ready: false });
    expect(value.owner).toEqual(admitted); expect(value.readyReasons).toEqual(['pi-catalog-unverified']); expect(await disk()).toEqual(before); noSecrets(value);
  });
  it.each(['state', 'pending', 'connection'] as const)('rejects same-generation owner %s changes during actual catalog inspection', async mode => {
    await credentials(); const { recordPath } = await readyOwner(), record = JSON.parse(await readFile(recordPath, 'utf8'));
    const describe = PiRuntimeAdapter.prototype.describe;
    const inspection = vi.spyOn(PiRuntimeAdapter.prototype, 'describe').mockImplementationOnce(async function (this: PiRuntimeAdapter) {
      const descriptor = await describe.call(this);
      const next = mode === 'state' ? { ...record, localState: 'unknown' } : mode === 'pending'
        ? { ...record, pendingRefresh: { operationId: 'external-pending', authGeneration: record.authGeneration } }
        : { ...record, connectionRef: 'external-connection' };
      await writeFile(recordPath, JSON.stringify(next)); return descriptor;
    });
    const value = await observePiRuntime(project);
    expect(inspection).toHaveBeenCalledOnce();
    expect(value).toMatchObject({ authentication: 'unknown', owner: null, descriptor: null, catalogOwnership: null, ready: false });
    expect(JSON.parse(await readFile(recordPath, 'utf8')).authGeneration).toBe(record.authGeneration); noSecrets(value);
  });
  it.each([false, true])('rejects replacement credentials even when catalog inspection %s', async catalogFails => {
    await credentials(); await readyOwner(); const describe = PiRuntimeAdapter.prototype.describe;
    const inspection = vi.spyOn(PiRuntimeAdapter.prototype, 'describe').mockImplementationOnce(async function (this: PiRuntimeAdapter) {
      const descriptor = await describe.call(this); await writeFile(join(agentDir, 'auth.json'), JSON.stringify({ openai: oauth('replacement') }));
      if (catalogFails) throw new Error('Catalog unavailable'); return descriptor;
    });
    const value = await observePiRuntime(project);
    expect(inspection).toHaveBeenCalledOnce();
    expect(value).toMatchObject({ authentication: 'unknown', owner: null, descriptor: null, catalogOwnership: null, ready: false }); noSecrets(value);
  });
  it.each(['unknown', 'pending'] as const)('does not inspect or settle an existing %s owner', async mode => {
    await credentials(); const { recordPath } = await readyOwner(), record = JSON.parse(await readFile(recordPath, 'utf8'));
    await writeFile(recordPath, JSON.stringify(mode === 'unknown' ? { ...record, localState: 'unknown' }
      : { ...record, pendingRefresh: { operationId: 'unproven-refresh', authGeneration: record.authGeneration } }));
    const describe = vi.spyOn(PiRuntimeAdapter.prototype, 'describe'), before = await disk(), value = await observePiRuntime(project);
    expect(value).toMatchObject({ authentication: 'unknown', owner: null, descriptor: null, catalogOwnership: null, ready: false });
    expect(describe).not.toHaveBeenCalled(); expect(await disk()).toEqual(before);
  });
  it('drops the old trusted scope when the native auth deployment changes during the catalog', async () => {
    await credentials(); const other = join(root, 'different-agent'); await mkdir(other);
    const before = await disk(), describe = PiRuntimeAdapter.prototype.describe;
    const inspection = vi.spyOn(PiRuntimeAdapter.prototype, 'describe').mockImplementationOnce(async function (this: PiRuntimeAdapter) {
      const descriptor = await describe.call(this); vi.stubEnv('PI_CODING_AGENT_DIR', other); return descriptor;
    });
    const value = await observePiRuntime(project);
    expect(inspection).toHaveBeenCalledOnce();
    expect(value).toMatchObject({ authContextRef: null, authentication: 'unknown', owner: null, descriptor: null, catalogOwnership: null, ready: false });
    expect(await disk()).toEqual(before); noSecrets(value);
  });
  it('rejects an actual concurrent owner refresh without taking over or cancelling its native save', async () => {
    await credentials({ openai: oauth('expired', 1) }); const { owner, admitted, recordPath } = await readyOwner();
    const lease = owner.lease({ harnessId: 'pi', authContextRef: admitted.authContextRef, connectionRef: admitted.connection.connectionRef, authGeneration: admitted.authGeneration });
    const runtime = (await createPiRuntimeContext({ ...owner.scope, credentials: lease.credentials, resolveAuth: lease.resolveAuth })).modelRuntime as ModelRuntime;
    let enter!: () => void, release!: () => void;
    const began = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(runtime.getProvider('openai')!.auth.oauth!, 'refresh').mockImplementation(async () => { enter(); await gate; return oauth('rotated') as never; });
    const describe = PiRuntimeAdapter.prototype.describe; let refreshing!: Promise<unknown>;
    vi.spyOn(PiRuntimeAdapter.prototype, 'describe').mockImplementationOnce(async function (this: PiRuntimeAdapter) {
      const descriptor = await describe.call(this); refreshing = runtime.getAuth('openai'); await began; return descriptor;
    });
    externalRefresh = true;
    try {
      const value = await observePiRuntime(project);
      expect(value).toMatchObject({ authentication: 'unknown', owner: null, descriptor: null, catalogOwnership: null, ready: false });
      expect(JSON.parse(await readFile(recordPath, 'utf8')).pendingRefresh).toBeDefined();
    } finally { release(); await refreshing; await lease.drain(); }
    expect(modifyStorage).toHaveBeenCalledOnce(); expect(getAuth).toHaveBeenCalledOnce(); expect(createStorage).toHaveBeenCalledOnce(); createStorage.mockClear();
    expect((await observePiRuntime(project)).ready).toBe(true);
  });
  it('cancellation stops observation without fencing a ready login or changing any files', async () => {
    await credentials(); await readyOwner(); const before = await disk(), controller = new AbortController(), reason = new DOMException('Stop observation', 'AbortError');
    const describe = PiRuntimeAdapter.prototype.describe;
    vi.spyOn(PiRuntimeAdapter.prototype, 'describe').mockImplementationOnce(async function (this: PiRuntimeAdapter) {
      const value = await describe.call(this); controller.abort(reason); return value;
    });
    await expect(observePiRuntime(project, controller.signal)).rejects.toBe(reason); expect(await disk()).toEqual(before);
    await expect(observePiRuntime(project, controller.signal)).rejects.toBe(reason); expect(await disk()).toEqual(before);
  });
});
