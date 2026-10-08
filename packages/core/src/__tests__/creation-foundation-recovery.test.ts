import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { CreationTaskCoordinator } from '../creation/coordinator.js';
import { creationBook, creationInstruction, inferCreationPlan } from '../creation/contracts.js';
import { SchedulerStore } from '../pipeline/scheduler-store.js';
import { createInitialRuntimeState } from '../state/runtime-state-store.js';
import { StateManager } from '../state/manager.js';
import { syncWorkSourceArtifacts } from '../harness/source-sync.js';
import { createWorkManifest, saveWorkManifest } from '../harness/work-store.js';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0)) await fn(); });
async function interruptedCommit() {
  const root = await mkdtemp(join(tmpdir(), 'inkos-foundation-commit-'));
  const scheduler = new SchedulerStore(join(root, '.inkos/harness.sqlite'));
  const pipeline = { initBook: vi.fn(), runWithAgentContext: vi.fn((_context, fn) => fn()) } as any;
  const coordinator = new CreationTaskCoordinator(root, pipeline, scheduler, 1000);
  cleanup.push(async () => { coordinator.close(); scheduler.close(); await rm(root, { recursive: true, force: true }); });
  const request = { id: randomUUID(), kind: 'short' as const, brief: 'Write this in English in three chapters. A detective steals a memory to solve her last case.' };
  let task = coordinator.tasks.create(request, inferCreationPlan(request, { language: 'zh', daemon: { market: { platform: 'fixture', language: 'zh' } } } as any));
  task = coordinator.tasks.update(task.id, current => ({ ...current, phase: 'planning', foundationAttempts: 1, planStatus: 'ready', plan: { ...current.plan, language: 'en', targetChapters: 3 } }));
  const state = new StateManager(root), dir = state.bookDir(task.workId);
  await saveWorkManifest(root, createWorkManifest({ id: task.workId, title: task.plan.title, profileId: 'longform-novel', language: task.plan.language }));
  await state.saveBookConfig(task.workId, creationBook(task));
  for (const [path, body] of Object.entries({ 'story/outline/story_frame.md': 'The detective returns the memory and solves the case.',
    'story/outline/volume_map.md': 'Three finite sections.', 'story/book_rules.md': 'Preserve causality.', 'story/book_rules.json': JSON.stringify({ version: '2', prohibitions: [], allowedDeviations: [], enableFullCastTracking: false }),
    'story/current_state.md': 'The case is unsolved.', 'story/pending_hooks.md': 'The stolen memory.', 'story/brief.md': creationInstruction(task),
    'chapters/index.json': '[]' })) {
    const absolute = join(dir, path); await mkdir(join(absolute, '..'), { recursive: true }); await writeFile(absolute, body);
  }
  await createInitialRuntimeState({ bookDir: dir, language: 'en' });
  // This is the actual atomic source/manifest registration that completed before the simulated crash.
  await syncWorkSourceArtifacts({ projectRoot: root, workId: task.workId, accept: true });
  return { root, pipeline, coordinator, task, dir };
}
describe('foundation commit crash window', () => {
  it('reconciles the exact committed foundation without calling initBook or overwriting it', async () => {
    const f = await interruptedCommit(); const before = await readFile(join(f.dir, 'story/outline/story_frame.md'), 'utf8');
    await f.coordinator.prepare(f.task.id, new AbortController().signal);
    expect(f.pipeline.initBook).not.toHaveBeenCalled();
    expect(f.coordinator.tasks.get(f.task.id)).toMatchObject({ foundation: 'completed', foundationAttempts: 1, phase: 'writing', plan: { language: 'en', targetChapters: 3 } });
    expect(await readFile(join(f.dir, 'story/outline/story_frame.md'), 'utf8')).toBe(before);
  });
  it('blocks unregistered changes rather than adopting or rewriting them', async () => {
    const f = await interruptedCommit(); await writeFile(join(f.dir, 'story/outline/story_frame.md'), 'An author edit that must survive.');
    await f.coordinator.prepare(f.task.id, new AbortController().signal);
    expect(f.pipeline.initBook).not.toHaveBeenCalled();
    expect(f.coordinator.tasks.get(f.task.id).error?.code).toBe('CREATION_FOUNDATION_RECONCILIATION_REQUIRED');
    expect(await readFile(join(f.dir, 'story/outline/story_frame.md'), 'utf8')).toBe('An author edit that must survive.');
  });
  it('does not adopt changes to structured reader rules or canonical runtime state', async () => {
    for (const relative of ['story/book_rules.json', 'story/state/current_state.json']) {
      const f = await interruptedCommit(); const file = join(f.dir, relative);
      await writeFile(file, JSON.stringify({ changedByUser: true }));
      await f.coordinator.prepare(f.task.id, new AbortController().signal);
      expect(f.pipeline.initBook).not.toHaveBeenCalled();
      expect(f.coordinator.tasks.get(f.task.id).error?.code).toBe('CREATION_FOUNDATION_RECONCILIATION_REQUIRED');
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ changedByUser: true });
    }
  });

});
