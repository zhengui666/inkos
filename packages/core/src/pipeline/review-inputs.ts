import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

/** Literal authoritative inputs, read once and passed into the actual audit.
 * Missing files stay distinct from empty files. Generated intent/context
 * projections are not authority and must not invalidate a review receipt. */
export const ChapterReviewInputsSchema = z.object({
  version: z.literal(1),
  plan: z.string().nullable(),
  authorBrief: z.string().nullable(),
  bookRules: z.string().nullable(),
}).strict();
export type ChapterReviewInputs = z.infer<typeof ChapterReviewInputsSchema>;

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
  return { version: 1, plan: await read(`${slug}.plan.json`),
    authorBrief: await read(`${slug}.user-brief.md`), bookRules: await read('story/book_rules.md') };
}

export function sameChapterReviewInputs(expected: unknown, current: ChapterReviewInputs): boolean {
  const parsed = ChapterReviewInputsSchema.safeParse(expected);
  return parsed.success && parsed.data.plan === current.plan && parsed.data.authorBrief === current.authorBrief
    && parsed.data.bookRules === current.bookRules;
}
