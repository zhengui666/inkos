import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chapterDocumentBody } from '../utils/chapter-document.js';
import { publishingError } from './contracts.js';
import {compareMegaNovelChapter} from './meganovel-observation.js';
import { ManualPublishingAdapter } from './manual-adapter.js';
import { PublishingStore } from './store.js';
import { MegaNovelIntentSchema, MegaNovelProbeSchema, MegaNovelScopeSchema, MegaNovelSnapshotSchema,
  type MegaNovelIntent, type MegaNovelRun, type MegaNovelScope, type MegaNovelSnapshot,
  type MegaNovelBrowserPort } from './meganovel-contracts.js';

/** Durable single-chapter adapter. A concrete calibrated UI binding is a separate deployment prerequisite. */
export interface MegaNovelOperationOptions { signal?: AbortSignal; beforeMutation?: () => Promise<void> }

export class MegaNovelPublishingAdapter {
  constructor(private readonly packages: ManualPublishingAdapter, private readonly store: PublishingStore,
    private readonly browser: MegaNovelBrowserPort) {}

  async ready(input: MegaNovelScope, options: MegaNovelOperationOptions = {}): Promise<void> {
    options.signal?.throwIfAborted();
    const scope = MegaNovelScopeSchema.parse(input);
    this.assertProbe(MegaNovelProbeSchema.parse(await this.browser.probe(scope, options)), scope);
    options.signal?.throwIfAborted();
  }

  async saveDraft(input: MegaNovelIntent, options: MegaNovelOperationOptions = {}): Promise<MegaNovelRun> {
    options.signal?.throwIfAborted();
    const intent = MegaNovelIntentSchema.parse(input);
    const {pkg, chapter, content} = await this.load(intent);
    options.signal?.throwIfAborted();
    const prior = this.matchRun(intent);
    const found = this.find(await this.inspect(intent, chapter.title, prior, options), {...chapter, content}, prior);
    options.signal?.throwIfAborted();
    if (prior) return found ? this.record(prior, found, pkg.version) : prior;
    const run: MegaNovelRun = {...intent, revisionId: chapter.revisionId, phase: 'draft_unknown',
      remoteChapterId: null, evidence: null};
    if (found) return this.record(run, found, pkg.version);
    await options.beforeMutation?.();
    options.signal?.throwIfAborted();
    this.write(run, pkg.version); // Reserve before any editor input, including autosave.
    try {
      await this.browser.createDraft({...intent, title: chapter.title, content, revisionId: chapter.revisionId}, options);
    } catch {
      // A transport error cannot prove absence. Only a separate read may resolve this reservation.
    }
    // Once a mutation started, drain its independent readback even if the parent was stopped.
    return this.reconcile(intent);
  }

  async submit(input: MegaNovelIntent, options: MegaNovelOperationOptions = {}): Promise<MegaNovelRun> {
    options.signal?.throwIfAborted();
    const intent = MegaNovelIntentSchema.parse(input);
    const {pkg, chapter, content} = await this.load(intent);
    options.signal?.throwIfAborted();
    const prior = this.matchRun(intent);
    if (!prior) throw publishingError('MEGANOVEL_DRAFT_REQUIRED', 'Save and independently verify this frozen chapter first.');
    const found = this.find(await this.inspect(intent, chapter.title, prior, options), {...chapter, content}, prior);
    options.signal?.throwIfAborted();
    if (prior.phase !== 'draft') return found ? this.record(prior, found, pkg.version) : prior;
    if (!found) throw publishingError('MEGANOVEL_READBACK_REQUIRED', 'The verified draft is no longer visible. Do not submit again.');
    if (found.status !== 'draft') return this.record(prior, found, pkg.version);
    this.assertDisclosure(found.aiDisclosure, intent.aiAssisted);
    await options.beforeMutation?.();
    options.signal?.throwIfAborted();
    this.write({...prior, phase: 'submit_unknown'}, pkg.version);
    try {
      await this.browser.submit({...intent, remoteChapterId: found.remoteChapterId,
        title: chapter.title, content, revisionId: chapter.revisionId}, options);
    } catch {
      // No mutation retry, even if the browser reports a timeout or closes before acknowledging.
    }
    return this.reconcile(intent);
  }

  async reconcile(input: MegaNovelIntent, options: MegaNovelOperationOptions = {}): Promise<MegaNovelRun> {
    options.signal?.throwIfAborted();
    const intent = MegaNovelIntentSchema.parse(input);
    const {pkg, chapter, content} = await this.load(intent);
    options.signal?.throwIfAborted();
    let prior = this.matchRun(intent, true);
    let version = pkg.version;
    if (!prior) {
      // Read-only adoption of chapters submitted outside this adapter, including a historical unknown.
      // Reserve first; an absent lookup must never turn an uncertain old attempt into a fresh write.
      const manual = pkg.chapters.find(c => c.number === intent.chapterNumber)!;
      prior = {...intent, revisionId: chapter.revisionId,
        phase: ['awaiting_submission', 'not_submitted_reported'].includes(manual.status) ? 'draft_unknown' : 'submit_unknown',
        remoteChapterId: manual.remoteChapterId, evidence: null};
      version = this.store.writeMegaNovelRun({run: prior, expectedVersion: pkg.version,
        eventId: randomUUID(), reconcileExistingManual: true}).version;
    }
    const found = this.find(await this.inspect(intent, chapter.title, prior, options), {...chapter, content}, prior);
    options.signal?.throwIfAborted();
    // A negative lookup cannot prove that a timed-out autosave/submission will never arrive.
    return found ? this.record(prior, found, version, true) : prior;
  }

  private async load(intent: MegaNovelIntent) {
    const {directory, package: pkg} = await this.packages.verify(intent.packageId);
    const target = pkg.manifest.target;
    if (target.platform !== 'meganovel' || target.accountLabel !== intent.scope.accountLabel
      || target.remoteBookId !== intent.scope.remoteBookId) {
      throw publishingError('MEGANOVEL_TARGET_CONFLICT', 'The explicit account/book must match the frozen target.');
    }
    const chapter = pkg.manifest.chapters.find(c => c.number === intent.chapterNumber);
    if (!chapter) throw publishingError('PUBLISHING_CHAPTER_MISSING', 'Select one chapter in this frozen package.');
    const bytes = await readFile(join(directory, chapter.packagePath));
    const document = bytes.toString('utf8');
    if (!Buffer.from(document).equals(bytes)) throw publishingError('MEGANOVEL_ENCODING_UNSUPPORTED', 'Frozen text must be lossless UTF-8.');
    const language = pkg.manifest.language;
    if (language !== 'en' && language !== 'zh') throw publishingError('MEGANOVEL_LANGUAGE_UNSUPPORTED', 'The observed separate-title editor requires an explicit supported document language.');
    // Observed MegaNovel UI has a separate title input and TinyMCE body. Preserve the frozen
    // document/revision; use the shared deterministic document-wrapper transform for both write/readback.
    const content = chapterDocumentBody(document, chapter.number, chapter.title, language);
    if (!content.trim()) throw publishingError('PUBLISHING_EMPTY_CHAPTER', 'The frozen document has no body after its formal chapter heading.');
    return {pkg, chapter, content};
  }
  private matchRun(intent: MegaNovelIntent, readOnlyRebind = false) {
    const run = this.store.getMegaNovelRun(intent.packageId, intent.chapterNumber);
    const comparable = (scope: MegaNovelScope) => readOnlyRebind ? {...scope, sessionId: ''} : scope;
    if (run && (JSON.stringify(comparable(run.scope)) !== JSON.stringify(comparable(intent.scope)) || run.aiAssisted !== intent.aiAssisted)) {
      throw publishingError('MEGANOVEL_RUN_CONFLICT', 'This attempt belongs to another browser target/account or AI declaration.');
    }
    return run && readOnlyRebind ? {...run, scope: intent.scope} : run;
  }
  private assertProbe(probe: {scope: MegaNovelScope; blocker: string}, scope: MegaNovelScope) {
    if (JSON.stringify(probe.scope) !== JSON.stringify(scope)) throw publishingError('MEGANOVEL_SCOPE_CHANGED', 'Browser target/account/book changed.');
    if (probe.blocker !== 'none') throw publishingError('MEGANOVEL_BROWSER_BLOCKED', `Stop at ${probe.blocker}; do not bypass or accept it.`);
  }
  private async inspect(intent: MegaNovelIntent, expectedTitle: string, prior?: MegaNovelRun,
    options: MegaNovelOperationOptions = {}): Promise<MegaNovelSnapshot> {
    const snapshot = MegaNovelSnapshotSchema.parse(await this.browser.snapshot({...intent,
      expectedTitle, ...(prior?.remoteChapterId ? {remoteChapterId: prior.remoteChapterId} : {})}, options));
    this.assertProbe(snapshot, intent.scope);
    if (snapshot.chapterNumber !== intent.chapterNumber) throw publishingError('MEGANOVEL_SCOPE_CHANGED', 'Readback concerns a different chapter.');
    return snapshot;
  }
  private find(snapshot: MegaNovelSnapshot, chapter: {number: number; title: string; content: string}, prior?: MegaNovelRun) {
    const comparison = compareMegaNovelChapter(snapshot, chapter, prior?.remoteChapterId ?? undefined);
    if (comparison.errors.length) {
      const failure = comparison.errors[0]!;
      throw publishingError(failure.code, failure.message);
    }
    return snapshot.candidates[0];
  }

  private assertDisclosure(disclosure: string, aiAssisted: boolean) {
    if (disclosure === 'unverified' || disclosure !== 'not_present'
      && disclosure !== (aiAssisted ? 'declared_ai' : 'declared_human')) {
      throw publishingError('MEGANOVEL_DISCLOSURE_UNVERIFIED', 'Verify the current UI and truthful AI declaration before submission.');
    }
  }
  private record(run: MegaNovelRun, found: MegaNovelSnapshot['candidates'][number], version: number, readOnlyRebind = false) {
    if (run.phase === 'submit_unknown' && found.status === 'draft') return run;
    if (found.status !== 'draft') this.assertDisclosure(found.aiDisclosure, run.aiAssisted);
    const next: MegaNovelRun = {...run, phase: found.status, remoteChapterId: found.remoteChapterId, evidence: found.evidence};
    this.store.writeMegaNovelRun({run: next, expectedVersion: version, eventId: randomUUID(), readOnlyRebind});
    return next;
  }
  private write(run: MegaNovelRun, expectedVersion: number) {
    this.store.writeMegaNovelRun({run, expectedVersion, eventId: randomUUID()});
  }
}
