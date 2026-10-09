import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
import { GoalStore } from '../goals/store.js';
import { SchedulerStore } from '../pipeline/scheduler-store.js';
import { createOwnershipLockSpace, SQLITE_OWNER_TOKEN_PREFIX } from '../harness/ownership-lock.js';
import type { Goal, GoalLease } from '../goals/contracts.js';

const roots: string[] = [], children: ChildProcess[] = [], stores: GoalStore[] = [];
const leases: Array<{ store: GoalStore; lease: GoalLease }> = [];
let modules: string;
beforeAll(async () => {
  modules = await mkdtemp(join(tmpdir(), 'inkos-goal-owner-modules-'));
  await symlink(fileURLToPath(new URL('../../node_modules', import.meta.url)), join(modules, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  for (const part of ['goals/store', 'goals/contracts', 'harness/sqlite', 'harness/ownership-lock', 'harness/contracts', 'models/observation', 'utils/source-text']) {
    const source = await readFile(new URL(`../${part}.ts`, import.meta.url), 'utf8');
    await mkdir(dirname(join(modules, `${part}.js`)), { recursive: true });
    await writeFile(join(modules, `${part}.js`), ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText);
  }
  return () => rm(modules, { recursive: true, force: true });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(children.splice(0).map(kill));
  for (const { store, lease } of leases.splice(0)) {
    try { store.release(lease, 'interrupted'); } catch (error) {
      if ((error as { code?: string }).code !== 'GOAL_OWNER_LOST') throw error;
    }
  }
  for (const store of stores.splice(0)) store.close();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
function open(path: string) { const store = new GoalStore(path); stores.push(store); return store; }
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'inkos-goal-owner-'));
  roots.push(root);
  const path = join(root, 'harness.sqlite');
  const store = open(path);
  createReady(store, 'goal', 'work');
  return { root, path, store };
}
function createReady(store: GoalStore, id: string, workId: string) {
  store.create({ id, workId, intent: 'Run a deterministic fixture',
    steps: [{ id: 'step', kind: 'fixture', input: {}, maxAttempts: 2 }],
    budget: { maxAttempts: 2, expiresAt: null } });
  store.requestRun(id, store.get(id).version);
}
function claim(store: GoalStore, id = 'goal') {
  const lease = store.claim(id)!;
  expect(lease).toBeDefined();
  leases.push({ store, lease });
  return lease;
}
async function kill(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
}
async function launch(script: string, ...args: string[]) {
  const child = spawn(process.execPath, ['-e', script, ...args], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    let errors = '';
    const timer = setTimeout(() => finish(new Error(`Child readiness timed out: ${errors}`)), 5_000);
    const finish = (error?: Error) => {
      clearTimeout(timer); child.off('message', message); child.off('error', fail); child.off('exit', exit);
      error ? reject(error) : resolve();
    };
    const message = (value: unknown) => { if (value === 'ready') finish(); };
    const fail = (error: Error) => finish(error);
    const exit = (code: number | null) => finish(new Error(`Child exited before readiness: ${code}; ${errors}`));
    child.stderr!.on('data', data => { errors += data.toString(); });
    child.on('message', message); child.once('error', fail); child.once('exit', exit);
  });
  return child;
}
function ownerChild(path: string) {
  return launch(`
    const { GoalStore } = require(process.argv[1]);
    const store = new GoalStore(process.argv[2]);
    const lease = store.claim('goal');
    if (!lease) throw Error('fixture owner was not admitted');
    store.beginAttempt(lease, 'step', 'baseline');
    process.send('ready'); setInterval(() => {}, 1000);
  `, join(modules, 'goals/store.js'), path);
}
function unrelatedChild() { return launch(`process.send('ready'); setInterval(() => {}, 1000);`); }
function edit(path: string, id: string, change: (goal: Omit<Goal, 'steps'>) => void) {
  const db = new DatabaseSync(path);
  try {
    const data = JSON.parse(String(db.prepare('SELECT data_json FROM goals WHERE id=?').get(id)!.data_json));
    change(data);
    db.prepare('UPDATE goals SET owner_token=?,data_json=? WHERE id=?').run(data.owner?.token ?? null, JSON.stringify(data), id);
  } finally { db.close(); }
}

describe('goal kernel ownership and conservative legacy recovery', () => {
  it.each(['run', 'paused', 'cancelled'] as const)('recovers a killed owner despite an unrelated live PID, preserving desiredState=%s', async desired => {
    const { path, store } = await setup();
    const owner = await ownerChild(path);
    const before = store.get('goal');
    expect(before.owner?.token.startsWith(SQLITE_OWNER_TOKEN_PREFIX)).toBe(true);
    if (desired !== 'run') store.requestStop('goal', desired, before.version);
    await kill(owner);
    const unrelated = await unrelatedChild();
    edit(path, 'goal', goal => { goal.owner!.pid = unrelated.pid!; });
    const persisted = store.get('goal'), events = store.events('goal');
    const signal = vi.spyOn(process, 'kill');
    const recovered = store.recover('goal', persisted.version);
    expect(signal).not.toHaveBeenCalled();
    expect(recovered.status).toBe(desired === 'run' ? 'interrupted' : desired);
    expect(recovered.owner).toBeNull();
    expect(recovered.version).toBe(persisted.version + 1);
    expect(recovered.attempts).toBe(before.attempts);
    expect(recovered.budget).toEqual(before.budget);
    expect(recovered.steps[0]).toEqual({ ...before.steps[0], interruptedAttempt: 1 });
    expect(store.events('goal')).toHaveLength(events.length + 1);
    expect(store.recover('goal')).toEqual(recovered);
    expect(store.claim('goal')).toBeUndefined();
    expect(unrelated.exitCode).toBeNull(); expect(unrelated.signalCode).toBeNull();
  });

  it('keeps a genuinely live owner despite dead PID and expired lease without any state or event changes', async () => {
    const { path, store } = await setup();
    await ownerChild(path);
    const dead = await unrelatedChild(); await kill(dead);
    edit(path, 'goal', goal => { goal.owner!.pid = dead.pid!; goal.owner!.leaseUntil = 0; });
    const before = store.get('goal'), events = store.events('goal');
    const signal = vi.spyOn(process, 'kill');
    expect(store.recover('goal', before.version)).toEqual(before);
    expect(signal).not.toHaveBeenCalled();
    expect(store.events('goal')).toEqual(events);
    expect(() => store.recover('goal', before.version - 1)).toThrow(expect.objectContaining({ code: 'GOAL_VERSION_CONFLICT' }));
    expect(store.claim('goal')).toBeUndefined();
  });

  it('preserves legacy live owners, including EPERM, and recovers confirmed dead owners only', async () => {
    const { path, store } = await setup();
    const legacy = await unrelatedChild();
    edit(path, 'goal', goal => { goal.status = 'running'; goal.owner = { pid: legacy.pid!, token: 'legacy-owner', leaseUntil: 0 }; });
    const before = store.get('goal');
    expect(store.recover('goal')).toEqual(before);
    const signal = vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); });
    expect(store.recover('goal')).toEqual(before);
    signal.mockRestore();
    await kill(legacy);
    expect(store.recover('goal').status).toBe('interrupted');
    expect(store.claim('goal')).toBeUndefined();
  });

  it('retains same-process legacy activeOwners checks for old tokens', async () => {
    const { path, store } = await setup();
    edit(path, 'goal', goal => { goal.status = 'running'; goal.owner = { pid: process.pid, token: 'unregistered-legacy-owner', leaseUntil: 0 }; });
    expect(store.recover('goal').owner).toBeNull();
  });

  it('claims one goal per work across stores and aliases while different works run in parallel', async () => {
    const { root, path, store } = await setup();
    createReady(store, 'same-work', 'work'); createReady(store, 'other-work', 'other');
    await symlink(root, join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
    const other = open(join(root, 'alias', 'harness.sqlite'));
    const lease = claim(store);
    expect(other.claim('same-work')).toBeUndefined();
    expect(other.claim('goal')).toBeUndefined();
    expect(() => other.heartbeat(lease)).toThrow(expect.objectContaining({ code: 'GOAL_OWNER_LOST' }));
    claim(other, 'other-work');
    expect(() => store.close()).toThrow(expect.objectContaining({ code: 'GOAL_BUSY' }));
    store.release(lease, 'interrupted');
    claim(other, 'same-work');
  });

  it('holds no main-ledger transaction during the owner lifetime', async () => {
    const { path, store } = await setup();
    const other = open(path), lease = claim(store);
    const scheduler = new SchedulerStore(path);
    try {
      scheduler.acquire();
      expect(scheduler.requestStop()).toBeDefined();
      scheduler.event('fixture-write', { okay: true });
      expect(scheduler.events(1)[0]!.type).toBe('fixture-write');
      const stopped = other.requestStop('goal', 'paused', other.get('goal').version);
      expect(store.heartbeat(lease).desiredState).toBe('paused');
      expect(other.events('goal').at(-1)?.type).toBe('goal-paused-requested');
      expect(other.recover('goal')).toEqual(store.get('goal'));
      expect(store.get('goal').version).toBe(stopped.version);
    } finally { scheduler.close(); }
  });

  it.each(['ABORT', 'ROLLBACK'])('does not leak tentative ownership after claim persistence fails with %s', async mode => {
    const { path, store } = await setup(), other = open(path);
    const db = new DatabaseSync(path);
    try {
      db.exec(`CREATE TRIGGER fail_claim BEFORE INSERT ON goal_events WHEN NEW.type='goal-claimed' BEGIN SELECT RAISE(${mode},'fixture-claim-failure'); END`);
      const before = store.get('goal'), events = store.events('goal');
      expect(() => store.claim('goal')).toThrow('fixture-claim-failure');
      expect(store.get('goal')).toEqual(before); expect(store.events('goal')).toEqual(events);
      db.exec('DROP TRIGGER fail_claim');
      claim(other);
    } finally { db.close(); }
  });

  it.each(['ABORT', 'ROLLBACK'])('releases ownership after failed durable release with %s while preserving evidence for recovery', async mode => {
    const { path, store } = await setup(), other = open(path);
    const lease = claim(store); store.beginAttempt(lease, 'step', 'baseline');
    const before = store.get('goal'), events = store.events('goal');
    const db = new DatabaseSync(path);
    try {
      db.exec(`CREATE TRIGGER fail_release BEFORE INSERT ON goal_events WHEN NEW.type='goal-released' BEGIN SELECT RAISE(${mode},'fixture-release-failure'); END`);
      expect(() => store.release(lease, 'interrupted')).toThrow('fixture-release-failure');
      expect(store.get('goal')).toEqual(before); expect(store.events('goal')).toEqual(events);
      expect(() => store.heartbeat(lease)).toThrow(expect.objectContaining({ code: 'GOAL_OWNER_LOST' }));
      db.exec('DROP TRIGGER fail_release');
      expect(other.recover('goal').status).toBe('interrupted');
      other.requestRun('goal', other.get('goal').version); claim(other);
    } finally { db.close(); }
  });

  it('does not leak the recovery probe when persistence fails', async () => {
    const { path, store } = await setup();
    const owner = await ownerChild(path); await kill(owner);
    const db = new DatabaseSync(path), before = store.get('goal');
    try {
      db.exec("CREATE TRIGGER fail_recover BEFORE INSERT ON goal_events WHEN NEW.type='goal-owner-recovered' BEGIN SELECT RAISE(ABORT,'fixture-recovery-failure'); END");
      expect(() => store.recover('goal')).toThrow('fixture-recovery-failure');
      expect(store.get('goal')).toEqual(before);
      db.exec('DROP TRIGGER fail_recover');
      expect(open(path).recover('goal').status).toBe('interrupted');
    } finally { db.close(); }
  });

  it('retains the recovery proof through the transaction and releases it after commit', async () => {
    const { path, store } = await setup();
    const owner = await ownerChild(path); await kill(owner);
    const space = createOwnershipLockSpace(path), original = store.get.bind(store);
    let reads = 0;
    const read = vi.spyOn(store, 'get').mockImplementation(id => {
      if (++reads === 2) expect(space.tryAcquire('goal-owner', 'work')).toBeUndefined();
      return original(id);
    });
    expect(store.recover('goal').status).toBe('interrupted');
    expect(reads).toBe(2); read.mockRestore();
    const available = space.tryAcquire('goal-owner', 'work');
    expect(available).toBeDefined(); available!.release();
  });

  it('does not use a stale recovery read to clear a replacement owner', async () => {
    const { path, store } = await setup();
    const owner = await ownerChild(path); await kill(owner);
    const original = store.get.bind(store), events = store.events('goal');
    const replacement = `${SQLITE_OWNER_TOKEN_PREFIX}replacement-owner`;
    vi.spyOn(store, 'get').mockImplementationOnce(id => {
      const old = original(id);
      edit(path, id, goal => { goal.owner!.token = replacement; });
      return old;
    });
    expect(store.recover('goal').owner?.token).toBe(replacement);
    expect(store.events('goal')).toEqual(events);
    expect(store.get('goal').status).toBe('running');
  });

  it('admits exactly one process for the same work from a shared start barrier', async () => {
    const { root, path, store } = await setup();
    for (let index = 1; index < 4; index++) createReady(store, `goal-${index}`, 'work');
    const contenders = await Promise.all(Array.from({ length: 4 }, (_, index) => launch(`
      const { GoalStore } = require(process.argv[1]);
      const { writeFileSync } = require('node:fs');
      const store = new GoalStore(process.argv[2]);
      process.on('message', message => {
        if (message !== 'claim') return;
        const lease = store.claim(process.argv[3]);
        writeFileSync(process.argv[4], JSON.stringify({ acquired: Boolean(lease), token: lease?.token }));
        process.send('claimed');
      });
      process.send('ready'); setInterval(() => {}, 1000);
    `, join(modules, 'goals/store.js'), path, index ? `goal-${index}` : 'goal', join(root, `${index}.json`))));
    const done = contenders.map(child => once(child, 'message'));
    contenders.forEach(child => child.send('claim'));
    await Promise.all(done);
    const outcomes = await Promise.all(contenders.map((_, index) => readFile(join(root, `${index}.json`), 'utf8').then(JSON.parse)));
    expect(outcomes.filter(value => value.acquired)).toHaveLength(1);
    expect(store.list().filter(goal => goal.owner)).toHaveLength(1);
    expect(store.list().find(goal => goal.owner)?.owner?.token).toBe(outcomes.find(value => value.acquired).token);
  });

  it('preserves maximum-length existing business IDs without SQLite VFS path failures', async () => {
    const { path, store } = await setup();
    const other = open(path);
    for (const [index, workId] of ['W'.repeat(120), 'w'.repeat(120), '书'.repeat(120)].entries()) {
      const id = `long-work-${index}`;
      createReady(store, id, workId);
      claim(store, id);
      expect(other.recover(id).status).toBe('running');
      expect(other.claim(id)).toBeUndefined();
    }
  });

  it('isolates independent in-memory stores with identical work IDs', () => {
    const first = open(':memory:'), second = open(':memory:');
    createReady(first, 'goal', 'work'); createReady(second, 'goal', 'work');
    claim(first); claim(second);
    expect(first.recover('goal').status).toBe('running');
    expect(second.recover('goal').status).toBe('running');
  });
});
