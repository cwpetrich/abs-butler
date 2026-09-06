import { useState } from 'react';
import { api, type Run, type RevertResult } from '../api';
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
          <Stat label="Trigger" value={data.trigger} />
          <Stat label="Mode" value={data.dryRun ? 'dry run' : 'applied'} />
          <Stat
            label="Undoable"
            value={
              data.revisions && data.revisions.total > 0
                ? `${data.revisions.total - data.revisions.reverted} of ${data.revisions.total}`
                : '—'
            }
          />
          <Stat label="Started" value={formatTime(data.startedAt ?? data.queuedAt)} />
          <Stat label="Duration" value={formatDuration(data.startedAt, data.finishedAt)} />
        </div>
      </div>

      {data.error && <Banner tone="err">{data.error}</Banner>}

      <RevertPanel run={data} onReverted={run.reload} />

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

/**
 * Putting a run back.
 *
 * Shown only where there is something to put back, so a dry run and an
 * `organize` — which moves files and records no revisions — simply do not offer
 * it rather than offering it and failing.
 *
 * The preview is not decoration: it is the same dry run the CLI does, and it
 * names the items an edit made since the run would otherwise have overwritten.
 */
function RevertPanel({ run, onReverted }: { run: Run; onReverted: () => void }) {
  const [preview, setPreview] = useState<RevertResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const pending = run.revisions ? run.revisions.total - run.revisions.reverted : 0
  if (!run.revisions || run.revisions.total === 0) return null

  const call = async (apply: boolean, force = false) => {
    setBusy(true)
    setError(null)
    try {
      const result = await api.revertRun(run.id, { apply, force })
      setPreview(result)
      if (apply) onReverted()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card">
      <h2>Undo</h2>
      {error && <Banner tone="err">{error}</Banner>}

      {pending === 0 ? (
        <p className="hint">Everything this run changed has already been put back.</p>
      ) : (
        <p className="hint">
          This run changed {pending} item(s) and recorded how to restore each one. Preview first —
          an item edited since the run is skipped rather than overwritten.
        </p>
      )}

      {preview && preview.plans.length > 0 && !preview.applied && (
        <table>
          <tbody>
            {preview.plans.map((plan) => (
              <tr key={plan.itemId}>
                <td>{plan.title}</td>
                <td className="dim">{plan.fields.join(', ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {preview?.skipped.map((skip) => (
        <Banner tone="warn" key={skip.itemId}>
          Skipping "{skip.title}" — {skip.reason}
        </Banner>
      ))}

      {preview?.applied && (
        <div className="banner" style={{ borderColor: 'var(--ok)', color: 'var(--ok)' }}>
          Restored {preview.restored} item(s).
        </div>
      )}

      {pending > 0 && (
        <div className="actions">
          <button type="button" disabled={busy} onClick={() => void call(false)}>
            {busy ? 'Checking…' : 'Preview undo'}
          </button>
          {preview && !preview.applied && preview.plans.length > 0 && (
            <button className="primary" type="button" disabled={busy} onClick={() => void call(true)}>
              Restore {preview.plans.length} item(s)
            </button>
          )}
          {preview && !preview.applied && preview.skipped.length > 0 && (
            <button type="button" disabled={busy} onClick={() => void call(true, true)}>
              Restore all, including edited
            </button>
          )}
        </div>
      )}
    </div>
  )
}
