import { useEffect, useState } from 'react';
import { api, type CapabilityReport, type Connection } from '../api';
import { Banner, Spinner, useAsync } from '../lib';

interface FormState {
  url: string;
  apiKey: string;
  libraryRoot: string;
  pathPrefix: string;
}

const EMPTY: FormState = { url: '', apiKey: '', libraryRoot: '', pathPrefix: '' };

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
        The API token is in AudiobookShelf under Settings → Users → your user → API Token.
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
            <h2 className="mono">{connection.url}</h2>
            <div className="hint">
              API key {connection.key.encrypted ? 'encrypted at rest' : 'stored in plaintext'}
            </div>
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
        {report && <CapabilityTable report={report} />}
      </div>

      <div className="card">
        <h2>Edit connection</h2>
        <ConnectionForm
          initial={{
            url: connection.url,
            apiKey: '',
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
          Forgets the URL and API key. Run history, logs, schedules, and settings are kept.
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

  useEffect(() => setForm(initial), [initial.url, initial.libraryRoot, initial.pathPrefix]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const payload = {
        url: form.url,
        libraryRoot: form.libraryRoot,
        pathPrefix: form.pathPrefix,
        ...(form.apiKey ? { apiKey: form.apiKey } : {}),
      };
      if (requireKey) await api.saveConnection({ ...payload, apiKey: form.apiKey });
      else await api.updateConnection(payload);

      setForm((f) => ({ ...f, apiKey: '' }));
      setStatus('Saved.');
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
        Server URL
        <input
          value={form.url}
          onChange={(e) => set('url', e.target.value)}
          placeholder="http://localhost:13378"
          required
        />
      </label>

      <label>
        API token
        {!requireKey && <span className="hint">Leave blank to keep the stored token.</span>}
        <input
          type="password"
          value={form.apiKey}
          onChange={(e) => set('apiKey', e.target.value)}
          placeholder={requireKey ? '' : '••••••••'}
          autoComplete="new-password"
          required={requireKey}
        />
      </label>

      <div className="field-grid">
        <label>
          Library root — where <em>this machine</em> sees the media
          <span className="hint">
            Needed only for organizing files. Leave blank to manage over the API alone.
          </span>
          <input
            value={form.libraryRoot}
            onChange={(e) => set('libraryRoot', e.target.value)}
            placeholder="/audiobooks"
          />
        </label>

        <label>
          Path prefix — where <em>AudiobookShelf</em> sees it
          <span className="hint">
            Only if it differs, which it does when AudiobookShelf runs in Docker. Test to see the
            paths it reports.
          </span>
          <input
            value={form.pathPrefix}
            onChange={(e) => set('pathPrefix', e.target.value)}
            placeholder="leave blank if the paths match"
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
