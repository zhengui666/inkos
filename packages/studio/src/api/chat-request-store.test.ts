import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ChatRequestStore } from "./chat-request-store.js";

afterEach(() => vi.restoreAllMocks());
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
