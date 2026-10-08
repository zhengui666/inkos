import { z } from 'zod';
import { HarnessIdSchema } from '../harness/contracts.js';

const Label = z.string().trim().min(1).max(500);
export const MegaNovelScopeSchema = z.object({
  // For CDP this is the actual browser target ID, never an invented login/session token.
  sessionId: Label, accountId: Label, accountLabel: Label, remoteBookId: Label,
}).strict();
export type MegaNovelScope = z.infer<typeof MegaNovelScopeSchema>;
export const MegaNovelIntentSchema = z.object({
  packageId: HarnessIdSchema, chapterNumber: z.number().int().positive(),
  scope: MegaNovelScopeSchema, aiAssisted: z.boolean(),
}).strict();
export type MegaNovelIntent = z.infer<typeof MegaNovelIntentSchema>;
export const MegaNovelPhaseSchema = z.enum([
  'draft_unknown', 'draft', 'submit_unknown', 'submitted', 'reviewing', 'published', 'rejected',
]);
export const MegaNovelRunSchema = z.object({
  ...MegaNovelIntentSchema.shape,
  revisionId: HarnessIdSchema,
  phase: MegaNovelPhaseSchema,
  remoteChapterId: Label.nullable(), evidence: z.string().max(8000).nullable(),
}).strict().superRefine((run, ctx) => {
  if (!['draft_unknown', 'submit_unknown'].includes(run.phase) && (!run.remoteChapterId || !run.evidence?.trim())) {
    ctx.addIssue({code: z.ZodIssueCode.custom, message: 'An observed state needs the actual remote chapter ID and readback evidence.'});
  }
});
export type MegaNovelRun = z.infer<typeof MegaNovelRunSchema>;
export const MegaNovelProbeSchema = z.object({
  scope: MegaNovelScopeSchema,
  origin: z.literal('https://www.meganovel.com'),
  blocker: z.enum(['none', 'login', 'captcha', 'agreement', 'risk_control', 'quota', 'unrecognized_ui']),
}).strict();
export type MegaNovelProbe = z.infer<typeof MegaNovelProbeSchema>;
export const MegaNovelSnapshotSchema = MegaNovelProbeSchema.extend({
  chapterNumber: z.number().int().positive(),
  // A scoped lookup, not a dump of the author's other chapters. Absence needs all relevant views.
  complete: z.boolean(),
  candidates: z.array(z.object({
    remoteChapterId: Label, number: z.number().int().positive(), title: Label, content: z.string(),
    status: z.enum(['draft', 'submitted', 'reviewing', 'published', 'rejected']),
    aiDisclosure: z.enum(['declared_ai', 'declared_human', 'not_present', 'unverified']),
    evidence: z.string().trim().min(1).max(8000),
  }).strict()),
}).strict();
export type MegaNovelSnapshot = z.infer<typeof MegaNovelSnapshotSchema>;
/** Read-only observations have no package reservation or submission declaration. */
export const MegaNovelSnapshotRequestSchema = z.object({
  scope: MegaNovelScopeSchema, chapterNumber: z.number().int().positive(), expectedTitle: Label.optional(), remoteChapterId: Label.optional(),
}).strict();
export type MegaNovelSnapshotRequest = z.infer<typeof MegaNovelSnapshotRequestSchema>;
export interface MegaNovelObservationPort {
  probe(scope: MegaNovelScope, options?: MegaNovelBrowserOptions): Promise<MegaNovelProbe>;
  snapshot(input: MegaNovelSnapshotRequest, options?: MegaNovelBrowserOptions): Promise<MegaNovelSnapshot>;
}
export interface MegaNovelBrowserOptions {
  signal?: AbortSignal;
  /** Recheck local authority after async preflight, immediately before each editor effect. */
  beforeMutation?: () => Promise<void>;
}

/** Browser paragraph text may omit the document's final newline. No prose or internal spacing is changed. */
export function normalizeMegaNovelBodyText(content: string): string {
  return content.replace(/\r\n?/gu, '\n').replace(/\n+$/u, '');
}

/** A port operates an already-authorized, exclusively owned browser tab; it never authenticates. */
export interface MegaNovelBrowserPort {
  /** Read only: no editor creation, typing, agreement, credential or session changes. */
  probe(scope: MegaNovelScope, options?: MegaNovelBrowserOptions): Promise<MegaNovelProbe>;
  /** Independent reopened UI read, including drafts and submission/publication lists. */
  snapshot(input: MegaNovelIntent & {remoteChapterId?: string; expectedTitle?: string}, options?: MegaNovelBrowserOptions): Promise<MegaNovelSnapshot>;
  /** Recheck scope/blockers immediately before typing: editor input can autosave. No internal retries. */
  createDraft(input: MegaNovelIntent & {title: string; content: string; revisionId: string}, options?: MegaNovelBrowserOptions): Promise<void>;
  /** Check exact draft/title/body and truthful AI disclosure immediately before final action. */
  submit(input: MegaNovelIntent & {remoteChapterId: string; title: string; content: string; revisionId: string}, options?: MegaNovelBrowserOptions): Promise<void>;
}
