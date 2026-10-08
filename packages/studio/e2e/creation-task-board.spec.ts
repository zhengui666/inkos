import { test, expect, type Page } from '@playwright/test';

const idea = 'A clockmaker follows memories hidden inside lost watches. Finding her father costs her own past.';
const taskFixture = () => ({
  id: '00000000-0000-4000-8000-000000000001', workId: 'fixture-work',
  request: { id: '00000000-0000-4000-8000-000000000001', kind: 'long', brief: idea },
  plan: { title: 'The Lost Hour', genre: 'mystery', language: 'en', platform: 'fixture', targetChapters: 12, chapterWordCount: 1800 },
  planStatus: 'ready', version: 3, desiredState: 'run', phase: 'writing', foundation: 'completed', foundationAttempts: 1,
  status: 'writing', canResume: true, writtenChapters: 1, reviewedChapters: 1, publishedChapters: 1,
  currentChapter: 1, stage: 'writing', receipts: [{ chapter: 1, revisionId: 'fixture-revision', publication: { status: 'published', remoteChapterId: 'fixture-remote', evidence: 'Offline verified receipt fixture' } }],
  error: undefined as { code: string; message: string } | undefined,
});

async function fixture(page: Page, options: { empty?: boolean; paused?: boolean; runtimeError?: string } = {}) {
  const task = taskFixture();
  if (options.paused) { task.desiredState = 'paused'; task.status = 'paused'; }
  const state = {
    tasks: options.empty ? [] as ReturnType<typeof taskFixture>[] : [task],
    runtime: { running: true, phase: 'running', error: options.runtimeError },
    publication: { configured: false, configurationStatus: 'missing', remoteBookCreation: false, emptyBookFirstChapter: false, requiresExistingRemoteBook: true },
    creates: [] as Array<{ id: string; kind: string; brief: string }>, controls: [] as string[],
    saves: [] as Array<{ version: number; plan: typeof task.plan }>,
    starts: 0, failCreate: false, failControl: false, failRead: false,
  };
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://127.0.0.1:4592') return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const path = url.pathname.replace('/api/v1', '');
    if (path === '/creation-tasks') {
      if (route.request().method() === 'POST') {
        const request = route.request().postDataJSON(); state.creates.push(request);
        if (!state.tasks.some(task => task.id === request.id)) state.tasks.push({ ...taskFixture(), id: request.id, request });
        await new Promise(resolve => setTimeout(resolve, 100));
        if (state.failCreate) return route.abort('failed'); // Server retained it, response lost.
        return route.fulfill({ status: 201, json: { task: state.tasks.at(-1) } });
      }
      if (state.failRead) return route.fulfill({ status: 503, json: { error: 'Fixture board unavailable' } });
      return route.fulfill({ json: { tasks: state.tasks, defaults: { language: 'en', platform: 'fixture' }, runtime: state.runtime, publication: state.publication } });
    }
    if (path === '/creation-tasks/runner/start') {
      state.starts++; await new Promise(resolve => setTimeout(resolve, 100));
      return route.fulfill({ json: { runtimeError: state.runtime.error } });
    }
    if (/^\/creation-tasks\/[^/]+\/(pause|resume)$/.test(path)) {
      const name = path.split('/').at(-1)!; state.controls.push(name);
      await new Promise(resolve => setTimeout(resolve, 100));
      if (state.failControl) return route.fulfill({ status: 503, json: { error: 'Fixture control unavailable' } });
      task.desiredState = name === 'pause' ? 'paused' : 'run'; task.status = name === 'pause' ? 'paused' : 'writing'; task.version++;
      return route.fulfill({ json: { task } });
    }
    if (path.endsWith('/plan')) {
      const input = route.request().postDataJSON(); state.saves.push(input);
      await new Promise(resolve => setTimeout(resolve, 100));
      if (input.version !== task.version) return route.fulfill({ status: 409, json: { error: 'Task changed. Refresh before retrying this action.' } });
      task.plan = input.plan; task.version++;
      return route.fulfill({ json: { task } });
    }
    const staticData: Record<string, unknown> = {
      '/project': { name: 'Offline creation-board fixture', language: 'en', languageExplicit: true },
      '/books': { books: [] }, '/works': { works: [] }, '/interactive-films': { films: [] },
      '/daemon': { running: false }, '/services': { services: [] },
    };
    if (path in staticData) return route.fulfill({ json: staticData[path] });
    return route.fulfill({ status: 404, json: { error: `Unmocked fixture endpoint: ${path}` } });
  });
  await page.goto('/#/');
  await expect(page.getByRole('region', { name: 'Creation task board' })).toBeVisible();
  return state;
}

const board = (page: Page) => page.getByRole('region', { name: 'Creation task board' });
async function doubleClickSameTick(page: Page, name: string) {
  await board(page).getByRole('button', { name, exact: true }).evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
}

test('two-field creation keeps the same request after a lost response and reload', async ({ page }) => {
  const state = await fixture(page, { empty: true }); const view = board(page);
  await view.getByRole('radio', { name: /Short story/ }).check();
  await view.getByLabel('Your story idea').fill(idea); state.failCreate = true;
  await doubleClickSameTick(page, 'Start creating');
  await expect(view.getByRole('alert')).toBeVisible(); expect(state.creates).toHaveLength(1);
  await page.reload();
  await expect(view.getByLabel('Your story idea')).toHaveValue(idea);
  await expect(view.getByRole('radio', { name: /Short story/ })).toBeChecked();
  state.failCreate = false; await doubleClickSameTick(page, 'Start creating');
  await expect(view.getByLabel('Your story idea')).toHaveValue(''); expect(state.creates).toHaveLength(2);
  expect(state.creates[1]).toEqual(state.creates[0]);
  expect(Object.keys(state.creates[0]).sort()).toEqual(['brief', 'id', 'kind']); expect(state.tasks).toHaveLength(1);
});

test('pause, resume and plan save admit only one same-tick submission', async ({ page }) => {
  const state = await fixture(page);
  await doubleClickSameTick(page, 'Pause');
  await expect(board(page).getByRole('button', { name: 'Resume', exact: true })).toBeEnabled();
  expect(state.controls).toEqual(['pause']);
  await board(page).getByRole('button', { name: 'Edit plan' }).click();
  await board(page).getByLabel('Ending chapter').fill('16'); await doubleClickSameTick(page, 'Save plan');
  await expect(board(page).getByRole('button', { name: 'Save plan' })).toHaveCount(0); expect(state.saves).toHaveLength(1);
  await doubleClickSameTick(page, 'Resume');
  await expect(board(page).getByRole('button', { name: 'Pause', exact: true })).toBeEnabled();
  expect(state.controls).toEqual(['pause', 'resume']);
});

test('runner recovery admits one request and keeps failure visible', async ({ page }) => {
  const state = await fixture(page, { runtimeError: 'Offline runner unavailable' });
  await doubleClickSameTick(page, 'Retry runner');
  await expect(board(page).getByRole('button', { name: 'Retry runner' })).toBeEnabled();
  await expect(board(page).getByRole('status')).toContainText('Offline runner unavailable'); expect(state.starts).toBe(1);
});

test('a polled newer plan cannot give stale edits a newer version', async ({ page }) => {
  const state = await fixture(page, { paused: true });
  await board(page).getByRole('button', { name: 'Edit plan' }).click();
  await board(page).getByLabel('Ending chapter').fill('16');
  state.tasks[0].plan = { ...state.tasks[0].plan, targetChapters: 30 }; state.tasks[0].version = 4;
  await expect(board(page).getByText(/Planned ending: 30 chapters/)).toBeVisible({ timeout: 8000 });
  await board(page).getByRole('button', { name: 'Save plan' }).click();
  await expect(board(page).getByRole('alert')).toContainText('Task changed');
  expect(state.saves[0].version).toBe(3); expect(state.tasks[0].plan.targetChapters).toBe(30);
  await board(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  await board(page).getByRole('button', { name: 'Edit plan' }).click();
  await expect(board(page).getByLabel('Ending chapter')).toHaveValue('30');
});

test('pause failure, cancel, navigation, history and reload never resume a retained task', async ({ page }) => {
  const state = await fixture(page); state.failControl = true;
  await board(page).getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(board(page).getByRole('alert')).toContainText('Fixture control unavailable'); state.failControl = false;
  await board(page).getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(board(page).getByRole('button', { name: 'Edit plan' })).toBeEnabled();
  await board(page).getByRole('button', { name: 'Edit plan' }).click();
  await board(page).getByLabel('Ending chapter').fill('99');
  await board(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(board(page).getByRole('button', { name: 'Save plan' })).toHaveCount(0); expect(state.saves).toHaveLength(0);
  await board(page).getByRole('button', { name: 'Open work' }).click(); await expect(page).toHaveURL(/#\/book\/fixture-work$/);
  await page.goBack(); await expect(board(page).getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
  await page.goForward(); await expect(board(page)).toHaveCount(0);
  await page.goBack(); await page.reload();
  await expect(board(page).getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
  expect(state.controls).toEqual(['pause', 'pause']); expect(state.starts).toBe(0); expect(state.creates).toHaveLength(0);
});

test('stopped and completed tasks retain evidence without offering unsafe resume', async ({ page }) => {
  const state = await fixture(page); const task = state.tasks[0];
  task.phase = 'blocked'; task.status = 'blocked'; task.canResume = false;
  task.error = { code: 'CREATION_REVIEW_LIMIT', message: 'Retained review failure; inspect the work.' }; await page.reload();
  await expect(board(page).getByText('CREATION_REVIEW_LIMIT')).toBeVisible();
  await expect(board(page).getByRole('button', { name: 'Resume', exact: true })).toHaveCount(0);
  await board(page).getByText('Publication receipts', { exact: false }).click();
  await expect(board(page).getByText(/Offline verified receipt fixture/)).toBeVisible();
  task.phase = 'completed'; task.status = 'completed'; task.error = undefined; await page.reload();
  await expect(board(page).getByText('Completed and published', { exact: true })).toBeVisible();
  await expect(board(page).getByRole('button', { name: 'Resume', exact: true })).toHaveCount(0);
  await expect(board(page).getByRole('button', { name: 'Pause', exact: true })).toHaveCount(0);
  await expect(board(page).getByRole('button', { name: 'Edit plan' })).toBeDisabled(); expect(state.controls).toHaveLength(0);
});


test('publication limits remain visible even when a config path is present', async ({ page }) => {
  const state = await fixture(page);
  state.publication.configured = true; state.publication.configurationStatus = 'path_provided';
  await page.reload();
  const note = board(page).getByRole('note', { name: 'Publication prerequisites' });
  await expect(note).toContainText('account, binding and remote publication are not yet verified');
  await expect(note).toContainText('Automatic remote-book creation and first-chapter submission to an empty book are unsupported');
  await expect(note).toContainText('pending submissions and platform review do not count as published');
  const noticeBounds = await note.boundingBox();
  const formBounds = await board(page).getByLabel('Your story idea').boundingBox();
  expect(noticeBounds!.y + noticeBounds!.height).toBeLessThan(formBounds!.y);
  expect(state.creates).toHaveLength(0); expect(state.starts).toBe(0);
});

test('an unavailable board can be retried without claiming progress was saved', async ({ page }) => {
  const state = await fixture(page); state.failRead = true; await page.reload();
  await expect(board(page).getByText('Status unconfirmed', { exact: true })).toBeVisible();
  await expect(board(page).getByRole('alert')).toContainText('Fixture board unavailable');
  state.failRead = false;
  await board(page).getByRole('button', { name: 'Retry task status' }).click();
  await expect(board(page).getByRole('heading', { name: 'The Lost Hour' })).toBeVisible();
  expect(state.creates).toHaveLength(0); expect(state.starts).toBe(0);
});
