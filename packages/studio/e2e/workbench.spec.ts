import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';

async function api(request: APIRequestContext, method: string, params: object = {}) {
  const response = await request.post(`/api/v1/${method.split('.').join('/')}`, { data: params });
  const value = await response.json(); expect(response.ok(), JSON.stringify(value)).toBeTruthy(); return value;
}
async function createWork(page: Page, title: string, profile = 'article') {
  await page.goto('/#works');
  await page.getByRole('button', { name: 'New work', exact: true }).click();
  await page.getByLabel('Work title', { exact: true }).fill(title);
  await page.getByLabel('Profile', { exact: true }).fill(profile);
  await page.getByLabel('Locale', { exact: true }).fill('ja');
  await expect(page.getByLabel('Platform', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Create work', exact: true }).click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  return decodeURIComponent(page.url().split('#works/')[1]);
}
async function importDraft(page: Page) {
  await page.getByLabel('Import draft file').setInputFiles({ name: 'letter.md', mimeType: 'text/markdown', buffer: Buffer.from('# 手紙\n\n京都の古い書庫で見つけた手紙。') });
  await expect(page.getByLabel('Draft content')).toHaveValue('# 手紙\n\n京都の古い書庫で見つけた手紙。');
  await expect(page.getByTestId('revision-id')).not.toHaveText('Loading…');
  return (await page.getByTestId('revision-id').innerText()).trim();
}

test('platform-free Japanese work, imported revisions, editing and independent targets', async ({ page, request }, info) => {
  const workId = await createWork(page, '日本語の手紙 · offline UI test');
  const firstRevision = await importDraft(page);
  await page.getByLabel('Draft content').fill('日本語の改稿。');
  await page.getByRole('button', { name: 'Save revision', exact: true }).click();
  await expect(page.getByTestId('revision-id')).not.toHaveText(firstRevision);
  const work = await api(request, 'works.get', { id: workId });
  expect(work.locale).toBe('ja'); expect(work.targetIds).toHaveLength(0);
  expect(work.artifactIds).toHaveLength(1);
  const read = await api(request, 'artifacts.read', { id: work.artifactIds[0] });
  expect(read.content).toBe('日本語の改稿。'); expect(read.artifact.revisions).toHaveLength(2);
  await page.getByLabel('Read revision ID').fill(firstRevision);
  await page.getByRole('button', { name: 'Read version', exact: true }).click();
  await expect(page.getByLabel('Draft content')).toHaveValue('# 手紙\n\n京都の古い書庫で見つけた手紙。');
  await page.reload();
  await expect(page.getByTestId('revision-id')).toHaveText(read.revision.id);
  await expect(page.getByLabel('Draft content')).toHaveValue('日本語の改稿。');
  await page.screenshot({ path: info.outputPath('works-desktop.png'), fullPage: true });
  await page.getByRole('link', { name: 'Publishing', exact: true }).click();
  for (const account of ['Offline A', 'Offline B']) {
    await page.getByRole('button', { name: 'Add target', exact: true }).click();
    await page.getByLabel('Target work').selectOption(workId);
    await page.getByLabel('Publisher', { exact: true }).fill('browser');
    await page.getByLabel('Account ID', { exact: true }).fill(account.toLowerCase().replace(' ', '-'));
    await page.getByLabel('Account label', { exact: true }).fill(account);
    await page.getByLabel('Entry URL', { exact: true }).fill('http://127.0.0.1:1/offline');
    await page.getByText('Browser, metadata & skill', { exact: true }).click();
    await page.getByLabel('Browser JSON').fill('{"headless":true}');
    await page.getByRole('button', { name: 'Create target', exact: true }).click();
    await expect(page.getByRole('heading', { name: account, exact: true })).toBeVisible();
  }
  expect((await api(request, 'works.get', { id: workId })).targetIds).toHaveLength(2);
  await expect(page.getByRole('heading', { name: 'Distribution progress', exact: true })).toBeVisible();
  await expect(page.getByText('Submitted ≠ published.', { exact: false })).toBeVisible();
  await page.screenshot({ path: info.outputPath('publishing-desktop.png'), fullPage: true });
});

test('native offline task survives refresh, pause/resume and cancellation', async ({ page, request }) => {
  // A real production schedule waits one hour before any content/model work.
  // Native pause/resume/cancel are exercised while that durable task is sleeping.
  const work = await api(request, 'works.create', { title: 'Offline scheduled production', profile: 'article', locale: 'ja', plan: { production: { nextAt: Date.now() + 3_600_000, backlog: 1, cron: null } } });
  const created = await api(request, 'produce', { workId: work.id, requestId: crypto.randomUUID() });
  await page.goto('/#tasks');
  const row = page.getByTestId(`task-${created.taskId}`);
  await expect(row).toBeVisible();
  await expect.poll(async () => (await api(request, 'tasks.get', { id: created.taskId })).state.status).toBe('running');
  const before = await api(request, 'status');
  const record = await api(request, 'tasks.get', { id: created.taskId });
  await page.reload(); await expect(row).toBeVisible();
  const after = await api(request, 'status');
  expect(after.pid).toBe(before.pid); expect(after.tasks.length).toBe(before.tasks.length);
  expect((await api(request, 'tasks.get', { id: created.taskId })).startedAt).toBe(record.startedAt);
  await row.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(row.getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
  expect((await api(request, 'works.get', { id: work.id })).pauseRequested).toBe(true);
  await row.getByRole('button', { name: 'Resume', exact: true }).click();
  await expect(row.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  expect((await api(request, 'works.get', { id: work.id })).pauseRequested).toBe(false);
  await row.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect.poll(async () => (await api(request, 'tasks.get', { id: created.taskId })).state.outcome?.status).toBe('aborted');
  await expect(row.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
  expect((await stat(join(before.rootDir, '.inkos', 'durable.sqlite'))).size).toBeGreaterThan(0);
});

test('persistent conversation writes one offline note; reload never resubmits', async ({ page, request }) => {
  await page.goto('/#conversations');
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await page.getByLabel('Offline note', { exact: true }).fill('Research decision: keep the Japanese letter intact.');
  let submissions = 0;
  page.on('request', request => { if (request.url().endsWith('/conversations/submit')) submissions++; });
  await page.getByRole('button', { name: 'Save note', exact: true }).click();
  await expect(page.locator('.transcript')).toContainText('Research decision: keep the Japanese letter intact.');
  const id = Number(page.url().split('#conversations/')[1]);
  const native = await api(request, 'conversations.get', { id });
  expect(native.entries.filter((entry: any) => entry.kind === 'inkos.note')).toHaveLength(1);
  await page.reload();
  await expect(page.locator('.transcript')).toContainText('Research decision: keep the Japanese letter intact.');
  expect(submissions).toBe(1);
  await page.getByLabel('Message type').selectOption('input');
  await page.getByLabel('Agent input', { exact: true }).fill('No model should run');
  await expect(page.getByRole('button', { name: 'Send input', exact: true })).toBeDisabled();
});

test('unconfigured models, official extension descriptors, materials and user-action entry', async ({ page, request }, info) => {
  await page.goto('/#models');
  await expect(page.getByText('Model service is not configured.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Use model', exact: true })).toBeDisabled();
  await expect(page.getByText('No model selected.', { exact: true })).toBeVisible();
  await expect(page.locator('input[type=radio]')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('models-desktop.png'), fullPage: true });
  await page.getByRole('link', { name: 'Extensions', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Extensions & capabilities', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Native tasks', exact: true }).first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Content publishers', exact: true }).first()).toBeVisible();
  await page.getByLabel('Official extension modules').fill('./does-not-exist.js');
  await page.getByRole('button', { name: 'Apply modules', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('does-not-exist');
  await page.getByRole('link', { name: 'Materials', exact: true }).click();
  await page.getByLabel('Material file path').fill('research.md');
  await page.getByRole('button', { name: 'Ingest source', exact: true }).click();
  await expect(page.locator('.material-item h3').first()).toBeVisible();
  await page.getByLabel('Search materials', { exact: true }).fill('Kyoto');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.locator('.material-item')).toContainText('handwritten letter');
  await page.getByRole('link', { name: 'User actions', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'User actions & observation', exact: true })).toBeVisible();
  const status = await api(request, 'status');
  expect(await readFile(join(status.rootDir, 'research.md'), 'utf8')).toContain('Kyoto');
});

test('responsive layout, visible keyboard focus and reduced motion on the real UI', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/#works');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to workspace', exact: true })).toBeFocused();
  expect(await page.getByRole('link', { name: 'Skip to workspace', exact: true }).evaluate(el => getComputedStyle(el).outlineStyle)).toBe('solid');
  await page.keyboard.press('Enter'); await expect(page.locator('#main-content')).toBeFocused();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await page.locator('.page-content').evaluate(el => getComputedStyle(el).animationName)).toBe('none');
  for (const width of [1440, 1024, 375]) {
    await page.setViewportSize({ width, height: 900 });
    for (const destination of ['works', 'tasks', 'conversations', 'publishing', 'models', 'plugins']) {
      await page.goto(`/#${destination}`);
      await expect(page.locator('.page-content')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath(`${destination}-${width}.png`), fullPage: true });
    }
  }
  expect(errors).toEqual([]);
});
test('native budget fault is terminal and explicit retry preserves the saved author draft without model calls', async ({ page, request }) => {
  const work = await api(request, 'works.create', { title: 'Zero-budget recovery', profile: 'article', plan: { review: { id: 'zero-budget', enabled: true, maxRevisions: 1, maxCost: 0 } } });
  const created = await api(request, 'creation.start', { workId: work.id, content: 'Author draft retained during failure.', artifactId: 'budget-draft', revisionId: 'budget-v1', requestId: 'budget-fault' });
  const failed = await api(request, 'tasks.wait', { id: created.taskId }); expect(failed.state.outcome.status).toBe('faulted');
  const root = (await api(request, 'status')).rootDir;
  const draftPath = join(root, '.inkos/artifacts', work.id, 'budget-draft/budget-v1/content.txt');
  const savedAt = (await stat(draftPath)).mtimeMs;
  expect(await readFile(draftPath, 'utf8')).toBe('Author draft retained during failure.');
  await page.goto('/#tasks'); const row = page.getByTestId(`task-${created.taskId}`);
  await expect(row.getByRole('button', { name: 'Pause', exact: true })).toBeDisabled();
  await expect(row.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
  await row.getByRole('button', { name: 'Retry content', exact: true }).click();
  await expect.poll(async () => (await api(request, 'status')).tasks.filter((task: any) => task.kind === 'inkos.content' && task.input.workId === work.id).length).toBe(2);
  const status = await api(request, 'status');
  const recovered = status.tasks.find((task: any) => task.kind === 'inkos.content' && task.input.workId === work.id && task.id !== created.taskId);
  expect((await api(request, 'tasks.wait', { id: recovered.id })).state.outcome.status).toBe('faulted');
  expect(await readFile(draftPath, 'utf8')).toBe('Author draft retained during failure.');
  expect((await stat(draftPath)).mtimeMs).toBe(savedAt);
  expect((await api(request, 'status')).usage.models).toEqual({});
});
