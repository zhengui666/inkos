import { useState } from 'react';
import { Eye, Plus, Radio } from 'lucide-react';
import { rpc, requestId } from '../runtime/api';
import { useWorkspace } from '../runtime/hooks';
import type { RecordData, Work } from '../runtime/types';
import { label, needsAttention, publishingStatus, targetView } from '../runtime/projection';
import { Action, Badge, DataDetails, Empty, Field } from '../components/workbench';

export function Publishing({ attentionOnly = false }: { attentionOnly?: boolean }) {
  const { status } = useWorkspace();
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState('');
  const targets = (status?.targets ?? []).map(targetView);
  const distributions = (status?.distributions ?? []).filter(item => (!selected || item.targetId === selected) && (!attentionOnly || needsAttention(item)));
  const publishers = [...new Set((status?.plugins ?? []).flatMap(plugin => (plugin.publishers ?? []).map((value: unknown) => typeof value === 'string' ? value : String((value as RecordData).id ?? (value as RecordData).name ?? label(value)))))];
  return <>
    <div className="page-heading"><div><p className="eyebrow">INDEPENDENT DISTRIBUTION</p><h1>{attentionOnly ? 'User actions & observation' : 'Publishing targets'}</h1><p className="muted">{attentionOnly ? 'Resolve one target at a time. Other targets continue independently.' : 'Content creation and distribution have separate native progress.'}</p></div>{!attentionOnly && <Action primary disabled={!status?.works.length} onClick={() => setCreating(true)}><Plus size={16} /> Add target</Action>}</div>
    {creating && <TargetForm works={status?.works ?? []} publishers={publishers} onClose={() => setCreating(false)} />}
    {!attentionOnly && <div className="target-list">{targets.map((target, i) => <TargetCard key={target.id} target={target} work={status?.works.find(w => w.id === target.workId)} publishers={publishers} styleIndex={i} />)}{!targets.length && <section className="panel"><Empty title="No publishing targets">A work does not need a platform. Add multiple targets to distribute a revision when ready.</Empty></section>}</div>}
    <section className="panel stack" aria-label="Distribution progress"><div className="panel-heading"><h2>{attentionOnly ? 'Needs your attention' : 'Distribution progress'}</h2><span className="count">{distributions.length}</span></div><Field label="Filter by target"><select value={selected} onChange={e => setSelected(e.target.value)}><option value="">All targets</option>{targets.map(target => <option key={target.id} value={target.id}>{target.accountLabel ?? target.id} · {target.publisher}</option>)}</select></Field>
      <p className="muted small">Submitted ≠ published. Reviewing and published are reported separately; an unknown result needs observation, not a retry.</p>
      {distributions.map(item => <Distribution key={item.id} item={item} target={targets.find(t => t.id === item.targetId)} />)}
      {!distributions.length && <Empty title={attentionOnly ? 'No user actions or unknown results' : 'No distributions in this view'}>{attentionOnly ? 'Waiting-user and needs-observation records appear here without blocking other targets.' : 'Queue a saved artifact revision for a target above.'}</Empty>}
    </section>
  </>;
}
function TargetForm({ works, publishers, onClose, target }: { works: Work[]; publishers: string[]; onClose: () => void; target?: RecordData }) {
  const { run } = useWorkspace();
  const key = target ? `target-update-${target.id}` : 'target-create';
  return <form className="panel stack enter" onSubmit={e => {
    e.preventDefault(); const form = new FormData(e.currentTarget);
    void run(key, async () => {
      const params: RecordData = { workId: target?.workId ?? String(form.get('workId')), publisher: String(form.get('publisher')), accountId: String(form.get('accountId')), accountLabel: String(form.get('accountLabel')) };
      for (const field of ['remoteWorkId', 'skill']) if (form.get(field)) params[field] = String(form.get(field));
      for (const field of ['browser', 'metadata']) if (form.get(field)) params[field] = JSON.parse(String(form.get(field)));
      const entryUrl = String(form.get('entryUrl') ?? '');
      if (entryUrl) params.metadata = { ...params.metadata, entryUrl };
      if (!target) return rpc('publishing.createTarget', params);
      const changes = target.config ? { label: params.accountLabel, config: {
        ...target.config, accountId: params.accountId, entryUrl: entryUrl || target.config.entryUrl,
        browser: params.browser ?? {}, metadata: params.metadata ?? {}, skill: params.skill ?? '',
        remote: { ...target.config.remote, workId: params.remoteWorkId || null },
      } } : params;
      return rpc('publishing.updateTarget', { id: target.id, changes });
    }, target ? 'Target updated' : 'Target created').then(value => { if (value !== undefined) onClose(); });
  }}><div className="panel-heading"><h2>{target ? 'Edit target' : 'New publishing target'}</h2><Action onClick={onClose}>Close</Action></div><div className="form-grid"><Field label="Target work"><select name="workId" required disabled={!!target} defaultValue={target?.workId ?? works[0]?.id}>{works.map(work => <option key={work.id} value={work.id}>{work.title}</option>)}</select></Field><Field label="Publisher" hint="Installed extension publisher ID; capabilities are declared by that extension"><input required readOnly={!!target} name="publisher" list="publishers" defaultValue={target?.publisher ?? 'browser'} /><datalist id="publishers">{publishers.map(p => <option key={p} value={p} />)}</datalist></Field></div><div className="form-grid"><Field label="Account ID"><input name="accountId" readOnly={!!target} required defaultValue={target?.accountId ?? ''} /></Field><Field label="Account label"><input name="accountLabel" required defaultValue={target?.accountLabel ?? ''} /></Field><Field label="Remote work ID (optional)"><input name="remoteWorkId" defaultValue={target?.remoteWorkId ?? ''} /></Field></div><Field label="Entry URL" hint="Browser and extension publishers need a destination URL; creating a target does not visit it."><input type="url" name="entryUrl" defaultValue={target?.entryUrl ?? ''} /></Field>{target && <p className="muted small">Work, publisher and account are this target’s identity. Create another target to change them.</p>}<details><summary>Browser, metadata & skill</summary><div className="stack"><Field label="Publisher skill"><input name="skill" defaultValue={target?.skill ?? ''} /></Field>{['browser', 'metadata'].map(field => <Field key={field} label={`${field[0].toUpperCase() + field.slice(1)} JSON`}><textarea rows={3} name={field} defaultValue={target?.[field] ? JSON.stringify(target[field], null, 2) : ''} /></Field>)}</div></details><Action primary type="submit" actionKey={key}>{target ? 'Save target' : 'Create target'}</Action></form>;
}
function TargetCard({ target, work, publishers, styleIndex }: { target: RecordData; work?: Work; publishers: string[]; styleIndex: number }) {
  const { run, status } = useWorkspace();
  const [editing, setEditing] = useState(false); const [queueing, setQueueing] = useState(false);
  return <article className="panel stack enter" aria-label={`Target ${target.accountLabel ?? target.id}`} style={{ animationDelay: `${Math.min(styleIndex, 5) * 32}ms` }}><div className="panel-heading"><div><h2>{target.accountLabel ?? target.id}</h2><p className="muted small">{work?.title ?? target.workId} · {target.publisher}</p><code>{target.id}</code></div><Radio size={18} className="muted" /></div><div className="actions"><Action onClick={() => setQueueing(!queueing)} disabled={!work?.artifactIds.length}>{queueing ? 'Close queue' : 'Queue revision'}</Action><Action onClick={() => setEditing(!editing)}>{editing ? 'Close editor' : 'Edit target'}</Action></div>
    {editing && <TargetForm target={target} works={status?.works ?? []} publishers={publishers} onClose={() => setEditing(false)} />}
    {queueing && <form className="stack" onSubmit={e => { e.preventDefault(); const form = new FormData(e.currentTarget); const scheduled = String(form.get('scheduledAt')); void run(`queue-${target.id}`, () => rpc('publishing.queue', { targetId: target.id, artifactId: form.get('artifactId'), ...(form.get('revisionId') ? { revisionId: form.get('revisionId') } : {}), operation: form.get('operation'), ...(scheduled ? { scheduledAt: new Date(scheduled).getTime() } : {}), requestId: requestId() }), 'Distribution queued for this target').then(value => { if (value !== undefined) setQueueing(false); }); }}><div className="form-grid"><Field label="Publish artifact"><select name="artifactId" required>{work?.artifactIds.map(id => <option value={id} key={id}>{id}</option>)}</select></Field><Field label="Publish revision ID" hint="Blank selects the runtime’s latest revision"><input name="revisionId" /></Field></div><div className="form-grid"><Field label="Operation"><select name="operation"><option value="publish">Publish</option><option value="update">Update</option></select></Field><Field label="Schedule (optional)"><input type="datetime-local" name="scheduledAt" /></Field></div><Action primary type="submit" actionKey={`queue-${target.id}`}>Queue distribution</Action></form>}
    <DataDetails title="Target configuration & capabilities" data={target.native ?? target} />
  </article>;
}
function Distribution({ item, target }: { item: RecordData; target?: RecordData }) {
  const { run } = useWorkspace(); const state = publishingStatus(item);
  const attention = needsAttention(item);
  return <article className={`distribution ${attention ? 'needs-attention' : ''}`} aria-label={`Distribution ${item.id}`}><div className="panel-heading"><div><h3>{target?.accountLabel ?? item.targetId}</h3><p className="muted small">{item.operation} · {item.artifactId} <code>#{item.id}</code></p></div><Badge value={state} /></div>
    <ol className="publishing-stages" aria-label="Remote publishing state">{['submitted', 'reviewing', 'published'].map(value => <li key={value} className={state === value ? 'current' : ''} aria-current={state === value ? 'step' : undefined}>{value}</li>)}</ol>
    {attention && <div className="inline-hint"><strong>{['unknown', 'needs-observation'].includes(state) ? 'Needs observation' : 'User action required'}</strong><p>{typeof (item.userTodo ?? item.todo) === 'string' ? item.userTodo ?? item.todo : item.error ?? item.lastObservation?.evidence ?? item.reason ?? 'Inspect the native receipt and act only on this distribution.'}</p><p className="small">Other targets continue independently.</p></div>}
    <div className="actions"><Action actionKey={`observe-${item.id}`} onClick={() => { void run(`observe-${item.id}`, () => rpc('publishing.observe', { id: item.id }), 'Observation requested for this distribution'); }}><Eye size={14} /> Observe remote state</Action><Action disabled={!attention} actionKey={`resume-${item.id}`} onClick={() => { void run(`resume-${item.id}`, () => rpc('publishing.resume', { id: item.id }), 'This distribution resumed'); }}>Resume this target</Action></div><DataDetails title="Receipt, user todo & native distribution" data={item} />
  </article>;
}
