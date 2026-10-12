import { describe, expect, it } from 'vitest';
import { canonicalLocale, entryText, needsAttention, publishingStatus, taskRows, taskStatus, terminalTask } from './projection';

describe('native read projections', () => {
  it('accepts Intl locales beyond an English/Chinese enum', () => {
    expect(canonicalLocale('ja')).toBe('ja');
    expect(canonicalLocale('fr-ca')).toBe('fr-CA');
    expect(canonicalLocale('ar-EG')).toBe('ar-EG');
    expect(() => canonicalLocale('not a locale')).toThrow();
  });
  it('keeps native terminal outcomes distinct', () => {
    expect(taskStatus({ state: { status: 'terminal', outcome: { status: 'aborted' } } })).toBe('aborted');
    expect(terminalTask({ state: { status: 'completing', outcome: { status: 'completed' } } })).toBe(false);
    expect(taskStatus({ state: { status: 'waiting' } })).toBe('waiting');
    expect(terminalTask({ state: { status: 'terminal', outcome: { status: 'faulted' } } })).toBe(true);
  });
  it('orders a native task graph by owner without creating task state', () => {
    const tasks = [{ id: 2, owner: 1, state: { status: 'waiting' } }, { id: 1, state: { status: 'running' } }];
    const rows = taskRows(tasks, { tasks: { '3': { id: 3, owner: 2, state: { status: 'pending' } } } });
    expect(rows.map(row => [row.task.id, row.depth])).toEqual([[1, 0], [2, 1], [3, 2]]);
    expect(tasks[0].state.status).toBe('waiting');
  });
  it('renders offline native note entries without model content', () => {
    expect(entryText({ kind: 'inkos.note', data: { text: 'Author decision' } })).toBe('Author decision');
  });
  it('does not confuse submitted or reviewing with published', () => {
    expect(publishingStatus({ status: 'submitted' })).toBe('submitted');
    expect(publishingStatus({ status: 'reviewing' })).toBe('reviewing');
    expect(publishingStatus({ status: 'published' })).toBe('published');
    expect(needsAttention({ status: 'needs-observation' })).toBe(true);
    expect(needsAttention({ status: 'published' })).toBe(false);
  });
});
