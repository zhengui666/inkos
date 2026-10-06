import { afterEach, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Route } from 'playwright-core';
import { createMegaNovelDomBinding, MegaNovelDomConfigurationSchema, validateMegaNovelVisibleInventory } from '../publishing/meganovel-dom-binding.js';
import { normalizeMegaNovelBodyText } from '../publishing/meganovel-contracts.js';

describe('MegaNovel observed DOM configuration', () => {
  it('uses the observed avatar trigger, not a build attribute or public-author link', () => {
    expect(MegaNovelDomConfigurationSchema.parse({}).avatarSelector).toBe('div.nickname.right-item > img');
    expect(createMegaNovelDomBinding().protocol).toBe('inkos-meganovel-dom-v1');
  });
  it('rejects duplicate historical IDs/numbers rather than choosing a row silently', () => {
    const chapter = {number: 1, title: 'First', remoteChapterId: '101', publicUrl: 'https://www.meganovel.com/story/Fixture_99/First_101'};
    expect(() => createMegaNovelDomBinding({knownChapters: [chapter, chapter]})).toThrow('unique');
  });
  it('only normalizes physical line endings and terminal newlines', () => {
    expect(normalizeMegaNovelBodyText('One\r\n\r\nTwo.\n')).toBe('One\n\nTwo.');
    expect(normalizeMegaNovelBodyText('One  two. ')).toBe('One  two. ');
    expect(normalizeMegaNovelBodyText('One\nTwo')).not.toBe(normalizeMegaNovelBodyText('One\n\nTwo'));
  });
  it('does not treat a cached lower chapter count as proof that a new chapter is absent', () => {
    expect(() => validateMegaNovelVisibleInventory([2, 1], 3, [1, 2, 3])).toThrow();
    expect(() => validateMegaNovelVisibleInventory([3, 2, 1], 4, [1, 2, 3])).toThrow();
    expect(() => validateMegaNovelVisibleInventory([3, 1], 3, [1, 2, 3])).toThrow();
    expect(() => validateMegaNovelVisibleInventory([3, 2, 1], 3, [1, 2, 3])).not.toThrow();
  });
});

// Opt in only on an executor where ephemeral Chromium processes are permitted.
// Every page request is intercepted below; no real MegaNovel account or site is accessed.
const browserFixtures = process.env.INKOS_BROWSER_FIXTURES === '1' ? describe : describe.skip;
let browser: Browser | undefined;
afterEach(async () => { await browser?.close(); browser = undefined; });

type Chapter = {number: number; id: string; title: string; body: string; published: boolean};
const origin = 'https://www.meganovel.com';
const scope = {sessionId: 'fixture-target', accountId: '700', accountLabel: 'fixture', remoteBookId: '99'};
const escape = (value: string) => value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;');
const scriptJson = (value: unknown) => (JSON.stringify(value) ?? 'null').replace(/</gu, '\\u003c');
const publicUrl = (chapter: Chapter) => `${origin}/story/Fixture_99/Observed_${chapter.id}`;

async function fixture(context: BrowserContext) {
  const chapters: Chapter[] = [
    {number: 1, id: '101', title: 'First', body: 'First paragraph.\n\nSecond paragraph.\n', published: true},
    {number: 2, id: '102', title: 'Second', body: 'Second chapter body.\n', published: true},
    {number: 3, id: '103', title: 'Third', body: 'Third chapter body.\n', published: true},
  ];
  const state = {chapters, saveCount: 0, publishCount: 0, accountId: '700', overflow: false,
    lastSavedEditor: undefined as {body: string; html: string} | undefined};
  const handler = async (route: Route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/__fixture_save') {
      const data = route.request().postDataJSON() as {id?: string; title: string; body: string; html: string};
      state.lastSavedEditor = {body: data.body, html: data.html};
      let chapter = chapters.find(item => item.id === data.id);
      if (!chapter) { chapter = {number: chapters.length + 1, id: String(101 + chapters.length), title: data.title, body: data.body, published: false}; chapters.push(chapter); }
      else { chapter.title = data.title; chapter.body = data.body; }
      state.saveCount++;
      return route.fulfill({json: {id: chapter.id}});
    }
    if (url.pathname === '/__fixture_publish') {
      const data = route.request().postDataJSON() as {id: string};
      chapters.find(item => item.id === data.id)!.published = true;
      state.publishCount++;
      return route.fulfill({json: {ok: true}});
    }
    let html: string;
    if (url.pathname === '/uc') {
      html = `<div class="nickname right-item"><img width="30" height="30" alt="" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E" onclick="document.querySelector('.user-center').style.display='block'"></div>
        <div class="user-center" style="display:none"><div class="user-center-top"><strong>Fixture author</strong><span>ID: ${state.accountId}</span></div></div>`;
    } else if (url.pathname === '/create_chapter/99') {
      const chapter = chapters.find(item => item.id === url.searchParams.get('chapterId'));
      html = editor(chapters, chapter, state.overflow);
    } else if (url.pathname.startsWith('/story/Fixture_99/')) {
      const id = /_(\d+)$/u.exec(url.pathname)?.[1];
      const chapter = chapters.find(item => item.id === id && item.published);
      html = chapter ? `<div>Cached catalog count: 1</div><div class="read-box chapter-out" data-chapterid="${chapter.id}" data-chaptername="${escape(chapter.title)}">
        <div id="${chapter.id}" class="title">${escape(chapter.title)}</div><div class="read-content fontSize20" style="white-space:pre-wrap">${escape(chapter.body.replace(/\n+$/u, ''))}</div></div>` : '<div>Chapter unavailable</div>';
    } else return route.abort();
    return route.fulfill({contentType: 'text/html', body: `<!doctype html><html><body>${html}</body></html>`});
  };
  await context.route('**/*', handler);
  return Object.assign(state, {install: (other: BrowserContext) => other.route('**/*', handler)});
}

function editor(chapters: Chapter[], chapter: Chapter | undefined, overflow: boolean) {
  const empty = '<li class="episode-unit" style="height:80px" onclick="location.href=\'/create_chapter/99\'"><div class="episode-name no-chapter-name">Untitled Chapter</div><div>Unpublished</div><div>Delete</div><div>PUBLISH</div></li>';
  const rows = [...chapters].reverse().map(item => `<li class="episode-unit" style="height:80px;cursor:pointer" onclick="location.href='/create_chapter/99?chapterId=${item.id}'"><div>${item.number}</div><div class="episode-name">${escape(item.title)}</div><div>${item.published ? '' : 'Unpublished'}</div><div>2000 Words</div></li>`).join('');
  const iframe = `<body id="tinymce" class="mce-content-body" contenteditable="true" spellcheck="false" style="white-space:pre-wrap">${escape(chapter?.body ?? '')}</body>`;
  return `<div class="top"><div class="side-bar-title" onclick="location.href='/create_chapter/99'">New Chapter</div></div>
    <ul class="episode-list" style="height:${overflow ? 120 : 660}px;overflow:auto;margin:0;padding:0;list-style:none">${empty}${rows}</ul>
    <input type="text" placeholder="Chapter title" value="${escape(chapter?.title ?? '')}"><iframe style="height:120px;width:700px" srcdoc="${escape(iframe)}"></iframe>
    <div class="menu-publish menu_save" onclick="save()">Save</div><div class="menu-publish menu_preview mr0" onclick="window.open('/story/Fixture_99/Observed_'+id)">Preview</div>
    ${!chapter?.published ? '<div class="menu-publish menu_pub" onclick="document.querySelector(\'#dialog\').style.display=\'block\'">PUBLISH</div>' : ''}
    <div id="dialog" style="display:none"><div>Publish Schedule</div><label><input type="radio" name="schedule" value="now">Now</label><label><input type="radio" name="schedule" value="later">Later</label><button onclick="publish()">Confirm</button><button>CANCEL</button></div>
    <script>let id=${scriptJson(chapter?.id)};
      async function save(){const r=await fetch('/__fixture_save',{method:'POST',body:JSON.stringify({id,title:document.querySelector('input[placeholder]').value,body:document.querySelector('iframe').contentDocument.body.innerText,html:document.querySelector('iframe').contentDocument.body.innerHTML})});id=(await r.json()).id;location.href='/create_chapter/99?chapterId='+id;}
      async function publish(){await fetch('/__fixture_publish',{method:'POST',body:JSON.stringify({id})});location.reload();}
    </script>`;
}

browserFixtures('MegaNovel observed DOM binding in an isolated network-blocked Chromium fixture', () => {
  it('reads real-shaped history, ignores stale totals/empty placeholder, and writes/publishes one new chapter through UI only', async () => {
    browser = await chromium.launch({headless: true, ...(process.env.INKOS_FIXTURE_CHROMIUM ? {executablePath: process.env.INKOS_FIXTURE_CHROMIUM} : {})});
    const context = await browser.newContext();
    const state = await fixture(context);
    const newContext = browser.newContext.bind(browser);
    vi.spyOn(browser, 'newContext').mockImplementation(async options => {
      const anonymous = await newContext(options);
      await state.install(anonymous); // Intercept every request from anonymous readback too.
      expect(await anonymous.cookies()).toEqual([]);
      return anonymous;
    });
    const page = await context.newPage();
    page.setDefaultTimeout(3000);
    await page.goto(`${origin}/create_chapter/99?chapterId=103`);
    const binding = createMegaNovelDomBinding({knownChapters: state.chapters.map(chapter => ({number: chapter.number,
      title: chapter.title, remoteChapterId: chapter.id, publicUrl: publicUrl(chapter)})), uiTimeoutMs: 3000});
    const signal = new AbortController().signal;
    for (const chapter of state.chapters) {
      const snapshot = await binding.snapshot(page, {packageId: `fixture-${chapter.number}`, chapterNumber: chapter.number,
        scope, aiAssisted: true, expectedTitle: chapter.title}, signal);
      expect(snapshot.candidates[0]).toMatchObject({remoteChapterId: chapter.id, status: 'published', title: chapter.title});
      expect(normalizeMegaNovelBodyText(snapshot.candidates[0]!.content)).toBe(normalizeMegaNovelBodyText(chapter.body));
    }
    const input = {packageId: 'fixture-four', chapterNumber: 4, scope, aiAssisted: true,
      title: 'Fourth', content: 'A new reviewed paragraph.\n\nFinal paragraph.\n', revisionId: 'fixture-revision'};
    expect((await binding.snapshot(page, {...input, expectedTitle: input.title}, signal)).candidates).toEqual([]);
    await binding.createDraft(page, input, signal);
    expect(normalizeMegaNovelBodyText(state.lastSavedEditor!.body), JSON.stringify(state.lastSavedEditor)).toBe(normalizeMegaNovelBodyText(input.content));
    const draft = await binding.snapshot(page, {...input, expectedTitle: input.title}, signal);
    expect(draft.candidates[0]).toMatchObject({status: 'draft', remoteChapterId: '104', number: 4});
    expect(draft.candidates[0]!.title).toBe(input.title);
    expect(normalizeMegaNovelBodyText(draft.candidates[0]!.content)).toBe(normalizeMegaNovelBodyText(input.content));
    await binding.submit(page, {...input, remoteChapterId: '104'}, signal);
    const published = await binding.snapshot(page, {...input, expectedTitle: input.title, remoteChapterId: '104'}, signal);
    expect(published.candidates[0]!.status).toBe('published');
    expect(state.saveCount).toBe(1);
    expect(state.publishCount).toBe(1);
    expect(state.chapters).toHaveLength(4);
    state.accountId = '701';
    await expect(binding.probe(page, scope, signal)).rejects.toMatchObject({code: 'MEGANOVEL_SCOPE_CHANGED'});
    state.accountId = '700'; state.overflow = true;
    await page.reload();
    await expect(binding.probe(page, scope, signal)).rejects.toMatchObject({code: 'MEGANOVEL_INCOMPLETE_LOOKUP'});
    expect(state.saveCount).toBe(1);
  }, 30000);
});
