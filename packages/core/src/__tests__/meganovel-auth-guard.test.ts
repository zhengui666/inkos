import { describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import { createMegaNovelDomBinding } from '../publishing/meganovel-dom-binding.js';

// Execute the production DOM binding against network-free Page doubles.
// The intercepted Chromium companion test exercises the same transitions.
const origin = 'https://www.meganovel.com';
const scope = {sessionId: 'auth-fixture', accountId: '700', accountLabel: 'auth-fixture', remoteBookId: '99'};
type Identity = 'correct' | 'wrong' | 'unknown' | 'logged_out';
type Transition = {at: 'new_chapter' | 'publish_dialog' | 'typing_batch'; identity: Identity};

function locator(options: {
  count?: () => number; text?: () => string; value?: () => string;
  click?: (options?: {trial?: boolean}) => void; fill?: (value: string) => void;
  locator?: (selector: string) => unknown; getByText?: (text: string | RegExp) => unknown;
  nth?: (index: number) => unknown; texts?: () => string[]; evaluate?: () => unknown;
  checked?: () => boolean; press?: () => void;
} = {}) {
  const count = () => options.count?.() ?? 1;
  const result = {
    count: async () => count(), isVisible: async () => count() > 0,
    waitFor: async () => { if (!count()) throw new Error('Synthetic visible control is absent'); },
    filter: () => result, innerText: async () => options.text?.() ?? '',
    inputValue: async () => options.value?.() ?? '',
    click: async (input?: {trial?: boolean}) => { options.click?.(input); },
    fill: async (value: string) => { if (!options.fill) throw new Error('Unexpected fill'); options.fill(value); },
    locator: (selector: string) => options.locator?.(selector),
    getByText: (text: string | RegExp) => options.getByText?.(text), nth: (index: number) => options.nth?.(index),
    allTextContents: async () => options.texts?.() ?? [], evaluate: async () => options.evaluate?.(),
    isChecked: async () => options.checked?.() ?? false,
    press: async () => { options.press?.(); },
    elementHandle: async () => ({dispose: async () => undefined}),
  };
  return result;
}

function fixture(initial: Identity = 'correct', transition?: Transition, accountDelayMs = 0) {
  const state = {identity: initial, url: `${origin}/create_chapter/99?chapterId=102`,
    title: 'Second', body: 'Synthetic body.', dialog: false, now: false,
    inputs: 0, saves: 0, publishes: 0, accountReads: 0, accountClosed: 0};
  const entered = () => {
    state.inputs++;
    if (transition?.at === 'typing_batch' && state.inputs >= 5) state.identity = transition.identity;
  };
  const absent = () => locator({count: () => 0});
  const body = locator({text: () => state.body, fill: value => { state.body = value; entered(); },
    evaluate: () => true, press: () => { state.body += '\n'; entered(); }});
  const title = locator({value: () => state.title, fill: value => { state.title = value; entered(); }});
  const row = (index: number) => locator({text: () => `${2 - index}\n${index ? 'First' : 'Second'}\nUnpublished`,
    locator: () => absent(), getByText: text => locator({count: () => Number(text === 'Unpublished')})});
  const accountPage = {
    goto: async (url: string) => {
      expect(url).toBe(`${origin}/uc`); state.accountReads++;
      if (accountDelayMs) await new Promise(resolve => setTimeout(resolve, accountDelayMs));
    },
    locator: (selector: string) => selector === '.user-center div.user-center-top'
      ? locator({count: () => Number(state.identity !== 'logged_out'), locator: () => locator({texts: () =>
        state.identity === 'unknown' ? [] : [`ID: ${state.identity === 'wrong' ? '701' : scope.accountId}`]})})
      : absent(),
    close: async () => { state.accountClosed++; },
  };
  const page = {
    url: () => state.url, goto: async (url: string) => { state.url = url; },
    frames: () => [{locator: () => body}], context: () => ({newPage: async () => accountPage}),
    keyboard: {insertText: async (value: string) => { state.body += value; entered(); }},
    waitForURL: async (predicate: (url: URL) => boolean) => { expect(predicate(new URL(state.url))).toBe(true); },
    getByRole: () => locator({checked: () => state.now}),
    getByText: (text: string | RegExp) => {
      if (typeof text !== 'string') return absent();
      return locator({count: () => Number(state.dialog), evaluate: () => ({text: 'Publish Schedule Now Later Confirm CANCEL', extraFields: false}),
        click: () => { if (text === 'Now') state.now = true; if (text === 'Confirm') state.publishes++; }});
    },
    locator: (selector: string) => {
      if (selector.startsWith('input[')) return title;
      if (selector === 'ul.episode-list') return locator({evaluate: () => ({scrollHeight: 100, clientHeight: 150, scrollTop: 0})});
      if (selector === 'ul.episode-list li.episode-unit') return locator({count: () => 2, nth: row});
      if (selector === '[role="dialog"], [aria-modal="true"], dialog[open]') return absent();
      if (selector === 'div.top div.side-bar-title') return locator({click: () => {
        state.url = `${origin}/create_chapter/99`; state.title = ''; state.body = '';
        if (transition?.at === 'new_chapter') state.identity = transition.identity;
      }});
      if (selector === 'div.menu-publish.menu_save') return locator({click: () => {
        state.saves++; state.url = `${origin}/create_chapter/99?chapterId=103`;
      }});
      if (selector === 'div.menu-publish.menu_pub') return locator({click: () => {
        state.dialog = true; if (transition?.at === 'publish_dialog') state.identity = transition.identity;
      }});
      throw new Error(`Unexpected synthetic selector: ${selector}`);
    },
  };
  const input = {packageId: 'auth-fixture-package', chapterNumber: 2, scope, aiAssisted: true,
    title: 'Second', content: 'Synthetic body.', revisionId: 'auth-fixture-revision', remoteChapterId: '102'};
  return {state, page: page as unknown as Page, input, binding: createMegaNovelDomBinding({uiTimeoutMs: 100}),
    signal: new AbortController().signal};
}

describe('MegaNovel identity guard using the production binding with synthetic pages', () => {
  it.each(['logged_out', 'wrong', 'unknown'] as const)('blocks initially %s identity without mutation', async identity => {
    const {state, page, binding, input, signal} = fixture(identity);
    await expect(binding.probe(page, scope, signal)).rejects.toThrow();
    await expect(binding.createDraft(page, input, signal)).rejects.toThrow();
    await expect(binding.submit(page, input, signal)).rejects.toThrow();
    expect(state.inputs + state.saves + state.publishes).toBe(0);
    expect(state.accountClosed).toBe(state.accountReads);
  });
  it.each(['logged_out', 'wrong', 'unknown'] as const)('rechecks identity becoming %s before autosaving input', async identity => {
    const {state, page, binding, input, signal} = fixture('correct', {at: 'new_chapter', identity});
    await expect(binding.createDraft(page, {...input, chapterNumber: 3, title: 'Third'}, signal)).rejects.toThrow();
    expect(state.inputs + state.saves + state.publishes).toBe(0);
    expect(state.accountClosed).toBe(state.accountReads);
  });
  it.each(['logged_out', 'wrong', 'unknown'] as const)('rechecks identity becoming %s before final publication confirmation', async identity => {
    const {state, page, binding, input, signal} = fixture('correct', {at: 'publish_dialog', identity});
    await expect(binding.submit(page, input, signal)).rejects.toThrow();
    expect(state.inputs + state.saves + state.publishes).toBe(0);
    expect(state.accountClosed).toBe(state.accountReads);
  });
  it('keeps the same configured identity usable through a draft and a submit', async () => {
    const draft = fixture();
    await draft.binding.createDraft(draft.page, {...draft.input, chapterNumber: 3, title: 'Third'}, draft.signal);
    expect(draft.state.saves).toBe(1);
    const submit = fixture();
    await submit.binding.submit(submit.page, submit.input, submit.signal);
    expect(submit.state.publishes).toBe(1);
  });
  it.each(['logged_out', 'wrong', 'unknown'] as const)('stops an in-flight typing batch when identity becomes %s without Save or Publish', async identity => {
    const {state, page, binding, input, signal} = fixture('correct', {at: 'typing_batch', identity});
    const content = Array.from({length: 100}, (_, index) => `Synthetic line ${index + 1}.`).join('\n');
    await expect(binding.createDraft(page, {...input, chapterNumber: 3, title: 'Third', content}, signal)).rejects.toThrow();
    expect(state.inputs).toBeLessThanOrEqual(16); // One title plus at most eight body lines and soft breaks.
    expect(state.saves + state.publishes).toBe(0);
    expect(state.accountClosed).toBe(state.accountReads);
  });
  it.each([50, 200])('bounds identity reads for 100 physical lines with a %ims account page', async accountDelay => {
    const {state, page, binding, input, signal} = fixture('correct', undefined, accountDelay);
    const content = Array.from({length: 100}, (_, index) => `Synthetic line ${index + 1}.`).join('\n');
    const started = Date.now();
    await binding.createDraft(page, {...input, chapterNumber: 3, title: 'Third', content}, signal);
    expect(state.body).toBe(content);
    expect(state.saves).toBe(1);
    expect(state.accountReads).toBeLessThanOrEqual(20);
    expect(Date.now() - started).toBeLessThan(8000);
    expect(state.accountClosed).toBe(state.accountReads);
  }, 10000);
});
