import { z } from "zod";

const text = z.string().trim().min(1);
const promise = {
  familiarPromise: text,
  distinctiveHook: text,
  readingPleasure: text,
  openingQuestion: text,
  proseApproach: text,
};

/** Creative commitments, not a host verdict or a fixed plot template. */
export const ReaderContractSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("commercial-underdog"),
    ...promise,
    riseRoute: z.object({
      startingDisadvantage: text,
      desiredChange: text,
      opportunity: text,
      opportunityLimits: text,
      opposition: z.object({ force: text, interest: text, leverage: text }).strict(),
      protagonistContribution: text,
      firstPayoff: text,
      payoffMeaning: text,
      escalation: text,
    }).strict(),
  }).strict(),
  z.object({ mode: z.literal("author-directed"), ...promise, authorDirection: text }).strict(),
]);
export type ReaderContract = z.infer<typeof ReaderContractSchema>;

export const ChapterDeliverySchema = z.object({
  role: z.enum(["setup", "advance", "payoff", "aftermath"]),
  wantedOutcome: text,
  openingMove: text,
  opposition: text,
  initiative: text,
  earnedChange: text,
  feltConsequence: text,
  carryForward: text,
  deferredPayoffReason: text,
}).strict();
export type ChapterDelivery = z.infer<typeof ChapterDeliverySchema>;
