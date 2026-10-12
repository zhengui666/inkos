import { useState } from 'react';
import { GitBranch, Pause, Play, X } from 'lucide-react';
import { useResource, useWorkspace } from '../runtime/hooks';
import { rpc, requestId } from '../runtime/api';
import type { RecordData } from '../runtime/types';
import { taskPaused, taskRows, taskStatus, terminalTask } from '../runtime/projection';
import { Action, Badge, DataDetails, Empty, QueryState } from '../components/workbench';

export function Tasks() {
  const { status, run } = useWorkspace();
  const [selected, setSelected] = useState<string | number | null>(null);
  const [filter, setFilter] = useState('all');
  const detail = useResource<RecordData>('tasks.get', { id: selected }, selected !== null);
  const rows = taskRows(status?.tasks ?? [], status?.taskGraph);
  const visible = rows.filter(({ task }) => filter === 'all' || (filter === 'active' ? !terminalTask(task) : ['failed', 'faulted'].includes(taskStatus(task))));
  return <>
    <div className="page-heading"><div><p className="eyebrow">NATIVE EXECUTION</p><h1>Task tree</h1><p className="muted">Runtime-owned tasks keep running when Studio is closed.</p></div></div>
    <div className="segmented" aria-label="Task filter">{['all', 'active', 'failed'].map(value => <button key={value} aria-pressed={filter === value} className={filter === value ? 'selected' : ''} onClick={() => setFilter(value)}>{value[0].toUpperCase() + value.slice(1)}</button>)}</div>
    <div className="task-grid"><section className="panel" aria-label="Native task tree"><div className="panel-heading"><h2>Tasks</h2><span className="count">{visible.length}</span></div>
      {!visible.length && <Empty title="No tasks in this view">Creation, agent and distribution tasks appear here as the runtime accepts them. No model output is simulated.</Empty>}
      <ul className="task-tree">{visible.map(({ task, depth }, i) => {
        const paused = taskPaused(task, status?.works);
        return <li key={task.id} className="task-row enter" data-testid={`task-${task.id}`} style={{ animationDelay: `${Math.min(i, 5) * 32}ms` }}>
          <button className={`task-select ${selected === task.id ? 'selected' : ''}`} style={{ paddingInlineStart: `${12 + Math.min(depth, 6) * 16}px` }} onClick={() => setSelected(task.id)} aria-pressed={selected === task.id}>
            <GitBranch size={16} /><span><strong>{task.title ?? task.kind ?? task.type ?? 'Native task'}</strong><small><code>#{task.id}</code>{depth > 0 ? ` · child level ${depth}` : ' · root task'}{task.input?.workId ? ` · ${task.input.workId}` : ''}</small></span><span className="task-badges"><Badge value={taskStatus(task)} />{paused && <Badge value="paused" />}{task.abortRequested && <Badge value="cancelling" />}</span>
          </button>
          <div className="task-actions">
            <Action disabled={terminalTask(task)} actionKey={`pause-${task.id}`} onClick={() => { void run(`pause-${task.id}`, () => rpc('tasks.pause', { id: task.id, paused: !paused }), 'Native task pause preference updated'); }}>{paused ? <><Play size={14} /> Resume</> : <><Pause size={14} /> Pause</>}</Action>
            <Action danger disabled={terminalTask(task) || task.abortRequested} actionKey={`abort-${task.id}`} onClick={() => { void run(`abort-${task.id}`, () => rpc('tasks.abort', { id: task.id }), 'Native cancellation requested'); }}><X size={14} /> Cancel</Action>
            {task.kind === 'inkos.content' && terminalTask(task) && taskStatus(task) !== 'completed' && <Action actionKey={`retry-${task.id}`} onClick={() => { void run(`retry-${task.id}`, () => rpc('tasks.retry', { id: task.id, requestId: requestId() }), 'Explicit recovery created a new native task'); }}>Retry content</Action>}
          </div>
        </li>;
      })}</ul>
    </section><aside className="panel stack" aria-label="Task inspector"><h2>Task inspector</h2>{selected === null ? <Empty title="Select a task">Inspect native state, parent-child links, waiting reasons, outcome and usage.</Empty> : <><QueryState resource={detail} />{detail.data && <><div className="actions"><code>Task #{selected}</code><Badge value={taskStatus(detail.data)} /></div><DataDetails title="Native task record" data={detail.data} open /></>}</>}</aside></div>
    <details className="panel"><summary>Native graph & project usage</summary><DataDetails title="Task graph" data={status?.taskGraph} /><DataDetails title="Usage" data={status?.usage} /></details>
  </>;
}
