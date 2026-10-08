// UI-only acceptance with intercepted API fixtures. No model, account or publishing network calls.
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const require = createRequire(new URL('../packages/core/package.json', import.meta.url));
const { chromium } = require('playwright-core');
const base = process.env.INKOS_UI_URL ?? 'http://127.0.0.1:4579';
const output = process.env.INKOS_UI_QA_DIR ?? '/tmp/inkos-creation-ui-qa';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1365, height: 1100 } });
const failures = []; page.on('pageerror', error => failures.push(String(error)));
const tasks = new Map(); let creates = 0;
const board = () => ({ tasks: [...tasks.values()], defaults: { language: 'zh', platform: 'fixture' }, runtime: { running: true, phase: 'running' }, publication: { configured: false, remoteBookCreation: false } });
await page.route('**/api/v1/**', async route => {
  const url = new URL(route.request().url()), path = url.pathname, method = route.request().method();
  let body = {};
  if (path === '/api/v1/project') body = { language: 'zh', languageExplicit: true };
  else if (path === '/api/v1/books') body = { books: [] };
  else if (path === '/api/v1/works') body = { works: [] };
  else if (path.includes('events')) return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': fixture\n\n' });
  else if (path === '/api/v1/creation-tasks' && method === 'GET') body = board();
  else if (path === '/api/v1/creation-tasks' && method === 'POST') {
    creates++; const request = route.request().postDataJSON();
    if (!tasks.has(request.id)) tasks.set(request.id, { id: request.id, workId: `creation-${request.id}`, request, version: 0,
      plan: { title: '失物记忆的修表师', genre: 'mystery', language: 'zh', platform: 'fixture', targetChapters: request.kind === 'short' ? 1 : 120, chapterWordCount: 2500 },
      phase: 'queued', status: 'queued', desiredState: 'run', foundation: 'pending', foundationAttempts: 0, createdAt: Date.now(), updatedAt: Date.now(),
      writtenChapters: 0, reviewedChapters: 0, publishedChapters: 0, currentChapter: 0, receipts: [] });
    body = { task: tasks.get(request.id) }; await new Promise(resolve => setTimeout(resolve, 250));
  } else if (/\/creation-tasks\/[^/]+\/(pause|resume)$/.test(path)) {
    const [id, action] = path.split('/').slice(-2), task = tasks.get(id);
    task.desiredState = action === 'pause' ? 'paused' : 'run'; task.status = action === 'pause' ? 'paused' : task.phase; task.version++;
    body = { task };
  } else if (/\/creation-tasks\/[^/]+\/plan$/.test(path)) {
    const id = path.split('/').at(-2), task = tasks.get(id); task.plan = route.request().postDataJSON().plan; task.version++; body = { task };
  } else if (path.includes('services')) body = { services: [] };
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
});
try {
  await page.goto(base, { waitUntil: 'networkidle' });
  const boardRegion = page.getByRole('region', { name: '创作任务看板' });
  await boardRegion.waitFor();
  if (await boardRegion.getByRole('radio').count() !== 2) throw new Error('Expected long/short controls');
  if (await boardRegion.getByRole('textbox').count() !== 1) throw new Error('Expected one required brief');
  await page.getByRole('radio', { name: /短篇小说/ }).check();
  await page.getByLabel('内容大概', { exact: true }).fill('一名能看见失物记忆的修表师，发现亡父留下的表正在倒计时。每找回一段记忆，他就会失去一段过去。');
  await page.locator('form').first().evaluate(form => { form.requestSubmit(); form.requestSubmit(); });
  await page.getByRole('heading', { name: '失物记忆的修表师' }).waitFor();
  if (creates !== 1 || tasks.size !== 1) throw new Error(`Repeated submit created ${creates} requests/${tasks.size} tasks`);
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: '失物记忆的修表师' }).waitFor();
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await page.getByText('暂停已请求', { exact: true }).waitFor();
  await page.getByRole('button', { name: '调整计划', exact: true }).click();
  await page.getByLabel('完结章数', { exact: true }).fill('3');
  await page.getByRole('button', { name: '保存计划', exact: true }).click();
  await page.getByText(/计划终点：3/).waitFor();
  await page.getByRole('button', { name: '继续', exact: true }).click();
  await page.getByText('等待启动', { exact: true }).waitFor();
  await page.screenshot({ path: join(output, 'creation-board-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(output, 'creation-board-mobile.png'), fullPage: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  if (overflow) throw new Error('Mobile page has horizontal overflow');
  if (failures.length) throw new Error(failures.join('\n'));
  const result = { status: 'passed', fixtureOnly: true, checks: ['two required creative inputs', 'double-submit admission', 'refresh retains task', 'pause', 'editable short-story sections', 'resume', 'desktop and mobile render'], creates, uniqueTasks: tasks.size, screenshots: ['creation-board-desktop.png', 'creation-board-mobile.png'] };
  await writeFile(join(output, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} finally { await browser.close(); }
