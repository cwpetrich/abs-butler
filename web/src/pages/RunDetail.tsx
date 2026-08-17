import { api } from '../api';
import { Banner, formatDuration, formatTime, Link, Spinner, StatusBadge, useAsync } from '../lib';
import { LogStream } from '../components/LogStream';

export function RunDetailPage({ runId, navigate }: { runId: number; navigate: (path: string) => void }) {
  const run = useAsync(() => api.run(runId), [runId], { pollMs: 2000 });

  if (run.loading) return <Spinner />;
  if (run.error) return <Banner tone="err">{run.error}</Banner>;
  if (!run.data) return <Banner tone="err">Run not found.</Banner>;

  const data = run.data;
  const live = data.status === 'running' || data.status === 'queued';

  return (
    <>
      <div className="page-head">
        <h1>
          Run #{data.id} <span className="dim">{data.command}</span>
        </h1>
        <div className="actions">
          {data.status === 'queued' && (
            <button
              className="small danger"
              onClick={async () => {
                await api.cancelRun(data.id);
                run.reload();
              }}
            >
              Cancel
            </button>
          )}
          <Link to="/runs" navigate={navigate}>
            Back to runs
          </Link>
        </div>
      </div>

      <div className="card">
        <div className="summary-grid">
          <Stat label="Status" value={<StatusBadge status={data.status} />} />
          <Stat label="Server" value={data.serverName ?? '—'} />
          <Stat label="Mode" value={data.dryRun ? 'dry run' : 'applied'} />
          <Stat label="Trigger" value={data.trigger} />
          <Stat label="Started" value={formatTime(data.startedAt ?? data.queuedAt)} />
          <Stat label="Duration" value={formatDuration(data.startedAt, data.finishedAt)} />
        </div>
      </div>

      {data.error && <Banner tone="err">{data.error}</Banner>}

      {data.summary && (
        <div className="card">
          <h2>Result</h2>
          <SummaryView summary={data.summary} />
        </div>
      )}

      {Object.keys(data.options).length > 0 && (
        <div className="card">
          <h2>Options</h2>
          <div className="mono dim">{JSON.stringify(data.options)}</div>
        </div>
      )}

      <div className="card">
        <h2>Log {live && <span className="badge accent">live</span>}</h2>
        <LogStream runId={data.id} live={live} />
      </div>
    </>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value" style={{ fontSize: 15 }}>
        {value}
      </div>
    </div>
  );
}

/**
 * Summaries differ per command, so this renders whatever shape came back rather
 * than hardcoding four layouts that would drift from the server.
 */
function SummaryView({ summary }: { summary: Record<string, unknown> }) {
  const scalars = Object.entries(summary).filter(
    ([, value]) => typeof value !== 'object' || value === null,
  );
  const objects = Object.entries(summary).filter(
    ([, value]) => typeof value === 'object' && value !== null,
  );

  return (
    <>
      <div className="summary-grid">
        {scalars.map(([key, value]) => (
          <div className="stat" key={key}>
            <div className="label">{humanize(key)}</div>
            <div className="value">{String(value)}</div>
          </div>
        ))}
      </div>

      {objects.map(([key, value]) => {
        const entries = Array.isArray(value)
          ? value.map((v, i) => [String(i), v] as const)
          : Object.entries(value as Record<string, unknown>);
        if (entries.length === 0) return null;
        return (
          <div key={key} style={{ marginTop: 14 }}>
            <div className="label dim" style={{ marginBottom: 6 }}>
              {humanize(key)}
            </div>
            <table>
              <tbody>
                {entries.map(([k, v]) => (
                  <tr key={k}>
                    <td>{Array.isArray(value) ? String(v) : humanize(k)}</td>
                    {!Array.isArray(value) && <td style={{ textAlign: 'right' }}>{String(v)}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </>
  );
}

function humanize(key: string): string {
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/[-_]/g, ' ')
    .replace(/^./, (c) => c.toUpperCase())
    .trim();
}

