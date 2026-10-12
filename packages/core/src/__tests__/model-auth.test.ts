import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeHost } from '../runtime/host.js';

let root: string;
let host: RuntimeHost;
beforeEach(async () => {
  root = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), 'inkos-auth-'));
  host = await RuntimeHost.open(root, { resume: false });
});
afterEach(async () => { await host?.close(); if (root) await rm(root, { recursive: true, force: true }); });
async function prompt(id: string, type: string) {
  await vi.waitFor(async () => {
    const state = await host.rpc('models.login.status', { id });
    expect(state.status, state.error).toBe('running');
    expect(state.prompt?.type).toBe(type);
  });
  return host.rpc('models.login.status', { id });
}

it('saves an API key through the official SDK without exposing it in login status', async () => {
  const { id } = await host.rpc('models.login.start', { providerId: 'openai', type: 'api_key' });
  await prompt(id, 'secret');
  const inertKey = 'offline-placeholder-not-a-provider-credential';
  await host.rpc('models.login.respond', { id, value: inertKey });
  await vi.waitFor(async () => expect((await host.rpc('models.login.status', { id })).status).toBe('done'));
  expect((await host.credentials.read('openai'))?.type).toBe('api_key');
  expect(JSON.stringify(await host.rpc('models.login.status', { id }))).not.toContain(inertKey);
  expect((await stat(join(root, '.inkos/credentials.json'))).mode & 0o777).toBe(0o600);
  const catalog = await host.rpc('models.list');
  expect(catalog.providers.find((p: any) => p.id === 'openai').configured).toBe(true);
  expect(JSON.stringify(catalog)).not.toContain(inertKey);
  const model = catalog.models.find((m: any) => m.provider === 'openai');
  expect(await host.rpc('models.set', { provider: 'openai', modelId: model.id })).toEqual({ provider: 'openai', modelId: model.id });
  expect((await host.status()).usage.models).toEqual({});
  await host.rpc('models.logout', { providerId: 'openai' });
  expect(await host.credentials.read('openai')).toBeUndefined();
});

it('cancels a pending secret prompt without saving credentials and allows a fresh login', async () => {
  const { id } = await host.rpc('models.login.start', { providerId: 'openai', type: 'api_key' });
  await prompt(id, 'secret');
  await host.rpc('models.login.cancel', { id });
  expect(await host.rpc('models.login.status', { id })).toMatchObject({ status: 'cancelled' });
  expect((await host.rpc('models.login.status', { id })).prompt).toBeUndefined();
  expect(await host.credentials.read('openai')).toBeUndefined();
  await expect(host.rpc('models.login.respond', { id, value: 'must-not-be-saved' })).rejects.toThrow('not awaiting input');
  const next = await host.rpc('models.login.start', { providerId: 'openai', type: 'api_key' });
  await prompt(next.id, 'secret');
  await host.rpc('models.login.cancel', { id: next.id });
});

it('starts native OpenAI OAuth with a stable device ID and releases its callback server on cancellation and close', async () => {
  async function start() {
    const { id } = await host.rpc('models.login.start', { providerId: 'openai', type: 'oauth' });
    const state = await prompt(id, 'manual_code');
    const event = state.events.find((e: any) => e.type === 'auth_url');
    expect(event).toBeDefined();
    const url = new URL(event.url);
    expect(url.hostname).toBe('auth.openai.com');
    expect(url.searchParams.get('agent_name_hint')).toBe('InkOS');
    expect(url.searchParams.get('ext_agent_host_id')).toMatch(/^urn:uuid:[a-f0-9-]{36}$/);
    expect(state.prompt).not.toHaveProperty('signal');
    expect(state).not.toHaveProperty('controller');
    return { id, deviceId: url.searchParams.get('ext_agent_host_id') };
  }
  const first = await start();
  await host.rpc('models.login.cancel', { id: first.id });
  expect((await host.rpc('models.login.status', { id: first.id })).status).toBe('cancelled');
  const second = await start();
  expect(second.deviceId).toBe(first.deviceId);
  await host.close();
  host = await RuntimeHost.open(root, { resume: false });
  const reopened = await start();
  expect(reopened.deviceId).toBe(first.deviceId);
  await host.rpc('models.login.cancel', { id: reopened.id });
  expect(await host.credentials.read('openai')).toBeUndefined();
  expect((await host.status()).usage.models).toEqual({});
});
