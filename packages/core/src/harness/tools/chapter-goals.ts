import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '../../codex/contracts.js';
import type { PipelineRunner } from '../../pipeline/runner.js';
import type { ActivatedSkillGuidance } from '../../agent/skill-tool.js';
import { mergeActivatedSkillGuidance } from '../../skills/activations.js';
import { runAsWorkflowTrajectory } from '../../llm/agent-trajectory.js';
import { ChapterGoalService, chapterGoalView } from '../../goals/service.js';
import { goalError, type Goal } from '../../goals/contracts.js';

const Identity = { goalId: Type.String({ minLength: 1, maxLength: 200 }), expectedVersion: Type.Integer({ minimum: 0 }) };
const Create = Type.Object({
  goalId: Identity.goalId,
  intent: Type.String({ minLength: 1, description: 'The authorized fixed writing objective, preserved through recovery.' }),
  startChapter: Type.Integer({ minimum: 1 }), endChapter: Type.Integer({ minimum: 1 }),
  expiresAt: Type.Integer({ minimum: 0, description: 'Absolute Unix deadline in milliseconds. Recovery never resets this budget.' }),
  wordCount: Type.Optional(Type.Integer({ minimum: 1 })),
  maxAttemptsPerChapter: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
}, { additionalProperties: false });
const Inspect = Type.Object({
  goalId: Type.Optional(Identity.goalId),
  afterSeq: Type.Optional(Type.Integer({ minimum: -1 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
}, { additionalProperties: false });
const Run = Type.Object(Identity, { additionalProperties: false });
const Control = Type.Object({ ...Identity, action: Type.Union([Type.Literal('pause'), Type.Literal('cancel'), Type.Literal('recover')]) }, { additionalProperties: false });

type GoalTool = AgentTool<any, any> & { readonly artifactsCommitted?: true; readonly managesWorkLock?: true };
interface Options {
  readonly activeSkills?: () => ReadonlyArray<ActivatedSkillGuidance>;
  readonly workerSkills?: (worker: string) => ReadonlyArray<ActivatedSkillGuidance>;
}

/** Goal metadata controls must remain available while the chapter adapter owns the Work lock. */
export function createChapterGoalTools(pipeline: PipelineRunner, projectRoot: string, workId: string, options: Options = {}): GoalTool[] {
  const withService = async <T>(task: (service: ChapterGoalService) => Promise<T> | T): Promise<T> => {
    const service = new ChapterGoalService({ projectRoot, createPipeline: () => pipeline });
    try { return await task(service); } finally { service.close(); }
  };
  const result = (goal: Goal, includeReceipts = false): AgentToolResult<unknown> => {
    const view = chapterGoalView(goal);
    const committedArtifacts = includeReceipts ? goal.steps.flatMap(step => step.status === 'completed' && step.receipt
      ? step.receipt.artifacts.map(ref => ({ workId, artifactId: ref.artifactId, revisionId: ref.revisionId, path: ref.path })) : []) : [];
    return {
      content: [{ type: 'text', text: `Goal ${goal.id}: ${goal.status}; ${view.completedSteps}/${view.totalSteps} chapter steps verified. This is foreground execution; no background loop was started. Acceptance covers committed chapters and settled state, not editorial approval or publishing.` }],
      details: { kind: 'chapter_goal_status', workId, goal: view, committedArtifacts,
        observations: ['failed', 'reconciliation_required', 'waiting_user', 'interrupted', 'ready'].includes(goal.status)
          ? [{ code: goal.error?.code ?? 'GOAL_INCOMPLETE', category: 'execution', assessment: 'unavailable',
              summary: goal.error?.message ?? `Goal remains ${goal.status}; it has not completed.`, evidence: [] }] : [] },
    };
  };
  return [
    { name: 'create_chapter_goal', label: 'Create fixed chapter goal', parameters: Create,
      artifactsCommitted: true, managesWorkLock: true,
      description: 'Persist a fixed chapter range and deadline for this Work. Same ID and input are idempotent. Creation is paused and does not infer. When the current request authorizes writing, proceed directly to run_chapter_goal using the returned version; no extra user approval is introduced.',
      execute: async (_id, params) => withService(async service => result(await service.create({ ...params, id: params.goalId, workId }))),
    },
    { name: 'inspect_chapter_goal', label: 'Inspect chapter goal', parameters: Inspect,
      description: 'Read this Work’s persistent goal state and bounded events without model execution. Omit goalId to list its goals. State survives process exit; reading it does not recover or start execution.',
      execute: async (_id, params) => withService(service => {
        const details = params.goalId
          ? { workId, goal: chapterGoalView(service.get(params.goalId, workId)), ...service.events(params.goalId, { workId, afterSeq: params.afterSeq, limit: params.limit }) }
          : { workId, goals: service.list(workId).map(goal => { const view = chapterGoalView(goal); return { id: view.id, status: view.status, desiredState: view.desiredState, version: view.version, completedSteps: view.completedSteps, totalSteps: view.totalSteps, nextStepId: view.nextStepId, error: view.error, budget: view.budget, owner: view.owner }; }) };
        return { content: [{ type: 'text', text: JSON.stringify(details) }], details };
      }),
    },
    { name: 'run_chapter_goal', label: 'Run remaining chapter goal', parameters: Run,
      artifactsCommitted: true, managesWorkLock: true,
      description: 'Run the remaining verified chapter steps under the existing fixed target and budget. Supply the latest version from create/inspect. Previously completed chapters are reconciled, not regenerated. This foreground action owns execution until it returns; a return is not a promise of a background loop.',
      execute: async (_id, params, signal) => withService(async service => {
        const before = service.get(params.goalId, workId);
        const goal = await runAsWorkflowTrajectory(() => pipeline.runWithAgentContext({
          workerSkills: worker => mergeActivatedSkillGuidance(options.workerSkills?.(worker) ?? [], options.activeSkills?.() ?? []),
        }, () => service.run(params.goalId, params.expectedVersion, { signal, workId })));
        return result(goal, before.status !== 'completed');
      }),
    },
    { name: 'control_chapter_goal', label: 'Control chapter goal', parameters: Control,
      artifactsCommitted: true, managesWorkLock: true,
      description: 'Persist pause/cancel or reconcile a dead executor for this Work at the expected version. Recover never starts inference and never steals a live owner. Under an active authorized request, recover followed by run can continue without another user approval; never undo a user’s pause/cancellation automatically.',
      execute: async (_id, params) => withService(service => {
        if (params.action === 'recover') return result(service.recover(params.goalId, params.expectedVersion, workId));
        if (params.action === 'pause' || params.action === 'cancel') return result(service.stop(params.goalId,
          params.action === 'pause' ? 'paused' : 'cancelled', params.expectedVersion, workId));
        throw goalError('GOAL_CONTROL_INVALID', 'Choose pause, cancel, or recover.');
      }),
    },
  ];
}
