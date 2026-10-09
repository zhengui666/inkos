import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChatRequestStore } from "../api/chat-request-store.js";
import type { StudioChatRequestSnapshot } from "../shared/session-request.js";

const roots: string[] = [], children: ChildProcess[] = [];
const sessionId = "session/with spaces";
type Command = { action: string; [key: string]: unknown };
type Worker = { child: ChildProcess;
  call<T = unknown>(command: Command, onStarted?: () => void): Promise<T>;
  waitForWrite(): Promise<void> };

afterEach(async () => {
  await Promise.all(children.splice(0).map(stop));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "inkos-chat-process-"));
  roots.push(root);
  return { root, store: new ChatRequestStore(root) };
}

function snapshotPath(root: string): string {
  return join(root, ".inkos", "chat-requests", `${encodeURIComponent(sessionId)}.json`);
}

async function writeFixture(root: string, snapshot: StudioChatRequestSnapshot): Promise<void> {
  await mkdir(join(root, ".inkos", "chat-requests"), { recursive: true });
  await writeFile(snapshotPath(root), JSON.stringify(snapshot), { mode: 0o600 });
}

async function worker(root: string): Promise<Worker> {
  // Like book-write-lock.test.ts, execute the real TypeScript source in a
  // separate OS process. The bare core import has the same source target as
  // Studio's Vitest alias; ownership is never replaced with a mock.
  const studioSourceRoot = new URL("../", import.meta.url).href;
  const coreSourceRoot = new URL("../../../core/src/", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { registerHooks, syncBuiltinESMExports } from 'node:module';
    import fs from 'node:fs';
    import { readFileSync } from 'node:fs';
    import { fileURLToPath } from 'node:url';
    import { join } from 'node:path';
    import ts from 'typescript';
    const studioSourceRoot = ${JSON.stringify(studioSourceRoot)};
    const coreSourceRoot = ${JSON.stringify(coreSourceRoot)};
    let pauseNextWrite = false, resumeWrite;
    const realWriteFile = fs.promises.writeFile;
    // A deterministic file-I/O latch, after a real temporary write and before
    // rename. The actual ownership helper and filesystem operations still run.
    fs.promises.writeFile = async (...args) => {
      const result = await realWriteFile(...args);
      if (pauseNextWrite && String(args[0]).endsWith('.tmp')) {
        pauseNextWrite = false;
        const resumed = new Promise(done => { resumeWrite = done; });
        process.send({ writePaused: true });
        await resumed;
      }
      return result;
    };
    syncBuiltinESMExports();
    registerHooks({
      resolve(specifier, context, next) {
        if (specifier === '@actalk/inkos-core') return next(coreSourceRoot + 'index.ts', context);
        const local = context.parentURL?.startsWith(studioSourceRoot) || context.parentURL?.startsWith(coreSourceRoot);
        return next(local && specifier.startsWith('.') && specifier.endsWith('.js')
          ? specifier.slice(0, -3) + '.ts' : specifier, context);
      },
      load(url, context, next) {
        if ((url.startsWith(studioSourceRoot) || url.startsWith(coreSourceRoot)) && url.endsWith('.ts')) {
          return { format: 'module', shortCircuit: true, source: ts.transpileModule(
            readFileSync(fileURLToPath(url), 'utf8'), {
              compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
            }).outputText };
        }
        return next(url, context);
      },
    });
    const { ChatRequestStore } = await import(studioSourceRoot + 'api/chat-request-store.ts');
    const { createOwnershipLockSpace } = await import(coreSourceRoot + 'index.ts');
    const root = ${JSON.stringify(root)};
    const store = new ChatRequestStore(root);
    const requests = new Map();
    let validateCalls = 0, modelCalls = 0, stateHolding, releaseState;
    async function run(command) {
      switch (command.action) {
        case 'prepare': {
          const snapshot = { sessionId: command.sessionId, requestId: command.requestId,
            startedAt: 1, status: 'running', retry: { text: 'Continue' }, owner: store.createOwner() };
          requests.set(command.requestId, snapshot);
          return snapshot;
        }
        case 'admit': {
          const snapshot = requests.get(command.requestId);
          const admitted = await store.admit(snapshot, () => {
            validateCalls++;
            if (command.failValidation) throw new Error('fixture validation failure');
            return snapshot;
          });
          requests.set(command.requestId, admitted);
          // The deterministic downstream stub is reached only after admission.
          modelCalls++;
          return { snapshot: admitted, validateCalls, modelCalls };
        }
        case 'save': {
          const snapshot = { ...requests.get(command.requestId), ...command.changes };
          await store.save(snapshot, command.mode ?? 'update');
          return store.load(snapshot.sessionId);
        }
        case 'release':
          store.releaseOwner(requests.get(command.requestId).owner);
          return true;
        case 'admitOtherSession': {
          const snapshot = { ...requests.get(command.requestId), sessionId: command.sessionId,
            requestId: command.otherRequestId };
          return store.admit(snapshot);
        }
        case 'cancel': return store.cancel(command.sessionId, command.liveRequestId);
        case 'recover': return store.recover(command.sessionId);
        case 'load': return store.load(command.sessionId);
        case 'delete': await store.delete(command.sessionId); return true;
        case 'pauseNextWrite': pauseNextWrite = true; return true;
        case 'lockInfo': {
          const locks = createOwnershipLockSpace(join(root, '.inkos', 'harness.sqlite'));
          const info = { canonicalDatabasePath: locks.canonicalDatabasePath };
          for (const kind of ['studio-chat-owner', 'studio-chat-state']) {
            const key = locks.key(kind, command.sessionId);
            info[kind] = { key, file: await fs.promises.stat(key)
              .then(stat => ({ size: stat.size, inode: stat.ino })).catch(error => ({ code: error.code })) };
          }
          return info;
        }
        case 'holdState': {
          const locks = createOwnershipLockSpace(join(root, '.inkos', 'harness.sqlite'));
          await new Promise((held, reject) => {
            stateHolding = locks.withStateLock('studio-chat-state', command.sessionId, async () => {
              const released = new Promise(done => { releaseState = done; });
              held();
              await released;
            });
            stateHolding.catch(reject);
          });
          return true;
        }
        case 'releaseState': releaseState(); await stateHolding; return true;
        default: throw new Error('Unknown fixture command: ' + command.action);
      }
    }
    let queue = Promise.resolve();
    process.on('message', command => {
      if (command.action === 'resumeWrite') {
        resumeWrite();
        process.send({ id: command.id, ok: true, value: true });
        return;
      }
      queue = queue.then(async () => {
        const realNow = Date.now;
        if (command.now !== undefined) Date.now = () => command.now;
        try {
          process.send({ started: command.id });
          process.send({ id: command.id, ok: true, value: await run(command) });
        }
        catch (error) { process.send({ id: command.id, ok: false,
          error: { message: error.message, code: error.code, validateCalls, modelCalls,
            request: requests.get(command.requestId) } }); }
        finally { Date.now = realNow; }
      });
    });
    process.send({ ready: true });
  `], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  children.push(child);
  let stderr = "", sequence = 0;
  child.stderr!.on("data", chunk => { stderr += chunk; });
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void;
    onStarted?: () => void }>();
  let writePaused = false;
  let writeWaiter: { resolve(): void; reject(error: Error): void } | undefined;
  let readyResolve!: () => void, readyReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const readyTimer = setTimeout(() => readyReject(new Error(`Worker did not become ready: ${stderr}`)), 20_000);
  child.on("message", message => {
    const reply = message as { ready?: boolean; started?: number; writePaused?: boolean;
      id: number; ok: boolean; value: unknown;
      error: { message: string; code?: string; validateCalls: number; modelCalls: number } };
    if (reply.ready) { clearTimeout(readyTimer); readyResolve(); return; }
    if (reply.writePaused) { writePaused = true; writeWaiter?.resolve(); return; }
    if (reply.started !== undefined) { pending.get(reply.started)?.onStarted?.(); return; }
    const request = pending.get(reply.id);
    if (!request) return;
    pending.delete(reply.id);
    if (reply.ok) request.resolve(reply.value);
    else request.reject(Object.assign(new Error(reply.error.message), reply.error));
  });
  const fail = (error: Error) => {
    clearTimeout(readyTimer);
    readyReject(error);
    writeWaiter?.reject(error);
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  child.once("error", fail);
  child.once("exit", (code, signal) => fail(new Error(`Worker exited (${code ?? signal}): ${stderr}`)));
  await ready;
  return { child, waitForWrite() {
    if (writePaused) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Worker write did not pause: ${stderr}`)), 10_000);
      writeWaiter = { resolve: () => { clearTimeout(timer); resolve(); },
        reject: error => { clearTimeout(timer); reject(error); } };
    });
  }, call<T>(command: Command, onStarted?: () => void): Promise<T> {
    const id = ++sequence;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Worker command ${command.action} timed out: ${stderr}`));
      }, 10_000);
      pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value as T); },
        reject: error => { clearTimeout(timer); reject(error); }, onStarted });
      child.send({ ...command, id }, error => {
        if (error) { pending.delete(id); clearTimeout(timer); reject(error); }
      });
    });
  } };
}

async function prepare(owner: Worker, requestId: string): Promise<StudioChatRequestSnapshot> {
  return owner.call({ action: "prepare", sessionId, requestId });
}

async function admit(owner: Worker, requestId: string): Promise<StudioChatRequestSnapshot> {
  await prepare(owner, requestId);
  return (await owner.call<{ snapshot: StudioChatRequestSnapshot }>({ action: "admit", requestId })).snapshot;
}

describe("ChatRequestStore across real processes", () => {
  it("admits exactly one of four barrier contenders through canonical root aliases", async () => {
    const f = await fixture(), aliases = await mkdtemp(join(tmpdir(), "inkos-chat-alias-"));
    roots.push(aliases);
    const alias = join(aliases, "project");
    await symlink(f.root, alias, process.platform === "win32" ? "junction" : "dir");
    const peers = await Promise.all([f.root, alias, f.root, alias].map(worker));
    await Promise.all(peers.map((peer, index) => prepare(peer, `request-${index}`)));
    // Every child is armed before any child receives the barrier release.
    const results = await Promise.allSettled(peers.map((peer, index) =>
      peer.call<{ snapshot: StudioChatRequestSnapshot; validateCalls: number; modelCalls: number }>(
        { action: "admit", requestId: `request-${index}` })));
    const winners = results.filter(result => result.status === "fulfilled");
    const failures = results.map(result => result.status === "rejected"
      ? { code: result.reason.code, message: result.reason.message, request: result.reason.request,
        validateCalls: result.reason.validateCalls, modelCalls: result.reason.modelCalls }
      : { requestId: result.value.snapshot.requestId });
    const diagnostics = winners.length === 1 ? undefined : {
      results: failures, saved: await f.store.load(sessionId),
      locks: await peers[0].call({ action: "lockInfo", sessionId }),
    };
    expect(winners, JSON.stringify(diagnostics)).toHaveLength(1);
    for (const result of results) {
      if (result.status === "rejected") expect(result.reason).toMatchObject({
        code: "CHAT_REQUEST_ALREADY_RUNNING", validateCalls: 0, modelCalls: 0,
      });
    }
    const winner = winners[0];
    if (winner.status !== "fulfilled") throw new Error("Missing admission winner");
    expect(winner.value).toMatchObject({ validateCalls: 1, modelCalls: 1 });
    expect(await f.store.load(sessionId)).toEqual(winner.value.snapshot);

    const winnerIndex = results.findIndex(result => result.status === "fulfilled");
    await peers[winnerIndex].call({ action: "release", requestId: winner.value.snapshot.requestId });
    const loser = peers[(winnerIndex + 1) % peers.length];
    const next = await admit(loser, "after-release");
    expect(await f.store.load(sessionId)).toEqual(next);
  }, 60_000);

  it("keeps the first durable cancel intent across child progress, repeated cancel and final success", async () => {
    const f = await fixture(), [finalizer, canceller] = await Promise.all([worker(f.root), worker(f.root)]);
    await admit(finalizer, "request");
    expect(await canceller.call({ action: "cancel", sessionId })).toBeNull();
    const first = await canceller.call<StudioChatRequestSnapshot>({ action: "cancel", sessionId,
      liveRequestId: "request", now: 1000 });
    expect(first).toMatchObject({ status: "running", cancelRequestedAt: 1000 });
    const progress = await finalizer.call<StudioChatRequestSnapshot>({ action: "save", requestId: "request",
      changes: { status: "running", cancelRequestedAt: 9000 } });
    expect(progress).toMatchObject({ status: "running", cancelRequestedAt: 1000 });
    expect(await canceller.call({ action: "cancel", sessionId, liveRequestId: "request", now: 2000 }))
      .toMatchObject({ cancelRequestedAt: 1000 });
    await canceller.call({ action: "pauseNextWrite" });
    const cancelling = canceller.call<StudioChatRequestSnapshot>({ action: "cancel", sessionId,
      liveRequestId: "request", now: 2500 });
    await canceller.waitForWrite();
    let finalStarted!: () => void, finalized = false;
    const started = new Promise<void>(resolve => { finalStarted = resolve; });
    const finalizing = finalizer.call({ action: "save", requestId: "request", changes: {
      status: "completed", completedAt: 3000, retry: { text: "late retry" },
      error: { code: "LATE_ERROR", message: "late error" },
    } }, finalStarted).then(saved => { finalized = true; return saved; });
    try {
      await started;
      await new Promise(resolve => setTimeout(resolve, 25));
      expect(finalized).toBe(false);
    } finally { await canceller.call({ action: "resumeWrite" }); }
    expect(await cancelling).toMatchObject({ status: "running", cancelRequestedAt: 1000 });
    await finalizing;
    await finalizer.call({ action: "release", requestId: "request" });
    const saved = await f.store.load(sessionId);
    expect(saved).toMatchObject({ status: "cancelled", cancelRequestedAt: 1000, completedAt: 3000 });
    expect(saved?.retry).toBeUndefined();
    expect(saved?.error).toBeUndefined();
    await finalizer.call({ action: "save", requestId: "request", changes: { status: "completed" } });
    expect(await f.store.load(sessionId)).toEqual(saved);
  }, 60_000);

  it("does not let a released child finalizer overwrite a later child's admission", async () => {
    const f = await fixture(), [stale, next] = await Promise.all([worker(f.root), worker(f.root)]);
    await admit(stale, "old");
    await stale.call({ action: "release", requestId: "old" });
    const admitted = await admit(next, "new");
    await stale.call({ action: "save", requestId: "old", changes: { status: "completed", completedAt: 10 } });
    expect(await f.store.load(sessionId)).toEqual(admitted);
  }, 60_000);

  it("uses the live kernel owner even when the snapshot records an exited PID", async () => {
    const f = await fixture(), [owner, exited, observer] = await Promise.all([
      worker(f.root), worker(f.root), worker(f.root),
    ]);
    const admitted = await admit(owner, "live-kernel-owner");
    const deadPid = exited.child.pid!;
    await stop(exited.child);
    const mismatched = { ...admitted, owner: { ...admitted.owner!, pid: deadPid } };
    await writeFixture(f.root, mismatched);
    expect(await observer.call({ action: "recover", sessionId })).toEqual(mismatched);
    await prepare(observer, "contender");
    await expect(observer.call({ action: "admit", requestId: "contender" }))
      .rejects.toMatchObject({ code: "CHAT_REQUEST_ALREADY_RUNNING", modelCalls: 0 });
    expect(await f.store.load(sessionId)).toEqual(mismatched);
  }, 60_000);

  it("recovers a crashed kernel owner despite an unrelated live PID, exactly once", async () => {
    const f = await fixture(), [owner, unrelated, observer] = await Promise.all([
      worker(f.root), worker(f.root), worker(f.root),
    ]);
    const admitted = await admit(owner, "crashed-owner");
    await writeFixture(f.root, { ...admitted, owner: { ...admitted.owner!, pid: unrelated.child.pid! } });
    await stop(owner.child);
    const recovered = await observer.call<StudioChatRequestSnapshot>({ action: "recover", sessionId, now: 1000 });
    expect(recovered).toMatchObject({ requestId: "crashed-owner", status: "failed", completedAt: 1000,
      error: { code: "CHAT_REQUEST_INTERRUPTED" }, retry: { text: "Continue" } });
    expect(await observer.call({ action: "recover", sessionId, now: 2000 })).toEqual(recovered);
    expect(await f.store.load(sessionId)).toEqual(recovered);
  }, 60_000);

  it("preserves a legacy live process until it exits", async () => {
    const f = await fixture(), [legacy, observer] = await Promise.all([worker(f.root), worker(f.root)]);
    const saved: StudioChatRequestSnapshot = { sessionId, requestId: "legacy", startedAt: 1, status: "running",
      owner: { pid: legacy.child.pid!, instanceId: "legacy-process-token" }, retry: { text: "Continue" } };
    await writeFixture(f.root, saved);
    expect(await observer.call({ action: "recover", sessionId })).toEqual(saved);
    expect(await observer.call({ action: "cancel", sessionId })).toBeNull();
    await prepare(observer, "new");
    await expect(observer.call({ action: "admit", requestId: "new" }))
      .rejects.toMatchObject({ code: "CHAT_REQUEST_ALREADY_RUNNING", modelCalls: 0 });
    await stop(legacy.child);
    expect(await observer.call({ action: "recover", sessionId })).toMatchObject({
      status: "failed", error: { code: "CHAT_REQUEST_INTERRUPTED" },
    });
  }, 60_000);

  it("releases tentative ownership after pure validation throws", async () => {
    const f = await fixture(), [rejected, next] = await Promise.all([worker(f.root), worker(f.root)]);
    await prepare(rejected, "rejected");
    await expect(rejected.call({ action: "admit", requestId: "rejected", failValidation: true }))
      .rejects.toMatchObject({ message: "fixture validation failure", validateCalls: 1, modelCalls: 0 });
    expect(await f.store.load(sessionId)).toBeNull();
    const admitted = await admit(next, "next");
    expect(await f.store.load(sessionId)).toEqual(admitted);
  }, 60_000);

  it("cleans its temporary and releases tentative locks after a real rename failure", async () => {
    const f = await fixture(), [rejected, next] = await Promise.all([worker(f.root), worker(f.root)]);
    await prepare(rejected, "rename-failure");
    await rejected.call({ action: "pauseNextWrite" });
    const failed = rejected.call({ action: "admit", requestId: "rename-failure" })
      .then(() => { throw new Error("Admission unexpectedly succeeded"); }, error => error as NodeJS.ErrnoException);
    await rejected.waitForWrite();
    // The read saw an empty slot. Make its destination a directory only after
    // the real temporary write, so the real rename syscall must fail.
    try { await mkdir(snapshotPath(f.root)); }
    finally { await rejected.call({ action: "resumeWrite" }); }
    expect(["EISDIR", "EPERM", "EEXIST", "ENOTEMPTY"]).toContain((await failed).code);
    expect(await readdir(join(f.root, ".inkos", "chat-requests")))
      .toEqual([`${encodeURIComponent(sessionId)}.json`]);
    await rm(snapshotPath(f.root), { recursive: true });
    const admitted = await admit(next, "after-rename-failure");
    expect(await f.store.load(sessionId)).toEqual(admitted);
  }, 60_000);

  it("does not re-create a deleted slot from an admitted update or closed-token replace", async () => {
    const f = await fixture(), [owner, deleter] = await Promise.all([worker(f.root), worker(f.root)]);
    await admit(owner, "deleted");
    await deleter.call({ action: "delete", sessionId });
    await owner.call({ action: "save", requestId: "deleted", changes: { status: "completed" } });
    expect(await f.store.load(sessionId)).toBeNull();
    await owner.call({ action: "release", requestId: "deleted" });
    // The contract permits rejection or a no-op for a closed-token replace.
    await owner.call({ action: "save", requestId: "deleted", mode: "replace", changes: { status: "running" } })
      .catch(() => undefined);
    expect(await f.store.load(sessionId)).toBeNull();
  }, 60_000);

  it("does not bind one owner to two sessions", async () => {
    const f = await fixture(), owner = await worker(f.root);
    const admitted = await admit(owner, "request");
    await expect(owner.call({ action: "admitOtherSession", requestId: "request",
      sessionId: "other-session", otherRequestId: "other-request" })).rejects.toBeInstanceOf(Error);
    expect(await f.store.load("other-session")).toBeNull();
    expect(await f.store.load(sessionId)).toEqual(admitted);
  }, 60_000);

  it("waits asynchronously for another process's state lock and keeps load free of recovery", async () => {
    const f = await fixture(), holder = await worker(f.root);
    const orphan: StudioChatRequestSnapshot = { sessionId, requestId: "orphan", startedAt: 1, status: "running" };
    await writeFixture(f.root, orphan);
    await holder.call({ action: "holdState", sessionId });
    let loaded = false;
    const loading = f.store.load(sessionId).then(snapshot => { loaded = true; return snapshot; });
    try {
      await new Promise(resolve => setTimeout(resolve, 25));
      expect(loaded).toBe(false);
    } finally { await holder.call({ action: "releaseState" }); }
    expect(await loading).toEqual(orphan);
    expect(JSON.parse(await readFile(snapshotPath(f.root), "utf8"))).toEqual(orphan);
  }, 60_000);
});
