import type { BrowserObservation, PublishingTarget, RemoteIdentity } from '../../publishing/contracts.js';
import { normalizeMegaNovelBodyText } from '../../publishing/meganovel-contracts.js';
import { runBrowserCode } from '../browser/session.js';
import { createBrowserPublisherExtension } from './browser-publisher.js';

export const MEGANOVEL_ORIGIN = 'https://www.meganovel.com';
export const MEGANOVEL_SKILL = `MegaNovel origin is https://www.meganovel.com.
Verify the signed-in account on /uc from visible .user-center div.user-center-top span text ID:number, not cookies. If its panel needs opening, find the actual opening control in the live snapshot.
Known editor URL: /create_chapter/{bookid}?chapterId={chapterid}; chapterId is absent for a first unsaved chapter. Never require a saved predecessor for an empty book.
Title: input[type=text][placeholder='Chapter title']. Body: exactly one frame's body#tinymce.mce-content-body[contenteditable=true][spellcheck=false]. Preserve internal whitespace; normalize only CRLF/CR and final newlines for readback.
Rows: ul.episode-list li.episode-unit. New Chapter is div.top div.side-bar-title with exact visible text New Chapter. Read real chapter IDs from the actual editor URL after opening/saving a row, never from an invented ID or ordinal.
Save: div.menu-publish.menu_save. Preview: .menu_preview.mr0. Publish: .menu_pub.
Use actual MCP browser_run_code or the listed browser interaction tools to fill the title and TinyMCE body. Multiline contenteditable fill can change blank lines: verify exact paragraph text, use Shift+Enter/insertText where needed, and compare full readback before saving.
Publish Schedule, Now, Later, Confirm belong to the actual observed dialog. Local scheduling already waited until due: select Now and confirm once. An interrupted Confirm must not be re-issued.
A matching author row without Unpublished and an editor without Publish establishes submitted ONLY. Do not claim publication or approval from the author UI.
A real public reader URL has /story/{slug}_{bookid}/{slug}_{chapterid}. Obtain it from actual links/preview; never fabricate slugs. published requires an independent public read with .read-box.chapter-out data-chapterid and div.read-content matching the selected body.
No create-book selectors are calibrated here. If the work is absent, dynamically inspect the author center, locate the real create-work control, fill supplied target metadata and cover, save once, capture the real work URL/ID and reopen it independently. Then create the first chapter. If required metadata is missing, report unknown rather than invent it.
An absent row after a timeout is not notApplied evidence. Never overwrite or republish a possibly submitted chapter. An explicit update uses the existing chapter and its actual edit/save controls, not New Chapter or Publish.`;
export function createMegaNovelExtension() {
  return createBrowserPublisherExtension({ id: 'meganovel', label: 'MegaNovel', capabilities: ['create-work', 'publish', 'update'], skill: MEGANOVEL_SKILL });
}
export function megaNovelEditorIdentity(value: string): { workId: string; artifactId: string | null } | null {
  const url = new URL(value);
  const workId = /^\/create_chapter\/(\d+)\/?$/u.exec(url.pathname)?.[1];
  if (url.origin !== MEGANOVEL_ORIGIN || !workId) return null;
  const chapter = url.searchParams.get('chapterId');
  return { workId, artifactId: chapter && /^\d+$/u.test(chapter) ? chapter : null };
}
export function megaNovelReaderIdentity(value: string): { workId: string; artifactId: string } | null {
  const url = new URL(value), parts = url.pathname.split('/').filter(Boolean);
  const workId = parts.length === 3 && parts[0] === 'story' ? /_(\d+)$/u.exec(parts[1]!)?.[1] : undefined;
  const artifactId = /_(\d+)$/u.exec(parts[2] ?? '')?.[1];
  return url.origin === MEGANOVEL_ORIGIN && !url.search && !url.hash && workId && artifactId ? { workId, artifactId } : null;
}
export type MegaNovelReadback = {
  accountId: string | null; authorUrl: string; title: string | null; body: string | null;
  rowPresent: boolean; unpublished: boolean; hasPublish: boolean;
  readerUrl: string | null; readerChapterId: string | null; readerBody: string | null;
};
/** Pure interpretation of freshly read actual DOM. Author submission is deliberately not publication. */
export function interpretMegaNovelReadback(read: MegaNovelReadback, evidence: string, now = Date.now()): BrowserObservation {
  const editor = megaNovelEditorIdentity(read.authorUrl), reader = read.readerUrl ? megaNovelReaderIdentity(read.readerUrl) : null;
  const remote: RemoteIdentity = { workId: editor?.workId ?? null, artifactId: editor?.artifactId ?? null,
    authorUrl: read.authorUrl, readerUrl: read.readerUrl };
  const publicMatch = editor?.artifactId && reader?.workId === editor.workId && reader.artifactId === editor.artifactId
    && read.readerChapterId === editor.artifactId && read.body !== null && read.readerBody !== null
    && normalizeMegaNovelBodyText(read.body) === normalizeMegaNovelBodyText(read.readerBody);
  const state = publicMatch ? 'published' : read.rowPresent && !read.unpublished && !read.hasPublish ? 'submitted'
    : read.rowPresent && read.unpublished && read.hasPublish ? 'draft' : 'unknown';
  return { state, accountId: read.accountId, remote, title: read.title, body: read.body,
    complete: Boolean(editor?.artifactId && read.title !== null && read.body !== null && state !== 'unknown'),
    notApplied: false, evidence, observedAt: now };
}
/** All browser execution uses the installed official MCP and its SDK. This does not fetch platform APIs. */
export async function observeMegaNovel(root: string, target: PublishingTarget, discovered: BrowserObservation,
  remote: RemoteIdentity, signal: AbortSignal): Promise<BrowserObservation> {
  const authorUrl = discovered.remote.authorUrl ?? remote.authorUrl;
  const readerUrl = discovered.remote.readerUrl ?? remote.readerUrl;
  // Discovery can inspect an empty book without a chapterId; never manufacture one to satisfy readback.
  if (!authorUrl || !megaNovelEditorIdentity(authorUrl)?.artifactId) {
    return discovered.state === 'absent' ? discovered : { ...discovered, state: 'unknown', complete: false, notApplied: false };
  }
  const read = await runBrowserCode<MegaNovelReadback>(root, target, `async (page) => {
    const accountPage = await page.context().newPage();
    let accountId = null;
    try {
      await accountPage.goto(${JSON.stringify(MEGANOVEL_ORIGIN + '/uc')}, {waitUntil:'domcontentloaded'});
      const spans = accountPage.locator('.user-center div.user-center-top span').filter({visible:true});
      const labels = await spans.allTextContents();
      const ids = labels.map(text => /^ID:\\s*(\\d+)$/.exec(text.trim())?.[1]).filter(Boolean);
      if (ids.length === 1) accountId = ids[0];
    } finally { await accountPage.close(); }
    await page.goto(${JSON.stringify(authorUrl)}, {waitUntil:'domcontentloaded'});
    const titleInput = page.locator('input[type="text"][placeholder="Chapter title"]');
    const title = await titleInput.count() === 1 ? await titleInput.inputValue() : null;
    const bodies = [];
    for (const frame of page.frames()) {
      const body = frame.locator('body#tinymce.mce-content-body[contenteditable="true"][spellcheck="false"]');
      if (await body.count() === 1 && await body.isVisible()) bodies.push(await body.innerText());
    }
    const body = bodies.length === 1 ? bodies[0] : null;
    const rows = page.locator('ul.episode-list li.episode-unit');
    const matches = [];
    for (let i=0; i<await rows.count(); i++) {
      const row = rows.nth(i);
      if (title !== null && await row.getByText(title,{exact:true}).count() === 1) matches.push(row);
    }
    const rowPresent = matches.length === 1;
    const unpublished = rowPresent && await matches[0].getByText('Unpublished',{exact:true}).count() === 1;
    const hasPublish = await page.locator('.menu_pub').filter({visible:true}).count() > 0;
    const result = {accountId, authorUrl:page.url(), title, body, rowPresent, unpublished, hasPublish,
      readerUrl:null, readerChapterId:null, readerBody:null};
    const readerUrl = ${JSON.stringify(readerUrl)};
    if (readerUrl) {
      const browser = page.context().browser();
      const anonymous = browser ? await browser.newContext() : null;
      if (anonymous) try {
        const reader = await anonymous.newPage();
        await reader.goto(readerUrl,{waitUntil:'domcontentloaded'});
        result.readerUrl = reader.url();
        const box = reader.locator('.read-box.chapter-out');
        const chapterId = new URL(page.url()).searchParams.get('chapterId');
        const matches = [];
        for(let i=0;i<await box.count();i++) if(await box.nth(i).getAttribute('data-chapterid') === chapterId) matches.push(box.nth(i));
        if(matches.length===1) {
          result.readerChapterId = await matches[0].getAttribute('data-chapterid');
          const content = matches[0].locator('div.read-content');
          if(await content.count()===1 && await content.isVisible()) result.readerBody = await content.innerText();
        }
      } catch {} finally { await anonymous.close(); }
    }
    return result;
  }`, signal);
  const observation = interpretMegaNovelReadback(read, discovered.evidence + '\nIndependent MCP account/editor/public-reader readback.');
  // Positive no-effect evidence is supplied by the fresh discovery workflow, not inferred from these DOM badges.
  observation.notApplied = discovered.notApplied && discovered.complete && observation.complete
    && discovered.accountId === observation.accountId && discovered.remote.artifactId === observation.remote.artifactId;
  return observation;
}
export default createMegaNovelExtension();
