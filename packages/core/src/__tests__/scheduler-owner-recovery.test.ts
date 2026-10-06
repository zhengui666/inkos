import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
import { SchedulerStore } from '../pipeline/scheduler-store.js';

const roots: string[] = [];
const children: ChildProcess[] = [];
const stores: SchedulerStore[] = [];
let modules: string;

beforeAll(async () => {
  modules = await mkdtemp(join(tmpdir(), 'inkos-owner-modules-'));
  await mkdir(join(modules, 'pipeline'));
  await mkdir(join(modules, 'harness'));
  for (const part of ['pipeline/scheduler-store', 'harness/sqlite']) {
    const source = await readFile(new URL(`../${part}.ts`, import.meta.url), 'utf8');
    await writeFile(join(modules, `${part}.js`), ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText);
  }
  return () => rm(modules, { recursive: true, force: true });
});

afterEach(async () => {
  await Promise.all(children.splice(0).map(kill));
  for (const store of stores.splice(0)) store.close();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'inkos-owner-recovery-'));
  roots.push(root);
  const path = join(root, 'harness.sqlite');
  const store = new SchedulerStore(path);
  stores.push(store);
  return { path, store };
}

async function launch(script: string, ...args: string[]) {
  const child = spawn(process.execPath, ['-e', script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    let output = '', errors = '';
    const timeout = setTimeout(() => finish(new Error(`Child readiness timed out: ${errors}`)), 5000);
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      child.stdout!.removeListener('data', onData);
      child.stderr!.removeListener('data', onErrorData);
      child.removeListener('error', onError);
      child.removeListener('exit', onExit);
      error ? reject(error) : resolve();
    };
    const onData = (data: Buffer) => { output += data.toString(); if (output.includes('ready\n')) finish(); };
    const onErrorData = (data: Buffer) => { errors += data.toString(); };
    const onError = (error: Error) => finish(error);
    const onExit = (code: number | null) => finish(new Error(`Child exited before readiness: ${code}; ${errors}`));
    child.stdout!.on('data', onData);
    child.stderr!.on('data', onErrorData);
    child.once('error', onError);
    child.once('exit', onExit);
  });
  return child;
}

async function kill(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
}

function editOwner(path: string, pid: number, token?: string) {
  const db = new DatabaseSync(path);
  try {
    if (token) db.prepare('INSERT OR REPLACE INTO scheduler_owner(id,pid,token) VALUES(1,?,?)').run(pid, token);
    else db.prepare('UPDATE scheduler_owner SET pid=? WHERE id=1').run(pid);
  } finally { db.close(); }
}

function ownerChild(path: string) {
  return launch(`
    const { SchedulerStore } = require(process.argv[1]);
    const store = new SchedulerStore(process.argv[2]);
    store.acquire();
    store.reserve('fixture-book', 4, Date.now(), 1);
    store.schedule('write', Date.now() + 3600000);
    process.stdout.write('ready\\n');
    setInterval(() => {}, 1000);
  `, join(modules, 'pipeline/scheduler-store.js'), path);
}

function unrelatedChild() {
  return launch(`process.stdout.write('ready\\n'); setInterval(() => {}, 1000);`);
}

describe('daemon ownership survives process identity reuse', () => {
  it('recovers the retained goal after a crash even when the old PID now belongs to a live unrelated process', async () => {
    const { path, store } = await setup();
    const owner = await ownerChild(path);
    const before = store.latest('fixture-book')!;
    const due = store.nextAt('write', 0);
    await kill(owner);
    const unrelated = await unrelatedChild();
    // Deterministic PID-reuse simulation: the stale row points at a real,
    // unrelated live child. No signal is ever sent to that recorded PID.
    editOwner(path, unrelated.pid!);

    expect(() => store.acquire()).not.toThrow();
    expect(store.latest('fixture-book')).toEqual(before);
    expect(store.nextAt('write', 0)).toBe(due);
    expect(store.reserve('another-book', 1, Date.now(), 1)).toBeUndefined();
    expect(unrelated.exitCode).toBeNull();
    expect(unrelated.signalCode).toBeNull();
  });

  it('rejects a second owner based on the held lock even if its ledger PID appears dead', async () => {
    const { path, store } = await setup();
    await ownerChild(path);
    const dead = await unrelatedChild();
    await kill(dead);
    editOwner(path, dead.pid!);
    const previous = store.runningOwner();

    expect(() => store.acquire()).toThrow(expect.objectContaining({ code: 'DAEMON_BUSY' }));
    expect(store.runningOwner()).toEqual(previous);
  });

  it('leaves ledger writes and stop requests available while the process lock is held', async () => {
    const { path, store } = await setup();
    const owner = await ownerChild(path);
    expect(store.requestStop()?.pid).toBe(owner.pid);
    expect(store.stopRequested()).toBe(true);
    store.event('fixture-observation', { readOnlyRemote: true });
    expect(store.events(1)[0].type).toBe('fixture-observation');
  });

  it('does not steal an active pre-upgrade owner and releases its tentative lock after rejection', async () => {
    const { path, store } = await setup();
    const legacy = await unrelatedChild();
    editOwner(path, legacy.pid!, 'legacy-owner-token');
    expect(() => store.acquire()).toThrow(expect.objectContaining({ code: 'DAEMON_BUSY' }));
    await kill(legacy);
    expect(() => store.acquire()).not.toThrow();
  });

  it('releases the process lock after an owner-claim transaction fails', async () => {
    const { path, store } = await setup();
    const db = new DatabaseSync(path);
    try {
      db.exec("CREATE TRIGGER refuse_owner BEFORE INSERT ON scheduler_owner BEGIN SELECT RAISE(ABORT, 'fixture-claim-failure'); END");
      expect(() => store.acquire()).toThrow('fixture-claim-failure');
      db.exec('DROP TRIGGER refuse_owner');
      expect(() => store.acquire()).not.toThrow();
    } finally { db.close(); }
  });

  it('admits exactly one of several concurrent process starts', async () => {
    const { path, store } = await setup();
    const resultPaths = Array.from({ length: 4 }, (_, index) => `${path}.contender-${index}.json`);
    await Promise.all(resultPaths.map(resultPath => launch(`
      const { SchedulerStore } = require(process.argv[1]);
      const { writeFileSync } = require('node:fs');
      const store = new SchedulerStore(process.argv[2]);
      let outcome;
      try { store.acquire(); outcome = 'acquired'; }
      catch (error) {
        if (error.code !== 'DAEMON_BUSY') throw error;
        outcome = 'busy'; store.close();
      }
      writeFileSync(process.argv[3], JSON.stringify({ outcome, pid: process.pid }));
      process.stdout.write('ready\\n');
      setInterval(() => {}, 1000);
    `, join(modules, 'pipeline/scheduler-store.js'), path, resultPath)));
    const outcomes = await Promise.all(resultPaths.map(async resultPath => JSON.parse(await readFile(resultPath, 'utf8'))));
    expect(outcomes.filter(result => result.outcome === 'acquired')).toHaveLength(1);
    expect(outcomes.filter(result => result.outcome === 'busy')).toHaveLength(3);
    expect(store.runningOwner()?.pid).toBe(outcomes.find(result => result.outcome === 'acquired').pid);
  });

  it('uses the same process lock through directory aliases', async () => {
    const { path, store } = await setup();
    const aliasRoot = await mkdtemp(join(tmpdir(), 'inkos-owner-alias-'));
    roots.push(aliasRoot);
    const realDirectory = join(path, '..');
    await symlink(realDirectory, join(aliasRoot, 'project'), process.platform === 'win32' ? 'junction' : 'dir');
    const aliased = new SchedulerStore(join(aliasRoot, 'project', 'harness.sqlite'));
    stores.push(aliased);
    store.acquire();
    // PID corruption is not required for normal exclusion. It isolates the
    // canonical lock-path assertion from the legacy live-PID fallback.
    editOwner(path, 2147483647);
    expect(() => aliased.acquire()).toThrow(expect.objectContaining({ code: 'DAEMON_BUSY' }));
  });

  it('releases the process lock while still surfacing an owner-cleanup failure', async () => {
    const { path, store } = await setup();
    store.acquire();
    const db = new DatabaseSync(path);
    try {
      db.exec("CREATE TRIGGER refuse_owner_cleanup BEFORE DELETE ON scheduler_owner BEGIN SELECT RAISE(ABORT, 'fixture-cleanup-failure'); END");
      expect(() => store.close()).toThrow('fixture-cleanup-failure');
      stores.splice(stores.indexOf(store), 1);
      db.exec('DROP TRIGGER refuse_owner_cleanup');
      const next = new SchedulerStore(path);
      stores.push(next);
      expect(() => next.acquire()).not.toThrow();
    } finally { db.close(); }
  });

  it('does not release the real owner when a failed contender closes', async () => {
    const { path, store } = await setup();
    store.acquire();
    const contender = new SchedulerStore(path);
    expect(() => contender.acquire()).toThrow(expect.objectContaining({ code: 'DAEMON_BUSY' }));
    contender.close();
    const third = new SchedulerStore(path);
    stores.push(third);
    expect(() => third.acquire()).toThrow(expect.objectContaining({ code: 'DAEMON_BUSY' }));
    store.close();
    stores.splice(stores.indexOf(store), 1);
    expect(() => third.acquire()).not.toThrow();
  });
});
