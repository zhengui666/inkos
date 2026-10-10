import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import ts from 'typescript';
import { createOwnershipLockSpace, SQLITE_OWNER_TOKEN_PREFIX, type OwnershipLockHandle, type OwnershipLockKind } from '../harness/ownership-lock.js';

const roots: string[] = [];
const handles: OwnershipLockHandle[] = [];
const children: ChildProcess[] = [];
let childModule: string;
beforeAll(async () => {
  const modules = await mkdtemp(join(tmpdir(), 'inkos-lock-child-modules-'));
  childModule = join(modules, 'ownership-lock.js');
  const source = await readFile(new URL('../harness/ownership-lock.ts', import.meta.url), 'utf8');
  await writeFile(childModule, ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText);
  return () => rm(modules, { recursive: true, force: true });
});
async function kill(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
}
async function launch(script: string, ...args: string[]) {
  const child = spawn(process.execPath, ['-e', script, childModule, ...args], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    let stderr = '';
    const timer = setTimeout(() => finish(new Error(`Lock child readiness timed out: ${stderr}`)), 5_000);
    const finish = (error?: Error) => {
      clearTimeout(timer); child.off('message', message); child.off('error', fail); child.off('exit', exit);
      error ? reject(error) : resolve();
    };
    const message = (value: unknown) => { if (value === 'ready') finish(); };
    const fail = (error: Error) => finish(error);
    const exit = (code: number | null) => finish(new Error(`Lock child exited ${code}: ${stderr}`));
    child.stderr!.on('data', data => { stderr += data.toString(); });
    child.on('message', message); child.once('error', fail); child.once('exit', exit);
  });
  return child;
}
async function broadcast(peers: ChildProcess[], message: unknown): Promise<any[]> {
  const replies = peers.map(child => once(child, 'message'));
  peers.forEach(child => child.send(message as object));
  return (await Promise.all(replies)).map(([reply]) => reply);
}
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(children.splice(0).map(kill));
  for (const handle of handles.splice(0)) handle.release();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'inkos-ownership-lock-'));
  roots.push(root);
  const path = join(root, 'project', 'harness.sqlite');
  const space = createOwnershipLockSpace(path);
  return { root, path, space };
}
function retain(handle: OwnershipLockHandle | undefined) {
  expect(handle).toBeDefined();
  handles.push(handle!);
  return handle!;
}

describe('canonical SQLite ownership lock space', () => {
  it('creates the ledger before canonicalizing relative, directory-alias and file-alias paths', async () => {
    const { root, path, space } = await setup();
    expect(space.canonicalDatabasePath).toBe(realpathSync(path));
    await symlink(dirname(path), join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
    const alias = createOwnershipLockSpace(join(root, 'alias', 'harness.sqlite'));
    const relativeSpace = createOwnershipLockSpace(relative(process.cwd(), path));
    expect(alias.key('goal-owner', 'work')).toBe(space.key('goal-owner', 'work'));
    expect(relativeSpace.key('goal-owner', 'work')).toBe(space.key('goal-owner', 'work'));
    retain(space.tryAcquire('goal-owner', 'work'));
    expect(alias.tryAcquire('goal-owner', 'work')).toBeUndefined();
    if (process.platform !== 'win32') {
      await symlink(path, join(root, 'ledger-alias.sqlite'));
      expect(createOwnershipLockSpace(join(root, 'ledger-alias.sqlite')).key('goal-owner', 'work')).toBe(space.key('goal-owner', 'work'));
    }
  });

  it('creates only the ledger path without initializing or truncating its contents', async () => {
    const { path } = await setup();
    expect((await stat(path)).size).toBe(0);
    expect(existsSync(`${path}-wal`)).toBe(false);
    const preserved = Buffer.from('fixture bytes must remain untouched');
    await writeFile(path, preserved);
    expect(() => createOwnershipLockSpace(path)).not.toThrow();
    expect(await readFile(path)).toEqual(preserved);
  });

  it.each(['delete', 'wal'])('does not touch an existing %s ledger journal/schema while its writer holds a transaction', async mode => {
    const { path } = await setup();
    const ledger = new DatabaseSync(path);
    try {
      ledger.exec(`PRAGMA journal_mode=${mode}; CREATE TABLE fixture(value TEXT); INSERT INTO fixture VALUES ('retained'); BEGIN EXCLUSIVE`);
      expect(createOwnershipLockSpace(path).canonicalDatabasePath).toBe(realpathSync(path));
      expect(ledger.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe(mode);
      expect(ledger.prepare('SELECT value FROM fixture').get()?.value).toBe('retained');
      expect(ledger.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([{ name: 'fixture' }]);
      ledger.exec('ROLLBACK');
    } finally { ledger.close(); }
  });

  it('constructs spaces concurrently through aliases without opening the ledger in SQLite', async () => {
    const { root, path } = await setup();
    await symlink(dirname(path), join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
    const paths = [path, join(root, 'alias', 'harness.sqlite')];
    const peers = await Promise.all(Array.from({ length: 4 }, (_, index) => launch(`
      const { createOwnershipLockSpace } = require(process.argv[1]);
      process.on('message', () => {
        const errors = []; let successful = 0;
        for (let index = 0; index < 100; index++) {
          try { createOwnershipLockSpace(process.argv[2]); successful++; }
          catch (error) { errors.push({ message: error.message, errcode: error.errcode }); }
        }
        process.send({ successful, errors });
      });
      process.send('ready');
    `, paths[index % paths.length]!)));
    const results = await broadcast(peers, 'construct');
    expect(results).toEqual(Array.from({ length: 4 }, () => ({ successful: 100, errors: [] })));
    expect((await stat(path)).size).toBe(0);
  });

  it.each(['goal-owner', 'studio-task-owner', 'studio-task-state', 'studio-chat-owner', 'studio-chat-state'] as const)(
    'admits a %s writer despite a transient sidecar reader, with exactly one writer', async kind => {
      const { space } = await setup();
      const key = space.key(kind, 'resource');
      await mkdir(dirname(key), { recursive: true });
      const reader = new DatabaseSync(key);
      try {
        reader.exec('CREATE TABLE fixture(value INTEGER); INSERT INTO fixture VALUES (1); BEGIN');
        expect(reader.prepare('SELECT value FROM fixture').get()?.value).toBe(1);
        const handle = retain(space.tryAcquire(kind, 'resource'));
        expect(space.tryAcquire(kind, 'resource')).toBeUndefined();
        expect(reader.prepare('SELECT value FROM fixture').get()?.value).toBe(1);
        handle.release();
        retain(space.tryAcquire(kind, 'resource'));
        reader.exec('ROLLBACK');
      } finally { reader.close(); }
    });

  it.each([false, true])('admits exactly one of four real processes in 200 fresh-resource rounds with preinitialized=%s', async preinitialized => {
    const { path, space } = await setup();
    const peers: ChildProcess[] = [];
    // Sequential space creation isolates lock admission from the constructor test.
    for (let index = 0; index < 4; index++) peers.push(await launch(`
      const { createOwnershipLockSpace } = require(process.argv[1]);
      const locks = createOwnershipLockSpace(process.argv[2]); let handle;
      process.on('message', message => {
        if (message.action === 'claim') {
          try { handle = locks.tryAcquire(message.kind, message.id); process.send({ acquired: Boolean(handle) }); }
          catch (error) { process.send({ error: error.message, errcode: error.errcode }); }
        } else { handle?.release(); handle = undefined; process.send({ released: true }); }
      });
      process.send('ready');
    `, path));
    const kinds = ['goal-owner', 'studio-task-owner', 'studio-task-state', 'studio-chat-owner', 'studio-chat-state'] as const;
    for (let round = 0; round < 200; round++) {
      const id = `fresh-${round}`, kind = kinds[round % kinds.length]!;
      if (preinitialized) {
        const key = space.key(kind, id);
        await mkdir(dirname(key), { recursive: true });
        const db = new DatabaseSync(key);
        try { db.exec('CREATE TABLE fixture(value INTEGER)'); } finally { db.close(); }
      }
      const results = await broadcast(peers, { action: 'claim', kind, id });
      expect(results.filter(result => result.error), `round ${round}: ${JSON.stringify(results)}`).toEqual([]);
      expect(results.filter(result => result.acquired), `round ${round}: ${JSON.stringify(results)}`).toHaveLength(1);
      // All handles stay held until every child has reported; no retries or
      // release/reacquire can turn a zero-winner round into an apparent success.
      expect(await broadcast(peers, { action: 'release' })).toEqual(peers.map(() => ({ released: true })));
    }
  }, 60_000);

  it('maps all UTF-16 code units to fixed-length lowercase resource names without ID length limits', async () => {
    const { space } = await setup();
    const ids = ['A', 'a', '/', '../outside', '\\', '\0', '\ud800', '\ud801', '\ufffd', '书籍😀', 'Ab'.repeat(180), '长'.repeat(120), 'x'.repeat(10_000)];
    const keys = ids.map(id => space.key('studio-task-owner', id));
    expect(new Set(keys.map(key => key.toLowerCase())).size).toBe(ids.length);
    ids.forEach((id, index) => {
      const segments = relative(`${space.canonicalDatabasePath}.owner-locks`, keys[index]!).split(sep);
      expect(segments.shift()).toBe('studio-task-owner');
      expect(segments.pop()).toBe('lock.sqlite');
      expect(segments).toHaveLength(1);
      expect(segments[0]).toMatch(/^[0-9a-f]{64}$/);
      expect(keys[index]).toHaveLength(keys[0]!.length);
      retain(space.tryAcquire('studio-task-owner', id));
    });
    expect(space.key('studio-task-owner', 'work')).not.toBe(space.key('goal-owner', 'work'));
    retain(space.tryAcquire('goal-owner', 'x'.repeat(10_000)));
  });

  it('rejects missing resources and unknown kinds without inventing a global resource lock', async () => {
    const { space } = await setup();
    for (const kind of ['goal-owner', 'studio-task-owner', 'studio-task-state', 'studio-chat-owner', 'studio-chat-state'] as const) {
      expect(() => space.key(kind)).toThrow();
      expect(() => space.key(kind, '')).toThrow();
    }
    expect(() => space.key('../outside' as OwnershipLockKind, 'work')).toThrow();
  });

  it('preserves the exact daemon path, prefix and legacy SQLite lock interoperability', async () => {
    const { path, space } = await setup();
    expect(SQLITE_OWNER_TOKEN_PREFIX).toBe('sqlite-lock-v1:');
    expect(space.key('daemon')).toBe(`${realpathSync(path)}.daemon-lock`);
    const old = new DatabaseSync(`${realpathSync(path)}.daemon-lock`);
    try {
      old.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
      expect(space.tryAcquire('daemon')).toBeUndefined();
      old.exec('ROLLBACK');
      const current = retain(space.tryAcquire('daemon'));
      expect(() => old.exec('BEGIN EXCLUSIVE')).toThrow();
      current.release(); current.release();
      old.exec('BEGIN EXCLUSIVE; ROLLBACK');
      expect(old.prepare('PRAGMA journal_mode').get()?.journal_mode).not.toBe('wal');
      expect(existsSync(current.key)).toBe(true);
    } finally { old.close(); }
  });

  it('does not block other resources, lock kinds, or shared ledger writes', async () => {
    const { path, space } = await setup();
    retain(space.tryAcquire('goal-owner', 'work'));
    expect(space.tryAcquire('goal-owner', 'work')).toBeUndefined();
    retain(space.tryAcquire('goal-owner', 'other'));
    retain(space.tryAcquire('studio-task-owner', 'work'));
    retain(space.tryAcquire('studio-task-state', 'work'));
    const db = new DatabaseSync(path);
    try { expect(() => db.exec('CREATE TABLE fixture(value TEXT); INSERT INTO fixture VALUES (\'written\')')).not.toThrow(); }
    finally { db.close(); }
  });

  it('propagates non-busy filesystem/SQLite failures instead of reporting contention', async () => {
    const { space } = await setup();
    await mkdir(space.key('goal-owner', 'blocked'), { recursive: true });
    expect(() => space.tryAcquire('goal-owner', 'blocked')).toThrow();
  });

  it('keeps each in-memory database isolated and never creates sidecars', () => {
    const left = createOwnershipLockSpace(':memory:'), right = createOwnershipLockSpace(':memory:');
    expect(left.canonicalDatabasePath).toBe(':memory:');
    expect(left.key('goal-owner', 'work')).not.toBe(right.key('goal-owner', 'work'));
    const first = retain(left.tryAcquire('goal-owner', 'work'));
    expect(left.tryAcquire('goal-owner', 'work')).toBeUndefined();
    retain(right.tryAcquire('goal-owner', 'work'));
    retain(left.tryAcquire('daemon'));
    expect(existsSync(first.key)).toBe(false);
    first.release(); first.release();
    retain(left.tryAcquire('goal-owner', 'work'));
  });

  it('waits asynchronously so the same-process holder can finish awaited I/O', async () => {
    const { path, space } = await setup();
    const other = createOwnershipLockSpace(path);
    const order: string[] = [];
    const first = space.withStateLock('studio-task-state', 'work', async () => {
      order.push('first-start');
      await new Promise<void>(resolve => setTimeout(resolve, 30));
      order.push('first-end');
    });
    const second = other.withStateLock('studio-task-state', 'work', async () => { order.push('second'); return 42; });
    await first;
    expect(await second).toBe(42);
    expect(order).toEqual(['first-start', 'first-end', 'second']);
  });

  it('releases a state lock when its operation rejects', async () => {
    const { space } = await setup();
    const failure = new Error('fixture-write-failure');
    await expect(space.withStateLock('studio-chat-state', 'session', async () => { throw failure; })).rejects.toBe(failure);
    retain(space.tryAcquire('studio-chat-state', 'session'));
  });

  it('bounds a contended state wait and preserves the live owner lock', async () => {
    const space = createOwnershipLockSpace(':memory:');
    retain(space.tryAcquire('studio-chat-state', 'session'));
    vi.useFakeTimers();
    const operation = vi.fn(async () => undefined);
    const waiting = expect(space.withStateLock('studio-chat-state', 'session', operation))
      .rejects.toMatchObject({ code: 'OWNERSHIP_LOCK_BUSY' });
    await vi.advanceTimersByTimeAsync(5_010);
    await waiting;
    expect(operation).not.toHaveBeenCalled();
    expect(space.tryAcquire('studio-chat-state', 'session')).toBeUndefined();
  });
});
