import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

const hooks = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('node:sqlite', () => ({ DatabaseSync: vi.fn(function (path: string) { return hooks.open(path); }) }));
import { BOOK_LOCK_GUARD_FILE, withBookLockGuard } from '../book-lock-guard.js';

const roots: string[] = [], children: ChildProcess[] = [];
beforeEach(() => { hooks.open.mockReset(); });
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(children.splice(0).map(async child => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  }));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
const sqliteError = (errcode = 5) => Object.assign(new Error('injected SQLite error'), { code: 'ERR_SQLITE_ERROR', errcode });
function clock() {
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const wait = vi.spyOn(Atomics, 'wait').mockImplementation((_array, _index, _value, timeout) => { now += timeout ?? 0; return 'timed-out'; });
  return { wait, advance(value: number) { now += value; }, get now() { return now; } };
}
function connection(exec: (sql: string) => void = () => {}) { return { exec: vi.fn(exec), close: vi.fn() }; }

function worker(root: string, value: string) {
  const sourceRoot = new URL('../../', import.meta.url).href;
  const child = spawn(process.execPath, ['--experimental-transform-types', '--input-type=module', '-e', `
    import {registerHooks} from 'node:module';
    import {statSync} from 'node:fs';
    import {join} from 'node:path';
    const sourceRoot=${JSON.stringify(sourceRoot)};
    registerHooks({resolve(specifier,context,next){return next(context.parentURL?.startsWith(sourceRoot)&&specifier.startsWith('.')&&specifier.endsWith('.js')?specifier.slice(0,-3)+'.ts':specifier,context);}});
    const {updateAgentSettings}=await import(sourceRoot+'runtime/settings.ts');
    process.send({type:'ready'});await new Promise(resolve=>process.once('message',resolve));
    const root=${JSON.stringify(root)};
    let result;
    try { const saved=await updateAgentSettings(root,{modelConnectionRef:${JSON.stringify(value)}},{expectedRevision:0});result={status:'saved',revision:saved.revision}; }
    catch(error){result={status:'error',code:error.code,message:error.message};}
    process.send({type:'result',...result,inode:statSync(join(root,'.inkos',${JSON.stringify(BOOK_LOCK_GUARD_FILE)})).ino});
    process.disconnect();
  `], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  children.push(child);
  let readyResolve!: () => void, readyReject!: (error: Error) => void;
  let doneResolve!: (result: { status: string; code?: string; revision?: number; inode: number }) => void, doneReject!: (error: Error) => void;
  let stderr = '', completed = false;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const done = new Promise<{ status: string; code?: string; revision?: number; inode: number }>((resolve, reject) => { doneResolve = resolve; doneReject = reject; });
  void done.catch(() => undefined);
  child.stderr!.on('data', chunk => { stderr += chunk; });
  child.on('message', message => {
    const result = message as { type: string; status: string; code?: string; revision?: number; inode: number };
    if (result.type === 'ready') readyResolve();
    if (result.type === 'result') { completed = true; doneResolve(result); }
  });
  child.on('error', error => { readyReject(error); doneReject(error); });
  child.on('exit', code => { if (!completed) { const error = new Error(`Guard worker exited ${code}: ${stderr}`); readyReject(error); doneReject(error); } });
  return { ready, done, start() { child.send('start'); } };
}

describe('guard WAL initialization', () => {
  it('closes each WAL BUSY connection before reopening the same path and enters the action once', () => {
    const timer = clock(), busy = sqliteError(), trace: string[] = [];
    const first = connection(sql => { if (sql === 'PRAGMA journal_mode = WAL') throw busy; });
    const second = connection(sql => { if (sql === 'PRAGMA journal_mode = WAL') throw busy; });
    const third = connection();
    [first, second, third].forEach((db, index) => db.close.mockImplementation(() => { trace.push(`close${index}`); }));
    hooks.open.mockImplementation(() => { const index = hooks.open.mock.calls.length - 1; trace.push(`open${index}`); return [first, second, third][index]; });
    const action = vi.fn(() => 42);
    expect(withBookLockGuard('/fixture/work.lock', action)).toBe(42);
    expect(trace).toEqual(['open0', 'close0', 'open1', 'close1', 'open2', 'close2']);
    expect(hooks.open.mock.calls.map(([path]) => path)).toEqual(Array(3).fill(join('/fixture', BOOK_LOCK_GUARD_FILE)));
    expect(action).toHaveBeenCalledTimes(1); expect(timer.wait).toHaveBeenCalledTimes(2);
    for (const failed of [first, second]) expect(failed.exec.mock.calls.some(([sql]) => ['BEGIN IMMEDIATE', 'COMMIT', 'ROLLBACK'].includes(sql))).toBe(false);
    expect(third.exec.mock.calls.map(([sql]) => sql).filter(sql => ['BEGIN IMMEDIATE', 'COMMIT', 'ROLLBACK'].includes(sql))).toEqual(['BEGIN IMMEDIATE', 'COMMIT']);
  });
  it('uses one monotonic 5000ms budget without resetting SQLite waits on retries', () => {
    const timer = clock(), busy = sqliteError(), databases: ReturnType<typeof connection>[] = [], limits: number[] = [];
    hooks.open.mockImplementation(() => {
      let budget = 0;
      const db = connection(sql => {
        if (sql.startsWith('PRAGMA busy_timeout = ')) { budget = Number(sql.split(' = ')[1]); limits.push(budget); }
        if (sql === 'PRAGMA journal_mode = WAL') { timer.advance(Math.min(1600, budget)); throw busy; }
      }); databases.push(db); return db;
    });
    const action = vi.fn();
    expect(() => withBookLockGuard('/fixture/work.lock', action)).toThrow(busy);
    expect(timer.now).toBe(5000); expect(limits[0]).toBe(5000); expect(limits).toEqual([5000, 3390, 1780, 170]);
    expect(action).not.toHaveBeenCalled(); expect(databases).toHaveLength(4);
    for (const db of databases) expect(db.close).toHaveBeenCalledTimes(1);
  });
  it('counts failed-connection close time in the same budget and never reopens after exhaustion', () => {
    const timer = clock(), busy = sqliteError(), action = vi.fn();
    const db = connection(sql => { if (sql === 'PRAGMA journal_mode = WAL') throw busy; });
    db.close.mockImplementation(() => { timer.advance(5000); }); hooks.open.mockReturnValue(db);
    expect(() => withBookLockGuard('/fixture/work.lock', action)).toThrow(busy);
    expect(timer.now).toBe(5000); expect(hooks.open).toHaveBeenCalledTimes(1); expect(db.close).toHaveBeenCalledTimes(1);
    expect(action).not.toHaveBeenCalled(); expect(timer.wait).not.toHaveBeenCalled();
  });
  it.each([sqliteError(6), Object.assign(new Error('database is locked'), { errcode: 5 }), new Error('database is locked')])('propagates a non-matching WAL error without retries: %j', error => {
    const timer = clock(), db = connection(sql => { if (sql === 'PRAGMA journal_mode = WAL') throw error; });
    hooks.open.mockReturnValue(db); const action = vi.fn();
    expect(() => withBookLockGuard('/fixture/work.lock', action)).toThrow(error);
    expect(hooks.open).toHaveBeenCalledTimes(1); expect(db.close).toHaveBeenCalledTimes(1); expect(timer.wait).not.toHaveBeenCalled(); expect(action).not.toHaveBeenCalled();
  });
  it.each(['busy-timeout', 'BEGIN IMMEDIATE', 'action', 'COMMIT', 'ROLLBACK'] as const)('does not replay initialization/action/transaction work after an error in %s', phase => {
    const timer = clock(), error = sqliteError(), actionError = new Error('action failed');
    const db = connection(sql => {
      if ((phase === 'busy-timeout' && sql.startsWith('PRAGMA busy_timeout = ')) || sql === phase) throw error;
    }); hooks.open.mockReturnValue(db);
    const action = vi.fn(() => { if (phase === 'action') throw error; if (phase === 'ROLLBACK') throw actionError; return 'value'; });
    expect(() => withBookLockGuard('/fixture/work.lock', action)).toThrow(error);
    expect(hooks.open).toHaveBeenCalledTimes(1); expect(db.close).toHaveBeenCalledTimes(1); expect(timer.wait).not.toHaveBeenCalled();
    expect(action).toHaveBeenCalledTimes(['action', 'COMMIT', 'ROLLBACK'].includes(phase) ? 1 : 0);
    expect(db.exec.mock.calls.filter(([sql]) => sql === 'COMMIT')).toHaveLength(phase === 'COMMIT' ? 1 : 0);
    expect(db.exec.mock.calls.filter(([sql]) => sql === 'ROLLBACK')).toHaveLength(['action', 'COMMIT', 'ROLLBACK'].includes(phase) ? 1 : 0);
  });
  it('does not reopen after closing a failed WAL connection rejects', () => {
    const timer = clock(), busy = sqliteError(), closeError = new Error('close failed');
    const db = connection(sql => { if (sql === 'PRAGMA journal_mode = WAL') throw busy; }); db.close.mockImplementation(() => { throw closeError; });
    hooks.open.mockReturnValue(db);
    expect(() => withBookLockGuard('/fixture/work.lock', vi.fn())).toThrow(closeError);
    expect(hooks.open).toHaveBeenCalledTimes(1); expect(db.close).toHaveBeenCalledTimes(1); expect(timer.wait).not.toHaveBeenCalled();
  });
  it('does not retry a failed constructor or invoke the action', () => {
    const timer = clock(), failure = sqliteError(), action = vi.fn(); hooks.open.mockImplementation(() => { throw failure; });
    expect(() => withBookLockGuard('/fixture/work.lock', action)).toThrow(failure);
    expect(hooks.open).toHaveBeenCalledTimes(1); expect(action).not.toHaveBeenCalled(); expect(timer.wait).not.toHaveBeenCalled();
  });
  it('arbitrates independent fresh-path CAS writers without replacing the mutex inode', async () => {
    // Required process integration coverage; the fault injection above is confined to this test process.
    for (let pair = 0; pair < 8; pair++) {
      const root = await mkdtemp(join(tmpdir(), 'inkos-guard-cas-')); roots.push(root);
      const first = worker(root, 'first'), second = worker(root, 'second');
      await Promise.all([first.ready, second.ready]); first.start(); second.start();
      const results = await Promise.all([first.done, second.done]);
      expect(results.filter(result => result.status === 'saved')).toHaveLength(1);
      expect(results.filter(result => result.code === 'AGENT_SETTINGS_REVISION_CONFLICT')).toHaveLength(1);
      const inode = (await stat(join(root, '.inkos', BOOK_LOCK_GUARD_FILE))).ino;
      expect(results.map(result => result.inode)).toEqual([inode, inode]);
      expect(JSON.parse(await readFile(join(root, '.inkos', 'agent-config.json'), 'utf8')).revision).toBe(1);
    }
  });
});
