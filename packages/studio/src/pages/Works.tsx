import { useEffect, useRef, useState } from 'react';
import { BookOpen, FilePlus2, Plus, Upload } from 'lucide-react';
import { rpc, requestId } from '../runtime/api';
import { useResource, useWorkspace } from '../runtime/hooks';
import { builtinProfiles, type ArtifactRead, type ModelCatalog, type RecordData, type Work } from '../runtime/types';
import { canonicalLocale, label } from '../runtime/projection';
import { Action, Badge, DataDetails, Empty, Field, QueryState } from '../components/workbench';
import { DomainView } from './domain/DomainView';

export function Works({ selectedId, select }: { selectedId?: string; select: (id?: string) => void }) {
  const { status, run } = useWorkspace();
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState('');
  const [migration, setMigration] = useState<RecordData | null>(null);
  const works = status?.works ?? [];
  const selected = works.find(work => work.id === selectedId);
  const profiles = [...new Set([...builtinProfiles, ...(status?.plugins ?? []).flatMap(plugin => (plugin.profiles ?? []).map((p: any) => typeof p === 'string' ? p : p.id ?? p.name))])];
  return <>
    <div className="page-heading"><div><p className="eyebrow">PROJECT LIBRARY</p><h1>Works & revisions</h1><p className="muted">Create independently. Choose distribution targets when you’re ready.</p></div><Action primary onClick={() => { setCreating(true); select(); }}><Plus size={16} /> New work</Action></div>
    {creating && <NewWork profiles={profiles} onClose={() => setCreating(false)} onCreated={id => { setCreating(false); select(id); }} />}
    <div className="library-grid">
      <section className="panel library-list" aria-label="Works library">
        <div className="panel-heading"><h2>Library</h2><span className="count">{works.length}</span></div>
        <label className="sr-only" htmlFor="work-search">Search works</label><input id="work-search" type="search" placeholder="Search works…" value={filter} onChange={e => setFilter(e.target.value)} />
        <div className="work-list">{works.filter(work => `${work.title} ${work.profile} ${work.locale}`.toLowerCase().includes(filter.toLowerCase())).map((work, i) => <button className={`work-item enter ${selectedId === work.id ? 'selected' : ''}`} style={{ animationDelay: `${Math.min(i, 5) * 32}ms` }} key={work.id} onClick={() => select(work.id)} aria-pressed={selectedId === work.id}>
          <BookOpen size={18} /><span><strong>{work.title}</strong><small>{work.profile} · {work.locale} · {work.artifactIds.length} artifacts</small></span><Badge value={work.status} />
        </button>)}</div>
        {!works.length && <Empty title="Your first work starts here">No platform or account is required. Create a work, then import or write a draft.</Empty>}
        {!!works.length && !works.some(work => `${work.title} ${work.profile} ${work.locale}`.toLowerCase().includes(filter.toLowerCase())) && <Empty title="No matching works">Try a different search.</Empty>}
        <details className="migration"><summary>Import legacy works</summary><p className="muted small">Preview the runtime migration before applying it.</p><Action actionKey="migrate-preview" onClick={() => { void run('migrate-preview', () => rpc('work.migrate', { apply: false }), 'Migration preview ready').then(result => { if (result) setMigration(result); }); }}>Preview migration</Action>{migration && <><DataDetails title="Migration preview" data={migration} open /><Action actionKey="migrate-apply" onClick={() => { void run('migrate-apply', () => rpc('work.migrate', { apply: true }), 'Legacy works migrated'); }}>Apply migration</Action></>}</details>
      </section>
      {selected ? <WorkDetail key={selected.id} work={selected} /> : <section className="panel"><Empty title={selectedId ? 'Work not found' : 'Select a work'}>{selectedId ? 'Refresh the project view or choose another work.' : 'Browse versions, edit a draft, and inspect the production plan.'}</Empty></section>}
    </div>
  </>;
}
function NewWork({ profiles, onClose, onCreated }: { profiles: string[]; onClose: () => void; onCreated: (id: string) => void }) {
  const { run } = useWorkspace();
  const [title, setTitle] = useState(''); const [profile, setProfile] = useState('fiction'); const [locale, setLocale] = useState('en'); const [brief, setBrief] = useState('');
  const [localeError, setLocaleError] = useState('');
  return <form className="panel new-work enter" onSubmit={e => {
    e.preventDefault(); let canonical: string;
    try { canonical = canonicalLocale(locale); setLocaleError(''); } catch { setLocaleError('Enter a valid Intl locale, such as ja, fr-CA or ar.'); return; }
    void run('new-work', () => rpc<Work>('works.create', { title, profile, locale: canonical, brief }), 'Work created').then(work => { if (work) onCreated(work.id); });
  }}><div className="panel-heading"><h2>New work</h2><Action onClick={onClose}>Close</Action></div><div className="form-grid">
    <Field label="Work title"><input autoFocus required value={title} onChange={e => setTitle(e.target.value)} /></Field>
    <Field label="Profile" hint="Built-in or an extension profile ID"><input list="work-profiles" required value={profile} onChange={e => setProfile(e.target.value)} /><datalist id="work-profiles">{profiles.map(p => <option key={p} value={p} />)}</datalist></Field>
    <Field label="Locale" hint="Any Intl locale; not limited to English or Chinese"><input required value={locale} aria-invalid={!!localeError} onChange={e => setLocale(e.target.value)} /></Field>
  </div>{localeError && <p role="alert" className="error-text">{localeError}</p>}<Field label="Creative brief"><textarea rows={3} value={brief} onChange={e => setBrief(e.target.value)} /></Field><div className="actions"><span className="muted small">No publishing platform required.</span><Action type="submit" actionKey="new-work" primary>Create work</Action></div></form>;
}
function WorkDetail({ work }: { work: Work }) {
  const { run } = useWorkspace();
  const [artifactId, setArtifactId] = useState(work.artifactIds[0] ?? '');
  const [blank, setBlank] = useState(false);
  const catalog = useResource<ModelCatalog>('models.list');
  const modelReady = Boolean(catalog.data?.selected && catalog.data.providers.some(provider => provider.id === catalog.data?.selected?.provider && provider.configured));
  useEffect(() => { if (!artifactId && !blank && work.artifactIds.length) setArtifactId(work.artifactIds[0]); }, [work.artifactIds, artifactId, blank]);
  return <section className="work-detail stack">
    <div className="panel"><div className="panel-heading"><div><h2>{work.title}</h2><p className="muted small">{work.profile} · {work.locale} <code>{work.id}</code></p></div><Badge value={work.status} /></div>
      <div className="actions"><Action actionKey={`work-pause-${work.id}`} onClick={() => { void run(`work-pause-${work.id}`, () => rpc('works.pause', { id: work.id, paused: !(work.pauseRequested || work.status === 'paused') }), 'Work pause preference updated'); }}>{work.pauseRequested || work.status === 'paused' ? 'Resume work' : 'Pause work'}</Action><Action disabled={!modelReady || work.status === 'cancelled' || work.status === 'paused'} actionKey={`produce-${work.id}`} onClick={() => { void run(`produce-${work.id}`, () => rpc('produce', { workId: work.id, requestId: requestId() }), 'Production task accepted'); }}>Produce next unit</Action></div>
      <QueryState resource={catalog} />
      {catalog.data && !modelReady && <p className="inline-hint">{catalog.data.providers.some(p => p.configured) ? 'No usable model is selected. Choose a configured provider and model in Models.' : 'Model service is not configured. Import and edit drafts offline; configure a provider in Models for AI creation.'}</p>}
      <WorkPlan work={work} />
    </div>
    <section className="panel" aria-label="Artifact editor"><div className="panel-heading"><h2>Drafts & versions</h2><div className="actions"><Action onClick={() => { setBlank(true); setArtifactId(''); }}><FilePlus2 size={16} /> New draft</Action></div></div>
      {!!work.artifactIds.length && <Field label="Artifact"><select value={artifactId} onChange={e => { setBlank(false); setArtifactId(e.target.value); }}><option value="">New artifact</option>{work.artifactIds.map(id => <option key={id} value={id}>{id}</option>)}</select></Field>}
      <ArtifactEditor key={artifactId || 'new'} work={work} artifactId={artifactId} modelReady={modelReady} onSaved={id => { if (id) { setBlank(false); setArtifactId(id); } }} />
    </section>
    <DomainView work={work} />
    <DataDetails title="Work history & native data" data={work} />
  </section>;
}
function WorkPlan({ work }: { work: Work }) {
  const { run } = useWorkspace();
  return <details className="plan"><summary>Production plan & review</summary><form className="stack" onSubmit={e => {
    e.preventDefault(); const form = new FormData(e.currentTarget); const number = (key: string) => form.get(key) === '' ? null : Number(form.get(key));
    void run(`plan-${work.id}`, () => rpc('works.update', { id: work.id, changes: {
      title: form.get('title'), locale: canonicalLocale(String(form.get('locale'))),
      plan: { ...work.plan, brief: form.get('brief'), serial: form.has('serial'), units: number('units'), needsPlanning: form.has('needsPlanning'),
        review: { id: form.get('reviewId'), enabled: form.has('review'), maxRevisions: number('maxRevisions'), maxCost: number('maxCost') },
        production: { backlog: number('backlog'), cron: form.get('cron') || null, nextAt: work.plan.production.nextAt } },
    } }), 'Production plan saved');
  }}><div className="form-grid"><Field label="Title"><input name="title" defaultValue={work.title} required /></Field><Field label="Profile"><input value={work.profile} readOnly /></Field><Field label="Work locale"><input name="locale" defaultValue={work.locale} required /></Field></div><Field label="Brief"><textarea name="brief" defaultValue={work.plan.brief} rows={3} /></Field><div className="form-grid"><Field label="Units (blank = open-ended)"><input name="units" type="number" min="1" defaultValue={work.plan.units ?? ''} /></Field><Field label="Backlog"><input name="backlog" type="number" min="0" required defaultValue={work.plan.production.backlog} /></Field><Field label="Production cron"><input name="cron" defaultValue={work.plan.production.cron ?? ''} placeholder="Optional cron expression" /></Field></div>
    <div className="checks"><label><input type="checkbox" name="serial" defaultChecked={work.plan.serial} /> Serial work</label><label><input type="checkbox" name="needsPlanning" defaultChecked={work.plan.needsPlanning} /> Needs planning</label><label><input type="checkbox" name="review" defaultChecked={work.plan.review.enabled} /> Review enabled</label></div><div className="form-grid"><Field label="Review ID"><input name="reviewId" defaultValue={work.plan.review.id} required /></Field><Field label="Max revisions"><input name="maxRevisions" type="number" min="0" required defaultValue={work.plan.review.maxRevisions} /></Field><Field label="Max review cost (blank = no cap)"><input name="maxCost" type="number" min="0" step="any" defaultValue={work.plan.review.maxCost ?? ''} /></Field></div><Action type="submit" primary actionKey={`plan-${work.id}`}>Save plan</Action></form></details>;
}
function ArtifactEditor({ work, artifactId, modelReady, onSaved }: { work: Work; artifactId: string; modelReady: boolean; onSaved: (id: string) => void }) {
  const { run, busy } = useWorkspace();
  const [revisionId, setRevisionId] = useState('');
  const resource = useResource<ArtifactRead>('artifacts.read', { id: artifactId, ...(revisionId ? { revisionId } : {}) }, !!artifactId);
  const [title, setTitle] = useState(''); const [content, setContent] = useState(''); const [format, setFormat] = useState('md'); const [dirty, setDirty] = useState(false);
  const [instruction, setInstruction] = useState(''); const [targetText, setTargetText] = useState(''); const [replacement, setReplacement] = useState('');
  const [exportPath, setExportPath] = useState(''); const [exportFormat, setExportFormat] = useState('md');
  const upload = useRef<HTMLInputElement>(null);
  useEffect(() => { if (resource.data && !dirty) { setTitle(resource.data.revision.title ?? resource.data.artifact.title ?? ''); setContent(resource.data.content); setFormat(resource.data.revision.format ?? 'md'); } }, [resource.data, dirty]);
  const revisions = resource.data?.artifact.revisions ?? resource.data?.artifact.history ?? [];
  const save = () => { void run('artifact-save', () => rpc<RecordData>('artifacts.save', { workId: work.id, ...(artifactId ? { artifactId } : {}), title, content, format }), 'Revision saved').then(revision => { if (revision) { setDirty(false); if (revision.id) setRevisionId(revision.id); onSaved(revision.artifactId ?? artifactId); } }); };
  return <div className="stack"><QueryState resource={resource} />
    {artifactId && <div className="revision-strip"><Badge value="revision" /><code data-testid="revision-id">{resource.data?.revision.id ?? 'Loading…'}</code><span className="muted small">{dirty ? 'Unsaved changes' : 'Persisted by runtime'}</span></div>}
    {artifactId && <form className="revision-picker actions" onSubmit={e => { e.preventDefault(); const value = String(new FormData(e.currentTarget).get('revision') ?? ''); setDirty(false); setRevisionId(value); }}><Field label="Read revision ID"><input name="revision" list={`revisions-${artifactId}`} placeholder="Blank = latest" defaultValue={revisionId} /><datalist id={`revisions-${artifactId}`}>{(Array.isArray(revisions) ? revisions : Object.values(revisions)).map((r: any) => <option value={typeof r === 'string' ? r : r.id} key={typeof r === 'string' ? r : r.id} />)}</datalist></Field><Action type="submit">Read version</Action></form>}
    <Field label="Draft title"><input value={title} onChange={e => { setDirty(true); setTitle(e.target.value); }} /></Field>
    <Field label="Draft content"><textarea className="draft-editor" rows={14} value={content} onChange={e => { setDirty(true); setContent(e.target.value); }} placeholder="Write here or import a text draft…" /></Field>
    <div className="actions"><Field label="Content format"><select value={format} onChange={e => { setFormat(e.target.value); setDirty(true); }}>{['md', 'txt', 'json', 'ink', 'html'].map(f => <option key={f} value={f}>{f}</option>)}</select></Field><Action primary actionKey="artifact-save" disabled={!title.trim() || !content.trim() || (!!artifactId && !resource.data)} onClick={save}>Save revision</Action><Action disabled={busy.has('draft-import')} onClick={() => upload.current?.click()}><Upload size={16} /> Import draft</Action><input className="sr-only" ref={upload} type="file" accept=".txt,.md,.json,.ink,.html" aria-label="Import draft file" onChange={e => { const file = e.target.files?.[0]; if (!file) return; void run('draft-import', async () => rpc<RecordData>('artifacts.save', { workId: work.id, title: file.name.replace(/\.[^.]+$/, ''), content: await file.text(), format: file.name.split('.').pop() ?? 'txt' }), 'Draft imported as a revision').then(revision => { if (revision) onSaved(revision.artifactId); }); e.target.value = ''; }} /></div>
    {!!artifactId && <details><summary>Exact-text edit & export</summary><div className="stack"><Field label="Target text"><textarea rows={2} value={targetText} onChange={e => setTargetText(e.target.value)} /></Field><Field label="Replacement"><textarea rows={2} value={replacement} onChange={e => setReplacement(e.target.value)} /></Field><Action disabled={!targetText || dirty} actionKey="artifact-edit" onClick={() => { void run('artifact-edit', () => rpc('artifacts.edit', { id: artifactId, targetText, replacement }), 'Edit persisted as a revision').then(result => { if (result) { setRevisionId(''); resource.refresh(); } }); }}>Apply exact edit</Action><div className="actions"><Field label="Export format"><select value={exportFormat} onChange={e => setExportFormat(e.target.value)}>{['txt', 'md', 'epub', 'html', 'json', 'ink'].map(f => <option key={f} value={f}>{f}</option>)}</select></Field><Action actionKey="artifact-export" onClick={() => { void run('artifact-export', () => rpc<{ path: string }>('artifacts.export', { artifactId, format: exportFormat }), 'Export written to project').then(result => { if (result) setExportPath(result.path); }); }}>Export artifact</Action></div>{exportPath && <p className="small">Project export: <code>{exportPath}</code></p>}</div></details>}
    <details><summary>AI creation task</summary><div className="stack"><p className="muted small">Creation produces a new revision only. Publishing is a separate operation per target.</p><Field label="Creation instruction"><textarea rows={3} value={instruction} onChange={e => setInstruction(e.target.value)} /></Field><Action primary disabled={!modelReady || !instruction.trim()} actionKey={`create-${work.id}`} onClick={() => { void run(`create-${work.id}`, () => rpc('creation.start', { workId: work.id, ...(artifactId ? { artifactId } : {}), title, instruction: content.trim() ? `${instruction}\n\nAuthor draft to revise:\n${content}` : instruction, requestId: requestId() }), 'Creation task accepted; inspect Tasks for progress'); }}>Start creation</Action></div></details>
    {resource.data && <DataDetails title="Artifact & revision metadata" data={{ artifact: resource.data.artifact, revision: resource.data.revision }} />}
    {resource.data && ['interactive-film', 'translation', 'play', 'storyboard'].includes(work.profile) && <DomainView work={work} content={resource.data.content} />}
  </div>;
}
