import { useEffect, useState } from 'react';
import { api, type Meta, type RunCommand, type Server } from '../api';
import { Banner, Empty, formatDuration, formatTime, Link, Spinner, StatusBadge, useAsync } from '../lib';

export function RunsPage({
  servers,
  meta,
  navigate,
}: {
  servers: Server[];
  meta: Meta | undefined;
  navigate: (path: string) => void;
}) {
  const [filter, setFilter] = useState({ serverId: '', command: '', status: '' });
  const [showForm, setShowForm] = useState(false);

  // Polled: a running job's status and the queue change without user action.
  const runs = useAsync(
    () => api.runs({ ...filter, limit: 50 }),
    [filter.serverId, filter.command, filter.status],
    { pollMs: 3000 },
  );

  return (
    <>
      <div className="page-head">
        <h1>Runs</h1>
        <button className="primary" onClick={() => setShowForm((v) => !v)} disabled={servers.length === 0}>
          {showForm ? 'Close' : 'New run'}
        </button>
      </div>
      <p className="subtitle">
        History of every job, whether started here, from the CLI, or by a schedule. Runs execute one
        at a time.
      </p>

      {servers.length === 0 && <Banner tone="warn">Add a server before starting a run.</Banner>}
      {runs.error && <Banner tone="err">{runs.error}</Banner>}

      {showForm && meta && (
        <NewRunForm
          servers={servers}
          meta={meta}
          onStarted={(id) => {
            setShowForm(false);
            runs.reload();
            navigate(`/runs/${id}`);
          }}
        />
      )}

      <div className="card">
        <div className="actions" style={{ marginBottom: 12 }}>
          <select
            value={filter.serverId}
            onChange={(e) => setFilter((f) => ({ ...f, serverId: e.target.value }))}
            style={{ width: 'auto' }}
          >
            <option value="">All servers</option>
            {servers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <select
            value={filter.command}
            onChange={(e) => setFilter((f) => ({ ...f, command: e.target.value }))}
            style={{ width: 'auto' }}
          >
            <option value="">All commands</option>
            {(meta?.commands ?? []).map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <select
            value={filter.status}
            onChange={(e) => setFilter((f) => ({ ...f, status: e.target.value }))}
            style={{ width: 'auto' }}
          >
            <option value="">All statuses</option>
            {['queued', 'running', 'success', 'failed', 'cancelled'].map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>

        {runs.loading && <Spinner />}
        {runs.data?.runs.length === 0 && <Empty>No runs yet.</Empty>}

        {(runs.data?.runs.length ?? 0) > 0 && (
          <table>
            <thead>
              <tr>
                <th>Run</th>
                <th>Server</th>
                <th>Command</th>
                <th>Mode</th>
                <th>Status</th>
                <th>Started</th>
                <th>Took</th>
              </tr>
            </thead>
            <tbody>
              {runs.data!.runs.map((run) => (
                <tr key={run.id} className="clickable" onClick={() => navigate(`/runs/${run.id}`)}>
                  <td>
                    <Link to={`/runs/${run.id}`} navigate={navigate}>
                      #{run.id}
                    </Link>
                  </td>
                  <td>{run.serverName ?? '—'}</td>
                  <td>{run.command}</td>
                  <td>
                    <span className={`badge ${run.dryRun ? 'dim' : 'warn'}`}>
                      {run.dryRun ? 'dry run' : 'applied'}
                    </span>
                  </td>
                  <td>
                    <StatusBadge status={run.status} />
                  </td>
                  <td className="dim">{formatTime(run.startedAt ?? run.queuedAt)}</td>
                  <td className="dim">{formatDuration(run.startedAt, run.finishedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function NewRunForm({
  servers,
  meta,
  onStarted,
}: {
  servers: Server[];
  meta: Meta;
  onStarted: (runId: number) => void;
}) {
  const [serverId, setServerId] = useState(String(servers[0]?.id ?? ''));
  const [command, setCommand] = useState<RunCommand>('audit');
  const [apply, setApply] = useState(false);
  const [limit, setLimit] = useState('');
  const [template, setTemplate] = useState(meta.defaultTemplate);
  const [force, setForce] = useState(false);
  const [overwrite, setOverwrite] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const server = servers.find((s) => String(s.id) === serverId);
  const canManageFiles = server?.files.canManageFiles ?? false;
  const isFileCommand = (c: RunCommand) => meta.fileCommands.includes(c);

  // Switching to a server whose files are out of reach must not leave a
  // now-impossible command selected in a form that looks ready to submit.
  useEffect(() => {
    if (isFileCommand(command) && !canManageFiles) setCommand('audit');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId, canManageFiles]);

  const start = async (event: React.FormEvent) => {
    event.preventDefault();
    setStarting(true);
    setError(null);
    try {
      const options: Record<string, unknown> = {};
      if (apply) options.apply = true;
      if (limit) options.limit = Number(limit);
      if (command === 'organize') options.template = template;
      if (command === 'rate' && force) options.force = true;
      if (command === 'metadata' && overwrite) options.overwrite = true;

      const run = await api.startRun({ serverId: Number(serverId), command, options });
      onStarted(run.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setStarting(false);
    }
  };

  return (
    <form className="card" onSubmit={start}>
      <h2>Start a run</h2>
      {error && <Banner tone="err">{error}</Banner>}

      <div className="field-grid">
        <label>
          Server
          <select value={serverId} onChange={(e) => setServerId(e.target.value)}>
            {servers.map((s) => (
              <option key={s.id} value={s.id} disabled={!s.enabled}>
                {s.name}
                {s.enabled ? '' : ' (disabled)'}
              </option>
            ))}
          </select>
        </label>

        <label>
          Command
          <select value={command} onChange={(e) => setCommand(e.target.value as RunCommand)}>
            {meta.commands.map((c) => {
              const blocked = isFileCommand(c) && !canManageFiles;
              return (
                <option key={c} value={c} disabled={blocked}>
                  {c}
                  {blocked ? ' — needs local file access' : ''}
                </option>
              );
            })}
          </select>
        </label>

        <label>
          Limit
          <span className="hint">Stop after N items. Blank means the whole library.</span>
          <input value={limit} onChange={(e) => setLimit(e.target.value)} type="number" min="1" />
        </label>
      </div>

      {command === 'organize' && (
        <label>
          Path template
          <span className="hint">Placeholders: author, title, series, sequence, year.</span>
          <input value={template} onChange={(e) => setTemplate(e.target.value)} className="mono" />
        </label>
      )}

      {!canManageFiles && (
        <Banner tone="warn">
          File organization is unavailable for {server?.name}: {server?.files.reason} It moves files
          directly, so it only works when the media is mounted where abs-butler runs. Every other
          command works over the API.
        </Banner>
      )}

      <div className="actions" style={{ marginBottom: 12 }}>
        <label className="checkbox" style={{ marginBottom: 0 }}>
          <input type="checkbox" checked={apply} onChange={(e) => setApply(e.target.checked)} />
          Apply changes (otherwise this is a dry run)
        </label>

        {command === 'rate' && (
          <label className="checkbox" style={{ marginBottom: 0 }}>
            <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
            Re-rate already-tagged books
          </label>
        )}

        {command === 'metadata' && (
          <label className="checkbox" style={{ marginBottom: 0 }}>
            <input
              type="checkbox"
              checked={overwrite}
              onChange={(e) => setOverwrite(e.target.checked)}
            />
            Overwrite existing values
          </label>
        )}
      </div>

      {apply && (
        <Banner tone="warn">
          This will write to {server?.name}
          {command === 'organize' ? ' and move files on disk' : ''}. Run it as a dry run first.
        </Banner>
      )}

      <button className="primary" type="submit" disabled={starting || !serverId}>
        {starting ? 'Queueing…' : 'Start run'}
      </button>
    </form>
  );
}
