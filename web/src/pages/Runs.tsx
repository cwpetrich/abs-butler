import { useEffect, useState } from 'react';
import { api, type Connection, type Meta, type Run, type RunCommand } from '../api';
import { Banner, Empty, formatDuration, formatTime, Link, Spinner, StatusBadge, useAsync } from '../lib';

export function RunsPage({
  connection,
  meta,
  navigate,
}: {
  connection: Connection | null;
  meta: Meta | undefined;
  navigate: (path: string) => void;
}) {
  const [filter, setFilter] = useState({ command: '', status: '' });
  const [showForm, setShowForm] = useState(false);

  // Polled: a running job's status and the queue change without user action.
  const runs = useAsync(
    () => api.runs({ ...filter, limit: 50 }),
    [filter.command, filter.status],
    { pollMs: 3000 },
  );

  return (
    <>
      <div className="page-head">
        <h1>Runs</h1>
        <button className="primary" onClick={() => setShowForm((v) => !v)} disabled={!connection}>
          {showForm ? 'Close' : 'New run'}
        </button>
      </div>
      <p className="subtitle">
        History of every job, whether started here, from the CLI, or by a schedule. Runs execute one
        at a time.
      </p>

      {runs.error && <Banner tone="err">{runs.error}</Banner>}

      {showForm && meta && connection && (
        <NewRunForm
          connection={connection}
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
                <th>Command</th>
                <th>Trigger</th>
                <th>Mode</th>
                <th>Status</th>
                <th>Started</th>
                <th>Took</th>
                <th />
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
                  <td>{run.command}</td>
                  <td className="dim">{run.trigger}</td>
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
                  <td style={{ textAlign: 'right' }}>
                    <StopButton run={run} onStopped={runs.reload} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

/**
 * Stopping a run from the list.
 *
 * Here rather than only on the run's own page: a run that will not finish is
 * noticed on this list, and making someone open it first to stop it is how
 * "there is no way to stop this" starts. Shown for anything still live —
 * `cancel` drops a queued run outright and asks a running one to wind up.
 */
function StopButton({ run, onStopped }: { run: Run; onStopped: () => void }) {
  const [asked, setAsked] = useState(false);
  if (run.status !== 'running' && run.status !== 'queued') return null;

  return (
    <button
      className="small danger"
      disabled={asked}
      onClick={async (e) => {
        // The row navigates on click; the button does not.
        e.stopPropagation();
        setAsked(true);
        try {
          await api.cancelRun(run.id);
        } catch {
          setAsked(false);
        }
        onStopped();
      }}
    >
      {asked ? 'Stopping…' : run.status === 'running' ? 'Stop' : 'Cancel'}
    </button>
  );
}

function NewRunForm({
  connection,
  meta,
  onStarted,
}: {
  connection: Connection;
  meta: Meta;
  onStarted: (runId: number) => void;
}) {
  const [command, setCommand] = useState<RunCommand>('audit');
  const [apply, setApply] = useState(false);
  const [limit, setLimit] = useState('');
  const [template, setTemplate] = useState(meta.defaultTemplate);
  const [singleFiles, setSingleFiles] = useState(false);
  const [force, setForce] = useState(false);
  const [overwrite, setOverwrite] = useState(false);
  const [noConsensus, setNoConsensus] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const settings = useAsync(() => api.settings(), []);
  const canManageFiles = connection.files.canManageFiles;
  const isFileCommand = (c: RunCommand) => meta.fileCommands.includes(c);

  // Reachable files and permission to change them are separate questions, and
  // organize needs both. This one is abs-butler's own switch, on the Settings
  // page — not a mount, not a permission bit.
  //
  // normalize has its own switch for the same reason and with the same shape:
  // the plan is always allowed, only writing it is gated.
  const fileWritesBlocked =
    isFileCommand(command) && settings.data?.settings.allowFileChanges === false;
  const rewriteBlocked =
    command === 'normalize' && settings.data?.settings.allowMetadataRewrite === false;
  const writesBlocked = fileWritesBlocked || rewriteBlocked;

  // A mount can disappear while this form is open; a now-impossible command
  // must not stay selected in a form that still looks ready to submit.
  useEffect(() => {
    if (isFileCommand(command) && !canManageFiles) setCommand('audit');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canManageFiles]);

  // Unlike an unreachable mount, this does not disqualify the command — a dry
  // run is still worth doing — so only the apply is withdrawn.
  useEffect(() => {
    if (writesBlocked) setApply(false);
  }, [writesBlocked]);

  const start = async (event: React.FormEvent) => {
    event.preventDefault();
    setStarting(true);
    setError(null);
    try {
      const options: Record<string, unknown> = {};
      if (apply) options.apply = true;
      if (limit) options.limit = Number(limit);
      if (command === 'organize') {
        options.template = template;
        if (singleFiles) options.singleFiles = true;
      }
      if (command === 'rate' && force) options.force = true;
      if (command === 'metadata' && overwrite) options.overwrite = true;
      if (command === 'normalize' && noConsensus) options.noConsensus = true;

      const run = await api.startRun({ command, options });
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
        <>
          <label>
            Path template
            <span className="hint">Placeholders: author, title, series, sequence, year.</span>
            <input value={template} onChange={(e) => setTemplate(e.target.value)} className="mono" />
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={singleFiles} onChange={(e) => setSingleFiles(e.target.checked)} />
            Include single-file items
          </label>
          <span className="hint">
            A bare book.m4b sitting in a library root is left alone by default. This files it into
            the folder the template describes. Dry run first — moves cannot be undone.
          </span>
        </>
      )}

      {!canManageFiles && (
        <Banner tone="warn">
          File organization is unavailable: {connection.files.reason} It moves files directly, so it
          needs the library mounted where abs-butler runs. Every other command works over the API.
        </Banner>
      )}

      {fileWritesBlocked && (
        <Banner tone="warn">
          File changes are turned off, so organize can plan moves but not carry them out. Turn on
          "Allow file changes" in Settings to apply a plan — the files themselves are reachable.
        </Banner>
      )}

      {rewriteBlocked && (
        <Banner tone="warn">
          Metadata rewriting is turned off, so normalize can propose changes but not write them.
          Turn on "Allow metadata rewrite" in Settings to apply a plan. Unlike metadata, which only
          fills blank fields, this replaces titles and names that already have a value.
        </Banner>
      )}

      <div className="actions" style={{ marginBottom: 12 }}>
        <label className="checkbox" style={{ marginBottom: 0 }}>
          <input
            type="checkbox"
            checked={apply}
            disabled={writesBlocked}
            onChange={(e) => setApply(e.target.checked)}
          />
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

        {command === 'normalize' && (
          <label className="checkbox" style={{ marginBottom: 0 }}>
            <input
              type="checkbox"
              checked={noConsensus}
              onChange={(e) => setNoConsensus(e.target.checked)}
            />
            Ignore what the rest of the library spells
          </label>
        )}
      </div>

      {apply && (
        <Banner tone="warn">
          This will write to AudiobookShelf
          {command === 'organize' ? ' and move files on disk' : ''}
          {command === 'normalize' ? ', replacing titles and names that already have a value' : ''}.
          Run it as a dry run first.
        </Banner>
      )}

      <button className="primary" type="submit" disabled={starting}>
        {starting ? 'Queueing…' : 'Start run'}
      </button>
    </form>
  );
}
