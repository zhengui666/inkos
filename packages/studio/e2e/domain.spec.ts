import { test, expect } from '@playwright/test';

test('interactive artifact renders its persisted graph and keyboard node inspector', async ({ page, request }) => {
  const workResponse = await request.post('/api/v1/works/create', { data: { title: 'Author-provided interactive story', profile: 'interactive-film', locale: 'ja' } });
  expect(workResponse.ok()).toBeTruthy(); const work = await workResponse.json();
  const graph = { schemaVersion: 1, projectId: work.id, title: 'Two authored scenes', variables: [], endings: [{ id: 'ending', nodeId: 'e', title: 'Home', type: 'good' }], nodes: [
    { id: 's', type: 'start', title: 'Archive', sceneDesc: 'Find the letter.', dialogue: [{ speaker: 'Archivist', text: 'This is your letter.', emotion: 'calm' }], choices: [{ id: 'go', text: 'Return home', targetNodeId: 'e' }] },
    { id: 'e', type: 'ending', title: 'Home', sceneDesc: 'Keep the letter.', dialogue: [], choices: [] },
  ] };
  const save = await request.post('/api/v1/artifacts/save', { data: { workId: work.id, title: graph.title, content: JSON.stringify(graph), format: 'json' } });
  expect(save.ok()).toBeTruthy();
  await page.goto(`/#works/${work.id}`);
  await expect(page.getByLabel('Inspect story node')).toBeVisible();
  await page.getByLabel('Inspect story node').selectOption('s');
  await expect(page.locator('.node-inspector')).toContainText('Archive');
  await expect(page.locator('.node-inspector')).toContainText('This is your letter.');
  await page.getByRole('button', { name: 'Return home → e', exact: true }).click();
  await expect(page.getByLabel('Inspect story node')).toHaveValue('e');
  await expect(page.locator('.node-inspector')).toContainText('Home');
});

test('translation domain retains source/target alignment, notes, review and terminology', async ({ page, request }) => {
  const response = await request.post('/api/v1/works/create', { data: { title: 'Human-authored translation', profile: 'translation', locale: 'fr', domain: { translation: {
    sourceLanguage: 'ja', targetLanguage: 'fr', glossary: { 手紙: 'lettre' }, chapters: [{ number: 1, title: 'Letter', translatedSegments: 1, observations: [{ assessment: 'issue', category: 'terminology', notes: 'Keep the glossary term' }], segments: [{ index: 1, source: '手紙を守る。', target: 'Protéger la lettre.', notes: 'Author-approved terminology' }] }],
  } } } });
  expect(response.ok()).toBeTruthy(); const work = await response.json();
  await page.goto(`/#works/${work.id}`);
  await expect(page.getByRole('heading', { name: 'Translation workspace', exact: true })).toBeVisible();
  await expect(page.locator('.translation-segment')).toContainText('手紙を守る。');
  await expect(page.locator('.translation-segment')).toContainText('Protéger la lettre.');
  await expect(page.locator('.translation-segment')).toContainText('Author-approved terminology');
  await expect(page.getByText('1 translated · 1 review issues', { exact: true })).toBeVisible();
  await page.getByText('Complete professional data', { exact: true }).click();
  await expect(page.locator('[aria-label="Professional domain data"] pre').last()).toContainText('glossary');
});
