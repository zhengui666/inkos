import { readChapterReviewInputs, readChapterReviewInputsSync, sameChapterReviewInputs } from "../pipeline/review-inputs.js";
import { join, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { SchedulerPublisher } from '../pipeline/autonomous-chapters.js';
import { StateManager } from '../state/manager.js';
import { loadWorkManifest } from '../harness/work-store.js';
import { runInWorkMutationQueue, withWorkMutationScope } from '../utils/work-mutation-scope.js';
import { ManualPublishingAdapter } from './manual-adapter.js';
import { PublishingStore } from './store.js';
import { MegaNovelPublishingAdapter } from './meganovel-adapter.js';
import { publishingError, type PublishingPackage } from './contracts.js';
import { MegaNovelScopeSchema, type MegaNovelBrowserPort, type MegaNovelScope, type MegaNovelRun } from './meganovel-contracts.js';
import type { MegaNovelCdpConfiguration, MegaNovelDomBinding } from './meganovel-cdp.js';
import { createMegaNovelDomBinding, MegaNovelDomConfigurationSchema } from './meganovel-dom-binding.js';
import { createPublisherCleanup, PublisherStartupCleanupError } from './publisher-cleanup.js';

export interface SchedulerPublishingBinding {
  workId: string; targetId: string; scope: MegaNovelScope; aiAssisted: boolean;
  /** Chapters below this boundary already existed when automation was enabled; reconcile only. */
  firstNewChapter: number;
  /** Known author/public detail identities, still independently verified by readback. */
  historicalChapterIds?: Readonly<Record<number, string>>;
  /** Explicit unresolved canonical replay identified during deployment. Read receipt only; never commit it here. */
  requiredStateReplay?: {chapterNumber: number; planId: string};
  browser: MegaNovelBrowserPort & { close?(): Promise<void> };
}

/** No account guessing and no fresh upload to resolve historical/manual uncertainty. */
export function createMegaNovelSchedulerPublisher(root: string, bindings: readonly SchedulerPublishingBinding[]): SchedulerPublisher & { close(): Promise<void> } {
  for (const binding of bindings) {
    validateHistoricalBoundary(binding.firstNewChapter, binding.historicalChapterIds);
    if (binding.requiredStateReplay) z.object({chapterNumber: z.number().int().positive(), planId: z.string().min(1)})
      .parse(binding.requiredStateReplay);
  }
  const byWork = new Map(bindings.map(binding => [binding.workId, binding]));
  if (byWork.size !== bindings.length) throw new Error('Select one publication destination per work.');
  const store = new PublishingStore(join(root, '.inkos', 'harness.sqlite'));
  const packages = new ManualPublishingAdapter(root, store), state = new StateManager(root);
  const cleanup = createPublisherCleanup(() => [bindings.map(binding => binding.browser), [store]]);
  const requireBinding = (workId: string) => {
    if (cleanup.requested) throw publishingError('PUBLISHING_CLOSED', 'The configured publisher has closed.');
    const binding = byWork.get(workId);
    if (!binding) throw publishingError('PUBLISHING_BINDING_MISSING', `No configured publication destination for ${workId}.`);
    const target = store.getTarget(binding.targetId);
    if (target.workId !== workId || target.platform !== 'meganovel' || target.accountLabel !== binding.scope.accountLabel
      || target.remoteBookId !== binding.scope.remoteBookId) throw publishingError('PUBLISHING_TARGET_CONFLICT', 'Configured binding differs from the retained target.');
    return binding;
  };
  const adapter = (binding: SchedulerPublishingBinding) => new MegaNovelPublishingAdapter(packages, store, binding.browser);
  const requireCanonicalReplay = async (binding: SchedulerPublishingBinding) => {
    const required = binding.requiredStateReplay;
    if (!required) return;
    let receipt: unknown;
    try {
      receipt = JSON.parse(await readFile(join(state.bookDir(binding.workId), 'story', 'runtime',
        `chapter-${String(required.chapterNumber).padStart(4, '0')}.state-replay.json`), 'utf8'));
    } catch {
      throw publishingError('PUBLISHING_CANONICAL_REPLAY_REQUIRED', 'The explicitly required canonical replay has no readable commit receipt. No new writing or submission is permitted.');
    }
    const parsed = z.object({planId: z.literal(required.planId), chapterNumber: z.literal(required.chapterNumber),
      validation: z.object({consistent: z.literal(true), reconciliationRequired: z.literal(false)})}).safeParse(receipt);
    if (!parsed.success) throw publishingError('PUBLISHING_CANONICAL_REPLAY_REQUIRED', 'The canonical replay receipt does not match the explicitly required plan and chapter.');
  };
  const existingPackage = (binding: SchedulerPublishingBinding, chapter: number): PublishingPackage | undefined => {
    const candidates = store.listPackages(binding.targetId).filter(pkg => pkg.manifest.chapters.some(item => item.number === chapter));
    const attempted = candidates.filter(pkg => store.getMegaNovelRun(pkg.manifest.id, chapter)
      || !['awaiting_submission', 'not_submitted_reported'].includes(pkg.chapters.find(item => item.number === chapter)!.status));
    if (attempted.length > 1) throw publishingError('PUBLISHING_RECONCILIATION_REQUIRED', 'Multiple retained attempts need review; no new package was selected.');
    return attempted[0];
  };
  const freeze = (binding: SchedulerPublishingBinding, chapterNumber: number, expectedRevision?: string) =>
    runInWorkMutationQueue(`${resolve(root)}\0${binding.workId}`, () => withWorkMutationScope(root, binding.workId,
      () => state.acquireBookLock(binding.workId), async () => {
        const meta = (await state.loadChapterIndex(binding.workId)).find(item => item.number === chapterNumber);
        if (!meta) throw new Error(`Retained chapter ${chapterNumber} is missing.`);
        const work = await loadWorkManifest(root, binding.workId);
        const prefix = `source/chapters/${String(chapterNumber).padStart(4, '0')}_`;
        const matches = work.artifacts.flatMap(artifact => artifact.revisions
          .filter(revision => revision.id === artifact.currentRevisionId && revision.path.startsWith(prefix) && revision.path.endsWith('.md'))
          .map(revision => ({ artifact, revision })));
        if (matches.length !== 1) throw new Error('Publication requires one retained chapter revision.');
        const { artifact, revision } = matches[0]!;
        if (expectedRevision && revision.id !== expectedRevision) throw publishingError('CHAPTER_REVISION_CHANGED', 'Chapter changed after review; publish the newly reviewed revision only.');
        const current = await readFile(join(root, 'works', binding.workId, revision.path));
        if (!revision.snapshotPath || !current.equals(await readFile(join(root, 'works', binding.workId, revision.snapshotPath)))) {
          throw publishingError('CHAPTER_REVISION_CHANGED', 'Unregistered chapter edits remain; no stale package was prepared.');
        }
        return packages.prepare({ targetId: binding.targetId, formats: ['txt'], chapters: [{ artifactId: artifact.id,
          revisionId: revision.id, number: chapterNumber, title: meta.title }] });
      }));
  const intent = (binding: SchedulerPublishingBinding, pkg: PublishingPackage, chapterNumber: number) => ({
    packageId: pkg.manifest.id, chapterNumber, scope: binding.scope, aiAssisted: binding.aiAssisted,
  });
  const view = (run: MegaNovelRun) => {
    if (run.phase === 'rejected') throw publishingError('PUBLISHING_REJECTED', 'Platform rejected this retained chapter; inspect its readback before editing or resubmitting.');
    return { status: run.phase === 'published' ? 'published' as const
      : ['submitted', 'reviewing'].includes(run.phase) ? 'submitted' as const : 'pending' as const,
      ...(run.remoteChapterId ? { remoteChapterId: run.remoteChapterId } : {}), ...(run.evidence ? { evidence: run.evidence } : {}) };
  };
  return {
    async reconcile(input) {
      input.signal.throwIfAborted();
      const binding = requireBinding(input.workId);
      await requireCanonicalReplay(binding);
      const prior = existingPackage(binding, input.chapterNumber);
      if (!prior) return undefined;
      const run = await adapter(binding).reconcile(intent(binding, prior, input.chapterNumber), { signal: input.signal });
      return run.phase === 'draft' ? { status: 'draft' } : view(run);
    },
    async ready(workId, signal, continuingChapter) {
      signal.throwIfAborted();
      const binding = requireBinding(workId), remote = adapter(binding);
      await requireCanonicalReplay(binding);
      for (const pkg of store.listPackages()) {
        if (pkg.manifest.target.id === binding.targetId || pkg.manifest.target.platform !== 'meganovel'
          || pkg.manifest.target.remoteBookId !== binding.scope.remoteBookId) continue;
        if (pkg.chapters.some(chapter => {
          const run = store.getMegaNovelRun(pkg.manifest.id, chapter.number);
          return store.hasUnverifiedManualOrigin(pkg.manifest.id, chapter.number) || (run ? run.scope.accountId === binding.scope.accountId
            : !['awaiting_submission', 'not_submitted_reported'].includes(chapter.status));
        })) throw publishingError('PUBLISHING_RECONCILIATION_REQUIRED', 'A chapter attempt exists under another local target for this platform book. Reconcile its original mapping before new writing.');
      }
      await remote.ready(binding.scope, { signal });
      // Existing author-operated chapters are migrated through readback of the
      // original target/package, never treated as first-time submissions.
      const index = await state.loadChapterIndex(workId);
      const attemptedNumbers = new Set(store.listPackages(binding.targetId).flatMap(pkg => pkg.chapters
        .filter(chapter => store.getMegaNovelRun(pkg.manifest.id, chapter.number)
          || !['awaiting_submission', 'not_submitted_reported'].includes(chapter.status))
        .map(chapter => chapter.number)));
      const history = index.filter(item => item.number < binding.firstNewChapter
        || attemptedNumbers.has(item.number) && item.number !== continuingChapter);
      if ([...attemptedNumbers].some(number => !index.some(chapter => chapter.number === number))) {
        throw publishingError('PUBLISHING_RECONCILIATION_REQUIRED', 'A retained platform attempt has no local indexed chapter. Reconcile it before new writing.');
      }
      for (const chapter of history) {
        signal.throwIfAborted();
        const pkg = existingPackage(binding, chapter.number) ?? await freeze(binding, chapter.number);
        const knownId = binding.historicalChapterIds?.[chapter.number];
        if (knownId && !store.getMegaNovelRun(pkg.manifest.id, chapter.number)) {
          const selected = pkg.manifest.chapters.find(item => item.number === chapter.number)!;
          // Keep a known identity in an UNKNOWN reservation. This is not a
          // publication receipt; the reopened detail must prove status/body.
          store.writeMegaNovelRun({ expectedVersion: pkg.version, eventId: randomUUID(), reconcileExistingManual: true,
            run: { ...intent(binding, pkg, chapter.number), revisionId: selected.revisionId,
              phase: 'submit_unknown', remoteChapterId: knownId, evidence: null } });
        }
        const observed = await remote.reconcile(intent(binding, pkg, chapter.number), { signal });
        if (observed.phase !== 'published') throw publishingError('PUBLISHING_HISTORY_PENDING', `Existing chapter ${chapter.number} is ${observed.phase}; no new writing was started.`);
      }
    },
    async publish(input) {
      input.signal.throwIfAborted();
      const binding = requireBinding(input.workId), remote = adapter(binding);
      await requireCanonicalReplay(binding);
      const prior = existingPackage(binding, input.chapterNumber);
      let pkg = prior;
      let run: MegaNovelRun | undefined;
      if (prior) {
        run = await remote.reconcile(intent(binding, prior, input.chapterNumber), { signal: input.signal });
        if (run.phase !== 'draft') return view(run);
      }
      const beforeMutation = async () => {
        input.signal.throwIfAborted();
        await input.beforeMutation?.();
        if (!sameChapterReviewInputs(input.reviewInputs, await readChapterReviewInputs(state.bookDir(input.workId), input.chapterNumber))) {
          throw publishingError('CHAPTER_REVIEW_INPUTS_CHANGED', 'A current input-bound review is required before a new remote mutation.');
        }
        const work = await loadWorkManifest(root, binding.workId);
        const prefix = `source/chapters/${String(input.chapterNumber).padStart(4, '0')}_`;
        const revisions = work.artifacts.flatMap(artifact => artifact.revisions.filter(revision =>
          revision.id === artifact.currentRevisionId && revision.path.startsWith(prefix) && revision.path.endsWith('.md')));
        const revision = revisions[0];
        if (revisions.length !== 1 || revision?.id !== input.revisionId || !revision.snapshotPath
          || !(await readFile(join(root, 'works', binding.workId, revision.path))).equals(
            await readFile(join(root, 'works', binding.workId, revision.snapshotPath)))) {
          throw publishingError('CHAPTER_REVISION_CHANGED', 'Chapter changed after review; no new remote mutation was made.');
        }
        input.signal.throwIfAborted();
      };
      const authorizeSubmission = () => {
        input.signal.throwIfAborted();
        if (!sameChapterReviewInputs(input.reviewInputs, readChapterReviewInputsSync(state.bookDir(input.workId), input.chapterNumber))) {
          throw publishingError('CHAPTER_REVIEW_INPUTS_CHANGED', 'Review authority changed before the final submission request.');
        }
        input.authorizeSubmission?.();
      };
      if (!pkg) {
        if (input.chapterNumber >= binding.firstNewChapter) await beforeMutation();
        pkg = await freeze(binding, input.chapterNumber, input.revisionId);
      }
      const selected = pkg.manifest.chapters.find(item => item.number === input.chapterNumber)!;
      const request = intent(binding, pkg, input.chapterNumber);
      if (selected.revisionId !== input.revisionId) throw publishingError('PUBLISHING_RECONCILIATION_REQUIRED', 'An older frozen revision has a publication attempt; it was read back without sending the edited chapter.');
      run ??= input.chapterNumber < binding.firstNewChapter
        ? await remote.reconcile(request, { signal: input.signal })
        : await remote.saveDraft(request, { signal: input.signal, beforeMutation });
      input.signal.throwIfAborted();
      if (run.phase === 'draft' && input.chapterNumber >= binding.firstNewChapter) {
        run = await remote.submit(request, { signal: input.signal, beforeMutation, authorizeSubmission });
      }
      return view(run);
    },
    close: () => cleanup.close(),
  };
}

export const MegaNovelSchedulerBindingConfigurationSchema = z.object({
  workId: z.string().min(1), targetId: z.string().min(1), firstNewChapter: z.number().int().positive(),
  historicalChapterIds: z.record(z.string().regex(/^[1-9]\d*$/), z.string().min(1)).optional(),
  requiredStateReplay: z.object({chapterNumber: z.number().int().positive(), planId: z.string().min(1)}).strict().optional(),
  aiAssisted: z.boolean(), scope: MegaNovelScopeSchema, endpointURL: z.string().min(1), lockDirectory: z.string().min(1),
  domBindingModule: z.string().min(1).optional(),
  dom: MegaNovelDomConfigurationSchema.optional(), authorization: z.object({
    automation: z.object({ provenance: z.enum(['user_reported','platform_document']), reference: z.string().min(1) }).strict(),
    aiAssistedContent: z.object({ provenance: z.enum(['user_reported','platform_document']), reference: z.string().min(1) }).strict(),
  }).strict(),
  timeoutMs: z.number().optional(), operationTimeoutMs: z.number().optional(),
}).strict().superRefine((config, ctx) => {
  try { validateHistoricalBoundary(config.firstNewChapter, config.historicalChapterIds); }
  catch (error) { ctx.addIssue({code: z.ZodIssueCode.custom, message: String(error)}); }
  if (config.domBindingModule && config.dom) ctx.addIssue({code: z.ZodIssueCode.custom,
    message: 'Choose the built-in DOM configuration or an explicit binding module, not both.'});
  for (const chapter of config.dom?.knownChapters ?? []) {
    const configuredId = config.historicalChapterIds?.[chapter.number];
    if (configuredId && configuredId !== chapter.remoteChapterId) ctx.addIssue({code: z.ZodIssueCode.custom,
      message: 'Historical chapter IDs must agree with independently observed DOM identities.'});
    if (chapter.number >= config.firstNewChapter) ctx.addIssue({code: z.ZodIssueCode.custom,
      message: 'An independently known chapter must be below the first-new-chapter boundary.'});
  }
});

function validateHistoricalBoundary(firstNewChapter: number, historicalChapterIds?: Readonly<Record<number, string>>) {
  if (!Number.isSafeInteger(firstNewChapter) || firstNewChapter < 1) throw publishingError('PUBLISHING_HISTORY_BOUNDARY', 'The first new chapter must be a positive integer.');
  const entries = Object.entries(historicalChapterIds ?? {});
  if (entries.some(([number, id]) => !/^[1-9]\d*$/u.test(number) || Number(number) >= firstNewChapter || !id.trim())
    || new Set(entries.map(([, id]) => id)).size !== entries.length) {
    throw publishingError('PUBLISHING_HISTORY_BOUNDARY', 'Every known historical chapter must be below the first-new boundary and have a unique remote ID.');
  }
}

/** Loads explicit local deployment configuration; never launches or signs in a browser. */
export async function loadMegaNovelSchedulerPublisher(root: string, configurationPath: string) {
  return createMegaNovelSchedulerPublisherFromConfiguration(root, JSON.parse(await readFile(configurationPath, 'utf8')));
}

/** Shared by the legacy loader and the provider registry; preserves the same transport and driver. */
export async function createMegaNovelSchedulerPublisherFromConfiguration(root: string, input: unknown) {
  const configurations = z.array(MegaNovelSchedulerBindingConfigurationSchema).min(1).parse(input);
  const bindings: SchedulerPublishingBinding[] = [];
  const unfinishedLoaders = new Set<{ close(): Promise<void> }>();
  const cleanup = createPublisherCleanup(() => [[...bindings.map(binding => binding.browser), ...unfinishedLoaders]]);
  try {
    for (const config of configurations) {
      const { domBindingModule, dom, workId, targetId, firstNewChapter, historicalChapterIds, requiredStateReplay, aiAssisted, ...transport } = config;
      const binding = domBindingModule
        ? (await import(pathToFileURL(resolve(root, domBindingModule)).href) as { default?: MegaNovelDomBinding }).default
        : createMegaNovelDomBinding(dom);
      const { connectMegaNovelCdpPort } = await import('./meganovel-cdp.js');
      const browser = await connectMegaNovelCdpPort(transport as MegaNovelCdpConfiguration, binding);
      const knownIds = Object.fromEntries((dom?.knownChapters ?? []).map(chapter => [chapter.number, chapter.remoteChapterId]));
      bindings.push({ workId, targetId, firstNewChapter, historicalChapterIds: {...knownIds, ...historicalChapterIds}, requiredStateReplay, aiAssisted, scope: config.scope, browser });
    }
    return createMegaNovelSchedulerPublisher(root, bindings);
  } catch (error) {
    try { await cleanup.close(); }
    catch (cleanupError) {
      if (error instanceof PublisherStartupCleanupError) unfinishedLoaders.add(error.cleanup);
      throw new PublisherStartupCleanupError(error, cleanupError, cleanup);
    }
    throw error;
  }
}
