import { afterEach, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright-core';
import { createMegaNovelDomBinding } from '../publishing/meganovel-dom-binding.js';

// Synthetic local Chromium pages. Every request is intercepted, including /uc.
// The configured ID is an assertion target, never an authenticated live session.
const origin = 'https://www.meganovel.com';
const scope = {sessionId: 'auth-fixture', accountId: '700', accountLabel: 'auth-fixture', remoteBookId: '99'};
const enabled = process.env.INKOS_BROWSER_FIXTURES === '1' ? describe : describe.skip;
type Identity = 'correct' | 'wrong' | 'unknown' | 'logged_out';
let browser: Browser | undefined;
afterEach(async () => { await browser?.close(); browser = undefined; });

async function fixture(initial: Identity = 'correct', transition?: {at: 'new_chapter' | 'publish_dialog'; identity: Identity}) {
  browser = await chromium.launch({headless: true,
    ...(process.env.INKOS_FIXTURE_CHROMIUM ? {executablePath: process.env.INKOS_FIXTURE_CHROMIUM} : {})});
  const context = await browser.newContext();
  context.setDefaultTimeout(400);
  const state = {identity: initial, saves: 0, publishes: 0, accountReads: 0};
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/__fixture_transition') {
      if (transition?.at === 'publish_dialog') state.identity = transition.identity;
      return route.fulfill({json: {ok: true}});
    }
    if (url.pathname === '/__fixture_save') { state.saves++; return route.fulfill({json: {ok: true}}); }
    if (url.pathname === '/__fixture_publish') { state.publishes++; return route.fulfill({json: {ok: true}}); }
    let html: string;
    if (url.pathname === '/uc') {
      state.accountReads++;
      html = state.identity === 'logged_out' ? '<div>Join or Log in</div><button>Google</button>'
        : `<div class="user-center"><div class="user-center-top"><span>${state.identity === 'unknown'
          ? 'Identity unavailable' : `ID: ${state.identity === 'wrong' ? '701' : scope.accountId}`}</span></div></div>`;
    } else if (url.pathname === '/create_chapter/99') {
      const blank = !url.searchParams.has('chapterId');
      if (blank && transition?.at === 'new_chapter') state.identity = transition.identity;
      html = `<div class="top"><div class="side-bar-title" onclick="location.href='/create_chapter/99'">New Chapter</div></div>
        <ul class="episode-list" style="height:150px"><li class="episode-unit"><div>2</div><div>Second</div><div>Unpublished</div></li><li class="episode-unit"><div>1</div><div>First</div></li></ul>
        <input type="text" placeholder="Chapter title" value="${blank ? '' : 'Second'}">
        <iframe srcdoc="<body id='tinymce' class='mce-content-body' contenteditable='true' spellcheck='false'>${blank ? '' : 'Synthetic body.'}</body>"></iframe>
        <div class="menu-publish menu_save" onclick="save()">Save</div>
        <div class="menu-publish menu_pub" onclick="schedule()">PUBLISH</div>
        <div id="dialog" style="display:none"><div>Publish Schedule</div><label><input type="radio" name="schedule">Now</label><label><input type="radio" name="schedule">Later</label><button onclick="publish()">Confirm</button><button>CANCEL</button></div>
        <script>
          async function save(){await fetch('/__fixture_save');location.href='/create_chapter/99?chapterId=103';}
          async function schedule(){await fetch('/__fixture_transition');document.querySelector('#dialog').style.display='block';}
          async function publish(){await fetch('/__fixture_publish');}
        </script>`;
    } else return route.abort();
    return route.fulfill({contentType: 'text/html', body: `<!doctype html><html><body>${html}</body></html>`});
  });
  const page = await context.newPage();
  await page.goto(`${origin}/create_chapter/99?chapterId=102`);
  const binding = createMegaNovelDomBinding({uiTimeoutMs: 400});
  const input = {packageId: 'auth-fixture-package', chapterNumber: 2, scope, aiAssisted: true,
    title: 'Second', content: 'Synthetic body.', revisionId: 'auth-fixture-revision', remoteChapterId: '102'};
  return {state, page, binding, input, signal: new AbortController().signal};
}

enabled('MegaNovel authentication boundary in intercepted Chromium', () => {
  it.each(['logged_out', 'wrong', 'unknown'] as const)('blocks %s before editing or publication', async identity => {
    const {state, page, binding, input, signal} = await fixture(identity);
    await expect(binding.probe(page, scope, signal)).rejects.toThrow();
    await expect(binding.createDraft(page, input, signal)).rejects.toThrow();
    await expect(binding.submit(page, input, signal)).rejects.toThrow();
    expect(await page.locator('input[placeholder="Chapter title"]').inputValue()).toBe('Second');
    expect(state.saves).toBe(0);
    expect(state.publishes).toBe(0);
  });

  it.each(['logged_out', 'wrong', 'unknown'] as const)('blocks identity becoming %s while opening a new chapter', async identity => {
    const {state, page, binding, input, signal} = await fixture('correct', {at: 'new_chapter', identity});
    await expect(binding.createDraft(page, {...input, chapterNumber: 3, title: 'Third'}, signal)).rejects.toThrow();
    expect(await page.locator('input[placeholder="Chapter title"]').inputValue()).toBe('');
    expect(state.saves).toBe(0);
    expect(state.publishes).toBe(0);
  });

  it.each(['logged_out', 'wrong', 'unknown'] as const)('blocks identity becoming %s while the publish dialog opens', async identity => {
    const {state, page, binding, input, signal} = await fixture('correct', {at: 'publish_dialog', identity});
    await expect(binding.submit(page, input, signal)).rejects.toThrow();
    expect(state.saves).toBe(0);
    expect(state.publishes).toBe(0);
  });
});
