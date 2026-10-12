import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Reuse the existing SQLite sidecar kernel-lock technique; only one project-level lock remains. */
export function acquireProjectOwner(rootDir: string): { rootDir: string; release(): void } {
  rootDir = realpathSync(rootDir);
  mkdirSync(join(rootDir, '.inkos'), { recursive: true });
  const lock = new DatabaseSync(join(rootDir, '.inkos', 'runtime-owner.sqlite'));
  try { lock.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE'); }
  catch (error) { lock.close(); throw Object.assign(new Error('Project runtime already has an owner'), { cause: error, code: 'RUNTIME_OWNED' }); }
  let released = false;
  return { rootDir, release() { if (!released) { released = true; try { lock.exec('ROLLBACK'); } finally { lock.close(); } } } };
}
