import { useState } from 'react';
import { api, type Finding, type Run, type RevertResult } from '../api';
import { Banner, formatDuration, formatTime, Link, Spinner, StatusBadge, useAsync } from '../lib';
import { LogStream } from '../components/LogStream';

export function RunDetailPage({ runId, navigate }: { runId: number; navigate: (path: string) => void }) {
  const run = useAsync(() => api.run(runId), [runId], { pollMs: 2000 });
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);

  if (run.loading) return <Spinner />;
  if (run.error) return <Banner tone="err">{run.error}</Banner>;
  if (!run.data) return <Banner tone="err">Run not found.</Banner>;

  const data = run.data;
  const live = data.status === 'running' || data.status === 'queued';

  const stop = async () => {
    setStopping(true);
    setStopError(null);
    try {
      await api.cancelRun(data.id);
    } catch (err) {
      setStopError((err as Error).message);
      setStopping(false);
    }
    run.reload();
  };

  return (
    <>
      <div className="page-head">
        <h1>
          Run #{data.id} <span className="dim">{data.command}</span>
        </h1>
        <div className="actions">
          {live && (
            <button className="small danger" disabled={stopping} onClick={() => void stop()}>
              {stopping ? 'Stopping…' : data.status === 'running' ? 'Stop run' : 'Cancel'}
            </button>
          )}
          <Link to="/runs" navigate={navigate}>
            Back to runs
          </Link>
        </div>
      </div>

      {stopError && <Banner tone="err">{stopError}</Banner>}
      {stopping && data.status === 'running' && (
        <Banner tone="warn">
          Stopping — the run finishes the book it is on and then stops. Anything it already applied
          stays applied, and this run's undo record covers exactly that much.
        </Banner>
      )}

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

      {/* A stopped run did what it was asked to; it is not a failure in red. */}
      {data.error && (
        <Banner tone={data.status === 'cancelled' ? 'warn' : 'err'}>{data.error}</Banner>
      )}

      {data.command === 'audit' && <FindingsPanel run={data} />}

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

/**
 * Every book the audit looked at, and what was wrong with each — if anything.
 *
 * Passes are listed, not omitted. A book absent from the report is
 * indistinguishable from one that was never scanned, and "which of my books
 * are fine" is as much a question as "which are broken". The counts double as
 * filters, so picking one narrows the table to the items behind it.
 *
 * The summary answers "how many", which on its own reads as an alarm and gives
 * nobody anything to do: every book is `unrated` until `rate` has run once, so
 * a first audit legitimately flags the whole library.
 */
function FindingsPanel({ run }: { run: Run }) {
  const [filter, setFilter] = useState<{ issue?: string; status?: 'issues' | 'clean' }>({});
  const [limit, setLimit] = useState(100);
  const meta = useAsync(() => api.meta(), []);
  const page = useAsync(
    () => api.findings(run.id, { ...filter, limit }),
    [run.id, filter.issue, filter.status, limit],
  );

  const counts = (run.summary?.issueCounts ?? {}) as Record<string, number>;
  const scanned = (run.summary?.scanned as number) ?? 0;
  const affected = (run.summary?.itemsWithIssues as number) ?? 0;
  const labels = new Map((meta.data?.auditIssues ?? []).map((i) => [i.code, i]));
  // Ordered by the server's own list, so the most serious issues lead rather
  // than whichever happened to be counted first.
  const present = (meta.data?.auditIssues ?? []).filter((i) => (counts[i.code] ?? 0) > 0);

  if (run.status === 'running' || run.status === 'queued') return null;

  const tone = (code: string) =>
    labels.get(code)?.severity === 'error' ? 'err' : labels.get(code)?.severity === 'warn' ? 'warn' : '';
  const chip = (active: boolean) => (active ? 'small primary' : 'small');
  const selected = filter.issue ?? filter.status ?? 'all';

  return (
    <div className="card">
      <h2>What the audit found</h2>

      <p className="hint">
        {affected} of {scanned} item(s) have at least one issue; {scanned - affected} passed every
        check.
      </p>

      <div className="actions" style={{ flexWrap: 'wrap', marginBottom: 12 }}>
        <button className={chip(selected === 'all')} onClick={() => setFilter({})}>
          Everything ({scanned})
        </button>
        <button
          className={chip(selected === 'issues')}
          onClick={() => setFilter({ status: 'issues' })}
        >
          With issues ({affected})
        </button>
        <button className={chip(selected === 'clean')} onClick={() => setFilter({ status: 'clean' })}>
          Passed ({scanned - affected})
        </button>
        {present.map((spec) => (
          <button
            key={spec.code}
            className={chip(selected === spec.code)}
            title={spec.code}
            onClick={() => setFilter({ issue: spec.code })}
          >
            {spec.label} ({counts[spec.code]})
          </button>
        ))}
      </div>

      {page.loading && !page.data && <Spinner />}
      {page.error && <Banner tone="err">{page.error}</Banner>}

      {page.data && page.data.findings.length === 0 && (
        <p className="hint">
          {selected === 'all'
            ? 'Nothing recorded for this run. Audits from before this version kept only the counts.'
            : 'No items match that filter.'}
        </p>
      )}

      {page.data && page.data.findings.length > 0 && (
        <>
          <table>
            <thead>
              <tr>
                <th>Title</th>
                <th>Author</th>
                <th>Issues</th>
              </tr>
            </thead>
            <tbody>
              {page.data.findings.map((finding) => (
                <FindingRow
                  key={finding.id}
                  finding={finding}
                  tone={tone}
                  label={(c) => labels.get(c)?.label ?? c}
                />
              ))}
            </tbody>
          </table>

          {page.data.total > page.data.findings.length && (
            <div className="actions">
              <button onClick={() => setLimit((n) => n + 200)}>
                Showing {page.data.findings.length} of {page.data.total} — show more
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function FindingRow({
  finding,
  tone,
  label,
}: {
  finding: Finding;
  tone: (code: string) => string;
  label: (code: string) => string;
}) {
  return (
    <tr>
      {/* The path is what someone needs to go and look at the book, and it is
          too long for a column of its own on most libraries. */}
      <td title={finding.path}>{finding.title}</td>
      <td className="dim">{finding.author ?? '—'}</td>
      <td>
        {finding.issues.length === 0 ? (
          <span className="badge ok">No issues</span>
        ) : (
          finding.issues.map((code) => (
            <span key={code} className={`badge ${tone(code)}`} style={{ marginRight: 4 }} title={code}>
              {label(code)}
            </span>
          ))
        )}
      </td>
    </tr>
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
