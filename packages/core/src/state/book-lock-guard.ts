import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const BOOK_LOCK_GUARD_FILE = ".write.lock.guard.sqlite";

/**
 * Stable per-physical-Work mutex for lock-file claim, recovery and release.
 * Never unlink this database: replacing its inode would split the mutex.
 * The callback must be synchronous and contain only short filesystem work.
 * No transaction remains open while a writer/model/host tool is running.
 */
export function withBookLockGuard<T>(lockPath: string, action: () => T): T {
  const db = new DatabaseSync(join(dirname(lockPath), BOOK_LOCK_GUARD_FILE));
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      db.exec("COMMIT");
      return result;
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  } finally { db.close(); }
}
