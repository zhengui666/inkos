import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const connections = vi.hoisted(() => ({
  entries: [] as Array<{ closes: number; close(): void }>,
  failAfter: undefined as number | undefined,
}));
vi.mock('node:sqlite', async importOriginal => {
  const actual = await importOriginal<typeof import('node:sqlite')>();
  return { ...actual, DatabaseSync: class extends actual.DatabaseSync {
    constructor(...args: ConstructorParameters<typeof actual.DatabaseSync>) {
    if (connections.failAfter === connections.entries.length) throw new Error('Synthetic open failure');
      super(...args);
      const original = this.close.bind(this);
      const entry = { closes: 0, close: () => this.close() };
      const db: import('node:sqlite').DatabaseSync = this;
      vi.spyOn(db, 'close').mockImplementation(() => { original(); entry.closes++; });
      connections.entries.push(entry);
    }
  } };
});
import { CreationTaskStore, type ProjectConfig } from '@actalk/inkos-core';
import { registerCreationTaskRoutes } from './creation-tasks.js';

let root: string;
let handle: ReturnType<typeof registerCreationTaskRoutes> | undefined;
const config = { language: 'en', daemon: { market: { platform: 'meganovel', language: 'en' } } } as ProjectConfig;
const json = (body: unknown) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
function gate() { let resolve!: () => void; const promise = new Promise<void>(r => resolve = r); return { promise, resolve }; }
function expectClosed() { expect(connections.entries.every(entry => entry.closes === 1)).toBe(true); }
function setup(loadConfig = async () => config, start = vi.fn(async () => {})) {
  const app = new Hono();
  handle = registerCreationTaskRoutes(app, { root, loadConfig, start, status: () => ({ running: false }) });
  return { app, start, handle };
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'inkos-creation-lifetime-'));
  connections.entries = []; connections.failAfter = undefined;
});
afterEach(async () => {
  handle?.close(); handle = undefined;
  // Explicitly release a failed baseline's handles so cleanup does not mask the assertion.
  for (const entry of connections.entries) if (!entry.closes) entry.close();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});
describe('creation route database ownership', () => {
  it('does not retain SQLite connections while an embedded application is idle', async () => {
    const f = setup();
    expectClosed();
    expect(connections.entries).toHaveLength(0);
    expect((await f.app.request('/api/v1/creation-tasks')).status).toBe(200);
    expectClosed();
  });

  it('persists intake and errors while closing every request-owned handle exactly once', async () => {
    const start = vi.fn(async () => { throw new Error('Synthetic offline startup failure'); });
    const f = setup(undefined, start);
    const response = await f.app.request('/api/v1/creation-tasks', json({ id: randomUUID(), kind: 'short', brief: 'A clockmaker repairs a forgotten promise.' }));
    expect(response.status).toBe(201);
    const { task, runtimeError } = await response.json();
    expect(runtimeError).toContain('offline startup failure');
    expectClosed();
    const paused = await f.app.request(`/api/v1/creation-tasks/${task.id}/pause`, json({ version: task.version }));
    expect(paused.status).toBe(200);
    expect((await f.app.request(`/api/v1/creation-tasks/${task.id}/pause`, json({ version: task.version }))).status).toBe(409);
    expect((await f.app.request('/api/v1/creation-tasks', json({ kind: 'invalid' }))).status).toBe(400);
    expectClosed();
    f.handle.close(); f.handle.close();
    const reopened = new CreationTaskStore(join(root, '.inkos', 'harness.sqlite'));
    try { expect(reopened.get(task.id).desiredState).toBe('paused'); }
    finally { reopened.close(); }
    expectClosed();
    // Real removal, without retry/ignore, also exercises Windows file-lock release in CI.
    await rm(root, { recursive: true });
  });

  it('holds no database across config waits and rejects a late request after close', async () => {
    const waiting = gate(), entered = gate();
    const f = setup(async () => { entered.resolve(); await waiting.promise; return config; });
    const request = f.app.request('/api/v1/creation-tasks');
    await entered.promise;
    try { expectClosed(); f.handle.close(); }
    finally { waiting.resolve(); }
    expect((await request).status).toBe(503);
    expectClosed();
  });

  it('releases intake stores before waiting for runtime startup and never reopens after close', async () => {
    const waiting = gate(), entered = gate();
    const f = setup(undefined, vi.fn(async () => { entered.resolve(); await waiting.promise; }));
    const request = f.app.request('/api/v1/creation-tasks', json({ id: randomUUID(), kind: 'short', brief: 'An offline fixture about an apprentice and an old map.' }));
    await entered.promise;
    try { expectClosed(); f.handle.close(); }
    finally { waiting.resolve(); }
    const count = connections.entries.length;
    expect((await request).status).toBe(503);
    expect(connections.entries).toHaveLength(count);
    expectClosed();
  });

  it('releases acquired handles if opening a later store fails', async () => {
    const f = setup();
    connections.failAfter = connections.entries.length + 1;
    const response = await f.app.request('/api/v1/creation-tasks');
    expect(response.status).toBeGreaterThanOrEqual(400);
    expectClosed();
  });
});
