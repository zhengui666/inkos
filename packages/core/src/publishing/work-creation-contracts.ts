import { z } from 'zod';
import { HarnessIdSchema, WorkResourceIdSchema } from '../harness/contracts.js';
import { PublishingPlatformSchema } from './contracts.js';

// Do not normalize the frozen submission or its receipt while comparing them.
const Text = z.string().min(1).refine(value => value.trim().length > 0, 'Use nonempty text.');
const Label = Text.refine(value => value === value.trim(), 'Labels cannot have surrounding whitespace.')
  .refine(value => value.length <= 500, 'Labels must be at most 500 characters.');
const Timestamp = z.number().finite().nonnegative();

export const RemoteWorkDestinationSchema = z.object({
  provider: Label, platform: PublishingPlatformSchema,
  accountLabel: Label, accountId: Label, sessionId: Label,
}).strict();
export type RemoteWorkDestination = z.infer<typeof RemoteWorkDestinationSchema>;

export const RemoteWorkMetadataSchema = z.object({
  title: Text, blurb: Text, genre: Text, language: z.enum(['zh', 'en']), aiAssisted: z.boolean(),
}).strict();
export type RemoteWorkMetadata = z.infer<typeof RemoteWorkMetadataSchema>;

export const RemoteWorkInputSchema = z.object({
  workId: WorkResourceIdSchema, destination: RemoteWorkDestinationSchema, metadata: RemoteWorkMetadataSchema,
}).strict();
export type RemoteWorkInput = z.infer<typeof RemoteWorkInputSchema>;

export const RemoteWorkReceiptSchema = z.object({
  operationId: HarnessIdSchema, destination: RemoteWorkDestinationSchema, metadata: RemoteWorkMetadataSchema,
  remoteBookId: Label, observedAt: Timestamp, evidence: Text,
  provenance: z.literal('independently_observed'),
  verifiedURL: z.string().url().refine(value => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && url.hostname.length > 0 && !url.username && !url.password
        && value === value.trim() && !/[\u0000-\u0020\u007f]/u.test(value);
    } catch { return false; }
  }, 'Use an HTTPS URL without credentials.').optional(),
}).strict();
export type RemoteWorkReceipt = z.infer<typeof RemoteWorkReceiptSchema>;

export const RemoteWorkPhaseSchema = z.enum(['ready', 'create_unknown', 'observed', 'bound']);
export type RemoteWorkPhase = z.infer<typeof RemoteWorkPhaseSchema>;
export const RemoteWorkBlockerSchema = z.object({
  status: z.enum(['unsupported', 'needs_setup', 'needs_confirmation', 'reconciliation_required']),
  code: Label, message: Text,
}).strict();
export type RemoteWorkBlocker = z.infer<typeof RemoteWorkBlockerSchema>;

export const RemoteWorkRunSchema = z.object({
  id: HarnessIdSchema, input: RemoteWorkInputSchema, version: z.number().int().nonnegative(),
  phase: RemoteWorkPhaseSchema, attempts: z.union([z.literal(0), z.literal(1)]),
  unverifiedRemoteBookId: Label.nullable(),
  attemptedAt: Timestamp.nullable(), receipt: RemoteWorkReceiptSchema.nullable(),
  targetId: HarnessIdSchema.nullable(), blocker: RemoteWorkBlockerSchema.nullable(),
  createdAt: Timestamp, updatedAt: Timestamp,
}).strict().superRefine((run, ctx) => {
  const attempted = run.attempts === 1 && run.attemptedAt !== null;
  const validPhase = run.phase === 'ready'
    ? run.attempts === 0 && run.attemptedAt === null && run.receipt === null && run.targetId === null && run.unverifiedRemoteBookId === null
    : run.phase === 'create_unknown'
      ? attempted && run.receipt === null && run.targetId === null
      : run.phase === 'observed'
        ? attempted && run.receipt !== null && run.targetId === null
        : attempted && run.receipt !== null && run.targetId !== null;
  if (!validPhase) ctx.addIssue({code: z.ZodIssueCode.custom, message: 'Creation phase and durable history disagree.'});
  if (run.receipt && (run.receipt.operationId !== run.id
    || JSON.stringify(run.receipt.destination) !== JSON.stringify(run.input.destination)
    || JSON.stringify(run.receipt.metadata) !== JSON.stringify(run.input.metadata)
    || run.unverifiedRemoteBookId !== null && run.unverifiedRemoteBookId !== run.receipt.remoteBookId
    || run.attemptedAt === null || run.receipt.observedAt < run.attemptedAt)) {
    ctx.addIssue({code: z.ZodIssueCode.custom, message: 'Observation does not match the frozen creation attempt.'});
  }
});
export type RemoteWorkRun = z.infer<typeof RemoteWorkRunSchema>;
export type RemoteWorkStatus = RemoteWorkPhase | RemoteWorkBlocker['status'];
export type RemoteWorkView = RemoteWorkRun & {status: RemoteWorkStatus};

/** A blocker is an overlay; it must never hide or reset the durable mutation phase. */
export function remoteWorkView(run: RemoteWorkRun): RemoteWorkView {
  const parsed = RemoteWorkRunSchema.parse(run);
  return {...parsed, status: parsed.blocker?.status ?? parsed.phase};
}
