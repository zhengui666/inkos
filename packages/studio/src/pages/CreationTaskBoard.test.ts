import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

// Exercise real JSX callbacks with React's render snapshots held until an
// explicit rerender. This covers same-tick admission and stale closures without
// a browser/DOM dependency; it is not a visual or browser E2E test.
const mock = vi.hoisted(() => ({
  slots: [] as any[], cursor: 0,
  data: null as any, loading: false, error: null as string | null,
  post: vi.fn(), put: vi.fn(), refresh: vi.fn(), open: vi.fn(),
}));
vi.mock('react', async importOriginal => ({
  ...await importOriginal<typeof import('react')>(),
  useState: (initial: any) => {
    const index = mock.cursor++;
    if (index >= mock.slots.length) mock.slots.push(typeof initial === 'function' ? initial() : initial);
    return [mock.slots[index], (value: any) => { mock.slots[index] = typeof value === 'function' ? value(mock.slots[index]) : value; }];
  },
  useRef: (initial: any) => {
    const index = mock.cursor++;
    if (index >= mock.slots.length) mock.slots.push({ current: initial });
    return mock.slots[index];
  },
  useEffect: vi.fn(),
}));
vi.mock('../hooks/use-api', () => ({
  useApi: () => ({ data: mock.data, loading: mock.loading, error: mock.error, refetch: mock.refresh }),
  postApi: mock.post, putApi: mock.put,
}));
vi.mock('../lib/app-language', () => ({ tr: (_zh: string, en: string) => en }));
import { CreationTaskBoard } from './CreationTaskBoard';

type Element = ReactElement<Record<string, any>>;
function nodes(value: any): Element[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== 'object' || !value.props) return [];
  return [value, ...nodes(value.props.children)];
}
function text(value: any): string {
  if (Array.isArray(value)) return value.map(text).join('');
  if (value && typeof value === 'object') return text(value.props?.children);
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}
function button(tree: Element, name: string): Element {
  const found = nodes(tree).find(node => node.type === 'button' && text(node) === name);
  if (!found) throw new Error(`Missing button ${name}`);
  return found;
}
function renderBoard() { mock.cursor = 0; return CreationTaskBoard({ onOpenWork: mock.open }); }
function cardRenderer(task = mock.data.tasks[0]) {
  const component = nodes(renderBoard()).find(node => typeof node.type === 'function' && node.type.name === 'TaskCard')!;
  mock.slots = [];
  return () => {
    mock.cursor = 0;
    return (component.type as (props: any) => Element)({ task, refresh: mock.refresh, onOpenWork: mock.open });
  };
}
const settle = async () => { for (let n = 0; n < 6; n++) await Promise.resolve(); };
function pending() { let resolve!: (value: any) => void; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

beforeEach(() => {
  mock.slots = []; mock.cursor = 0; mock.loading = false; mock.error = null;
  mock.post.mockReset().mockResolvedValue({}); mock.put.mockReset().mockResolvedValue({});
  mock.refresh.mockReset().mockResolvedValue(undefined); mock.open.mockReset();
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
  mock.data = {
    tasks: [{ id: 'fixture-task', workId: 'fixture-work', request: { kind: 'long', brief: 'A complete fictional brief.' },
      plan: { title: 'Fixture story', genre: 'mystery', language: 'en', platform: 'fixture', targetChapters: 12, chapterWordCount: 1800 },
      version: 3, desiredState: 'run', phase: 'writing', status: 'writing', foundation: 'completed', foundationAttempts: 1,
      canResume: true, writtenChapters: 1, reviewedChapters: 1, publishedChapters: 1, currentChapter: 1, stage: 'writing', receipts: [],
    }],
    runtime: { running: false, phase: 'idle' },
    publication: { configured: false, configurationStatus: 'missing', remoteBookCreation: false, emptyBookFirstChapter: false, requiresExistingRemoteBook: true },
  };
});

describe('Creation task board UI callbacks', () => {
  it('preserves a lost-response request through remount and suppresses repeat creation', async () => {
    let tree = renderBoard();
    nodes(tree).find(node => node.type === 'textarea')!.props.onChange({ target: { value: 'Two fictional sentences. With a finite ending.' } });
    tree = renderBoard(); const form = nodes(tree).find(node => node.type === 'form')!;
    mock.post.mockRejectedValueOnce(new Error('Response lost'));
    form.props.onSubmit({ preventDefault() {} }); form.props.onSubmit({ preventDefault() {} });
    expect(mock.post).toHaveBeenCalledTimes(1); await settle();
    const request = mock.post.mock.calls[0][1];
    mock.slots = []; tree = renderBoard();
    expect(nodes(tree).find(node => node.type === 'textarea')!.props.value).toContain('Two fictional');
    nodes(tree).find(node => node.type === 'form')!.props.onSubmit({ preventDefault() {} }); await settle();
    expect(mock.post.mock.calls[1][1]).toEqual(request);
    expect(Object.keys(request).sort()).toEqual(['brief', 'id', 'kind']);
    expect(nodes(renderBoard()).find(node => node.type === 'textarea')!.props.value).toBe('');
  });

  it.each(['pause', 'resume'])('admits only one same-tick %s and allows a later retry after settlement', async action => {
    if (action === 'resume') mock.data.tasks[0].desiredState = 'paused';
    const render = cardRenderer(); const held = pending(); mock.post.mockReturnValueOnce(held.promise);
    const control = button(render(), action === 'pause' ? 'Pause' : 'Resume');
    control.props.onClick(); control.props.onClick();
    expect(mock.post).toHaveBeenCalledTimes(1);
    expect(mock.post).toHaveBeenCalledWith(`/creation-tasks/fixture-task/${action}`, { version: 3 });
    held.resolve({}); await settle();
    button(render(), action === 'pause' ? 'Pause' : 'Resume').props.onClick(); await settle();
    expect(mock.post).toHaveBeenCalledTimes(2);
  });

  it('admits one runner retry and displays the returned runtime error', async () => {
    mock.data.runtime.error = 'Runner unavailable'; const held = pending(); mock.post.mockReturnValueOnce(held.promise);
    const retry = button(renderBoard(), 'Retry runner'); retry.props.onClick(); retry.props.onClick();
    expect(mock.post).toHaveBeenCalledTimes(1); expect(button(renderBoard(), 'Retrying…').props.disabled).toBe(true);
    held.resolve({ runtimeError: 'Still unavailable' }); await settle();
    expect(text(renderBoard())).toContain('Still unavailable');
    expect(button(renderBoard(), 'Retry runner').props.disabled).toBe(false);
  });

  it('captures the editor version instead of blessing a stale plan with polled state', async () => {
    const task = mock.data.tasks[0]; task.desiredState = 'paused'; const render = cardRenderer(task);
    button(render(), 'Edit plan').props.onClick();
    const oldPlan = { ...task.plan }; task.plan = { ...task.plan, targetChapters: 30 }; task.version = 4;
    mock.put.mockRejectedValueOnce(new Error('Task changed. Refresh before retrying this action.'));
    const form = nodes(render()).find(node => node.type === 'form')!; form.props.onSubmit({ preventDefault() {} }); await settle();
    expect(mock.put).toHaveBeenCalledWith('/creation-tasks/fixture-task/plan', { version: 3, plan: oldPlan });
    expect(text(render())).toContain('Task changed');
    button(render(), 'Cancel').props.onClick(); button(render(), 'Edit plan').props.onClick();
    nodes(render()).find(node => node.type === 'form')!.props.onSubmit({ preventDefault() {} }); await settle();
    expect(mock.put.mock.calls[1][1]).toEqual({ version: 4, plan: task.plan });
  });

  it('suppresses repeated plan saves and freezes numeric inputs during the request', async () => {
    mock.data.tasks[0].desiredState = 'paused'; const render = cardRenderer();
    button(render(), 'Edit plan').props.onClick(); const held = pending(); mock.put.mockReturnValueOnce(held.promise);
    const form = nodes(render()).find(node => node.type === 'form')!;
    form.props.onSubmit({ preventDefault() {} }); form.props.onSubmit({ preventDefault() {} });
    expect(mock.put).toHaveBeenCalledTimes(1);
    const numbers = nodes(render()).filter(node => node.type === 'input' && node.props.type === 'number');
    expect(numbers).toHaveLength(2); expect(numbers.every(node => node.props.disabled)).toBe(true);
    held.resolve({}); await settle(); expect(nodes(render()).filter(node => node.type === 'form')).toHaveLength(0);
  });

  it('does not save an open editor if another view has resumed the task', async () => {
    const task = mock.data.tasks[0]; task.desiredState = 'paused'; const render = cardRenderer(task);
    button(render(), 'Edit plan').props.onClick(); task.desiredState = 'run';
    expect(button(render(), 'Save plan').props.disabled).toBe(true);
    nodes(render()).find(node => node.type === 'form')!.props.onSubmit({ preventDefault() {} });
    expect(mock.put).not.toHaveBeenCalled();
  });

  it('cancel and opening a work never resume, create or save a task', () => {
    mock.data.tasks[0].desiredState = 'paused'; const render = cardRenderer();
    button(render(), 'Edit plan').props.onClick(); button(render(), 'Cancel').props.onClick();
    expect(nodes(render()).filter(node => node.type === 'form')).toHaveLength(0);
    button(render(), 'Open work').props.onClick(); expect(mock.open).toHaveBeenCalledWith('fixture-work');
    expect(mock.post).not.toHaveBeenCalled(); expect(mock.put).not.toHaveBeenCalled();
  });

  it('stopped and completed tasks do not offer unsafe resume', () => {
    const task = mock.data.tasks[0]; task.phase = 'blocked'; task.status = 'blocked'; task.canResume = false;
    const render = cardRenderer(task); expect(() => button(render(), 'Resume')).toThrow();
    expect(text(render())).toContain('Review budgets and uncertain submissions will not be reset');
    task.phase = 'completed'; task.status = 'completed';
    expect(text(render())).toContain('Completed and published'); expect(() => button(render(), 'Pause')).toThrow();
    expect(button(render(), 'Edit plan').props.disabled).toBe(true); expect(mock.post).not.toHaveBeenCalled();
  });

  it.each([false, true])('discloses fresh-book limitations before creation with configured=%s', configured => {
    mock.data.publication.configured = configured;
    mock.data.publication.configurationStatus = configured ? 'path_provided' : 'missing';
    const tree = renderBoard(); const content = text(tree);
    expect(content).toContain('Automatic remote-book creation and first-chapter submission to an empty book are unsupported');
    expect(content).toContain('Retained drafts, pending submissions and platform review do not count as published');
    if (configured) expect(content).toContain('account, binding and remote publication are not yet verified');
    expect(content).toContain('Sign-in and configuration do not establish that permission');
    const all = nodes(tree); expect(all.findIndex(node => node.props.role === 'note')).toBeLessThan(all.findIndex(node => node.type === 'form'));
    expect(all.filter(node => node.type === 'textarea')).toHaveLength(1);
    expect(all.filter(node => node.type === 'input' && node.props.type === 'radio')).toHaveLength(2);
  });

  it('does not claim a saved/empty board when initial status retrieval fails', () => {
    mock.data = null; mock.error = 'Offline unavailable'; const tree = renderBoard();
    expect(text(tree)).toContain('Status unconfirmed'); expect(text(tree)).not.toContain('Progress saved durably');
    button(tree, 'Retry task status').props.onClick(); expect(mock.refresh).toHaveBeenCalledTimes(1);
    expect(mock.post).not.toHaveBeenCalled();
  });
});
