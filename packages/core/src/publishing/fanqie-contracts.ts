import { z } from 'zod';
import { HarnessIdSchema } from '../harness/contracts.js';

const Label = z.string().trim().min(1).max(500);
export const FanqieInstantSchema = z.string().datetime({offset: true}).refine(value => Number.isFinite(Date.parse(value)), 'Use a valid timestamp and UTC offset.');
export const FanqieScopeSchema = z.object({
  sessionId: Label, accountId: Label, accountLabel: Label, remoteBookId: Label,
}).strict();
export type FanqieScope = z.infer<typeof FanqieScopeSchema>;
export const FanqieIntentSchema = z.object({
  packageId: HarnessIdSchema, chapterNumber: z.number().int().positive(),
  scope: FanqieScopeSchema,
  // No default: the caller must establish the actual content provenance.
  aiAssisted: z.boolean(),
}).strict();
export type FanqieIntent = z.infer<typeof FanqieIntentSchema>;
export const FanqieRunSchema = z.object({
  ...FanqieIntentSchema.shape,
  checksum: z.string().optional(), revisionId: HarnessIdSchema.optional(),
  phase: z.enum(['draft_unknown', 'draft', 'schedule_unknown', 'scheduled', 'reviewing', 'published', 'rejected']),
  remoteChapterId: Label.nullable(), scheduledFor: FanqieInstantSchema.nullable(),
  evidence: z.string().max(8000).nullable(),
}).strict();
export type FanqieRun = z.infer<typeof FanqieRunSchema>;
export const FanqieSnapshotSchema = z.object({
  scope: FanqieScopeSchema,
  origin: z.literal('https://fanqienovel.com'),
  // A port must report these from the current UI, not infer them from login alone.
  blocker: z.enum(['none', 'login', 'captcha', 'agreement', 'risk_control', 'quota', 'unrecognized_ui']),
  schedulingAvailable: z.boolean(),
  complete: z.boolean(), // all draft, review/scheduled, published/rejected pages scanned
  chapters: z.array(z.object({
    remoteChapterId: Label, number: z.number().int().positive(), title: Label,
    contentChecksum: z.string().optional(), content: z.string().optional(), aiAssisted: z.boolean().nullable(),
    status: z.enum(['draft', 'reviewing', 'scheduled', 'published', 'rejected']),
    scheduledFor: FanqieInstantSchema.nullable(),
    evidence: z.string().trim().min(1).max(8000),
  }).strict()),
}).strict();
export type FanqieSnapshot = z.infer<typeof FanqieSnapshotSchema>;

/**
 * Inject only a calibrated, already-authorized tab. No login, credentials, private API or guessed selectors.
 * The port owns the tab exclusively and serializes its snapshot/mutation workflows. It must never retry
 * a mutation internally, including autosaving editor input. Reject an unrecognized UI instead of guessing.
 */
export interface FanqieBrowserPort {
  snapshot(scope: FanqieScope): Promise<FanqieSnapshot>;
  /** Recheck scope/blockers immediately before typing; typing may autosave. Return is NOT proof of save. */
  createDraft(input: FanqieIntent & {title: string; content: string; revisionId: string; checksum?: string}): Promise<void>;
  /** Recheck scope, exact chapter, content, truthful declaration and preview before final action. */
  schedule(input: FanqieIntent & {remoteChapterId: string; content: string; revisionId: string; checksum?: string; scheduledFor: string}): Promise<void>;
}
