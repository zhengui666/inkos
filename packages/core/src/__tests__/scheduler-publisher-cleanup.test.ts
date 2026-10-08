import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMegaNovelSchedulerPublisher, createMegaNovelSchedulerPublisherFromConfiguration } from '../publishing/scheduler-publisher.js';
import { createPublisherCleanup, PublisherStartupCleanupError } from '../publishing/publisher-cleanup.js';
import { PublishingStore } from '../publishing/store.js';
import type { MegaNovelBrowserPort } from '../publishing/meganovel-contracts.js';

const fixture = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock('../publishing/meganovel-cdp.js', () => ({ connectMegaNovelCdpPort: fixture.connect }));
let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'inkos-loader-cleanup-')); fixture.connect.mockReset(); });
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
const browser = (): MegaNovelBrowserPort & { close: ReturnType<typeof vi.fn> } => ({
  probe: vi.fn(), snapshot: vi.fn(), createDraft: vi.fn(), submit: vi.fn(), close: vi.fn(async () => {}),
});
const configuration = (id: string) => ({ workId: `work-${id}`, targetId: `target-${id}`, firstNewChapter: 1, aiAssisted: true,
  scope: { sessionId: `tab-${id}`, accountId: 'fixture-account', accountLabel: 'fixture-author', remoteBookId: `book-${id}` },
  endpointURL: 'http://127.0.0.1:9222', lockDirectory: join(root, 'locks'),
  authorization: { automation: { provenance: 'user_reported', reference: 'Offline fixture only' },
    aiAssistedContent: { provenance: 'user_reported', reference: 'Offline fixture only' } },
});

describe('MegaNovel loader cleanup ownership with synthetic transports', () => {
  it('retains partial startup transports and retries only failed closes after a later connector fails', async () => {
    const a = browser(), b = browser(), startupError = new Error('connector startup failed');
    a.close.mockRejectedValueOnce(new Error('first transport close failed'));
    fixture.connect.mockResolvedValueOnce(a).mockResolvedValueOnce(b).mockRejectedValueOnce(startupError);
    const failure = await createMegaNovelSchedulerPublisherFromConfiguration(root, ['a', 'b', 'c'].map(configuration))
      .catch(error => error) as PublisherStartupCleanupError;
    expect(failure).toBeInstanceOf(PublisherStartupCleanupError);
    expect(failure.errors[0]).toBe(startupError);
    expect(a.close).toHaveBeenCalledOnce(); expect(b.close).toHaveBeenCalledOnce();
    const retry = failure.cleanup.close();
    expect(failure.cleanup.close()).toBe(retry);
    await retry; await failure.cleanup.close();
    expect(a.close).toHaveBeenCalledTimes(2); expect(b.close).toHaveBeenCalledOnce();
    expect(fixture.connect).toHaveBeenCalledTimes(3);
    expect(a.createDraft).not.toHaveBeenCalled(); expect(b.submit).not.toHaveBeenCalled();
  });

  it('retains nested connector cleanup together with an earlier failed transport close', async () => {
    const a = browser(), nested = browser();
    a.close.mockRejectedValueOnce(new Error('earlier close failed'));
    nested.close.mockRejectedValueOnce(new Error('connector close failed'));
    const nestedCleanup = createPublisherCleanup(() => [[nested]]);
    const nestedCloseError = await nestedCleanup.close().catch(error => error);
    const nestedFailure = new PublisherStartupCleanupError(new Error('connector failed'), nestedCloseError, nestedCleanup);
    fixture.connect.mockResolvedValueOnce(a).mockRejectedValueOnce(nestedFailure);
    const failure = await createMegaNovelSchedulerPublisherFromConfiguration(root, ['a', 'b'].map(configuration))
      .catch(error => error) as PublisherStartupCleanupError;
    expect(failure).toBeInstanceOf(PublisherStartupCleanupError);
    expect(failure.errors[0]).toBe(nestedFailure);
    expect(a.close).toHaveBeenCalledOnce(); expect(nested.close).toHaveBeenCalledOnce();
    await failure.cleanup.close();
    expect(a.close).toHaveBeenCalledTimes(2); expect(nested.close).toHaveBeenCalledTimes(2);
    expect(fixture.connect).toHaveBeenCalledTimes(2);
  });

  it('does not close successful browsers or its SQLite store again when publisher close is retried', async () => {
    const a = browser(), b = browser(); a.close.mockRejectedValueOnce(new Error('fixture close failed'));
    const closeStore = vi.spyOn(PublishingStore.prototype, 'close');
    const publisher = createMegaNovelSchedulerPublisher(root, [a, b].map((transport, index) => ({
      ...configuration(String(index)), browser: transport,
    })));
    await expect(publisher.close()).rejects.toThrow('Publisher cleanup failed');
    expect(closeStore).toHaveBeenCalledOnce();
    await expect(publisher.ready('work-0', new AbortController().signal)).rejects.toMatchObject({ code: 'PUBLISHING_CLOSED' });
    await publisher.close(); await publisher.close();
    expect(a.close).toHaveBeenCalledTimes(2); expect(b.close).toHaveBeenCalledOnce();
    expect(closeStore).toHaveBeenCalledOnce();
  });
});
