import { test, expect, type APIRequestContext, type Page } from '@playwright/test';

async function api(request: APIRequestContext, method: string, params: object = {}) {
  const response = await request.post(`/api/v1/${method.split('.').join('/')}`, { data: params });
  const value = await response.json();
  expect(response.ok(), JSON.stringify(value)).toBeTruthy();
  return value;
}
const provider = (page: Page) => page.locator('.provider').filter({ has: page.getByText('openai', { exact: true }) });
async function start(page: Page, type: 'API key' | 'OAuth') {
  const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/login/start');
  await provider(page).getByRole('button', { name: `Connect ${type}`, exact: true }).click();
  return (await (await response).json()).id as string;
}

test('API key authentication immediately opens in the viewport and can be cancelled', async ({ page, request }) => {
  await page.goto('/#models');
  const id = await start(page, 'API key');
  try {
    const auth = page.getByLabel('Provider authentication', { exact: true });
    await expect(auth).toBeInViewport();
    await expect(page.getByRole('dialog', { name: 'Provider authentication', exact: true })).toBeVisible();
    await expect(auth.getByLabel('Secret authentication value')).toHaveAttribute('type', 'password');
    await expect(auth.getByLabel('Secret authentication value')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect((await api(request, 'models.login.status', { id })).status).toBe('cancelled');
  } finally {
    await request.post('/api/v1/models/login/cancel', { data: { id } });
  }
});

test('native API key setup refreshes configured providers and enables model selection without a manual refresh', async ({ page, request }) => {
  await page.goto('/#models');
  const id = await start(page, 'API key');
  try {
    const auth = page.getByLabel('Provider authentication', { exact: true });
    const inertKey = 'offline-ui-placeholder-not-a-provider-credential';
    await auth.getByLabel('Secret authentication value').fill(inertKey);
    await auth.getByRole('button', { name: 'Send response', exact: true }).click();
    await expect.poll(async () => (await api(request, 'models.login.status', { id })).status).toBe('done');
    expect(JSON.stringify(await api(request, 'models.login.status', { id }))).not.toContain(inertKey);
    await expect(provider(page).locator('.badge')).toHaveText('configured');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByLabel('Model provider', { exact: true }).selectOption('openai');
    await page.getByLabel('Available model', { exact: true }).selectOption({ index: 1 });
    await expect(page.getByRole('button', { name: 'Use model', exact: true })).toBeEnabled();
    expect((await api(request, 'status')).usage.models).toEqual({});
  } finally {
    await api(request, 'models.logout', { providerId: 'openai' });
  }
});

test('OpenAI OAuth shows the real SDK authorization link and cancellation permits another attempt', async ({ page, request }) => {
  await page.goto('/#models');
  let id = await start(page, 'OAuth');
  try {
    const auth = page.getByRole('dialog', { name: 'Provider authentication', exact: true });
    const link = auth.getByRole('link', { name: 'Open provider authentication ↗', exact: true });
    await expect(link).toBeVisible();
    const url = new URL((await link.getAttribute('href'))!);
    expect(url.hostname).toBe('auth.openai.com');
    expect(url.searchParams.get('ext_agent_host_id')).toMatch(/^urn:uuid:/);
    await auth.getByRole('button', { name: 'Cancel authentication', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect((await api(request, 'models.login.status', { id })).status).toBe('cancelled');
    id = await start(page, 'OAuth');
    await expect(page.getByRole('dialog').getByRole('link', { name: 'Open provider authentication ↗', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect((await api(request, 'models.login.status', { id })).status).toBe('cancelled');
    const catalog = await api(request, 'models.list');
    expect(catalog.providers.find((p: any) => p.id === 'openai').configured).toBe(false);
    expect((await api(request, 'status')).usage.models).toEqual({});
  } finally {
    await request.post('/api/v1/models/login/cancel', { data: { id } });
  }
});

test.describe('Chinese authentication on mobile', () => {
  test.use({ locale: 'zh-CN', viewport: { width: 375, height: 800 } });
  test('keeps credential input and cancellation visible in the localized dialog', async ({ page, request }) => {
    await page.goto('/#models');
    const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/login/start');
    await provider(page).getByRole('button', { name: '连接 API 密钥', exact: true }).click();
    const { id } = await (await response).json();
    try {
      const auth = page.getByRole('dialog', { name: '服务商身份验证', exact: true });
      await expect(auth).toBeInViewport();
      await expect(auth.getByLabel('身份验证密钥')).toHaveAttribute('type', 'password');
      await expect(auth.getByRole('button', { name: '发送回复', exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await auth.getByRole('button', { name: '取消身份验证', exact: true }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      expect((await api(request, 'models.login.status', { id })).status).toBe('cancelled');
    } finally {
      await request.post('/api/v1/models/login/cancel', { data: { id } });
    }
  });
});
