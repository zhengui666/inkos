import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodexClient } from '../../codex/app-server.js';
import { CodexAuthenticationOwner } from '../auth/codex-owner.js';
import { CodexRuntimeAdapter } from '../adapters/codex/adapter.js';
import { bindCodexModelConnection, dispatchCodexHostEffect, observeCodexRuntime, startCodexRuntimeThread, startCodexRuntimeTurn, withCodexExecution } from '../execution.js';
import { currentCodexRun } from '../run-context.js';
import { readAgentSettings, updateAgentSettings } from '../settings.js';

const mocks = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('../../codex/client.js', () => ({ createCodexClient: mocks.create }));

let root: string, nativeTier: string | null, account: unknown, ack: 'known' | 'unknown' | 'incompatible';
const peers: Peer[] = [];
class Peer implements CodexClient {
  readonly cwd: string;
  readonly codexHome: string;
  closed = false;
  readonly calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  private readonly closes = new Set<() => void>();
  private readonly threadId = randomUUID();
  constructor(projectRoot: string) { this.cwd = projectRoot; this.codexHome = join(projectRoot, '.inkos', 'codex', 'home'); }
  async request<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    const input = params as Record<string, unknown>; this.calls.push({ method, params: input });
    if (this.closed) throw new Error('Fixture peer is closed');
    let result: unknown = {};
    if (method === 'account/read') result = account;
    if (method === 'model/list') result = { data: ['native-model', 'other-model'].map((model, index) => ({ id: model, model,
      isDefault: index === 0, defaultReasoningEffort: 'low', defaultServiceTier: nativeTier,
      supportedReasoningEfforts: ['low', 'high', 'ultra'].map(reasoningEffort => ({ reasoningEffort })),
      serviceTiers: [{ id: 'fast' }, { id: 'priority' }],
    })) };
    if (method === 'config/read') result = { config: {} };
    if (method === 'thread/start') result = { thread: { id: this.threadId }, ...(ack === 'unknown' ? {} : {
      model: ack === 'incompatible' ? 'unexpected-model' : input.model, reasoningEffort: 'low',
      serviceTier: Object.hasOwn(input, 'serviceTier') ? input.serviceTier : nativeTier,
    }) };
    if (method === 'turn/start') result = { turn: { id: randomUUID() } };
    return result as T;
  }
  onNotification() { return () => {}; }
  onRequest() { return () => {}; }
  onClose(callback: () => void) { this.closes.add(callback); return () => { this.closes.delete(callback); }; }
  async close() { if (!this.closed) { this.closed = true; for (const callback of this.closes) callback(); } }
}

beforeEach(async () => {
  vi.stubEnv('INKOS_CODEX_HOME', ''); delete process.env.INKOS_CODEX_HOME;
  vi.stubEnv('INKOS_CODEX_STATE_ROOT', ''); delete process.env.INKOS_CODEX_STATE_ROOT;
  root = mkdtempSync(join(tmpdir(), 'inkos-codex-runtime-'));
  mkdirSync(join(root, '.inkos', 'codex', 'home'), { recursive: true, mode: 0o700 });
  nativeTier = null; ack = 'known';
  account = { account: { type: 'chatgpt', email: null, planType: 'unknown' }, requiresOpenaiAuth: true, workspaceRouting: null };
  mocks.create.mockReset().mockImplementation(async projectRoot => { const peer = new Peer(projectRoot); peers.push(peer); return peer; });
  await updateAgentSettings(root, { harnessPreferences: { codex: { model: null, effort: null, speed: null } } }, { expectedRevision: 0 });
});
afterEach(() => { peers.splice(0); rmSync(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });

async function executeBoundary() {
  const context = currentCodexRun()!, peer = await context.takeClient();
  const thread = await startCodexRuntimeThread(peer, { ephemeral: true, environments: [] });
  const turn = await startCodexRuntimeTurn(peer, { threadId: thread.threadId, input: [{ type: 'text', text: 'protocol fixture' }], environments: [] });
  return { context, peer: peer as Peer, thread, turn };
}

describe('Codex runtime core boundary (authenticated protocol fixture)', () => {
  it('observes catalog ownership from the real client context without binding or exposing identity/secrets', async () => {
    const client = new Peer(root);
    account = { account: { type: 'chatgpt', email: 'private@example.test', planType: 'fixture' }, accessToken: 'synthetic-secret' };
    const observed = await observeCodexRuntime(client);
    expect(observed).toMatchObject({ ready: true, owner: null,
      account: { type: 'chatgpt', planType: 'fixture', identityPresent: true },
      catalogOwnership: { harnessId: 'codex', authContextRef: observed.authContextRef, authGeneration: null, operationId: null },
      nativeDefaultsEvidence: { model: 'model/list-default', effort: 'model/list-default', serviceTier: 'unknown' } });
    expect(observed.catalogOwnership?.adapterVersion).toBe(observed.descriptor?.adapterVersion);
    expect((await readAgentSettings(root)).modelConnectionRef).toBeNull();
    expect(JSON.stringify(observed)).not.toMatch(/private@example.test|synthetic-secret/);
    expect(new CodexAuthenticationOwner(client).snapshot()).toBeUndefined();
  });

  it('binds only the owner-verified reference and performs the second configuration CAS after probing', async () => {
    const client = new Peer(root);
    const original = client.request.bind(client);
    let raced = false;
    client.request = async <T = unknown>(method: string, parameters?: unknown): Promise<T> => {
      const result = await original<T>(method, parameters);
      if (method === 'account/read' && !raced) {
        raced = true; await updateAgentSettings(root, {}, { expectedRevision: 1 });
      }
      return result;
    };
    await expect(bindCodexModelConnection(root, client, { expectedRevision: 1 })).rejects.toMatchObject({ code: 'AGENT_SETTINGS_REVISION_CONFLICT' });
    expect((await readAgentSettings(root)).modelConnectionRef).toBeNull();
    const owner = new CodexAuthenticationOwner(client), before = owner.snapshot()!;
    const bound = await bindCodexModelConnection(root, client, { expectedRevision: 2 });
    expect(bound.modelConnectionRef).toBe(before.connectionRef);
    expect(owner.snapshot()?.authGeneration).toBe(before.authGeneration);
  });

  it('rejects an external project client without modifying either project settings or the external owner', async () => {
    const otherRoot = join(root, 'other-project'); mkdirSync(join(otherRoot, '.inkos', 'codex', 'home'), { recursive: true });
    const other = new Peer(otherRoot), otherOwner = new CodexAuthenticationOwner(other);
    await otherOwner.admit(other);
    const settingsPath = join(root, '.inkos', 'agent-config.json'), ownerPath = join(other.codexHome, 'inkos-connection.json');
    const settingsBefore = readFileSync(settingsPath), ownerBefore = readFileSync(ownerPath);
    const before = await readAgentSettings(root), requestCount = other.calls.length;
    await expect(bindCodexModelConnection(root, other, { expectedRevision: before.revision })).rejects.toMatchObject({ code: 'RUNTIME_AUTH_REVOKED' });
    expect(other.calls).toHaveLength(requestCount);
    expect(readFileSync(settingsPath)).toEqual(settingsBefore);
    expect(await readAgentSettings(root)).toEqual(before);
    expect(readFileSync(ownerPath)).toEqual(ownerBefore);
    expect(existsSync(join(root, '.inkos', 'codex', 'home', 'inkos-connection.json'))).toBe(false);
  });

  it('rejects a trusted project home switch during account/read before writing settings or an owner admission', async () => {
    const client = new Peer(root), otherHome = join(root, 'replacement-home'); mkdirSync(otherHome);
    const settingsPath = join(root, '.inkos', 'agent-config.json'), bytes = readFileSync(settingsPath), before = await readAgentSettings(root);
    const request = client.request.bind(client);
    client.request = async <T = unknown>(method: string, parameters?: unknown): Promise<T> => {
      const result = await request<T>(method, parameters);
      if (method === 'account/read') vi.stubEnv('INKOS_CODEX_HOME', otherHome);
      return result;
    };
    await expect(bindCodexModelConnection(root, client, { expectedRevision: before.revision })).rejects.toMatchObject({ code: 'RUNTIME_AUTH_REVOKED' });
    expect(readFileSync(settingsPath)).toEqual(bytes); expect(await readAgentSettings(root)).toEqual(before);
    expect(existsSync(join(client.codexHome, 'inkos-connection.json'))).toBe(false);
    expect(existsSync(join(otherHome, 'inkos-connection.json'))).toBe(false);
  });

  it('accepts a same-physical-home alias without requiring an isolated peer cwd to equal the project', async () => {
    const client = new Peer(root), alias = join(root, 'home-alias'); symlinkSync(client.codexHome, alias, 'dir');
    vi.stubEnv('INKOS_CODEX_HOME', alias);
    Object.defineProperty(client, 'cwd', { value: join(root, 'isolated-worker') });
    const bound = await bindCodexModelConnection(root, client, { expectedRevision: 1 });
    expect(bound.modelConnectionRef).toBe(new CodexAuthenticationOwner(client).snapshot()?.connectionRef);
    expect(bound.revision).toBe(2);
  });

  it('reports an absent default service tier as unknown rather than inventing catalog evidence', async () => {
    const client = new Peer(root), request = client.request.bind(client);
    client.request = async <T = unknown>(method: string, parameters?: unknown): Promise<T> => {
      const result = await request<T>(method, parameters);
      if (method === 'model/list') for (const model of (result as unknown as { data: Record<string, unknown>[] }).data) delete model.defaultServiceTier;
      return result;
    };
    const observed = await observeCodexRuntime(client);
    expect(observed.ready).toBe(true);
    expect(observed.descriptor?.capabilities?.nativeDefaults.serviceTier).toBeNull();
    expect(observed.nativeDefaultsEvidence?.serviceTier).toBe('unknown');
    mocks.create.mockResolvedValue(client);
    await withCodexExecution(root, async () => {
      const result = await executeBoundary();
      expect(result.turn.requested.serviceTier).toBeNull();
      expect(result.peer.calls.find(call => call.method === 'turn/start')!.params).not.toHaveProperty('serviceTierForTurn');
    });
  });

  it('discards catalog ownership after a recorded A is observed as B and then nullable during a real probe', async () => {
    const client = new Peer(root), owner = new CodexAuthenticationOwner(client);
    account = { account: { type: 'chatgpt', email: 'a@example.test' } };
    const admitted = await owner.admit(client), request = client.request.bind(client);
    let reads = 0;
    client.request = async <T = unknown>(method: string, parameters?: unknown): Promise<T> => {
      const result = await request<T>(method, parameters);
      if (method !== 'account/read') return result;
      return (++reads === 1 ? { account: { type: 'chatgpt', email: 'b@example.test' } }
        : { account: { type: 'chatgpt', email: null }, workspaceRouting: null }) as T;
    };
    expect(await observeCodexRuntime(client)).toMatchObject({ ready: false, descriptor: null,
      catalogOwnership: null, nativeDefaultsEvidence: null, account: null });
    expect(reads).toBe(2);
    expect(owner.snapshot()).toMatchObject({ localState: 'disconnected', authGeneration: admitted.authGeneration + 1 });
    await expect(owner.guard({ harnessId: 'codex', authContextRef: admitted.authContextRef,
      connectionRef: admitted.connection.connectionRef, authGeneration: admitted.authGeneration }, client)).rejects.toMatchObject({ code: 'RUNTIME_AUTH_REVOKED' });
    expect(owner.snapshot()?.authGeneration).toBe(admitted.authGeneration + 1);
  });

  it('resolves all three saved nulls to native values, keeps saved bytes/preferences, and exposes only actual ACK fields', async () => {
    const legacy = '{\r\n "model": null, "reasoningEffort": "low", "serviceTier": "default"\r\n}\r\n';
    const legacyPath = join(root, '.inkos', 'codex-config.json'); writeFileSync(legacyPath, legacy);
    await withCodexExecution(root, async () => {
      const result = await executeBoundary();
      expect(result.context.saved).toEqual({ model: null, effort: null, speed: null });
      expect(result.context.selection).toMatchObject({ modelId: 'native-model', effort: 'low', serviceTier: null });
      expect(result.peer.calls.find(call => call.method === 'thread/start')?.params).toMatchObject({ model: 'native-model' });
      const turn = result.peer.calls.find(call => call.method === 'turn/start')!.params;
      expect(turn).toMatchObject({ model: 'native-model', effort: 'low' }); expect(turn).not.toHaveProperty('serviceTierForTurn');
      expect(result.thread.effective).toEqual({ scope: 'thread', modelId: 'native-model', effort: 'low', serviceTier: null });
      expect(result.turn).not.toHaveProperty('effective');
    });
    expect((await readAgentSettings(root)).harnessPreferences.codex).toEqual({ model: null, effort: null, speed: null });
    expect(readFileSync(legacyPath, 'utf8')).toBe(legacy);
    expect(peers.every(peer => peer.closed)).toBe(true);
  });

  it.each([null, 'default'] as const)('distinguishes inherited Fast from explicit Standard (saved speed: %s)', async speed => {
    nativeTier = 'fast';
    const probe = new Peer(root), harness = await new CodexRuntimeAdapter(probe).describe();
    await updateAgentSettings(root, { harnessPreferences: { codex: { speed } } }, { expectedRevision: 1, catalogs: { codex: harness.capabilities! } });
    await withCodexExecution(root, async () => {
      const { peer, turn } = await executeBoundary();
      expect(peer.calls.find(call => call.method === 'turn/start')!.params.serviceTierForTurn).toBe(speed === null ? 'fast' : 'default');
      expect(turn.requested.serviceTier).toBe(speed === null ? 'fast' : 'default');
    });
    expect((await readAgentSettings(root)).harnessPreferences.codex.speed).toBe(speed);
  });

  it('freezes nested asynchronous scopes across saves and ignores later overrides within the same admitted run', async () => {
    await withCodexExecution(root, async () => {
      const first = await executeBoundary(), selection = first.context.selection;
      const harness = await new CodexRuntimeAdapter(first.peer).describe();
      await updateAgentSettings(root, { harnessPreferences: { codex: { effort: 'high', speed: 'priority' } } }, { expectedRevision: selection.configRevision, catalogs: { codex: harness.capabilities! } });
      for (let descendant = 0; descendant < 3; descendant++) {
        await Promise.resolve().then(() => withCodexExecution(root, async () => {
          expect(currentCodexRun()!.selection).toBe(selection);
          const child = await executeBoundary();
          expect(child.turn.requested).toEqual(first.turn.requested);
          expect(child.thread.effective.modelId).toBe('native-model');
        }, { settings: { model: 'other-model', reasoningEffort: 'ultra', serviceTier: 'priority' } }));
      }
      expect(Object.isFrozen(selection)).toBe(true);
      expect(selection.configRevision).toBeLessThan((await readAgentSettings(root)).revision);
    });
  });

  it('validates a first-invocation override without modifying saved preferences or loading environment keys', async () => {
    vi.stubEnv('INKOS_LLM_MODEL', 'unrelated-model'); vi.stubEnv('INKOS_LLM_API_KEY', 'synthetic-secret');
    await withCodexExecution(root, async () => {
      const { context, turn } = await executeBoundary();
      expect(context.saved).toEqual({ model: null, effort: null, speed: null });
      expect(turn.requested).toMatchObject({ modelId: 'other-model', effort: 'high', serviceTier: 'priority' });
      expect(JSON.stringify(context.selection)).not.toContain('synthetic-secret');
    }, { settings: { model: 'other-model', reasoningEffort: 'high', serviceTier: 'priority' } });
    expect((await readAgentSettings(root)).harnessPreferences.codex).toEqual({ model: null, effort: null, speed: null });
  });

  it('keeps missing ACK settings unknown and blocks an explicit incompatible model', async () => {
    ack = 'unknown';
    await withCodexExecution(root, async () => { expect((await executeBoundary()).thread.effective).toEqual({ scope: 'thread' }); });
    ack = 'incompatible';
    await expect(withCodexExecution(root, executeBoundary)).rejects.toThrow('incompatible model');
  });

  it('rejects attempts to overwrite frozen routing or reuse a thread from another peer', async () => {
    await withCodexExecution(root, async () => {
      const { context, peer, thread } = await executeBoundary();
      await expect(startCodexRuntimeThread(peer, { model: 'other-model' })).rejects.toThrow('frozen selection');
      const other = await context.takeClient();
      await expect(startCodexRuntimeTurn(other, { threadId: thread.threadId, input: [] })).rejects.toMatchObject({ code: 'RUNTIME_AUTH_REVOKED' });
      expect((other as Peer).calls.filter(call => call.method === 'turn/start')).toHaveLength(0);
    });
  });

  it('rejects a revoked epoch at the next turn or host dispatch while retaining an already-admitted result', async () => {
    await withCodexExecution(root, async () => {
      const { peer, thread } = await executeBoundary(); let effects = 0;
      expect(await dispatchCodexHostEffect(peer, async () => ++effects)).toBe(1);
      new CodexAuthenticationOwner(peer).disconnect();
      await expect(dispatchCodexHostEffect(peer, async () => ++effects)).rejects.toMatchObject({ code: 'RUNTIME_AUTH_REVOKED' });
      await expect(startCodexRuntimeTurn(peer, { threadId: thread.threadId, input: [] })).rejects.toMatchObject({ code: 'RUNTIME_AUTH_REVOKED' });
      expect(effects).toBe(1); expect(peer.calls.filter(call => call.method === 'turn/start')).toHaveLength(1);
    });
  });

  it.each([null, { type: 'apiKey' }])('does not admit waived authentication without ChatGPT (%j)', async value => {
    account = { account: value, requiresOpenaiAuth: false };
    await expect(withCodexExecution(root, executeBoundary)).rejects.toMatchObject({ code: 'RUNTIME_AUTH_REVOKED' });
    expect(peers.flatMap(peer => peer.calls).filter(call => call.method === 'thread/start')).toHaveLength(0);
    expect((await readAgentSettings(root)).modelConnectionRef).toBeNull();
  });

  it('blocks selected Pi without starting Codex and rejects a nested foreign project', async () => {
    await updateAgentSettings(root, { selectedHarnessId: 'pi' }, { expectedRevision: 1 });
    await expect(withCodexExecution(root, executeBoundary)).rejects.toMatchObject({ code: 'RUNTIME_HARNESS_NOT_CONNECTED' });
    expect(mocks.create).not.toHaveBeenCalled();
    await updateAgentSettings(root, { selectedHarnessId: 'codex' }, { expectedRevision: 2 });
    await withCodexExecution(root, async () => {
      await expect(withCodexExecution(join(root, 'other-project'), executeBoundary)).rejects.toMatchObject({ code: 'RUNTIME_AUTH_REVOKED' });
    });
  });
});
