import { z } from 'zod';
import type { BookConfig } from '../models/book.js';
import type { ProjectConfig } from '../models/project.js';

export const CreationRequestSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(['long', 'short']),
  brief: z.string().trim().min(5).max(4000),
}).strict();
export type CreationRequest = z.infer<typeof CreationRequestSchema>;
export const CreationPlanSchema = z.object({
  title: z.string().trim().min(1).max(120),
  genre: z.string().trim().min(1).max(100),
  /** Public-facing metadata, never the raw author brief or private planning instructions. */
  blurb: z.string().trim().min(1).max(2000).optional(),
  language: z.enum(['zh', 'en']),
  platform: z.string().trim().min(1).max(100).nullable(),
  targetChapters: z.number().int().min(1).max(2000),
  chapterWordCount: z.number().int().min(1).max(20000),
}).strict();
export const CreationControlSchema = z.object({ version: z.number().int().nonnegative() }).strict();
export const CreationPlanUpdateSchema = z.object({ version: z.number().int().nonnegative(), plan: CreationPlanSchema }).strict();
export type CreationPlan = z.infer<typeof CreationPlanSchema>;
export type CreationPhase = 'queued' | 'planning' | 'writing' | 'reviewing' | 'revising' | 'publishing' | 'blocked' | 'completed';
export interface CreationTask {
  id: string; workId: string; request: CreationRequest; plan: CreationPlan;
  planStatus?: 'provisional' | 'ready'; planOverrides?: Partial<CreationPlan>; endingIntent?: string; planSummary?: string;
  version: number; desiredState: 'run' | 'paused'; phase: CreationPhase;
  foundation: 'pending' | 'completed' | 'blocked'; foundationAttempts: number; foundationTransientFailures?: number;
  /** Settled nontransient failures; cumulative attempts also include pauses. */
  foundationFailures?: number;
  nextAttemptAt: number; createdAt: number; updatedAt: number;
  error?: { code: string; message: string };
}
export function inferCreationPlan(request: CreationRequest, config: Pick<ProjectConfig, 'language' | 'daemon'>): CreationPlan {
  const language = config.daemon.market?.language ?? config.language;
  const targetChapters = request.kind === 'short' ? 1 : config.daemon.market?.autoCreate?.targetChapters ?? 120;
  const chapterWordCount = request.kind === 'short' ? (language === 'zh' ? 6000 : 3500)
    : config.daemon.market?.autoCreate?.chapterWordCount ?? (language === 'zh' ? 2500 : 1800);
  return CreationPlanSchema.parse({
    title: (request.brief.split(/[\n。！？.!?]/u).find(part => part.trim())?.trim() ?? (language === 'zh' ? '新故事' : 'New story')).slice(0, 60), language,
    genre: /悬疑|推理|侦探|mystery|detective/iu.test(request.brief) ? 'mystery'
      : /爱情|恋爱|言情|romance|love/iu.test(request.brief) ? 'romance'
      : /科幻|太空|星际|sci.?fi|space/iu.test(request.brief) ? 'science-fiction'
      : /修仙|玄幻|魔法|奇幻|fantasy|magic/iu.test(request.brief) ? 'fantasy' : 'original-fiction',
    platform: config.daemon.market?.platform ?? null,
    targetChapters, chapterWordCount,
  });
}
export function creationBook(task: CreationTask): BookConfig {
  if (!task.plan.platform) throw creationError('CREATION_PLATFORM_REQUIRED', 'Choose a publishing platform in this task’s plan. No destination was guessed.');
  const {blurb: _blurb, ...bookPlan} = task.plan;
  return { ...bookPlan, platform: task.plan.platform, id: task.workId, status: 'outlining',
    createdAt: new Date(task.createdAt).toISOString(), updatedAt: new Date(task.updatedAt).toISOString() };
}
export function creationInstruction(task: CreationTask, chapter?: number): string {
  const final = chapter === task.plan.targetChapters;
  return [
    `Author brief (${task.request.kind === 'short' ? 'self-contained short fiction' : 'finite long-form novel'}): ${task.request.brief}`,
    `Write in ${task.plan.language} for ${task.plan.platform ?? 'the author-selected platform'}.`,
    `Current editable length plan (explicit author constraints in the brief take precedence over defaults): the ending boundary is ${task.plan.targetChapters} chapter(s), approximately ${task.plan.chapterWordCount} words/characters per chapter. Do not silently extend this boundary.`,
    task.endingIntent ? `Planned story resolution: ${task.endingIntent}` : '',
    'Infer a specific reader promise, original premise, characters, causal conflict and an earned ending from this brief. Plan backwards from that ending, with a structure appropriate to this story, not a fixed sequence of beats.',
    task.request.kind === 'short' ? 'This is a complete short story, not the opening of an endless serial. Resolve its central conflict within the approved length.'
      : 'Give the long story a finite main arc. Intermediate installments can carry momentum, but the final installment must deliver the main promise and close the central conflict.',
    final ? 'THIS IS THE FINAL CHAPTER. Deliver the earned ending, resolve the central reader promise and important outstanding threads. Do not advertise or require an unapproved next chapter.'
      : chapter ? `Write chapter ${chapter}; preserve continuity and make meaningful progress toward the retained ending.` : '',
  ].filter(Boolean).join('\n');
}
export function creationError(code: string, message: string): Error & { code: string } { return Object.assign(new Error(message), { code }); }

export function canResumeCreationTask(task: CreationTask): boolean {
  if (task.phase === 'completed') return false;
  return task.phase !== 'blocked' || (task.foundation !== 'blocked'
    && ['CREATION_PLATFORM_REQUIRED', 'CREATION_PUBLISHER_REQUIRED', 'PUBLISHING_BINDING_MISSING', 'PUBLISHING_MANUAL_REQUIRED', 'PUBLISHING_TARGET_CONFLICT', 'CREATION_TRANSIENT_WRITE_PAUSED'].includes(task.error?.code ?? ''));
}
