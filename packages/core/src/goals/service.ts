import { join, resolve } from 'node:path';
import { z } from 'zod';
import type { PipelineRunner } from '../pipeline/runner.js';
import { StateManager } from '../state/manager.js';
import { loadWorkManifest } from '../harness/work-store.js';
import { createBuiltInWorkProfileRegistry } from '../harness/builtin-profiles.js';
import { withExecutionEvidence } from '../harness/execution-evidence.js';
import { loadAvailableAgentSkills, resolveProfileSkillActivations } from '../skills/index.js';
import { GoalStore } from './store.js';
import { GoalExecutor } from './executor.js';
import { chapterGoalInput, createChapterGoalAdapter, CHAPTER_GOAL_KIND } from './chapters.js';
import { GoalInputSchema, goalError, goalInputValue, type Goal, type GoalEvent } from './contracts.js';

export type GoalPipeline = Pick<PipelineRunner, 'writeChapters' | 'runWithAbortSignal' | 'runWithAgentContext'>;
export type ChapterGoalCreateInput = Parameters<typeof chapterGoalInput>[0];
export interface ChapterGoalServiceOptions {
  readonly projectRoot: string;
  readonly retryDelayMs?: number;
  /** Creation automation may replace a safely reconciled interrupted attempt once. */
  readonly compensateInterruptedAttempts?: boolean;
  /** Called only by a runnable writing request, never create/status/recover. */
  readonly createPipeline?: () => Promise<GoalPipeline> | GoalPipeline;
}
const Id = z.string().min(1).max(200);
const Version = z.number().int().nonnegative();
const inputOf = (goal: Goal) => GoalInputSchema.parse({ id: goal.id, workId: goal.workId, intent: goal.intent,
  budget: goal.budget, steps: goal.steps.map(({ id, kind, input, maxAttempts }) => ({ id, kind, input, maxAttempts })) });

/** Foreground access to the existing persistent executor. This starts no daemon or scheduler. */
export class ChapterGoalService {
  private readonly root: string;
  private readonly store: GoalStore;
  constructor(private readonly options: ChapterGoalServiceOptions) {
    this.root = resolve(options.projectRoot);
    this.store = new GoalStore(join(this.root, '.inkos', 'harness.sqlite'));
  }

  async create(input: ChapterGoalCreateInput): Promise<Goal> {
    const wordCount = input.wordCount === undefined ? undefined : z.number().int().positive().parse(input.wordCount);
    const desired = GoalInputSchema.parse(chapterGoalInput({ ...input, wordCount }));
    await this.requireWork(desired.workId);
    const existing = this.find(desired.id);
    if (existing) return this.sameCreation(existing, desired);
    try { return this.store.create(desired); }
    catch (error) {
      // Concurrent identical creates converge on the already durable identity.
      const winner = this.find(desired.id);
      if (winner) return this.sameCreation(winner, desired);
      throw error;
    }
  }

  get(id: string, workId?: string): Goal {
    const goal = this.store.get(Id.parse(id));
    if (workId !== undefined && goal.workId !== workId) throw goalError('GOAL_WORK_SCOPE_MISMATCH', 'This goal belongs to another Work.');
    return goal;
  }

  list(workId?: string): Goal[] { return this.store.list(workId); }

  events(id: string, options: { workId?: string; afterSeq?: number; limit?: number } = {}): { events: GoalEvent[]; nextAfterSeq: number } {
    this.get(id, options.workId);
    const afterSeq = z.number().int().min(-1).parse(options.afterSeq ?? -1);
    const limit = z.number().int().min(1).max(200).parse(options.limit ?? 100);
    const events = this.store.events(id, afterSeq, limit).map(event => {
      if (event.type !== 'goal-claimed') return event;
      const { token: _token, ...payload } = event.payload;
      return { ...event, payload };
    });
    return { events, nextAfterSeq: events.at(-1)?.seq ?? afterSeq };
  }

  stop(id: string, desired: 'paused' | 'cancelled', expectedVersion: number, workId?: string): Goal {
    this.get(id, workId);
    return this.store.requestStop(id, z.enum(['paused', 'cancelled']).parse(desired), Version.parse(expectedVersion));
  }

  recover(id: string, expectedVersion: number, workId?: string): Goal {
    this.get(id, workId);
    return this.store.recover(id, Version.parse(expectedVersion));
  }

  retryTransientFailure(id: string, expectedVersion: number, workId?: string, additionalAttempts = 3): Goal {
    this.get(id, workId);
    return this.store.retryTransientFailure(id, Version.parse(expectedVersion), additionalAttempts);
  }

  async run(id: string, expectedVersion: number, options: { signal?: AbortSignal; workId?: string } = {}): Promise<Goal> {
    const goal = this.get(id, options.workId);
    if (goal.version !== Version.parse(expectedVersion)) throw goalError('GOAL_VERSION_CONFLICT', 'Goal changed. Read its latest state first.');
    if (goal.status === 'completed') return goal;
    if (goal.status === 'cancelled' || goal.status === 'failed') throw goalError('GOAL_TERMINAL', 'This goal is terminal; inspect its retained results instead of resuming it.');
    if (goal.owner) throw goalError('GOAL_BUSY', 'The previous executor still owns this goal. Recover only after it has exited.');
    if (goal.budget.expiresAt !== null && Date.now() >= goal.budget.expiresAt) throw goalError('GOAL_BUDGET_EXHAUSTED', 'Goal deadline has elapsed.');
    if (goal.steps.some(step => step.kind !== CHAPTER_GOAL_KIND)) throw goalError('GOAL_ADAPTER_UNAVAILABLE', 'This entry point only runs the fixed chapter-writing adapter.');
    options.signal?.throwIfAborted();
    const { work, profile } = await this.requireWork(goal.workId);
    if (!this.options.createPipeline) throw goalError('GOAL_RUNTIME_UNAVAILABLE', 'No chapter-writing runtime was supplied.');
    const skills = resolveProfileSkillActivations((await loadAvailableAgentSkills({ projectRoot: this.root })).skills, profile);
    const pipeline = await this.options.createPipeline();
    options.signal?.throwIfAborted();
    // requestRun performs the atomic CAS after all non-writing preparation.
    this.store.requestRun(id, expectedVersion);
    const executor = new GoalExecutor(this.store, [createChapterGoalAdapter({ projectRoot: this.root, pipeline })], this.options.retryDelayMs,
      { compensateInterruptedAttempts: this.options.compensateInterruptedAttempts });
    return withExecutionEvidence(undefined, () => pipeline.runWithAgentContext({ activatedSkills: skills },
      () => executor.run(id, options.signal)), profile, work, goal.intent);
  }

  close(): void { this.store.close(); }

  private find(id: string): Goal | undefined {
    try { return this.store.get(id); }
    catch (error) { if ((error as { code?: string }).code === 'GOAL_NOT_FOUND') return undefined; throw error; }
  }

  private sameCreation(existing: Goal, desired: z.infer<typeof GoalInputSchema>): Goal {
    if (goalInputValue(inputOf(existing)) !== goalInputValue(desired)) throw goalError('GOAL_ID_CONFLICT', 'This goal ID already belongs to a different fixed target or budget.');
    return existing;
  }

  private async requireWork(workId: string) {
    const work = await loadWorkManifest(this.root, workId);
    const profile = createBuiltInWorkProfileRegistry(this.root).require(work.profileId);
    if (!profile.capabilityIds.includes('longform')) throw goalError('GOAL_WORK_PROFILE_MISMATCH', 'Chapter goals require a long-form Work.');
    await new StateManager(this.root).loadBookConfig(workId);
    return { work, profile };
  }
}

/** Public status omits the executor's private ownership token. */
export function chapterGoalView(goal: Goal) {
  return { ...goal, owner: goal.owner ? { pid: goal.owner.pid, leaseUntil: goal.owner.leaseUntil } : null,
    completedSteps: goal.steps.filter(step => step.status === 'completed').length, totalSteps: goal.steps.length,
    nextStepId: goal.steps.find(step => step.status !== 'completed')?.id ?? null,
    execution: 'foreground' as const,
    acceptance: 'Committed chapters with settled state; not editorial approval or publication.' };
}
