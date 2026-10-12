import { useEffect, useRef, useState } from 'react';
import { KeyRound, LogOut, Search } from 'lucide-react';
import { rpc } from '../runtime/api';
import { useResource, useWorkspace } from '../runtime/hooks';
import type { ModelCatalog, RecordData } from '../runtime/types';
import { label } from '../runtime/projection';
import { Action, Badge, DataDetails, Empty, Field, QueryState } from '../components/workbench';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../components/ui/dialog';
import { useI18n } from '../i18n';

type ProviderFilter = 'all' | 'configured' | 'unconfigured';
const modelIdentity = (model: RecordData) => String(model.id ?? model.modelId ?? '');

export function Models({ loginId, selectLogin }: { loginId?: string; selectLogin: (id: string) => void }) {
  const { t, formatNumber } = useI18n();
  const { run, busy } = useWorkspace();
  const catalog = useResource<ModelCatalog>('models.list');
  const [provider, setProvider] = useState('');
  const [modelId, setModelId] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<ProviderFilter>('all');
  const pickerEdited = useRef(false);
  const providers = catalog.data?.providers ?? [];
  const configuredProviders = providers.filter(value => value.configured);
  const selected = catalog.data?.selected;
  const selectedModelId = selected?.modelId ?? selected?.id ?? '';
  const selectedProvider = providers.find(value => value.id === provider);
  const choices = (catalog.data?.models ?? []).filter(model => provider && (model.provider === provider || model.providerId === provider));
  const modelInCatalog = choices.some(model => modelIdentity(model) === modelId);
  const settingModel = busy.has('model-set');
  const search = query.trim().toLowerCase();
  const visibleProviders = providers.filter(value => {
    const matchesSearch = `${value.name} ${value.id}`.toLowerCase().includes(search);
    return matchesSearch && (filter === 'all' || (filter === 'configured' ? value.configured : !value.configured));
  }).sort((a, b) => Number(b.configured) - Number(a.configured));

  useEffect(() => {
    // Runtime refreshes update a pristine picker, never an in-progress choice.
    if (!pickerEdited.current) { setProvider(selected?.provider ?? ''); setModelId(selectedModelId); }
  }, [selected?.provider, selectedModelId]);

  const chooseProvider = (id: string) => {
    pickerEdited.current = true;
    setProvider(id);
    if (id !== provider) setModelId('');
  };
  const connected = (providerId: string) => {
    pickerEdited.current = true;
    setProvider(providerId); setModelId('');
    catalog.refresh(); selectLogin('');
  };
  const clearFilters = () => { setQuery(''); setFilter('all'); };

  return <>
    <div className="page-heading">
      <div><p className="eyebrow">{t('OFFICIAL MODEL SERVICE')}</p><h1>{t('Model configuration')}</h1><p className="muted">{t('Connect a provider, then choose a model. Credentials stay with the runtime.')}</p></div>
      {catalog.data && <span className="count">{t('{count} configured providers', { count: formatNumber(configuredProviders.length) })}</span>}
    </div>
    <QueryState resource={catalog} />
    {catalog.data && <>
      {!configuredProviders.length && <div className="notice attention">
        <KeyRound size={18} aria-hidden="true" /><span><strong>{t('Model service is not configured.')}</strong>{' '}{t('You can still create works and edit drafts. Connect a provider to enable AI creation.')}</span>
      </div>}
      <div className="model-overview">
        <section className="panel stack model-picker">
          <h2>{t('Selected model')}</h2>
          <div className={`current-model ${selected ? 'has-selection' : ''}`}>
            <KeyRound size={20} aria-hidden="true" />
            {selected ? <div className="current-model-value"><strong>{providers.find(value => value.id === selected.provider)?.name ?? selected.provider}</strong><code>{selected.provider} / {selectedModelId}</code></div>
              : <p className="muted">{t('No model selected.')}</p>}
            {selected && <Badge value="selected" />}
          </div>
          <form className="stack" onSubmit={event => {
            event.preventDefault();
            if (!selectedProvider?.configured || !modelInCatalog || settingModel) return;
            void run('model-set', async () => {
              const result = await rpc('models.set', { provider, modelId });
              pickerEdited.current = false; catalog.refresh();
              return result;
            }, 'Model selected');
          }}>
            <div className="form-grid">
              <Field label="Model provider"><select required value={provider} disabled={settingModel} onChange={event => chooseProvider(event.target.value)}>
                <option value="">{t('Choose a configured provider')}</option>
                {provider && !selectedProvider && <option value={provider} disabled>{t('{provider} · unavailable', { provider })}</option>}
                {providers.map(value => <option key={value.id} value={value.id} disabled={!value.configured}>{value.configured ? value.name : t('{provider} · unconfigured', { provider: value.name })}</option>)}
              </select></Field>
              <Field label="Available model"><select required value={modelId} onChange={event => { pickerEdited.current = true; setModelId(event.target.value); }} disabled={!selectedProvider?.configured || settingModel}>
                <option value="">{t('Choose a model')}</option>
                {modelId && !modelInCatalog && <option value={modelId} disabled>{t('{model} · not in catalog', { model: modelId })}</option>}
                {choices.map(model => <option key={`${provider}/${modelIdentity(model)}`} value={modelIdentity(model)}>{model.name ?? modelIdentity(model)}</option>)}
              </select></Field>
            </div>
            <div className="actions">
              <Action primary type="submit" actionKey="model-set" disabled={!selectedProvider?.configured || !modelId || !modelInCatalog}>{t('Use model')}</Action>
              {provider && selectedProvider?.configured && !choices.length && <p className="muted small">{t('No available models returned for this provider.')}</p>}
            </div>
          </form>
          <DataDetails title="Official model capabilities" data={choices} />
        </section>
        <section className="panel stack configured-providers">
          <div className="panel-heading"><h2>{t('Configured providers')}</h2><span className="count">{formatNumber(configuredProviders.length)}</span></div>
          {configuredProviders.length > 0 ? <>
            <p className="muted small">{t('Choose a provider to update the model picker.')}</p>
            <div className="configured-provider-list">
              {configuredProviders.map(value => <button type="button" className="configured-provider-choice" key={value.id} aria-pressed={provider === value.id} disabled={settingModel || busy.has(`logout-${value.id}`)} onClick={() => chooseProvider(value.id)}>
                <span><strong>{value.name}</strong><code>{value.id}</code></span><KeyRound size={15} aria-hidden="true" />
              </button>)}
            </div>
          </> : <p className="muted small">{t('Connect a provider below to choose a model.')}</p>}
          {catalog.loading && <p className="muted small" role="status">{t('Refreshing catalog…')}</p>}
        </section>
      </div>
      <section className="panel stack provider-directory" aria-labelledby="provider-directory-heading">
        <div className="panel-heading"><h2 id="provider-directory-heading">{t('Provider directory')}</h2><span className="muted small" role="status">{t('{shown} of {total} providers', { shown: formatNumber(visibleProviders.length), total: formatNumber(providers.length) })}</span></div>
        <div className="provider-toolbar">
          <div className="provider-search"><Search size={16} aria-hidden="true" /><input type="search" aria-label={t('Search providers')} placeholder={t('Search by name or ID…')} value={query} onChange={event => setQuery(event.target.value)} /></div>
          <div className="provider-filters" role="group" aria-label={t('Provider filter')}>
            {([{ id: 'all', label: 'All providers' }, { id: 'configured', label: 'Configured' }, { id: 'unconfigured', label: 'Not configured' }] as const).map(value => <button type="button" key={value.id} aria-pressed={filter === value.id} onClick={() => setFilter(value.id)}>{t(value.label)}</button>)}
          </div>
          {(query || filter !== 'all') && <button type="button" className="filter-reset" onClick={clearFilters}>{t('Clear filters')}</button>}
        </div>
        <div className="provider-grid" aria-busy={catalog.loading}>
          {visibleProviders.map((value, index) => <article className="provider enter" key={value.id} style={{ animationDelay: `${Math.min(index, 5) * 24}ms` }}>
            <div className="panel-heading"><div><h3>{value.name}</h3><code>{value.id}</code></div><Badge value={value.configured ? 'configured' : 'unconfigured'} /></div>
            <div className="actions">
              {value.authTypes.map(type => <Action key={type} actionKey={`login-${value.id}`} disabled={busy.has(`logout-${value.id}`)} onClick={() => {
                void run(`login-${value.id}`, () => rpc<{ id: string }>('login.start', { providerId: value.id, type }), 'Authentication started').then(result => { if (result) selectLogin(String(result.id)); });
              }}>{type === 'api_key' ? t('Connect API key') : type === 'oauth' ? t('Connect OAuth') : t(type)}</Action>)}
              {value.configured && <Action danger actionKey={`logout-${value.id}`} disabled={busy.has(`login-${value.id}`)} onClick={() => {
                void run(`logout-${value.id}`, () => rpc('logout', { providerId: value.id }), 'Provider logged out').then(result => { if (result !== undefined) catalog.refresh(); });
              }}><LogOut size={14} aria-hidden="true" />{t('Logout')}</Action>}
            </div>
            {!value.authTypes.length && <p className="muted small">{t('This provider uses environment or SDK-managed credentials.')}</p>}
          </article>)}
        </div>
        {!providers.length && <Empty title="No providers registered">{t('Provider integrations are supplied by the official model service and extensions.')}</Empty>}
        {providers.length > 0 && !visibleProviders.length && <Empty title="No matching providers">{t('Try another name or ID, or clear the filters.')}</Empty>}
      </section>
    </>}
    {loginId && <Login key={loginId} id={loginId} providers={providers} onComplete={connected} onClose={() => selectLogin('')} />}
  </>;
}

function Login({ id, providers, onComplete, onClose }: {
  id: string; providers: ModelCatalog['providers']; onComplete: (providerId: string) => void; onClose: () => void;
}) {
  const { t } = useI18n();
  const { run, busy } = useWorkspace();
  const session = useResource<RecordData>('login.status', { id });
  const [value, setValue] = useState('');
  const completed = useRef(false);
  const state = session.data?.status;
  const terminal = ['done', 'failed', 'cancelled'].includes(state ?? '');
  const cancelling = busy.has(`login-cancel-${id}`);
  const responding = busy.has(`login-respond-${id}`);
  useEffect(() => {
    if (terminal || session.error) return;
    const timer = setInterval(session.refresh, 500); return () => clearInterval(timer);
  }, [id, state, session.error]);
  useEffect(() => {
    if (state === 'done' && !completed.current) { completed.current = true; onComplete(session.data!.providerId); }
  }, [state, session.data?.providerId, onComplete]);
  const close = () => {
    if (cancelling) return;
    if (!terminal) {
      void run(`login-cancel-${id}`, () => rpc<RecordData>('login.cancel', { id }), 'Authentication cancelled').then(result => { if (result !== undefined) onClose(); });
    } else onClose();
  };
  const prompt = session.data?.prompt;
  const providerName = providers.find(provider => provider.id === session.data?.providerId)?.name ?? session.data?.providerId ?? '';
  const events = session.data?.events ?? [];
  return <Dialog open onOpenChange={open => { if (!open) close(); }}>
    <DialogContent className="auth-dialog stack" showCloseButton={false} aria-label={t('Provider authentication')}>
      <div className="panel-heading"><div><DialogTitle>{t('Provider authentication')}</DialogTitle>{providerName && <p className="muted small">{providerName}</p>}</div>{state && <Badge value={state} />}</div>
      <DialogDescription>{t('Credentials stay with the runtime. After connecting, select a model to use.')}</DialogDescription>
      <QueryState resource={session} />
      {session.data?.error && state !== 'cancelled' && <p role="alert" className="error-text">{t(session.data.error)}</p>}
      {events.length > 0 && <ul className="auth-events">{events.map((event: RecordData, index: number) => <li key={index}>
        {event.type === 'auth_url' ? <><p>{t(event.instructions ?? 'Follow the provider’s authentication instructions.')}</p><a href={event.url} target="_blank" rel="noreferrer" className="external-link">{t('Open provider authentication ↗')}</a></>
          : event.type === 'device_code' ? <><p>{t('Device code: {code}', { code: event.userCode })}</p><a href={event.verificationUri} target="_blank" rel="noreferrer" className="external-link">{t('Open provider authentication ↗')}</a></>
          : <>{t(event.message ?? event.instructions ?? label(event))}{(event.links ?? []).map((link: RecordData) => <a className="external-link" href={link.url} key={link.url} target="_blank" rel="noreferrer"> {t(link.label ?? link.url)} ↗</a>)}</>}
      </li>)}</ul>}
      {prompt && state === 'running' && <form className="stack" onSubmit={event => {
        event.preventDefault();
        if (responding || cancelling || !value.trim()) return;
        void run(`login-respond-${id}`, () => rpc('login.respond', { id, value }), 'Authentication response sent').then(result => { if (result !== undefined) setValue(''); });
      }}>
        <p>{t(prompt.message ?? 'Follow the provider’s authentication instructions.')}</p>
        <Field label={prompt.type === 'secret' ? 'Secret authentication value' : prompt.type === 'manual_code' ? 'Authorization callback or code' : 'Authentication response'}>
          {prompt.type === 'select' ? <select autoFocus required value={value} disabled={responding || cancelling} onChange={event => setValue(event.target.value)}>
            <option value="">{t('Choose an option')}</option>{(prompt.options ?? []).map((option: RecordData) => <option key={option.id} value={option.id}>{t(option.label)}{option.description ? ` · ${t(option.description)}` : ''}</option>)}
          </select> : <input autoFocus autoComplete="off" type={prompt.type === 'secret' ? 'password' : 'text'} placeholder={prompt.placeholder ? t(prompt.placeholder) : undefined} value={value} disabled={responding || cancelling} onChange={event => setValue(event.target.value)} required />}
        </Field>
        <Action primary type="submit" actionKey={`login-respond-${id}`} disabled={!value.trim() || cancelling}>{t('Send response')}</Action>
      </form>}
      {!prompt && state === 'running' && <p role="status" className="muted">{t('Waiting for the official authentication flow…')}</p>}
      <DataDetails title="Native authentication prompt & events" data={session.data} />
      <div className="actions auth-dialog-actions"><Action actionKey={`login-cancel-${id}`} onClick={close}>{t(terminal ? 'Close' : 'Cancel authentication')}</Action></div>
    </DialogContent>
  </Dialog>;
}
