import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createOwnershipLockSpace, SQLITE_OWNER_TOKEN_PREFIX } from "@actalk/inkos-core";
import {
  deleteStudioTaskSnapshot,
  loadStudioTaskSnapshot,
  hasStudioTaskOwner,
  tryAcquireStudioTaskOwnerGuard,
  recoverStudioTaskSnapshot,
  reserveStudioTaskExecution,
  saveStudioTaskSnapshot,
  studioTaskSnapshotPath,
  type StudioTaskLease,
  type StudioTaskSnapshot,
} from "./task-store.js";

describe("Studio task snapshots", () => {
  let root: string;
  let leases: StudioTaskLease[];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-studio-task-"));
    leases = [];
  });

  afterEach(async () => {
    await Promise.allSettled(leases.map((lease) => lease.release()));
    await rm(root, { recursive: true, force: true });
  });

  function snapshot(sessionId = "owned-session", executionId = "owned-task"): StudioTaskSnapshot {
    return {
      version: 1,
      sessionId,
      requestedIntent: "short_run",
      updatedAt: 20,
      execution: {
        id: executionId,
        tool: "short_fiction_run",
        label: "生成短篇",
        status: "running",
        startedAt: 10,
        logs: ["正在生成大纲"],
        details: { phase: "outline" },
      },
    };
  }

  async function reserve(sessionId = "owned-session", executionId = "owned-task"): Promise<StudioTaskLease> {
    const lease = await reserveStudioTaskExecution(root, sessionId, executionId);
    expect(lease).not.toBeNull();
    if (!lease) throw new Error("Expected task lease.");
    leases.push(lease);
    return lease;
  }

  async function writeFixture(value: StudioTaskSnapshot): Promise<string> {
    await mkdir(join(root, ".inkos", "tasks"), { recursive: true });
    const text = `${JSON.stringify(value, null, 2)}\n`;
    await writeFile(studioTaskSnapshotPath(root, value.sessionId), text);
    return text;
  }

  it("probes owner occupancy without waiting or creating a task snapshot", async () => {
    expect(hasStudioTaskOwner(root, "owned-session")).toBe(false);
    const lease = await reserve();
    expect(hasStudioTaskOwner(root, "owned-session")).toBe(true);
    expect(hasStudioTaskOwner(root, "other-session")).toBe(false);
    expect(await loadStudioTaskSnapshot(root, "owned-session")).toBeNull();
    const alias = join(root, "alias");
    await symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
    expect(hasStudioTaskOwner(alias, "owned-session")).toBe(true);
    await lease.release();
    expect(hasStudioTaskOwner(root, "owned-session")).toBe(false);
    expect(hasStudioTaskOwner(alias, "owned-session")).toBe(false);
    expect(await loadStudioTaskSnapshot(root, "owned-session")).toBeNull();
    await reserve("owned-session", "next-owner");
  });

  it("checks owner occupancy synchronously while the state lock is held", async () => {
    const space = createOwnershipLockSpace(join(root, ".inkos", "harness.sqlite"));
    const state = space.tryAcquire("studio-task-state", "owned-session")!;
    try {
      expect(hasStudioTaskOwner(root, "owned-session")).toBe(false);
      const owner = tryAcquireStudioTaskOwnerGuard(root, "owned-session")!;
      expect(owner).toBeDefined();
      try {
        expect(hasStudioTaskOwner(root, "owned-session")).toBe(true);
        expect(tryAcquireStudioTaskOwnerGuard(root, "owned-session")).toBeUndefined();
      } finally { owner.release(); }
      expect(hasStudioTaskOwner(root, "owned-session")).toBe(false);
    } finally { state.release(); }
    expect(await loadStudioTaskSnapshot(root, "owned-session")).toBeNull();
  });

  it("does not mutate a legacy running snapshot while probing ownership", async () => {
    const original = await writeFixture(snapshot());
    expect(hasStudioTaskOwner(root, "owned-session")).toBe(false);
    expect(await readFile(studioTaskSnapshotPath(root, "owned-session"), "utf8")).toBe(original);
    expect(await reserveStudioTaskExecution(root, "owned-session", "not-authorized")).toBeNull();
  });

  it("persists a running task so a refreshed Studio session can restore it", async () => {
    await saveStudioTaskSnapshot(root, {
      version: 1,
      sessionId: "session-1",
      sourceRequestId: "request-1",
      requestedIntent: "short_run",
      updatedAt: 20,
      execution: {
        id: "task-1",
        tool: "short_fiction_run",
        label: "生成短篇",
        status: "running",
        startedAt: 10,
        logs: ["正在生成大纲"],
      },
    });

    await expect(loadStudioTaskSnapshot(root, "session-1")).resolves.toEqual({
      version: 1,
      sessionId: "session-1",
      sourceRequestId: "request-1",
      requestedIntent: "short_run",
      updatedAt: 20,
      execution: {
        id: "task-1",
        tool: "short_fiction_run",
        label: "生成短篇",
        status: "running",
        startedAt: 10,
        logs: ["正在生成大纲"],
      },
    });
  });

  it("serializes overlapping progress writes and keeps the newest snapshot", async () => {
    const base = {
      version: 1 as const,
      sessionId: "session-2",
      requestedIntent: "script_create" as const,
      execution: {
        id: "task-2",
        tool: "script_create",
        label: "生成剧本",
        status: "running" as const,
        startedAt: 10,
      },
    };

    await Promise.all([
      saveStudioTaskSnapshot(root, { ...base, updatedAt: 20, execution: { ...base.execution, logs: ["第一步"] } }),
      saveStudioTaskSnapshot(root, { ...base, updatedAt: 30, execution: { ...base.execution, logs: ["第一步", "第二步"] } }),
    ]);

    await expect(loadStudioTaskSnapshot(root, "session-2")).resolves.toMatchObject({
      updatedAt: 30,
      execution: { logs: ["第一步", "第二步"] },
    });
  });

  it("surfaces a corrupt snapshot instead of silently dropping task state", async () => {
    const path = studioTaskSnapshotPath(root, "session-3");
    await saveStudioTaskSnapshot(root, {
      version: 1,
      sessionId: "session-3",
      requestedIntent: "short_run",
      updatedAt: 20,
      execution: {
        id: "task-3",
        tool: "short_fiction_run",
        label: "生成短篇",
        status: "running",
        startedAt: 10,
      },
    });
    await writeFile(path, "{broken", "utf-8");

    await expect(loadStudioTaskSnapshot(root, "session-3")).rejects.toThrow();
    await expect(readFile(path, "utf-8")).resolves.toBe("{broken");
  });

  it("holds admission before the first snapshot and permits different sessions", async () => {
    const first = await reserve();
    await expect(reserveStudioTaskExecution(root, first.sessionId, "duplicate")).resolves.toBeNull();
    await reserve("another-session", "another-task");
    await saveStudioTaskSnapshot(root, snapshot(first.sessionId, "unowned-write"));
    await expect(loadStudioTaskSnapshot(root, first.sessionId)).resolves.toBeNull();
    await first.release();
    await reserve(first.sessionId, "successor");
  });

  it("freezes queued input and drains admitted writes when release begins", async () => {
    const lease = await reserve();
    const space = createOwnershipLockSpace(join(root, ".inkos", "harness.sqlite"));
    const state = space.tryAcquire("studio-task-state", lease.sessionId)!;
    expect(state).toBeDefined();
    const input = { ...snapshot(), execution: { ...snapshot().execution, logs: ["captured"] } };
    const saving = saveStudioTaskSnapshot(root, input);
    input.execution.logs.push("mutated after save");
    const releasing = lease.release();
    const rejectedProgress = saveStudioTaskSnapshot(root, {
      ...snapshot(), execution: { ...snapshot().execution, logs: ["after closing"] },
    });
    state.release();
    await Promise.all([saving, releasing, rejectedProgress]);

    await expect(loadStudioTaskSnapshot(root, lease.sessionId)).resolves.toMatchObject({
      owner: lease.owner,
      execution: { status: "error", logs: ["captured"], details: { phase: "outline" } },
    });
    await reserve(lease.sessionId, "successor");
    const successor = await reserveStudioTaskExecution(root, lease.sessionId, "other-successor");
    expect(successor).toBeNull();
  });

  it("queues writes by canonical lock key across symlink aliases without using the clock as order", async () => {
    const alias = join(root, "project-alias");
    await symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
    const lease = await reserve();
    const state = createOwnershipLockSpace(join(root, ".inkos", "harness.sqlite"))
      .tryAcquire("studio-task-state", lease.sessionId)!;
    const first = saveStudioTaskSnapshot(root, { ...snapshot(), updatedAt: 100 });
    const second = saveStudioTaskSnapshot(alias, {
      ...snapshot(), updatedAt: 1, execution: { ...snapshot().execution, logs: ["second alias write"] },
    });
    state.release();
    await Promise.all([first, second]);
    await expect(loadStudioTaskSnapshot(root, lease.sessionId)).resolves.toMatchObject({
      updatedAt: 1, owner: lease.owner, execution: { logs: ["second alias write"] },
    });
  });

  it("allows completed tool stages to continue running within the same lease", async () => {
    const lease = await reserve();
    await saveStudioTaskSnapshot(root, {
      ...snapshot(), execution: { ...snapshot().execution, status: "completed", completedAt: 30 },
    });
    await saveStudioTaskSnapshot(root, {
      ...snapshot(), execution: { ...snapshot().execution, status: "running", logs: ["continuation"] },
    });
    await expect(loadStudioTaskSnapshot(root, lease.sessionId)).resolves.toMatchObject({
      owner: lease.owner, execution: { status: "running", logs: ["continuation"] },
    });
  });

  it("replaces a terminal task with a new lease and fences the old finalizer", async () => {
    const previous = await reserve();
    await saveStudioTaskSnapshot(root, {
      ...snapshot(), execution: { ...snapshot().execution, status: "completed", result: "first result" },
    });
    await previous.release();
    const next = await reserve(previous.sessionId, "successor");
    await saveStudioTaskSnapshot(root, snapshot(next.sessionId, next.executionId));
    await saveStudioTaskSnapshot(root, {
      ...snapshot(), execution: { ...snapshot().execution, status: "error", error: "late finalizer" },
    });
    await previous.release();
    await expect(loadStudioTaskSnapshot(root, next.sessionId)).resolves.toMatchObject({
      owner: next.owner, execution: { id: next.executionId, status: "running" },
    });
  });

  it("keeps the owner until release after deletion and never revives a late callback", async () => {
    const lease = await reserve();
    await saveStudioTaskSnapshot(root, snapshot());
    await deleteStudioTaskSnapshot(root, lease.sessionId);
    await saveStudioTaskSnapshot(root, snapshot());
    await expect(loadStudioTaskSnapshot(root, lease.sessionId)).resolves.toBeNull();
    await expect(reserveStudioTaskExecution(root, lease.sessionId, "new-task")).resolves.toBeNull();
    await lease.release();
    await saveStudioTaskSnapshot(root, snapshot());
    await expect(loadStudioTaskSnapshot(root, lease.sessionId)).resolves.toBeNull();
    const next = await reserve(lease.sessionId, "new-task");
    await saveStudioTaskSnapshot(root, snapshot(next.sessionId, next.executionId));
    await expect(loadStudioTaskSnapshot(root, lease.sessionId)).resolves.toMatchObject({ owner: next.owner });
  });

  it("fences the first snapshot when deletion queues immediately behind reservation", async () => {
    const admission = reserveStudioTaskExecution(root, "owned-session", "owned-task");
    const deletion = deleteStudioTaskSnapshot(root, "owned-session");
    const [lease] = await Promise.all([admission, deletion]);
    expect(lease).not.toBeNull();
    if (!lease) throw new Error("Expected task lease.");
    leases.push(lease);
    await saveStudioTaskSnapshot(root, snapshot());
    await expect(loadStudioTaskSnapshot(root, lease.sessionId)).resolves.toBeNull();
    await lease.release();
    await saveStudioTaskSnapshot(root, snapshot());
    await expect(loadStudioTaskSnapshot(root, lease.sessionId)).resolves.toBeNull();
  });

  it("rejects forged owners and unleased writes against a persisted SQLite owner", async () => {
    const lease = await reserve();
    await saveStudioTaskSnapshot(root, snapshot());
    await saveStudioTaskSnapshot(root, {
      ...snapshot(lease.sessionId, "forged-task"), owner: lease.owner,
    });
    await lease.release();
    await saveStudioTaskSnapshot(root, {
      ...snapshot(), execution: { ...snapshot().execution, status: "running" },
    });
    await expect(loadStudioTaskSnapshot(root, lease.sessionId)).resolves.toMatchObject({
      owner: lease.owner, execution: { id: lease.executionId, status: "error" },
    });
  });

  it("recovers a dead SQLite owner once even when its PID currently exists", async () => {
    const fixture = {
      ...snapshot(), owner: { pid: process.pid, token: `${SQLITE_OWNER_TOKEN_PREFIX}dead-owner` },
    };
    await writeFixture(fixture);
    const recovered = await recoverStudioTaskSnapshot(root, fixture.sessionId, "interrupted fixture");
    expect(recovered).toMatchObject({
      owner: fixture.owner,
      execution: {
        id: fixture.execution.id, status: "error", error: "interrupted fixture",
        logs: fixture.execution.logs, details: fixture.execution.details,
      },
    });
    expect(recovered?.execution.completedAt).toBeTypeOf("number");
    const bytes = await readFile(studioTaskSnapshotPath(root, fixture.sessionId), "utf-8");
    await expect(recoverStudioTaskSnapshot(root, fixture.sessionId, "second error")).resolves.toEqual(recovered);
    await expect(readFile(studioTaskSnapshotPath(root, fixture.sessionId), "utf-8")).resolves.toBe(bytes);
    const lease = await reserve(fixture.sessionId, "successor");
    await saveStudioTaskSnapshot(root, snapshot(lease.sessionId, lease.executionId));
    await expect(loadStudioTaskSnapshot(root, lease.sessionId)).resolves.toMatchObject({ owner: lease.owner });
  });

  it("preserves an external live owner byte for byte and admits its successor after the lock is released", async () => {
    const fixture = {
      ...snapshot(), owner: { pid: process.pid, token: `${SQLITE_OWNER_TOKEN_PREFIX}external-owner` },
    };
    const original = await writeFixture(fixture);
    const handle = createOwnershipLockSpace(join(root, ".inkos", "harness.sqlite"))
      .tryAcquire("studio-task-owner", fixture.sessionId)!;
    try {
      await expect(recoverStudioTaskSnapshot(root, fixture.sessionId, "must not write")).resolves.toEqual(fixture);
      await expect(reserveStudioTaskExecution(root, fixture.sessionId, "successor")).resolves.toBeNull();
      await expect(readFile(studioTaskSnapshotPath(root, fixture.sessionId), "utf-8")).resolves.toBe(original);
    } finally {
      handle.release();
    }
    const lease = await reserve(fixture.sessionId, "successor");
    await expect(loadStudioTaskSnapshot(root, fixture.sessionId)).resolves.toMatchObject({
      execution: { id: fixture.execution.id, status: "error" },
    });
    await saveStudioTaskSnapshot(root, snapshot(lease.sessionId, lease.executionId));
    await expect(loadStudioTaskSnapshot(root, fixture.sessionId)).resolves.toMatchObject({ owner: lease.owner });
  });

  it("preserves ownerless legacy running tasks and protects unknown tokens whose PID is live", async () => {
    const fixture = snapshot();
    const original = await writeFixture(fixture);
    await expect(recoverStudioTaskSnapshot(root, fixture.sessionId, "must not migrate")).resolves.toEqual(fixture);
    await expect(reserveStudioTaskExecution(root, fixture.sessionId, "successor")).resolves.toBeNull();
    await expect(readFile(studioTaskSnapshotPath(root, fixture.sessionId), "utf-8")).resolves.toBe(original);

    const unknownOwner = { ...fixture, owner: { pid: process.pid, token: "legacy-owner-token" } };
    const unknownBytes = await writeFixture(unknownOwner);
    await expect(recoverStudioTaskSnapshot(root, fixture.sessionId, "must not migrate")).resolves.toEqual(unknownOwner);
    await expect(reserveStudioTaskExecution(root, fixture.sessionId, "successor")).resolves.toBeNull();
    await saveStudioTaskSnapshot(root, fixture);
    await expect(readFile(studioTaskSnapshotPath(root, fixture.sessionId), "utf-8")).resolves.toBe(unknownBytes);
  });

  it("probes ownership before recovering an unknown token with a dead legacy PID", async () => {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    const pid = child.pid!;
    await once(child, "exit");
    expect(() => process.kill(pid, 0)).toThrow();
    const fixture = { ...snapshot(), owner: { pid, token: "old-binary-owner" } };
    const original = await writeFixture(fixture);
    const handle = createOwnershipLockSpace(join(root, ".inkos", "harness.sqlite"))
      .tryAcquire("studio-task-owner", fixture.sessionId)!;
    try {
      await expect(recoverStudioTaskSnapshot(root, fixture.sessionId, "interrupted old owner")).resolves.toEqual(fixture);
      await expect(readFile(studioTaskSnapshotPath(root, fixture.sessionId), "utf-8")).resolves.toBe(original);
    } finally {
      handle.release();
    }
    await expect(recoverStudioTaskSnapshot(root, fixture.sessionId, "interrupted old owner")).resolves.toMatchObject({
      owner: fixture.owner, execution: { status: "error", error: "interrupted old owner" },
    });
  });

  it("waits for the state lock before reading an initially missing snapshot", async () => {
    const handle = createOwnershipLockSpace(join(root, ".inkos", "harness.sqlite"))
      .tryAcquire("studio-task-state", "owned-session")!;
    try {
      const reading = loadStudioTaskSnapshot(root, "owned-session");
      await writeFixture(snapshot());
      handle.release();
      await expect(reading).resolves.toEqual(snapshot());
    } finally {
      handle.release();
    }
  });

  it("releases ownership when a failed first snapshot also makes settlement fail", async () => {
    const lease = await reserve();
    const path = studioTaskSnapshotPath(root, lease.sessionId);
    await mkdir(join(root, ".inkos", "tasks"), { recursive: true });
    await writeFile(path, "{broken");
    await expect(saveStudioTaskSnapshot(root, snapshot())).rejects.toThrow();
    await expect(lease.release()).rejects.toThrow();
    const handle = createOwnershipLockSpace(join(root, ".inkos", "harness.sqlite"))
      .tryAcquire("studio-task-owner", lease.sessionId);
    expect(handle).toBeDefined();
    handle?.release();
    await unlink(path);
    await reserve(lease.sessionId, "successor");
  });

  it("releases a tentative owner when reservation rejects a corrupt snapshot", async () => {
    const path = studioTaskSnapshotPath(root, "owned-session");
    await mkdir(join(root, ".inkos", "tasks"), { recursive: true });
    await writeFile(path, "{broken");
    await expect(reserveStudioTaskExecution(root, "owned-session", "failed-reserve")).rejects.toThrow();
    const probe = createOwnershipLockSpace(join(root, ".inkos", "harness.sqlite"))
      .tryAcquire("studio-task-owner", "owned-session");
    expect(probe).toBeDefined();
    probe?.release();
    await unlink(path);
    await reserve("owned-session", "fresh-reserve");
  });

  it("preserves a more specific execution error during release settlement", async () => {
    const lease = await reserve();
    await saveStudioTaskSnapshot(root, {
      ...snapshot(), execution: { ...snapshot().execution, error: "tool supplied detail" },
    });
    await lease.release();
    await expect(loadStudioTaskSnapshot(root, lease.sessionId)).resolves.toMatchObject({
      execution: { status: "error", error: "tool supplied detail" },
    });
  });
});
