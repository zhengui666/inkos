import { configure, defineTask, UsageDoc, type ConversationId, type JsonObject, type TaskRuntime, type RunningTask } from '@earendil-works/pi-durable';
import type { Context } from '@earendil-works/chord';
import { contentText } from '@earendil-works/pi-ai';
import { Works, Artifacts, Reviews, reviewKey, type Work, type ReviewResult } from '../../works/documents.js';
import { saveArtifact, savedRevision, readArtifact } from '../../works/artifacts.js';
import { commitRevision } from '../../works/service.js';
import { findProfile, measureLength, type ContentProfile } from '../../runtime/plugins.js';
import { retrieveMaterials } from '../../materials/retrieve.js';
import { blockingIssues, parseJson, ReviewSchema, reviewInstructions } from './review.js';
import { profileGuidance } from './skills.js';
import { completedUnits } from '../../works/progress.js';

export type ContentInput = { workId: string; artifactId: string; revisionId: string; title: string; content?: string; instruction?: string };
type Phase = 'prepare' | 'plan' | 'compose' | 'review' | 'revise' | 'save';
export type ContentCheckpoint = { [P in Phase]: { phase: P; child: ConversationId | null; children: ConversationId[]; contextText: string; attempt: number; revisionId: string; review: ReviewResult | null } }[Phase];
type Result = { artifactId: string; revisionId: string };
type Runtime = TaskRuntime<ContentInput, ContentCheckpoint, Result, {}>;
type Invocation = RunningTask<ContentInput, ContentCheckpoint, Result>;

/** Pause is domain intent, not a terminal abort. Native document watches wake the current invocation. */
export async function atBoundary(runtime: Pick<Runtime, 'snapshot' | 'watchDoc' | 'signal'>, workId: string, context: Context): Promise<Work> {
  let work = await runtime.snapshot(Works, workId, context);
  if (!work) throw new Error('Work not found');
  if (work.pauseRequested) {
    const watch = await runtime.watchDoc(Works, workId, context);
    if (!watch) throw new Error('Work document not found');
    try {
      if (watch.value?.pauseRequested) await new Promise<void>((resolve, reject) => {
        const abort = () => reject(runtime.signal.reason ?? new Error('Invocation stopped'));
        runtime.signal.addEventListener('abort', abort, { once: true });
        watch.start(async value => { if (!value?.pauseRequested) { runtime.signal.removeEventListener('abort', abort); resolve(); } });
        if (runtime.signal.aborted) abort();
      });
    } finally { await watch.stop(); }
    work = await runtime.snapshot(Works, workId, context);
  }
  if (!work || work.status === 'cancelled') throw new Error('Work was cancelled');
  return work;
}
async function ask(task: Invocation, runtime: Runtime, context: Context, instructions: string, prompt: string): Promise<string | undefined> {
  const checkpoint = task.state.checkpoint;
  if (checkpoint.child === null) {
    await runtime.commit(async tx => {
      const child = await tx.createConversation({ ownership: { kind: 'task', taskId: task.id } });
      await configure(tx, child.id, { instructions, tools: [] });
      return { status: 'running', checkpoint: { ...checkpoint, child: child.id, children: [...checkpoint.children, child.id] } };
    }, context);
    return undefined;
  }
  const conversation = await runtime.conversation(checkpoint.child, context);
  if (!conversation) throw new Error('Owned conversation missing');
  const settled = await (await conversation.submit({ type: 'input', content: prompt, requestId: `content:${task.id}:${checkpoint.phase}:${checkpoint.attempt}` }, context)).wait(context);
  if (settled.status !== 'done' || settled.type !== 'input') throw new Error(`Model step failed (${checkpoint.phase}); saved content retained`);
  const entry = await runtime.entry(settled.answer, context);
  const answer = entry?.model?.find(message => message.role === 'assistant');
  if (!answer || answer.role !== 'assistant') throw new Error('Model step has no assistant answer');
  return contentText(answer.content);
}
function validateContent(profile: ContentProfile, text: string): JsonObject | undefined {
  return profile.parseDomain?.(text);
}
async function withinBudget(task: Invocation, runtime: Runtime, work: Work, context: Context) {
  if (work.plan.review.maxCost === null) return;
  const children = task.state.checkpoint.children;
  let cost = 0;
  for (const id of children) {
    const usage = await runtime.snapshot(UsageDoc, id as ConversationId, context);
    cost += Object.values(usage?.models ?? {}).reduce((total, value) => total + value.cost.total, 0);
  }
  if (cost >= work.plan.review.maxCost) throw new Error('Configured model budget reached; saved revisions retained');
}
export function createContentTask(rootDir: string) {
  return defineTask<ContentInput, ContentCheckpoint, Result, {}>({
    name: 'inkos.content', version: 1,
    initial: input => ({ phase: 'prepare', child: null, children: [], contextText: '', attempt: 0, revisionId: input.revisionId, review: null }),
    phases: {
      prepare: async (task, runtime, context) => {
        const work = await atBoundary(runtime, task.input.workId, context);
        const profile = findProfile(runtime.registry, work.profile);
        const materials = await retrieveMaterials(rootDir, { query: task.input.instruction ?? work.plan.brief });
        const previousArtifact = work.artifactIds.length ? await runtime.snapshot(Artifacts, work.artifactIds.at(-1)!, context) : undefined;
        const previousRevision = previousArtifact?.revisions.find(revision => revision.id === previousArtifact.currentRevision);
        const previousContent = previousRevision && !previousRevision.format.startsWith('image/') ? await readArtifact(rootDir, previousRevision) : undefined;
        const guidance = await profileGuidance(rootDir, work.profile, Array.isArray(work.domain.skills) ? work.domain.skills.filter((id): id is string => typeof id === 'string') : []);
        const contextText = JSON.stringify({ brief: work.plan.brief, locale: work.locale, plan: work.plan, domain: work.domain, guidance, previousContent,
          materials: materials.filter(item => !work.materialIds.length || work.materialIds.includes(item.id)), instruction: task.input.instruction ?? '' });
        await runtime.commit(async tx => {
          const doc = await tx.doc(Works, work.id, work); if (!doc.pauseRequested) doc.status = 'active';
          return { status: 'running', checkpoint: { ...task.state.checkpoint, contextText: `${profile.instructions}\n${contextText}`, phase: work.plan.needsPlanning && task.input.content === undefined ? 'plan' : 'compose' } };
        }, context);
      },
      plan: async (task, runtime, context) => {
        const work = await atBoundary(runtime, task.input.workId, context); await withinBudget(task, runtime, work, context);
        const answer = await ask(task, runtime, context, 'Prepare only the necessary plan. Preserve author directions and established facts. Do not write the finished content or add global commercial obligations.', task.state.checkpoint.contextText);
        if (answer === undefined) return;
        await runtime.commit(() => ({ status: 'running', checkpoint: { ...task.state.checkpoint, phase: 'compose', child: null, contextText: `${task.state.checkpoint.contextText}\nCurrent plan:\n${answer}` } }), context);
      },
      compose: async (task, runtime, context) => {
        const work = await atBoundary(runtime, task.input.workId, context);
        const profile = findProfile(runtime.registry, work.profile);
        let revision = await savedRevision(rootDir, work.id, task.input.artifactId, task.state.checkpoint.revisionId);
        if (!revision) {
          if (task.input.content === undefined) await withinBudget(task, runtime, work, context);
          const text = task.input.content ?? await ask(task, runtime, context, profile.instructions, `${task.state.checkpoint.contextText}\nLatest author brief: ${work.plan.brief}\nProduce ${task.input.title}. Return only the requested content, using locale ${work.locale}.`);
          if (text === undefined) return;
          validateContent(profile, text);
          revision = await saveArtifact(rootDir, { id: task.state.checkpoint.revisionId, workId: work.id, artifactId: task.input.artifactId,
            title: task.input.title, content: text, format: profile.format, metadata: { role: 'content', locale: work.locale, profile: work.profile, length: measureLength(text, work.locale, profile.countingUnit) } });
        }
        await runtime.commit(() => ({ status: 'running', checkpoint: { ...task.state.checkpoint, phase: work.plan.review.enabled ? 'review' : 'save', child: null } }), context);
      },
      review: async (task, runtime, context) => {
        const work = await atBoundary(runtime, task.input.workId, context);
        const key = reviewKey(task.state.checkpoint.revisionId, work.plan.review.id);
        let review = await runtime.snapshot(Reviews, key, context);
        if (!review) {
          await withinBudget(task, runtime, work, context);
          const revision = await savedRevision(rootDir, work.id, task.input.artifactId, task.state.checkpoint.revisionId);
          if (!revision) throw new Error('Draft revision missing');
          const text = await ask(task, runtime, context, reviewInstructions, `${task.state.checkpoint.contextText}\nDraft:\n${await readArtifact(rootDir, revision)}`);
          if (text === undefined) return;
          const parsed = ReviewSchema.parse(parseJson(text));
          review = { revisionId: revision.id, policyId: work.plan.review.id, issues: parsed.issues, storyState: parsed.storyState, completedAt: Date.now() };
        }
        const result = review;
        const blocking = blockingIssues(result);
        if (blocking.length && task.state.checkpoint.attempt >= work.plan.review.maxRevisions) throw new Error('Unresolved author requirements after configured revision budget; draft retained');
        await runtime.commit(async tx => {
          await tx.doc(Reviews, key, result);
          return { status: 'running', checkpoint: { ...task.state.checkpoint, review: result, phase: blocking.length ? 'revise' : 'save', child: null } };
        }, context);
      },
      revise: async (task, runtime, context) => {
        const work = await atBoundary(runtime, task.input.workId, context);
        const checkpoint = task.state.checkpoint;
        const nextId = `${task.input.revisionId}-edit-${checkpoint.attempt + 1}`;
        let revision = await savedRevision(rootDir, work.id, task.input.artifactId, nextId);
        if (!revision) {
          await withinBudget(task, runtime, work, context);
          const prior = await savedRevision(rootDir, work.id, task.input.artifactId, checkpoint.revisionId);
          if (!prior || !checkpoint.review) throw new Error('Revision input missing');
          const profile = findProfile(runtime.registry, work.profile);
          const answer = await ask(task, runtime, context, `${profile.instructions}\nMake only the necessary corrections; keep all unaffected content.`, JSON.stringify({ draft: await readArtifact(rootDir, prior), issues: blockingIssues(checkpoint.review), author: work.plan.brief }));
          if (answer === undefined) return;
          validateContent(profile, answer);
          revision = await saveArtifact(rootDir, { id: nextId, artifactId: task.input.artifactId, workId: work.id, title: task.input.title, format: profile.format, content: answer, metadata: { ...prior.metadata, role: 'content', revises: prior.id } });
        }
        await runtime.commit(() => ({ status: 'running', checkpoint: { ...checkpoint, phase: 'review', revisionId: revision.id, attempt: checkpoint.attempt + 1, child: null, review: null } }), context);
      },
      save: async (task, runtime, context) => {
        const work = await atBoundary(runtime, task.input.workId, context);
        const revision = await savedRevision(rootDir, work.id, task.input.artifactId, task.state.checkpoint.revisionId);
        if (!revision) throw new Error('Saved revision missing');
        const structured = validateContent(findProfile(runtime.registry, work.profile), await readArtifact(rootDir, revision));
        const domain = structured ?? task.state.checkpoint.review?.storyState;
        const units = await completedUnits(runtime, work, context) + (work.artifactIds.includes(revision.artifactId) ? 0 : 1);
        await runtime.commit(async tx => {
          await commitRevision(tx, work, revision, domain, rootDir);
          const doc = await tx.doc(Works, work.id, work);
          if (!doc.plan.serial && doc.plan.units !== null && units >= doc.plan.units) doc.status = 'completed';
          return { status: 'terminal', outcome: { status: 'completed', result: { artifactId: revision.artifactId, revisionId: revision.id } } };
        }, context);
      },
    },
    abort: async (task, runtime, context) => {
      const work = await runtime.snapshot(Works, task.input.workId, context);
      await runtime.commit(async tx => {
        if (work) (await tx.doc(Works, work.id, work)).status = 'cancelled';
        return { status: 'terminal', outcome: { status: 'aborted' } };
      }, context);
    },
  });
}
