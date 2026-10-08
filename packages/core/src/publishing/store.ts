import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { FanqieRunSchema, type FanqieRun } from './fanqie-contracts.js';
import { MegaNovelRunSchema, type MegaNovelRun } from './meganovel-contracts.js';
import { HarnessIdSchema } from '../harness/contracts.js';
import {
  PublishingTargetInputSchema, PublishingTargetSchema, PublishingManifestSchema,
  PublishingReceiptSchema, PublishingChapterStatusSchema, publishingManifestValue, publishingError,
  type PublishingTarget, type PublishingManifest, type PublishingPackage, type PublishingReceipt,
} from './contracts.js';

const fanqieTransitions: Record<FanqieRun['phase'], FanqieRun['phase'][]> = {
  draft_unknown: ['draft_unknown', 'draft', 'reviewing', 'scheduled', 'published', 'rejected'],
  draft: ['draft', 'schedule_unknown', 'reviewing', 'scheduled', 'published', 'rejected'],
  schedule_unknown: ['schedule_unknown', 'reviewing', 'scheduled', 'published', 'rejected'],
  reviewing: ['reviewing', 'scheduled', 'published', 'rejected'],
  scheduled: ['scheduled', 'reviewing', 'published', 'rejected'],
  published: ['published'], rejected: ['rejected', 'reviewing', 'scheduled', 'published'],
};
const megaNovelTransitions: Record<MegaNovelRun['phase'], MegaNovelRun['phase'][]> = {
  draft_unknown: ['draft_unknown', 'draft', 'submitted', 'reviewing', 'published', 'rejected'],
  draft: ['draft', 'submit_unknown', 'submitted', 'reviewing', 'published', 'rejected'],
  submit_unknown: ['submit_unknown', 'submitted', 'reviewing', 'published', 'rejected'],
  submitted: ['submitted', 'reviewing', 'published', 'rejected'],
  reviewing: ['reviewing', 'published', 'rejected'],
  published: ['published'], rejected: ['rejected', 'submitted', 'reviewing', 'published'],
};

export interface PublishingPreparation {
  readonly manifest: PublishingManifest;
  readonly stagingDirectory: string | null;
}

/** Shares harness.sqlite, with independent tables and transactional compare-and-swap updates. */
export class PublishingStore {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), {recursive: true});
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS publishing_targets (
        id TEXT PRIMARY KEY, work_id TEXT NOT NULL, platform TEXT NOT NULL,
        account_label TEXT NOT NULL, remote_book_id TEXT NOT NULL, target_json TEXT NOT NULL,
        UNIQUE(platform, account_label, remote_book_id)
      );
      CREATE TABLE IF NOT EXISTS publishing_preparations (
        operation_key TEXT PRIMARY KEY, manifest_json TEXT NOT NULL, staging_directory TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS publishing_packages (
        id TEXT PRIMARY KEY, target_id TEXT NOT NULL REFERENCES publishing_targets(id),
        operation_key TEXT NOT NULL UNIQUE, manifest_json TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS publishing_chapters (
        package_id TEXT NOT NULL REFERENCES publishing_packages(id), number INTEGER NOT NULL,
        status TEXT NOT NULL, remote_chapter_id TEXT, evidence TEXT, provenance TEXT,
        PRIMARY KEY(package_id, number)
      );
      CREATE TABLE IF NOT EXISTS publishing_fanqie_runs (
        package_id TEXT NOT NULL REFERENCES publishing_packages(id), number INTEGER NOT NULL,
        account_id TEXT NOT NULL, remote_book_id TEXT NOT NULL, run_json TEXT NOT NULL,
        PRIMARY KEY(package_id, number), UNIQUE(account_id, remote_book_id, number)
      );
      CREATE TABLE IF NOT EXISTS publishing_events (
        package_id TEXT NOT NULL REFERENCES publishing_packages(id), event_id TEXT NOT NULL,
        action_json TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY(package_id, event_id)
      );
      CREATE TABLE IF NOT EXISTS publishing_meganovel_runs (
        package_id TEXT NOT NULL REFERENCES publishing_packages(id), number INTEGER NOT NULL,
        account_id TEXT NOT NULL, remote_book_id TEXT NOT NULL, run_json TEXT NOT NULL,
        PRIMARY KEY(package_id, number), UNIQUE(account_id, remote_book_id, number)
      );
    `);
  }
  close() { this.db.close(); }

  mapBook(input: z.input<typeof PublishingTargetInputSchema>): PublishingTarget {
    const parsed = PublishingTargetInputSchema.parse(input);
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT target_json FROM publishing_targets WHERE platform=? AND account_label=? AND remote_book_id=?')
        .get(parsed.platform, parsed.accountLabel, parsed.remoteBookId) as {target_json: string} | undefined;
      if (existing) {
        const target = PublishingTargetSchema.parse(JSON.parse(existing.target_json));
        if (target.workId !== parsed.workId) throw publishingError('PUBLISHING_MAPPING_CONFLICT', 'This platform book is already mapped to another Work.');
        return target;
      }
      const target = PublishingTargetSchema.parse({...parsed, id: randomUUID(), createdAt: new Date().toISOString(), verification: 'user_supplied'});
      this.db.prepare('INSERT INTO publishing_targets VALUES (?, ?, ?, ?, ?, ?)')
        .run(target.id, target.workId, target.platform, target.accountLabel, target.remoteBookId, JSON.stringify(target));
      return target;
    });
  }
  getTarget(id: string): PublishingTarget {
    const row = this.db.prepare('SELECT target_json FROM publishing_targets WHERE id=?').get(HarnessIdSchema.parse(id)) as {target_json: string} | undefined;
    if (!row) throw publishingError('PUBLISHING_TARGET_MISSING', 'Unknown platform book mapping.');
    return PublishingTargetSchema.parse(JSON.parse(row.target_json));
  }
  listTargets(): PublishingTarget[] {
    return this.db.prepare('SELECT target_json FROM publishing_targets ORDER BY id').all()
      .map(row => PublishingTargetSchema.parse(JSON.parse(String(row.target_json))));
  }
  getPackage(id: string): PublishingPackage {
    const row = this.db.prepare('SELECT manifest_json, version FROM publishing_packages WHERE id=?')
      .get(HarnessIdSchema.parse(id)) as {manifest_json: string; version: number} | undefined;
    if (!row) throw publishingError('PUBLISHING_PACKAGE_MISSING', 'Unknown publishing package.');
    const chapters = this.db.prepare(`SELECT number, status, remote_chapter_id AS remoteChapterId, evidence, provenance
      FROM publishing_chapters WHERE package_id=? ORDER BY number`).all(id) as unknown as PublishingPackage['chapters'];
    for (const chapter of chapters) PublishingChapterStatusSchema.parse(chapter.status);
    return {manifest: PublishingManifestSchema.parse(JSON.parse(row.manifest_json)), version: row.version, chapters, remoteVerified: false};
  }
  findPackage(operationKey: string): PublishingPackage | undefined {
    const row = this.db.prepare('SELECT id FROM publishing_packages WHERE operation_key=?').get(operationKey);
    return row ? this.getPackage(String(row.id)) : undefined;
  }
  listPackages(targetId?: string): PublishingPackage[] {
    const rows = targetId
      ? this.db.prepare('SELECT id FROM publishing_packages WHERE target_id=? ORDER BY rowid').all(HarnessIdSchema.parse(targetId))
      : this.db.prepare('SELECT id FROM publishing_packages ORDER BY rowid').all();
    return rows.map(row => this.getPackage(String(row.id)));
  }
  findPreparation(operationKey: string): PublishingPreparation | undefined {
    const row = this.db.prepare('SELECT manifest_json, staging_directory FROM publishing_preparations WHERE operation_key=?').get(operationKey);
    return row ? {manifest: PublishingManifestSchema.parse(JSON.parse(String(row.manifest_json))), stagingDirectory: String(row.staging_directory)} : undefined;
  }
  listPreparations(): PublishingPreparation[] {
    return this.db.prepare('SELECT manifest_json, staging_directory FROM publishing_preparations').all()
      .map(row => ({manifest: PublishingManifestSchema.parse(JSON.parse(String(row.manifest_json))), stagingDirectory: String(row.staging_directory)}));
  }
  reservePreparation(input: PublishingManifest, stagingDirectory: string): PublishingPreparation {
    const manifest = PublishingManifestSchema.parse(input);
    z.string().regex(/^\.prepare-[a-zA-Z0-9]+$/u).parse(stagingDirectory);
    return this.transaction(() => {
      const existing = this.findPackage(manifest.operationKey);
      if (existing) return {manifest: existing.manifest, stagingDirectory: null};
      const pending = this.findPreparation(manifest.operationKey);
      if (pending) return pending;
      if (JSON.stringify(this.getTarget(manifest.target.id)) !== JSON.stringify(manifest.target)) {
        throw publishingError('PUBLISHING_MAPPING_CONFLICT', 'Package target differs from its mapping.');
      }
      this.db.prepare('INSERT INTO publishing_preparations VALUES (?,?,?)')
        .run(manifest.operationKey, JSON.stringify(manifest), stagingDirectory);
      return {manifest, stagingDirectory};
    });
  }
  registerPackage(input: PublishingManifest): PublishingPackage {
    const manifest = PublishingManifestSchema.parse(input);
    return this.transaction(() => {
      const target = this.getTarget(manifest.target.id);
      if (JSON.stringify(target) !== JSON.stringify(manifest.target)) throw publishingError('PUBLISHING_MAPPING_CONFLICT', 'Package target differs from its mapping.');
      const existing = this.findPackage(manifest.operationKey);
      if (existing) {
        if (publishingManifestValue(existing.manifest) !== publishingManifestValue(manifest)) throw publishingError('PUBLISHING_PACKAGE_CONFLICT', 'Immutable package differs from its recorded manifest.');
        return existing;
      }
      const pending = this.findPreparation(manifest.operationKey);
      if (!pending || publishingManifestValue(pending.manifest) !== publishingManifestValue(manifest)) {
        throw publishingError('PUBLISHING_PACKAGE_INTEGRITY', 'Package has no matching authoritative preparation record.');
      }
      this.db.prepare('INSERT INTO publishing_packages (id,target_id,operation_key,manifest_json) VALUES (?,?,?,?)')
        .run(manifest.id, target.id, manifest.operationKey, JSON.stringify(manifest));
      const insert = this.db.prepare("INSERT INTO publishing_chapters (package_id,number,status) VALUES (?,?,'awaiting_submission')");
      for (const chapter of manifest.chapters) insert.run(manifest.id, chapter.number);
      this.db.prepare('DELETE FROM publishing_preparations WHERE operation_key=?').run(manifest.operationKey);
      return this.getPackage(manifest.id);
    });
  }

  /** Call before the human submits. Persisting uncertainty first prevents blind replay after a crash. */
  beginSubmission(input: {packageId: string; chapterNumber: number; expectedVersion: number; eventId: string}): PublishingPackage {
    return this.change(input, {type: 'begin'}, (pkg, chapter) => {
      this.assertNoBrowserRun(input.packageId, input.chapterNumber);
      if (!['awaiting_submission', 'not_submitted_reported'].includes(chapter.status)) {
        throw publishingError('PUBLISHING_RECONCILIATION_REQUIRED', 'Submission may already exist. Inspect the author portal and record a receipt; do not submit again.');
      }
      this.assertChapterAvailable(pkg, input.chapterNumber);
      this.db.prepare("UPDATE publishing_chapters SET status='awaiting_receipt',remote_chapter_id=NULL,evidence=NULL,provenance=NULL WHERE package_id=? AND number=?")
        .run(input.packageId, input.chapterNumber);
    });
  }
  recordReceipt(input: {packageId: string; chapterNumber: number; expectedVersion: number; eventId: string; receipt: PublishingReceipt}): PublishingPackage {
    const receipt = PublishingReceiptSchema.parse(input.receipt);
    return this.change(input, {type: 'receipt', receipt}, (pkg, chapter) => {
      this.assertNoBrowserRun(input.packageId, input.chapterNumber);
      if (chapter.status === 'awaiting_submission' || chapter.status === 'not_submitted_reported') {
        throw publishingError('PUBLISHING_ATTEMPT_MISSING', 'Record the beginning of a manual submission before its receipt.');
      }
      if (chapter.status === 'published_reported' && receipt.status !== 'published_reported'
        || chapter.status === 'submitted_reported' && !['submitted_reported', 'published_reported'].includes(receipt.status)) {
        throw publishingError('PUBLISHING_RECEIPT_CONFLICT', 'A recorded submission cannot be cleared to allow duplicate publication. Resolve platform changes separately.');
      }
      if (chapter.remoteChapterId && receipt.remoteChapterId && chapter.remoteChapterId !== receipt.remoteChapterId) {
        throw publishingError('PUBLISHING_RECEIPT_CONFLICT', 'The platform chapter ID cannot change for an existing submission.');
      }
      const remoteId = receipt.status === 'not_submitted_reported' ? null : receipt.remoteChapterId ?? chapter.remoteChapterId;
      if (remoteId && this.db.prepare(`SELECT c.package_id FROM publishing_chapters c JOIN publishing_packages p ON p.id=c.package_id
        WHERE p.target_id=? AND c.remote_chapter_id=? AND NOT (c.package_id=? AND c.number=?)`)
        .get(pkg.manifest.target.id, remoteId, input.packageId, input.chapterNumber)) {
        throw publishingError('PUBLISHING_CHAPTER_MAPPING_CONFLICT', 'This remote chapter is already mapped to a different local chapter.');
      }
      if (remoteId && this.db.prepare(`SELECT r.package_id FROM (
        SELECT package_id,number,run_json FROM publishing_fanqie_runs
        UNION ALL SELECT package_id,number,run_json FROM publishing_meganovel_runs
        ) r JOIN publishing_packages p ON p.id=r.package_id
        WHERE p.target_id=? AND json_extract(r.run_json,'$.remoteChapterId')=?
          AND NOT (r.package_id=? AND r.number=?)`)
        .get(pkg.manifest.target.id, remoteId, input.packageId, input.chapterNumber)) {
        throw publishingError('PUBLISHING_CHAPTER_MAPPING_CONFLICT', 'This remote chapter ID already belongs to a browser-observed local chapter.');
      }
      this.db.prepare("UPDATE publishing_chapters SET status=?,remote_chapter_id=?,evidence=?,provenance='user_reported' WHERE package_id=? AND number=?")
        .run(receipt.status, remoteId, receipt.evidence, input.packageId, input.chapterNumber);
    });
  }
  getFanqieRun(packageId: string, number: number): FanqieRun | undefined {
    const row = this.db.prepare('SELECT run_json FROM publishing_fanqie_runs WHERE package_id=? AND number=?')
      .get(HarnessIdSchema.parse(packageId), z.number().int().positive().parse(number));
    return row ? FanqieRunSchema.parse(JSON.parse(String(row.run_json))) : undefined;
  }

  /** Uses the same CAS, event journal and cross-package reservation as manual publication. */
  writeFanqieRun(input: {expectedVersion: number; eventId: string; run: FanqieRun}): PublishingPackage {
    const run = FanqieRunSchema.parse(input.run);
    return this.change({...input, packageId: run.packageId, chapterNumber: run.chapterNumber},
      {type: 'fanqie', run}, (pkg, chapter) => {
        const selected = pkg.manifest.chapters.find(c => c.number === run.chapterNumber)!;
        const target = pkg.manifest.target;
        if (target.platform !== 'fanqie' || target.accountLabel !== run.scope.accountLabel
          || target.remoteBookId !== run.scope.remoteBookId || (run.revisionId !== undefined && selected.revisionId !== run.revisionId)) {
          throw publishingError('FANQIE_TARGET_CONFLICT', 'Fanqie run differs from the frozen target or chapter.');
        }
        const existing = this.getFanqieRun(run.packageId, run.chapterNumber);
        if (!existing) {
          if (!['awaiting_submission', 'not_submitted_reported'].includes(chapter.status)) {
            throw publishingError('PUBLISHING_RECONCILIATION_REQUIRED', 'A manual attempt exists; reconcile it before automation.');
          }
          this.assertChapterAvailable(pkg, run.chapterNumber, run.scope.accountId);
          const reservations = this.db.prepare(`SELECT r.number, p.manifest_json FROM publishing_fanqie_runs r
            JOIN publishing_packages p ON p.id=r.package_id WHERE r.account_id=? AND r.remote_book_id=?`)
            .all(run.scope.accountId, run.scope.remoteBookId);
          const other = reservations.find(row => row.number === run.chapterNumber
            || PublishingManifestSchema.parse(JSON.parse(String(row.manifest_json))).chapters
              .some(c => c.number === row.number && c.artifactId === selected.artifactId));
          if (other) throw publishingError('PUBLISHING_RECONCILIATION_REQUIRED', 'This account/book/chapter or artifact already has a browser run, possibly under another local account label.');
        } else {
          if (JSON.stringify(existing.scope) !== JSON.stringify(run.scope) || existing.aiAssisted !== run.aiAssisted
            || (existing.revisionId !== undefined && existing.revisionId !== run.revisionId) || existing.remoteChapterId && existing.remoteChapterId !== run.remoteChapterId
            || existing.scheduledFor && existing.scheduledFor !== run.scheduledFor) {
            throw publishingError('FANQIE_RUN_CONFLICT', 'Cannot change the session, declaration, content, remote identity or schedule of this run.');
          }
          if (!fanqieTransitions[existing.phase].includes(run.phase)) throw publishingError('FANQIE_RUN_CONFLICT', 'Cannot reset a possibly submitted chapter to allow another write.');
        }
        if (run.remoteChapterId) {
          const otherRuns = this.db.prepare(`SELECT run_json FROM publishing_fanqie_runs
            WHERE account_id=? AND remote_book_id=? AND NOT (package_id=? AND number=?)`)
            .all(run.scope.accountId, run.scope.remoteBookId, run.packageId, run.chapterNumber);
          const browserConflict = otherRuns.some(row =>
            FanqieRunSchema.parse(JSON.parse(String(row.run_json))).remoteChapterId === run.remoteChapterId);
          const manualConflict = this.db.prepare(`SELECT c.package_id FROM publishing_chapters c
            JOIN publishing_packages p ON p.id=c.package_id
            WHERE p.target_id=? AND c.remote_chapter_id=?
              AND NOT (c.package_id=? AND c.number=?)`)
            .get(target.id, run.remoteChapterId, run.packageId, run.chapterNumber);
          if (browserConflict || manualConflict) throw publishingError('PUBLISHING_CHAPTER_MAPPING_CONFLICT', 'This remote chapter ID already belongs to another local chapter.');
        }
        this.db.prepare('INSERT INTO publishing_fanqie_runs VALUES (?,?,?,?,?) ON CONFLICT(package_id,number) DO UPDATE SET run_json=excluded.run_json')
          .run(run.packageId, run.chapterNumber, run.scope.accountId, run.scope.remoteBookId, JSON.stringify(run));
        // Keep manual provenance honest: browser results live separately, while reserving this chapter.
        this.db.prepare("UPDATE publishing_chapters SET status='awaiting_receipt' WHERE package_id=? AND number=?")
          .run(run.packageId, run.chapterNumber);
      });
  }

  getMegaNovelRun(packageId: string, number: number): MegaNovelRun | undefined {
    const row = this.db.prepare('SELECT run_json FROM publishing_meganovel_runs WHERE package_id=? AND number=?')
      .get(HarnessIdSchema.parse(packageId), z.number().int().positive().parse(number));
    return row ? MegaNovelRunSchema.parse(JSON.parse(String(row.run_json))) : undefined;
  }

  /** A failed/negative migration read cannot identify the account of a historical manual attempt. */
  hasUnverifiedManualOrigin(packageId: string, chapterNumber: number): boolean {
    if (this.getMegaNovelRun(packageId, chapterNumber)?.evidence) return false;
    return Boolean(this.db.prepare(`SELECT 1 FROM publishing_events WHERE package_id=?
      AND json_extract(action_json,'$.chapterNumber')=? AND json_extract(action_json,'$.type')='begin' LIMIT 1`)
      .get(packageId, chapterNumber));
  }

  writeMegaNovelRun(input: {expectedVersion: number; eventId: string; run: MegaNovelRun;
    reconcileExistingManual?: boolean; readOnlyRebind?: boolean}): PublishingPackage {
    const run = MegaNovelRunSchema.parse(input.run);
    return this.change({...input, packageId: run.packageId, chapterNumber: run.chapterNumber},
      {type: 'meganovel', run, reconcileExistingManual: input.reconcileExistingManual === true,
        readOnlyRebind: input.readOnlyRebind === true}, (pkg, chapter) => {
        const selected = pkg.manifest.chapters.find(c => c.number === run.chapterNumber)!;
        const target = pkg.manifest.target;
        if (target.platform !== 'meganovel' || target.accountLabel !== run.scope.accountLabel
          || target.remoteBookId !== run.scope.remoteBookId || selected.revisionId !== run.revisionId) {
          throw publishingError('MEGANOVEL_TARGET_CONFLICT', 'Browser run differs from the frozen target or chapter.');
        }
        const existing = this.getMegaNovelRun(run.packageId, run.chapterNumber);
        if (!existing) {
          if (!['awaiting_submission', 'not_submitted_reported'].includes(chapter.status)
            && !(input.reconcileExistingManual === true && run.phase === 'submit_unknown'
              && (chapter.remoteChapterId === null || run.remoteChapterId === chapter.remoteChapterId))) {
            throw publishingError('PUBLISHING_RECONCILIATION_REQUIRED', 'A manual attempt exists; reconcile it before automation.');
          }
          this.assertChapterAvailable(pkg, run.chapterNumber);
          const reservations = this.db.prepare(`SELECT r.number, p.manifest_json FROM publishing_meganovel_runs r
            JOIN publishing_packages p ON p.id=r.package_id WHERE r.account_id=? AND r.remote_book_id=?`)
            .all(run.scope.accountId, run.scope.remoteBookId);
          const other = reservations.find(row => row.number === run.chapterNumber
            || PublishingManifestSchema.parse(JSON.parse(String(row.manifest_json))).chapters
              .some(c => c.number === row.number && c.artifactId === selected.artifactId));
          if (other) throw publishingError('PUBLISHING_RECONCILIATION_REQUIRED', 'This account/book/chapter or artifact already has a browser reservation.');
        } else {
          const previousScope = input.readOnlyRebind ? {...existing.scope, sessionId: ''} : existing.scope;
          const nextScope = input.readOnlyRebind ? {...run.scope, sessionId: ''} : run.scope;
          if (JSON.stringify(previousScope) !== JSON.stringify(nextScope) || existing.aiAssisted !== run.aiAssisted
            || existing.revisionId !== run.revisionId || existing.remoteChapterId && existing.remoteChapterId !== run.remoteChapterId) {
            throw publishingError('MEGANOVEL_RUN_CONFLICT', 'Cannot change the browser target, declaration, revision or remote identity of this attempt.');
          }
          if (!megaNovelTransitions[existing.phase].includes(run.phase)) throw publishingError('MEGANOVEL_RUN_CONFLICT', 'Cannot reset a possibly submitted chapter to allow another write.');
        }
        if (run.remoteChapterId) {
          const otherRuns = this.db.prepare(`SELECT run_json FROM publishing_meganovel_runs
            WHERE account_id=? AND remote_book_id=? AND NOT (package_id=? AND number=?)`)
            .all(run.scope.accountId, run.scope.remoteBookId, run.packageId, run.chapterNumber);
          const browserConflict = otherRuns.some(row =>
            MegaNovelRunSchema.parse(JSON.parse(String(row.run_json))).remoteChapterId === run.remoteChapterId);
          const manualConflict = this.db.prepare(`SELECT c.package_id FROM publishing_chapters c
            JOIN publishing_packages p ON p.id=c.package_id
            WHERE p.target_id=? AND c.remote_chapter_id=?
              AND NOT (c.package_id=? AND c.number=?)`)
            .get(target.id, run.remoteChapterId, run.packageId, run.chapterNumber);
          if (browserConflict || manualConflict) throw publishingError('PUBLISHING_CHAPTER_MAPPING_CONFLICT', 'This remote chapter ID already belongs to another local chapter.');
        }
        this.db.prepare('INSERT INTO publishing_meganovel_runs VALUES (?,?,?,?,?) ON CONFLICT(package_id,number) DO UPDATE SET run_json=excluded.run_json')
          .run(run.packageId, run.chapterNumber, run.scope.accountId, run.scope.remoteBookId, JSON.stringify(run));
        // Do not counterfeit manual provenance or promote remoteVerified on the original package.
        this.db.prepare(`UPDATE publishing_chapters SET status=CASE
          WHEN provenance='user_reported' AND status NOT IN ('awaiting_submission','not_submitted_reported')
          THEN status ELSE 'awaiting_receipt' END WHERE package_id=? AND number=?`)
          .run(run.packageId, run.chapterNumber);
      });
  }

  private assertNoBrowserRun(packageId: string, number: number) {
    if (this.getFanqieRun(packageId, number) || this.getMegaNovelRun(packageId, number)) throw publishingError('PUBLISHING_RECONCILIATION_REQUIRED',
      'A browser run owns this chapter. Manual receipts cannot clear or replace its reservation.');
  }
  private assertChapterAvailable(pkg: PublishingPackage, number: number, observedFanqieAccountId?: string) {
    const artifactId = pkg.manifest.chapters.find(chapter => chapter.number === number)!.artifactId;
    const reservations = this.db.prepare(`SELECT p.manifest_json, c.package_id, c.number, c.status
      FROM publishing_chapters c JOIN publishing_packages p ON p.id=c.package_id
      JOIN publishing_targets t ON t.id=p.target_id
      WHERE (p.target_id=? OR (t.platform='fanqie' AND t.remote_book_id=? AND ?='fanqie'
          AND (? IS NULL OR NOT EXISTS (SELECT 1 FROM publishing_fanqie_runs r
            WHERE r.package_id=c.package_id AND r.number=c.number AND r.account_id<>?)))
        OR (t.platform='meganovel' AND t.remote_book_id=? AND ?='meganovel'))
        AND c.package_id<>? AND c.status NOT IN ('awaiting_submission','not_submitted_reported')`)
      .all(pkg.manifest.target.id, pkg.manifest.target.remoteBookId, pkg.manifest.target.platform,
        observedFanqieAccountId ?? null, observedFanqieAccountId ?? null, pkg.manifest.target.remoteBookId, pkg.manifest.target.platform, pkg.manifest.id);
    const existing = reservations.find(row => {
      const manifest = PublishingManifestSchema.parse(JSON.parse(String(row.manifest_json)));
      if (manifest.target.id !== pkg.manifest.target.id && manifest.target.platform === 'meganovel'
        && this.getMegaNovelRun(String(row.package_id), Number(row.number))
        && !this.hasUnverifiedManualOrigin(String(row.package_id), Number(row.number))) return false;
      if (row.number === number) return true;
      return manifest.chapters.some(chapter => chapter.number === row.number && chapter.artifactId === artifactId);
    });
    if (existing) throw publishingError('PUBLISHING_RECONCILIATION_REQUIRED', `This chapter number or artifact already has a submission in package ${existing.package_id} (${existing.status}). Do not resubmit or renumber a different revision.`);
  }
  private change(input: {packageId: string; chapterNumber: number; expectedVersion: number; eventId: string}, action: object,
    apply: (pkg: PublishingPackage, chapter: PublishingPackage['chapters'][number]) => void): PublishingPackage {
    HarnessIdSchema.parse(input.packageId); HarnessIdSchema.parse(input.eventId);
    z.number().int().nonnegative().parse(input.expectedVersion);
    z.number().int().positive().parse(input.chapterNumber);
    const actionJson = JSON.stringify({chapterNumber: input.chapterNumber, expectedVersion: input.expectedVersion, ...action});
    return this.transaction(() => {
      const pkg = this.getPackage(input.packageId);
      const event = this.db.prepare('SELECT action_json FROM publishing_events WHERE package_id=? AND event_id=?')
        .get(input.packageId, input.eventId);
      if (event) {
        if (event.action_json !== actionJson) throw publishingError('PUBLISHING_EVENT_CONFLICT', 'The event ID was already used for a different action.');
        return pkg;
      }
      if (pkg.version !== input.expectedVersion) throw publishingError('PUBLISHING_VERSION_CONFLICT', 'Publishing state changed. Inspect it before continuing.');
      const chapter = pkg.chapters.find(c => c.number === input.chapterNumber);
      if (!chapter) throw publishingError('PUBLISHING_CHAPTER_MISSING', 'Chapter is not in this package.');
      apply(pkg, chapter);
      this.db.prepare('UPDATE publishing_packages SET version=version+1 WHERE id=?').run(input.packageId);
      this.db.prepare('INSERT INTO publishing_events VALUES (?,?,?,?)').run(input.packageId, input.eventId, actionJson, new Date().toISOString());
      return this.getPackage(input.packageId);
    });
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}
