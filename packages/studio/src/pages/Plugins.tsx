import { useState } from 'react';
import { ChevronDown, Puzzle, SlidersHorizontal } from 'lucide-react';
import { rpc } from '../runtime/api';
import { useResource, useWorkspace } from '../runtime/hooks';
import type { RecordData } from '../runtime/types';
import { label } from '../runtime/projection';
import { Action, DataDetails, Empty, Field, QueryState } from '../components/workbench';
import { useI18n } from '../i18n';

export function Plugins() {
  const { t, formatNumber } = useI18n();
  const { run, busy } = useWorkspace();
  const plugins = useResource<RecordData[]>('plugins.list');
  const [modules, setModules] = useState('');
  const configuring = busy.has('plugins-configure');

  return <>
    <div className="page-heading">
      <div><p className="eyebrow">{t('OFFICIAL EXTENSIONS')}</p><h1>{t('Extensions')}</h1><p className="muted">{t('Tools, native tasks, work profiles and publishers from the project runtime.')}</p></div>
    </div>
    <QueryState resource={plugins} />
    <details className="panel extension-config">
      <summary><span className="extension-config-title"><SlidersHorizontal size={18} aria-hidden="true" /><span>{t('Configure extension modules')}</span></span><span className="muted small">{t('Module names or file paths')}</span><ChevronDown className="details-chevron" size={16} aria-hidden="true" /></summary>
      <form className="stack module-form" onSubmit={event => {
        event.preventDefault();
        void run('plugins-configure', () => rpc('plugins.configure', { modules: modules.split('\n').map(value => value.trim()).filter(Boolean) }), 'Extension configuration applied').then(result => { if (result !== undefined) plugins.refresh(); });
      }}>
        <Field label="Official extension modules" hint="One module name or file path per line. This replaces the external-module list; blank removes external modules.">
          <textarea rows={3} value={modules} onChange={event => setModules(event.target.value)} disabled={configuring} placeholder="@scope/extension\n/path/to/extension.js" />
        </Field>
        <div className="actions"><Action primary type="submit" actionKey="plugins-configure">{t('Apply modules')}</Action></div>
      </form>
    </details>
    {plugins.data && <section className="installed-extensions" aria-labelledby="installed-extensions-heading">
      <div className="section-heading"><h2 id="installed-extensions-heading">{t('Installed extensions')}</h2><span className="count">{formatNumber(plugins.data.length)}</span>{plugins.loading && <span role="status" className="muted small">{t('Refreshing extensions…')}</span>}</div>
      <div className="plugin-list" aria-busy={plugins.loading}>
        {plugins.data.map((plugin, index) => <section className="panel stack extension-card enter" key={plugin.name} aria-label={plugin.name} style={{ animationDelay: `${Math.min(index, 5) * 32}ms` }}>
          <div className="extension-card-heading"><span className="extension-icon"><Puzzle size={20} aria-hidden="true" /></span><h2>{plugin.name}</h2></div>
          <div className="capability-grid">
            <CapabilitySection title="Tools" items={plugin.tools} />
            <CapabilitySection title="Native tasks" items={plugin.tasks} />
            <CapabilitySection title="Work profiles" items={plugin.profiles} />
            <CapabilitySection title="Content publishers" items={plugin.publishers} />
            {Array.isArray(plugin.rankingSources) && <CapabilitySection title="Ranking sources" items={plugin.rankingSources} />}
          </div>
          <DataDetails title="Complete extension descriptors" data={plugin} />
        </section>)}
      </div>
      {plugins.data.length === 0 && <section className="panel"><Empty title="No extensions loaded">{t('Use Configure extension modules to register tools, tasks, work profiles or publishers. Runtime errors are shown directly.')}</Empty></section>}
    </section>}
  </>;
}

function CapabilitySection({ title, items }: { title: string; items: unknown[] | Record<string, unknown> | undefined }) {
  const { t, formatNumber } = useI18n();
  const values = Array.isArray(items) ? items : Object.values(items ?? {});
  return <section className="capability-section" aria-label={t(title)}>
    <h3>{t(title)}<span className="capability-count">{formatNumber(values.length)}</span></h3>
    {values.length ? <ul className="capability-list">{values.map((item, index) => {
      const descriptor = typeof item === 'object' && item !== null ? item as RecordData : null;
      return <li key={descriptor?.id ?? index} className={`capability-item ${descriptor ? 'has-descriptor' : ''}`}>
        {descriptor ? <>
          <div className="capability-identity"><strong>{t(label(descriptor))}</strong>{descriptor.id && <code>{descriptor.id}</code>}</div>
          {descriptor.description && <details className="capability-copy"><summary>{t('Description')}</summary><p className="prose-text">{t(descriptor.description)}</p></details>}
          {descriptor.instructions && <details className="capability-copy"><summary>{t('Model instructions')}</summary><p className="prose-text">{t(descriptor.instructions)}</p></details>}
          {descriptor.capabilities?.length > 0 && <ul className="capability-tags" aria-label={t('Declared capabilities')}>{descriptor.capabilities.map((value: string) => <li key={value}>{t(value)}</li>)}</ul>}
        </> : <code>{String(item)}</code>}
      </li>;
    })}</ul> : <p className="muted small">{t('None registered')}</p>}
  </section>;
}
