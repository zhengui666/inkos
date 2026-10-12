import type { RecordData, Work } from './types';

export function canonicalLocale(value: string): string {
  return Intl.getCanonicalLocales(value.trim())[0] ?? 'en';
}
export function taskStatus(task: RecordData): string {
  const state = task.state ?? task.task?.state ?? task;
  return state.status === 'terminal' ? state.outcome?.status ?? 'terminal' : state.status ?? 'pending';
}
export function taskPaused(task: RecordData, works: Work[] = []): boolean {
  const work = works.find(work => work.id === (task.workId ?? task.input?.workId));
  return Boolean(task.paused ?? task.pauseRequested ?? task.state?.paused ?? task.state?.pauseRequested ?? work?.pauseRequested);
}
export function terminalTask(task: RecordData): boolean {
  return ['completed', 'failed', 'faulted', 'aborted', 'terminal'].includes(taskStatus(task));
}
export function taskRows(tasks: RecordData[], graph?: { tasks: Record<string, RecordData> }) {
  const nodes = new Map<string, RecordData>();
  for (const [id, task] of Object.entries(graph?.tasks ?? {})) nodes.set(String(id), { ...task, id: task.id ?? Number(id) });
  for (const task of tasks) nodes.set(String(task.id), { ...nodes.get(String(task.id)), ...task });
  const parent = (task: RecordData) => task.owner ?? task.ownership?.taskId ?? task.parentId ?? task.parentTaskId ?? task.parent?.id;
  const depth = (task: RecordData) => {
    let level = 0; let cursor = task; const seen = new Set([String(task.id)]);
    while (parent(cursor) !== undefined && parent(cursor) !== null) {
      const id = String(parent(cursor)); const next = nodes.get(id);
      if (!next || seen.has(id)) break;
      seen.add(id); level++; cursor = next;
    }
    return level;
  };
  const result: { task: RecordData; depth: number }[] = [];
  const visited = new Set<string>();
  const visit = (task: RecordData) => {
    const id = String(task.id); if (visited.has(id)) return;
    visited.add(id); result.push({ task, depth: depth(task) });
    for (const child of nodes.values()) if (String(parent(child)) === id) visit(child);
  };
  for (const task of nodes.values()) if (!nodes.has(String(parent(task)))) visit(task);
  for (const task of nodes.values()) visit(task);
  return result;
}
export function entryText(raw: RecordData): string {
  const entry = raw.entry ?? raw;
  if (entry.kind === 'inkos.note') return entry.data?.text ?? '';
  if (Array.isArray(entry.model)) return entry.model.map((message: RecordData) => `${message.role}: ${entryText({ content: message.content })}`).join('\n\n');
  const content = entry.content ?? entry.message?.content ?? entry.data?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(block => typeof block === 'string' ? block : block.text ?? JSON.stringify(block, null, 2)).join('\n');
  return JSON.stringify(entry.data ?? entry, null, 2);
}
export function publishingStatus(item: RecordData): string {
  return item.receipt?.status ?? item.status ?? item.remote?.status ?? item.state?.status ?? 'needs-observation';
}
export function needsAttention(item: RecordData): boolean {
  return ['needs-observation', 'unknown', 'waiting-user', 'needs-user', 'user-action', 'failed'].includes(publishingStatus(item)) || Boolean(item.userTodo ?? item.todo ?? item.remote?.userAction);
}
export function label(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const item = value as RecordData;
    return String(item.name ?? item.title ?? item.label ?? item.id ?? item.type ?? JSON.stringify(item));
  }
  return String(value ?? '');
}

/** Read-only labels over the native publishing target; never a second target store. */
export function targetView(record: RecordData): RecordData {
  const config = record.config ?? {};
  return { ...record, native: record,
    publisher: record.publisher ?? record.platform,
    accountLabel: record.accountLabel ?? record.label ?? record.id,
    accountId: record.accountId ?? config.accountId,
    remoteWorkId: record.remoteWorkId ?? config.remote?.workId,
    browser: record.browser ?? config.browser,
    metadata: record.metadata ?? config.metadata,
    skill: record.skill ?? config.skill,
    entryUrl: record.entryUrl ?? record.metadata?.entryUrl ?? config.entryUrl,
  };
}
