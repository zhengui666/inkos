import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { publishingError } from './contracts.js';
import { ManualPublishingAdapter } from './manual-adapter.js';
import { PublishingStore } from './store.js';
import { FanqieIntentSchema, FanqieSnapshotSchema, FanqieInstantSchema,
  type FanqieIntent, type FanqieRun, type FanqieSnapshot, type FanqieBrowserPort } from './fanqie-contracts.js';

/** Protocol slice. Live DOM binding is deliberately not supplied until inspected in an authorized session. */
export class FanqiePublishingAdapter {
  constructor(private readonly packages: ManualPublishingAdapter, private readonly store: PublishingStore,
    private readonly browser: FanqieBrowserPort) {}

  async saveDraft(input: FanqieIntent): Promise<FanqieRun> {
    const intent = FanqieIntentSchema.parse(input);
    const {pkg, chapter, content} = await this.load(intent);
    const prior = this.matchRun(intent);
    const snapshot = await this.inspect(intent);
    const found = this.find(snapshot, {...chapter, content}, prior);
    if (prior) return found ? this.record(prior, found, pkg.version) : prior;
    const run: FanqieRun = {...intent, revisionId: chapter.revisionId, phase: 'draft_unknown',
      remoteChapterId: null, scheduledFor: null, evidence: null};
    if (found) return this.record(run, found, pkg.version);
    // Persist uncertainty before even typing: the editor may autosave before a Save click.
    this.write(run, pkg.version);
    try {
      await this.browser.createDraft({...intent, title: chapter.title, content, revisionId: chapter.revisionId});
    } catch {
      // A transport error is not proof of failure. Read back once; never retry the mutation.
    }
    return this.reconcile(intent);
  }

  async schedule(input: FanqieIntent & {scheduledFor: string}): Promise<FanqieRun> {
    const intent = FanqieIntentSchema.parse({packageId: input.packageId, chapterNumber: input.chapterNumber,
      scope: input.scope, aiAssisted: input.aiAssisted});
    const scheduledFor = FanqieInstantSchema.parse(input.scheduledFor);
    const {pkg, chapter, content} = await this.load(intent);
    const prior = this.matchRun(intent);
    if (!prior) throw publishingError('FANQIE_DRAFT_REQUIRED', 'Save and verify this frozen chapter as a draft first.');
    if (prior.scheduledFor && Date.parse(prior.scheduledFor) !== Date.parse(scheduledFor)) {
      throw publishingError('FANQIE_RUN_CONFLICT', 'A different schedule requires a separate, explicitly authorized edit workflow.');
    }
    const snapshot = await this.inspect(intent);
    const found = this.find(snapshot, {...chapter, content}, prior);
    if (prior.phase !== 'draft') return found ? this.record(prior, found, pkg.version) : prior;
    if (!found || found.status !== 'draft') {
      if (found) return this.record(prior, found, pkg.version);
      throw publishingError('FANQIE_READBACK_REQUIRED', 'The verified draft is no longer visible. Do not submit again.');
    }
    if (!snapshot.schedulingAvailable) throw publishingError('FANQIE_SCHEDULE_UNAVAILABLE', 'This book/session does not expose scheduled publishing.');
    if (Date.parse(scheduledFor) <= Date.now()) throw publishingError('FANQIE_INVALID_SCHEDULE', 'Choose a future time with an explicit UTC offset.');
    if (found.aiAssisted !== intent.aiAssisted) throw publishingError('FANQIE_DECLARATION_UNVERIFIED', 'Verify the truthful AI declaration before scheduling.');
    const run: FanqieRun = {...prior, phase: 'schedule_unknown', scheduledFor};
    this.write(run, pkg.version);
    try {
      await this.browser.schedule({...intent, remoteChapterId: found.remoteChapterId,
        content, revisionId: chapter.revisionId, scheduledFor});
    } catch {
      // Unknown outcome stays durable until an independent read observes the requested state/time.
    }
    return this.reconcile(intent);
  }

  async reconcile(input: FanqieIntent): Promise<FanqieRun> {
    const intent = FanqieIntentSchema.parse(input);
    const {pkg, chapter, content} = await this.load(intent);
    const prior = this.matchRun(intent);
    if (!prior) throw publishingError('FANQIE_RUN_MISSING', 'No browser attempt exists for this frozen chapter.');
    const found = this.find(await this.inspect(intent), {...chapter, content}, prior);
    // Even a complete negative read cannot safely prove a timed-out request will never arrive.
    return found ? this.record(prior, found, pkg.version) : prior;
  }

  private async load(intent: FanqieIntent) {
    const {directory, package: pkg} = await this.packages.verify(intent.packageId);
    const target = pkg.manifest.target;
    if (target.platform !== 'fanqie' || target.accountLabel !== intent.scope.accountLabel
      || target.remoteBookId !== intent.scope.remoteBookId) throw publishingError('FANQIE_TARGET_CONFLICT', 'The explicit session/account/book must match the frozen target.');
    const chapter = pkg.manifest.chapters.find(c => c.number === intent.chapterNumber);
    if (!chapter) throw publishingError('PUBLISHING_CHAPTER_MISSING', 'Select one chapter in this frozen package.');
    const bytes = await readFile(join(directory, chapter.packagePath));
    const content = bytes.toString('utf8');
    if (!Buffer.from(content).equals(bytes)) throw publishingError('FANQIE_ENCODING_UNSUPPORTED', 'Frozen content must be losslessly representable as UTF-8.');
    return {pkg, chapter, content};
  }

  private matchRun(intent: FanqieIntent) {
    const run = this.store.getFanqieRun(intent.packageId, intent.chapterNumber);
    if (run && (JSON.stringify(run.scope) !== JSON.stringify(intent.scope) || run.aiAssisted !== intent.aiAssisted)) {
      throw publishingError('FANQIE_RUN_CONFLICT', 'This run belongs to another session or AI declaration.');
    }
    return run;
  }
  private async inspect(intent: FanqieIntent): Promise<FanqieSnapshot> {
    const snapshot = FanqieSnapshotSchema.parse(await this.browser.snapshot(intent.scope));
    if (JSON.stringify(snapshot.scope) !== JSON.stringify(intent.scope)) throw publishingError('FANQIE_SCOPE_CHANGED', 'Browser session/account/book changed.');
    if (snapshot.blocker !== 'none') throw publishingError('FANQIE_BROWSER_BLOCKED', `Stop at ${snapshot.blocker}; do not bypass or accept it.`);
    return snapshot;
  }
  private find(snapshot: FanqieSnapshot, chapter: {number: number; title: string; content: string}, prior?: FanqieRun) {
    if (!snapshot.complete) throw publishingError('FANQIE_INCOMPLETE_INVENTORY', 'Readback must cover every draft/review/published page to exclude duplicate matches.');
    const matches = snapshot.chapters.filter(c => c.number === chapter.number || c.remoteChapterId === prior?.remoteChapterId);
    if (matches.length > 1) throw publishingError('FANQIE_DUPLICATE_CHAPTER', 'Multiple rows match this chapter; resolve the ambiguity without writing.');
    const found = matches[0];
    if (found && (found.number !== chapter.number || found.title !== chapter.title || found.content !== chapter.content
      || prior?.remoteChapterId && prior.remoteChapterId !== found.remoteChapterId)) {
      throw publishingError('FANQIE_CONTENT_CONFLICT', 'The remote chapter identity/title/content differs from the frozen revision.');
    }
    return found;
  }
  private record(run: FanqieRun, found: FanqieSnapshot['chapters'][number], version: number) {
    if (run.phase === 'schedule_unknown' && found.status === 'draft') return run;
    if (found.status !== 'draft' && found.aiAssisted !== run.aiAssisted) {
      throw publishingError('FANQIE_DECLARATION_UNVERIFIED', 'Remote submission does not verify the truthful AI declaration.');
    }
    // A published detail page may omit the original schedule. Retain an independently verified
    // historical schedule without pretending the new page displayed it. Unknown attempts get no exception.
    const publishedAfterVerifiedSchedule = found.status === 'published' && found.scheduledFor === null
      && ['reviewing', 'scheduled', 'published'].includes(run.phase);
    if (run.scheduledFor && found.status !== 'draft' && !publishedAfterVerifiedSchedule
      && (!found.scheduledFor || Date.parse(run.scheduledFor) !== Date.parse(found.scheduledFor))) {
      throw publishingError('FANQIE_SCHEDULE_CONFLICT', 'Readback does not confirm the requested scheduled instant.');
    }
    const next: FanqieRun = {...run, phase: found.status, remoteChapterId: found.remoteChapterId,
      scheduledFor: run.scheduledFor ?? found.scheduledFor, evidence: found.evidence};
    this.write(next, version);
    return next;
  }
  private write(run: FanqieRun, expectedVersion: number) {
    this.store.writeFanqieRun({run, expectedVersion, eventId: randomUUID()});
  }
}
