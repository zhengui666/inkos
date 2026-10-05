import { mkdtemp, readFile, writeFile, mkdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StateManager } from "../state/manager.js";
import { captureWorkSourceState } from "../harness/source-sync.js";
import { BOOK_LOCK_GUARD_FILE } from "../state/book-lock-guard.js";

const roots: string[] = [], children: ChildProcess[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const child of children.splice(0)) await stop(child);
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "inkos-book-lock-")); roots.push(root);
  const state = new StateManager(root), path = join(state.bookDir("novel"), ".write.lock");
  await mkdir(state.bookDir("novel"), { recursive: true });
  return { root, state, path };
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
}
async function owner(root: string, acquire = true) {
  // Execute the real source in a separate OS process. Resolve this project's
  // .js source imports to .ts; package dependencies keep their own resolution.
  const sourceRoot = new URL("../", import.meta.url).href;
  const child = spawn(process.execPath, ["--experimental-transform-types", "--input-type=module", "-e", `
    import { registerHooks } from 'node:module';
    const sourceRoot = ${JSON.stringify(sourceRoot)};
    registerHooks({resolve(specifier,context,next) {
      return next(context.parentURL?.startsWith(sourceRoot) && specifier.startsWith('.') && specifier.endsWith('.js')
        ? specifier.slice(0,-3)+'.ts' : specifier,context);
    }});
    const { StateManager } = await import(sourceRoot+'state/manager.ts');
    const realNow = Date.now;
    Date.now = () => realNow() - 240000;
    const release = ${acquire} ? await new StateManager(${JSON.stringify(root)}).acquireBookLock('novel') : async () => {};
    process.send('ready');
    await new Promise(done => process.once('message', done));
    await release(); process.disconnect();
  `], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  children.push(child);
  let errors = ""; child.stderr!.on("data", chunk => { errors += chunk; });
  const [message] = await Promise.race([
    once(child, "message"), once(child, "exit").then(([code]) => { throw new Error(`Owner exited early (${code}): ${errors}`); }),
  ]);
  expect(message).toBe("ready");
  return child;
}
async function releaseChild(child: ChildProcess) {
  const exited = once(child, "exit"); child.send("release");
  expect((await exited)[0]).toBe(0);
}

describe("shared book write ownership", () => {
  it("retains a real live writer with a four-minute-old heartbeat until it drains", async () => {
    const f = await fixture(), child = await owner(f.root);
    const before = await readFile(f.path, "utf8");
    expect(Date.now() - JSON.parse(before).heartbeatAt).toBeGreaterThan(180000);
    await expect(new StateManager(f.root).acquireBookLock("novel")).rejects.toMatchObject({ code: "BOOK_BUSY" });
    expect(await readFile(f.path, "utf8")).toBe(before);
    await releaseChild(child);
    const release = await f.state.acquireBookLock("novel"); await release();
  });

  it("recovers a demonstrably exited foreign owner", async () => {
    const f = await fixture(), child = await owner(f.root);
    const before = JSON.parse(await readFile(f.path, "utf8"));
    await stop(child);
    const release = await f.state.acquireBookLock("novel");
    try {
      const after = JSON.parse(await readFile(f.path, "utf8"));
      expect(after.pid).toBe(process.pid); expect(after.token).not.toBe(before.token);
    } finally { await release(); }
  });

  it("does not treat an old timestamp as evidence against a reused live PID", async () => {
    const f = await fixture(), unrelatedProcess = await owner(f.root, false);
    const raw = JSON.stringify({ version: 1, pid: unrelatedProcess.pid, token: "old-process-token", startedAt: 1, heartbeatAt: 1 });
    await writeFile(f.path, raw);
    await expect(f.state.acquireBookLock("novel")).rejects.toMatchObject({ code: "BOOK_BUSY" });
    expect(await readFile(f.path, "utf8")).toBe(raw);
    await releaseChild(unrelatedProcess);
    const release = await f.state.acquireBookLock("novel"); await release();
  });

  it("retains ownership when process liveness is denied rather than absent", async () => {
    const f = await fixture();
    const raw = JSON.stringify({ version: 1, pid: process.pid + 1, token: "permission-hidden-owner", startedAt: 1, heartbeatAt: 1 });
    await writeFile(f.path, raw);
    vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("permission denied"), { code: "EPERM" }); });
    await expect(f.state.acquireBookLock("novel")).rejects.toMatchObject({ code: "BOOK_BUSY" });
    expect(await readFile(f.path, "utf8")).toBe(raw);
  });

  it("recovers an abandoned same-process file but preserves an active owner", async () => {
    const f = await fixture();
    await writeFile(f.path, JSON.stringify({ version: 1, pid: process.pid, token: "abandoned-task", startedAt: 1, heartbeatAt: 1 }));
    const release = await f.state.acquireBookLock("novel");
    try { await expect(new StateManager(f.root).acquireBookLock("novel")).rejects.toMatchObject({ code: "BOOK_BUSY" }); }
    finally { await release(); }
  });

  it("recognizes the same live owner through a symlink or junction", async () => {
    const f = await fixture(), aliases = await mkdtemp(join(tmpdir(), "inkos-lock-alias-")); roots.push(aliases);
    const alias = join(aliases, "project"); await symlink(f.root, alias, process.platform === "win32" ? "junction" : "dir");
    const release = await f.state.acquireBookLock("novel"), before = await readFile(f.path, "utf8");
    try {
      await expect(new StateManager(alias).acquireBookLock("novel")).rejects.toMatchObject({ code: "BOOK_BUSY" });
      expect(await readFile(f.path, "utf8")).toBe(before);
    } finally { await release(); }
  });

  it("keeps the local owner reserved while a release retries", async () => {
    const f = await fixture(), release = await f.state.acquireBookLock("novel");
    vi.spyOn(f.state as unknown as { readLockSnapshot(path: string): unknown }, "readLockSnapshot")
      .mockImplementationOnce(() => { throw Object.assign(new Error("temporarily busy"), { code: "EBUSY" }); });
    const releasing = release();
    await expect(new StateManager(f.root).acquireBookLock("novel")).rejects.toMatchObject({ code: "BOOK_BUSY" });
    await releasing;
    const nextRelease = await f.state.acquireBookLock("novel"); await nextRelease();
  });

  it("keeps the coordination file stable and excludes it from source artifacts", async () => {
    const f = await fixture(), release = await f.state.acquireBookLock("novel");
    try { expect([...(await captureWorkSourceState(f.root, "novel")).keys()]).toEqual([]); }
    finally { await release(); }
    const guard = join(f.state.bookDir("novel"), BOOK_LOCK_GUARD_FILE);
    expect((await readFile(guard)).length).toBeGreaterThan(0);
    expect([...(await captureWorkSourceState(f.root, "novel")).keys()]).toEqual([]);
  });

  it.each([{}, { pid: 0 }, { pid: -1 }, { pid: 1.5 }])("retains ambiguous owner metadata %j", async metadata => {
    const f = await fixture();
    const raw = JSON.stringify({ version: 1, token: "unknown-owner", startedAt: 1, heartbeatAt: 1, ...metadata });
    await writeFile(f.path, raw);
    await expect(f.state.acquireBookLock("novel")).rejects.toMatchObject({ code: "BOOK_BUSY" });
    expect(await readFile(f.path, "utf8")).toBe(raw);
  });
});
