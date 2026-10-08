import { z } from "zod";
import { WorkResourceIdSchema } from "../harness/contracts.js";

const Id = z.string().min(1).max(200);
const Timestamp = z.number().int().nonnegative().safe();
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
const Json: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string(), z.number().finite(), z.boolean(), z.null(), z.array(Json), z.record(Json),
]));
export const GoalErrorSchema = z.object({ code: Id, message: z.string() }).strict();
export type GoalError = z.infer<typeof GoalErrorSchema>;
export const GoalReceiptSchema = z.object({
  operationKey: Id,
  artifacts: z.array(z.object({
    artifactId: Id, revisionId: Id, checksum: z.string().optional(), path: z.string().min(1),
  }).strict()),
  evidence: z.record(Json),
}).strict();
export type GoalReceipt = z.infer<typeof GoalReceiptSchema>;

export const GoalStepInputSchema = z.object({
  id: Id, kind: Id, input: z.record(Json),
  maxAttempts: z.number().int().min(1).default(3),
}).strict();
export const GoalStepSchema = GoalStepInputSchema.extend({
  operationKey: Id, inputHash: z.string().optional(),
  baselineHash: z.string().nullable().optional(), baselineState: z.string().nullable().optional(),
  status: z.enum(["pending", "running", "completed", "reconciliation_required", "waiting_user", "failed"]),
  attempts: z.number().int().nonnegative(),
  /** Durable interrupted-attempt identity; compensation never resets cumulative attempts. */
  interruptedAttempt: z.number().int().positive().optional(),
  compensatedInterruptedAttempt: z.number().int().positive().optional(),
  receipt: GoalReceiptSchema.nullable(), error: GoalErrorSchema.nullable(),
});
export type GoalStep = z.infer<typeof GoalStepSchema>;
export const GoalStatusSchema = z.enum([
  "ready", "running", "paused", "interrupted", "reconciliation_required", "waiting_user", "completed", "failed", "cancelled",
]);
export type GoalStatus = z.infer<typeof GoalStatusSchema>;
export const GoalInputSchema = z.object({
  id: Id, workId: WorkResourceIdSchema, intent: z.string().min(1),
  steps: z.array(GoalStepInputSchema).min(1),
  budget: z.object({ maxAttempts: z.number().int().min(1), expiresAt: Timestamp.nullable() }).strict(),
}).strict();
export type GoalInput = z.input<typeof GoalInputSchema>;
export const GoalSchema = GoalInputSchema.extend({
  schemaVersion: z.literal(1), version: z.number().int().nonnegative(),
  steps: z.array(GoalStepSchema).min(1), status: GoalStatusSchema,
  desiredState: z.enum(["run", "paused", "cancelled"]),
  attempts: z.number().int().nonnegative(),
  owner: z.object({ token: Id, pid: z.number().int().positive(), leaseUntil: Timestamp }).strict().nullable(),
  error: GoalErrorSchema.nullable(), createdAt: Timestamp, updatedAt: Timestamp,
  lastProgressAt: Timestamp,
}).strict();
export type Goal = z.infer<typeof GoalSchema>;
export interface GoalLease { readonly goalId: string; readonly token: string }
export interface GoalEvent {
  readonly goalId: string; readonly seq: number; readonly at: number;
  readonly type: string; readonly payload: Readonly<Record<string, unknown>>;
}
export type GoalReconciliation =
  | { readonly status: "completed"; readonly receipt: GoalReceipt }
  | { readonly status: "absent"; readonly baselineHash?: string; readonly baselineState?: string }
  | { readonly status: "waiting_user"; readonly error: GoalError }
  | { readonly status: "unknown"; readonly error: GoalError };
export interface GoalStepContext {
  readonly goal: Goal; readonly step: GoalStep; readonly signal: AbortSignal;
}
/** No default retries: each adapter must prove absence before executing again. */
export interface GoalStepAdapter {
  readonly kind: string;
  readonly retrySafe: boolean;
  withScope<T>(context: GoalStepContext, task: () => Promise<T>): Promise<T>;
  reconcile(context: GoalStepContext): Promise<GoalReconciliation>;
  execute(context: GoalStepContext): Promise<void>;
  isRetryable(error: unknown): boolean;
}

/** Compare the actual stored JSON values, with stable object ordering. */
export function goalInputValue(value: unknown): string {
  const canonical = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonical);
    if (input && typeof input === "object") return Object.fromEntries(
      Object.entries(input).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]),
    );
    return input;
  };
  return JSON.stringify(canonical(value));
}

/** @deprecated Compatibility alias; no digest is produced. */
export const goalInputHash = goalInputValue;

export function goalError(code: string, message: string): Error & GoalError {
  return Object.assign(new Error(message), { code });
}
export function goalFailure(error: unknown): GoalError {
  return { code: typeof (error as { code?: unknown })?.code === "string"
    ? (error as { code: string }).code : "GOAL_EXECUTION_FAILED",
  message: error instanceof Error ? error.message : String(error) };
}
