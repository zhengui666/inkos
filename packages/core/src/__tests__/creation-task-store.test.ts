import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { CreationTaskStore } from '../creation/store.js';
import { inferCreationPlan, creationInstruction } from '../creation/contracts.js';
import { creationTaskView } from '../creation/coordinator.js';
const config = { language: 'zh', daemon: { market: { platform: 'meganovel', language: 'en' } } } as any;
const request = (kind: 'short' | 'long' = 'short') => ({ id: randomUUID(), kind, brief: 'A detective finds a clock containing tomorrow’s memories.' });
describe('durable two-field creation intake', () => {
  it('fills language, genre, platform and a finite editable plan without extra required fields', () => {
    const input = request(); const plan = inferCreationPlan(input, config);
    expect(plan).toMatchObject({ language: 'en', platform: 'meganovel', genre: 'mystery', targetChapters: 1 });
    expect(inferCreationPlan(request('long'), config).targetChapters).toBe(120);
    expect(inferCreationPlan(input, { language: 'zh', daemon: {} } as any).platform).toBeNull();
  });
  it('rejects shortening the ending onto a published non-final chapter, leaving a recoverable plan', () => {
    const store = new CreationTaskStore(':memory:'); const input = request('long');
    try {
      let task = store.create(input, inferCreationPlan(input, config));
      task = store.control(task.id, 'paused', task.version);
      expect(() => store.editPlan(task.id, { ...task.plan, targetChapters: 1 }, task.version, 1)).toThrow(/new ending must follow/i);
      expect(store.get(task.id).plan.targetChapters).toBe(120);
      expect(store.editPlan(task.id, { ...task.plan, targetChapters: 2 }, task.version, 1).plan.targetChapters).toBe(2);
    } finally { store.close(); }
  });
  it('converges duplicate requests and refuses identity reuse for a different brief', () => {
    const store = new CreationTaskStore(':memory:'); const input = request(); const plan = inferCreationPlan(input, config);
    try {
      const first = store.create(input, plan);
      expect(store.create(input, { ...plan, targetChapters: 8 })).toEqual(first);
      expect(store.list()).toHaveLength(1);
      expect(() => store.create({ ...input, brief: 'A different story about ancient dragons.' }, plan)).toThrow(/already belongs/);
    } finally { store.close(); }
  });
  it('never lets a late scheduler transition undo a user pause', () => {
    const store = new CreationTaskStore(':memory:'); const input = request();
    try {
      const task = store.create(input, inferCreationPlan(input, config));
      store.control(task.id, 'paused', task.version);
      store.update(task.id, current => ({ ...current, phase: 'writing', foundation: 'completed' }));
      expect(store.get(task.id).desiredState).toBe('paused');
      expect(() => store.control(task.id, 'run', task.version)).toThrow(/Refresh/);
    } finally { store.close(); }
  });
  it('lets short stories use multiple sections and lets long-story endings change only while paused', () => {
    const store = new CreationTaskStore(':memory:'); const input = request();
    try {
      let task = store.create(input, inferCreationPlan(input, config));
      expect(() => store.editPlan(task.id, { ...task.plan, targetChapters: 3 }, task.version, 0)).toThrow(/Pause/);
      task = store.control(task.id, 'paused', task.version);
      task = store.editPlan(task.id, { ...task.plan, targetChapters: 3 }, task.version, 0);
      expect(task.plan.targetChapters).toBe(3);
      expect(creationInstruction(task, 3)).toContain('THIS IS THE FINAL CHAPTER');
      expect(() => store.editPlan(task.id, { ...task.plan, targetChapters: 1 }, task.version, 2)).toThrow(/already reserved/);
    } finally { store.close(); }
  });
  it('shows a retained written chapter even when quality blocks its acceptance', () => {
    const store = new CreationTaskStore(':memory:'); const input = request();
    try {
      const task = store.create(input, inferCreationPlan(input, config));
      const view = creationTaskView(task, [{ workId: task.workId, chapter: 1, phase: 'blocked', writingCompleted: true,
        error: { code: 'CHAPTER_REVIEW_REQUIRED', message: 'Retained prose needs repair.' } }] as any);
      expect(view.writtenChapters).toBe(1); expect(view.reviewedChapters).toBe(0); expect(view.publishedChapters).toBe(0);
    } finally { store.close(); }
  });
  it('does not label pending receipts or reviewed local drafts as published', () => {
    const store = new CreationTaskStore(':memory:'); const input = request();
    try {
      const task = store.create(input, inferCreationPlan(input, config));
      const view = creationTaskView(task, [{ workId: task.workId, chapter: 1, phase: 'publishing', reviewReceipt: { revisionId: 'r1' }, publication: { status: 'pending', evidence: 'simulated adapter receipt' } }] as any);
      expect(view.reviewedChapters).toBe(1); expect(view.publishedChapters).toBe(0);
      expect(view.receipts[0]?.publication?.evidence).toContain('simulated');
    } finally { store.close(); }
  });
});
