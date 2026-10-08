import { afterEach, describe, expect, it, vi } from 'vitest';
import { CreationPlannerAgent } from '../creation/planner.js';
import { BaseAgent } from '../agents/base.js';
import { inferCreationPlan } from '../creation/contracts.js';
import { randomUUID } from 'node:crypto';
afterEach(() => vi.restoreAllMocks());
describe('typed semantic creation intake (model output fixture)', () => {
  it.each([
    ['Do not write in English. Write this Chinese story in three chapters.', 'zh', 3],
    ['不要英文小说，用中文写，共三章。故事围绕一只失踪的怀表。', 'zh', 3],
    ['不要写三章，要写五章。用英文讲述失踪的怀表。', 'en', 5],
    ['Write this in English in three chapters. A detective trades memories.', 'en', 3],
  ])('sends the whole authoritative brief and persists semantic output: %s', async (brief, language, targetChapters) => {
    const request = { id: randomUUID(), kind: 'long' as const, brief };
    const defaults = inferCreationPlan(request, { language: 'en', daemon: {} } as any);
    const submit = vi.spyOn(BaseAgent.prototype as any, 'submitStructured').mockImplementation(async (messages: any, tool: any) => {
      expect(JSON.parse(messages[1].content).authorBrief).toBe(brief);
      expect(messages[0].content).toContain('negations');
      expect(messages[0].content).toContain('over defaults');
      const proposal = { title: 'The Missing Watch', blurb: 'A detective trades a treasured memory to recover a missing watch.', genre: 'mystery', language, targetChapters, chapterWordCount: 1500,
        endingIntent: 'The detective solves the missing watch case.', summary: 'The explicit final instructions determine language and chapter count.' };
      tool.validate(proposal); return { result: proposal };
    });
    const agent = new CreationPlannerAgent({} as any);
    expect((await agent.plan(request, defaults)).plan).toMatchObject({ language, targetChapters, blurb: 'A detective trades a treasured memory to recover a missing watch.' });
    expect(submit).toHaveBeenCalledOnce();
  });
});
