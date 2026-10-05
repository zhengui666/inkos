import { z } from 'zod';
import { HarnessIdSchema, WorkResourceIdSchema } from '../harness/contracts.js';

export const PublishingPlatformSchema = z.enum(['fanqie', 'qidian', 'qimao', 'meganovel', 'goodnovel', 'dreame']);
export type PublishingPlatform = z.infer<typeof PublishingPlatformSchema>;
const Label = z.string().trim().min(1).max(500);
export const PublishingTargetInputSchema = z.object({
  workId: WorkResourceIdSchema, platform: PublishingPlatformSchema,
  accountLabel: Label, remoteBookId: Label,
}).strict();
export const PublishingTargetSchema = PublishingTargetInputSchema.extend({
  id: HarnessIdSchema, createdAt: z.string(), verification: z.literal('user_supplied'),
});
export type PublishingTarget = z.infer<typeof PublishingTargetSchema>;

export const PublishingSelectionSchema = z.array(z.object({
  artifactId: WorkResourceIdSchema, revisionId: HarnessIdSchema,
  number: z.number().int().positive(), title: Label,
}).strict()).min(1).superRefine((chapters, ctx) => {
  if (new Set(chapters.map(c => c.number)).size !== chapters.length
    || new Set(chapters.map(c => c.artifactId)).size !== chapters.length) {
    ctx.addIssue({code: z.ZodIssueCode.custom, message: 'Select each chapter number and artifact only once.'});
  }
});
export type PublishingSelection = z.infer<typeof PublishingSelectionSchema>;
export const PublishingFormatsSchema = z.array(z.enum(['txt', 'md', 'epub'])).min(1);
export const PublishingFileSchema = z.object({
  path: z.string().regex(/^(chapters\/[0-9]+_chapter\.md|exports\/book\.(txt|md|epub)|README\.txt)$/u),
  checksum: z.string().optional(), contentBase64: z.string().optional(), byteLength: z.number().int().nonnegative(),
}).strict();
export const PublishingManifestSchema = z.object({
  version: z.literal(1), adapter: z.literal('manual'), id: HarnessIdSchema,
  operationKey: z.string(), createdAt: z.string(), target: PublishingTargetSchema,
  title: Label, language: z.string().min(1),
  chapters: z.array(z.object({
    artifactId: WorkResourceIdSchema, revisionId: HarnessIdSchema,
    number: z.number().int().positive(), title: Label,
    checksum: z.string().optional(), sourcePath: z.string(), packagePath: PublishingFileSchema.shape.path,
  }).strict()).min(1),
  formats: PublishingFormatsSchema, files: z.array(PublishingFileSchema).min(1),
  remoteVerified: z.literal(false),
}).strict();
export type PublishingManifest = z.infer<typeof PublishingManifestSchema>;
/** Compare recorded selections and actual bytes; former digest metadata is read-only history. */
export function publishingManifestValue(manifest: PublishingManifest): string {
  return JSON.stringify({...manifest,
    chapters: manifest.chapters.map(({checksum: _legacy, ...chapter}) => chapter),
    files: manifest.files.map(({checksum: _legacy, ...file}) => file),
  });
}
export const PublishingChapterStatusSchema = z.enum([
  'awaiting_submission', 'awaiting_receipt', 'submission_unknown',
  'submitted_reported', 'published_reported', 'not_submitted_reported',
]);
export type PublishingChapterStatus = z.infer<typeof PublishingChapterStatusSchema>;
export const PublishingReceiptSchema = z.object({
  status: z.enum(['submission_unknown', 'submitted_reported', 'published_reported', 'not_submitted_reported']),
  evidence: z.string().trim().min(1).max(8000),
  remoteChapterId: Label.optional(),
}).strict().superRefine((receipt, ctx) => {
  if (receipt.status === 'published_reported' && !receipt.remoteChapterId) {
    ctx.addIssue({code: z.ZodIssueCode.custom, message: 'A reported publication needs the platform chapter ID.'});
  }
  if (receipt.status === 'not_submitted_reported' && receipt.remoteChapterId) {
    ctx.addIssue({code: z.ZodIssueCode.custom, message: 'An absent submission cannot have a platform chapter ID.'});
  }
});
export type PublishingReceipt = z.infer<typeof PublishingReceiptSchema>;
export interface PublishingPackage {
  readonly manifest: PublishingManifest;
  readonly version: number;
  readonly chapters: Array<{
    number: number; status: PublishingChapterStatus; remoteChapterId: string | null;
    evidence: string | null; provenance: 'user_reported' | null;
  }>;
  readonly remoteVerified: false;
}
export function publishingError(code: string, message: string): Error & {code: string} {
  return Object.assign(new Error(message), {code});
}
