import { useState } from 'react';
import { MessageSquare, Plus, Send } from 'lucide-react';
import { rpc, requestId } from '../runtime/api';
import { useResource, useWorkspace } from '../runtime/hooks';
import type { ModelCatalog, RecordData } from '../runtime/types';
import { entryText } from '../runtime/projection';
import { Action, Badge, DataDetails, Empty, Field, QueryState } from '../components/workbench';
import { useI18n } from '../i18n';

export function Conversations({ selectedId, select }: { selectedId?: string; select: (id: string) => void }) {
  const { t } = useI18n();
  const { run, connection } = useWorkspace();
  const list = useResource<RecordData[]>('conversations.list');
  const id = selectedId ? Number(selectedId) : null;
  return <>
    <div className="page-heading"><div><p className="eyebrow">{t('PERSISTENT CONVERSATIONS')}</p><h1>{t('Conversation workspace')}</h1><p className="muted">{t('Reconnect to the same native session. Reopening never sends a message.')}</p></div><Action primary actionKey="conversation-create" onClick={() => { void run('conversation-create', () => rpc<{ id: number }>('conversations.create', {}), 'Conversation created').then(value => { if (value) select(String(value.id)); }); }}><Plus size={16} /> {t('New conversation')}</Action></div>
    <div className="conversation-grid"><section className="panel"><div className="panel-heading"><h2>{t('Sessions')}</h2><Badge value={connection} /></div><QueryState resource={list} />
      <div className="work-list">{(list.data ?? []).map(record => <button key={record.id} className={`work-item ${id === record.id ? 'selected' : ''}`} aria-pressed={id === record.id} onClick={() => select(String(record.id))}><MessageSquare size={16} /><span><strong>{record.title ?? record.name ?? t('Conversation {id}', { id: record.id })}</strong><small>{t('Native session #{id}', { id: record.id })}</small></span></button>)}</div>
      {list.data?.length === 0 && <Empty title="No conversations yet">{t('Create a persistent session. Offline notes work without a model provider.')}</Empty>}
    </section>{id === null ? <section className="panel"><Empty title="Select or create a conversation">{t('Your messages, notes and inbox are stored by the runtime, not this browser.')}</Empty></section> : <Conversation key={id} id={id} />}</div>
  </>;
}
function Conversation({ id }: { id: number }) {
  const { t, formatNumber } = useI18n();
  const { run, agentEvents } = useWorkspace();
  const view = useResource<RecordData>('conversations.get', { id });
  const models = useResource<ModelCatalog>('models.list');
  const [content, setContent] = useState(''); const [mode, setMode] = useState('note'); const [whenBusy, setWhenBusy] = useState('followUp');
  const inbox = view.data?.inbox ?? view.data?.docs?.['pi.inbox'] ?? [];
  const inboxItems: RecordData[] = Array.isArray(inbox) ? inbox : inbox.items ?? inbox.pending ?? inbox.submissions ?? [];
  const agent = view.data?.agent ?? view.data?.docs?.['pi.agent'];
  const usage = view.data?.usage ?? view.data?.docs?.['pi.usage'];
  const entries: RecordData[] = view.data?.entries ?? [];
  const [submission, setSubmission] = useState<RecordData | null>(null);
  const chosenModel = agent?.model ?? view.data?.model ?? models.data?.selected;
  const modelReady = Boolean(chosenModel && models.data?.providers.some(p => p.id === chosenModel.provider && p.configured));
  return <section className="panel conversation-detail stack" aria-label={t('Conversation {id}', { id })}><div className="panel-heading"><h2>{t('Session #{id}', { id })}</h2><Action danger actionKey={`conversation-abort-${id}`} disabled={!view.data} onClick={() => { void run(`conversation-abort-${id}`, () => rpc('conversations.abort', { id }), 'Native conversation cancellation requested'); }}>{t('Cancel active turn')}</Action></div>
    <QueryState resource={view} />
    <QueryState resource={models} />
    {models.data && !modelReady && <p className="inline-hint">{t(models.data.providers.some(p => p.configured) ? 'No usable model is selected for this session. Choose a configured model, or save an offline note.' : 'Model service is not configured. Save an offline note below, or configure a provider in Models to send agent input.')}</p>}
    <div className="transcript" aria-label={t('Conversation entries')} aria-live="polite">{entries.map((entry, index) => <article className="message enter" key={entry.id ?? entry.sequence ?? index}><div className="message-meta"><Badge value={entry.kind ?? entry.entry?.kind ?? entry.role ?? entry.message?.role ?? 'entry'} /><code>{entry.id ?? entry.sequence ?? index + 1}</code></div><div className="prose-text">{entryText(entry)}</div>{entry.usage && <DataDetails title="Entry usage" data={entry.usage} />}</article>)}{view.data && !entries.length && <Empty title="This session is ready">{t('Add an offline note, or send an input to a configured model.')}</Empty>}</div>
    <form className="composer stack" onSubmit={e => {
      e.preventDefault(); const unique = requestId(); const draft = mode === 'note' ? { type: 'write', requestId: unique, entry: { kind: 'inkos.note', data: { text: content } } } : { type: 'input', content, requestId: unique, whenBusy };
      void run(`submit-${id}`, () => rpc<RecordData>('conversations.submit', { id, draft }), mode === 'note' ? 'Offline note persisted' : 'Native submission accepted').then(value => { if (value) { setSubmission(value); setContent(''); } });
    }}><div className="form-grid"><Field label="Message type"><select value={mode} onChange={e => setMode(e.target.value)}><option value="note">{t('Offline note (no model call)')}</option><option value="input">{t('Agent input')}</option></select></Field><Field label="When the agent is busy"><select value={whenBusy} disabled={mode === 'note'} onChange={e => setWhenBusy(e.target.value)}><option value="followUp">{t('Follow-up · queue for next turn')}</option><option value="steer">{t('Steer · guide the active turn')}</option><option value="reject">{t('Reject if busy')}</option></select></Field></div><Field label={mode === 'note' ? 'Offline note' : 'Agent input'}><textarea rows={4} value={content} onChange={e => setContent(e.target.value)} placeholder={t(mode === 'note' ? 'Save research, intent or a decision to this session…' : 'Send an instruction to the native agent…')} /></Field><div className="actions"><span className="muted small">{t('One request ID per action. No automatic resend on reconnect.')}</span><Action primary type="submit" actionKey={`submit-${id}`} disabled={!content.trim() || !view.data || (mode === 'input' && !modelReady)}><Send size={15} />{t(mode === 'note' ? 'Save note' : 'Send input')}</Action></div></form>
    {submission && <DataDetails title="Last native submission receipt" data={submission} />}
    {agentEvents !== null && <DataDetails title="Latest native agent activity (live projection)" data={agentEvents} />}
    <details><summary>{t('Session configuration & usage')}</summary><form className="stack" onSubmit={e => { e.preventDefault(); const form = new FormData(e.currentTarget); void run(`configure-${id}`, () => rpc('conversations.configure', { id, changes: { instructions: String(form.get('instructions')), model: form.get('sessionModel') ? JSON.parse(String(form.get('sessionModel'))) : null } }), 'Conversation configuration saved'); }}><Field label="Session model" hint="No override follows the runtime’s selected model"><select name="sessionModel" key={JSON.stringify(agent?.model)} defaultValue={agent?.model ? JSON.stringify(agent.model) : ''}><option value="">{t('Follow runtime model (no override)')}</option>{(models.data?.models ?? []).filter(model => models.data?.providers.some(p => p.id === model.provider && p.configured)).map(model => { const reference = { provider: model.provider, modelId: model.id ?? model.modelId }; return <option key={JSON.stringify(reference)} value={JSON.stringify(reference)}>{reference.provider} / {model.name ?? reference.modelId}</option>; })}</select></Field><Field label="Session instructions"><textarea name="instructions" rows={3} defaultValue={view.data?.instructions ?? agent?.instructions ?? ''} /></Field><Action type="submit" actionKey={`configure-${id}`}>{t('Save configuration')}</Action></form><DataDetails title="Model, agent & usage" data={{ model: view.data?.model ?? agent?.model, agent, usage }} /><DataDetails title="Complete native session view" data={view.data} /></details>
    <details><summary>{t('Native inbox ({count})', { count: formatNumber(inboxItems.length) })}</summary><div className="stack">{inboxItems.map((item, i) => <div key={item.id ?? i}><DataDetails title={t('Submission {id}', { id: item.id ?? i + 1 })} data={item} /><Action danger actionKey={`submission-abort-${item.id}`} disabled={!item.id} onClick={() => { void run(`submission-abort-${item.id}`, () => rpc('submissions.abort', { id: item.id }), 'Native submission cancellation requested'); }}>{t('Cancel submission')}</Action></div>)}<DataDetails title="Complete inbox" data={inbox} /></div></details>
  </section>;
}
