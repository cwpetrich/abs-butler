import { useEffect, useState } from 'react';
import { api, type Connection, type Meta, type RunCommand } from '../api';
import { Banner, Empty, formatInterval, formatTime, Spinner, useAsync } from '../lib';

const PRESETS = [
  { label: 'Every 6 hours', minutes: 360 },
  { label: 'Every 12 hours', minutes: 720 },
  { label: 'Daily', minutes: 1440 },
  { label: 'Weekly', minutes: 10080 },
];

export function SchedulesPage({
  connection,
  meta,
}: {
  connection: Connection | null;
  meta: Meta | undefined;
}) {
  const schedules = useAsync(() => api.schedules(), [], { pollMs: 15000 });
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      schedules.reload();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <>
      <div className="page-head">
        <h1>Schedules</h1>
        <button className="primary" onClick={() => setShowForm((v) => !v)} disabled={!connection}>
          {showForm ? 'Close' : 'New schedule'}
        </button>
      </div>
      <p className="subtitle">
        Recurring jobs. These queue like any other run, so they never overlap with a manual one.
      </p>

      {error && <Banner tone="err">{error}</Banner>}
      {schedules.error && <Banner tone="err">{schedules.error}</Banner>}

      {showForm && meta && connection && (
        <ScheduleForm
          connection={connection}
          meta={meta}
          onSaved={() => {
            setShowForm(false);
            schedules.reload();
          }}
        />
      )}

      {schedules.loading && <Spinner />}
      {schedules.data?.length === 0 && <Empty>No schedules configured.</Empty>}

      {(schedules.data?.length ?? 0) > 0 && (
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>Command</th>
                <th>Mode</th>
                <th>Every</th>
                <th>Last run</th>
                <th>Next run</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {schedules.data!.map((schedule) => (
                <tr key={schedule.id}>
                  <td>{schedule.command}</td>
                  <td>
                    <span className={`badge ${schedule.options.apply ? 'warn' : 'dim'}`}>
                      {schedule.options.apply ? 'applied' : 'dry run'}
                    </span>
                  </td>
                  <td>{formatInterval(schedule.intervalMinutes)}</td>
                  <td className="dim">{formatTime(schedule.lastRunAt)}</td>
                  <td className="dim">{schedule.enabled ? formatTime(schedule.nextRunAt) : '—'}</td>
                  <td>
                    <span className={`badge ${schedule.enabled ? 'ok' : 'dim'}`}>
                      {schedule.enabled ? 'enabled' : 'paused'}
                    </span>
                  </td>
                  <td>
                    <div className="actions">
                      <button
                        className="small"
                        onClick={() =>
                          act(() => api.updateSchedule(schedule.id, { enabled: !schedule.enabled }))
                        }
                      >
                        {schedule.enabled ? 'Pause' : 'Resume'}
                      </button>
                      <button
                        className="small danger"
                        onClick={() => act(() => api.deleteSchedule(schedule.id))}
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function ScheduleForm({
  connection,
  meta,
  onSaved,
}: {
  connection: Connection;
  meta: Meta;
  onSaved: () => void;
}) {
  const [command, setCommand] = useState<RunCommand>('audit');
  const [minutes, setMinutes] = useState(720);
  const [apply, setApply] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const canManageFiles = connection.files.canManageFiles;
  const isFileCommand = (c: RunCommand) => meta.fileCommands.includes(c);

  useEffect(() => {
    if (isFileCommand(command) && !canManageFiles) setCommand('audit');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canManageFiles]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api.createSchedule({
        command,
        intervalMinutes: minutes,
        options: apply ? { apply: true } : {},
      });
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="card" onSubmit={submit}>
      <h2>New schedule</h2>
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
          Interval
          <select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
            {PRESETS.map((preset) => (
              <option key={preset.minutes} value={preset.minutes}>
                {preset.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {!canManageFiles && (
        <Banner tone="warn">
          File organization is unavailable: {connection.files.reason} Every other command works over
          the API.
        </Banner>
      )}

      <label className="checkbox">
        <input type="checkbox" checked={apply} onChange={(e) => setApply(e.target.checked)} />
        Apply changes automatically
      </label>

      {apply && (
        <Banner tone="warn">
          This schedule will write to AudiobookShelf unattended. Verify with a dry run first.
        </Banner>
      )}

      <button className="primary" type="submit" disabled={saving}>
        {saving ? 'Saving…' : 'Create schedule'}
      </button>
    </form>
  );
}
