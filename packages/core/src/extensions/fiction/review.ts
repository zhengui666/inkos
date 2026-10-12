import { z } from 'zod';
import type { ReviewResult } from '../../works/documents.js';
export const ReviewSchema = z.object({
  issues: z.array(z.object({ kind: z.enum(['requirement', 'contradiction', 'suggestion']), message: z.string() })),
  storyState: z.record(z.string(), z.any()).default({}),
});
export const blockingIssues = (review: Pick<ReviewResult, 'issues'>) => review.issues.filter(issue => issue.kind !== 'suggestion');
export function parseJson(text: string): unknown {
  return JSON.parse(text.trim().replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, ''));
}
export const reviewInstructions = 'Review against explicit author requirements and established content, not a universal commercial SOP. Return JSON {issues:[{kind:"requirement"|"contradiction"|"suggestion",message}],storyState:{}}. Only requirement violations and factual/continuity contradictions block. Ordinary stylistic advice is a suggestion. Extract newly established story facts, character state, summaries and hooks together with the review; do not invent obligations or turn future plans into facts.';
