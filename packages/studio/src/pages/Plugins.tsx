import { useState } from 'react';
import { Puzzle } from 'lucide-react';
import { rpc } from '../runtime/api';
import { useResource, useWorkspace } from '../runtime/hooks';
import type { RecordData } from '../runtime/types';
import { Action, DataDetails, Descriptions, Empty, Field, QueryState } from '../components/workbench';

export function Plugins() {
  const { run } = useWorkspace();
  const plugins = useResource<RecordData[]>('plugins.list');
  const [modules, setModules] = useState('');
  return <>
    <div className="page-heading"><div><p className="eyebrow">OFFICIAL EXTENSIONS</p><h1>Extensions & capabilities</h1><p className="muted">Tools, native tasks, work profiles and publishers from the project runtime.</p></div><Puzzle size={24} className="muted" /></div>
    <section className="panel"><form className="stack" onSubmit={e => { e.preventDefault(); void run('plugins-configure', () => rpc('plugins.configure', { modules: modules.split('\n').map(value => value.trim()).filter(Boolean) }), 'Extension configuration applied'); }}><h2>Configure extension modules</h2><Field label="Official extension modules" hint="One module name or file path per line. This replaces the external-module list; blank removes external modules."><textarea rows={3} value={modules} onChange={e => setModules(e.target.value)} placeholder="@scope/extension\n/path/to/extension.js" /></Field><Action primary type="submit" actionKey="plugins-configure">Apply modules</Action></form></section>
    <QueryState resource={plugins} />
    <div className="plugin-list">{(plugins.data ?? []).map((plugin, i) => <section className="panel stack enter" key={plugin.name} style={{ animationDelay: `${Math.min(i, 5) * 32}ms` }}><div className="panel-heading"><h2>{plugin.name}</h2><Puzzle size={18} className="muted" /></div><div className="capability-grid"><div><h3>Tools</h3><Descriptions items={plugin.tools} /></div><div><h3>Native tasks</h3><Descriptions items={plugin.tasks} /></div><div><h3>Work profiles</h3><Descriptions items={plugin.profiles} /></div><div><h3>Content publishers</h3><Descriptions items={plugin.publishers} /></div></div><DataDetails title="Complete extension descriptors" data={plugin} /></section>)}</div>
    {plugins.data?.length === 0 && <section className="panel"><Empty title="No extensions loaded">Apply modules above to register tools, tasks, content profiles or publishers. Runtime errors are shown directly.</Empty></section>}
  </>;
}
