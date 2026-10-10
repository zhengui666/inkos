import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";

export const BOOK_LOCK_GUARD_FILE = ".write.lock.guard.sqlite";
const WAL_INIT_BUDGET_MS = 5000;
const WAL_INIT_PAUSE = new Int32Array(new SharedArrayBuffer(4));

/**
 * Stable per-physical-Work mutex for lock-file claim, recovery and release.
 * Never unlink this database: replacing its inode would split the mutex.
 * The callback must be synchronous and contain only short filesystem work.
 * No transaction remains open while a writer/model/host tool is running.
 */
export function withBookLockGuard<T>(lockPath: string, action: () => T): T {
  const path = join(dirname(lockPath), BOOK_LOCK_GUARD_FILE);
  const deadline = performance.now() + WAL_INIT_BUDGET_MS;
  const remaining = () => Math.max(0, Math.floor(deadline - performance.now()));
  let busy: unknown;
  for (;;) {
    if (busy !== undefined && remaining() === 0) throw busy;
    const db = new DatabaseSync(path);
    let retryWal = false;
    try {
      db.exec(`PRAGMA busy_timeout = ${remaining()}`);
      try { db.exec("PRAGMA journal_mode = WAL"); }
      catch (error) {
        // Only the observed first WAL-initialization BUSY can be retried. The
        // callback and transaction have not started; every other failure escapes.
        const sqlite = error as { code?: string; errcode?: number } | null;
        if (!sqlite || sqlite.code !== "ERR_SQLITE_ERROR" || sqlite.errcode !== 5 || remaining() === 0) throw error;
        busy = error; retryWal = true;
      }
      if (!retryWal) {
        db.exec(`PRAGMA busy_timeout = ${remaining()}`);
        db.exec("BEGIN IMMEDIATE");
        try {
          const result = action();
          db.exec("COMMIT");
          return result;
        } catch (error) { db.exec("ROLLBACK"); throw error; }
      }
    } finally { db.close(); }
    // Close the failed connection before backoff/reopen. Never replace the
    // mutex file/inode, reset this deadline, or replay an entered action.
    const waitMs = Math.min(10, remaining());
    if (waitMs === 0) throw busy;
    Atomics.wait(WAL_INIT_PAUSE, 0, 0, waitMs);
  }
}
