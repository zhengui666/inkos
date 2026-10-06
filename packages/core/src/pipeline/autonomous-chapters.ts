import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { PipelineRunner } from "./runner.js";
import { StateManager } from "../state/manager.js";
import { ChapterGoalService } from "../goals/service.js";
import { loadWorkManifest } from "../harness/work-store.js";
import { createBuiltInWorkProfileRegistry } from "../harness/builtin-profiles.js";
import { loadAvailableAgentSkills, resolveProfileSkillActivations } from "../skills/index.js";
import { withExecutionEvidence } from "../harness/execution-evidence.js";
import type { Observation } from "../models/observation.js";
import type { ScheduledChapter, SchedulerStore } from "./scheduler-store.js";
import { runInWorkMutationQueue, withWorkMutationScope } from "../utils/work-mutation-scope.js";

export interface SchedulerPublisher {
  /** Read-only check of configured transport and actual signed-in account/book. */
  ready(workId: string, signal: AbortSignal, continuingChapter?: number): Promise<void>;
  /** Reconcile prior attempts before any write; pending must never imply a new submission. */
  publish(input: { workId: string; chapterNumber: number; revisionId: string; signal: AbortSignal }): Promise<NonNullable<ScheduledChapter["publication"]>>;
  close?(): Promise<void>;
}

export function unresolvedReview(observations: readonly Observation[]): Observation[] {
  return observations.filter(observation => observation.assessment !== "resolved" && (observation.assessment === "issue" || observation.assessment === "unavailable"
    || /(?:review-unavailable|state-sync-required|state-validation|state-reconciliation)/u.test(observation.code)
    || (observation.assessment === undefined && observation.category !== "scope")));
}

export type AutonomousPipeline = Pick<PipelineRunner, "writeChapters" | "runWithAbortSignal" | "runWithAgentContext" | "reviewChapter" | "reviseDraft">;

/** Resumes one durable chapter through existing writing, review and publication APIs. */
export class AutonomousChapterRunner {
  private readonly state: StateManager;
  constructor(private readonly root: string, private readonly pipeline: AutonomousPipeline,
    private readonly store: SchedulerStore, private readonly options: {
      publisher?: SchedulerPublisher; retryDelayMs: number; maxAttempts?: number;
      publicationPollMs?: number;
      now?: () => number; onComplete?: (workId: string, chapter: number) => void;
    }) { this.state = new StateManager(root); }

  async run(job: ScheduledChapter, signal: AbortSignal): Promise<ScheduledChapter> {
    const now = this.options.now ?? Date.now;
    if (["blocked", "completed"].includes(job.phase) || job.nextAttemptAt > now()) return job;
    signal.throwIfAborted();
    const book = await this.state.loadBookConfig(job.workId);
    if (!["active", "outlining"].includes(book.status)) return job;
    try {
      // No new model work while the explicitly selected publishing destination is unavailable.
      await this.options.publisher?.ready(job.workId, signal, job.phase === "publishing" ? job.chapter : undefined);
      if (job.phase === "writing") job = await this.write(job, signal);
      signal.throwIfAborted();
      if (!["active", "outlining"].includes((await this.state.loadBookConfig(job.workId)).status)) return job;
      if (job.phase === "reviewing") job = await this.review(job, signal);
      if (job.phase === "publishing") {
        signal.throwIfAborted();
        if (!["active", "outlining"].includes((await this.state.loadBookConfig(job.workId)).status)) return job;
        const current = await this.chapterRevision(job.workId, job.chapter);
        if (current.revisionId !== job.revisionId || job.reviewReceipt?.revisionId !== current.revisionId
          || unresolvedReview(current.observations).length) {
          job = { ...job, phase: "reviewing", revisionId: undefined, reviewReceipt: undefined };
          this.store.save(job, "review-invalidated-by-edit", now());
          return job;
        }
        const publication = await this.options.publisher!.publish({ workId: job.workId, chapterNumber: job.chapter,
          revisionId: job.revisionId!, signal });
        job = { ...job, publication, failures: 0, error: undefined, publicationStartedAt: job.publicationStartedAt ?? now(),
          phase: publication.status === "published" ? "completed" : "publishing",
          nextAttemptAt: now() + (this.options.publicationPollMs ?? 900_000) };
        this.store.save(job, "publication-readback", now());
      }
      if (job.phase === "completed") {
        // A UI/notification callback cannot turn committed work into another writing attempt.
        try { this.options.onComplete?.(job.workId, job.chapter); }
        catch (error) { this.store.event("completion-callback-failed", { workId: job.workId, message: String(error) }, now()); }
      }
      return job;
    } catch (error) {
      // A repair records its attempt before the model call, even if that call fails.
      const retained = this.store.latest(job.workId);
      if (retained?.chapter === job.chapter) job = retained;
      if (signal.aborted) { this.store.event("chapter-interrupted", { workId: job.workId, chapter: job.chapter }, now()); return job; }
      const failure = { code: (error as { code?: string }).code ?? "DAEMON_OPERATION_FAILED", message: String(error) };
      if (failure.code === "PUBLISHING_HISTORY_PENDING") {
        const startedAt = job.publicationStartedAt ?? now();
        job = { ...job, error: failure, publicationStartedAt: startedAt, nextAttemptAt: now() + (this.options.publicationPollMs ?? 900_000) };
        this.store.save(job, "waiting-for-historical-publication", now());
        return job;
      }
      if (["GOAL_BUSY", "BOOK_BUSY"].includes(failure.code)) {
        job = { ...job, error: failure, nextAttemptAt: now() + Math.max(30_000, this.options.retryDelayMs) };
        this.store.save(job, "waiting-for-existing-writer", now());
        return job;
      }
      const failures = job.failures + 1;
      job = { ...job, failures, error: failure,
        phase: failures >= (this.options.maxAttempts ?? 3) ? "blocked" : job.phase,
        nextAttemptAt: now() + Math.min(3_600_000, Math.max(1_000, this.options.retryDelayMs) * 2 ** (failures - 1)) };
      this.store.save(job, job.phase === "blocked" ? "chapter-blocked" : "chapter-backoff", now());
      return job;
    }
  }

  private async write(job: ScheduledChapter, signal: AbortSignal): Promise<ScheduledChapter> {
    const service = new ChapterGoalService({ projectRoot: this.root, createPipeline: () => this.pipeline,
      retryDelayMs: Math.min(60_000, this.options.retryDelayMs) });
    try {
      let goal;
      try { goal = service.get(job.goalId); }
      catch (error) {
        if ((error as { code?: string }).code !== "GOAL_NOT_FOUND") throw error;
        goal = await service.create({ id: job.goalId, workId: job.workId,
          intent: `Write original chapter ${job.chapter} in this book's configured language, preserving its canon and author instructions.`,
          startChapter: job.chapter, endChapter: job.chapter, expiresAt: Date.now() + 86_400_000,
          maxAttemptsPerChapter: this.options.maxAttempts ?? 3 });
      }
      if (goal.owner) goal = service.recover(goal.id, goal.version);
      if (goal.status !== "completed" && Date.now() >= goal.budget.expiresAt) return this.block(job, "GOAL_BUDGET_EXHAUSTED", "The retained writing deadline elapsed.");
      if (goal.owner) throw Object.assign(new Error("Previous chapter executor is still alive."), { code: "GOAL_BUSY" });
      if (goal.status === "completed") return this.advance(job, "reviewing", "writing-reconciled");
      const explicitlyPaused = goal.desiredState === "paused" && service.events(goal.id).events.some(event => event.type === "goal-paused-requested");
      const waitingForBook = goal.status === "reconciliation_required" && goal.error?.code === "BOOK_BUSY";
      if (["failed", "cancelled", "waiting_user"].includes(goal.status)
        || (goal.status === "reconciliation_required" && !waitingForBook) || explicitlyPaused) {
        return this.block(job, goal.error?.code ?? "GOAL_PAUSED", goal.error?.message ?? "Writing goal requires attention.");
      }
      goal = await service.run(goal.id, goal.version, { signal });
      if (goal.status === "completed") return this.advance(job, "reviewing", "writing-completed");
      if (signal.aborted) return job;
      if (goal.status === "ready" || goal.error?.code === "BOOK_BUSY") throw Object.assign(new Error("Another writer still owns this work."), { code: "GOAL_BUSY" });
      return this.block(job, goal.error?.code ?? "CHAPTER_NOT_COMPLETED", goal.error?.message ?? `Writing stopped: ${goal.status}`);
    } finally { service.close(); }
  }

  private async review(job: ScheduledChapter, signal: AbortSignal): Promise<ScheduledChapter> {
    return runInWorkMutationQueue(`${resolve(this.root)}\0${job.workId}`, () =>
      withWorkMutationScope(this.root, job.workId, () => this.state.acquireBookLock(job.workId),
        () => this.reviewLocked(job, signal)));
  }
  private async reviewLocked(job: ScheduledChapter, signal: AbortSignal): Promise<ScheduledChapter> {
    const now = this.options.now ?? Date.now;
    const work = await loadWorkManifest(this.root, job.workId);
    const profile = createBuiltInWorkProfileRegistry(this.root).require(work.profileId);
    const skills = resolveProfileSkillActivations((await loadAvailableAgentSkills({ projectRoot: this.root })).skills, profile);
    const runReview = <T>(task: () => Promise<T>) => withExecutionEvidence(undefined,
      () => this.pipeline.runWithAgentContext({ signal, activatedSkills: skills }, task),
      profile, work, "Review this retained chapter before autonomous publication.");
    while (true) {
      signal.throwIfAborted();
      if (!["active", "outlining"].includes((await this.state.loadBookConfig(job.workId)).status)) return job;
      const initial = await this.chapterRevision(job.workId, job.chapter);
      // A prose audit cannot settle canonical state or authorize a replay.
      const stateIssues = unresolvedReview(initial.observations).filter(issue =>
        /(?:state-sync-required|state-validation|state-reconciliation)/u.test(issue.code));
      if (stateIssues.length) return this.block(job, "CHAPTER_STATE_RECOVERY_REQUIRED", stateIssues.map(issue => `${issue.code}: ${issue.summary}`).join("\n"));
      if ((job.reviewChecks ?? 0) >= (this.options.maxAttempts ?? 3)) {
        return this.block(job, "CHAPTER_REVIEW_BUDGET_EXHAUSTED", "The retained chapter review budget is exhausted; edits and restarts do not reset it.");
      }
      job = { ...job, reviewChecks: (job.reviewChecks ?? 0) + 1, reviewReceipt: undefined,
        reviewAttempt: { revisionId: initial.revisionId, startedAt: now() } };
      this.store.save(job, "review-started", now());
      // Empty index observations are not evidence that this revision was reviewed.
      const result = await runReview(() => this.pipeline.reviewChapter(job.workId, job.chapter));
      signal.throwIfAborted();
      const reviewed = await this.chapterRevision(job.workId, job.chapter);
      if (reviewed.revisionId !== initial.revisionId) {
        return this.block(job, "CHAPTER_REVIEW_REVISION_CHANGED", "The chapter changed during review; no acceptance receipt was issued.");
      }
      job = { ...job, reviewAttempt: undefined };
      this.store.save(job, "review-finished", now());
      const issues = [...unresolvedReview(result.observations), ...unresolvedReview(reviewed.observations)];
      if (result.unavailable || issues.some(issue => issue.code === "review-unavailable" || issue.assessment === "unavailable")) {
        throw Object.assign(new Error("The current revision has no available review result."), { code: "CHAPTER_REVIEW_UNAVAILABLE" });
      }
      if (!issues.length) {
        job = { ...job, revisionId: reviewed.revisionId, reviewReceipt: {
          revisionId: reviewed.revisionId, reviewedAt: now(), summary: result.summary, observations: result.observations,
        } };
        return this.advance(job, this.options.publisher ? "publishing" : "completed", "review-accepted");
      }
      if (job.reviewAttempts >= 1 || (job.reviewChecks ?? 0) >= (this.options.maxAttempts ?? 3)
        || issues.some(issue => /(?:state-sync-required|state-validation|state-reconciliation)/u.test(issue.code))) {
        return this.block(job, "CHAPTER_REVIEW_REQUIRED", issues.map(issue => `${issue.code}: ${issue.summary}`).join("\n"));
      }
      job = { ...job, reviewAttempts: job.reviewAttempts + 1,
        reviewRepair: { revisionId: reviewed.revisionId, startedAt: now() } };
      this.store.save(job, "review-repair-started", now());
      await runReview(() => this.pipeline.reviseDraft(job.workId, job.chapter, "spot-fix",
        "Correct only the retained source-supported review findings. Preserve original language, established facts and all unaffected prose."));
      // Reconcile and independently review the resulting current revision. An
      // interrupted repair uses this same path on resume, never a blind repair retry.
    }
  }

  private async chapterRevision(workId: string, chapter: number) {
    const meta = (await this.state.loadChapterIndex(workId)).find(item => item.number === chapter);
    if (!meta) throw new Error(`Retained chapter ${chapter} is missing.`);
    const work = await loadWorkManifest(this.root, workId);
    const prefix = `source/chapters/${String(chapter).padStart(4, "0")}_`;
    const revisions = work.artifacts.flatMap(artifact => artifact.revisions.filter(revision => revision.id === artifact.currentRevisionId && revision.path.startsWith(prefix) && revision.path.endsWith(".md")));
    if (revisions.length !== 1 || !revisions[0]!.snapshotPath) throw new Error(`Chapter ${chapter} has no unique current retained revision.`);
    const revision = revisions[0]!;
    const bytes = await readFile(join(this.root, "works", workId, revision.path));
    if (!bytes.equals(await readFile(join(this.root, "works", workId, revision.snapshotPath!)))) {
      throw Object.assign(new Error("Current chapter has unregistered edits; retain them and reconcile before publication."), { code: "CHAPTER_REVISION_CHANGED" });
    }
    return { revisionId: revision.id, observations: meta.observations };
  }
  private advance(job: ScheduledChapter, phase: ScheduledChapter["phase"], event: string): ScheduledChapter {
    const next = { ...job, phase, failures: 0, error: undefined };
    this.store.save(next, event); return next;
  }
  private block(job: ScheduledChapter, code: string, message: string): ScheduledChapter {
    const next: ScheduledChapter = { ...job, phase: "blocked", error: { code, message } };
    this.store.save(next, "chapter-blocked"); return next;
  }
}
