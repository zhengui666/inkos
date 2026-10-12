import { useEffect, useState } from 'react';
import { BookOpen, GitBranch, MessageSquare, Radio, Inbox, KeyRound, Puzzle, Library, Moon, Sun, RefreshCw } from 'lucide-react';
import { InkosLogo } from './components/InkosLogo';
import { Action, Badge } from './components/workbench';
import { useTheme } from './hooks/use-theme';
import { Workspace, useActions, useRuntime } from './runtime/hooks';
import { needsAttention, terminalTask } from './runtime/projection';
import { Works } from './pages/Works';
import { Tasks } from './pages/Tasks';
import { Conversations } from './pages/Conversations';
import { Publishing } from './pages/Publishing';
import { Models } from './pages/Models';
import { Plugins } from './pages/Plugins';
import { Materials } from './pages/Materials';

const pages = [
  { id: 'works', label: 'Works & revisions', icon: BookOpen },
  { id: 'tasks', label: 'Task tree', icon: GitBranch },
  { id: 'conversations', label: 'Conversations', icon: MessageSquare },
  { id: 'publishing', label: 'Publishing', icon: Radio },
  { id: 'attention', label: 'User actions', icon: Inbox },
  { id: 'materials', label: 'Materials', icon: Library },
  { id: 'models', label: 'Models', icon: KeyRound },
  { id: 'plugins', label: 'Extensions', icon: Puzzle },
];
function readRoute() {
  const [page, id] = location.hash.slice(1).split('/');
  return { page: pages.some(value => value.id === page) ? page : 'works', id: id ? decodeURIComponent(id) : undefined };
}
export function App() {
  const [route, setRoute] = useState(readRoute);
  const runtime = useRuntime(route.page === 'conversations' && route.id ? Number(route.id) : undefined);
  const actions = useActions(runtime.invalidate);
  const { theme, setTheme } = useTheme();
  useEffect(() => { const onHash = () => setRoute(readRoute()); window.addEventListener('hashchange', onHash); return () => window.removeEventListener('hashchange', onHash); }, []);
  useEffect(() => { document.documentElement.classList.toggle('dark', theme === 'dark'); }, [theme]);
  const navigate = (page: string, id?: string) => { location.hash = `${page}${id ? `/${encodeURIComponent(id)}` : ''}`; };
  const projectName = runtime.status?.rootDir.split('/').filter(Boolean).pop() ?? 'Project runtime';
  const activeTasks = runtime.status?.tasks.filter(task => !terminalTask(task)).length ?? 0;
  const attention = runtime.status?.distributions.filter(needsAttention).length ?? 0;
  return <Workspace.Provider value={{ ...runtime, run: actions.run, busy: actions.busy }}><a href="#main-content" className="skip-link" onClick={e => { e.preventDefault(); document.getElementById('main-content')?.focus(); }}>Skip to workspace</a><div className="studio-shell">
    <aside className="studio-sidebar"><a href="#works" className="brand"><InkosLogo className="brand-logo" /><span><strong>InkOS</strong><small>STUDIO</small></span></a><div className="sidebar-project"><p className="eyebrow">WORKSPACE</p><strong>{projectName}</strong><span className="muted small">One project · one runtime</span></div>
      <nav aria-label="Studio navigation">{pages.map(({ id, label, icon: Icon }) => <a href={`#${id}`} key={id} className={route.page === id ? 'active' : ''} aria-current={route.page === id ? 'page' : undefined}><Icon size={18} /><span>{label}</span>{id === 'tasks' && activeTasks > 0 && <span className="nav-count">{activeTasks}</span>}{id === 'attention' && attention > 0 && <span className="nav-count">{attention}</span>}</a>)}</nav>
      <div className="sidebar-footer"><Badge value={runtime.connection} /><p>Closing Studio disconnects this view.<br />Native work stays with the runtime.</p>{runtime.status && <code>PID {runtime.status.pid}</code>}</div>
    </aside>
    <div className="studio-content"><header className="studio-header"><div><span className="muted">Workspace</span><span className="breadcrumb-slash">/</span><strong>{pages.find(p => p.id === route.page)?.label}</strong></div><div className="header-actions"><Badge value={runtime.connection} /><Action onClick={runtime.invalidate}><RefreshCw size={15} /> Refresh</Action><button className="theme-button" aria-label={theme === 'dark' ? 'Use light theme' : 'Use dark theme'} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}</button></div></header>
      <main id="main-content" tabIndex={-1} className="workspace-main">
        {runtime.error && <div className="notice error" role="alert"><span><strong>Runtime unavailable.</strong> {runtime.error}{runtime.status && ' Showing the last read projection.'}</span><Action onClick={runtime.invalidate}>Retry connection</Action></div>}
        {actions.notice && <div className={`notice ${actions.notice.error ? 'error' : 'success'}`} role={actions.notice.error ? 'alert' : 'status'}><span>{actions.notice.text}</span><button onClick={actions.dismiss} aria-label="Dismiss notification">×</button></div>}
        {!runtime.status && !runtime.error && <section className="panel"><p role="status" className="muted">Connecting to the project runtime…</p></section>}
        {runtime.status && <div key={route.page} className="page-content enter">
          {route.page === 'works' && <Works selectedId={route.id} select={id => navigate('works', id)} />}
          {route.page === 'tasks' && <Tasks />}
          {route.page === 'conversations' && <Conversations selectedId={route.id} select={id => navigate('conversations', id)} />}
          {route.page === 'publishing' && <Publishing />}
          {route.page === 'attention' && <Publishing attentionOnly />}
          {route.page === 'models' && <Models loginId={route.id} selectLogin={id => navigate('models', id)} />}
          {route.page === 'plugins' && <Plugins />}
          {route.page === 'materials' && <Materials />}
        </div>}
      </main>
    </div>
  </div></Workspace.Provider>;
}
