import { createHash, randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const SQLITE_OWNER_TOKEN_PREFIX = "sqlite-lock-v1:";
export type OwnershipLockKind = "daemon" | "goal-owner" | "studio-task-owner" | "studio-task-state" | "studio-chat-owner" | "studio-chat-state";
export interface OwnershipLockHandle {
  readonly key: string;
  release(): void;
}
export interface OwnershipLockSpace {
  readonly canonicalDatabasePath: string;
  key(kind: OwnershipLockKind, resourceId?: string): string;
  tryAcquire(kind: OwnershipLockKind, resourceId?: string): OwnershipLockHandle | undefined;
  withStateLock<T>(kind: "studio-task-state" | "studio-chat-state", resourceId: string, operation: () => Promise<T>): Promise<T>;
}

const kinds = new Set<OwnershipLockKind>(["daemon", "goal-owner", "studio-task-owner", "studio-task-state", "studio-chat-owner", "studio-chat-state"]);

/** Kernel ownership lives in separate rollback-journal databases, never the ledger. */
export function createOwnershipLockSpace(databasePath: string): OwnershipLockSpace {
  const memory = databasePath === ":memory:";
  if (!memory) {
    // Ensure canonicalization works before a ledger/server has been opened.
    // Do not open SQLite here: its owners control the ledger journal/schema,
    // and concurrent journal-mode initialization can fail before busy_timeout.
    mkdirSync(dirname(databasePath), { recursive: true });
    closeSync(openSync(databasePath, "a"));
  }
  const canonicalDatabasePath = memory ? databasePath : realpathSync(databasePath);
  const memoryRoot = memory ? `:memory:${randomUUID()}` : undefined;
  const held = new Set<string>();
  const key = (kind: OwnershipLockKind, resourceId?: string): string => {
    if (!kinds.has(kind)) throw new TypeError(`Unknown ownership lock kind: ${kind}`);
    if (kind === "daemon") return `${memoryRoot ?? canonicalDatabasePath}.daemon-lock`;
    if (typeof resourceId !== "string" || !resourceId.length) throw new TypeError("Ownership lock resource ID must not be empty.");
    // Hash only the lock kind and resource string, never file contents. UTF-16LE
    // preserves lone surrogates; lowercase hex is safe on case-folding volumes.
    // A fixed-size name avoids imposing SQLite VFS path limits on business IDs.
    const resourceKey = createHash("sha256").update(`${kind}\0`).update(Buffer.from(resourceId, "utf16le")).digest("hex");
    return join(`${memoryRoot ?? canonicalDatabasePath}.owner-locks`, kind, resourceKey, "lock.sqlite");
  };
  const tryAcquire = (kind: OwnershipLockKind, resourceId?: string): OwnershipLockHandle | undefined => {
    const lockKey = key(kind, resourceId);
    if (memory) {
      if (held.has(lockKey)) return undefined;
      held.add(lockKey);
      let released = false;
      return { key: lockKey, release() { if (!released) { released = true; held.delete(lockKey); } } };
    }
    mkdirSync(dirname(lockKey), { recursive: true });
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(lockKey);
      // A RESERVED writer lock arbitrates without upgrading past another
      // contender's transient read lock (which can leave EXCLUSIVE no winner).
      // Existing daemon binaries require their original EXCLUSIVE protocol.
      db.exec(`PRAGMA busy_timeout = 0; BEGIN ${kind === "daemon" ? "EXCLUSIVE" : "IMMEDIATE"}`);
    } catch (error) {
      // Cleanup cannot replace the original failure (including filesystem errors).
      try { db?.close(); } catch { /* preserve acquisition failure */ }
      if ([5, 6].includes(Number((error as { errcode?: number }).errcode))) return undefined;
      throw error;
    }
    const lock = db;
    let released = false;
    return { key: lockKey, release() {
      if (released) return;
      released = true;
      try { lock.exec("ROLLBACK"); } finally { lock.close(); }
      // Never unlink a sidecar: another process may already have opened its inode.
    } };
  };
  return { canonicalDatabasePath, key, tryAcquire,
    async withStateLock<T>(kind: "studio-task-state" | "studio-chat-state", resourceId: string, operation: () => Promise<T>): Promise<T> {
      if (kind !== "studio-task-state" && kind !== "studio-chat-state") throw new TypeError("A state lock kind is required.");
      const started = Date.now();
      let handle = tryAcquire(kind, resourceId);
      while (!handle) {
        if (Date.now() - started >= 5_000) {
          throw Object.assign(new Error("Ownership state lock is busy."), { code: "OWNERSHIP_LOCK_BUSY" });
        }
        // Do not synchronously block JS: the holder may be awaiting file I/O in
        // this same process. Callers retain their canonical-key FIFO queues.
        await new Promise<void>(resolve => setTimeout(resolve, 10));
        handle = tryAcquire(kind, resourceId);
      }
      try { return await operation(); } finally { handle.release(); }
    },
  };
}
