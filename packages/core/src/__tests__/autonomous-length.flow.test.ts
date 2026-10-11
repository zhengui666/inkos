import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodexFixture } from './codex-fixture.js';

const codex = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('../codex/client.js', () => ({ createCodexClient: codex.create }));

import { createLLMClient } from '../llm/provider.js';
import { PipelineRunner } from '../pipeline/runner.js';
import { AutonomousChapterRunner } from '../pipeline/autonomous-chapters.js';
import { SchedulerStore, type ScheduledChapter } from '../pipeline/scheduler-store.js';
import { ReviserAgent } from '../agents/reviser.js';
import { StateManager } from '../state/manager.js';
import { createInitialRuntimeState } from '../state/runtime-state-store.js';
import { createWorkManifest, saveWorkManifest } from '../harness/work-store.js';
import { syncWorkSourceArtifacts } from '../harness/source-sync.js';
import { countChapterLength } from '../utils/length-metrics.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// These exact-count synthetic strings certify host control flow and persistence,
// not literary quality or any live model, account, or publishing transport.
const bodyFor = (language: 'zh' | 'en', count: number) => language === 'zh'
  ? `${'甲'.repeat(count)}\n`
  : `${Array.from({ length: count }, () => 'word').join(' ')}\n`;

async function setup(input: {
  language: 'zh' | 'en';
  count: number;
  target: number;
  minimum?: number;
  maximum?: number;
  revisedCount?: number;
  failRepair?: boolean;
}) {
  const root = await mkdtemp(join(tmpdir(), 'inkos-autonomous-length-'));
  // Each CodexFixture creates its synthetic home here. Explicitly override any
  // enclosing runner's deployment home so admission never opens that context.
  vi.stubEnv('INKOS_CODEX_HOME', join(root, '.inkos/codex/home'));
  vi.stubEnv('INKOS_CODEX_STATE_ROOT', join(root, '.inkos/codex'));
  let store: SchedulerStore | undefined;
  cleanups.push(async () => { store?.close(); await rm(root, { recursive: true, force: true }); });
  const state = new StateManager(root), bookId = 'synthetic-length', bookDir = state.bookDir(bookId);
  const timestamp = '2026-01-01T00:00:00.000Z';
  const path = join(bookDir, 'chapters/0001_Scene.md');
  const originalBody = bodyFor(input.language, input.count);
  await saveWorkManifest(root, createWorkManifest({
    id: bookId, title: 'Synthetic length fixture', profileId: 'longform-novel', language: input.language,
  }));
  await state.saveBookConfig(bookId, {
    id: bookId, title: 'Synthetic length fixture', platform: 'other', genre: 'general',
    status: 'active', targetChapters: 2, chapterWordCount: input.target, language: input.language,
    ...(input.minimum === undefined ? {} : { minChapterLength: input.minimum }),
    ...(input.maximum === undefined ? {} : { maxChapterLength: input.maximum }),
    createdAt: timestamp, updatedAt: timestamp,
  });
  await mkdir(join(bookDir, 'story/outline'), { recursive: true });
  await mkdir(join(bookDir, 'story/runtime'), { recursive: true });
  await mkdir(join(bookDir, 'chapters'), { recursive: true });
  await writeFile(join(bookDir, 'story/book_rules.md'), 'Preserve the established events and causal continuity.\n');
  await writeFile(join(bookDir, 'story/book_rules.json'), JSON.stringify({
    version: '2', prohibitions: [], enableFullCastTracking: false, allowedDeviations: [],
  }));
  await writeFile(join(bookDir, 'story/outline/story_frame.md'), 'An isolated synthetic scene.\n');
  await writeFile(join(bookDir, 'story/outline/volume_map.md'), 'Two synthetic chapters.\n');
  await writeFile(path, `# ${input.language === 'en' ? 'Chapter 1: Scene' : '第1章 Scene'}\n\n${originalBody}`);
  await createInitialRuntimeState({ bookDir, language: input.language });
  await state.saveChapterIndex(bookId, [{
    number: 1, title: 'Scene', wordCount: input.count, observations: [], provenance: 'generated',
    createdAt: timestamp, updatedAt: timestamp,
  }]);
  await state.snapshotState(bookId, 0);
  await syncWorkSourceArtifacts({ projectRoot: root, workId: bookId, accept: true });

  store = new SchedulerStore(join(root, '.inkos/harness.sqlite'));
  const reservation = store.reserve(bookId, 1, Date.now(), 1)!;
  const job: ScheduledChapter = { ...reservation, phase: 'reviewing', writingCompleted: true };
  store.save(job, 'synthetic-retained-chapter');
  const repairSnapshots: ScheduledChapter[] = [];
  const provider = new CodexFixture(view => {
    const name = view.tools[0]!.function.name;
    if (name === 'submit_revised_chapter') {
      repairSnapshots.push(structuredClone(store!.latest(bookId)!));
      if (input.failRepair) throw new Error('Synthetic revision provider failed before returning prose.');
      if (input.revisedCount === undefined) throw new Error('Unexpected prose revision for a compliant or soft target.');
      return { calls: [{ name, args: { revisedContent: bodyFor(input.language, input.revisedCount) } }] };
    }
    if (name === 'submit_runtime_state_delta') return { calls: [{ name, args: {
      postSettlement: 'No synthetic state facts or hooks changed.',
      factOps: { upsert: [], expire: [] },
      hookOps: { upsert: [], mention: [], resolve: [], defer: [] },
      newHookCandidates: [],
      chapterSummary: {
        title: 'Scene', characters: '', events: 'Synthetic fixture scene retained.', stateChanges: '',
        hookActivity: '', mood: '', chapterType: 'scene',
      },
    } }] };
    if (name === 'submit_state_validation') return { calls: [{ name, args: {
      reconciliationRequired: false, reportMarkdown: '',
    } }] };
    throw new Error(`Unexpected synthetic provider tool: ${name}`);
  });
  codex.create.mockImplementation(provider.createClient);
  const client = createLLMClient({
    service: 'custom', provider: 'openai', configSource: 'studio', model: 'fixture', apiKey: 'fixture',
    baseUrl: 'https://unused.invalid/v1', apiFormat: 'chat', stream: false, temperature: 0, thinkingBudget: 0,
  });
  const pipeline = new PipelineRunner({ projectRoot: root, client, model: 'fixture' });
  const reviewedCounts: number[] = [];
  // Only semantic evidence is synthetic. The real reviewChapter freezes policy,
  // measures length, updates metadata, and binds the current source revision.
  vi.spyOn(pipeline as any, 'collectReviewObservations').mockImplementation(async (request: any) => {
    reviewedCounts.push(countChapterLength(request.chapterContent, input.language === 'zh' ? 'zh_chars' : 'en_words'));
    return { summary: 'Synthetic semantic fixture reports no unresolved finding.', observations: [] };
  });
  const review = vi.spyOn(pipeline, 'reviewChapter');
  const revise = vi.spyOn(pipeline, 'reviseDraft');
  const reviser = vi.spyOn(ReviserAgent.prototype, 'reviseChapter');
  const write = vi.spyOn(pipeline, 'writeChapters');
  const completion = vi.fn();
  const runner = new AutonomousChapterRunner(root, pipeline, store, {
    retryDelayMs: 1, onComplete: completion,
  });
  const restart = () => {
    store!.close();
    store = new SchedulerStore(join(root, '.inkos/harness.sqlite'));
    const restarted = new AutonomousChapterRunner(root, pipeline, store, {
      retryDelayMs: 1, onComplete: completion, now: () => Date.now() + 100000,
    });
    return { store, runner: restarted, job: store.latest(bookId)! };
  };
  return { root, path, bookId, originalBody, store, job, pipeline, runner, provider,
    review, revise, reviser, write, completion, reviewedCounts, repairSnapshots, restart };
}

describe('explicit autonomous chapter length with the real reviser', () => {
  it.each([1800, 2600])('repairs retained Chinese %i characters before local acceptance', async count => {
    const f = await setup({ language: 'zh', count, target: 2400, minimum: 2000, maximum: 2500, revisedCount: 2200 });
    const result = await f.runner.run(f.job, new AbortController().signal);
    expect(result.error).toBeUndefined();
    expect(f.revise).toHaveBeenCalledOnce();
    expect(f.reviser).toHaveBeenCalledOnce();
    expect(f.provider.turns.filter(turn => turn.tools[0]?.function.name === 'submit_revised_chapter')).toHaveLength(1);
    expect(f.revise.mock.calls[0]![4]?.reviewFindings).toBeUndefined();
    expect(f.reviser.mock.calls[0]![3]).toEqual([]);
    const instruction = f.revise.mock.calls[0]![3]!;
    expect(instruction).toContain(String(count));
    expect(instruction).toContain('zh_chars');
    expect(instruction).toContain('2000');
    expect(instruction).toContain('2500');
    expect(instruction).toMatch(/preserv|保留|保持/iu);
    expect(f.repairSnapshots).toHaveLength(1);
    expect(f.repairSnapshots[0]).toMatchObject({ phase: 'reviewing', reviewAttempts: 1, reviewChecks: 1 });
    expect(f.repairSnapshots[0]!.reviewReceipt).toBeUndefined();
    expect(f.repairSnapshots[0]!.publication).toBeUndefined();

    expect(f.review).toHaveBeenCalledTimes(2);
    const reviews = await Promise.all(f.review.mock.results.map(call => call.value));
    expect(reviews[0]!.delivery).toMatchObject({
      status: 'needs_revision', measurements: { count, countingMode: 'zh_chars' },
    });
    expect(reviews[1]!.delivery).toMatchObject({
      status: 'checks_passed', measurements: { count: 2200, countingMode: 'zh_chars' },
    });
    expect(f.reviewedCounts).toEqual([count, 2200, 2200]);
    expect(result).toMatchObject({ phase: 'completed', reviewAttempts: 1, reviewChecks: 2 });
    expect(result.reviewReceipt?.revisionId).toBe(result.revisionId);
    expect(countChapterLength(await readFile(f.path, 'utf8'), 'zh_chars')).toBe(2200);
    expect(f.completion).toHaveBeenCalledOnce();
    expect(f.write).not.toHaveBeenCalled();
    expect(f.store.chapters(f.bookId).map(chapter => chapter.chapter)).toEqual([1]);
    expect(result.publication).toBeUndefined();
  });

  it.each([2000, 2500])('accepts exactly %i Chinese characters without revision', async count => {
    const f = await setup({ language: 'zh', count, target: 2400, minimum: 2000, maximum: 2500 });
    const result = await f.runner.run(f.job, new AbortController().signal);
    expect(result.error).toBeUndefined();
    expect(result).toMatchObject({ phase: 'completed', reviewAttempts: 0, reviewChecks: 1 });
    expect(result.reviewReceipt).toBeDefined();
    expect(f.review).toHaveBeenCalledOnce();
    expect((await f.review.mock.results[0]!.value).delivery?.status).toBe('checks_passed');
    expect(f.revise).not.toHaveBeenCalled();
    expect(f.reviser).not.toHaveBeenCalled();
    expect(f.provider.turns).toEqual([]);
    expect(countChapterLength(await readFile(f.path, 'utf8'), 'zh_chars')).toBe(count);
  });

  it('keeps an approximate 2400-character target soft for a retained 1800-character chapter', async () => {
    const f = await setup({ language: 'zh', count: 1800, target: 2400 });
    const result = await f.runner.run(f.job, new AbortController().signal);
    expect(result.error).toBeUndefined();
    expect(result.phase).toBe('completed');
    expect(result.reviewReceipt).toBeDefined();
    expect((await f.review.mock.results[0]!.value).delivery).toBeUndefined();
    expect(f.revise).not.toHaveBeenCalled();
    expect(f.reviser).not.toHaveBeenCalled();
    expect(countChapterLength(await readFile(f.path, 'utf8'), 'zh_chars')).toBe(1800);
  });

  it('repairs an English word bound independently of Chinese character thresholds', async () => {
    const f = await setup({ language: 'en', count: 700, target: 900, minimum: 800, maximum: 1000, revisedCount: 900 });
    const result = await f.runner.run(f.job, new AbortController().signal);
    expect(result.error).toBeUndefined();
    expect(f.reviser).toHaveBeenCalledOnce();
    expect(f.review).toHaveBeenCalledTimes(2);
    const reviews = await Promise.all(f.review.mock.results.map(call => call.value));
    expect(reviews[0]!.delivery).toMatchObject({ status: 'needs_revision', measurements: { count: 700, countingMode: 'en_words' } });
    expect(reviews[1]!.delivery).toMatchObject({ status: 'checks_passed', measurements: { count: 900, countingMode: 'en_words' } });
    expect(f.revise.mock.calls[0]![3]).toContain('en_words');
    expect(f.revise.mock.calls[0]![3]).toContain('800');
    expect(f.revise.mock.calls[0]![3]).toContain('1000');
    expect(f.repairSnapshots[0]!.reviewReceipt).toBeUndefined();
    expect(f.reviewedCounts).toEqual([700, 900, 900]);
    expect(result).toMatchObject({ phase: 'completed', reviewAttempts: 1, reviewChecks: 2 });
    expect(countChapterLength(await readFile(f.path, 'utf8'), 'en_words')).toBe(900);
    expect(f.write).not.toHaveBeenCalled();
    expect(result.publication).toBeUndefined();
  });

  it.each([800, 1000])('accepts exactly %i English words without revision', async count => {
    const f = await setup({ language: 'en', count, target: 900, minimum: 800, maximum: 1000 });
    const result = await f.runner.run(f.job, new AbortController().signal);
    expect(result.error).toBeUndefined();
    expect(result.phase).toBe('completed');
    expect(result.reviewReceipt).toBeDefined();
    expect((await f.review.mock.results[0]!.value).delivery).toMatchObject({
      status: 'checks_passed', measurements: { count, countingMode: 'en_words' },
    });
    expect(f.revise).not.toHaveBeenCalled();
    expect(f.reviser).not.toHaveBeenCalled();
  });

  it.each(['out-of-bounds', 'provider-error'] as const)(
    'retains original prose and the consumed repair budget after a real %s repair failure and restart',
    async failure => {
      const f = await setup({
        language: 'zh', count: 2600, target: 2400, minimum: 2000, maximum: 2500,
        revisedCount: 1800, failRepair: failure === 'provider-error',
      });
      const before = await readFile(f.path);
      const first = await f.runner.run(f.job, new AbortController().signal);
      expect(first).toMatchObject({ phase: 'blocked', reviewAttempts: 1, reviewChecks: 1 });
      expect(first.error?.message).toContain('2600');
      expect(first.error?.message).toContain('zh_chars');
      expect(first.error?.message).toContain('2000');
      expect(first.error?.message).toContain('2500');
      expect(first.reviewReceipt).toBeUndefined();
      expect(first.publication).toBeUndefined();
      expect(await readFile(f.path)).toEqual(before);
      expect(f.revise).toHaveBeenCalledOnce();
      expect(f.reviser).toHaveBeenCalledOnce();
      expect(f.review).toHaveBeenCalledOnce();
      // Structured-tool validation may request bounded corrections within this
      // one chapter-level revision. It must never grant a second repair budget.
      expect(f.repairSnapshots.length).toBeGreaterThan(0);
      expect(f.repairSnapshots.every(job => job.reviewAttempts === 1 && !job.reviewReceipt)).toBe(true);
      expect(f.provider.turns.some(turn => turn.tools[0]?.function.name === 'submit_runtime_state_delta')).toBe(false);
      const providerTurns = f.provider.turns.length;
      const reopened = f.restart();
      expect(reopened.job).toEqual(first);
      const retained = await reopened.runner.run(reopened.job, new AbortController().signal);
      expect(retained).toEqual(first);
      expect(reopened.store.latest(f.bookId)).toEqual(first);
      expect(await readFile(f.path)).toEqual(before);
      expect(f.revise).toHaveBeenCalledOnce();
      expect(f.reviser).toHaveBeenCalledOnce();
      expect(f.review).toHaveBeenCalledOnce();
      expect(f.provider.turns).toHaveLength(providerTurns);
      expect(f.completion).not.toHaveBeenCalled();
      expect(f.write).not.toHaveBeenCalled();
      expect(reopened.store.chapters(f.bookId).map(job => job.chapter)).toEqual([1]);
    },
  );
});
