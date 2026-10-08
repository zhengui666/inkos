import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { HarnessIdSchema, WorkResourceIdSchema } from '../harness/contracts.js';
import { PublishingTargetSchema, publishingError, type PublishingTarget } from './contracts.js';
import { PublishingStore } from './store.js';
import {
  RemoteWorkBlockerSchema, RemoteWorkInputSchema, RemoteWorkReceiptSchema, RemoteWorkRunSchema,
  type RemoteWorkBlocker, type RemoteWorkInput, type RemoteWorkReceipt, type RemoteWorkRun,
} from './work-creation-contracts.js';

interface BindingRow {
  operation_id: string; work_id: string; target_id: string;
  platform: string; account_id: string; remote_book_id: string; receipt_json: string;
}

/** Durable, single-attempt ledger. Only a service holding an authorized port may record observations. */
export class RemoteWorkStore {
  private readonly db: DatabaseSync;

  constructor(databasePath: string) {
    // Initialize existing publishing tables through their owner, without rewriting any historic JSON.
    if (databasePath !== ':memory:') {
      const publishing = new PublishingStore(databasePath);
      publishing.close();
    }
    this.db = new DatabaseSync(databasePath);
    try {
      this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
      if (databasePath === ':memory:') {
        // A separate :memory: PublishingStore connection cannot initialize this connection.
        this.db.exec(`CREATE TABLE IF NOT EXISTS publishing_targets (
          id TEXT PRIMARY KEY, work_id TEXT NOT NULL, platform TEXT NOT NULL,
          account_label TEXT NOT NULL, remote_book_id TEXT NOT NULL, target_json TEXT NOT NULL,
          UNIQUE(platform, account_label, remote_book_id)
        );`);
      }
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS publishing_remote_work_runs (
          id TEXT PRIMARY KEY, work_id TEXT NOT NULL UNIQUE,
          version INTEGER NOT NULL CHECK(version >= 0), run_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS publishing_remote_work_bindings (
          operation_id TEXT PRIMARY KEY REFERENCES publishing_remote_work_runs(id),
          work_id TEXT NOT NULL UNIQUE,
          target_id TEXT NOT NULL UNIQUE REFERENCES publishing_targets(id),
          platform TEXT NOT NULL, account_id TEXT NOT NULL, remote_book_id TEXT NOT NULL,
          receipt_json TEXT NOT NULL, created_at REAL NOT NULL,
          UNIQUE(platform, account_id, remote_book_id)
        );
      `);
    } catch (error) { this.db.close(); throw error; }
  }

  close(): void { this.db.close(); }

  reserve(input: RemoteWorkInput): RemoteWorkRun {
    const parsed = RemoteWorkInputSchema.parse(input);
    return this.transaction(() => {
      const existing = this.forWork(parsed.workId);
      if (existing) {
        if (JSON.stringify(existing.input) !== JSON.stringify(parsed)) {
          throw publishingError('REMOTE_WORK_INPUT_CONFLICT', 'A creation operation already freezes different metadata or destination for this Work.');
        }
        return existing;
      }
      const now = Date.now();
      const run = RemoteWorkRunSchema.parse({
        id: randomUUID(), input: parsed, version: 0, phase: 'ready', attempts: 0,
        unverifiedRemoteBookId: null,
        attemptedAt: null, receipt: null, targetId: null, blocker: null, createdAt: now, updatedAt: now,
      });
      this.db.prepare('INSERT INTO publishing_remote_work_runs (id,work_id,version,run_json) VALUES (?,?,?,?)')
        .run(run.id, run.input.workId, run.version, JSON.stringify(run));
      return run;
    });
  }

  get(id: string): RemoteWorkRun {
    const row = this.db.prepare('SELECT work_id,version,run_json FROM publishing_remote_work_runs WHERE id=?')
      .get(HarnessIdSchema.parse(id));
    if (!row) throw publishingError('REMOTE_WORK_MISSING', 'Unknown remote Work creation operation.');
    const run = RemoteWorkRunSchema.parse(JSON.parse(String(row.run_json)));
    if (run.id !== id || run.version !== row.version || run.input.workId !== row.work_id) {
      throw publishingError('REMOTE_WORK_INTEGRITY', 'Creation ledger identity or version is inconsistent.');
    }
    if (run.phase === 'bound') this.assertBinding(run);
    return run;
  }

  forWork(workId: string): RemoteWorkRun | undefined {
    const row = this.db.prepare('SELECT id FROM publishing_remote_work_runs WHERE work_id=?')
      .get(WorkResourceIdSchema.parse(workId));
    const run = row ? this.get(String(row.id)) : undefined;
    if (run && run.input.workId !== workId) throw publishingError('REMOTE_WORK_INTEGRITY', 'Creation ledger Work identity is inconsistent.');
    return run;
  }

  list(): RemoteWorkRun[] {
    return this.db.prepare('SELECT id FROM publishing_remote_work_runs ORDER BY rowid').all()
      .map(row => this.get(String(row.id)));
  }

  setBlocker(id: string, expectedVersion: number, blocker: RemoteWorkBlocker | null): RemoteWorkRun {
    const parsed = RemoteWorkBlockerSchema.nullable().parse(blocker);
    return this.change(id, expectedVersion, run => JSON.stringify(run.blocker) === JSON.stringify(parsed)
      ? run : this.save(run, {blocker: parsed}));
  }

  /** Commit uncertainty BEFORE any browser or other remote mutation, including autosaving inputs. */
  beginCreation(id: string, expectedVersion: number): RemoteWorkRun {
    return this.change(id, expectedVersion, run => {
      if (run.phase !== 'ready' || run.attempts !== 0) {
        throw publishingError('REMOTE_WORK_RECONCILIATION_REQUIRED', 'Creation may already have happened. Observe the existing operation; never create again.');
      }
      if (run.blocker) throw publishingError('REMOTE_WORK_BLOCKED', 'Resolve the recorded blocker before beginning creation.');
      return this.save(run, {phase: 'create_unknown', attempts: 1, attemptedAt: Math.max(Date.now(), run.updatedAt)});
    });
  }

  /** A mutation return value is only a recovery hint, never independent proof of creation. */
  recordHint(id: string, expectedVersion: number, remoteBookId: string): RemoteWorkRun {
    const parsed = RemoteWorkReceiptSchema.shape.remoteBookId.parse(remoteBookId);
    return this.change(id, expectedVersion, run => {
      if (run.attempts !== 1 || run.attemptedAt === null) {
        throw publishingError('REMOTE_WORK_ATTEMPT_MISSING', 'Persist a creation attempt before recording a remote ID hint.');
      }
      if (run.unverifiedRemoteBookId !== null && run.unverifiedRemoteBookId !== parsed
        || run.receipt !== null && run.receipt.remoteBookId !== parsed) {
        throw publishingError('REMOTE_WORK_RECEIPT_CONFLICT', 'A remote ID hint cannot change an existing hint or observed remote book ID.');
      }
      return run.unverifiedRemoteBookId === parsed ? run : this.save(run, {unverifiedRemoteBookId: parsed});
    });
  }

  /** Not a manual receipt endpoint: only independently observed, exact-scope port receipts belong here. */
  recordObserved(id: string, expectedVersion: number, receipt: RemoteWorkReceipt): RemoteWorkRun {
    const parsed = RemoteWorkReceiptSchema.parse(receipt);
    return this.change(id, expectedVersion, run => {
      if (run.attempts !== 1 || run.attemptedAt === null) {
        throw publishingError('REMOTE_WORK_ATTEMPT_MISSING', 'Persist a creation attempt before observing its result.');
      }
      if (parsed.operationId !== run.id
        || JSON.stringify(parsed.destination) !== JSON.stringify(run.input.destination)
        || JSON.stringify(parsed.metadata) !== JSON.stringify(run.input.metadata)
        || run.unverifiedRemoteBookId !== null && parsed.remoteBookId !== run.unverifiedRemoteBookId
        || parsed.observedAt < run.attemptedAt) {
        throw publishingError('REMOTE_WORK_RECEIPT_CONFLICT', 'Observed operation, destination, metadata or time differs from the frozen attempt.');
      }
      if (run.receipt) {
        if (JSON.stringify(run.receipt) !== JSON.stringify(parsed)) {
          throw publishingError('REMOTE_WORK_RECEIPT_CONFLICT', 'The recorded observation and remote book ID cannot change.');
        }
        return run;
      }
      return this.save(run, {phase: 'observed', receipt: parsed, blocker: null});
    });
  }

  /** Target, actual-account uniqueness, proof, and bound phase commit or roll back together. */
  bindObserved(id: string, expectedVersion: number): RemoteWorkRun {
    return this.change(id, expectedVersion, run => {
      if (run.phase === 'bound') {
        this.assertBinding(run);
        return run;
      }
      if (run.phase !== 'observed' || !run.receipt) {
        throw publishingError('REMOTE_WORK_OBSERVATION_REQUIRED', 'An independently observed creation is required before binding a publishing target.');
      }
      const {destination} = run.input;
      const receipt = run.receipt;
      const established = this.db.prepare(`SELECT * FROM publishing_remote_work_bindings
        WHERE (platform=? AND account_id=? AND remote_book_id=?) OR operation_id=? OR work_id=?`)
        .all(destination.platform, destination.accountId, receipt.remoteBookId, run.id, run.input.workId);
      if (established.length) {
        throw publishingError('REMOTE_WORK_BINDING_CONFLICT', 'This operation, Work or actual-account remote book already has a durable binding.');
      }
      const target = this.findReusableTarget(run) ?? this.createTarget(run);
      this.db.prepare(`INSERT INTO publishing_remote_work_bindings
        (operation_id,work_id,target_id,platform,account_id,remote_book_id,receipt_json,created_at)
        VALUES (?,?,?,?,?,?,?,?)`)
        .run(run.id, run.input.workId, target.id, destination.platform, destination.accountId,
          receipt.remoteBookId, JSON.stringify(receipt), Date.now());
      return this.save(run, {phase: 'bound', targetId: target.id, blocker: null});
    });
  }

  private findReusableTarget(run: RemoteWorkRun): PublishingTarget | undefined {
    const {destination, workId} = run.input;
    const rows = this.db.prepare(`SELECT t.id,t.work_id,t.platform,t.account_label,t.remote_book_id,t.target_json,b.account_id FROM publishing_targets t
      LEFT JOIN publishing_remote_work_bindings b ON b.target_id=t.id
      WHERE t.platform=? AND t.remote_book_id=?`).all(destination.platform, run.receipt!.remoteBookId);
    let reusable: PublishingTarget | undefined;
    for (const row of rows) {
      const target = PublishingTargetSchema.parse(JSON.parse(String(row.target_json)));
      if (target.id !== row.id || target.workId !== row.work_id || target.platform !== row.platform
        || target.accountLabel !== row.account_label || target.remoteBookId !== row.remote_book_id
        || row.account_id !== null && target.observedAccountId !== undefined && row.account_id !== target.observedAccountId) {
        throw publishingError('REMOTE_WORK_INTEGRITY', 'Publishing target identity differs from its stored account-scoped mapping.');
      }
      const accountId = row.account_id === null ? target.observedAccountId : String(row.account_id);
      if (accountId === undefined && target.accountLabel !== destination.accountLabel) {
        throw publishingError('REMOTE_WORK_AMBIGUOUS_TARGET', 'A legacy target has this platform book ID under another label, with no known actual account. Resolve the ambiguity first.');
      }
      if (accountId !== undefined && accountId !== destination.accountId) {
        if (target.accountLabel === destination.accountLabel) {
          throw publishingError('REMOTE_WORK_BINDING_CONFLICT', 'This account label and remote book ID already identify a different actual account.');
        }
        continue;
      }
      if (target.workId !== workId) {
        throw publishingError('REMOTE_WORK_BINDING_CONFLICT', 'This platform book is already mapped to another Work.');
      }
      if (reusable) {
        throw publishingError('REMOTE_WORK_AMBIGUOUS_TARGET', 'Multiple targets could represent this actual-account remote book. Resolve the ambiguity first.');
      }
      reusable = target;
    }
    return reusable;
  }

  private createTarget(run: RemoteWorkRun): PublishingTarget {
    const {destination, workId} = run.input;
    const target = PublishingTargetSchema.parse({
      id: randomUUID(), workId, platform: destination.platform, accountLabel: destination.accountLabel,
      remoteBookId: run.receipt!.remoteBookId, createdAt: new Date().toISOString(),
      verification: 'independently_observed', observedAccountId: destination.accountId, creationOperationId: run.id,
    });
    this.db.prepare('INSERT INTO publishing_targets (id,work_id,platform,account_label,remote_book_id,target_json) VALUES (?,?,?,?,?,?)')
      .run(target.id, target.workId, target.platform, target.accountLabel, target.remoteBookId, JSON.stringify(target));
    return target;
  }

  private assertBinding(run: RemoteWorkRun): void {
    const row = this.db.prepare('SELECT * FROM publishing_remote_work_bindings WHERE operation_id=?')
      .get(run.id) as unknown as BindingRow | undefined;
    if (!row || row.work_id !== run.input.workId || row.target_id !== run.targetId
      || row.platform !== run.input.destination.platform || row.account_id !== run.input.destination.accountId
      || row.remote_book_id !== run.receipt!.remoteBookId || row.receipt_json !== JSON.stringify(run.receipt)) {
      throw publishingError('REMOTE_WORK_INTEGRITY', 'Bound creation is missing its matching durable account-scoped proof.');
    }
    const stored = this.db.prepare('SELECT * FROM publishing_targets WHERE id=?').get(row.target_id);
    if (!stored) throw publishingError('REMOTE_WORK_INTEGRITY', 'Bound creation is missing its publishing target.');
    const target = PublishingTargetSchema.parse(JSON.parse(String(stored.target_json)));
    if (target.id !== row.target_id || target.workId !== row.work_id || target.platform !== row.platform || target.remoteBookId !== row.remote_book_id
      || target.workId !== stored.work_id || target.platform !== stored.platform
      || target.accountLabel !== stored.account_label || target.remoteBookId !== stored.remote_book_id
      || target.observedAccountId !== undefined && target.observedAccountId !== row.account_id) {
      throw publishingError('REMOTE_WORK_INTEGRITY', 'Bound publishing target differs from its durable proof.');
    }
  }

  private change(id: string, expectedVersion: number, apply: (run: RemoteWorkRun) => RemoteWorkRun): RemoteWorkRun {
    HarnessIdSchema.parse(id); z.number().int().nonnegative().parse(expectedVersion);
    return this.transaction(() => {
      const run = this.get(id);
      if (run.version !== expectedVersion) {
        throw publishingError('REMOTE_WORK_VERSION_CONFLICT', 'Creation state changed. Inspect it before continuing.');
      }
      return apply(run);
    });
  }

  private save(run: RemoteWorkRun, patch: Partial<RemoteWorkRun>): RemoteWorkRun {
    const next = RemoteWorkRunSchema.parse({...run, ...patch,
      version: run.version + 1, updatedAt: Math.max(Date.now(), run.updatedAt)});
    const result = this.db.prepare('UPDATE publishing_remote_work_runs SET version=?,run_json=? WHERE id=? AND version=?')
      .run(next.version, JSON.stringify(next), run.id, run.version);
    if (result.changes !== 1) throw publishingError('REMOTE_WORK_VERSION_CONFLICT', 'Creation state changed. Inspect it before continuing.');
    return next;
  }

  private transaction<T>(apply: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = apply(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}
