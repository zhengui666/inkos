import { isCreationTransientFailure } from './transient.js';
import { CreationPlannerAgent } from './planner.js';
import { verifyCreationFoundation } from './foundation-recovery.js';
import { join, resolve } from 'node:path';
import type { PipelineRunner } from '../pipeline/runner.js';
import type { SchedulerStore, ScheduledChapter } from '../pipeline/scheduler-store.js';
import type { SchedulerPublisher } from '../pipeline/autonomous-chapters.js';
import { StateManager } from '../state/manager.js';
import { createBuiltInWorkProfileRegistry } from '../harness/builtin-profiles.js';
import { withExecutionEvidence } from '../harness/execution-evidence.js';
import { syncWorkSourceArtifacts } from '../harness/source-sync.js';
import { loadAvailableAgentSkills, resolveProfileSkillActivations } from '../skills/index.js';
import { runInWorkMutationQueue, withWorkMutationScope } from '../utils/work-mutation-scope.js';
import { CreationTaskStore } from './store.js';
import { creationBook, creationError, creationInstruction, canResumeCreationTask, CreationPlanSchema, type CreationTask } from './contracts.js';

/** An intake adapter for the existing scheduler, not a second writing engine. */
export class CreationTaskCoordinator {
  readonly tasks: CreationTaskStore;
  private readonly state: StateManager;
  constructor(private readonly root: string, private readonly pipeline: PipelineRunner,
    private readonly scheduler: SchedulerStore, private readonly retryDelayMs: number) {
    this.tasks = new CreationTaskStore(join(root, '.inkos', 'harness.sqlite'));
    this.state = new StateManager(root);
  }
  runnable(workId: string): boolean {
    const task = this.tasks.forWork(workId);
    return !task || (task.desiredState === 'run' && !['completed', 'blocked'].includes(task.phase));
  }
  intent(workId: string, chapter: number): string | undefined {
    const task = this.tasks.forWork(workId);
    return task ? creationInstruction(task, chapter) : undefined;
  }
  /** Missing transport blocks at publication, after a reviewed local draft is safely retained. */
  publisher(configured?: SchedulerPublisher): SchedulerPublisher {
    return {
      ready: async (workId, signal, chapter) => {
        signal.throwIfAborted();
        if (!this.runnable(workId)) throw creationError('CREATION_PAUSED', 'The creation task is paused or blocked.');
        if (configured) {
          try { await configured.ready(workId, signal, chapter); }
          catch (error) {
            if ((error as {code?: string}).code?.startsWith('REMOTE_WORK_')) throw creationError('CREATION_PUBLISHER_REQUIRED',
              `${(error as {code: string}).code}: ${(error as Error).message}`);
            // A new local work does not yet have a remote binding. Drafting is safe; publication remains gated.
            if ((error as { code?: string }).code !== 'PUBLISHING_BINDING_MISSING') throw error;
          }
        }
      },
      ...(configured?.reconcile ? { reconcile: async (input: Parameters<NonNullable<SchedulerPublisher['reconcile']>>[0]) => {
        try { return await configured.reconcile!(input); }
        catch (error) {
          // An uncreated remote work cannot have a chapter attempt. Do not create it here.
          if ((error as {code?: string}).code === 'PUBLISHING_BINDING_MISSING') return undefined;
          if ((error as {code?: string}).code?.startsWith('REMOTE_WORK_')) throw creationError('CREATION_PUBLISHER_REQUIRED',
            `${(error as {code: string}).code}: ${(error as Error).message}`);
          throw error;
        }
      } } : {}),
      publish: async input => {
        input.signal.throwIfAborted();
        if (!this.runnable(input.workId)) throw creationError('CREATION_PAUSED', 'The creation task is paused or blocked.');
        if (!configured) throw creationError('CREATION_PUBLISHER_REQUIRED', 'The reviewed draft is retained. Configure an explicit publisher/account/remote-book binding, then resume. Remote book creation, identity, tax and contract steps are not automatic.');
        try {
          try { await configured.ready(input.workId, input.signal, input.chapterNumber); }
          catch (error) {
            if ((error as {code?: string}).code !== 'PUBLISHING_BINDING_MISSING') throw error;
            const task = this.tasks.forWork(input.workId);
            if (!task || !configured.ensureWork) throw error;
            if (!task.plan.platform || !task.plan.blurb) throw creationError('CREATION_PUBLISHER_REQUIRED',
              'This retained task has no public-facing book metadata or platform for automatic new-book creation. Configure an existing remote binding; the raw author brief will not be published as a blurb.');
            await configured.ensureWork({workId: input.workId, platform: task.plan.platform, signal: input.signal,
              metadata: {title: task.plan.title, blurb: task.plan.blurb, genre: task.plan.genre, language: task.plan.language, aiAssisted: true},
              beforeMutation: async () => { await input.beforeMutation?.(); if (!this.runnable(input.workId)) throw creationError('CREATION_PAUSED', 'Creation was paused before remote mutation.'); } });
            input.signal.throwIfAborted();
            if (!this.runnable(input.workId)) throw creationError('CREATION_PAUSED', 'Creation was paused before chapter publication.');
            await configured.ready(input.workId, input.signal, input.chapterNumber);
          }
          input.signal.throwIfAborted();
          if (!this.runnable(input.workId)) throw creationError('CREATION_PAUSED', 'Creation was paused before chapter publication.');
          return await configured.publish(input);
        }
        catch (error) {
          if ((error as {code?: string}).code?.startsWith('REMOTE_WORK_')) throw creationError('CREATION_PUBLISHER_REQUIRED',
            `${(error as {code: string}).code}: ${(error as Error).message}`);
          if ((error as { code?: string }).code === 'PUBLISHING_BINDING_MISSING') throw creationError('CREATION_PUBLISHER_REQUIRED', 'This new work has no configured remote-book binding. The reviewed draft is retained; complete publishing setup and resume.');
          throw error;
        }
      },
    };
  }
  async prepare(taskId: string, signal: AbortSignal): Promise<void> {
    let task = this.tasks.get(taskId);
    if (task.desiredState !== 'run' || task.phase === 'completed' || task.foundation === 'blocked' || task.nextAttemptAt > Date.now()) return;
    // Book settings and task controls are independent user-owned pauses. A
    // retained task's old run marker must not restart a currently paused book.
    if (!await this.bookAllowsFoundation(task.workId)) return;
    if (!task.plan.platform) {
      this.saveIfChanged(task.id, { phase: 'blocked', error: { code: 'CREATION_PLATFORM_REQUIRED', message: 'Set the platform in this task’s plan before writing. Your language and finite length are already filled in.' } });
      return;
    }
    if (task.foundation === 'completed') { await this.applyPlan(task); return; }
    if (task.foundationAttempts === 0 && (await this.state.listBooks()).includes(task.workId)) {
      this.saveIfChanged(task.id, { foundation: 'blocked', phase: 'blocked', error: { code: 'CREATION_WORK_CONFLICT', message: 'This work identity already exists; it was not changed or adopted.' } });
      return;
    }
    if (task.foundationAttempts > 0 && await this.state.isCompleteBookDirectory(this.state.bookDir(task.workId))) {
      try {
        await verifyCreationFoundation(this.root, task);
        this.tasks.update(task.id, current => ({ ...current, foundation: 'completed', phase: 'writing', error: undefined }));
      } catch (error) {
        this.tasks.update(task.id, current => ({ ...current, foundation: 'blocked', phase: 'blocked',
          error: { code: 'CREATION_FOUNDATION_RECONCILIATION_REQUIRED', message: String(error) } }));
      }
      return;
    }
    task = this.tasks.update(task.id, current => ({ ...current, phase: 'planning',
      // Infer old records before admitting this attempt. Unknown historical
      // interruptions are not evidence for refunding a prior failure.
      foundationFailures: current.foundationFailures
        ?? Math.max(0, current.foundationAttempts - (current.foundationTransientFailures ?? 0)),
      foundationAttempts: current.foundationAttempts + 1, error: undefined }));
    try {
      const profile = createBuiltInWorkProfileRegistry(this.root).require('longform-novel');
      const skills = resolveProfileSkillActivations((await loadAvailableAgentSkills({ projectRoot: this.root })).skills, profile);
      await withExecutionEvidence(undefined, () => this.pipeline.runWithAgentContext({ signal, activatedSkills: skills }, async () => {
        signal.throwIfAborted();
        // Async profile/skill reads must not carry stale controls into a model call.
        if (!await this.bookAllowsFoundation(task.workId) || this.tasks.get(task.id).desiredState !== 'run') return;
        signal.throwIfAborted();
        if (task.planStatus !== 'ready') {
          const proposed = await new CreationPlannerAgent(this.pipeline.createAgentContext('architect')).plan(task.request, task.plan);
          signal.throwIfAborted();
          task = this.tasks.update(task.id, current => ({ ...current,
            plan: CreationPlanSchema.parse({ ...proposed.plan, ...current.planOverrides }), planStatus: 'ready',
            endingIntent: proposed.endingIntent, planSummary: proposed.summary }));
        }
        signal.throwIfAborted();
        // The author may pause the book while the planner is in flight.
        if (!await this.bookAllowsFoundation(task.workId) || this.tasks.get(task.id).desiredState !== 'run') return;
        signal.throwIfAborted();
        await this.pipeline.initBook(creationBook(task), { externalContext: creationInstruction(task), authorIntent: creationInstruction(task) });
      }), profile, null, task.request.brief);
      if (await this.state.isCompleteBookDirectory(this.state.bookDir(task.workId))) this.tasks.update(task.id, current => ({ ...current, foundation: 'completed', phase: 'writing', error: undefined }));
    } catch (error) {
      const transient = isCreationTransientFailure(error);
      const transientFailures = (task.foundationTransientFailures ?? 0) + (transient ? 1 : 0);
      const foundationFailures = (task.foundationFailures ?? 0) + (!signal.aborted && !transient ? 1 : 0);
      const failed = !signal.aborted && !transient && foundationFailures >= 3;
      this.tasks.update(task.id, current => ({ ...current, foundation: failed ? 'blocked' : 'pending', phase: failed ? 'blocked' : 'queued',
        foundationTransientFailures: transientFailures, foundationFailures,
        nextAttemptAt: Date.now() + Math.min(3_600_000, Math.max(1000, this.retryDelayMs) * 2 ** Math.min(task.foundationAttempts - 1, 10)),
        error: signal.aborted ? undefined : { code: (error as { code?: string }).code ?? 'CREATION_FOUNDATION_FAILED', message: String(error) } }));
    }
  }
  private async bookAllowsFoundation(workId: string): Promise<boolean> {
    try {
      const book = await this.state.loadBookConfig(workId);
      return ['active', 'outlining'].includes(book.status);
    } catch (error) {
      // New tasks and the retained manifest-before-book.json crash window have
      // no book-level control yet. Other read/validation failures stay closed.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
      throw error;
    }
  }
  async applyPlan(task: CreationTask): Promise<void> {
    await runInWorkMutationQueue(`${resolve(this.root)}\0${task.workId}`, () => withWorkMutationScope(this.root, task.workId,
      () => this.state.acquireBookLock(task.workId), async () => {
        const current = this.tasks.get(task.id);
        if (current.desiredState !== 'run') return;
        const book = await this.state.loadBookConfig(task.workId);
        if (!['active', 'outlining'].includes(book.status)) return;
        if (book.targetChapters === current.plan.targetChapters && book.chapterWordCount === current.plan.chapterWordCount) return;
        await this.state.saveBookConfig(task.workId, { ...book, targetChapters: current.plan.targetChapters,
          chapterWordCount: current.plan.chapterWordCount, updatedAt: new Date().toISOString() });
        await syncWorkSourceArtifacts({ projectRoot: this.root, workId: task.workId, accept: true, acceptPaths: ['source/book.json'] });
      }));
  }
  sync(workId: string): void {
    const task = this.tasks.forWork(workId);
    if (!task || task.foundation !== 'completed') return;
    const jobs = this.scheduler.chapters(workId), latest = jobs.at(-1);
    const complete = jobs.length === task.plan.targetChapters && jobs.every((job, i) => job.chapter === i + 1
      && job.phase === 'completed' && job.publication?.status === 'published' && Boolean(job.reviewReceipt));
    const closure = latest?.reviewReceipt?.observations.some(observation => observation.code === 'story-closure'
      && observation.category === 'quality' && ['observation', 'resolved'].includes(observation.assessment ?? '')
      && observation.sourceRefs?.some(ref => ref.sourceId === `chapter-${task.plan.targetChapters}` && ref.quote.trim()));
    if (complete && closure) { this.saveIfChanged(task.id, { phase: 'completed', error: undefined }); return; }
    if (complete) {
      this.saveIfChanged(task.id, { phase: 'blocked', error: { code: 'STORY_CLOSURE_REVIEW_REQUIRED', message: 'All chapter receipts are retained, but the ending has no source-supported closure acceptance. No chapter will be rewritten or resubmitted automatically.' } });
      return;
    }
    if (!latest) return;
    const phase = latest.phase === 'completed' ? 'writing' : latest.phase === 'reviewing' && latest.reviewRepair ? 'revising' : latest.phase;
    this.saveIfChanged(task.id, { phase: latest.error?.code === 'CREATION_PUBLISHER_REQUIRED' ? 'blocked' : phase, error: latest.error });
  }
  private saveIfChanged(id: string, patch: Partial<CreationTask>): void {
    const current = this.tasks.get(id);
    if (Object.entries(patch).every(([key, value]) => JSON.stringify(current[key as keyof CreationTask]) === JSON.stringify(value))) return;
    this.tasks.update(id, task => ({ ...task, ...patch }));
  }
  close(): void { this.tasks.close(); }
}

export function creationTaskView(task: CreationTask, jobs: readonly ScheduledChapter[]) {
  const latest = jobs.at(-1);
  const phase = latest && !['completed', 'blocked', 'planning'].includes(task.phase)
    ? latest.phase === 'completed' ? task.phase : latest.phase === 'reviewing' && latest.reviewRepair ? 'revising' : latest.phase : task.phase;
  return { ...task, canResume: canResumeCreationTask(task), status: task.desiredState === 'paused' && task.phase !== 'completed' ? 'paused' : phase,
    writtenChapters: jobs.filter(job => job.writingCompleted || (job.reviewChecks ?? 0) > 0 || Boolean(job.reviewReceipt) || ['reviewing', 'publishing', 'completed'].includes(job.phase)).length,
    reviewedChapters: jobs.filter(job => Boolean(job.reviewReceipt)).length,
    publishedChapters: jobs.filter(job => job.publication?.status === 'published').length,
    currentChapter: latest?.chapter ?? 0, stage: latest?.phase ?? task.phase,
    nextAttemptAt: latest?.nextAttemptAt ?? task.nextAttemptAt,
    error: task.error ?? latest?.error,
    receipts: jobs.filter(job => job.publication).map(job => ({ chapter: job.chapter, revisionId: job.revisionId,
      review: job.reviewReceipt, publication: job.publication })),
  };
}
