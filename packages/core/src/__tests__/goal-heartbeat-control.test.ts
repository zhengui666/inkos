import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GoalStore } from '../goals/store.js';

const fixtures: Array<{ root: string; writer: GoalStore; reader: GoalStore }> = [];

afterEach(() => {
  for (const { root, writer, reader } of fixtures.splice(0)) {
    const current = writer.get('goal');
    if (current.owner) writer.release({ goalId: current.id, token: current.owner.token }, 'interrupted');
    reader.close();
    writer.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'inkos-goal-heartbeat-'));
  let now = 100_000;
  const path = join(root, 'goals.sqlite');
  const writer = new GoalStore(path, { now: () => now });
  const reader = new GoalStore(path, { now: () => now });
  writer.create({ id: 'goal', workId: 'novel', intent: 'Complete this fixed sequence',
    steps: [{ id: 'chapter-1', kind: 'fixture', input: { chapter: 1 }, maxAttempts: 2 }],
    budget: { maxAttempts: 2, expiresAt: now + 60_000 } });
  writer.requestRun('goal', writer.get('goal').version);
  const lease = writer.claim('goal')!;
  fixtures.push({ root, writer, reader });
  return { writer, reader, lease, advance: (milliseconds: number) => { now += milliseconds; } };
}

describe('goal heartbeat and control versions', () => {
  it.each(['paused', 'cancelled'] as const)('keeps a read version usable for %s through lease renewal', desired => {
    const { writer, reader, lease, advance } = fixture();
    writer.beginAttempt(lease, 'chapter-1', 'baseline');
    const observed = reader.get('goal');
    const events = reader.events('goal');

    advance(5_000);
    const renewed = writer.heartbeat(lease);
    expect(renewed.version).toBe(observed.version);
    expect(renewed.updatedAt).toBe(observed.updatedAt + 5_000);
    expect(renewed.owner?.leaseUntil).toBe(observed.owner!.leaseUntil + 5_000);
    expect(renewed.steps).toEqual(observed.steps);
    expect(renewed.attempts).toBe(observed.attempts);
    expect(renewed.lastProgressAt).toBe(observed.lastProgressAt);
    expect(reader.events('goal')).toEqual(events);

    const stopped = reader.requestStop('goal', desired, observed.version);
    expect(stopped.version).toBe(observed.version + 1);
    const stopEvents = reader.events('goal');
    advance(1_000);
    const afterStopHeartbeat = writer.heartbeat(lease);
    expect(afterStopHeartbeat.version).toBe(stopped.version);
    expect(afterStopHeartbeat.desiredState).toBe(desired);
    expect(afterStopHeartbeat.steps).toEqual(stopped.steps);
    expect(afterStopHeartbeat.attempts).toBe(stopped.attempts);
    expect(reader.events('goal')).toEqual(stopEvents);
    expect(reader.get('goal')).toEqual(afterStopHeartbeat);
  });

  it('still rejects stale controls after real chapter progress', () => {
    const { writer, reader, lease, advance } = fixture();
    const observed = reader.get('goal');
    advance(5_000);
    writer.heartbeat(lease);
    const progressed = writer.beginAttempt(lease, 'chapter-1', 'baseline');
    expect(progressed.version).toBe(observed.version + 1);
    expect(() => reader.requestStop('goal', 'paused', observed.version))
      .toThrowError(expect.objectContaining({ code: 'GOAL_VERSION_CONFLICT' }));
    expect(reader.get('goal')).toEqual(progressed);
    expect(reader.requestStop('goal', 'cancelled', progressed.version).desiredState).toBe('cancelled');
  });

  it('rejects a foreign store and a stale lease without changing durable state', () => {
    const { writer, reader, lease, advance } = fixture();
    const before = reader.get('goal');
    expect(() => reader.heartbeat(lease))
      .toThrowError(expect.objectContaining({ code: 'GOAL_OWNER_LOST' }));
    expect(() => writer.heartbeat({ ...lease, token: 'wrong-owner' }))
      .toThrowError(expect.objectContaining({ code: 'GOAL_OWNER_LOST' }));
    expect(reader.get('goal')).toEqual(before);

    const released = writer.release(lease, 'interrupted');
    reader.requestRun('goal', released.version);
    const replacementLease = writer.claim('goal')!;
    const reclaimed = reader.get('goal');
    const events = reader.events('goal');
    advance(5_000);
    expect(() => writer.heartbeat(lease))
      .toThrowError(expect.objectContaining({ code: 'GOAL_OWNER_LOST' }));
    expect(reader.get('goal')).toEqual(reclaimed);
    expect(reader.events('goal')).toEqual(events);
    expect(writer.heartbeat(replacementLease).version).toBe(reclaimed.version);
  });
});
