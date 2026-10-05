import { z } from "zod";
import { LengthTelemetrySchema } from "./length-governance.js";
import { ObservationSchema, type Observation } from "./observation.js";

export const ChapterMetaSchema = z.object({
  number: z.number().int().min(1),
  title: z.string(),
  wordCount: z.number().int(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  observations: z.array(ObservationSchema),
  provenance: z.enum(["generated", "imported", "edited"]),
  lengthTelemetry: LengthTelemetrySchema.optional(),
  tokenUsage: z.object({
    promptTokens: z.number().int(),
    completionTokens: z.number().int(),
    totalTokens: z.number().int(),
  }).strict().optional(),
}).strict();

export type ChapterMeta = z.infer<typeof ChapterMetaSchema>;

/** A quality review cannot certify or discard execution/state-reconciliation evidence. */
export function mergeChapterReviewObservations(
  previous: ReadonlyArray<Observation>, reviewed: ReadonlyArray<Observation>,
): Observation[] {
  return [
    ...previous.filter(observation => observation.category === "execution" || observation.code === "state-sync-required"),
    ...reviewed,
  ];
}
