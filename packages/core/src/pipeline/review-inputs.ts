import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

/** Literal authoritative inputs, read once and passed into the actual audit.
 * Missing files stay distinct from empty files. Generated intent/context
 * projections are not authority and must not invalidate a review receipt. */
export const ChapterReviewInputsSchema = z.object({
  version: z.literal(2),
  plan: z.string().nullable(),
  authorBrief: z.string().nullable(),
  bookRules: z.string().nullable(),
  bookRulesJson: z.string().nullable(),
  authorIntent: z.string().nullable(),
  currentFocus: z.string().nullable(),
  styleGuide: z.string().nullable(),
  parentCanon: z.string().nullable(),
  fanficCanon: z.string().nullable(),
}).strict();
export type ChapterReviewInputs = z.infer<typeof ChapterReviewInputsSchema>;

export const ChapterReviewPolicySchema = z.object({
  requireStoryClosure: z.boolean(),
  language: z.enum(['zh', 'en']),
}).strict();
export type ChapterReviewPolicy = z.infer<typeof ChapterReviewPolicySchema>;

export function sameChapterReviewPolicy(expected: unknown, current: ChapterReviewPolicy): boolean {
  const parsed = ChapterReviewPolicySchema.safeParse(expected);
  return parsed.success && parsed.data.requireStoryClosure === current.requireStoryClosure
    && parsed.data.language === current.language;
}

export async function readChapterReviewInputs(bookDir: string, chapter: number): Promise<ChapterReviewInputs> {
  if (!Number.isSafeInteger(chapter) || chapter < 1) throw new Error('Invalid review chapter number.');
  const read = async (path: string): Promise<string | null> => {
    try {
      const bytes = await readFile(join(bookDir, path));
      const text = bytes.toString('utf8');
      if (!Buffer.from(text, 'utf8').equals(bytes)) {
        throw Object.assign(new Error(`Review input is not lossless UTF-8: ${path}`), { code: 'CHAPTER_REVIEW_INPUTS_UNREADABLE' });
      }
      return text;
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  };
  const slug = `story/runtime/chapter-${String(chapter).padStart(4, '0')}`;
  return { version: 2, plan: await read(`${slug}.plan.json`),
    authorBrief: await read(`${slug}.user-brief.md`), bookRules: await read('story/book_rules.md'),
    bookRulesJson: await read('story/book_rules.json'), authorIntent: await read('story/author_intent.md'),
    currentFocus: await read('story/current_focus.md'), styleGuide: await read('story/style_guide.md'),
    parentCanon: await read('story/parent_canon.md'), fanficCanon: await read('story/fanfic_canon.md') };
}

export function sameChapterReviewInputs(expected: unknown, current: ChapterReviewInputs): boolean {
  const parsed = ChapterReviewInputsSchema.safeParse(expected);
  return parsed.success && parsed.data.plan === current.plan && parsed.data.authorBrief === current.authorBrief
    && parsed.data.bookRules === current.bookRules && parsed.data.bookRulesJson === current.bookRulesJson
    && parsed.data.authorIntent === current.authorIntent && parsed.data.currentFocus === current.currentFocus
    && parsed.data.styleGuide === current.styleGuide && parsed.data.parentCanon === current.parentCanon
    && parsed.data.fanficCanon === current.fanficCanon;
}

/** Final host authorization only: no event-loop yield before issuing submission.
 * This does not make filesystem reads atomic with other processes or remote UI. */
export function readChapterReviewInputsSync(bookDir: string, chapter: number): ChapterReviewInputs {
  if (!Number.isSafeInteger(chapter) || chapter < 1) throw new Error('Invalid review chapter number.');
  const read = (path: string): string | null => {
    try {
      const bytes = readFileSync(join(bookDir, path));
      const text = bytes.toString('utf8');
      if (!Buffer.from(text, 'utf8').equals(bytes)) {
        throw Object.assign(new Error(`Review input is not lossless UTF-8: ${path}`), { code: 'CHAPTER_REVIEW_INPUTS_UNREADABLE' });
      }
      return text;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  };
  const slug = `story/runtime/chapter-${String(chapter).padStart(4, '0')}`;
  return { version: 2, plan: read(`${slug}.plan.json`),
    authorBrief: read(`${slug}.user-brief.md`), bookRules: read('story/book_rules.md'),
    bookRulesJson: read('story/book_rules.json'), authorIntent: read('story/author_intent.md'),
    currentFocus: read('story/current_focus.md'), styleGuide: read('story/style_guide.md'),
    parentCanon: read('story/parent_canon.md'), fanficCanon: read('story/fanfic_canon.md') };
}
