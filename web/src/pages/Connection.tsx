import { useEffect, useId, useState } from 'react';
import { api, type CapabilityReport, type Connection } from '../api';
import { Banner, Spinner, useAsync } from '../lib';

/**
 * How to authenticate. An API token is the default and the recommendation: it
 * is what gets stored either way, and it can be revoked in AudiobookShelf
 * without disturbing the account's password. Signing in is offered because
 * finding the token means a trip through the AudiobookShelf settings.
 *
 * `keep` exists only when editing, so changing a path is not mistaken for
 * replacing a credential.
 */
type AuthMethod = 'keep' | 'apiKey' | 'password';

interface FormState {
  url: string;
  method: AuthMethod;
  apiKey: string;
  username: string;
  password: string;
  libraryRoot: string;
  pathPrefix: string;
}

const EMPTY: FormState = {
  url: '',
  method: 'apiKey',
  apiKey: '',
  username: '',
  password: '',
  libraryRoot: '',
  pathPrefix: '',
};

export function ConnectionPage({ onChanged }: { onChanged: () => void }) {
  const loaded = useAsync(() => api.connection(), []);
  const connection = loaded.data?.connection ?? null;

  if (loaded.loading) return <Spinner />;
  if (loaded.error) return <Banner tone="err">{loaded.error}</Banner>;

  return (
    <>
      <div className="page-head">
        <h1>Connection</h1>
      </div>
      <p className="subtitle">
        abs-butler manages one AudiobookShelf server and runs beside it. Everything except file
        organization works over the API; organizing needs the same library mounted here.
      </p>

      {connection ? (
        <Connected
          connection={connection}
          onChanged={() => {
            loaded.reload();
            onChanged();
          }}
        />
      ) : (
        <NotConnected
          onSaved={() => {
            loaded.reload();
            onChanged();
          }}
        />
      )}
    </>
  );
}

function NotConnected({ onSaved }: { onSaved: () => void }) {
  return (
    <div className="card">
      <h2>Connect to AudiobookShelf</h2>
      <p className="hint">
        Tell abs-butler where AudiobookShelf is and how to authenticate. Either paste an API token,
        or sign in with an admin username and password — abs-butler exchanges the login for that
        user's API token and stores only the token.
      </p>
      <ConnectionForm initial={EMPTY} requireKey onSaved={onSaved} submitLabel="Connect" />
    </div>
  );
}

function Connected({
  connection,
  onChanged,
}: {
  connection: Connection;
  onChanged: () => void;
}) {
  const [report, setReport] = useState<CapabilityReport | null>(null);
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);

  const test = async () => {
    setTesting(true);
    setTestError(null);
    try {
      setReport(await api.capability());
    } catch (err) {
      setTestError((err as Error).message);
    } finally {
      setTesting(false);
    }
  };

  const files = connection.files;

  return (
    <>
      <div className="card">
        <div className="row-between">
          <div>
            <div className="hint">AudiobookShelf server</div>
            <h2 className="mono">{connection.url}</h2>
            {urlNote(connection.url) && <p className="hint">{urlNote(connection.url)}</p>}
            <p className="hint">{credentialSummary(connection)}</p>
          </div>
          <button onClick={test} disabled={testing}>
            {testing ? 'Testing…' : 'Test'}
          </button>
        </div>

        <div className={`banner ${files.canManageFiles ? '' : 'warn'}`} style={{ marginTop: 12 }}>
          <strong>File organization: {files.canManageFiles ? 'available' : 'unavailable'}</strong>
          <div>{files.reason}</div>
        </div>

        {testError && <Banner tone="err">{testError}</Banner>}
        {report?.user?.username && (
          <p className="hint">
            Reachable. The stored token authenticates as <strong>{report.user.username}</strong>
            {report.user.type ? ` (${report.user.type})` : ''}.
          </p>
        )}
        {report && <CapabilityTable report={report} />}
        {report && <PathFinding report={report} onApplied={onChanged} />}
      </div>

      <div className="card">
        <h2>Edit connection</h2>
        <ConnectionForm
          initial={{
            url: connection.url,
            method: 'keep',
            apiKey: '',
            username: '',
            password: '',
            libraryRoot: connection.libraryRoot ?? '',
            pathPrefix: connection.pathPrefix ?? '',
          }}
          onSaved={onChanged}
          submitLabel="Save changes"
        />
      </div>

      <div className="card">
        <h2>Disconnect</h2>
        <p className="hint">
          Forgets the server URL and the stored API token. Run history, logs, schedules, and
          settings are kept.
        </p>
        {confirmingDisconnect ? (
          <div className="actions">
            <button
              className="danger"
              onClick={async () => {
                await api.disconnect();
                setConfirmingDisconnect(false);
                onChanged();
              }}
            >
              Yes, disconnect
            </button>
            <button onClick={() => setConfirmingDisconnect(false)}>Cancel</button>
          </div>
        ) : (
          <div className="actions">
            <button className="danger" onClick={() => setConfirmingDisconnect(true)}>
              Disconnect
            </button>
          </div>
        )}
      </div>
    </>
  );
}

/**
 * Explains hostnames that only resolve from inside Docker. The installer picks
 * these on its own, so they are the ones people find and do not recognize.
 */
function urlNote(url: string): string | null {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  if (host === 'host.docker.internal') {
    return (
      'host.docker.internal is how a Docker container reaches the machine it runs on. ' +
      'It works from abs-butler, not from your browser.'
    );
  }
  const singleLabel = !host.includes('.') && !host.includes(':') && host !== 'localhost';
  if (singleLabel) {
    return (
      `"${host}" is a Docker container name: abs-butler reaches AudiobookShelf over their ` +
      'shared Docker network. It will not open in your browser, and does not need to.'
    );
  }
  return null;
}

function credentialSummary(connection: Connection): string {
  const atRest = connection.key.encrypted ? 'encrypted at rest' : 'stored in plaintext';
  if (connection.authMethod === 'login') {
    const who = connection.authUsername ? ` as ${connection.authUsername}` : '';
    return (
      `Connected by signing in${who}. abs-butler exchanged that login for the user's API token ` +
      `and stores only the token (${atRest}), never the password.`
    );
  }
  if (connection.authMethod === 'token') {
    return `Authenticates with an API token that was pasted in (${atRest}).`;
  }
  return (
    `Authenticates with a stored API token (${atRest}). If you connected by signing in — as the ` +
    'installer does — AudiobookShelf issued this token for that user; you did not have to ' +
    'create one. Test shows which user it belongs to.'
  );
}

function ConnectionForm({
  initial,
  requireKey = false,
  submitLabel,
  onSaved,
}: {
  initial: FormState;
  requireKey?: boolean;
  submitLabel: string;
  onSaved: () => void;
}) {
  const [form, setForm] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const methodName = useId();

  useEffect(() => setForm(initial), [initial.url, initial.libraryRoot, initial.pathPrefix]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const usingPassword = form.method === 'password';

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      // Only the chosen method is sent. Keeping the current credential sends
      // nothing at all, which the server reads as "keep the stored token".
      const credentials =
        form.method === 'password'
          ? { username: form.username, password: form.password }
          : form.method === 'apiKey'
            ? { apiKey: form.apiKey }
            : {};

      const payload = {
        url: form.url,
        libraryRoot: form.libraryRoot,
        pathPrefix: form.pathPrefix,
        ...credentials,
      };
      if (requireKey) await api.saveConnection(payload);
      else await api.updateConnection(payload);

      // Neither secret is kept in component state after a save.
      setForm((f) => ({
        ...f,
        apiKey: '',
        password: '',
        ...(requireKey ? {} : { method: 'keep' as const }),
      }));
      setStatus(usingPassword ? 'Saved. Stored the API token, not the password.' : 'Saved.');
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit}>
      {error && <Banner tone="err">{error}</Banner>}
      {status && (
        <div className="banner" style={{ borderColor: 'var(--ok)', color: 'var(--ok)' }}>
          {status}
        </div>
      )}

      <label>
        AudiobookShelf URL
        <span className="hint">
          The address abs-butler uses to reach AudiobookShelf — not necessarily the one you open in
          your browser. If both run in Docker on a shared network, use the container name, e.g.{' '}
          <code>http://audiobookshelf:80</code>. If only abs-butler is in Docker, use{' '}
          <code>http://host.docker.internal:13378</code>.
        </span>
        <input
          value={form.url}
          onChange={(e) => set('url', e.target.value)}
          placeholder="http://localhost:13378"
          required
        />
      </label>

      <div style={{ marginBottom: 10 }}>
        <div className="field-label">How abs-butler authenticates</div>
        <div className="actions">
          {!requireKey && (
            <label className="checkbox">
              <input
                type="radio"
                name={methodName}
                checked={form.method === 'keep'}
                onChange={() => set('method', 'keep')}
              />
              Keep the stored token
            </label>
          )}
          <label className="checkbox">
            <input
              type="radio"
              name={methodName}
              checked={form.method === 'apiKey'}
              onChange={() => set('method', 'apiKey')}
            />
            {requireKey ? 'Paste an API token' : 'Paste a new API token'}{' '}
            <span className="badge ok">recommended</span>
          </label>
          <label className="checkbox">
            <input
              type="radio"
              name={methodName}
              checked={usingPassword}
              onChange={() => set('method', 'password')}
            />
            {requireKey ? 'Sign in with a username and password' : 'Sign in again'}
          </label>
        </div>
      </div>

      {usingPassword && (
        <>
          <p className="hint">
            Used once to fetch that user's API token; the password is never stored. The account
            needs to read every library, so an admin is the safe choice.
          </p>
          <div className="field-grid">
            <label>
              AudiobookShelf username
              <input
                value={form.username}
                onChange={(e) => set('username', e.target.value)}
                placeholder="e.g. root"
                autoComplete="username"
                required
              />
            </label>
            <label>
              AudiobookShelf password
              <input
                type="password"
                value={form.password}
                onChange={(e) => set('password', e.target.value)}
                autoComplete="current-password"
                required
              />
            </label>
          </div>
        </>
      )}

      {form.method === 'apiKey' && (
        <label>
          API token
          <span className="hint">
            In AudiobookShelf: Settings → Users → your user → API Token.
          </span>
          <input
            type="password"
            value={form.apiKey}
            onChange={(e) => set('apiKey', e.target.value)}
            placeholder="Paste the token here"
            autoComplete="new-password"
            required
          />
        </label>
      )}

      <p className="hint">
        {requireKey
          ? 'Only needed to organize files. Leave both blank and abs-butler fills them in by finding ' +
            "your books from here — it looks for them, so it will not settle on an empty folder."
          : 'Only needed to organize files. Test looks for your books from here and offers the right ' +
            'paths if these are wrong.'}
      </p>
      <div className="field-grid">
        <label>
          Library folder, as abs-butler sees it
          <span className="hint">
            In the Docker setup this is <code>/audiobooks</code>, where docker-compose.yml mounts{' '}
            <code>HOST_LIBRARY_PATH</code> — not the path AudiobookShelf uses.
          </span>
          <input
            value={form.libraryRoot}
            onChange={(e) => set('libraryRoot', e.target.value)}
            placeholder={requireKey ? 'found automatically' : 'e.g. /audiobooks'}
          />
        </label>

        <label>
          Library folder, as AudiobookShelf sees it
          <span className="hint">
            The path AudiobookShelf shows for the library, e.g. <code>/audiobooks</code> or{' '}
            <code>/nas/AudioBooks</code>. Blank when it is the same as the one beside it.
          </span>
          <input
            value={form.pathPrefix}
            onChange={(e) => set('pathPrefix', e.target.value)}
            placeholder={requireKey ? 'found automatically' : 'blank when both paths match'}
          />
        </label>
      </div>

      <div className="actions">
        <button className="primary" type="submit" disabled={busy}>
          {busy ? 'Checking…' : submitLabel}
        </button>
      </div>
    </form>
  );
}

/**
 * The answer from looking for the books: confirmation when the settings find
 * them, the settings that would when they do not, and what is mounted when
 * nothing does.
 */
function PathFinding({ report, onApplied }: { report: CapabilityReport; onApplied: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const discovery = report.discovery;
  if (!report.reachable || !discovery || discovery.checked === 0) return null;

  const { mapping, checked, found } = discovery;
  const tally = `${found} of ${checked} sampled ${checked === 1 ? 'book' : 'books'}`;

  if (mapping && discovery.matchesCurrent) {
    return <p className="hint">Checked by looking for them: {tally} are where these paths say.</p>;
  }

  if (mapping) {
    const apply = async () => {
      setBusy(true);
      setError(null);
      try {
        await api.updateConnection({
          libraryRoot: mapping.libraryRoot,
          pathPrefix: mapping.pathPrefix ?? '',
        });
        onApplied();
      } catch (err) {
        setError((err as Error).message);
        setBusy(false);
      }
    };
    return (
      <div className="banner" style={{ marginTop: 12 }}>
        <strong>Found your books ({tally})</strong>
        <div>
          {mapping.pathPrefix ? (
            <>
              AudiobookShelf's <code>{mapping.pathPrefix}</code> is <code>{mapping.libraryRoot}</code>{' '}
              here.
            </>
          ) : (
            <>
              At <code>{mapping.libraryRoot}</code>, the same path AudiobookShelf uses.
            </>
          )}
        </div>
        {error && <Banner tone="err">{error}</Banner>}
        <div className="actions" style={{ marginTop: 8 }}>
          <button className="primary" onClick={apply} disabled={busy}>
            {busy ? 'Saving…' : 'Use these paths'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="banner warn" style={{ marginTop: 12 }}>
      <strong>None of {checked} sampled books could be found from here</strong>
      <div>
        abs-butler is not looking at the same files as AudiobookShelf, so no setting here can fix it:
        the library has to be mounted into abs-butler first.{' '}
        {report.mounts.length > 0 ? (
          <>
            Mounted in this container: <code>{report.mounts.join(', ')}</code>. Point{' '}
            <code>HOST_LIBRARY_PATH</code> at the folder AudiobookShelf uses and run{' '}
            <code>docker compose up -d</code>.
          </>
        ) : (
          'Check that the folder AudiobookShelf uses is reachable from this machine.'
        )}
      </div>
    </div>
  );
}

function CapabilityTable({ report }: { report: CapabilityReport }) {
  if (!report.reachable) {
    return <Banner tone="err">Could not reach AudiobookShelf: {report.error}</Banner>;
  }
  const rows = report.capability?.libraries ?? [];
  if (rows.length === 0) return <p className="hint">No book libraries found.</p>;

  return (
    <table style={{ marginTop: 12 }}>
      <thead>
        <tr>
          <th>Library</th>
          <th>AudiobookShelf path</th>
          <th>Path here</th>
          <th>Access</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={`${row.libraryId}:${row.absPath}`}>
            <td>{row.libraryName}</td>
            <td className="mono">{row.absPath}</td>
            <td className="mono">{row.localPath ?? '—'}</td>
            <td>
              <span className={`badge ${row.access === 'read-write' ? 'ok' : 'warn'}`}>
                {row.access}
              </span>
              {row.reason && <div className="hint">{row.reason}</div>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
