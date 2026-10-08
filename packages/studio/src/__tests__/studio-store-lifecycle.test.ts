import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { Server } from 'node:http';

const f = vi.hoisted(() => ({
  connections: [] as Array<{ closes: number; close(): void }>,
  servers: [] as Server[],
}));
vi.mock('node:sqlite', async importOriginal => {
  const actual = await importOriginal<typeof import('node:sqlite')>();
  return { ...actual, DatabaseSync: class extends actual.DatabaseSync {
    constructor(...args: ConstructorParameters<typeof actual.DatabaseSync>) {
      super(...args);
      const original = this.close.bind(this);
      const entry = { closes: 0, close: () => this.close() };
      const db: import('node:sqlite').DatabaseSync = this;
      vi.spyOn(db, 'close').mockImplementation(() => { original(); entry.closes++; });
      f.connections.push(entry);
    }
  } };
});
vi.mock('@hono/node-server', async importOriginal => {
  const actual = await importOriginal<typeof import('@hono/node-server')>();
  return { ...actual, serve: (...args: Parameters<typeof actual.serve>) => {
    const server = actual.serve(...args);
    f.servers.push(server as Server);
    return server;
  } };
});
import { SchedulerStore, type ProjectConfig } from '@actalk/inkos-core';
import { createStudioServer, shutdownStudioServer, startStudioServer } from '../api/server.js';

let root: string;
const apps: ReturnType<typeof createStudioServer>[] = [];
const closers: Array<() => Promise<void>> = [];
const config = { name: 'offline lifecycle fixture', version: '0.1.0', language: 'en' } as ProjectConfig;
function app() { const value = createStudioServer(config, root); apps.push(value); return value; }
function expectClosed() { expect(f.connections.every(entry => entry.closes === 1)).toBe(true); }
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'inkos-studio-lifetime-'));
  await writeFile(join(root, 'inkos.json'), JSON.stringify(config));
  f.connections = []; f.servers = [];
});
afterEach(async () => {
  await Promise.all(closers.splice(0).map(close => close()));
  await Promise.all(apps.splice(0).map(server => shutdownStudioServer(server)));
  for (const entry of f.connections) if (!entry.closes) entry.close();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe('Studio app and transport database lifetime', () => {
  it('leaves no open SQLite handles after legacy app requests without requiring shutdown', async () => {
    const server = app();
    expectClosed();
    expect((await server.request('/api/v1/sessions')).status).toBe(200);
    await new Promise(resolve => setImmediate(resolve));
    expectClosed();
    // This is the real Windows deletion boundary that Unix unlink used to hide.
    await rm(root, { recursive: true });
  });

  it('closes only its own temporary connections and never releases an external daemon owner', async () => {
    const owner = new SchedulerStore(join(root, '.inkos', 'harness.sqlite'));
    owner.acquire();
    const ownedConnections = [...f.connections];
    try {
      const original = owner.runningOwner();
      const server = app();
      expect((await server.request('/api/v1/creation-tasks')).status).toBe(200);
      await shutdownStudioServer(server);
      expect(ownedConnections.every(entry => entry.closes === 0)).toBe(true);
      expect(f.connections.slice(ownedConnections.length).every(entry => entry.closes === 1)).toBe(true);
      expect(owner.runningOwner()).toEqual(original);
      const contender = new SchedulerStore(join(root, '.inkos', 'harness.sqlite'));
      try { expect(() => contender.acquire()).toThrow(/already owns/); }
      finally { contender.close(); }
    } finally { owner.close(); }
    expectClosed();
  });

  it('makes repeated shutdown safe, drains SSE and rejects late creation reads without reopening SQLite', async () => {
    const server = app();
    const response = await server.request('/api/v1/events');
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: ping');
    const drained = (async () => { while (!(await reader.read()).done) { /* consume the close */ } })();
    await Promise.all([shutdownStudioServer(server), shutdownStudioServer(server), drained]);
    const count = f.connections.length;
    expect((await server.request('/api/v1/creation-tasks')).status).toBe(503);
    expect((await server.request('/api/v1/events')).status).toBe(503);
    expect(f.connections).toHaveLength(count);
    expectClosed();
  });

  it('runs real HTTP/SSE and releases all SQLite handles through the installed SIGTERM handler', async () => {
    const beforeTerm = process.listeners('SIGTERM'), beforeInt = process.listeners('SIGINT');
    await startStudioServer(root, 0);
    const server = f.servers[0];
    if (!server.listening) await once(server, 'listening');
    const address = server.address();
    expect(address).not.toBeNull();
    if (!address || typeof address === 'string') throw new Error('Expected TCP test listener');
    const base = `http://127.0.0.1:${address.port}`;
    const added = process.listeners('SIGTERM').filter(listener => !beforeTerm.includes(listener));
    expect(added).toHaveLength(1);
    // Invoke the actual signal listener rather than killing the Windows test worker.
    const close = added[0] as () => Promise<void>;
    closers.push(close);
    expect((await fetch(`${base}/api/v1/sessions`)).status).toBe(200);
    const board = await fetch(`${base}/api/v1/creation-tasks`);
    expect(board.status).toBe(200);
    await board.json();
    expectClosed();
    const events = await fetch(`${base}/api/v1/events`);
    const reader = events.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: ping');
    const drained = (async () => { while (!(await reader.read()).done) { /* consume until transport EOF */ } })();
    await Promise.all([close(), close(), drained]);
    expect(server.listening).toBe(false);
    expect(process.listeners('SIGTERM')).toEqual(beforeTerm);
    expect(process.listeners('SIGINT')).toEqual(beforeInt);
    expectClosed();
    const reopened = new SchedulerStore(join(root, '.inkos', 'harness.sqlite'));
    try { expect(reopened.runningOwner()).toBeUndefined(); }
    finally { reopened.close(); }
    await rm(root, { recursive: true });
  });
});
