import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CreationDeliveryModeSchema, CreationRequestSchema, CreationPlanSchema,
  effectiveCreationDeliveryMode, creationBook, inferCreationPlan,
  type CreationRequest, type CreationTask,
} from '../creation/contracts.js';
import { CreationTaskStore } from '../creation/store.js';
import { ProjectConfigSchema } from '../models/project.js';

const config = { language: 'zh' as const, daemon: ProjectConfigSchema.shape.daemon.parse({
  schedule: {}, market: { platform: 'meganovel', language: 'en' },
}) };
const request = (): CreationRequest => ({
  id: randomUUID(), kind: 'short', brief: 'A detective finds a clock containing tomorrow’s memories.',
});

describe('creation delivery request contract in a real SQLite ledger', () => {
  let root: string;
  let path: string;
  let store: CreationTaskStore;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'inkos-creation-delivery-'));
    path = join(root, 'harness.sqlite');
    store = new CreationTaskStore(path);
  });
  afterEach(async () => {
    try { store.close(); } finally { await rm(root, { recursive: true, force: true }); }
  });
  const withDatabase = <T>(run: (db: DatabaseSync) => T): T => {
    const db = new DatabaseSync(path);
    try { return run(db); } finally { db.close(); }
  };
  const raw = (id: string): string => withDatabase(db =>
    String(db.prepare('SELECT data_json FROM creation_tasks WHERE id=?').get(id)!.data_json));
  const replaceRaw = (id: string, value: string): void => withDatabase(db => {
    db.prepare('UPDATE creation_tasks SET data_json=? WHERE id=?').run(value, id);
  });
  const reopen = (): void => { store.close(); store = new CreationTaskStore(path); };

  it('exports exactly manuscript/publish and preserves an absent request field', () => {
    expect(CreationDeliveryModeSchema.options).toEqual(['manuscript', 'publish']);
    const input = request();
    expect(CreationRequestSchema.parse(input)).toEqual(input);
    expect(CreationRequestSchema.parse(input)).not.toHaveProperty('deliveryMode');
    expect(effectiveCreationDeliveryMode(input)).toBe('publish');
    expect(effectiveCreationDeliveryMode({ ...input, deliveryMode: undefined })).toBe('publish');
    for (const deliveryMode of ['manuscript', 'publish'] as const) {
      const parsed = CreationRequestSchema.parse({ ...input, deliveryMode });
      expect(parsed.deliveryMode).toBe(deliveryMode);
      expect(effectiveCreationDeliveryMode(parsed)).toBe(deliveryMode);
    }
  });

  it.each([null, 'unknown', '', false, 0, {}, []])('rejects corrupt mode %j without interpreting it as a default', deliveryMode => {
    const input = { ...request(), deliveryMode };
    expect(CreationRequestSchema.safeParse(input).success).toBe(false);
    expect(() => effectiveCreationDeliveryMode(input as CreationRequest)).toThrow(expect.objectContaining({ name: 'ZodError' }));
    expect(() => store.create(input as CreationRequest, inferCreationPlan(request(), config))).toThrow();
    expect(store.list()).toEqual([]);
  });

  it.each(['omitted-first', 'publish-first'] as const)('converges omitted and explicit publish (%s) without rewriting stored bytes', order => {
    const legacy = request();
    const explicit = { ...legacy, deliveryMode: 'publish' as const };
    const firstInput = order === 'omitted-first' ? legacy : explicit;
    const secondInput = order === 'omitted-first' ? explicit : legacy;
    const plan = inferCreationPlan(firstInput, config);
    const first = store.create(firstInput, plan, 1234);
    const bytes = raw(first.id);
    reopen();
    expect(store.create(secondInput, { ...plan, targetChapters: 8 }, 9999)).toEqual(first);
    expect(store.list()).toEqual([first]);
    expect(raw(first.id)).toBe(bytes);
    expect(store.get(first.id).request).toEqual(firstInput);
  });

  it.each([
    [undefined, 'manuscript'], ['publish', 'manuscript'],
    ['manuscript', undefined], ['manuscript', 'publish'],
  ] as const)('rejects changing a retained ID from %s to %s', (firstMode, nextMode) => {
    const input = request();
    const firstInput = firstMode === undefined ? input : { ...input, deliveryMode: firstMode };
    const nextInput = nextMode === undefined ? input : { ...input, deliveryMode: nextMode };
    const plan = inferCreationPlan(input, config);
    const first = store.create(firstInput, plan);
    const bytes = raw(first.id);
    expect(() => store.create(nextInput, plan)).toThrow(expect.objectContaining({ code: 'CREATION_ID_CONFLICT' }));
    expect(store.list()).toEqual([first]);
    expect(raw(first.id)).toBe(bytes);
  });

  it('keeps kind/brief comparisons and distinct request IDs intact', () => {
    const input = { ...request(), deliveryMode: 'manuscript' as const };
    const plan = inferCreationPlan(input, config);
    const first = store.create(input, plan);
    expect(store.create(input, plan)).toEqual(first);
    for (const changed of [{ ...input, kind: 'long' as const }, { ...input, brief: 'A different story about ancient dragons.' }]) {
      expect(() => store.create(changed, plan)).toThrow(expect.objectContaining({ code: 'CREATION_ID_CONFLICT' }));
    }
    const second = store.create({ ...input, id: randomUUID() }, plan);
    expect(second.id).not.toBe(first.id);
    expect(store.list()).toHaveLength(2);
  });

  it('reads/reopens legacy JSON verbatim and never adds deliveryMode during duplicate intake', () => {
    const input = request();
    const first = store.create(input, inferCreationPlan(input, config));
    const oldBytes = '\n' + JSON.stringify(first, null, 2) + '\n';
    replaceRaw(first.id, oldBytes);
    for (let attempt = 0; attempt < 2; attempt++) {
      reopen();
      expect(store.get(first.id)).toEqual(first);
      expect(store.forWork(first.workId)).toEqual(first);
      expect(store.list()).toEqual([first]);
      expect(effectiveCreationDeliveryMode(store.get(first.id).request)).toBe('publish');
      expect(store.create({ ...input, deliveryMode: 'publish' }, first.plan)).toEqual(first);
      expect(raw(first.id)).toBe(oldBytes);
      expect(JSON.parse(raw(first.id)).request).not.toHaveProperty('deliveryMode');
    }
  });

  it.each([null, 'corrupt'])('surfaces persisted corrupt mode %j without overwriting the ledger', deliveryMode => {
    const input = request();
    const task = store.create(input, inferCreationPlan(input, config));
    const corruptBytes = JSON.stringify({ ...task, request: { ...input, deliveryMode } });
    replaceRaw(task.id, corruptBytes);
    reopen();
    expect(() => effectiveCreationDeliveryMode(store.get(task.id).request)).toThrow(expect.objectContaining({ name: 'ZodError' }));
    expect(() => store.create(input, task.plan)).toThrow(expect.objectContaining({ name: 'ZodError' }));
    expect(raw(task.id)).toBe(corruptBytes);
  });

  it.each([undefined, 'publish', 'manuscript'] as const)('preserves the original request through controls, plans and late replacements (%s)', deliveryMode => {
    const legacy = request();
    const input = deliveryMode === undefined ? legacy : { ...legacy, deliveryMode };
    let task = store.create(input, inferCreationPlan(input, config));
    task = store.control(task.id, 'paused', task.version);
    task = store.editPlan(task.id, { ...task.plan, targetChapters: 3 }, task.version, 0);
    task = store.update(task.id, current => ({
      ...current, foundation: 'completed', phase: 'writing',
      request: { ...request(), kind: 'long', deliveryMode: deliveryMode === 'manuscript' ? 'publish' : 'manuscript' },
    }));
    expect(task.desiredState).toBe('paused');
    expect(task.request).toEqual(input);
    expect(task.plan).not.toHaveProperty('deliveryMode');
    expect(task.planOverrides).not.toHaveProperty('deliveryMode');
    task = store.control(task.id, 'run', task.version);
    reopen();
    expect(store.get(task.id).request).toEqual(input);
  });

  it.each([undefined, 'publish', 'manuscript'] as const)('fences in-place request mutation by an update callback (%s)', deliveryMode => {
    const legacy = request();
    const input = deliveryMode === undefined ? legacy : { ...legacy, deliveryMode };
    const first = store.create(input, inferCreationPlan(input, config));
    const next = store.update(first.id, current => {
      current.request.deliveryMode = deliveryMode === 'manuscript' ? 'publish' : 'manuscript';
      current.request.id = randomUUID();
      current.request.kind = 'long';
      current.request.brief = 'A changed brief that must not replace retained author intent.';
      return { ...current, phase: 'planning' };
    });
    expect(next.request).toEqual(input);
    expect(next.phase).toBe('planning');
    expect(next.version).toBe(first.version + 1);
    reopen();
    expect(store.get(first.id).request).toEqual(input);
  });

  it.each([undefined, 'publish', 'manuscript'] as const)('still requires the selected creative platform (%s)', deliveryMode => {
    const legacy = request();
    const input = deliveryMode === undefined ? legacy : { ...legacy, deliveryMode };
    const plan = { ...inferCreationPlan(input, config), platform: null };
    const task = store.create(input, plan);
    expect(task.phase).toBe('blocked');
    expect(task.error?.code).toBe('CREATION_PLATFORM_REQUIRED');
    expect(task.error?.message).toMatch(deliveryMode === 'manuscript' ? /creative (target )?platform/i : /publishing platform/i);
    expect(() => creationBook(task)).toThrow(expect.objectContaining({ code: 'CREATION_PLATFORM_REQUIRED' }));
    expect(() => creationBook(task)).toThrow(deliveryMode === 'manuscript' ? /creative (target )?platform/i : /publishing platform/i);
    const selected = { ...task, plan: { ...plan, platform: 'meganovel' } } satisfies CreationTask;
    expect(creationBook(selected).platform).toBe('meganovel');
  });

  it('keeps deliveryMode out of strict plans and plan edits', () => {
    const input = request();
    const first = store.create(input, inferCreationPlan(input, config));
    const paused = store.control(first.id, 'paused', first.version);
    const bytes = raw(first.id);
    const invalid = { ...paused.plan, deliveryMode: 'manuscript' };
    expect(CreationPlanSchema.safeParse(invalid).success).toBe(false);
    expect(() => store.editPlan(first.id, invalid, paused.version, 0)).toThrow();
    expect(raw(first.id)).toBe(bytes);
  });
});
