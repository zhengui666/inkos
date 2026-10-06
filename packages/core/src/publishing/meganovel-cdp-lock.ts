import { randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { publishingError } from './contracts.js';

// A dropped transport reference must not let GC release a live browser's lock.
const activeLocks = new Set<DatabaseSync>();
const PROTOCOL = 'inkos-meganovel-cdp-sqlite-v1';
function busy(): Error {
  return publishingError('MEGANOVEL_BROWSER_BUSY', 'This browser target is reserved. Legacy or unrecognized locks require explicit reconciliation.');
}

/** The stable sidecar is never removed: replacing its inode would split ownership.
 * The marker also excludes older transports, which only use open(..., 'wx').
 * PID is diagnostic only; a held SQLite transaction establishes a live owner.
 */
export function acquireMegaNovelCdpLock(directory: string, targetId: string): {release(): void} {
  mkdirSync(directory, {recursive: true});
  const lockPath = join(realpathSync(directory), `${targetId}.lock`);
  const db = new DatabaseSync(`${lockPath}.sqlite`);
  let closed = false;
  const close = () => {
    if (closed) return;
    db.close();
    closed = true;
    activeLocks.delete(db);
  };
  try {
    db.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE');
  } catch (error) {
    close();
    if ([5, 6].includes(Number((error as {errcode?: number}).errcode))) throw busy();
    throw error;
  }
  const marker = JSON.stringify({protocol: PROTOCOL, token: randomUUID(), pid: process.pid});
  const temporary = `${lockPath}.${randomUUID()}.tmp`;
  try {
    // A crash cannot leave a partially written live marker. Temporary leftovers
    // contain no session data and never confer ownership.
    writeFileSync(temporary, marker, {flag: 'wx', mode: 0o600});
    try { linkSync(temporary, lockPath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let previous: unknown;
      try { previous = JSON.parse(readFileSync(lockPath, 'utf8')); }
      catch { throw busy(); } // Empty, malformed and unreadable old markers are never stolen.
      if (!previous || typeof previous !== 'object' || !('protocol' in previous) || previous.protocol !== PROTOCOL
        || !('token' in previous) || typeof previous.token !== 'string' || !previous.token) throw busy();
      // Holding the kernel lock proves this version's previous owner is gone,
      // even if its PID was reused. Rename leaves no gap for a legacy wx claim.
      renameSync(temporary, lockPath);
    }
  } catch (error) { close(); throw error; }
  finally {
    try { unlinkSync(temporary); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { close(); throw error; } }
  }
  activeLocks.add(db);
  let released = false;
  return {release() {
    if (released) return;
    released = true;
    try {
      if (readFileSync(lockPath, 'utf8') !== marker) throw busy();
      unlinkSync(lockPath);
    } finally { close(); }
  }};
}
