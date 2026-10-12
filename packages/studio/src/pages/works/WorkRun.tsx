import { useState } from 'react';
import { Clock3, Play, Square, Radar } from 'lucide-react';
import { rpc, requestId } from '../../runtime/api';
import { useWorkspace } from '../../runtime/hooks';
import { taskStatus, terminalTask, taskPaused } from '../../runtime/projection';
import type { RecordData, Work } from '../../runtime/types';
import { Action, Badge, DataDetails, Empty, Field } from '../../components/workbench';
import { useI18n } from '../../i18n';
import './works.css';

export function WorkRun({ work, modelReady }: { work: Work; modelReady: boolean }) {
  const { t, formatDateTime } = useI18n();
  const { status, run } = useWorkspace();
  const config = work.autonomy?.config;
  const [urls, setUrls] = useState(config?.sources.map(source => source.url).join('\n') ?? '');
  const [source, setSource] = useState(config?.sources[0]?.source ?? 'public-page');
  const [chapterMinutes, setChapterMinutes] = useState((config?.chapterEveryMs ?? 3600000) / 60000);
  const [researchHours, setResearchHours] = useState((config?.researchEveryMs ?? 21600000) / 3600000);
  const [length, setLength] = useState(config?.chapterLength ?? 2000);
  const [hours, setHours] = useState(24);
  const [adopt, setAdopt] = useState(config?.adoptSelection ?? false);
  const [ongoing, setOngoing] = useState(true);
  const [preview, setPreview] = useState<RecordData[]>([]);
  const sources = (status?.plugins ?? []).flatMap(plugin => plugin.rankingSources ?? []);
  const native = status?.tasks.find(task => task.id === work.autonomy?.taskId);
  const active = Boolean(native && !terminalTask(native));
  const phase = native?.state?.checkpoint?.phase;
  const settings = () => ({ sources: urls.split('\n').map(url => url.trim()).filter(Boolean).map((url, i) => ({ id: `source-${i + 1}`, source, url })),
    chapterEveryMs: chapterMinutes * 60000, researchEveryMs: researchHours * 3600000, chapterLength: length, adoptSelection: adopt });
  return <section className="panel stack work-run" aria-label={t('Unattended writing')}>
    <div className="panel-heading"><div><p className="eyebrow">{t('RESEARCH → CREATE → DISTRIBUTE')}</p><h2>{t('Unattended writing')}</h2></div>{native ? <Badge value={taskStatus(native)} /> : <Radar size={20} />}</div>
    <ol className="autonomy-stages">{[['scan', 'Ranking research'], ['select', 'Topic & book title'], ['title', 'Chapter planning'], ['write', 'Writing & review'], ['schedule', 'Paced continuation']].map(([value, text]) => <li key={value} aria-current={phase === value || value === 'write' && phase === 'continue' ? 'step' : undefined}>{t(text)}</li>)}</ol>
    <p className="muted small">{t('Native tasks survive Studio disconnects. A persisted deadline stops this run, including paused or in-flight model work.')}</p>
    {work.autonomy?.endAt && <div className="run-times"><Clock3 size={16} /><span>{t('Run ends:')} <strong>{formatDateTime(work.autonomy.endAt)}</strong></span>{work.autonomy.nextChapterAt && <span>{t('Next chapter:')} {formatDateTime(work.autonomy.nextChapterAt)}</span>}</div>}
    {work.autonomy?.lastError && <div className="inline-hint" role="status"><strong>{t('Recovery is paced; saved drafts are retained.')}</strong><p className="source-error">{work.autonomy.lastError}</p>{native?.state?.checkpoint?.retryAt && <p>{t('Retry at:')} {formatDateTime(native.state.checkpoint.retryAt)}</p>}</div>}
    <details open={!config}><summary>{t('Sources & run settings')}</summary><form className="stack" onSubmit={event => { event.preventDefault(); void run(`autonomy-config-${work.id}`, () => rpc('autonomy.configure', { workId: work.id, config: settings() }), 'Unattended settings saved'); }}>
      <Field label="Ranking reader"><select value={source} onChange={event => setSource(event.target.value)}>{sources.map((item: RecordData) => <option key={item.id} value={item.id}>{t(item.label ?? item.id)}</option>)}</select></Field>
      <Field label="Ranking source URLs" hint="One public ranking URL per line. Dynamic or authenticated sources need an installed source extension."><textarea required rows={3} value={urls} onChange={event => setUrls(event.target.value)} placeholder="https://…" /></Field>
      <div className="form-grid"><Field label="Chapter interval (minutes)"><input required min="1" type="number" value={chapterMinutes} onChange={event => setChapterMinutes(Number(event.target.value))} /></Field><Field label="Research interval (hours)"><input required min="0.1" step="0.1" type="number" value={researchHours} onChange={event => setResearchHours(Number(event.target.value))} /></Field><Field label="Approximate chapter length"><input required min="1" type="number" value={length} onChange={event => setLength(Number(event.target.value))} /></Field></div>
      <label className="check-line"><input type="checkbox" checked={adopt} disabled={!!work.artifactIds.length} onChange={event => setAdopt(event.target.checked)} />{t('Adopt the original book title and topic on an empty work')}</label>
      <div className="actions"><Action type="submit" actionKey={`autonomy-config-${work.id}`} primary>{t('Save run settings')}</Action><Action disabled={!urls.trim()} actionKey={`ranking-check-${work.id}`} onClick={() => { void run(`ranking-check-${work.id}`, () => Promise.all(settings().sources.map(item => rpc<RecordData>('ranking.read', item))), 'Ranking sources read').then(value => { if (value) setPreview(value); }); }}>{t('Check sources without a model call')}</Action></div>
    </form></details>
    {!!preview.length && <details open><summary>{t('Source preview')}</summary>{preview.map(item => <article key={item.id}><a href={item.url} target="_blank" rel="noreferrer">{item.url}</a><p className="research-text">{item.text}</p></article>)}</details>}
    <div className="run-controls"><Field label="Run duration (hours)"><input type="number" min="0.1" step="0.1" value={hours} onChange={event => setHours(Number(event.target.value))} /></Field><label className="check-line"><input type="checkbox" checked={ongoing} onChange={event => setOngoing(event.target.checked)} />{t('Ongoing serial')}</label>
      <Action primary disabled={!modelReady || active || !urls.trim() || hours <= 0} actionKey={`autonomy-start-${work.id}`} onClick={() => { void run(`autonomy-start-${work.id}`, async () => {
        await rpc('autonomy.configure', { workId: work.id, config: settings() });
        await rpc('works.update', { id: work.id, changes: { plan: { serial: ongoing, units: ongoing ? null : work.plan.units ?? 1 } } });
        return rpc('autonomy.start', { workId: work.id, durationMs: hours * 3600000, requestId: requestId() });
      }, 'Unattended run accepted'); }}><Play size={15} />{t('Start timed run')}</Action>
      <Action danger disabled={!active} actionKey={`autonomy-stop-${work.id}`} onClick={() => { void run(`autonomy-stop-${work.id}`, () => rpc('autonomy.stop', { workId: work.id }), 'Unattended run stopped'); }}><Square size={14} />{t('Stop run')}</Action>
    </div>
    {work.autonomy?.selection && <details open className="topic-selection"><summary>{t('Original topic & book title')}</summary><h3>{work.autonomy.selection.title}</h3><p>{work.autonomy.selection.topic}</p><p>{work.autonomy.selection.brief}</p><details><summary>{t('Serial blueprint')}</summary><p className="research-text">{work.autonomy.selection.blueprint}</p></details></details>}
    {!!work.autonomy?.research.length && <details><summary>{t('Acquired ranking evidence')}</summary>{work.autonomy.research.map(item => <article key={item.id}><a href={item.url} target="_blank" rel="noreferrer">{item.label}</a><p className="muted small">{formatDateTime(item.fetchedAt)}</p><p className="research-text">{item.text}</p></article>)}</details>}
    <WorkTasks work={work} />
  </section>;
}
export function WorkTasks({ work }: { work: Work }) {
  const { t } = useI18n();
  const { status, run } = useWorkspace();
  const tasks = (status?.tasks ?? []).filter(task => task.input?.workId === work.id && task.kind !== 'inkos.autonomy.deadline');
  return <details className="work-tasks" open={tasks.length > 0}><summary>{t('Activity & recovery')} <span className="count">{tasks.length}</span></summary>
    {!tasks.length && <Empty title="No work activity yet">Saved content, research and native tasks will appear here.</Empty>}
    {[...tasks].reverse().map(task => <article className="work-task" key={task.id} data-testid={`task-${task.id}`}><div className="panel-heading"><span><strong>{task.kind}</strong> <code>#{task.id}</code></span><Badge value={taskStatus(task)} /></div>
      {task.state?.checkpoint?.phase && <p className="muted small">{t('Current step:')} {t(task.state.checkpoint.phase)}</p>}
      {task.state?.outcome?.error?.message && <p className="source-error">{task.state.outcome.error.message}</p>}
      <div className="actions"><Action disabled={terminalTask(task)} actionKey={`pause-${task.id}`} onClick={() => { void run(`pause-${task.id}`, () => rpc('tasks.pause', { id: task.id, paused: !taskPaused(task, [work]) }), 'Native task pause preference updated'); }}>{t(taskPaused(task, [work]) ? 'Resume' : 'Pause')}</Action><Action danger disabled={terminalTask(task) || task.abortRequested} actionKey={`abort-${task.id}`} onClick={() => { void run(`abort-${task.id}`, () => rpc('tasks.abort', { id: task.id }), 'Native cancellation requested'); }}>{t('Cancel')}</Action>
      {task.kind === 'inkos.content' && terminalTask(task) && taskStatus(task) !== 'completed' && <Action actionKey={`retry-${task.id}`} onClick={() => { void run(`retry-${task.id}`, () => rpc('tasks.retry', { id: task.id, requestId: requestId() }), 'Explicit recovery created a new native task'); }}>{t('Retry content')}</Action>}</div>
      <DataDetails title="Native task record" data={task} />
    </article>)}
  </details>;
}
