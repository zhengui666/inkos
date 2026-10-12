import { useEffect, useState } from 'react';
import { BookOpen, KeyRound, Puzzle, Moon, Sun, RefreshCw, Languages } from 'lucide-react';
import { InkosLogo } from './components/InkosLogo';
import { Action, Badge } from './components/workbench';
import { useTheme } from './hooks/use-theme';
import { Workspace, useActions, useRuntime } from './runtime/hooks';
import { needsAttention, taskStatus } from './runtime/projection';
import { Works } from './pages/Works';
import { Models } from './pages/Models';
import { Plugins } from './pages/Plugins';
import { useI18n, type Locale } from './i18n';

const pages = [
  { id: 'works', label: 'Works & revisions', icon: BookOpen },
  { id: 'models', label: 'Model configuration', icon: KeyRound },
  { id: 'plugins', label: 'Extensions', icon: Puzzle },
] as const;
type Page = typeof pages[number]['id'];

function readRoute(): { page: Page; id?: string } {
  const [page, encodedId] = location.hash.slice(1).split('/');
  const destination = pages.find(value => value.id === page);
  if (!destination) return { page: 'works' };
  // A legacy destination is only a view fallback; it never replays an action.
  try {
    return { page: destination.id, id: encodedId && destination.id !== 'plugins' ? decodeURIComponent(encodedId) : undefined };
  } catch {
    return { page: destination.id };
  }
}

export function App() {
  const [route, setRoute] = useState(readRoute);
  const { locale, setLocale, t, formatNumber } = useI18n();
  const runtime = useRuntime();
  const actions = useActions(runtime.invalidate);
  const { theme, setTheme } = useTheme();
  useEffect(() => {
    const onHash = () => setRoute(readRoute());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  useEffect(() => { document.documentElement.classList.toggle('dark', theme === 'dark'); }, [theme]);

  const navigate = (page: Page, id?: string) => { location.hash = `${page}${id ? `/${encodeURIComponent(id)}` : ''}`; };
  const projectName = runtime.status?.rootDir.split('/').filter(Boolean).pop() ?? t('Project runtime');
  const runningTasks = runtime.status?.tasks.filter(task => taskStatus(task) === 'running').length ?? 0;
  const attention = runtime.status?.distributions.filter(needsAttention).length ?? 0;
  const currentPage = pages.find(page => page.id === route.page)!;

  return <Workspace.Provider value={{ ...runtime, run: actions.run, busy: actions.busy }}>
    <a href="#main-content" className="skip-link" onClick={event => {
      event.preventDefault(); document.getElementById('main-content')?.focus();
    }}>{t('Skip to workspace')}</a>
    <div className="studio-shell">
      <aside className="studio-sidebar">
        <a href="#works" className="brand"><InkosLogo className="brand-logo" /><span><strong>InkOS</strong><small>STUDIO</small></span></a>
        <div className="sidebar-project">
          <p className="eyebrow">{t('WORKSPACE')}</p>
          <strong>{projectName}</strong>
          <span className="muted small">{t('One project · one runtime')}</span>
        </div>
        <nav aria-label={t('Studio navigation')}>
          {pages.map(({ id, label, icon: Icon }) => <a href={`#${id}`} key={id} className={route.page === id ? 'active' : ''} aria-current={route.page === id ? 'page' : undefined}>
            <Icon size={18} aria-hidden="true" /><span>{t(label)}</span>
          </a>)}
        </nav>
        <div className="sidebar-footer">
          {runtime.status && <dl className="runtime-summary" aria-label={t('Runtime status')}>
            <div><dt>{t('Running tasks')}</dt><dd>{formatNumber(runningTasks)}</dd></div>
            <div><dt>{t('Needs your attention')}</dt><dd className={attention > 0 ? 'runtime-attention' : undefined}>{formatNumber(attention)}</dd></div>
          </dl>}
          <p>{t('Closing Studio disconnects this view.')}<br />{t('Native work stays with the runtime.')}</p>
          {runtime.status && <code>PID {runtime.status.pid}</code>}
        </div>
      </aside>
      <div className="studio-content">
        <header className="studio-header">
          <div className="studio-breadcrumb"><span className="muted">{t('Workspace')}</span><span className="breadcrumb-slash" aria-hidden="true">/</span><strong>{t(currentPage.label)}</strong></div>
          <div className="header-actions">
            <Badge value={runtime.connection} />
            <label className="language-switcher" title={t('Interface language')}>
              <Languages size={16} aria-hidden="true" />
              <select aria-label={t('Interface language')} value={locale} onChange={event => setLocale(event.target.value as Locale)}>
                <option value="zh-CN" lang="zh-CN">中文</option><option value="en" lang="en">English</option>
              </select>
            </label>
            <Action onClick={runtime.invalidate}><RefreshCw size={15} aria-hidden="true" />{t('Refresh')}</Action>
            <button type="button" className="theme-button" aria-label={t(theme === 'dark' ? 'Use light theme' : 'Use dark theme')} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
              {theme === 'dark' ? <Sun size={18} aria-hidden="true" /> : <Moon size={18} aria-hidden="true" />}
            </button>
          </div>
        </header>
        <main id="main-content" tabIndex={-1} className="workspace-main">
          {runtime.error && <div className="notice error" role="alert">
            <span><strong>{t('Runtime unavailable.')}</strong> {t(runtime.error)}{runtime.status && ` ${t('Showing the last read projection.')}`}</span>
            <Action onClick={runtime.invalidate}>{t('Retry connection')}</Action>
          </div>}
          {actions.notice && <div className={`notice ${actions.notice.error ? 'error' : 'success'}`} role={actions.notice.error ? 'alert' : 'status'}>
            <span>{t(actions.notice.text)}{actions.notice.error && ` — ${t('Read the latest state before retrying.')}`}</span>
            <button type="button" onClick={actions.dismiss} aria-label={t('Dismiss notification')}>×</button>
          </div>}
          {!runtime.status && !runtime.error && <section className="panel"><p role="status" className="muted">{t('Connecting to the project runtime…')}</p></section>}
          {runtime.status && <div key={route.page} className="page-content enter">
            {route.page === 'works' && <Works selectedId={route.id} select={id => navigate('works', id)} />}
            {route.page === 'models' && <Models loginId={route.id} selectLogin={id => navigate('models', id)} />}
            {route.page === 'plugins' && <Plugins />}
          </div>}
        </main>
      </div>
    </div>
  </Workspace.Provider>;
}
