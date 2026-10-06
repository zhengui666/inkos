import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { realpathSync } from "node:fs";
import { openHarnessDatabase } from "../harness/sqlite.js";
import type { BookConfig } from "../models/book.js";
import type { Observation } from "../models/observation.js";

export interface ScheduledFoundation {
  scanId: string; concept: string; book: BookConfig; instruction: string;
  phase: "pending" | "completed" | "blocked"; attempts: number; nextAttemptAt: number;
  error?: string;
}

export interface ScheduledChapter {
  workId: string;
  chapter: number;
  goalId: string;
  phase: "writing" | "reviewing" | "publishing" | "completed" | "blocked";
  revisionId?: string;
  reviewAttempts: number;
  /** Audit and repair budgets survive both process restarts and chapter edits. */
  reviewChecks?: number;
  reviewAttempt?: { revisionId: string; startedAt: number };
  reviewRepair?: { revisionId: string; startedAt: number };
  reviewReceipt?: { revisionId: string; reviewedAt: number; summary: string; observations: readonly Observation[] };
  failures: number;
  nextAttemptAt: number;
  publicationStartedAt?: number;
  error?: { code: string; message: string };
  publication?: { status: "published" | "submitted" | "pending"; remoteChapterId?: string; evidence?: string };
}

const owners = new Set<string>();
const LOCKED_OWNER_PREFIX = "sqlite-lock-v1:";
function daemonBusy(): Error {
  return Object.assign(new Error("A daemon already owns this project."), { code: "DAEMON_BUSY" });
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/** Small durable coordinator over the project's existing SQLite ledger. */
export class SchedulerStore {
  private readonly db: DatabaseSync;
  private owner?: string;
  private ownerLock?: DatabaseSync;
  private readonly ownerLockPath: string;
  constructor(path: string) {
    this.db = openHarnessDatabase(path);
    this.ownerLockPath = path === ":memory:" ? path : `${realpathSync(path)}.daemon-lock`;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scheduler_owner (id INTEGER PRIMARY KEY CHECK(id=1), pid INTEGER NOT NULL, token TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS scheduler_control (id INTEGER PRIMARY KEY CHECK(id=1), stop_requested INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS scheduler_timers (name TEXT PRIMARY KEY, next_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS scheduler_chapters (work_id TEXT NOT NULL, chapter INTEGER NOT NULL, day TEXT NOT NULL, data_json TEXT NOT NULL, PRIMARY KEY(work_id, chapter));
      CREATE TABLE IF NOT EXISTS scheduler_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, type TEXT NOT NULL, data_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS scheduler_foundations (scan_id TEXT PRIMARY KEY, concept TEXT NOT NULL UNIQUE, work_id TEXT NOT NULL UNIQUE, data_json TEXT NOT NULL);
    `);
  }
  acquire(): void {
    if (this.owner) throw daemonBusy();
    // A separate SQLite transaction is held for the process lifetime. Kernel
    // locks disappear on crash/reboot, unlike persisted PIDs which may be reused.
    // Never hold this transaction on the shared writing/publication ledger.
    const lock = new DatabaseSync(this.ownerLockPath);
    try { lock.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE"); }
    catch (error) {
      lock.close();
      if ([5, 6].includes(Number((error as { errcode?: number }).errcode))) throw daemonBusy();
      throw error;
    }
    try {
      const token = this.transaction(() => {
        const previous = this.db.prepare("SELECT pid, token FROM scheduler_owner WHERE id=1").get();
        // Pre-upgrade daemons do not hold the new lock. Keep their conservative
        // PID check until they have stopped; never take over a live legacy owner.
        if (previous && !String(previous.token).startsWith(LOCKED_OWNER_PREFIX)
          && (Number(previous.pid) === process.pid ? owners.has(String(previous.token)) : alive(Number(previous.pid)))) {
          throw daemonBusy();
        }
        const next = `${LOCKED_OWNER_PREFIX}${randomUUID()}`;
        this.db.prepare("INSERT OR REPLACE INTO scheduler_owner(id,pid,token) VALUES(1,?,?)").run(process.pid, next);
        this.db.prepare("INSERT OR REPLACE INTO scheduler_control(id,stop_requested) VALUES(1,0)").run();
        return next;
      });
      this.owner = token;
      owners.add(token);
      this.ownerLock = lock;
    } catch (error) { lock.close(); throw error; }
  }
  runningOwner(): { pid: number; token: string } | undefined {
    const row = this.db.prepare("SELECT pid,token FROM scheduler_owner WHERE id=1").get();
    return row ? { pid: Number(row.pid), token: String(row.token) } : undefined;
  }
  requestStop(): { pid: number; token: string } | undefined {
    return this.transaction(() => {
      const owner = this.runningOwner();
      if (owner) {
        this.db.prepare("INSERT OR REPLACE INTO scheduler_control(id,stop_requested) VALUES(1,1)").run();
        this.event("daemon-stop-requested", { pid: owner.pid });
      }
      return owner;
    });
  }
  stopRequested(): boolean {
    return this.db.prepare("SELECT stop_requested FROM scheduler_control WHERE id=1").get()?.stop_requested === 1;
  }
  nextAt(name: string, initial: number): number {
    const existing = this.db.prepare("SELECT next_at FROM scheduler_timers WHERE name=?").get(name);
    if (existing) return Number(existing.next_at);
    this.db.prepare("INSERT OR IGNORE INTO scheduler_timers(name,next_at) VALUES(?,?)").run(name, initial);
    return Number(this.db.prepare("SELECT next_at FROM scheduler_timers WHERE name=?").get(name)!.next_at);
  }
  schedule(name: string, nextAt: number): void {
    this.db.prepare("INSERT OR REPLACE INTO scheduler_timers(name,next_at) VALUES(?,?)").run(name, nextAt);
  }
  latest(workId: string): ScheduledChapter | undefined {
    const row = this.db.prepare("SELECT data_json FROM scheduler_chapters WHERE work_id=? ORDER BY chapter DESC LIMIT 1").get(workId);
    return row ? JSON.parse(String(row.data_json)) : undefined;
  }
  hasPendingDue(now: number): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM scheduler_chapters WHERE json_extract(data_json,'$.phase') NOT IN ('completed','blocked') AND json_extract(data_json,'$.nextAttemptAt') <= ? LIMIT 1").get(now));
  }
  foundations(): ScheduledFoundation[] {
    return this.db.prepare("SELECT data_json FROM scheduler_foundations ORDER BY rowid").all().map(row => JSON.parse(String(row.data_json)));
  }
  reserveFoundation(input: ScheduledFoundation): ScheduledFoundation {
    return this.transaction(() => {
      const key = input.concept.trim().toLowerCase();
      const existing = this.db.prepare("SELECT data_json FROM scheduler_foundations WHERE scan_id=? OR concept=?").get(input.scanId, key);
      if (existing) return JSON.parse(String(existing.data_json));
      this.db.prepare("INSERT INTO scheduler_foundations(scan_id,concept,work_id,data_json) VALUES(?,?,?,?)")
        .run(input.scanId, key, input.book.id, JSON.stringify(input));
      this.event("foundation-selected", input);
      return input;
    });
  }
  saveFoundation(input: ScheduledFoundation, event: string): void {
    this.transaction(() => {
      this.db.prepare("UPDATE scheduler_foundations SET data_json=? WHERE scan_id=?").run(JSON.stringify(input), input.scanId);
      this.event(event, input);
    });
  }
  reserve(workId: string, chapter: number, now: number, dailyCap: number): ScheduledChapter | undefined {
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT data_json FROM scheduler_chapters WHERE work_id=? AND chapter=?").get(workId, chapter);
      if (existing) return JSON.parse(String(existing.data_json));
      const day = new Date(now).toISOString().slice(0, 10);
      const count = Number(this.db.prepare("SELECT COUNT(*) AS count FROM scheduler_chapters WHERE day=?").get(day)!.count);
      if (count >= dailyCap) return undefined;
      const job: ScheduledChapter = { workId, chapter, goalId: `daemon-${randomUUID()}`, phase: "writing", reviewAttempts: 0, failures: 0, nextAttemptAt: now };
      this.db.prepare("INSERT INTO scheduler_chapters(work_id,chapter,day,data_json) VALUES(?,?,?,?)").run(workId, chapter, day, JSON.stringify(job));
      this.event("chapter-reserved", job, now);
      return job;
    });
  }
  admitWriting(workId: string, chapter: number, now: number, dailyCap: number): boolean {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT day FROM scheduler_chapters WHERE work_id=? AND chapter=?").get(workId, chapter);
      if (!row) throw new Error("Writing requires a retained scheduler reservation.");
      const day = new Date(now).toISOString().slice(0, 10);
      if (row.day === day) return true;
      if (Number(this.db.prepare("SELECT COUNT(*) AS count FROM scheduler_chapters WHERE day=?").get(day)!.count) >= dailyCap) return false;
      this.db.prepare("UPDATE scheduler_chapters SET day=? WHERE work_id=? AND chapter=?").run(day, workId, chapter);
      this.event("writing-reservation-carried-over", { workId, chapter, day }, now);
      return true;
    });
  }
  save(job: ScheduledChapter, event: string, now = Date.now()): void {
    this.transaction(() => {
      this.db.prepare("UPDATE scheduler_chapters SET data_json=? WHERE work_id=? AND chapter=?").run(JSON.stringify(job), job.workId, job.chapter);
      this.event(event, job, now);
    });
  }
  event(type: string, data: unknown, now = Date.now()): void {
    this.db.prepare("INSERT INTO scheduler_events(at,type,data_json) VALUES(?,?,?)").run(now, type, JSON.stringify(data));
  }
  events(limit = 100): Array<{ at: number; type: string; data: unknown }> {
    return this.db.prepare("SELECT at,type,data_json FROM scheduler_events ORDER BY seq DESC LIMIT ?").all(limit)
      .map(row => ({ at: Number(row.at), type: String(row.type), data: JSON.parse(String(row.data_json)) }));
  }
  close(): void {
    try {
      if (this.owner) this.db.prepare("DELETE FROM scheduler_owner WHERE id=1 AND token=?").run(this.owner);
    } finally {
      if (this.owner) owners.delete(this.owner);
      this.owner = undefined;
      try { this.db.close(); }
      finally { this.ownerLock?.close(); this.ownerLock = undefined; }
    }
  }
  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = operation(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
}
