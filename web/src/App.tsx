import { useCallback, useEffect, useState } from 'react';
import { api, type Meta, type Server } from './api';
import { Banner, Link, Spinner, useAsync, useRoute } from './lib';
import { LoginPage } from './pages/Login';
import { LogsPage } from './pages/Logs';
import { RunDetailPage } from './pages/RunDetail';
import { RunsPage } from './pages/Runs';
import { SchedulesPage } from './pages/Schedules';
import { ServersPage } from './pages/Servers';
import { SettingsPage } from './pages/Settings';

const NAV = [
  { path: '/', label: 'Servers' },
  { path: '/runs', label: 'Runs' },
  { path: '/schedules', label: 'Schedules' },
  { path: '/logs', label: 'Logs' },
  { path: '/settings', label: 'Settings' },
];

export function App() {
  const [path, navigate] = useRoute();
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [authRequired, setAuthRequired] = useState(false);

  const checkAuth = useCallback(async () => {
    try {
      const status = await api.authStatus();
      setAuthRequired(status.authRequired);
      setAuthed(status.authenticated);
    } catch {
      // If even the status endpoint is unreachable, render the UI and let the
      // individual pages surface the real error rather than a blank screen.
      setAuthed(true);
    }
  }, []);

  useEffect(() => {
    void checkAuth();
  }, [checkAuth]);

  if (authed === null) return <Spinner label="Starting…" />;
  if (!authed) return <LoginPage onSuccess={() => void checkAuth()} />;

  return <Shell path={path} navigate={navigate} authRequired={authRequired} onLogout={checkAuth} />;
}

function Shell({
  path,
  navigate,
  authRequired,
  onLogout,
}: {
  path: string;
  navigate: (path: string) => void;
  authRequired: boolean;
  onLogout: () => void;
}) {
  const meta = useAsync<Meta>(() => api.meta(), []);
  const servers = useAsync<Server[]>(() => api.servers(), []);

  return (
    <div className="app">
      <nav className="sidebar">
        <div className="brand">📚 abs-butler</div>
        {NAV.map((item) => (
          <Link
            key={item.path}
            to={item.path}
            navigate={navigate}
            className={`nav-link ${isActive(path, item.path) ? 'active' : ''}`}
          >
            {item.label}
          </Link>
        ))}
        <div className="sidebar-footer">
          {authRequired && (
            <button
              className="small"
              onClick={async () => {
                await api.logout();
                onLogout();
              }}
            >
              Sign out
            </button>
          )}
          <div style={{ marginTop: 8 }}>v0.2.0</div>
        </div>
      </nav>

      <main className="main">
        {servers.error && <Banner tone="err">{servers.error}</Banner>}
        <Route
          path={path}
          navigate={navigate}
          servers={servers.data ?? []}
          meta={meta.data}
          reloadServers={servers.reload}
        />
      </main>
    </div>
  );
}

function Route({
  path,
  navigate,
  servers,
  meta,
  reloadServers,
}: {
  path: string;
  navigate: (path: string) => void;
  servers: Server[];
  meta: Meta | undefined;
  reloadServers: () => void;
}) {
  const runMatch = /^\/runs\/(\d+)$/.exec(path);
  if (runMatch) return <RunDetailPage runId={Number(runMatch[1])} navigate={navigate} />;

  switch (path) {
    case '/':
      return <ServersPage onChanged={reloadServers} />;
    case '/runs':
      return <RunsPage servers={servers} meta={meta} navigate={navigate} />;
    case '/schedules':
      return <SchedulesPage servers={servers} meta={meta} />;
    case '/logs':
      return <LogsPage navigate={navigate} />;
    case '/settings':
      return <SettingsPage />;
    default:
      return (
        <>
          <h1>Not found</h1>
          <p className="subtitle">
            No page at <span className="mono">{path}</span>.{' '}
            <Link to="/" navigate={navigate}>
              Go to servers
            </Link>
          </p>
        </>
      );
  }
}

function isActive(current: string, target: string): boolean {
  if (target === '/') return current === '/';
  return current === target || current.startsWith(`${target}/`);
}
