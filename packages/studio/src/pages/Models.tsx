import { useEffect, useState } from 'react';
import { KeyRound, LogOut } from 'lucide-react';
import { rpc } from '../runtime/api';
import { useResource, useWorkspace } from '../runtime/hooks';
import type { ModelCatalog, RecordData } from '../runtime/types';
import { label } from '../runtime/projection';
import { Action, Badge, DataDetails, Empty, Field, QueryState } from '../components/workbench';

export function Models({ loginId, selectLogin }: { loginId?: string; selectLogin: (id: string) => void }) {
  const { run } = useWorkspace();
  const catalog = useResource<ModelCatalog>('models.list');
  const [provider, setProvider] = useState(''); const [modelId, setModelId] = useState('');
  const providers = catalog.data?.providers ?? [];
  const selectedProvider = providers.find(p => p.id === provider);
  const choices = (catalog.data?.models ?? []).filter(model => !provider || model.provider === provider || model.providerId === provider);
  return <>
    <div className="page-heading"><div><p className="eyebrow">OFFICIAL MODEL SERVICE</p><h1>Models & authentication</h1><p className="muted">Connect a provider, then choose a model. Credentials stay with the runtime.</p></div><Badge value={providers.some(p => p.configured) ? 'configured' : 'unconfigured'} /></div><QueryState resource={catalog} />
    {catalog.data && !providers.some(p => p.configured) && <div className="notice attention"><KeyRound size={18} /><span><strong>Model service is not configured.</strong> Offline notes, artifact editing and task inspection remain available. Studio will not generate simulated model output.</span></div>}
    <div className="settings-grid"><section className="panel stack"><h2>Providers</h2>{providers.map(p => <article className="provider" key={p.id}><div className="panel-heading"><div><h3>{p.name}</h3><code>{p.id}</code></div><Badge value={p.configured ? 'configured' : 'unconfigured'} /></div><div className="actions">{p.authTypes.map(type => <Action key={type} actionKey={`login-${p.id}`} onClick={() => { void run(`login-${p.id}`, () => rpc<{ id: string }>('login.start', { providerId: p.id, type }), 'Authentication started').then(value => { if (value) selectLogin(String(value.id)); }); }}>{type === 'api_key' ? 'Connect API key' : type === 'oauth' ? 'Connect OAuth' : type}</Action>)}{p.configured && <Action danger actionKey={`logout-${p.id}`} onClick={() => { void run(`logout-${p.id}`, () => rpc('logout', { providerId: p.id }), 'Provider logged out'); }}><LogOut size={14} /> Logout</Action>}</div></article>)}{catalog.data && !providers.length && <Empty title="No providers registered">Provider integrations are supplied by the official model service and extensions.</Empty>}</section>
    <section className="panel stack"><h2>Selected model</h2>{catalog.data?.selected ? <p className="selection-label"><Badge value="selected" /><code>{catalog.data.selected.provider} / {catalog.data.selected.modelId ?? catalog.data.selected.id}</code></p> : <p className="muted">No model selected.</p>}<form className="stack" onSubmit={e => { e.preventDefault(); void run('model-set', () => rpc('models.set', { provider, modelId }), 'Model selected'); }}><Field label="Model provider"><select required value={provider} onChange={e => { setProvider(e.target.value); setModelId(''); }}><option value="">Choose a configured provider</option>{providers.map(p => <option key={p.id} value={p.id} disabled={!p.configured}>{p.name}{!p.configured ? ' · unconfigured' : ''}</option>)}</select></Field><Field label="Available model"><select required value={modelId} onChange={e => setModelId(e.target.value)} disabled={!selectedProvider?.configured}><option value="">Choose a model</option>{choices.map(model => <option key={`${model.provider ?? model.providerId}/${model.id}`} value={model.id ?? model.modelId}>{model.name ?? model.id ?? model.modelId}</option>)}</select></Field><Action primary type="submit" actionKey="model-set" disabled={!selectedProvider?.configured || !modelId}>Use model</Action></form>{provider && !choices.length && <p className="muted small">No available models returned for this provider.</p>}<DataDetails title="Official model capabilities" data={choices} /></section></div>
    {loginId && <Login key={loginId} id={loginId} />}
  </>;
}
function Login({ id }: { id: string }) {
  const { run } = useWorkspace();
  const session = useResource<RecordData>('login.status', { id });
  const [value, setValue] = useState('');
  useEffect(() => {
    if (session.data?.status === 'done' || session.data?.status === 'failed' || session.error) return;
    const timer = setInterval(session.refresh, 1_000); return () => clearInterval(timer);
  }, [id, session.data?.status, session.error]);
  const prompt = session.data?.prompt;
  const url = prompt?.url ?? prompt?.authUrl;
  return <section className="panel stack" aria-label="Provider authentication"><div className="panel-heading"><h2>Authentication</h2><Badge value={session.data?.status ?? 'running'} /></div><QueryState resource={session} />
    {session.data?.error && <p role="alert" className="error-text">{session.data.error}</p>}
    {session.data?.status === 'done' && <p className="success-text">Provider connected. Choose an available model above.</p>}
    {prompt && session.data?.status === 'running' && <form className="stack" onSubmit={e => { e.preventDefault(); void run(`login-respond-${id}`, () => rpc('login.respond', { id, value }), 'Authentication response sent').then(result => { if (result !== undefined) setValue(''); }); }}><p>{prompt.message ?? 'Follow the provider’s authentication instructions.'}</p>{url && <a href={url} target="_blank" rel="noreferrer" className="external-link">Open provider authentication ↗</a>}<Field label={prompt.type === 'secret' ? 'Secret authentication value' : 'Authentication response'}>{prompt.type === 'select' ? <select required value={value} onChange={e => setValue(e.target.value)}><option value="">Choose an option</option>{(prompt.options ?? []).map((option: RecordData) => <option key={option.id} value={option.id}>{option.label}{option.description ? ` · ${option.description}` : ''}</option>)}</select> : <input autoComplete="off" type={prompt.type === 'secret' ? 'password' : 'text'} placeholder={prompt.placeholder} value={value} onChange={e => setValue(e.target.value)} required />}</Field><Action primary type="submit" actionKey={`login-respond-${id}`} disabled={!value.trim()}>Send response</Action></form>}
    {!prompt && session.data?.status === 'running' && <p role="status" className="muted">Waiting for the official authentication flow…</p>}
    <ul className="auth-events">{(session.data?.events ?? []).map((event: RecordData, i: number) => <li key={i}>{event.message ?? event.instructions ?? (event.type === 'device_code' ? `Device code: ${event.userCode}` : label(event))}{(event.url ?? event.verificationUri) && <a className="external-link" href={event.url ?? event.verificationUri} target="_blank" rel="noreferrer"> Open authentication ↗</a>}{(event.links ?? []).map((link: RecordData) => <a className="external-link" href={link.url} key={link.url} target="_blank" rel="noreferrer"> {link.label ?? link.url} ↗</a>)}</li>)}</ul><DataDetails title="Native authentication prompt & events" data={session.data} />
  </section>;
}
