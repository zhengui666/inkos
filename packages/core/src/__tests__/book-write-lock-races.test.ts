import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { StateManager } from "../state/manager.js";

const roots: string[] = [], children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) await stop(child);
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "inkos-book-lock-race-")); roots.push(root);
  const state = new StateManager(root), path = join(state.bookDir("novel"), ".write.lock");
  await mkdir(state.bookDir("novel"), { recursive: true });
  return { root, state, path };
}
async function deadLock(path: string) {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" }); await once(child, "exit");
  await writeFile(path, JSON.stringify({ version: 1, pid: child.pid, token: "dead-owner", startedAt: 1, heartbeatAt: 1 }));
}
function worker(root: string, mode: "normal" | "reclaim" | "release" | "kill-in-guard") {
  const sourceRoot = new URL("../", import.meta.url).href;
  const child = spawn(process.execPath, ["--experimental-transform-types", "--input-type=module", "-e", `
    import {registerHooks} from 'node:module';
    const sourceRoot=${JSON.stringify(sourceRoot)};
    registerHooks({resolve(specifier,context,next){return next(context.parentURL?.startsWith(sourceRoot) && specifier.startsWith('.') && specifier.endsWith('.js')?specifier.slice(0,-3)+'.ts':specifier,context);}});
    const {StateManager}=await import(sourceRoot+'state/manager.ts');
    const state=new StateManager(${JSON.stringify(root)}),mode=${JSON.stringify(mode)};
    const pause=ms=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms);
    if(mode==='reclaim'||mode==='kill-in-guard'){
      const remove=state.removeStaleLock.bind(state);
      state.removeStaleLock=path=>{
        if(mode==='kill-in-guard'){remove(path);process.send('stale-removed');pause(10000);}
        else{process.send('reclaim-paused');pause(500);remove(path);}
      };
    }
    let release;
    try{release=await state.acquireBookLock('novel');}
    catch(error){if(error.code!=='BOOK_BUSY')throw error;process.send('blocked');process.disconnect();}
    if(release){
      process.send('owned');await new Promise(done=>process.once('message',done));
      if(mode==='release'){
        const read=state.readLockSnapshot.bind(state);let first=true;
        state.readLockSnapshot=path=>{const result=read(path);if(first){first=false;process.send('release-paused');pause(500);}return result;};
      }
      await release();process.send('released');process.disconnect();
    }
  `], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  children.push(child);
  const history: string[] = [], waiters: Array<(value: string) => void> = [];
  let errors = "";
  child.stderr!.on("data", chunk => { errors += chunk; });
  child.on("message", value => { const waiter = waiters.shift(); if (waiter) waiter(String(value)); else history.push(String(value)); });
  const next = async () => history.length ? history.shift()! : new Promise<string>((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) { reject(new Error(`Worker exited: ${errors}`)); return; }
    waiters.push(resolve);
    child.once("exit", () => { if (waiters.includes(resolve)) reject(new Error(`Worker exited: ${errors}`)); });
  });
  return { child, next };
}
async function releaseWorker(value: ReturnType<typeof worker>) {
  value.child.send("release"); expect(await value.next()).toBe("released");
}

describe("atomic book lock lifecycle", () => {
  it("serializes dead-owner recovery with a competing claim across OS processes", async () => {
    const f = await fixture(); await deadLock(f.path);
    const first = worker(f.root, "reclaim"); expect(await first.next()).toBe("reclaim-paused");
    const second = worker(f.root, "normal");
    expect(await first.next()).toBe("owned");
    expect(await second.next()).toBe("blocked");
    expect(JSON.parse(await readFile(f.path, "utf8")).pid).toBe(first.child.pid);
    await expect(f.state.acquireBookLock("novel")).rejects.toMatchObject({ code: "BOOK_BUSY" });
    await releaseWorker(first);
    const release = await f.state.acquireBookLock("novel"); await release();
  });

  it("cannot delete a replacement owner while releasing the previous token", async () => {
    const f = await fixture(), first = worker(f.root, "release"); expect(await first.next()).toBe("owned");
    first.child.send("release"); expect(await first.next()).toBe("release-paused");
    const second = worker(f.root, "normal");
    expect(await first.next()).toBe("released"); expect(await second.next()).toBe("owned");
    const replacement = await readFile(f.path, "utf8");
    expect(JSON.parse(replacement).pid).toBe(second.child.pid);
    await expect(f.state.acquireBookLock("novel")).rejects.toMatchObject({ code: "BOOK_BUSY" });
    expect(await readFile(f.path, "utf8")).toBe(replacement);
    await releaseWorker(second);
  });

  it("releases the coordination transaction when a reclaimer dies between unlink and create", async () => {
    const f = await fixture(); await deadLock(f.path);
    const first = worker(f.root, "kill-in-guard"); expect(await first.next()).toBe("stale-removed");
    await stop(first.child);
    const release = await f.state.acquireBookLock("novel");
    try { expect(JSON.parse(await readFile(f.path, "utf8")).pid).toBe(process.pid); }
    finally { await release(); }
  });
});
