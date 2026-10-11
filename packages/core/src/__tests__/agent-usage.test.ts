import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReviserAgent } from '../agents/reviser.js';
import { ContinuityAuditor } from '../agents/continuity.js';
import { PlannerAgent } from '../agents/planner.js';
import { BaseAgent, type AgentContext } from '../agents/base.js';
import type { LLMResponse } from '../llm/provider.js';

const worker = vi.hoisted(() => vi.fn());
vi.mock('../agent/worker-agent.js', () => ({ runWorkerAgentTool: worker }));
const known = { promptTokens: 12, completionTokens: 3, totalTokens: 15 };
const pairs = [
  { name: 'known + known', first: known, second: known, expected: { promptTokens: 24, completionTokens: 6, totalTokens: 30 } },
  { name: 'known + unknown', first: known, second: undefined, expected: undefined },
  { name: 'unknown + known', first: undefined, second: known, expected: undefined },
  { name: 'all unknown', first: undefined, second: undefined, expected: undefined },
];
const ctx: AgentContext = { projectRoot: '/tmp/inkos-usage-fixture', model: 'fixture', client: {
  provider: 'openai', apiFormat: 'responses', stream: true,
  defaults: { temperature: 0, maxTokens: 16384, thinkingBudget: 0, extra: {} },
} };
beforeEach(() => worker.mockReset());
afterEach(() => vi.restoreAllMocks());

describe('host usage propagation without changing accepted content', () => {
  it.each(pairs)('reviser: $name', async ({ first, second, expected }) => {
    worker.mockImplementation(async (_client, _model, _messages, tool, options) => {
      options.onUsage?.(tool.name === 'submit_chapter_edit_ranges' ? first : second);
      const result = tool.name === 'submit_chapter_edit_ranges'
        ? { ranges: [{ startLine: 1, endLine: 1 }] } : { range_0_content: 'Revised line\n' };
      return tool.validate ? tool.validate(result) : result;
    });
    const candidate = vi.fn();
    const output = await new ReviserAgent(ctx).reviseChapter('/unused', 'Original line\nProtected line', 1, [], 'spot-fix', undefined,
      { language: 'en', contextPackage: { chapter: 1, selectedContext: [] }, onCandidate: candidate });
    expect(output.revisedContent).toBe('Revised line\nProtected line');
    expect(candidate).toHaveBeenCalledWith(output.revisedContent);
    expect(output.tokenUsage).toEqual(expected); expect(worker).toHaveBeenCalledTimes(2);
  });

  it('reviser: skipped planning has a zero identity, not an unknown model call', async () => {
    worker.mockImplementation(async (_client, _model, _messages, tool, options) => {
      options.onUsage?.(known); return tool.validate({ range_0_content: 'Revised line' });
    });
    const output = await new ReviserAgent(ctx).reviseChapter('/unused', 'Original line\nProtected line', 1, [], 'spot-fix', undefined,
      { language: 'en', targetText: 'Original line', contextPackage: { chapter: 1, selectedContext: [] } });
    expect(output.revisedContent).toBe('Revised line\nProtected line');
    expect(output.tokenUsage).toEqual(known); expect(worker).toHaveBeenCalledOnce();
  });

  it.each(pairs)('continuity: $name', async ({ first, second, expected }) => {
    vi.spyOn(PlannerAgent.prototype, 'classifyChapterContract').mockResolvedValue({ result: { observations: [], summary: 'Accepted contract' }, usage: first });
    const base = BaseAgent.prototype as unknown as { submitSourcedReview: () => Promise<{ result: { observations: never[]; summary: string }; usage: LLMResponse['usage'] }> };
    vi.spyOn(base, 'submitSourcedReview').mockResolvedValue({ result: { observations: [], summary: 'Review accepted' }, usage: second });
    const output = await new ContinuityAuditor(ctx).auditChapter('/unused', 'Accepted chapter', 1, undefined,
      { language: 'en', contextPackage: { chapter: 1, selectedContext: [{ source: 'runtime/chapter_memo', excerpt: 'Approved intent', reason: 'Review authority', protection: 'protected' }] } });
    expect(output.summary).toBe('Review accepted'); expect(output.observations).toEqual([]);
    expect(output.tokenUsage).toEqual(expected);
  });
});
