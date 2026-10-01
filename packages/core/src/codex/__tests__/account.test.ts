import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCodexAccountService } from '../account.js';
import type { CodexClient, CodexNotificationListener } from '../app-server.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'inkos-account-test-')); roots.push(dir);
  let notification: CodexNotificationListener = () => undefined;
  let close: () => void = () => undefined;
  const request = vi.fn(async (method: string): Promise<unknown> => {
    if (method === 'account/read') return { account: null, requiresOpenaiAuth: true, accessToken: 'DO NOT EXPOSE' };
    if (method === 'account/login/start') return { type: 'chatgptDeviceCode', loginId: 'l1', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD', accessToken: 'DO NOT EXPOSE' };
    if (method === 'model/list') return { data: [{ id: 'model1', model: 'model1', displayName: 'Model', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'medium' }], serviceTiers: [{ id: 'fast' }], token: 'DO NOT EXPOSE' }], nextCursor: null };
    return {};
  });
  const client = { request, onNotification: (listener: CodexNotificationListener) => { notification = listener; return () => undefined; },
    onClose: (listener: () => void) => { close = listener; return () => undefined; }, close: vi.fn(async () => close()),
    cwd: dir, codexHome: dir, closed: false, onRequest: () => () => undefined } as unknown as CodexClient;
  const service = createCodexAccountService({ projectDir: dir, clientFactory: async () => client });
  return { service, request, notify: (method: string, params: unknown) => notification(method, params), close: () => close() };
}
describe('Codex account service', () => {
  it('projects account/model/login data without credential leakage', async () => {
    const { service, request } = await fixture();
    const status = await service.readAccount();
    expect(status.connected).toBe(false); expect(JSON.stringify(status)).not.toContain('EXPOSE');
    expect(JSON.stringify(await service.listModels())).not.toContain('EXPOSE');
    expect(JSON.stringify(await service.startDeviceLogin())).not.toContain('EXPOSE');
    expect(request).toHaveBeenCalledWith('account/login/start', { type: 'chatgptDeviceCode' });
    await service.dispose();
  });
  it('deduplicates repeated starts and guards stale cancellations', async () => {
    const { service, request } = await fixture();
    await Promise.all([service.startDeviceLogin(), service.startDeviceLogin()]);
    expect(request.mock.calls.filter(([method]) => method === 'account/login/start')).toHaveLength(1);
    await expect(service.cancelLogin('stale')).rejects.toThrow('no longer current');
    await service.cancelLogin('l1');
    expect((await service.readAccount()).login).toEqual({ loginId: 'l1', status: 'cancelled' });
    await service.dispose();
  });
  it('tracks completed, failed, and disconnected sign-ins without raw error leakage', async () => {
    const { service, notify, close } = await fixture();
    await service.startDeviceLogin(); notify('account/login/completed', { loginId: 'l1', success: false, error: 'SECRET' });
    expect((await service.readAccount()).login?.status).toBe('failed');
    expect(JSON.stringify(await service.readAccount())).not.toContain('SECRET');
    await service.startDeviceLogin(); notify('account/login/completed', { loginId: 'l1', success: true });
    expect((await service.readAccount()).login).toEqual({ loginId: 'l1', status: 'completed' });
    await service.startDeviceLogin(); close();
    expect((await service.readAccount()).login?.status).toBe('failed');
    await service.dispose();
  });
  it('validates supported reasoning and service tier against model/list', async () => {
    const { service } = await fixture();
    await expect(service.updateSettings({ model: 'made-up' })).rejects.toThrow('not available');
    await expect(service.updateSettings({ serviceTier: 'ultrafast' })).rejects.toThrow('not supported');
    await expect(service.updateSettings({ reasoningEffort: 'high' })).rejects.toThrow('not supported');
    expect(await service.updateSettings({ serviceTier: 'fast' })).toMatchObject({ serviceTier: 'fast' });
    await service.dispose();
  });
});

it('shares catalog aliases/default fallback/speed projection with runtime settings validation', async () => {
  const { service, request } = await fixture();
  request.mockImplementation(async (method: string) => method === 'model/list' ? { data: [{ id: 'alias', model: 'canonical', displayName: 'Model', isDefault: false,
    supportedReasoningEfforts: [{ reasoningEffort: 'medium' }], serviceTiers: [{ id: 'fast', name: 'Fast' }], additionalSpeedTiers: ['fast', 'priority'] }], nextCursor: null } : {});
  expect((await service.listModels())[0]?.serviceTiers.map(tier => tier.id)).toEqual(['fast', 'priority']);
  await expect(service.updateSettings({ model: 'alias', serviceTier: 'priority' })).resolves.toMatchObject({ model: 'alias', serviceTier: 'priority' });
  await expect(service.updateSettings({ model: null, serviceTier: 'default' })).resolves.toMatchObject({ reasoningEffort: 'medium' });
  await service.dispose();
});
