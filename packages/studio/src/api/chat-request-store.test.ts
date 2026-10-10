import { afterEach, expect, it, vi } from "vitest";
import filesystem from "node:fs/promises";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ChatRequestStore } from "./chat-request-store.js";

afterEach(() => { vi.restoreAllMocks(); syncBuiltinESMExports(); });
async function fixture(run: (store: ChatRequestStore, peer: ChatRequestStore) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "inkos-chat-owner-"));
  try { await run(new ChatRequestStore(root), new ChatRequestStore(root)); }
  finally { await rm(root, { recursive: true, force: true }); }
}
const running = { sessionId: "session", requestId: "request", startedAt: 1, status: "running" as const,
  retry: { text: "Continue" } };

it("persists orphan recovery once, retaining saved retry input", () => fixture(async (store, peer) => {
  await store.save(running);
  const recovered = await peer.recover("session");
  expect(recovered).toMatchObject({ status: "failed", error: { code: "CHAT_REQUEST_INTERRUPTED" }, retry: running.retry });
  expect(await store.load("session")).toEqual(recovered);
  expect(await peer.recover("session")).toEqual(recovered);
}));

it("does not recover a live owner in another server instance", () => fixture(async (store, peer) => {
  const owner = store.createOwner();
  try {
    await store.save({ ...running, owner });
    expect((await peer.recover("session"))?.status).toBe("running");
    expect(await peer.cancel("session")).toBeNull();
  } finally { store.releaseOwner(owner); }
  expect((await peer.recover("session"))?.status).toBe("failed");
}));

it("conservatively retains a live foreign-process owner", () => fixture(async (store, peer) => {
  vi.spyOn(process, "kill").mockReturnValue(true);
  await store.save({ ...running, owner: { pid: process.pid + 1, instanceId: "other-process" } });
  expect((await peer.recover("session"))?.status).toBe("running");
  expect(await peer.cancel("session")).toBeNull();
}));

it("persists cancellation before abort and never resurrects it after restart or late success", () => fixture(async (store, peer) => {
  const owner = store.createOwner();
  await store.save({ ...running, owner });
  const cancelled = await store.cancel("session", "request");
  expect(cancelled).toMatchObject({ status: "running", cancelRequestedAt: expect.any(Number) });
  await store.save({ ...running, owner }, "update");
  expect((await store.load("session"))?.cancelRequestedAt).toBe(cancelled?.cancelRequestedAt);
  store.releaseOwner(owner);
  expect(await peer.recover("session")).toMatchObject({ status: "cancelled", retry: undefined });
  await store.save({ ...running, owner, status: "completed" }, "update");
  expect((await peer.load("session"))?.status).toBe("cancelled");
}));

it("does not let a stale finalizer overwrite a newer request", () => fixture(async (store, peer) => {
  await store.save(running);
  await peer.save({ ...running, requestId: "new" });
  await store.save({ ...running, status: "failed" }, "update");
  expect((await peer.load("session"))?.requestId).toBe("new");
}));

it("does not claim a session until a pending owner is admitted", () => fixture(async (store, peer) => {
  const pending = store.createOwner(), owner = peer.createOwner();
  try {
    expect(pending.instanceId).toMatch(/^sqlite-lock-v1:/);
    await peer.admit({ ...running, owner });
    await expect(store.admit({ ...running, requestId: "other", owner: pending })).rejects.toMatchObject({ code: "CHAT_REQUEST_ALREADY_RUNNING" });
  } finally { store.releaseOwner(pending); peer.releaseOwner(owner); }
}));

it("releases a tentative owner after validation throws without occupying the slot", () => fixture(async (store, peer) => {
  const owner = store.createOwner(), winner = peer.createOwner();
  try {
    await expect(store.admit({ ...running, owner }, () => { throw new Error("invalid retry"); })).rejects.toThrow("invalid retry");
    expect(await store.load("session")).toBeNull();
    await peer.admit({ ...running, owner: winner });
    expect((await store.load("session"))?.owner).toEqual(winner);
  } finally { store.releaseOwner(owner); peer.releaseOwner(winner); }
}));

it.each(["sessionId", "requestId", "owner"] as const)("rejects validation that changes %s and releases both locks", field => fixture(async (store, peer) => {
  const owner = store.createOwner(), winner = peer.createOwner();
  try {
    const input = { ...running, owner };
    await expect(store.admit(input, () => ({ ...input, [field]: field === "owner" ? winner : "changed" }))).rejects.toThrow("identity");
    expect(await store.load("session")).toBeNull();
    expect(await store.load("changed")).toBeNull();
    await peer.admit({ ...running, owner: winner });
  } finally { store.releaseOwner(owner); peer.releaseOwner(winner); }
}));

it("does not replay an old request ID after its owner releases", () => fixture(async (store, peer) => {
  const owner = store.createOwner(), next = peer.createOwner();
  await store.admit({ ...running, owner });
  await store.save({ ...running, owner, status: "completed", completedAt: 2 }, "update");
  store.releaseOwner(owner);
  try {
    await expect(peer.admit({ ...running, owner: next })).rejects.toMatchObject({ code: "CHAT_REQUEST_ID_REUSED" });
    await peer.admit({ ...running, requestId: "new", owner: next });
  } finally { peer.releaseOwner(next); }
}));

it("keeps the first cancellation intent through progress and clears retry/error on finalization", () => fixture(async (store, peer) => {
  const owner = store.createOwner();
  try {
    await store.admit({ ...running, owner });
    const now = vi.spyOn(Date, "now").mockReturnValue(100);
    const first = await peer.cancel("session", "request");
    now.mockReturnValue(200);
    expect((await peer.cancel("session", "request"))?.cancelRequestedAt).toBe(100);
    await store.save({ ...running, owner, cancelRequestedAt: 999 }, "update");
    expect(await peer.load("session")).toMatchObject({ status: "running", cancelRequestedAt: first?.cancelRequestedAt });
    await store.save({ ...running, owner, status: "failed", completedAt: 300, error: { code: "LATE", message: "late" } }, "update");
    const saved = await peer.load("session");
    expect(saved).toMatchObject({ status: "cancelled", cancelRequestedAt: 100, completedAt: 300 });
    expect(saved?.retry).toBeUndefined();
    expect(saved?.error).toBeUndefined();
    await store.save({ ...running, owner, status: "completed", completedAt: 400 }, "update");
    expect((await peer.load("session"))?.completedAt).toBe(300);
  } finally { store.releaseOwner(owner); }
}));

it.each(["completed", "failed"] as const)("does not regress a %s update back to running", status => fixture(async (store, peer) => {
  const owner = store.createOwner();
  try {
    await store.admit({ ...running, owner });
    await store.save({ ...running, owner, status, completedAt: 2 }, "update");
    await store.save({ ...running, owner }, "update");
    expect(await peer.load("session")).toMatchObject({ status, completedAt: 2 });
  } finally { store.releaseOwner(owner); }
}));

it("requires the admitted local token for updates and refuses closed-token resurrection", () => fixture(async (store, peer) => {
  const owner = store.createOwner(), other = peer.createOwner();
  try {
    await store.admit({ ...running, owner });
    await peer.save({ ...running, owner, status: "completed" }, "update");
    await peer.save({ ...running, owner: other, status: "failed" }, "update");
    expect((await peer.load("session"))?.status).toBe("running");
    await expect(peer.save({ ...running, requestId: "legacy" })).rejects.toMatchObject({ code: "CHAT_REQUEST_ALREADY_RUNNING" });
    store.releaseOwner(owner);
    store.releaseOwner(owner);
    await store.save({ ...running, owner, status: "completed" }, "update");
    expect((await peer.load("session"))?.status).toBe("running");
    await peer.delete("session");
    await store.save({ ...running, owner }, "update");
    await store.save({ ...running, owner });
    expect(await peer.load("session")).toBeNull();
  } finally { store.releaseOwner(owner); peer.releaseOwner(other); }
}));

it("cannot bind a token from another store or to a second session", () => fixture(async (store, peer) => {
  const owner = store.createOwner(), other = peer.createOwner();
  try {
    await store.admit({ ...running, owner });
    await expect(store.admit({ ...running, sessionId: "second", owner })).rejects.toThrow("fresh local owner");
    await expect(peer.admit({ ...running, sessionId: "second", owner })).rejects.toThrow("fresh local owner");
    await peer.admit({ ...running, sessionId: "second", owner: other });
  } finally { store.releaseOwner(owner); peer.releaseOwner(other); }
}));

it("cleans its temporary and releases tentative ownership when admission rename fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "inkos-chat-rename-"));
  const store = new ChatRequestStore(root), peer = new ChatRequestStore(root);
  const owner = store.createOwner(), winner = peer.createOwner();
  try {
    const rename = vi.spyOn(filesystem, "rename").mockRejectedValueOnce(Object.assign(new Error("fixture rename failure"), { code: "EIO" }));
    syncBuiltinESMExports();
    await expect(store.admit({ ...running, owner })).rejects.toThrow("fixture rename failure");
    expect(await readdir(join(root, ".inkos", "chat-requests"))).toEqual([]);
    expect(await store.load("session")).toBeNull();
    rename.mockRestore();
    syncBuiltinESMExports();
    await peer.admit({ ...running, owner: winner });
    expect((await store.load("session"))?.owner).toEqual(winner);
  } finally { store.releaseOwner(owner); peer.releaseOwner(winner); await rm(root, { recursive: true, force: true }); }
});

it("retains the durable snapshot and ownership when a final save rename fails", () => fixture(async (store, peer) => {
  const owner = store.createOwner(), contender = peer.createOwner();
  try {
    const admitted = await store.admit({ ...running, owner });
    const rename = vi.spyOn(filesystem, "rename").mockRejectedValueOnce(Object.assign(new Error("fixture final rename failure"), { code: "EIO" }));
    syncBuiltinESMExports();
    await expect(store.save({ ...running, owner, status: "completed" }, "update")).rejects.toThrow("fixture final rename failure");
    rename.mockRestore();
    syncBuiltinESMExports();
    expect(await peer.load("session")).toEqual(admitted);
    await expect(peer.admit({ ...running, requestId: "new", owner: contender })).rejects.toMatchObject({ code: "CHAT_REQUEST_ALREADY_RUNNING" });
    await store.save({ ...running, owner, status: "completed" }, "update");
    expect((await peer.load("session"))?.status).toBe("completed");
  } finally { store.releaseOwner(owner); peer.releaseOwner(contender); }
}));

it("treats EPERM as a live legacy owner", () => fixture(async (store, peer) => {
  vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("no permission"), { code: "EPERM" }); });
  const saved = { ...running, owner: { pid: process.pid + 1, instanceId: "legacy-permission" } };
  await store.save(saved);
  expect(await peer.recover("session")).toEqual(saved);
  expect(await peer.cancel("session")).toBeNull();
}));

it("releases admission ownership after a corrupt snapshot read fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "inkos-chat-corrupt-"));
  const store = new ChatRequestStore(root), peer = new ChatRequestStore(root);
  const owner = store.createOwner(), next = peer.createOwner();
  try {
    await filesystem.mkdir(join(root, ".inkos", "chat-requests"));
    const path = join(root, ".inkos", "chat-requests", "session.json");
    await filesystem.writeFile(path, "{", { mode: 0o600 });
    await expect(store.admit({ ...running, owner })).rejects.toThrow();
    await filesystem.rm(path);
    await peer.admit({ ...running, owner: next });
    expect((await store.load("session"))?.owner).toEqual(next);
  } finally { store.releaseOwner(owner); peer.releaseOwner(next); await rm(root, { recursive: true, force: true }); }
});
