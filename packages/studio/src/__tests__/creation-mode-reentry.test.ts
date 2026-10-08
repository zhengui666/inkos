import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';

const f = vi.hoisted(() => ({ instances: [] as any[], publishers: [] as any[], config: {} as any,
  configGate: undefined as any, stopGate: undefined as any, startGate: undefined as any, startError: undefined as any,
  publisherGate: undefined as any, publisherCloseGate: undefined as any }));
vi.mock('@actalk/inkos-core', async importOriginal => {
  const actual = await importOriginal<typeof import('@actalk/inkos-core')>();
  return { ...actual,
    createLLMClient: vi.fn(() => ({})),
    loadProjectConfig: vi.fn(async () => { await f.configGate?.promise; return f.config; }),
    loadSchedulerPublisher: vi.fn(async () => {
      const publisher = { ready: vi.fn(), publish: vi.fn(), close: vi.fn(async () => { await f.publisherCloseGate?.promise; }) };
      f.publishers.push(publisher);
      await f.publisherGate?.promise;
      return publisher;
    }),
    Scheduler: class {
      isRunning = false;
      private stopping?: Promise<void>;
      constructor(readonly config: any) { f.instances.push(this); }
      async start() { await f.startGate?.promise; if (f.startError) throw f.startError; this.isRunning = true; }
      stop() { return this.stopping ??= (async () => { this.isRunning = false; await f.stopGate?.promise; await this.config.publisher?.close?.(); })(); }
    },
  };
});
import { CreationTaskStore, SchedulerStore } from '@actalk/inkos-core';
import { createStudioServer, shutdownStudioServer } from '../api/server.js';

let root: string;
let app: ReturnType<typeof createStudioServer>;
const json = (body: unknown) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'inkos-mode-audit-'));
  f.instances = []; f.publishers = [];
  f.configGate = f.stopGate = f.startGate = f.startError = f.publisherGate = f.publisherCloseGate = undefined;
  f.config = { name: 'fixture', version: '0.1.0', language: 'en', llm: { model: 'fixture', provider: 'openai' }, notify: [],
    daemon: { market: { platform: 'meganovel', language: 'en', liveMegaNovel: false },
      schedule: { writeCron: '*/15 * * * *', radarCron: '0 */6 * * *' }, maxConcurrentBooks: 1, chaptersPerCycle: 1,
      retryDelayMs: 1000, cooldownAfterChapterMs: 0, maxChaptersPerDay: 2 } };
  app = createStudioServer(f.config, root);
});
afterEach(async () => { await shutdownStudioServer(app); await rm(root, { recursive: true, force: true }); });
async function create() {
  const response = await app.request('/api/v1/creation-tasks', json({ id: randomUUID(), kind: 'short', brief: 'An isolated fixture about a clock and a promise.' }));
  expect(response.status).toBe(201);
  expect(f.instances).toHaveLength(1);
  expect(f.instances[0].config.creationTasksOnly).toBe(true);
  return (await response.json()).task;
}
function deferred() {
  let resolve!: () => void;
  return { promise: new Promise<void>(done => { resolve = done; }), resolve: () => resolve() };
}
function blockForPublisher(task: { id: string; workId: string }) {
  const tasks = new CreationTaskStore(join(root, '.inkos/harness.sqlite'));
  const scheduler = new SchedulerStore(join(root, '.inkos/harness.sqlite'));
  try {
    const failure = { code: 'CREATION_PUBLISHER_REQUIRED', message: 'Fixture needs publication setup.' };
    const blocked = tasks.update(task.id, current => ({ ...current, phase: 'blocked', foundation: 'completed', error: failure }));
    const job = scheduler.reserve(task.workId, 1, Date.now(), 10);
    expect(job).toBeDefined();
    scheduler.save({ ...job!, phase: 'publishing', error: failure,
      reviewReceipt: { revisionId: 'fixture', reviewedAt: Date.now(), summary: 'Fixture only', observations: [] } }, 'fixture-setup-blocked');
    return blocked;
  } finally { tasks.close(); scheduler.close(); }
}

describe('creation mode survives rejected general-runner reentry (mock transports)', () => {
  it('keeps the actual creation-only mode after a duplicate general start is rejected', async () => {
    await create();
    const rejected = await app.request('/api/v1/daemon/start', { method: 'POST' });
    expect(rejected.status).toBe(409);
    const board = await (await app.request('/api/v1/creation-tasks')).json();
    expect(board.runtime).toMatchObject({ running: true, creationTasksOnly: true });
  });

  it('can still reload publishing setup for the creation runner after rejected reentry', async () => {
    const task = await create();
    expect((await app.request('/api/v1/daemon/start', { method: 'POST' })).status).toBe(409);
    const tasks = new CreationTaskStore(join(root, '.inkos/harness.sqlite'));
    const scheduler = new SchedulerStore(join(root, '.inkos/harness.sqlite'));
    let blocked;
    try {
      const failure = { code: 'CREATION_PUBLISHER_REQUIRED', message: 'Fixture needs publication setup.' };
      blocked = tasks.update(task.id, current => ({ ...current, phase: 'blocked', foundation: 'completed', error: failure }));
      const job = scheduler.reserve(task.workId, 1, Date.now(), 1)!;
      scheduler.save({ ...job, phase: 'publishing', error: failure, reviewReceipt: { revisionId: 'fixture', reviewedAt: Date.now(), summary: 'Fixture only', observations: [] } }, 'fixture-setup-blocked');
    } finally { tasks.close(); scheduler.close(); }
    f.config.daemon.publisherConfig = 'simulated-publisher.json';
    const response = await app.request(`/api/v1/creation-tasks/${task.id}/resume`, json({ version: blocked!.version }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.runtimeError).toBeUndefined();
    expect(f.instances).toHaveLength(2);
    expect(f.instances[1].config.creationTasksOnly).toBe(true);
  });

  it('captures creation scope before a rejected general start during slow config loading', async () => {
    await create();
    await app.request('/api/v1/daemon/stop', { method: 'POST' });
    let release!: () => void;
    f.configGate = { promise: new Promise<void>(resolve => { release = resolve; }) };
    const starting = app.request('/api/v1/creation-tasks/runner/start', { method: 'POST' });
    try {
      for (let n = 0; n < 15; n++) await new Promise(resolve => setImmediate(resolve));
      const rejected = await app.request('/api/v1/daemon/start', { method: 'POST' });
      expect(rejected.status).toBe(409);
    } finally { release(); }
    expect((await starting).status).toBe(200);
    expect(f.instances).toHaveLength(2);
    expect(f.instances[1].config.creationTasksOnly).toBe(true);
    const board = await (await app.request('/api/v1/creation-tasks')).json();
    expect(board.runtime).toMatchObject({ running: true, creationTasksOnly: true });
  });

  it('preserves the last successful mode when a replacement start fails', async () => {
    await create();
    await app.request('/api/v1/daemon/stop', { method: 'POST' });
    f.startError = new Error('Simulated start failure');
    expect((await app.request('/api/v1/daemon/start', { method: 'POST' })).status).toBe(500);
    const board = await (await app.request('/api/v1/creation-tasks')).json();
    expect(board.runtime).toMatchObject({ running: false, creationTasksOnly: true });
  });

  it('commits general mode after an explicitly requested general start succeeds', async () => {
    await create();
    await app.request('/api/v1/daemon/stop', { method: 'POST' });
    expect((await app.request('/api/v1/daemon/start', { method: 'POST' })).status).toBe(200);
    expect(f.instances[1].config.creationTasksOnly).toBe(false);
    const board = await (await app.request('/api/v1/creation-tasks')).json();
    expect(board.runtime).toMatchObject({ running: true, creationTasksOnly: false });
  });

  it('retains the general request scope across stale-runner drain and a rejected creation start', async () => {
    await create();
    f.instances[0].isRunning = false;
    let release!: () => void;
    f.stopGate = { promise: new Promise<void>(resolve => { release = resolve; }) };
    const restarting = app.request('/api/v1/daemon/start', { method: 'POST' });
    try {
      for (let n = 0; n < 15; n++) await new Promise(resolve => setImmediate(resolve));
      const rejected = await app.request('/api/v1/creation-tasks/runner/start', { method: 'POST' });
      expect((await rejected.json()).runtimeError).toContain('stopping');
    } finally { release(); }
    expect((await restarting).status).toBe(200);
    expect(f.instances).toHaveLength(2);
    expect(f.instances[1].config.creationTasksOnly).toBe(false);
    const board = await (await app.request('/api/v1/creation-tasks')).json();
    expect(board.runtime).toMatchObject({ running: true, creationTasksOnly: false });
  });

  it('coalesces repeated creation starts and returns the shared startup failure', async () => {
    const starting = deferred(); f.startGate = starting;
    let completed = 0;
    const first = Promise.resolve(app.request('/api/v1/creation-tasks/runner/start', { method: 'POST' })).then(response => { completed++; return response; });
    try {
      await vi.waitFor(() => expect(f.instances).toHaveLength(1));
      const second = Promise.resolve(app.request('/api/v1/creation-tasks/runner/start', { method: 'POST' })).then(response => { completed++; return response; });
      await new Promise(resolve => setImmediate(resolve));
      expect(completed).toBe(0);
      f.startError = new Error('Shared simulated startup failure');
      starting.resolve();
      for (const response of await Promise.all([first, second])) {
        expect((await response.json()).runtimeError).toContain('Shared simulated startup failure');
      }
      expect(f.instances).toHaveLength(1);
    } finally { starting.resolve(); }
  });

  it('waits for publisher loading and cleanup when stopped before scheduler construction', async () => {
    const loading = deferred(), closing = deferred();
    f.config.daemon.publisherConfig = 'simulated-publisher.json';
    f.publisherGate = loading; f.publisherCloseGate = closing;
    const starting = app.request('/api/v1/creation-tasks/runner/start', { method: 'POST' });
    try {
      await vi.waitFor(() => expect(f.publishers).toHaveLength(1));
      let stopped = false;
      const stopping = Promise.resolve(app.request('/api/v1/daemon/stop', { method: 'POST' })).then(response => { stopped = true; return response; });
      await vi.waitFor(async () => expect((await (await app.request('/api/v1/daemon')).json()).phase).toBe('stopping'));
      loading.resolve();
      await vi.waitFor(() => expect(f.publishers[0].close).toHaveBeenCalledOnce());
      expect(stopped).toBe(false);
      expect(f.instances).toHaveLength(0);
      expect((await app.request('/api/v1/daemon/start', { method: 'POST' })).status).toBe(409);
      closing.resolve();
      expect((await (await starting).json()).runtimeError).toContain('cancelled');
      expect((await stopping).status).toBe(200);
      expect(f.instances).toHaveLength(0);
      expect(f.publishers[0].close).toHaveBeenCalledOnce();
    } finally { loading.resolve(); closing.resolve(); }
  });

  it('shares one publisher refresh and replacement runtime across concurrent task resumes', async () => {
    const firstTask = blockForPublisher(await create()), secondTask = blockForPublisher(await create());
    const draining = deferred(), starting = deferred();
    f.stopGate = draining; f.startGate = starting;
    f.config.daemon.publisherConfig = 'simulated-publisher.json';
    let completed = 0;
    const resume = (task: typeof firstTask) => Promise.resolve(app.request(`/api/v1/creation-tasks/${task.id}/resume`, json({ version: task.version })))
      .then(response => { completed++; return response; });
    const first = resume(firstTask);
    try {
      await vi.waitFor(() => expect(f.instances[0].isRunning).toBe(false));
      const second = resume(secondTask);
      await new Promise(resolve => setImmediate(resolve));
      expect(completed).toBe(0);
      draining.resolve();
      await vi.waitFor(() => expect(f.instances).toHaveLength(2));
      expect(completed).toBe(0);
      starting.resolve();
      for (const response of await Promise.all([first, second])) {
        expect(response.status).toBe(200);
        expect((await response.json()).runtimeError).toBeUndefined();
      }
      expect(f.publishers).toHaveLength(1);
      expect((await app.request('/api/v1/creation-tasks/runner/start', { method: 'POST' })).status).toBe(200);
      expect(f.instances).toHaveLength(2);
    } finally { draining.resolve(); starting.resolve(); }
  });

  it('lets an explicit stop cancel a creation refresh waiting on the previous runtime', async () => {
    const task = blockForPublisher(await create()), draining = deferred();
    f.stopGate = draining;
    f.config.daemon.publisherConfig = 'simulated-publisher.json';
    const resuming = app.request(`/api/v1/creation-tasks/${task.id}/resume`, json({ version: task.version }));
    try {
      await vi.waitFor(() => expect(f.instances[0].isRunning).toBe(false));
      const stopping = app.request('/api/v1/daemon/stop', { method: 'POST' });
      await vi.waitFor(async () => {
        const board = await (await app.request('/api/v1/creation-tasks')).json();
        expect(board.tasks[0].desiredState).toBe('paused');
      });
      draining.resolve();
      expect((await (await resuming).json()).runtimeError).toContain('cancelled');
      expect((await stopping).status).toBe(200);
      expect(f.instances).toHaveLength(1);
      expect(f.publishers).toHaveLength(0);
      const board = await (await app.request('/api/v1/creation-tasks')).json();
      expect(board.runtime).toMatchObject({ running: false, phase: 'stopped', creationTasksOnly: true });
      expect(board.tasks[0].desiredState).toBe('paused');
    } finally { draining.resolve(); }
  });

  it('reports a competing general startup instead of claiming creation startup succeeded', async () => {
    const starting = deferred(); f.startGate = starting;
    const general = app.request('/api/v1/daemon/start', { method: 'POST' });
    try {
      await vi.waitFor(() => expect(f.instances).toHaveLength(1));
      const creation = await app.request('/api/v1/creation-tasks/runner/start', { method: 'POST' });
      expect((await creation.json()).runtimeError).toContain('starting');
      starting.resolve();
      expect((await general).status).toBe(200);
      expect(f.instances).toHaveLength(1);
      expect(f.instances[0].config.creationTasksOnly).toBe(false);
    } finally { starting.resolve(); }
  });
});
