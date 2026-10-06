import { describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import { createMegaNovelDomBinding } from '../publishing/meganovel-dom-binding.js';

// Network-free Page doubles exercise the real binding. All identities, titles,
// prose, URLs and page responses below are synthetic fixtures, not production
// account data or claims about current platform availability.
const ORIGIN = 'https://www.meganovel.com';
const TITLE = 'input[type="text"][placeholder="Chapter title"]';
const BODY = 'body#tinymce.mce-content-body[contenteditable="true"][spellcheck="false"]';
const ROWS = 'ul.episode-list li.episode-unit';
const PREVIEW = 'div.menu-publish.menu_preview.mr0';
const PUBLISH = 'div.menu-publish.menu_pub';
const scope = {sessionId: 'recovery-fixture-target', accountId: '700',
  accountLabel: 'recovery-fixture', remoteBookId: '99'};
const chapters = ['101', '102', '103'].map((remoteChapterId, index) => ({
  number: index + 1, remoteChapterId, title: `Fixture Chapter ${index + 1}`,
  content: `Fixture chapter ${index + 1} first paragraph.\n\nSecond paragraph.\n`,
  publicUrl: `${ORIGIN}/story/Fixture_Book_${scope.remoteBookId}/Fixture_Chapter_${remoteChapterId}`,
}));
const editorUrl = (id?: string) => `${ORIGIN}/create_chapter/${scope.remoteBookId}${id ? `?chapterId=${id}` : ''}`;
const signal = () => new AbortController().signal;

type PublicResult = 'available' | '404' | 'timeout' | 'body_mismatch' | 'title_mismatch';
type PreviewResult = 'canonical' | 'query' | 'popup_timeout' | 'load_timeout';
type FixtureOptions = {
  publicResult?: PublicResult;
  previewResult?: PreviewResult;
  placeholder?: {title: string; content: string; readError?: boolean};
  unpublished?: boolean;
  publishAction?: boolean;
};

function locator(options: {
  count?: number; text?: () => string; value?: () => string;
  click?: () => void; locator?: (selector: string) => ReturnType<typeof locator>;
  getByText?: (text: string | RegExp) => ReturnType<typeof locator>;
  nth?: (index: number) => ReturnType<typeof locator>;
  attribute?: (name: string) => string | null; allTexts?: () => string[];
  evaluate?: () => unknown;
} = {}): {
  count(): Promise<number>; isVisible(): Promise<boolean>; waitFor(): Promise<void>;
  filter(): ReturnType<typeof locator>; innerText(): Promise<string>; inputValue(): Promise<string>;
  click(): Promise<void>; fill(): Promise<never>; locator(selector: string): ReturnType<typeof locator>;
  getByText(text: string | RegExp): ReturnType<typeof locator>; nth(index: number): ReturnType<typeof locator>;
  getAttribute(name: string): Promise<string | null>; allTextContents(): Promise<string[]>;
  evaluate(): Promise<unknown>;
} {
  const count = options.count ?? 1;
  const result = {
    count: async () => count,
    isVisible: async () => count > 0,
    waitFor: async () => { if (!count) throw new Error('Fixture locator is absent'); },
    filter: () => result,
    innerText: async () => options.text?.() ?? '',
    inputValue: async () => options.value?.() ?? '',
    click: async () => { if (!options.click) throw new Error('Unexpected fixture click'); options.click(); },
    fill: async (): Promise<never> => { throw new Error('Read-only recovery must never fill an editor'); },
    locator: (selector: string) => {
      if (!options.locator) throw new Error(`Unexpected nested fixture selector: ${selector}`);
      return options.locator(selector);
    },
    getByText: (text: string | RegExp) => {
      if (!options.getByText) throw new Error(`Unexpected fixture text lookup: ${String(text)}`);
      return options.getByText(text);
    },
    nth: (index: number) => {
      if (!options.nth) throw new Error('Unexpected fixture nth lookup');
      return options.nth(index);
    },
    getAttribute: async (name: string) => options.attribute?.(name) ?? null,
    allTextContents: async () => options.allTexts?.() ?? [],
    evaluate: async () => options.evaluate?.(),
  };
  return result;
}

function fixture(options: FixtureOptions = {}) {
  const state = {
    url: editorUrl(chapters[2]!.remoteChapterId),
    publicResult: options.publicResult ?? 'available' as PublicResult,
    navigations: [] as string[], anonymousUrls: [] as string[],
    anonymousOptions: [] as unknown[], anonymousClosed: 0, accountClosed: 0,
    previewClicks: 0, previewClosed: 0, mutations: [] as string[],
  };
  const current = () => chapters.find(chapter => chapter.remoteChapterId === new URL(state.url).searchParams.get('chapterId'));
  const absent = () => locator({count: 0});
  const body = () => locator({text: () => {
    if (current()) return current()!.content;
    if (options.placeholder?.readError) throw new Error('Fixture interrupted body read');
    return options.placeholder?.content ?? '';
  }});
  const rows = [...(options.placeholder ? [undefined] : []), ...[...chapters].reverse()];
  const row = (index: number) => {
    const chapter = rows[index];
    return locator({
      text: () => chapter ? `${chapter.number}\n${chapter.title}${options.unpublished ? '\nUnpublished' : ''}` : 'Untitled Chapter\nUnpublished',
      click: () => { state.url = editorUrl(chapter?.remoteChapterId); },
      locator: selector => {
        if (selector !== '.episode-name.no-chapter-name') throw new Error(`Unexpected row selector: ${selector}`);
        return locator({count: chapter ? 0 : 1});
      },
      getByText: text => locator({count: chapter
        ? Number(text === chapter.title || text === 'Unpublished' && options.unpublished === true)
        : Number(text === 'Untitled Chapter' || text === 'Unpublished')}),
    });
  };
  const accountPage = {
    goto: async (url: string) => { expect(url).toBe(`${ORIGIN}/uc`); },
    locator: (selector: string) => {
      expect(selector).toBe('.user-center div.user-center-top');
      return locator({locator: nested => {
        expect(nested).toBe('span');
        return locator({allTexts: () => [`ID: ${scope.accountId}`]});
      }});
    },
    close: async () => { state.accountClosed++; },
  };
  const anonymous = () => {
    let url = '';
    const selected = () => chapters.find(chapter => url.endsWith(`_${chapter.remoteChapterId}`))!;
    return {
      setDefaultTimeout: () => undefined, setDefaultNavigationTimeout: () => undefined,
      newPage: async () => ({
        url: () => url,
        goto: async (destination: string) => {
          url = destination; state.anonymousUrls.push(destination);
          if (state.publicResult === 'timeout') throw Object.assign(new Error('Fixture reader timeout'), {name: 'TimeoutError'});
        },
        getByText: () => locator({count: Number(state.publicResult === '404')}),
        locator: (selector: string) => {
          expect(selector).toBe(`.read-box.chapter-out[data-chapterid="${selected().remoteChapterId}"]`);
          return locator({count: state.publicResult === '404' ? 0 : 1,
            attribute: name => {
              expect(name).toBe('data-chaptername');
              return state.publicResult === 'title_mismatch' ? 'A different title' : selected().title;
            },
            locator: nested => {
              expect(nested).toBe('div.read-content');
              return locator({text: () => state.publicResult === 'body_mismatch' ? 'A different body' : selected().content.replace(/\n+$/u, '')});
            },
          });
        },
      }),
      close: async () => { state.anonymousClosed++; },
    };
  };
  const page = {
    url: () => state.url,
    goto: async (url: string) => { state.navigations.push(url); state.url = url; },
    reload: async () => undefined,
    waitForURL: async (predicate: (url: URL) => boolean) => { expect(predicate(new URL(state.url))).toBe(true); },
    frames: () => [{locator: (selector: string) => { expect(selector).toBe(BODY); return body(); }}],
    getByText: () => absent(),
    locator: (selector: string) => {
      if (selector === TITLE) return locator({value: () => current()?.title ?? options.placeholder?.title ?? ''});
      if (selector === 'ul.episode-list') return locator({evaluate: () => ({scrollHeight: 500, clientHeight: 600, scrollTop: 0})});
      if (selector === ROWS) return locator({count: rows.length, nth: row});
      if (selector === '[role="dialog"], [aria-modal="true"], dialog[open]') return absent();
      if (selector === PREVIEW) return locator({click: () => { state.previewClicks++; }});
      if (selector === PUBLISH) return locator({count: Number(options.publishAction === true), click: () => { state.mutations.push('Publish'); }});
      throw new Error(`Unexpected author-page selector: ${selector}`);
    },
    waitForEvent: async (event: string) => {
      expect(event).toBe('popup');
      if (options.previewResult === 'popup_timeout') throw Object.assign(new Error('Fixture popup timeout'), {name: 'TimeoutError'});
      const url = `${current()!.publicUrl}${options.previewResult === 'query' ? '?preview=1' : ''}`;
      return {
        waitForLoadState: async () => {
          if (options.previewResult === 'load_timeout') throw Object.assign(new Error('Fixture preview load timeout'), {name: 'TimeoutError'});
        },
        url: () => url,
        close: async () => { state.previewClosed++; },
      };
    },
    context: () => ({newPage: async () => accountPage, browser: () => ({
      newContext: async (configuration: unknown) => { state.anonymousOptions.push(configuration); return anonymous(); },
    })}),
  };
  return {state, page: page as unknown as Page};
}

const binding = (known = true) => createMegaNovelDomBinding({uiTimeoutMs: 100,
  knownChapters: known ? chapters.map(({content: _content, ...chapter}) => chapter) : []});
const intent = (chapter = chapters[2]!) => ({packageId: `recovery-fixture-${chapter.number}`,
  chapterNumber: chapter.number, scope, aiAssisted: true, expectedTitle: chapter.title,
  remoteChapterId: chapter.remoteChapterId});

describe('MegaNovel DOM recovery through network-free Page doubles', () => {
  it.each(chapters)('keeps author-visible chapter $remoteChapterId submitted while its canonical guest reader is 404', async chapter => {
    const {page, state} = fixture({publicResult: '404'});
    const snapshot = await binding().snapshot(page, intent(chapter), signal());
    expect(snapshot.candidates).toHaveLength(1);
    expect(snapshot.candidates[0]).toMatchObject({remoteChapterId: chapter.remoteChapterId,
      number: chapter.number, content: chapter.content, status: 'submitted'});
    expect(state.anonymousUrls).toEqual([chapter.publicUrl]);
    expect(state.anonymousOptions).toEqual([{storageState: {cookies: [], origins: []}}]);
    expect(state.anonymousClosed).toBe(1);
    expect(state.mutations).toEqual([]);
  });

  it.each(chapters)('promotes chapter $remoteChapterId only when a later independent guest read matches its full body', async chapter => {
    const {page, state} = fixture({publicResult: '404'});
    const dom = binding();
    expect((await dom.snapshot(page, intent(chapter), signal())).candidates[0]!.status).toBe('submitted');
    state.publicResult = 'available';
    expect((await dom.snapshot(page, intent(chapter), signal())).candidates[0]!.status).toBe('published');
    expect(state.anonymousOptions).toEqual(Array.from({length: 2}, () => ({storageState: {cookies: [], origins: []}})));
    expect(state.anonymousClosed).toBe(2);
    expect(state.mutations).toEqual([]);
  });

  it.each(['query', 'popup_timeout', 'load_timeout'] as const)('preserves submitted state when author Preview produces %s', async previewResult => {
    const {page, state} = fixture({previewResult});
    const snapshot = await binding(false).snapshot(page, intent(), signal());
    expect(snapshot.candidates[0]).toMatchObject({remoteChapterId: chapters[2]!.remoteChapterId, status: 'submitted'});
    expect(state.anonymousOptions).toEqual([]);
    expect(state.previewClicks).toBe(1);
    expect(state.previewClosed).toBe(previewResult === 'popup_timeout' ? 0 : 1);
    expect(state.mutations).toEqual([]);
  });

  it('uses canonical Preview only as a destination and still checks a new anonymous context', async () => {
    const {page, state} = fixture({previewResult: 'canonical', publicResult: '404'});
    expect((await binding(false).snapshot(page, intent(), signal())).candidates[0]!.status).toBe('submitted');
    expect(state.previewClosed).toBe(1);
    expect(state.anonymousOptions).toEqual([{storageState: {cookies: [], origins: []}}]);
    expect(state.mutations).toEqual([]);
  });

  it.each(['body_mismatch', 'title_mismatch'] as const)('does not hide a public %s behind a submitted fallback', async publicResult => {
    const {page, state} = fixture({publicResult});
    await expect(binding().snapshot(page, intent(), signal())).rejects.toMatchObject({code: 'MEGANOVEL_CONTENT_CONFLICT'});
    expect(state.anonymousClosed).toBe(1);
    expect(state.mutations).toEqual([]);
  });

  it('keeps a guest reader transport timeout submitted without replay', async () => {
    const {page, state} = fixture({publicResult: 'timeout'});
    expect((await binding().snapshot(page, intent(), signal())).candidates[0]!.status).toBe('submitted');
    expect(state.anonymousClosed).toBe(1);
    expect(state.mutations).toEqual([]);
  });

  it('does not infer submission from a missing badge while a Publish action remains', async () => {
    const {page, state} = fixture({publicResult: '404', publishAction: true});
    await expect(binding().snapshot(page, intent(), signal())).rejects.toMatchObject({code: 'MEGANOVEL_PUBLICATION_UNVERIFIED'});
    expect(state.mutations).toEqual([]);
  });

  it('keeps a visibly Unpublished chapter a draft without consulting the guest reader', async () => {
    const {page, state} = fixture({unpublished: true, publishAction: true});
    expect((await binding().snapshot(page, intent(), signal())).candidates[0]!.status).toBe('draft');
    expect(state.anonymousOptions).toEqual([]);
    expect(state.mutations).toEqual([]);
  });

  it.each([
    {title: 'Recovered title', content: ''},
    {title: 'Untitled Chapter', content: 'Only surviving unsaved prose.'},
  ])('preserves the nonempty placeholder editor: $title / $content', async placeholder => {
    const {page, state} = fixture({placeholder});
    await expect(binding().probe(page, scope, signal())).rejects.toMatchObject({code: 'MEGANOVEL_INCOMPLETE_LOOKUP'});
    expect(state.url).toBe(editorUrl());
    expect(state.navigations).toEqual([]);
    expect(state.mutations).toEqual([]);
  });

  it('preserves the placeholder editor when its body cannot be read', async () => {
    const {page, state} = fixture({placeholder: {title: 'Untitled Chapter', content: '', readError: true}});
    await expect(binding().probe(page, scope, signal())).rejects.toThrow('Fixture interrupted body read');
    expect(state.url).toBe(editorUrl());
    expect(state.navigations).toEqual([]);
    expect(state.mutations).toEqual([]);
  });

  it('restores the saved chapter after verifying a truly empty placeholder', async () => {
    const {page, state} = fixture({placeholder: {title: 'Untitled Chapter', content: ''}});
    const original = state.url;
    expect((await binding().probe(page, scope, signal())).blocker).toBe('none');
    expect(state.url).toBe(original);
    expect(state.navigations).toEqual([original]);
    expect(state.mutations).toEqual([]);
  });
});
