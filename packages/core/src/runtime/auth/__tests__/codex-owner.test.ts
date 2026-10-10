import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CodexClient } from '../../../codex/app-server.js';
import type { RuntimeSelection } from '../../contracts.js';
import { CodexAuthenticationOwner } from '../codex-owner.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'inkos-owner-test-')); roots.push(home);
  let account: unknown = { account: { type: 'chatgpt', email: null, planType: 'unknown' }, requiresOpenaiAuth: true };
  const client = { codexHome: home, request: vi.fn(async () => account) } as unknown as CodexClient;
  return { home, client, owner: new CodexAuthenticationOwner(client), setAccount(value: unknown) { account = value; } };
}
function target(value: Awaited<ReturnType<CodexAuthenticationOwner['admit']>>): RuntimeSelection {
  return { harnessId: value.harnessId, adapterVersion: 'test', authContextRef: value.authContextRef,
    connectionRef: value.connection.connectionRef, authGeneration: value.authGeneration,
    modelId: 'test', effort: null, serviceTier: null, configRevision: 3 };
}

describe('managed Codex authentication owner', () => {
  it('shares a nonzero epoch across owner instances/restarts and accepts nullable account identity', async () => {
    const f = fixture(), first = await f.owner.admit(f.client);
    const restarted = new CodexAuthenticationOwner(f.client);
    expect(await restarted.admit(f.client)).toEqual(first);
    await restarted.guard(target(first), f.client);
    expect(first.authGeneration).toBeGreaterThan(0);
    expect(restarted.snapshot()).toEqual(f.owner.snapshot());
    expect(first).toMatchObject({ harnessId: 'codex', ready: true, connection: { provider: 'chatgpt', authMethod: 'oauth' } });
  });

  it.each([null, { type: 'apiKey' }, { type: 'amazonBedrock' }])('rejects a non-ChatGPT account even when authentication is waived (%j)', async account => {
    const f = fixture(); f.setAccount({ account, requiresOpenaiAuth: false });
    await expect(f.owner.admit(f.client)).rejects.toMatchObject({ code: 'RUNTIME_AUTH_REVOKED' });
    expect(f.owner.snapshot()?.localState).toBe('disconnected');
  });

  it('does not create a record or bind config for a passive successful account observation', () => {
    const f = fixture(); f.owner.observe(f.client, { account: { type: 'chatgpt' } });
    expect(f.owner.snapshot()).toBeUndefined();
  });

  it('revokes the old epoch before an operation and rejects a late completion', async () => {
    const f = fixture(), selected = target(await f.owner.admit(f.client));
    const first = f.owner.begin(true), second = new CodexAuthenticationOwner(f.client).begin();
    expect(second.authGeneration).toBe(first.authGeneration + 1);
    expect(await f.owner.completeLogin(first, f.client)).toBe(false);
    expect(f.owner.snapshot()).toMatchObject({ localState: 'transitioning', ...second });
    expect(f.owner.complete(second, 'disconnected')).toBe(true);
    await expect(f.owner.guard(selected, f.client)).rejects.toMatchObject({ code: 'RUNTIME_AUTH_REVOKED' });
  });

  it('allows a competing revocation while live validation is waiting, then rejects the stale permit', async () => {
    const f = fixture(), selected = target(await f.owner.admit(f.client));
    let respond!: (value: unknown) => void;
    vi.mocked(f.client.request).mockImplementationOnce((() => new Promise<unknown>(resolve => { respond = resolve; })) as CodexClient['request']);
    const guarded = f.owner.guard(selected, f.client);
    const rejected = expect(guarded).rejects.toMatchObject({ code: 'RUNTIME_AUTH_REVOKED' });
    new CodexAuthenticationOwner(f.client).disconnect();
    respond({ account: { type: 'chatgpt' } }); await rejected;
  });

  it('keeps an uncertain RPC outcome non-ready and never reuses the preceding epoch', async () => {
    const f = fixture(), old = target(await f.owner.admit(f.client));
    const operation = f.owner.begin(); f.owner.complete(operation, 'unknown');
    expect(f.owner.snapshot()?.localState).toBe('unknown');
    await expect(f.owner.guard(old, f.client)).rejects.toMatchObject({ code: 'RUNTIME_AUTH_REVOKED' });
    const revalidated = await new CodexAuthenticationOwner(f.client).admit(f.client);
    expect(revalidated.authGeneration).toBe(operation.authGeneration);
    expect(revalidated.authGeneration).toBeGreaterThan(old.authGeneration);
  });

  it('revalidates but never replays an inherited in-progress login', async () => {
    const f = fixture(); await f.owner.admit(f.client); const operation = f.owner.begin(true);
    vi.mocked(f.client.request).mockClear();
    await expect(new CodexAuthenticationOwner(f.client).admit(f.client)).rejects.toMatchObject({ code: 'RUNTIME_AUTH_REVOKED' });
    expect(vi.mocked(f.client.request).mock.calls.map(([method]) => method)).toEqual(['account/read']);
    expect(f.owner.snapshot()).toMatchObject({ localState: 'transitioning', ...operation });
  });

  it('increments for observed sign-out or a definite identity change, not plan/catalog/config reads', async () => {
    const f = fixture(); f.setAccount({ account: { type: 'chatgpt', email: 'first@example.test', planType: 'plus' } });
    const first = await f.owner.admit(f.client);
    f.owner.observe(f.client, { account: { type: 'chatgpt', email: 'first@example.test', planType: 'pro' } });
    expect(f.owner.snapshot()?.authGeneration).toBe(first.authGeneration);
    f.owner.observe(f.client, { account: { type: 'chatgpt', email: 'second@example.test' } });
    expect(f.owner.snapshot()?.authGeneration).toBe(first.authGeneration + 1);
    expect(JSON.stringify(f.owner.snapshot())).not.toContain('@example.test');
    f.setAccount({ account: { type: 'chatgpt', email: 'second@example.test' } });
    const second = await f.owner.admit(f.client);
    f.setAccount({ account: null, requiresOpenaiAuth: false });
    await expect(f.owner.guard(target(second), f.client)).rejects.toMatchObject({ code: 'RUNTIME_AUTH_REVOKED' });
    expect(f.owner.snapshot()?.authGeneration).toBe(second.authGeneration + 1);
  });

  it('rejects another trusted client context and keeps credentials out of the record/admission', async () => {
    const f = fixture(), other = fixture();
    f.setAccount({ account: { type: 'chatgpt', email: null }, accessToken: 'synthetic-secret', refreshToken: 'synthetic-secret' });
    const admitted = await f.owner.admit(f.client);
    expect(JSON.stringify([admitted, f.owner.snapshot()])).not.toMatch(/synthetic-secret|accessToken|refreshToken|apiKey/);
    await expect(f.owner.guard(target(admitted), other.client)).rejects.toMatchObject({ code: 'RUNTIME_AUTH_REVOKED' });
    expect(f.owner.snapshot()?.authGeneration).toBe(admitted.authGeneration + 1);
  });

  it('observes an independent OS process revoking the same physical owner record', async () => {
    const f = fixture(), selected = target(await f.owner.admit(f.client));
    const sourceRoot = new URL('../../../', import.meta.url).href;
    const child = spawnSync(process.execPath, ['--experimental-transform-types', '--input-type=module', '-e', `
      import {registerHooks} from 'node:module';
      const sourceRoot=${JSON.stringify(sourceRoot)};
      registerHooks({resolve(specifier,context,next){return next(context.parentURL?.startsWith(sourceRoot)&&specifier.startsWith('.')&&specifier.endsWith('.js')?specifier.slice(0,-3)+'.ts':specifier,context);}});
      const {CodexAuthenticationOwner}=await import(sourceRoot+'runtime/auth/codex-owner.ts');
      const owner=new CodexAuthenticationOwner({codexHome:${JSON.stringify(f.home)}});
      owner.disconnect(); process.stdout.write(String(owner.snapshot().authGeneration));
    `], { encoding: 'utf8', timeout: 5000 });
    expect(child.status).toBe(0);
    expect(Number(child.stdout)).toBe(selected.authGeneration + 1);
    await expect(f.owner.guard(selected, f.client)).rejects.toMatchObject({ code: 'RUNTIME_AUTH_REVOKED' });
  });

  it('discards a catalog probe when another owner revokes its generation during the probe', async () => {
    const f = fixture(); await f.owner.admit(f.client);
    const observed = await f.owner.probe(f.client, async () => {
      new CodexAuthenticationOwner(f.client).disconnect(); return { catalog: 'candidate' };
    });
    expect(observed).toMatchObject({ ready: false, value: null, account: null, owner: null });
    expect(observed.readyReasons).toEqual(['owner-changed-during-probe']);
  });

  it('revokes an observed identity change across a catalog probe and exposes no raw identity', async () => {
    const f = fixture(); await f.owner.admit(f.client);
    f.setAccount({ account: { type: 'chatgpt', email: 'first@example.test' } });
    const before = f.owner.snapshot()!;
    const observed = await f.owner.probe(f.client, async () => {
      f.setAccount({ account: { type: 'chatgpt', email: 'second@example.test' }, accessToken: 'synthetic-secret' }); return {};
    });
    expect(observed.ready).toBe(false);
    expect(f.owner.snapshot()?.authGeneration).toBe(before.authGeneration + 1);
    expect(JSON.stringify(observed)).not.toMatch(/@example.test|synthetic-secret/);
  });

  it('learns newly available account identity without incrementing, then revokes a definite later change', async () => {
    const f = fixture(), admitted = await f.owner.admit(f.client);
    f.setAccount({ account: { type: 'chatgpt', email: 'first@example.test' } });
    await f.owner.guard(target(admitted), f.client);
    expect(f.owner.snapshot()?.authGeneration).toBe(admitted.authGeneration);
    expect(f.owner.snapshot()?.identityRef).toMatch(/^email:/);
    f.setAccount({ account: { type: 'chatgpt', email: 'second@example.test' } });
    await expect(f.owner.guard(target(admitted), f.client)).rejects.toMatchObject({ code: 'RUNTIME_AUTH_REVOKED' });
    expect(f.owner.snapshot()?.authGeneration).toBe(admitted.authGeneration + 1);
  });
});
