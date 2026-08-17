import { useState } from 'react';
import { api, type CapabilityReport, type Server } from '../api';
import { Banner, Empty, Spinner, useAsync } from '../lib';

export function ServersPage({ onChanged }: { onChanged: () => void }) {
  const servers = useAsync(() => api.servers(), []);
  const [editing, setEditing] = useState<Server | 'new' | null>(null);

  if (servers.loading) return <Spinner />;

  return (
    <>
      <div className="page-head">
        <h1>Servers</h1>
        <button className="primary" onClick={() => setEditing('new')}>
          Add server
        </button>
      </div>
      <p className="subtitle">
        Each server is managed over its HTTP API, so it can live on any machine. Only file
        organization needs the media mounted here.
      </p>

      {servers.error && <Banner tone="err">{servers.error}</Banner>}

      {editing && (
        <ServerForm
          server={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            servers.reload();
            onChanged();
          }}
        />
      )}

      {servers.data?.length === 0 && !editing && (
        <Empty>No servers configured yet. Add one to get started.</Empty>
      )}

      {servers.data?.map((server) => (
        <ServerCard
          key={server.id}
          server={server}
          onEdit={() => setEditing(server)}
          onChanged={() => {
            servers.reload();
            onChanged();
          }}
        />
      ))}
    </>
  );
}

function ServerCard({
  server,
  onEdit,
  onChanged,
}: {
  server: Server;
  onEdit: () => void;
  onChanged: () => void;
}) {
  const [report, setReport] = useState<CapabilityReport | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const check = async () => {
    setChecking(true);
    setError(null);
    try {
      setReport(await api.capability(server.id));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setChecking(false);
    }
  };

  const remove = async () => {
    if (!confirm(`Remove "${server.name}" and its run history? This cannot be undone.`)) return;
    try {
      await api.deleteServer(server.id);
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="card">
      <div className="card-row">
        <div>
          <h2>
            {server.name}{' '}
            {!server.enabled && <span className="badge dim">disabled</span>}{' '}
            {server.key.encrypted ? (
              <span className="badge ok">key encrypted</span>
            ) : (
              <span className="badge warn">key in plaintext</span>
            )}
          </h2>
          <div className="mono dim">{server.url}</div>
          <div style={{ marginTop: 8 }}>
            {server.files.canManageFiles ? (
              <span className="badge ok">file organization available</span>
            ) : (
              <span className="badge dim">API-only — organization disabled</span>
            )}
            <div className="dim" style={{ marginTop: 4 }}>
              {server.files.canManageFiles ? (
                <>
                  Media reachable at <span className="mono">{server.files.path}</span>
                  {server.pathPrefix && (
                    <>
                      {' '}
                      (this server reports it as <span className="mono">{server.pathPrefix}</span>)
                    </>
                  )}
                </>
              ) : (
                server.files.reason
              )}
            </div>
          </div>
        </div>
        <div className="actions">
          <button className="small" onClick={check} disabled={checking}>
            {checking ? 'Checking…' : 'Test'}
          </button>
          <button className="small" onClick={onEdit}>
            Edit
          </button>
          <button className="small danger" onClick={remove}>
            Remove
          </button>
        </div>
      </div>

      {error && <Banner tone="err">{error}</Banner>}
      {report && <CapabilityView report={report} />}
    </div>
  );
}

function CapabilityView({ report }: { report: CapabilityReport }) {
  if (!report.reachable) {
    return <Banner tone="err">Could not reach this server: {report.error}</Banner>;
  }

  return (
    <div style={{ marginTop: 14 }}>
      <div className="badge ok">reachable</div>{' '}
      <span className="dim">{report.libraries.length} librar(ies)</span>
      {report.capability && (
        <>
          <div style={{ margin: '10px 0' }}>
            {report.capability.canManageFiles ? (
              <span className="badge ok">files manageable</span>
            ) : (
              <span className="badge warn">API-only from this machine</span>
            )}{' '}
            <span className="dim">{report.capability.reason}</span>
          </div>
          {report.capability.libraries.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>Library</th>
                  <th>Path on server</th>
                  <th>Path here</th>
                  <th>Access</th>
                </tr>
              </thead>
              <tbody>
                {report.capability.libraries.map((lib, index) => (
                  <tr key={`${lib.libraryId}-${index}`}>
                    <td>{lib.libraryName}</td>
                    <td className="mono">{lib.absPath}</td>
                    <td className="mono">{lib.localPath ?? '—'}</td>
                    <td>
                      <span
                        className={`badge ${lib.access === 'read-write' ? 'ok' : lib.access === 'read-only' ? 'warn' : 'dim'}`}
                        title={lib.reason}
                      >
                        {lib.access}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}

function ServerForm({
  server,
  onClose,
  onSaved,
}: {
  server: Server | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    name: server?.name ?? '',
    url: server?.url ?? '',
    apiKey: '',
    libraryRoot: server?.libraryRoot ?? '',
    pathPrefix: server?.pathPrefix ?? '',
    enabled: server?.enabled ?? true,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (key: keyof typeof form) => (event: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: event.target.value }));

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const payload = {
        name: form.name,
        url: form.url,
        libraryRoot: form.libraryRoot || null,
        pathPrefix: form.pathPrefix || null,
        enabled: form.enabled,
        ...(form.apiKey ? { apiKey: form.apiKey } : {}),
      };
      if (server) await api.updateServer(server.id, payload);
      else await api.createServer(payload);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="card" onSubmit={submit}>
      <h2>{server ? `Edit ${server.name}` : 'Add a server'}</h2>
      {error && <Banner tone="err">{error}</Banner>}

      <div className="field-grid">
        <label>
          Name
          <span className="hint">How you will refer to this server.</span>
          <input value={form.name} onChange={set('name')} required placeholder="home" />
        </label>

        <label>
          URL
          <span className="hint">Base URL of the AudiobookShelf server.</span>
          <input
            value={form.url}
            onChange={set('url')}
            required
            placeholder="http://192.168.1.10:13378"
          />
        </label>
      </div>

      <label>
        API key
        <span className="hint">
          {server
            ? 'Leave blank to keep the current key. The existing one is never sent to the browser.'
            : 'AudiobookShelf → Settings → Users → your user → API Token.'}
        </span>
        <input
          value={form.apiKey}
          onChange={set('apiKey')}
          required={!server}
          type="password"
          autoComplete="new-password"
        />
      </label>

      <div className="field-grid">
        <label>
          Library root on this machine
          <span className="hint">Leave blank to manage this server over the API only.</span>
          <input value={form.libraryRoot} onChange={set('libraryRoot')} placeholder="/mnt/audiobooks" />
        </label>

        <label>
          Path prefix reported by the server
          <span className="hint">Only needed when AudiobookShelf sees a different path.</span>
          <input value={form.pathPrefix} onChange={set('pathPrefix')} placeholder="/audiobooks" />
        </label>
      </div>

      <label className="checkbox">
        <input
          type="checkbox"
          checked={form.enabled}
          onChange={(event) => setForm((f) => ({ ...f, enabled: event.target.checked }))}
        />
        Enabled
      </label>

      <div className="actions">
        <button className="primary" type="submit" disabled={saving}>
          {saving ? 'Verifying…' : server ? 'Save' : 'Add server'}
        </button>
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <span className="dim">The connection is verified before saving.</span>
      </div>
    </form>
  );
}
