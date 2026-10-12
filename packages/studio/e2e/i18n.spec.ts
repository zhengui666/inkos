import { test, expect, type APIRequestContext } from '@playwright/test';

async function api(request: APIRequestContext, method: string, params: object = {}) {
  const response = await request.post(`/api/v1/${method.split('.').join('/')}`, { data: params });
  const value = await response.json();
  expect(response.ok(), JSON.stringify(value)).toBeTruthy();
  return value;
}

test('switching language preserves inputs, notices, content locale and revisions without duplicate writes', async ({ page, request }) => {
  const mutations: string[] = [];
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (['/works/create', '/artifacts/save', '/creation/start', '/conversations/submit'].some(method => path.endsWith(method))) mutations.push(path);
  });
  await page.goto('/#works');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await page.getByRole('button', { name: 'New work', exact: true }).click();
  const title = '保留标题 · i18n';
  await page.getByLabel('Work title', { exact: true }).fill(title);
  await page.getByLabel('Profile', { exact: true }).fill('article');
  await page.getByLabel('Locale', { exact: true }).fill('ja');
  await page.getByLabel('Creative brief', { exact: true }).fill('Keep 日本語 unchanged.');
  await page.getByLabel('Interface language').selectOption('zh-CN');
  await expect(page.getByLabel('作品标题', { exact: true })).toHaveValue(title);
  await expect(page.getByLabel('内容语言', { exact: true })).toHaveValue('ja');
  await expect(page.getByLabel('创作要求', { exact: true })).toHaveValue('Keep 日本語 unchanged.');
  await page.getByLabel('内容语言', { exact: true }).fill('invalid_locale');
  await page.getByRole('button', { name: '创建作品', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('请输入有效的语言区域代码');
  await page.getByLabel('界面语言').selectOption('en');
  await expect(page.getByRole('alert')).toContainText('Enter a valid Intl locale');
  expect(mutations).toEqual([]);
  await page.getByLabel('Locale', { exact: true }).fill('ja');
  await page.getByLabel('Interface language').selectOption('zh-CN');
  await page.getByRole('button', { name: '创建作品', exact: true }).click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await expect(page.locator('.notice.success')).toContainText('作品已创建');
  const workId = decodeURIComponent(page.url().split('#works/')[1]);
  await page.getByLabel('草稿标题', { exact: true }).fill('手紙 / Letter');
  const draft = '京都の古い書庫。\n中文与 English remain intact.';
  await page.getByLabel('草稿内容', { exact: true }).fill(draft);
  await page.getByLabel('界面语言').selectOption('en');
  await expect(page.getByLabel('Draft title', { exact: true })).toHaveValue('手紙 / Letter');
  await expect(page.getByLabel('Draft content', { exact: true })).toHaveValue(draft);
  await expect(page.locator('.notice.success')).toContainText('Work created');
  await page.getByRole('button', { name: 'Save revision', exact: true }).click();
  await expect(page.getByTestId('revision-id')).not.toHaveText('Loading…');
  const revisionId = (await page.getByTestId('revision-id').innerText()).trim();
  await page.getByLabel('Interface language').selectOption('zh-CN');
  await expect(page.getByTestId('revision-id')).toHaveText(revisionId);
  await expect(page.getByLabel('草稿内容', { exact: true })).toHaveValue(draft);
  await expect(page.locator('.notice.success')).toContainText('版本已保存');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await expect(page.getByLabel('界面语言')).toHaveValue('zh-CN');
  await expect(page.getByLabel('草稿内容', { exact: true })).toHaveValue(draft);
  await page.getByLabel('界面语言').selectOption('en');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByLabel('Interface language')).toHaveValue('en');
  const work = await api(request, 'works.get', { id: workId });
  expect(work.locale).toBe('ja');
  const saved = await api(request, 'artifacts.read', { id: work.artifactIds[0] });
  expect(saved.content).toBe(draft);
  expect(saved.artifact.revisions).toHaveLength(1);
  expect(mutations).toEqual(['/api/v1/works/create', '/api/v1/artifacts/save']);
  expect((await api(request, 'status')).usage.models).toEqual({});
});

test.describe('Chinese browser preference', () => {
  test.use({ locale: 'zh-CN' });
  test('detects Chinese and localizes every navigation destination on desktop and mobile', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('/#works');
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    await expect(page.getByLabel('界面语言')).toHaveValue('zh-CN');
    await expect(page.getByRole('button', { name: '新建作品', exact: true })).toBeVisible();
    const destinations = ['作品与版本', '模型配置', '扩展'];
    for (const width of [1440, 375]) {
      await page.setViewportSize({ width, height: 900 });
      for (const destination of destinations) {
        await page.getByRole('link', { name: destination, exact: true }).click();
        await expect(page.locator('main h1')).toContainText(/[\u4e00-\u9fff]/);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await expect(page.getByLabel('界面语言')).toBeVisible();
      }
    }
    await expect(page.getByRole('navigation', { name: 'Studio 导航' }).getByRole('link')).toHaveCount(3);
    await page.getByRole('link', { name: '作品与版本', exact: true }).click();
    await page.getByLabel('界面语言').selectOption('en');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByRole('heading', { name: 'Works & revisions', exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('localizes professional labels and mobile captions without altering source, translation or domain data', async ({ page, request }) => {
    const domain = { translation: {
      sourceLanguage: 'ja', targetLanguage: 'fr', glossary: { 手紙: 'lettre' },
      chapters: [{ number: 1, title: '手紙 / Lettre', translatedSegments: 1, observations: [], segments: [
        { index: 1, source: '手紙を守る。', target: 'Protéger la lettre.', notes: 'Author-approved terminology' },
      ] }],
    } };
    const work = await api(request, 'works.create', { title: '专业数据与界面语言', profile: 'translation', locale: 'fr', domain });
    await page.goto(`/#works/${work.id}`);
    await expect(page.getByRole('heading', { name: '翻译工作区', exact: true })).toBeVisible();
    await expect(page.locator('.translation-columns')).toContainText('原文');
    await expect(page.locator('.translation-columns')).toContainText('译文与备注');
    await page.setViewportSize({ width: 375, height: 900 });
    const source = page.locator('.translation-segment > div').first();
    const target = page.locator('.translation-segment > div').last();
    expect(await source.evaluate(el => getComputedStyle(el, '::before').content)).toBe('"原文"');
    expect(await target.evaluate(el => getComputedStyle(el, '::before').content)).toBe('"译文与备注"');
    await expect(source).toContainText('手紙を守る。');
    await expect(target).toContainText('Protéger la lettre.');
    await expect(target).toContainText('Author-approved terminology');
    await page.getByText('完整专业数据', { exact: true }).click();
    await expect(page.getByText('完整专业数据', { exact: true }).locator('..').locator('pre')).toContainText('"sourceLanguage": "ja"');
    await page.getByLabel('界面语言').selectOption('en');
    await expect(page.getByRole('heading', { name: 'Translation workspace', exact: true })).toBeVisible();
    expect(await source.evaluate(el => getComputedStyle(el, '::before').content)).toBe('"Source"');
    expect(await target.evaluate(el => getComputedStyle(el, '::before').content)).toBe('"Translation & notes"');
    await expect(source).toContainText('手紙を守る。');
    await expect(target).toContainText('Protéger la lettre.');
    expect((await api(request, 'works.get', { id: work.id })).domain).toEqual(domain);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
});
