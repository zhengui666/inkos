import { describe, expect, it, vi } from 'vitest';
import { createPublisherCleanup, PublisherStartupCleanupError } from '../publishing/publisher-cleanup.js';

describe('retained publisher cleanup, offline', () => {
  it('retries only unfinished closers, deduplicating handles and retaining successful store closure', async () => {
    const failure = new Error('fixture close failed');
    const pending = { close: vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(undefined) };
    const done = { close: vi.fn(async () => {}) }, store = { close: vi.fn(() => {}) };
    const cleanup = createPublisherCleanup(() => [[pending, done, pending], [done, store]]);
    const first = cleanup.close();
    expect(cleanup.close()).toBe(first);
    await expect(first).rejects.toMatchObject({ errors: [failure] });
    expect(cleanup.requested).toBe(true);
    const retry = cleanup.close();
    expect(cleanup.close()).toBe(retry);
    await retry; await cleanup.close();
    expect(pending.close).toHaveBeenCalledTimes(2);
    expect(done.close).toHaveBeenCalledOnce();
    expect(store.close).toHaveBeenCalledOnce();
  });

  it('awaits in-flight resources before taking the close snapshot and keeps all failures visible', async () => {
    let release!: () => void;
    const drain = new Promise<void>(resolve => { release = resolve; });
    const first = new Error('sync close failed'), second = new Error('async close failed');
    const resources: Array<{ close(): void | Promise<void> }> = [];
    const cleanup = createPublisherCleanup(() => [resources], () => drain);
    const closing = cleanup.close(), rejected = expect(closing).rejects.toMatchObject({ errors: [first, second] });
    resources.push({ close() { throw first; } }, { async close() { throw second; } });
    release(); await rejected;
  });

  it('retains original startup and cleanup errors with cleanup-only retry authority', async () => {
    const startup = new Error('factory failed'), close = new Error('close failed');
    const cleanup = createPublisherCleanup(() => [[]]);
    const failure = new PublisherStartupCleanupError(startup, close, cleanup);
    expect(failure).toMatchObject({ code: 'PUBLISHING_STARTUP_CLEANUP_FAILED', errors: [startup, close], cleanup });
    await failure.cleanup.close();
    expect(failure.errors).toEqual([startup, close]);
  });
});
