import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
vi.mock('../pipeline/runner.js', () => ({ PipelineRunner: class {} }));
import { Scheduler } from '../pipeline/scheduler.js';
import { SchedulerStore } from '../pipeline/scheduler-store.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('scheduler publisher cleanup ownership, offline', () => {
  it('retains the failed cleanup promise and owner rather than admitting another daemon', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inkos-cleanup-')); roots.push(root);
    const close = vi.fn().mockRejectedValue(new Error('fixture transport close failed'));
    const config = { projectRoot: root, client: {} as any, model: 'fixture', radarCron: '0 */6 * * *', writeCron: '*/15 * * * *',
      maxConcurrentBooks: 1, chaptersPerCycle: 1, retryDelayMs: 1000, cooldownAfterChapterMs: 0, maxChaptersPerDay: 10,
      creationTasksOnly: true, publisher: { ready: vi.fn(), publish: vi.fn(), close } };
    const scheduler = new Scheduler(config), ledger = new SchedulerStore(join(root, '.inkos/harness.sqlite'));
    await scheduler.start();
    const stopping = scheduler.stop();
    await expect(stopping).rejects.toThrow('fixture transport close failed');
    expect(scheduler.stop()).toBe(stopping);
    expect(close).toHaveBeenCalledOnce();
    expect(ledger.runningOwner()).toBeDefined();
    const replacement = new Scheduler({ ...config, publisher: undefined });
    await expect(replacement.start()).rejects.toThrow();
    await replacement.stop();
    expect(ledger.runningOwner()).toBeDefined();
    // Test teardown only: release the intentionally retained failure owner without retrying transport.
    (scheduler as any).creation.close(); (scheduler as any).store.close(); ledger.close();
  });
});
