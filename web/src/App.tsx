import { useCallback, useEffect, useState } from 'react';
import { api, type AuthStatus, type Connection, type Meta, type UpdateStatus } from './api';
import { Banner, Link, Spinner, useAsync, useRoute } from './lib';
import { ConnectionPage } from './pages/Connection';
import { LoginPage } from './pages/Login';
import { LogsPage } from './pages/Logs';
import { RunDetailPage } from './pages/RunDetail';
import { RunsPage } from './pages/Runs';
import { SchedulesPage } from './pages/Schedules';
import { SettingsPage } from './pages/Settings';
import { SetupPage } from './pages/Setup';

const NAV = [
  { path: '/', label: 'Runs' },
  { path: '/schedules', label: 'Schedules' },
  { path: '/logs', label: 'Logs' },
  { path: '/connection', label: 'Connection' },
  { path: '/settings', label: 'Settings' },
];

export function App() {
  const [path, navigate] = useRoute();
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const check = useCallback(async () => {
    try {
      setStatus(await api.authStatus());
      setFailed(null);
    } catch (err) {
      setFailed((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  if (failed) {
    return (
      <div className="login-wrap">
        <div className="card login-card">
          <h2>📚 abs-butler</h2>
          <Banner tone="err">Could not reach the server: {failed}</Banner>
        </div>
      </div>
    );
  }
  if (!status) return <Spinner label="Starting…" />;

  if (!status.configured) {
    if (!status.setup.open) return <SetupClosed />;
    return <SetupPage setup={status.setup} onSuccess={() => void check()} />;
  }
  if (!status.authenticated) return <LoginPage onSuccess={() => void check()} />;

  return <Shell path={path} navigate={navigate} onLogout={check} />;
}

function SetupClosed() {
  return (
    <div className="login-wrap">
      <div className="card login-card">
        <h2>📚 abs-butler</h2>
        <Banner tone="warn">
          The setup window has closed. Restart abs-butler to open a new one — under Docker that is{' '}
          <span className="mono">docker compose restart butler</span>. If you would rather not
          restart, reload this page and enter the setup code from the startup log.
        </Banner>
        <button onClick={() => window.location.reload()} style={{ width: '100%' }}>
          Reload
        </button>
      </div>
    </div>
  );
}

function Shell({
  path,
  navigate,
  onLogout,
}: {
  path: string;
  navigate: (path: string) => void;
  onLogout: () => void;
}) {
  const meta = useAsync<Meta>(() => api.meta(), []);
  const loaded = useAsync(() => api.connection(), []);
  const connection = loaded.data?.connection ?? null;

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
          <button
            className="small"
            onClick={async () => {
              await api.logout();
              onLogout();
            }}
          >
            Sign out
          </button>
          <div style={{ marginTop: 8 }}>v0.4.2</div>
          <UpdateNotice />
        </div>
      </nav>

      <main className="main">
        {loaded.error && <Banner tone="err">{loaded.error}</Banner>}
        {!loaded.loading && !connection && path !== '/connection' && (
          <Banner tone="warn">
            Not connected to AudiobookShelf yet.{' '}
            <Link to="/connection" navigate={navigate}>
              Set it up
            </Link>{' '}
            to start running jobs.
          </Banner>
        )}
        <Route
          path={path}
          navigate={navigate}
          connection={connection}
          meta={meta.data}
          reloadConnection={loaded.reload}
        />
      </main>
    </div>
  );
}

function Route({
  path,
  navigate,
  connection,
  meta,
  reloadConnection,
}: {
  path: string;
  navigate: (path: string) => void;
  connection: Connection | null;
  meta: Meta | undefined;
  reloadConnection: () => void;
}) {
  const runMatch = /^\/runs\/(\d+)$/.exec(path);
  if (runMatch) return <RunDetailPage runId={Number(runMatch[1])} navigate={navigate} />;

  switch (path) {
    case '/':
    case '/runs':
      return <RunsPage connection={connection} meta={meta} navigate={navigate} />;
    case '/schedules':
      return <SchedulesPage connection={connection} meta={meta} />;
    case '/logs':
      return <LogsPage navigate={navigate} />;
    case '/connection':
      return <ConnectionPage onChanged={reloadConnection} />;
    case '/settings':
      return <SettingsPage />;
    default:
      return (
        <>
          <h1>Not found</h1>
          <p className="subtitle">
            No page at <span className="mono">{path}</span>.{' '}
            <Link to="/" navigate={navigate}>
              Go to runs
            </Link>
          </p>
        </>
      );
  }
}

function isActive(current: string, target: string): boolean {
  if (target === '/') return current === '/' || current.startsWith('/runs');
  return current === target || current.startsWith(`${target}/`);
}

/**
 * A quiet line in the sidebar when a newer version has been tagged.
 *
 * Deliberately not a modal or a badge on every page: knowing there is an
 * update is useful, being interrupted by it is not. Says nothing at all when
 * the check is off, failed, or found nothing.
 */
function UpdateNotice() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);

  useEffect(() => {
    api.update().then(setStatus).catch(() => setStatus(null));
  }, []);

  if (!status?.available || !status.latest) return null;

  return (
    <div className="update-notice">
      <strong>{status.latest} available</strong>
      <div className="hint">
        Update with{' '}
        <span className="mono">sh install.sh --update</span> in the directory abs-butler was
        installed into.
      </div>
    </div>
  );
}
