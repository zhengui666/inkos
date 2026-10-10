import { mkdir, readFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import type { RequestedIntent } from "@actalk/inkos-core";
import { commitAtomicFileSet, createOwnershipLockSpace, SQLITE_OWNER_TOKEN_PREFIX } from "@actalk/inkos-core";

export type StudioTaskExecutionStatus = "running" | "processing" | "completed" | "error";

export interface StudioTaskExecution {
  readonly id: string;
  readonly tool: string;
  readonly agent?: string;
  readonly label: string;
  readonly status: StudioTaskExecutionStatus;
  readonly args?: Record<string, unknown>;
  readonly result?: string;
  readonly details?: unknown;
  readonly error?: string;
  readonly stages?: ReadonlyArray<{
    readonly label: string;
    readonly status: "pending" | "active" | "completed";
  }>;
  readonly logs?: ReadonlyArray<string>;
  readonly startedAt: number;
  readonly completedAt?: number;
}

export interface StudioTaskSnapshot {
  readonly version: 1;
  readonly sessionId: string;
  readonly sourceRequestId?: string;
  readonly requestedIntent: RequestedIntent;
  readonly execution: StudioTaskExecution;
  readonly updatedAt: number;
  readonly owner?: { readonly pid: number; readonly token: string };
}

export interface StudioTaskLease {
  readonly sessionId: string;
  readonly executionId: string;
  readonly owner: { readonly pid: number; readonly token: string };
  release(): Promise<void>;
}

const TASKS_DIR = ".inkos/tasks";
const INTERRUPTED_ERROR = "Task interrupted because its execution owner stopped before completion.";
type LockSpace = ReturnType<typeof createOwnershipLockSpace>;
interface LocalLease extends StudioTaskLease {
  closing: boolean;
  deleted: boolean;
  hasWritten: boolean;
  readonly pendingWrites: Set<Promise<void>>;
}
const lockSpaces = new Map<string, LockSpace>();
const stateQueues = new Map<string, Promise<unknown>>();
const localLeases = new Map<string, LocalLease>();
// Keep only identities, rather than released handles, to fence late callbacks.
const closedExecutions = new Map<string, Set<string>>();

function taskLockSpace(projectRoot: string): LockSpace {
  const databasePath = join(projectRoot, ".inkos", "harness.sqlite");
  const path = resolve(databasePath);
  let space = lockSpaces.get(path);
  if (!space) {
    space = createOwnershipLockSpace(databasePath);
    lockSpaces.set(path, space);
  }
  return space;
}

function withTaskState<T>(space: LockSpace, sessionId: string, operation: () => Promise<T>): Promise<T> {
  const key = space.key("studio-task-state", sessionId);
  const previous = stateQueues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(() => space.withStateLock("studio-task-state", sessionId, operation));
  stateQueues.set(key, next);
  return next.finally(() => {
    if (stateQueues.get(key) === next) stateQueues.delete(key);
  });
}

function taskFileName(sessionId: string): string {
  return `${encodeURIComponent(sessionId)}.json`;
}

export function studioTaskSnapshotPath(projectRoot: string, sessionId: string): string {
  return join(projectRoot, TASKS_DIR, taskFileName(sessionId));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isExecutionStatus(value: unknown): value is StudioTaskExecutionStatus {
  return value === "running" || value === "processing" || value === "completed" || value === "error";
}

function parseStudioTaskSnapshot(value: unknown): StudioTaskSnapshot {
  if (!isRecord(value) || value.version !== 1) throw new Error("Invalid Studio task snapshot version.");
  if (typeof value.sessionId !== "string" || typeof value.requestedIntent !== "string") {
    throw new Error("Invalid Studio task snapshot identity.");
  }
  if (value.sourceRequestId !== undefined && typeof value.sourceRequestId !== "string") {
    throw new Error("Invalid Studio task sourceRequestId.");
  }
  if (typeof value.updatedAt !== "number") throw new Error("Invalid Studio task updatedAt.");
  if (value.owner !== undefined && (
    !isRecord(value.owner)
    || !Number.isInteger(value.owner.pid)
    || (value.owner.pid as number) <= 0
    || typeof value.owner.token !== "string"
  )) throw new Error("Invalid Studio task owner.");
  if (!isRecord(value.execution)) throw new Error("Invalid Studio task execution.");

  const execution = value.execution;
  if (
    typeof execution.id !== "string"
    || typeof execution.tool !== "string"
    || typeof execution.label !== "string"
    || !isExecutionStatus(execution.status)
    || typeof execution.startedAt !== "number"
  ) throw new Error("Invalid Studio task execution identity.");
  if (execution.logs !== undefined && (!Array.isArray(execution.logs) || execution.logs.some((log) => typeof log !== "string"))) {
    throw new Error("Invalid Studio task execution logs.");
  }

  return value as unknown as StudioTaskSnapshot;
}

function isRunning(snapshot: StudioTaskSnapshot): boolean {
  return snapshot.execution.status === "running" || snapshot.execution.status === "processing";
}

function hasSqliteOwner(snapshot: StudioTaskSnapshot): boolean {
  return !!snapshot.owner?.token.startsWith(SQLITE_OWNER_TOKEN_PREFIX);
}

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

function interruptSnapshot(snapshot: StudioTaskSnapshot, error: string): StudioTaskSnapshot {
  const now = Date.now();
  return {
    ...snapshot,
    updatedAt: now,
    execution: {
      ...snapshot.execution,
      status: "error",
      error: snapshot.execution.error ?? error,
      completedAt: now,
    },
  };
}

async function readSnapshot(projectRoot: string, sessionId: string): Promise<StudioTaskSnapshot | null> {
  try {
    const snapshot = parseStudioTaskSnapshot(JSON.parse(await readFile(studioTaskSnapshotPath(projectRoot, sessionId), "utf-8")));
    if (snapshot.sessionId !== sessionId) throw new Error("Invalid Studio task snapshot sessionId.");
    return snapshot;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeSnapshot(projectRoot: string, snapshot: StudioTaskSnapshot): Promise<void> {
  await mkdir(join(projectRoot, TASKS_DIR), { recursive: true });
  await commitAtomicFileSet({
    rootDir: projectRoot,
    writes: [{
      relativePath: join(TASKS_DIR, taskFileName(snapshot.sessionId)),
      content: `${JSON.stringify(snapshot, null, 2)}\n`,
    }],
  });
}

/** Ownership only: a chat tool guard never creates or changes a task snapshot. */
export interface StudioTaskOwnerGuard {
  release(): void;
}

export function tryAcquireStudioTaskOwnerGuard(projectRoot: string, sessionId: string): StudioTaskOwnerGuard | undefined {
  return taskLockSpace(projectRoot).tryAcquire("studio-task-owner", sessionId);
}

/** Read-only, non-waiting occupancy check, including before the first snapshot. */
export function hasStudioTaskOwner(projectRoot: string, sessionId: string): boolean {
  const probe = tryAcquireStudioTaskOwnerGuard(projectRoot, sessionId);
  if (!probe) return true;
  try { return false; }
  finally { probe.release(); }
}

export async function reserveStudioTaskExecution(
  projectRoot: string,
  sessionId: string,
  executionId: string,
): Promise<StudioTaskLease | null> {
  const space = taskLockSpace(projectRoot);
  const handle = space.tryAcquire("studio-task-owner", sessionId);
  if (!handle) return null;
  let retained = false;
  const owner = Object.freeze({ pid: process.pid, token: `${SQLITE_OWNER_TOKEN_PREFIX}${randomUUID()}` });
  let releasePromise: Promise<void> | undefined;
  const lease: LocalLease = {
    sessionId,
    executionId,
    owner,
    closing: false,
    deleted: false,
    hasWritten: false,
    pendingWrites: new Set(),
    release() {
      if (releasePromise) return releasePromise;
      lease.closing = true;
      let closed = closedExecutions.get(handle.key);
      if (!closed) closedExecutions.set(handle.key, closed = new Set());
      closed.add(executionId);
      releasePromise = (async () => {
        let failed = false;
        let failure: unknown;
        try {
          // Closing rejects later calls; writes admitted before closing still
          // run with this owner, even when they dequeue after release starts.
          await Promise.allSettled([...lease.pendingWrites]);
          await withTaskState(space, sessionId, async () => {
            const current = await readSnapshot(projectRoot, sessionId);
            if (
              current?.execution.id === executionId
              && current.owner?.token === owner.token
              && current.owner.pid === owner.pid
              && isRunning(current)
            ) await writeSnapshot(projectRoot, interruptSnapshot(current, INTERRUPTED_ERROR));
          });
        } catch (error) {
          failed = true;
          failure = error;
        } finally {
          if (localLeases.get(handle.key) === lease) localLeases.delete(handle.key);
          try { handle.release(); }
          catch (error) { if (!failed) { failed = true; failure = error; } }
        }
        if (failed) throw failure;
      })();
      return releasePromise;
    },
  };
  try {
    const admitted = await withTaskState(space, sessionId, async () => {
      if (closedExecutions.get(handle.key)?.has(executionId)) return false;
      const current = await readSnapshot(projectRoot, sessionId);
      if (current && isRunning(current)) {
        // The acquired owner lock proves a SQLite owner stopped. Older owners
        // have no such proof: ownerless tasks stay protected until migration.
        if (!hasSqliteOwner(current) && (!current.owner || processExists(current.owner.pid))) return false;
        await writeSnapshot(projectRoot, interruptSnapshot(current, INTERRUPTED_ERROR));
      }
      // Register before releasing state, so an already queued local deletion
      // can fence the lease even before its caller receives admission.
      localLeases.set(handle.key, lease);
      return true;
    });
    if (!admitted) return null;
    retained = true;
    return { sessionId, executionId, owner, release: lease.release };
  } finally {
    if (!retained) {
      if (localLeases.get(handle.key) === lease) localLeases.delete(handle.key);
      handle.release();
    }
  }
}

export async function saveStudioTaskSnapshot(
  projectRoot: string,
  snapshot: StudioTaskSnapshot,
): Promise<void> {
  // Freeze both input and queue admission before this async function yields.
  const frozen = parseStudioTaskSnapshot(JSON.parse(JSON.stringify(snapshot)));
  const space = taskLockSpace(projectRoot);
  const ownerKey = space.key("studio-task-owner", frozen.sessionId);
  const local = localLeases.get(ownerKey);
  const lease = local?.executionId === frozen.execution.id && !local.closing ? local : undefined;
  if (!lease && (
    frozen.owner
    || local?.executionId === frozen.execution.id
    || closedExecutions.get(ownerKey)?.has(frozen.execution.id)
  )) return;

  const next = withTaskState(space, frozen.sessionId, async () => {
    const current = await readSnapshot(projectRoot, frozen.sessionId);
    if (lease) {
      if (localLeases.get(ownerKey) !== lease || lease.deleted) return;
      if (!current && lease.hasWritten) return;
      if (current && hasSqliteOwner(current) && (
        current.execution.id !== lease.executionId
        || current.owner?.token !== lease.owner.token
        || current.owner.pid !== lease.owner.pid
      ) && (isRunning(current) || lease.hasWritten)) return;
      if (current && isRunning(current) && !hasSqliteOwner(current)) return;
      await writeSnapshot(projectRoot, { ...frozen, owner: lease.owner });
      lease.hasWritten = true;
      return;
    }
    if (current && (current.owner || (isRunning(current) && current.execution.id !== frozen.execution.id))) return;
    const probe = space.tryAcquire("studio-task-owner", frozen.sessionId);
    if (!probe) return;
    try { await writeSnapshot(projectRoot, frozen); }
    finally { probe.release(); }
  });
  lease?.pendingWrites.add(next);
  try {
    await next;
  } finally {
    lease?.pendingWrites.delete(next);
  }
}

export async function loadStudioTaskSnapshot(
  projectRoot: string,
  sessionId: string,
): Promise<StudioTaskSnapshot | null> {
  return withTaskState(taskLockSpace(projectRoot), sessionId, () => readSnapshot(projectRoot, sessionId));
}

export async function recoverStudioTaskSnapshot(
  projectRoot: string,
  sessionId: string,
  interruptedError: string,
): Promise<StudioTaskSnapshot | null> {
  const space = taskLockSpace(projectRoot);
  return withTaskState(space, sessionId, async () => {
    const current = await readSnapshot(projectRoot, sessionId);
    if (!current || !isRunning(current)) return current;
    if (!hasSqliteOwner(current)) {
      if (!current.owner || processExists(current.owner.pid)) return current;
    } else {
      const local = localLeases.get(space.key("studio-task-owner", sessionId));
      if (local?.executionId === current.execution.id && local.owner.token === current.owner?.token) return current;
    }
    const probe = space.tryAcquire("studio-task-owner", sessionId);
    if (!probe) return current;
    try {
      const recovered = interruptSnapshot(current, interruptedError);
      await writeSnapshot(projectRoot, recovered);
      return recovered;
    } finally {
      probe.release();
    }
  });
}

export async function deleteStudioTaskSnapshot(projectRoot: string, sessionId: string): Promise<void> {
  const space = taskLockSpace(projectRoot);
  await withTaskState(space, sessionId, async () => {
    const lease = localLeases.get(space.key("studio-task-owner", sessionId));
    if (lease) lease.deleted = true;
    await unlink(studioTaskSnapshotPath(projectRoot, sessionId)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  });
}
