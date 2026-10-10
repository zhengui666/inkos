import type { Frame, Locator, Page } from 'playwright-core';
import { z } from 'zod';
import { publishingError } from './contracts.js';
import { normalizeMegaNovelBodyText, MegaNovelSnapshotRequestSchema, MegaNovelSubmissionBlockedError, type MegaNovelBrowserPort, type MegaNovelProbe,
  type MegaNovelScope, type MegaNovelSnapshot, type MegaNovelSnapshotRequest } from './meganovel-contracts.js';
import type { MegaNovelDomBinding } from './meganovel-cdp.js';

const ORIGIN = 'https://www.meganovel.com';
const TITLE = 'input[type="text"][placeholder="Chapter title"]';
const BODY = 'body#tinymce.mce-content-body[contenteditable="true"][spellcheck="false"]';
const ROWS = 'ul.episode-list li.episode-unit';
const SAVE = 'div.menu-publish.menu_save';
const PREVIEW = 'div.menu-publish.menu_preview.mr0';
const PUBLISH = 'div.menu-publish.menu_pub';
const KnownChapterSchema = z.object({
  number: z.number().int().positive(), title: z.string().min(1), remoteChapterId: z.string().regex(/^\d+$/u),
  // Supply an independently observed public URL. Do not invent title slugs.
  publicUrl: z.string().url(),
}).strict();
export const MegaNovelDomConfigurationSchema = z.object({
  // Observed visible avatar trigger; no build-specific attributes or image URL are used.
  avatarSelector: z.string().trim().min(1).default('div.nickname.right-item > img'),
  knownChapters: z.array(KnownChapterSchema).default([]),
  uiTimeoutMs: z.number().int().min(100).max(60000).default(10000),
}).strict();
export type MegaNovelDomConfiguration = z.input<typeof MegaNovelDomConfigurationSchema>;
type Row = {index: number; number: number; titleText: string; unpublished: boolean};
type Editor = {remoteChapterId: string; title: string; content: string};

/** Native UI implementation calibrated from authorized observations on 2026-10-06.
 * It never reads cookies, account state objects, application APIs, or hidden account-menu text.
 * Overflow/pagination/unrecognized rows fail closed until that new UI has been observed.
 */
export function createMegaNovelDomBinding(configuration: MegaNovelDomConfiguration = {}): MegaNovelDomBinding {
  const config = MegaNovelDomConfigurationSchema.parse(configuration);
  if (new Set(config.knownChapters.map(c => c.number)).size !== config.knownChapters.length
    || new Set(config.knownChapters.map(c => c.remoteChapterId)).size !== config.knownChapters.length) {
    throw publishingError('MEGANOVEL_DOM_CONFIG', 'Known chapter numbers and remote IDs must be unique.');
  }
  const recent = new Map<string, string>();
  const key = (input: {scope: MegaNovelScope; chapterNumber: number}) =>
    JSON.stringify([input.scope.sessionId, input.scope.accountId, input.scope.remoteBookId, input.chapterNumber]);
  const known = (number: number) => config.knownChapters.find(c => c.number === number);

  async function beforeEditorEffect(page: Page, scope: MegaNovelScope, signal: AbortSignal) {
    // A successful probe is not an authorization lease. The session can expire
    // or switch accounts during navigation, input or a publish dialog.
    await verifyVisibleAccount(page, scope, config.avatarSelector, config.uiTimeoutMs, signal);
    await checkEditor(page, scope, signal);
  }

  async function probe(page: Page, scope: MegaNovelScope, signal: AbortSignal): Promise<MegaNovelProbe> {
    signal.throwIfAborted();
    await verifyVisibleAccount(page, scope, config.avatarSelector, config.uiTimeoutMs, signal);
    signal.throwIfAborted();
    const url = new URL(page.url());
    if (url.origin !== ORIGIN) throw publishingError('MEGANOVEL_SCOPE_CHANGED', 'The owned tab left the official MegaNovel origin.');
    const currentEditor = editorIdentity(url.href);
    if (currentEditor && currentEditor.bookId !== scope.remoteBookId) throw publishingError('MEGANOVEL_SCOPE_CHANGED', 'The owned editor belongs to another book.');
    if (!currentEditor?.chapterId) {
      if (currentEditor) {
        await requireOne(page.locator(TITLE), 'Chapter title');
        const title = await page.locator(TITLE).inputValue();
        if (title.trim() && title !== 'Untitled Chapter' || (await (await editorBody(page)).innerText()).trim()) {
          throw publishingError('MEGANOVEL_PENDING_EDITOR', 'The unsaved editor contains text. Preserve it for reconciliation instead of navigating away.');
        }
      }
      const first = config.knownChapters[0];
      if (!first) throw publishingError('MEGANOVEL_EDITOR_REQUIRED', 'Open a verified existing chapter editor or configure observed historical chapter IDs.');
      await page.goto(editorUrl(scope.remoteBookId, first.remoteChapterId), {waitUntil: 'domcontentloaded'});
    }
    await checkEditor(page, scope, signal);
    await readRows(page, signal); // Current calibration covers a fully visible, unpaginated list only.
    return {scope, origin: ORIGIN, blocker: 'none'};
  }

  async function snapshot(page: Page, input: MegaNovelSnapshotRequest, signal: AbortSignal): Promise<MegaNovelSnapshot> {
    await probe(page, input.scope, signal);
    const expected = known(input.chapterNumber);
    const expectedTitle = input.expectedTitle ?? expected?.title;
    if (!expectedTitle) throw publishingError('MEGANOVEL_CHAPTER_IDENTITY_REQUIRED', 'Provide the frozen chapter title for scoped UI lookup.');
    if (expected && expected.title !== expectedTitle) throw publishingError('MEGANOVEL_CONTENT_CONFLICT', 'The configured historical title differs from the frozen selection.');
    const hint = input.remoteChapterId ?? expected?.remoteChapterId ?? recent.get(key(input));
    if (hint) {
      await page.goto(editorUrl(input.scope.remoteBookId, hint), {waitUntil: 'domcontentloaded'});
      const editor = await readEditor(page, input.scope, signal);
      if (editor.remoteChapterId !== hint) throw publishingError('MEGANOVEL_SCOPE_CHANGED', 'The editor redirected to another chapter.');
      const matching = await matchingRows(page, await readRows(page, signal), input.chapterNumber, editor.title);
      if (matching.length > 1) throw publishingError('MEGANOVEL_DUPLICATE_CHAPTER', 'More than one visible row matches this chapter.');
      const row = matching[0];
      const candidate = await observe(page, input.scope, row?.number ?? input.chapterNumber, editor, row, expected?.publicUrl, signal);
      return {scope: input.scope, origin: ORIGIN, blocker: 'none', chapterNumber: input.chapterNumber, complete: true, candidates: [candidate]};
    }
    // A cached author sidebar is not evidence of absence. Reopen it before any first submission.
    await page.reload({waitUntil: 'domcontentloaded'});
    await checkEditor(page, input.scope, signal);
    const rows = await readRows(page, signal);
    for (const historical of config.knownChapters) {
      const row = rows.find(row => row.number === historical.number);
      if (!row || await page.locator(ROWS).nth(row.index).getByText(historical.title, {exact: true}).count() !== 1) {
        throw publishingError('MEGANOVEL_INCOMPLETE_LOOKUP', 'The author list omits an independently known historical chapter. Absence is not established.');
      }
    }
    const matches = await matchingRows(page, rows, input.chapterNumber, expectedTitle);
    if (!matches.length) validateMegaNovelVisibleInventory(rows.map(row => row.number), input.chapterNumber - 1,
      config.knownChapters.map(chapter => chapter.number));
    const candidates: MegaNovelSnapshot['candidates'] = [];
    for (const row of matches) {
      signal.throwIfAborted();
      await page.locator(ROWS).nth(row.index).click(); // IDs are not present in row markup; read the real URL after clicking.
      await page.waitForURL(url => editorIdentity(url.href)?.bookId === input.scope.remoteBookId
        && Boolean(editorIdentity(url.href)?.chapterId), {timeout: config.uiTimeoutMs});
      const editor = await readEditor(page, input.scope, signal);
      candidates.push(await observe(page, input.scope, row.number, editor, row, undefined, signal));
    }
    return {scope: input.scope, origin: ORIGIN, blocker: 'none', chapterNumber: input.chapterNumber, complete: true, candidates};
  }

  async function observe(page: Page, scope: MegaNovelScope, number: number, editor: Editor,
    row: Row | undefined, publicUrl: string | undefined, signal: AbortSignal): Promise<MegaNovelSnapshot['candidates'][number]> {
    const aiDisclosure = await disclosureState(page);
    if (row?.unpublished) return {...editor, number, status: 'draft', aiDisclosure,
      evidence: `Reopened author editor ${editor.remoteChapterId}; visible matching row says Unpublished; title and body read.`};
    // The lack of an Unpublished badge is NOT proof of publication. Verify the real public reader.
    let publication: string;
    try {
      publication = publicUrl
        ? await readPublic(page, publicUrl, scope, editor, config.uiTimeoutMs, signal)
        : await readObservedPreview(page, scope, editor, config.uiTimeoutMs, signal);
    } catch (error) {
      if ((error as {code?: string}).code === 'MEGANOVEL_PUBLICATION_UNVERIFIED'
        && megaNovelAuthorSubmissionVisible(Boolean(row), row?.unpublished ?? true, await page.locator(PUBLISH).count() > 0)) {
        return {...editor, number, status: 'submitted', aiDisclosure,
          evidence: `Author chapter ${editor.remoteChapterId} and its body were reopened; the matching row is no longer Unpublished and the editor offers no Publish action. Anonymous public readback is still unconfirmed; no review outcome is inferred.`};
      }
      throw error;
    }
    if (normalizeMegaNovelBodyText(publication) !== normalizeMegaNovelBodyText(editor.content)) {
      throw publishingError('MEGANOVEL_CONTENT_CONFLICT', 'The public reader body differs from the reopened author editor.');
    }
    return {...editor, number, status: 'published', aiDisclosure,
      evidence: `Reopened author editor and actual public reader for chapter ${editor.remoteChapterId}; exact title and ordinary body text agree.`};
  }

  return {
    protocol: 'inkos-meganovel-dom-v1',
    calibration: {observedAt: '2026-10-06T00:00:00Z',
      evidence: 'Calibration date has day precision; the midnight timestamp does not identify a session. Authorized visible author-center account menu, editor/TinyMCE, chapter rows and public reader observations on 2026-10-06. Overflow and new UI remain unsupported.'},
    probe, snapshot,
    observeSnapshot: (page, input, signal) => snapshot(page, MegaNovelSnapshotRequestSchema.parse(input), signal),
    async createDraft(page, input, signal, beforeMutation) {
      const guard = async () => { await beforeMutation?.(); signal.throwIfAborted(); };
      await probe(page, input.scope, signal);
      const newChapter = page.locator('div.top div.side-bar-title').filter({hasText: /^New Chapter$/u});
      await requireOne(newChapter, 'New Chapter');
      const previousId = editorIdentity(page.url())?.chapterId;
      await beforeEditorEffect(page, input.scope, signal);
      await guard();
      await newChapter.click();
      await page.waitForURL(url => editorIdentity(url.href)?.bookId === input.scope.remoteBookId
        && editorIdentity(url.href)?.chapterId !== previousId, {timeout: config.uiTimeoutMs});
      await checkEditor(page, input.scope, signal);
      const title = await page.locator(TITLE).inputValue();
      const body = await editorBody(page);
      if (title.trim() && title !== 'Untitled Chapter' || (await body.innerText()).trim()) {
        throw publishingError('MEGANOVEL_NONEMPTY_DRAFT', 'New Chapter did not open an empty editor. Do not overwrite an existing draft.');
      }
      await beforeEditorEffect(page, input.scope, signal);
      await page.locator(TITLE).click({trial: true});
      signal.throwIfAborted();
      await guard();
      await page.locator(TITLE).fill(input.title);
      await beforeEditorEffect(page, input.scope, signal);
      let identityCheckedAt = Date.now();
      await body.click({trial: true}); // Unlike fill, a trial click checks covering overlays in both frames.
      signal.throwIfAborted();
      // A multiline contenteditable fill creates Chromium block wrappers that
      // can add internal blank lines. Enter explicit soft breaks through the
      // observed editor UI, then verify the resulting text before Save.
      const lines = input.content.replace(/\r\n?/gu, '\n').split('\n');
      await guard();
      await body.fill(lines[0]!);
      for (let index = 1; index < lines.length; index++) {
        const line = lines[index]!;
        // Bound each typing batch without navigating /uc for every keystroke.
        // Before the next line, recheck at an eight-line boundary or when the
        // last check is two seconds old. Individual browser awaits may take longer.
        // Every input still checks the live editor and cancellation.
        if (index % 8 === 0 || Date.now() - identityCheckedAt >= 2000) {
          await beforeEditorEffect(page, input.scope, signal);
          identityCheckedAt = Date.now();
        } else await checkEditor(page, input.scope, signal);
        await body.click({trial: true});
        signal.throwIfAborted();
        await guard();
        await body.press('Shift+Enter');
        await checkEditor(page, input.scope, signal);
        if (line) {
          if (!await body.evaluate(element => element.ownerDocument.activeElement === element)) {
            throw publishingError('MEGANOVEL_EDITOR_FOCUS_CHANGED', 'The observed body no longer owns keyboard focus. Preserve it without further typing.');
          }
          signal.throwIfAborted();
          await guard();
          await page.keyboard.insertText(line);
        }
      }
      await checkEditor(page, input.scope, signal);
      if (await page.locator(TITLE).inputValue() !== input.title
        || normalizeMegaNovelBodyText(await body.innerText()) !== normalizeMegaNovelBodyText(input.content)) {
        throw publishingError('MEGANOVEL_CONTENT_CONFLICT', 'Editor input changed the frozen body text. Preserve the unsaved editor; do not click Save or Publish.');
      }
      await requireOne(page.locator(SAVE), 'Save');
      await beforeEditorEffect(page, input.scope, signal);
      await guard();
      await page.locator(SAVE).click();
      await page.waitForURL(url => editorIdentity(url.href)?.bookId === input.scope.remoteBookId
        && Boolean(editorIdentity(url.href)?.chapterId), {timeout: config.uiTimeoutMs});
      recent.set(key(input), editorIdentity(page.url())!.chapterId!);
    },
    async submit(page, input, signal, beforeMutation) {
      const guard = async () => {
        try { await beforeMutation?.(); signal.throwIfAborted(); }
        catch (error) { throw new MegaNovelSubmissionBlockedError(error); }
      };
      await probe(page, input.scope, signal);
      await page.goto(editorUrl(input.scope.remoteBookId, input.remoteChapterId), {waitUntil: 'domcontentloaded'});
      const editor = await readEditor(page, input.scope, signal);
      if (editor.remoteChapterId !== input.remoteChapterId || editor.title !== input.title
        || normalizeMegaNovelBodyText(editor.content) !== normalizeMegaNovelBodyText(input.content)) {
        throw publishingError('MEGANOVEL_CONTENT_CONFLICT', 'The final editor does not match the frozen draft.');
      }
      if (await disclosureState(page) !== 'not_present') throw publishingError('MEGANOVEL_DISCLOSURE_UNVERIFIED', 'A new AI declaration UI needs truthful mapping before submission.');
      await requireOne(page.locator(PUBLISH), 'Publish');
      await beforeEditorEffect(page, input.scope, signal);
      await guard();
      await page.locator(PUBLISH).click();
      const scheduleTitle = page.getByText('Publish Schedule', {exact: true}).filter({visible: true});
      await requireOne(scheduleTitle, 'Publish Schedule');
      const now = page.getByText('Now', {exact: true}).filter({visible: true});
      const confirm = page.getByText('Confirm', {exact: true}).filter({visible: true});
      await requireOne(now, 'Now');
      await requireOne(confirm, 'Confirm');
      const later = page.getByText('Later', {exact: true}).filter({visible: true});
      const cancel = page.getByText('CANCEL', {exact: true}).filter({visible: true});
      await requireOne(later, 'Later');
      await requireOne(cancel, 'CANCEL');
      await verifyVisibleAccount(page, input.scope, config.avatarSelector, config.uiTimeoutMs, signal);
      await verifyScheduleDialog(scheduleTitle, [now, later, confirm, cancel]);
      signal.throwIfAborted();
      await guard();
      await now.click();
      const selectedNow = page.getByRole('radio', {name: 'Now', exact: true});
      if (await selectedNow.count() !== 1 || !await selectedNow.isChecked()) {
        throw publishingError('MEGANOVEL_SCHEDULE_UNVERIFIED', 'The observed Now radio state could not be confirmed. Do not click Confirm.');
      }
      await verifyVisibleAccount(page, input.scope, config.avatarSelector, config.uiTimeoutMs, signal);
      const finalEditor = editorIdentity(page.url());
      if (finalEditor?.bookId !== input.scope.remoteBookId || finalEditor.chapterId !== input.remoteChapterId) {
        throw publishingError('MEGANOVEL_SCOPE_CHANGED', 'The publish dialog belongs to another book or chapter.');
      }
      await verifyScheduleDialog(scheduleTitle, [now, later, confirm, cancel]);
      signal.throwIfAborted();
      await guard();
      try { beforeMutation?.authorizeSubmission?.(input); signal.throwIfAborted(); }
      catch (error) { throw new MegaNovelSubmissionBlockedError(error); }
      // Authorization and issuing this request share a host call stack. Remote
      // execution is asynchronous; filesystem writes and DOM are not atomic.
      await confirm.click(); // Exactly one final action. Readback is performed independently by the adapter.
    },
  };
}

async function requireOne(locator: Locator, name: string) {
  await locator.waitFor({state: 'visible'});
  if (await locator.count() !== 1 || !await locator.isVisible()) throw publishingError('MEGANOVEL_UNRECOGNIZED_UI', `Expected one visible ${name} control.`);
}
function editorIdentity(value: string) {
  const url = new URL(value);
  const book = /^\/create_chapter\/(\d+)$/u.exec(url.pathname)?.[1];
  if (url.origin !== ORIGIN || !book) return undefined;
  const chapter = url.searchParams.get('chapterId');
  return {bookId: book, chapterId: chapter && /^\d+$/u.test(chapter) ? chapter : undefined};
}
function editorUrl(bookId: string, chapterId: string) {
  if (!/^\d+$/u.test(bookId) || !/^\d+$/u.test(chapterId)) throw publishingError('MEGANOVEL_DOM_CONFIG', 'Observed MegaNovel editor IDs must be numeric.');
  return `${ORIGIN}/create_chapter/${bookId}?chapterId=${chapterId}`;
}
async function checkEditor(page: Page, scope: MegaNovelScope, signal: AbortSignal) {
  signal.throwIfAborted();
  if (editorIdentity(page.url())?.bookId !== scope.remoteBookId) throw publishingError('MEGANOVEL_SCOPE_CHANGED', 'The actual editor URL identifies another book.');
  await requireOne(page.locator(TITLE), 'Chapter title');
  await editorBody(page);
  if (await page.locator('[role="dialog"], [aria-modal="true"], dialog[open]').filter({visible: true}).count()) {
    throw publishingError('MEGANOVEL_BROWSER_BLOCKED', 'An unexpected visible dialog is covering the editor.');
  }
  const blocker = page.getByText(/I (?:agree|accept)|terms of (?:service|use)|copyright agreement|sign (?:a|the) contract|payment required|verify your identity|captcha|security verification|quota exceeded|limit reached/iu).filter({visible: true});
  if (await blocker.count()) throw publishingError('MEGANOVEL_BROWSER_BLOCKED', 'A visible agreement, authentication, risk, quota or payment notice requires attention.');
  signal.throwIfAborted();
}
async function verifyScheduleDialog(title: Locator, controls: Locator[]) {
  const handles = await Promise.all(controls.map(control => control.elementHandle()));
  if (handles.some(handle => !handle)) throw publishingError('MEGANOVEL_UNRECOGNIZED_UI', 'The observed publish-schedule controls disappeared.');
  try {
    const observed = await title.evaluate((node, others) => {
      type VisibleElement = {parentElement: VisibleElement | null; contains(other: unknown): boolean;
        innerText?: string; querySelectorAll(selector: string): ArrayLike<{
          getClientRects(): {length: number}; tagName: string; getAttribute(name: string): string | null;
        }>};
      let container: VisibleElement | null = node as unknown as VisibleElement;
      while (container && others.some(other => !other || !container!.contains(other))) container = container.parentElement;
      if (typeof container?.innerText !== 'string') return null;
      const extraFields = Array.from(container.querySelectorAll('input,select,textarea')).some(field =>
        field.getClientRects().length > 0 && !(field.tagName === 'INPUT' && field.getAttribute('type')?.toLowerCase() === 'radio'));
      return {text: container.innerText, extraFields};
    }, handles);
    let remainder = observed?.text ?? 'unrecognized dialog';
    for (const label of ['Publish Schedule', 'Now', 'Later', 'Confirm', 'CANCEL']) remainder = remainder.replace(label, '');
    if (remainder.trim() || observed?.extraFields) throw publishingError('MEGANOVEL_UNRECOGNIZED_UI', 'The publish dialog contains unobserved text, fields or terms. Do not confirm it.');
  } finally { await Promise.all(handles.map(handle => handle?.dispose())); }
}
async function editorBody(page: Page): Promise<Locator> {
  const frames: Frame[] = [];
  for (const frame of page.frames()) if (await frame.locator(BODY).count() === 1) frames.push(frame);
  if (frames.length !== 1) throw publishingError('MEGANOVEL_UNRECOGNIZED_UI', 'Expected exactly one observed TinyMCE body frame.');
  const body = frames[0]!.locator(BODY);
  await requireOne(body, 'TinyMCE body');
  return body;
}
async function readEditor(page: Page, scope: MegaNovelScope, signal: AbortSignal): Promise<Editor> {
  await checkEditor(page, scope, signal);
  const remoteChapterId = editorIdentity(page.url())?.chapterId;
  if (!remoteChapterId) throw publishingError('MEGANOVEL_REMOTE_ID_MISSING', 'The editor has no actual saved chapter ID. A blank placeholder is not a chapter.');
  return {remoteChapterId, title: await page.locator(TITLE).inputValue(), content: await (await editorBody(page)).innerText()};
}
async function verifyVisibleAccount(page: Page, scope: MegaNovelScope, avatarSelector: string | undefined,
  timeout: number, signal: AbortSignal) {
  const accountPage = await page.context().newPage();
  try {
    await accountPage.goto(`${ORIGIN}/uc`, {waitUntil: 'domcontentloaded', timeout});
    signal.throwIfAborted();
    const panel = accountPage.locator('.user-center div.user-center-top');
    if (!await panel.isVisible()) {
      if (!avatarSelector) throw publishingError('MEGANOVEL_SESSION_IDENTITY_UNVERIFIED', 'The visible account-menu opening control has not been calibrated.');
      const avatar = accountPage.locator(avatarSelector);
      await requireOne(avatar, 'account avatar');
      signal.throwIfAborted();
      await avatar.click();
    }
    await requireOne(panel, 'logged-in account menu');
    const labels = await panel.locator('span').filter({visible: true}).allTextContents();
    const ids = labels.map(text => /^ID:\s*(\d+)$/u.exec(text.trim())?.[1]).filter(Boolean);
    if (ids.length !== 1 || ids[0] !== scope.accountId) throw publishingError('MEGANOVEL_SCOPE_CHANGED', 'The visible logged-in account ID differs from the configured account.');
    signal.throwIfAborted();
  } finally { await accountPage.close(); }
}
async function readRows(page: Page, signal: AbortSignal): Promise<Row[]> {
  const list = page.locator('ul.episode-list');
  await requireOne(list, 'chapter list');
  const bounds = await list.evaluate(element => ({scrollHeight: element.scrollHeight, clientHeight: element.clientHeight, scrollTop: element.scrollTop}));
  if (bounds.clientHeight <= 0 || bounds.scrollHeight > bounds.clientHeight + 1 || bounds.scrollTop !== 0) {
    throw publishingError('MEGANOVEL_INCOMPLETE_LOOKUP', 'The chapter list exceeds the observed fully visible unpaginated layout. Inspect its new boundary before continuing.');
  }
  const rows = page.locator(ROWS);
  const result: Row[] = [];
  for (let index = 0; index < await rows.count(); index++) {
    const row = rows.nth(index);
    if (!await row.isVisible()) throw publishingError('MEGANOVEL_INCOMPLETE_LOOKUP', 'A chapter-list row is hidden.');
    const titleText = await row.innerText();
    if (await row.locator('.episode-name.no-chapter-name').count() === 1
      && await row.getByText('Untitled Chapter', {exact: true}).count() === 1
      && await row.getByText('Unpublished', {exact: true}).count() === 1) {
      await verifyBlankPlaceholder(page, row, signal);
      continue;
    }
    const number = Number(/^\s*(\d+)\b/u.exec(titleText)?.[1]);
    if (!Number.isSafeInteger(number) || number < 1) throw publishingError('MEGANOVEL_UNRECOGNIZED_UI', 'A non-placeholder row has no observed chapter ordinal.');
    result.push({index, number, titleText, unpublished: await row.getByText('Unpublished', {exact: true}).count() === 1});
  }
  validateMegaNovelVisibleInventory(result.map(row => row.number));
  return result;
}
/** Pure validation of observed ordinals; cached chapter totals never participate. */
export function validateMegaNovelVisibleInventory(numbers: number[], requiredThrough = 0, knownNumbers: number[] = []) {
  if (numbers.some((number, index) => number !== numbers.length - index)
    || numbers.length < requiredThrough || knownNumbers.some(number => !numbers.includes(number))) {
    throw publishingError('MEGANOVEL_INCOMPLETE_LOOKUP', 'The visible chapter rows are incomplete, duplicated, or omit a required predecessor/known chapter.');
  }
}
/** The observed post-submission author UI establishes submission only, never guest publication. */
export function megaNovelAuthorSubmissionVisible(rowPresent: boolean, unpublished: boolean, hasPublishAction: boolean): boolean {
  return rowPresent && !unpublished && !hasPublishAction;
}
async function verifyBlankPlaceholder(page: Page, row: Locator, signal: AbortSignal) {
  const originalUrl = page.url();
  const original = editorIdentity(originalUrl);
  if (!original?.chapterId) throw publishingError('MEGANOVEL_INCOMPLETE_LOOKUP', 'A saved editor is required to inspect and restore the unnumbered placeholder safely.');
  let verifiedEmpty = false;
  try {
    signal.throwIfAborted();
    await row.click();
    await page.waitForURL(url => editorIdentity(url.href)?.bookId === original.bookId
      && !editorIdentity(url.href)?.chapterId);
    await requireOne(page.locator(TITLE), 'blank chapter title');
    const title = await page.locator(TITLE).inputValue();
    const content = await (await editorBody(page)).innerText();
    if (title.trim() && title !== 'Untitled Chapter' || content.trim()) {
      throw publishingError('MEGANOVEL_INCOMPLETE_LOOKUP', 'An unnumbered draft contains text. It cannot be excluded as an empty placeholder.');
    }
    verifiedEmpty = true;
    signal.throwIfAborted();
  } finally {
    // A nonempty or unreadable editor may hold unsaved work. Never navigate
    // away from it to tidy up a failed read-only inventory check.
    if (verifiedEmpty && page.url() !== originalUrl) await page.goto(originalUrl, {waitUntil: 'domcontentloaded'});
  }
}
async function matchingRows(page: Page, rows: Row[], number: number, title: string) {
  const matches: Row[] = [];
  for (const row of rows) if (row.number === number || await page.locator(ROWS).nth(row.index).getByText(title, {exact: true}).count() > 0) matches.push(row);
  return matches;
}
async function disclosureState(page: Page): Promise<'not_present' | 'unverified'> {
  const disclosure = page.getByText(/AI[- ](?:generated|assisted)|AI disclosure/iu).filter({visible: true});
  return await disclosure.count() === 0 ? 'not_present' : 'unverified';
}
async function publicBody(page: Page, scope: MegaNovelScope, editor: Editor, signal: AbortSignal) {
  signal.throwIfAborted();
  const url = new URL(page.url());
  const parts = url.pathname.split('/').filter(Boolean);
  if (url.origin !== ORIGIN || url.search || url.hash || parts.length !== 3 || parts[0] !== 'story'
    || !parts[1]!.endsWith(`_${scope.remoteBookId}`) || !parts[2]!.endsWith(`_${editor.remoteChapterId}`)) {
    throw publishingError('MEGANOVEL_PUBLICATION_UNVERIFIED', 'The observed page is not this chapter’s actual public reader.');
  }
  const box = page.locator(`.read-box.chapter-out[data-chapterid="${editor.remoteChapterId}"]`);
  if (await box.count() === 0 && await page.getByText(/^(?:404|current book does not exist[.!]?)$/iu).filter({visible: true}).count()) {
    throw publishingError('MEGANOVEL_PUBLICATION_UNVERIFIED', 'The anonymous public reader reports that this book or chapter is unavailable. Do not resubmit.');
  }
  await requireOne(box, 'public chapter');
  if (await box.getAttribute('data-chaptername') !== editor.title) throw publishingError('MEGANOVEL_CONTENT_CONFLICT', 'The public chapter title differs.');
  const body = box.locator('div.read-content');
  await requireOne(body, 'public chapter body');
  return body.innerText();
}
async function readPublic(page: Page, url: string, scope: MegaNovelScope, editor: Editor, timeout: number, signal: AbortSignal) {
  // Validate the supplied observed destination before visiting it.
  const target = new URL(url);
  if (target.origin !== ORIGIN || !target.pathname.endsWith(`_${editor.remoteChapterId}`)
    || target.search || target.hash) throw publishingError('MEGANOVEL_DOM_CONFIG', 'Use the observed public chapter URL without tracking parameters.');
  const browser = page.context().browser();
  if (!browser) throw publishingError('MEGANOVEL_PUBLICATION_UNVERIFIED', 'An independent anonymous reader context is unavailable.');
  const anonymous = await browser.newContext({storageState: {cookies: [], origins: []}});
  anonymous.setDefaultTimeout(timeout);
  anonymous.setDefaultNavigationTimeout(timeout);
  try {
    const reader = await anonymous.newPage();
    await reader.goto(url, {waitUntil: 'domcontentloaded'});
    return await publicBody(reader, scope, editor, signal);
  } catch (error) {
    if (signal.aborted || (error as {code?: string}).code) throw error;
    throw publishingError('MEGANOVEL_PUBLICATION_UNVERIFIED', 'The anonymous public reader did not confirm this chapter. Preserve its real ID and pending attempt; do not resubmit.');
  } finally { await anonymous.close(); }
}
async function readObservedPreview(page: Page, scope: MegaNovelScope, editor: Editor, timeout: number, signal: AbortSignal) {
  try {
  await requireOne(page.locator(PREVIEW), 'Preview');
  signal.throwIfAborted();
  const [reader] = await Promise.all([page.waitForEvent('popup', {timeout}), page.locator(PREVIEW).click()]);
  // An unobserved same-tab/modal preview is not silently accepted.
  let observedUrl: string;
  try {
    await reader.waitForLoadState('domcontentloaded');
    observedUrl = reader.url();
  } finally { await reader.close(); }
  // Author preview only supplies a real observed destination. Publication requires a cookie-free read.
  const observed = new URL(observedUrl);
  if (observed.origin !== ORIGIN || observed.search || observed.hash
    || !observed.pathname.endsWith(`_${editor.remoteChapterId}`)) {
    throw publishingError('MEGANOVEL_PUBLICATION_UNVERIFIED', 'The author preview did not supply a canonical anonymous reader destination. Preserve the submitted chapter; do not resubmit.');
  }
  return readPublic(page, observedUrl, scope, editor, timeout, signal);
  } catch (error) {
    if (signal.aborted || (error as {code?: string}).code) throw error;
    throw publishingError('MEGANOVEL_PUBLICATION_UNVERIFIED', 'The observed author preview did not establish anonymous public availability. Preserve the chapter and reconcile without resubmitting.');
  }
}
