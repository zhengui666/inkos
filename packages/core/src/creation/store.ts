import type { DatabaseSync } from 'node:sqlite';
import { openHarnessDatabase } from '../harness/sqlite.js';
import { goalInputValue } from '../goals/contracts.js';
import { CreationRequestSchema, CreationPlanSchema, creationError, canResumeCreationTask, type CreationTask, type CreationRequest, type CreationPlan } from './contracts.js';

/** Intake and user controls share the existing ledger, never an in-memory job queue. */
export class CreationTaskStore {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = openHarnessDatabase(path);
    this.db.exec('CREATE TABLE IF NOT EXISTS creation_tasks (id TEXT PRIMARY KEY, work_id TEXT UNIQUE NOT NULL, data_json TEXT NOT NULL)');
  }
  list(): CreationTask[] {
    return this.db.prepare('SELECT data_json FROM creation_tasks ORDER BY rowid DESC').all().map(row => JSON.parse(String(row.data_json)));
  }
  get(id: string): CreationTask {
    const row = this.db.prepare('SELECT data_json FROM creation_tasks WHERE id=?').get(id);
    if (!row) throw creationError('CREATION_NOT_FOUND', 'Creation task was not found.');
    return JSON.parse(String(row.data_json));
  }
  forWork(workId: string): CreationTask | undefined {
    const row = this.db.prepare('SELECT data_json FROM creation_tasks WHERE work_id=?').get(workId);
    return row ? JSON.parse(String(row.data_json)) : undefined;
  }
  create(input: CreationRequest, plan: CreationPlan, now = Date.now()): CreationTask {
    const request = CreationRequestSchema.parse(input);
    return this.transaction(() => {
      const row = this.db.prepare('SELECT data_json FROM creation_tasks WHERE id=?').get(request.id);
      if (row) {
        const prior: CreationTask = JSON.parse(String(row.data_json));
        if (goalInputValue(prior.request) !== goalInputValue(request)) throw creationError('CREATION_ID_CONFLICT', 'This request ID already belongs to another brief.');
        return prior;
      }
      const task: CreationTask = { id: request.id, workId: `creation-${request.id}`, request,
        plan: CreationPlanSchema.parse(plan), planStatus: 'provisional', version: 0, desiredState: 'run', phase: plan.platform ? 'queued' : 'blocked',
        ...(plan.platform ? {} : { error: { code: 'CREATION_PLATFORM_REQUIRED', message: 'Choose the publishing platform in this task’s plan. No destination was guessed.' } }),
        foundation: 'pending', foundationAttempts: 0, foundationFailures: 0, nextAttemptAt: now, createdAt: now, updatedAt: now };
      this.db.prepare('INSERT INTO creation_tasks(id,work_id,data_json) VALUES(?,?,?)').run(task.id, task.workId, JSON.stringify(task));
      return task;
    });
  }
  /** Always merge scheduler updates into the latest controls; a late callback cannot undo pause. */
  update(id: string, change: (current: CreationTask) => CreationTask, version?: number): CreationTask {
    return this.transaction(() => {
      const current = this.get(id);
      if (version !== undefined && current.version !== version) throw creationError('CREATION_VERSION_CONFLICT', 'Task changed. Refresh before retrying this action.');
      const next = { ...change(current), id: current.id, workId: current.workId, request: current.request,
        version: current.version + 1, updatedAt: Date.now() };
      this.db.prepare('UPDATE creation_tasks SET data_json=? WHERE id=?').run(JSON.stringify(next), id);
      return next;
    });
  }
  control(id: string, desiredState: 'run' | 'paused', version: number): CreationTask {
    return this.update(id, task => {
      if (task.phase === 'completed') throw creationError('CREATION_TERMINAL', 'This story is finished. Create a new task for a new work.');
      if (desiredState === 'run' && task.phase === 'blocked') {
        if (!canResumeCreationTask(task)) {
          throw creationError('CREATION_RECONCILIATION_REQUIRED', 'This automatic run has stopped with retained results and an unresolved writing/review failure. Resume cannot reopen this failure or reset its budgets; inspect the work and execution evidence.');
        }
        return { ...task, desiredState, phase: task.foundation === 'completed' ? 'writing' : 'queued', error: undefined, nextAttemptAt: Date.now() };
      }
      return { ...task, desiredState, nextAttemptAt: Date.now() };
    }, version);
  }
  editPlan(id: string, input: CreationPlan, version: number, lastReservedChapter: number, chapterUnsettled = false): CreationTask {
    const plan = CreationPlanSchema.parse(input);
    return this.update(id, task => {
      if (task.desiredState !== 'paused' || task.phase === 'completed') throw creationError('CREATION_PAUSE_REQUIRED', 'Pause this task before editing its ending or length.');
      if (chapterUnsettled) throw creationError('CREATION_CHAPTER_SETTLING', 'The retained chapter is still in progress. Resume it through review/publication before changing the future plan.');
      if (plan.targetChapters < lastReservedChapter || (plan.targetChapters !== task.plan.targetChapters && plan.targetChapters === lastReservedChapter)) throw creationError('CREATION_END_BEHIND_PROGRESS', 'The new ending must follow every already reserved chapter, so it can receive its own closure review.');
      if (task.foundationAttempts > 0 && (plan.title !== task.plan.title || plan.genre !== task.plan.genre || plan.blurb !== task.plan.blurb || plan.language !== task.plan.language || plan.platform !== task.plan.platform)) {
        throw creationError('CREATION_FOUNDATION_FIXED', 'Title, language and platform cannot change after planning has started. The ending and future chapter length remain editable.');
      }
      const overrides = { ...task.planOverrides };
      for (const key of Object.keys(plan) as Array<keyof CreationPlan>) if (plan[key] !== task.plan[key]) Object.assign(overrides, { [key]: plan[key] });
      return { ...task, plan, planOverrides: overrides, error: undefined, phase: task.phase === 'blocked' && task.foundationAttempts === 0 ? 'queued' : task.phase };
    }, version);
  }
  close(): void { this.db.close(); }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}
