import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectMegaNovelCdpPort, validateMegaNovelCdpEndpoint, type MegaNovelCdpConfiguration,
  type MegaNovelDomBinding } from '../publishing/meganovel-cdp.js';
import { PublisherStartupCleanupError } from '../publishing/publisher-cleanup.js';

const fixture = vi.hoisted(() => ({connect: vi.fn()}));
vi.mock('playwright-core', () => ({chromium: {connectOverCDP: fixture.connect}}));
let root: string;
let config: MegaNovelCdpConfiguration;
let binding: MegaNovelDomBinding;
let connected: boolean;
let pageURL: string;
let events: EventEmitter;
let browser: {once: EventEmitter['once']; close: ReturnType<typeof vi.fn>; isConnected: () => boolean; contexts: () => unknown[]};
let port: Awaited<ReturnType<typeof connectMegaNovelCdpPort>> | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'inkos-cdp-fixture-'));
  config = {endpointURL: 'ws://127.0.0.1:9222/devtools/browser/browser-1',
    scope: {sessionId: 'target-1', accountId: 'account-1', accountLabel: 'author', remoteBookId: 'book-1'},
    lockDirectory: root, operationTimeoutMs: 100,
    authorization: {automation: {provenance: 'user_reported', reference: 'Fixture authorization only'},
      aiAssistedContent: {provenance: 'user_reported', reference: 'Fixture AI authorization only'}}};
  connected = true;
  pageURL = 'https://www.meganovel.com/fixture-only';
  const page = {url: () => pageURL, isClosed: () => false, setDefaultTimeout: vi.fn(), setDefaultNavigationTimeout: vi.fn()};
  const context = {pages: () => [page], newCDPSession: async () => ({
    send: async () => ({targetInfo: {targetId: 'target-1'}}), detach: vi.fn()})};
  events = new EventEmitter();
  browser = {once: events.once.bind(events), close: vi.fn(async () => { connected = false; events.emit('disconnected'); }), isConnected: () => connected, contexts: () => [context]};
  fixture.connect.mockReset().mockResolvedValue(browser);
  binding = {protocol: 'inkos-meganovel-dom-v1',
    calibration: {observedAt: '2026-10-06T00:00:00Z', evidence: 'Synthetic binding. No live selectors or acceptance claimed.'},
    probe: vi.fn<MegaNovelDomBinding['probe']>(async () => ({scope: config.scope, origin: 'https://www.meganovel.com', blocker: 'none'})),
    snapshot: vi.fn<MegaNovelDomBinding['snapshot']>(async (_page, input) => ({scope: config.scope, origin: 'https://www.meganovel.com',
      blocker: 'none', chapterNumber: input.chapterNumber, complete: true, candidates: []})),
    createDraft: vi.fn(async () => undefined), submit: vi.fn(async () => undefined)};
});
afterEach(async () => { if (port) await port.close(); port = undefined; await rm(root, {recursive: true, force: true}); });

describe('MegaNovel actual CDP transport with synthetic browser driver', () => {
  it.each(['https://127.0.0.1:9222/', 'http://localhost:9222/', 'http://example.com:9222/',
    'http://127.0.0.1/', 'http://user:secret@127.0.0.1:9222/', 'http://127.0.0.1:9222/path',
    'http://127.0.0.1:9222/?token=secret', 'ws://127.0.0.1:9222/arbitrary', 'not a URL'])('rejects endpoint %s', value => {
    expect(() => validateMegaNovelCdpEndpoint(value)).toThrow();
  });
  it('accepts explicit numeric loopback endpoints only', () => {
    expect(validateMegaNovelCdpEndpoint('http://127.0.0.1:9222')).toBe('http://127.0.0.1:9222/');
    expect(validateMegaNovelCdpEndpoint('ws://[::1]:9222/devtools/browser/abc')).toBe('ws://[::1]:9222/devtools/browser/abc');
  });
  it('missing binding fails before connecting or creating a browser reservation', async () => {
    await expect(connectMegaNovelCdpPort(config)).rejects.toMatchObject({code: 'MEGANOVEL_BINDING_MISSING'});
    expect(fixture.connect).not.toHaveBeenCalled();
    expect((await readdir(root)).filter(name => name.endsWith('.lock'))).toEqual([]);
  });
  it('does not infer automation or AI permission from a configured endpoint', async () => {
    await expect(connectMegaNovelCdpPort({...config, authorization: undefined} as unknown as MegaNovelCdpConfiguration, binding)).rejects.toThrow();
    expect(fixture.connect).not.toHaveBeenCalled();
  });
  it('connects a pre-existing target without defaults and probes without any mutation', async () => {
    port = await connectMegaNovelCdpPort(config, binding);
    expect(fixture.connect).toHaveBeenCalledWith(config.endpointURL, {timeout: 15000, noDefaults: true});
    expect(binding.probe).toHaveBeenCalledOnce();
    expect(binding.createDraft).not.toHaveBeenCalled();
    expect(binding.submit).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual(expect.arrayContaining(['target-1.lock', 'target-1.lock.sqlite']));
  });
  it('does not steal another process or stale browser lock', async () => {
    port = await connectMegaNovelCdpPort(config, binding);
    await expect(connectMegaNovelCdpPort(config, binding)).rejects.toMatchObject({code: 'MEGANOVEL_BROWSER_BUSY'});
    expect(fixture.connect).toHaveBeenCalledTimes(1);
  });
  it('refuses a replacement target rather than choosing the first tab', async () => {
    await expect(connectMegaNovelCdpPort({...config, scope: {...config.scope, sessionId: 'gone-target'}}, binding))
      .rejects.toMatchObject({code: 'MEGANOVEL_BROWSER_TARGET_MISSING'});
    expect(browser.close).toHaveBeenCalledOnce();
    expect((await readdir(root)).filter(name => name.endsWith('.lock'))).toEqual([]);
  });
  it('bounds target discovery and disconnects if the CDP target-info request never resolves', async () => {
    const context = browser.contexts()[0] as {newCDPSession: () => Promise<unknown>};
    context.newCDPSession = async () => ({send: () => new Promise(() => undefined), detach: vi.fn()});
    await expect(connectMegaNovelCdpPort(config, binding)).rejects.toMatchObject({code: 'MEGANOVEL_BROWSER_TIMEOUT'});
    expect(connected).toBe(false);
    expect(binding.probe).not.toHaveBeenCalled();
    expect((await readdir(root)).filter(name => name.endsWith('.lock'))).toEqual([]);
  });
  it('rejects an unrecognized origin without running the binding', async () => {
    pageURL = 'https://example.com';
    await expect(connectMegaNovelCdpPort(config, binding)).rejects.toMatchObject({code: 'MEGANOVEL_BROWSER_BLOCKED'});
    expect(binding.probe).not.toHaveBeenCalled();
  });
  it('rechecks account/book/blockers before each mutation', async () => {
    port = await connectMegaNovelCdpPort(config, binding);
    binding.probe = vi.fn<MegaNovelDomBinding['probe']>(async () => ({scope: config.scope, origin: 'https://www.meganovel.com', blocker: 'agreement'}));
    await expect(port.createDraft({packageId: 'package-1', chapterNumber: 1, scope: config.scope,
      aiAssisted: true, revisionId: 'revision-1', title: 'Title', content: 'Body'}))
      .rejects.toMatchObject({code: 'MEGANOVEL_BROWSER_BLOCKED'});
    expect(binding.createDraft).not.toHaveBeenCalled();
  });
  it.each(['createDraft', 'submit'] as const)('rechecks authority after transport preflight and passes the guard to %s', async operation => {
    port = await connectMegaNovelCdpPort(config, binding);
    const input = {packageId: 'package-1', chapterNumber: 1, scope: config.scope, aiAssisted: true,
      revisionId: 'revision-1', title: 'Title', content: 'Body', remoteChapterId: 'remote-1'};
    let changed = false;
    binding.probe = vi.fn(async () => { changed = true; return {scope: config.scope, origin: 'https://www.meganovel.com' as const, blocker: 'none' as const}; });
    const beforeMutation = vi.fn(async () => { if (changed) throw Object.assign(new Error('New author brief'), {code: 'CHAPTER_REVIEW_INPUTS_CHANGED'}); });
    await expect(port[operation](input, {beforeMutation})).rejects.toMatchObject({code: 'CHAPTER_REVIEW_INPUTS_CHANGED'});
    expect(binding[operation]).not.toHaveBeenCalled();
    changed = false;
    binding.probe = vi.fn(async () => ({scope: config.scope, origin: 'https://www.meganovel.com' as const, blocker: 'none' as const}));
    await port[operation](input, {beforeMutation});
    expect(binding[operation]).toHaveBeenCalledWith(expect.anything(), input, expect.any(AbortSignal), beforeMutation);
  });
  it('serializes binding operations on its owned target', async () => {
    port = await connectMegaNovelCdpPort(config, binding);
    const order: string[] = [];
    binding.snapshot = vi.fn<MegaNovelDomBinding['snapshot']>(async (_page, input) => {
      order.push(`start-${input.chapterNumber}`);
      await new Promise(resolve => setTimeout(resolve, 5));
      order.push(`end-${input.chapterNumber}`);
      return {scope: config.scope, origin: 'https://www.meganovel.com', blocker: 'none', chapterNumber: input.chapterNumber, complete: true, candidates: []};
    });
    const intent = {packageId: 'package-1', chapterNumber: 1, scope: config.scope, aiAssisted: true};
    await Promise.all([port.snapshot(intent), port.snapshot({...intent, chapterNumber: 2})]);
    expect(order).toEqual(['start-1', 'end-1', 'start-2', 'end-2']);
  });
  it('disconnects and quarantines timed-out work before another operation can act', async () => {
    port = await connectMegaNovelCdpPort(config, binding);
    let observedSignal: AbortSignal | undefined;
    binding.createDraft = vi.fn(async (_page, _input, signal) => { observedSignal = signal; await new Promise(() => undefined); });
    await expect(port.createDraft({packageId: 'package-1', chapterNumber: 1, scope: config.scope,
      aiAssisted: true, revisionId: 'revision-1', title: 'Title', content: 'Body'}))
      .rejects.toMatchObject({code: 'MEGANOVEL_BROWSER_TIMEOUT'});
    expect(connected).toBe(false);
    expect(observedSignal!.aborted).toBe(true);
    await expect(port.probe(config.scope)).rejects.toMatchObject({code: 'MEGANOVEL_BROWSER_CLOSED'});
    expect(binding.createDraft).toHaveBeenCalledTimes(1);
    expect(await readdir(root)).toEqual(expect.arrayContaining(['target-1.lock', 'target-1.lock.sqlite'])); // Held until explicit transport disposal.
  });
  it('normal close disconnects and releases only this target lock', async () => {
    port = await connectMegaNovelCdpPort(config, binding);
    await port.close();
    expect(connected).toBe(false);
    expect((await readdir(root)).filter(name => name.endsWith('.lock'))).toEqual([]);
  });
  it('does not start a queued editor mutation after parent cancellation', async () => {
    port = await connectMegaNovelCdpPort(config, binding);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const originalSnapshot = binding.snapshot;
    binding.snapshot = async (...args) => { await gate; return originalSnapshot(...args); };
    const intent = {packageId: 'package-1', chapterNumber: 1, scope: config.scope, aiAssisted: true};
    const first = port.snapshot(intent);
    const controller = new AbortController();
    const pending = port.createDraft({...intent, revisionId: 'revision-1', title: 'Title', content: 'Body'}, {signal: controller.signal});
    controller.abort();
    release();
    await first;
    await expect(pending).rejects.toMatchObject({name: 'AbortError'});
    expect(binding.createDraft).not.toHaveBeenCalled();
  });
  it('releases startup ownership after connect failure without calling browser operations', async () => {
    fixture.connect.mockRejectedValueOnce(new Error('fixture connect failed'));
    await expect(connectMegaNovelCdpPort(config, binding)).rejects.toThrow('fixture connect failed');
    expect(browser.close).not.toHaveBeenCalled();
    port = await connectMegaNovelCdpPort(config, binding);
    expect(binding.probe).toHaveBeenCalledOnce();
  });
  it('keeps failed-start ownership until a still-connected browser actually disconnects', async () => {
    pageURL = 'https://example.com';
    browser.close.mockRejectedValue(new Error('fixture close failed'));
    await expect(connectMegaNovelCdpPort(config, binding)).rejects.toThrow('CDP startup failed');
    await expect(connectMegaNovelCdpPort(config, binding)).rejects.toMatchObject({code: 'MEGANOVEL_BROWSER_BUSY'});
    connected = false;
    events.emit('disconnected');
    connected = true;
    pageURL = 'https://www.meganovel.com/fixture-only';
    browser.close.mockImplementation(async () => { connected = false; events.emit('disconnected'); });
    port = await connectMegaNovelCdpPort(config, binding);
  });
  it('exposes cleanup-only retry for a failed startup without reconnecting or releasing a live owner', async () => {
    pageURL = 'https://example.com';
    browser.close.mockRejectedValueOnce(new Error('fixture startup close failed'));
    const failure = await connectMegaNovelCdpPort(config, binding).catch(error => error) as PublisherStartupCleanupError;
    expect(failure).toBeInstanceOf(PublisherStartupCleanupError);
    expect(connected).toBe(true);
    await expect(connectMegaNovelCdpPort(config, binding)).rejects.toMatchObject({ code: 'MEGANOVEL_BROWSER_BUSY' });
    expect(fixture.connect).toHaveBeenCalledOnce();
    let release!: () => void;
    browser.close.mockImplementationOnce(() => new Promise<void>(resolve => {
      release = () => { connected = false; events.emit('disconnected'); resolve(); };
    }));
    const retry = failure.cleanup.close();
    expect(failure.cleanup.close()).toBe(retry);
    await vi.waitFor(() => expect(browser.close).toHaveBeenCalledTimes(2));
    await expect(connectMegaNovelCdpPort(config, binding)).rejects.toMatchObject({ code: 'MEGANOVEL_BROWSER_BUSY' });
    release(); await retry; await failure.cleanup.close();
    expect(connected).toBe(false);
    expect(browser.close).toHaveBeenCalledTimes(2);
    expect(fixture.connect).toHaveBeenCalledOnce();
    expect(binding.createDraft).not.toHaveBeenCalled(); expect(binding.submit).not.toHaveBeenCalled();
    connected = true;
    pageURL = 'https://www.meganovel.com/fixture-only';
    port = await connectMegaNovelCdpPort(config, binding);
    expect(fixture.connect).toHaveBeenCalledTimes(2);
  });
  it('shares in-flight close and admits no replacement before disconnection completes', async () => {
    port = await connectMegaNovelCdpPort(config, binding);
    let disconnect!: () => void;
    browser.close.mockImplementationOnce(() => new Promise<void>(resolve => {
      disconnect = () => { connected = false; events.emit('disconnected'); resolve(); };
    }));
    const first = port.close();
    const second = port.close();
    expect(second).toBe(first);
    await Promise.resolve();
    await expect(connectMegaNovelCdpPort(config, binding)).rejects.toMatchObject({code: 'MEGANOVEL_BROWSER_BUSY'});
    disconnect();
    await Promise.all([first, second]);
    expect(browser.close).toHaveBeenCalledOnce();
    connected = true;
    port = await connectMegaNovelCdpPort(config, binding);
  });
  it('allows close to retry after an unconfirmed disconnect without admitting a second owner', async () => {
    port = await connectMegaNovelCdpPort(config, binding);
    browser.close.mockRejectedValueOnce(new Error('fixture close failed'));
    await expect(port.close()).rejects.toThrow('fixture close failed');
    await expect(connectMegaNovelCdpPort(config, binding)).rejects.toMatchObject({code: 'MEGANOVEL_BROWSER_BUSY'});
    await port.close();
    connected = true;
    port = await connectMegaNovelCdpPort(config, binding);
  });
  it.each(['cooperative', 'ignores-signal'])('waits for disconnection on active cancellation with a %s binding', async behavior => {
    port = await connectMegaNovelCdpPort({...config, operationTimeoutMs: 10000}, binding);
    let started!: () => void;
    const beginning = new Promise<void>(resolve => { started = resolve; });
    binding.createDraft = vi.fn(async (_page, _input, signal) => {
      started();
      await new Promise<void>((_resolve, reject) => {
        if (behavior === 'cooperative') signal.addEventListener('abort', () => reject(signal.reason), {once: true});
      });
    });
    let disconnect!: () => void;
    browser.close.mockImplementationOnce(() => new Promise<void>(resolve => {
      disconnect = () => { connected = false; events.emit('disconnected'); resolve(); };
    }));
    const controller = new AbortController();
    let settled = false;
    const mutation = port.createDraft({packageId: 'package-1', chapterNumber: 1, scope: config.scope,
      aiAssisted: true, revisionId: 'revision-1', title: 'Title', content: 'Body'}, {signal: controller.signal})
      .finally(() => { settled = true; });
    const rejected = expect(mutation).rejects.toMatchObject({name: 'AbortError'});
    await beginning;
    controller.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    await expect(connectMegaNovelCdpPort(config, binding)).rejects.toMatchObject({code: 'MEGANOVEL_BROWSER_BUSY'});
    disconnect();
    await rejected;
    expect(connected).toBe(false);
    await expect(port.probe(config.scope)).rejects.toMatchObject({code: 'MEGANOVEL_BROWSER_CLOSED'});
    expect(binding.createDraft).toHaveBeenCalledOnce();
  });

});
