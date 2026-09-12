import { useState } from 'react';
import { api, type RunItem, type RunItemStatus, type Run, type RevertResult } from '../api';
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

      <RunItemsPanel run={data} />

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
 * Every book the run looked at, and what it had to say about each.
 *
 * Items it had nothing to do to are listed, not omitted. A book absent from the
 * report is indistinguishable from one that was never reached, and "which of my
 * books are fine" is as much a question as "which are not". The counts double
 * as filters, so picking one narrows the table to the items behind it.
 *
 * One panel for every command. The statuses are shared — something to do,
 * nothing to do, passed over — and only the wording differs, which the server
 * sends along with the vocabulary of codes so the browser keeps no copy of
 * either to drift out of date.
 */
function RunItemsPanel({ run }: { run: Run }) {
  const [filter, setFilter] = useState<{ code?: string; status?: RunItemStatus }>({});
  const [limit, setLimit] = useState(100);
  const meta = useAsync(() => api.meta(), []);
  // `run.status` is a dependency, not decoration. A run's rows are written as it
  // finishes, so a page opened while it was still going fetched nothing — and
  // without the status in here, nothing fetched again when it finished. The card
  // sat on "Nothing recorded for this run" until the page was reloaded.
  const page = useAsync(
    () => api.runItems(run.id, { ...filter, limit }),
    [run.id, run.status, filter.code, filter.status, limit],
  );

  if (run.status === 'running' || run.status === 'queued') return null;

  const totals = page.data?.totals;
  const labels = meta.data?.runItemLabels?.[run.command];
  // Audit codes carry a severity and a human label; every other command's are
  // bare words from its own vocabulary, humanized on the way out.
  const issues = new Map((meta.data?.auditIssues ?? []).map((i) => [i.code, i]));
  const codeLabel = (code: string) => issues.get(code)?.label ?? humanize(code);
  const tone = (code: string) =>
    issues.get(code)?.severity === 'error' ? 'err' : issues.get(code)?.severity === 'warn' ? 'warn' : '';

  // In the server's order where it has one — worst issue first — and by how
  // many items carry it otherwise, so the common case leads.
  const codes = Object.entries(totals?.byCode ?? {}).sort((a, b) => {
    const ranked = [...issues.keys()];
    const ia = ranked.indexOf(a[0]);
    const ib = ranked.indexOf(b[0]);
    if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    return b[1] - a[1];
  });

  const chip = (active: boolean) => (active ? 'small primary' : 'small');
  const selected = filter.code ?? filter.status ?? 'all';
  const statuses: RunItemStatus[] = ['action', 'clean', 'skipped'];

  if (totals && totals.total === 0) {
    return (
      <div className="card">
        <h2>What this run did</h2>
        <p className="hint">
          Nothing recorded for this run. Detail is kept for the ten most recent runs, and runs from
          before this version kept only the counts.
        </p>
      </div>
    );
  }

  return (
    <div className="card">
      <h2>What this run did</h2>

      {totals && labels && (
        <p className="hint">
          {totals.total} item(s) looked at — {totals.byStatus.action} with something to do,{' '}
          {totals.byStatus.clean} with nothing to do, {totals.byStatus.skipped} passed over.
        </p>
      )}

      <div className="actions" style={{ flexWrap: 'wrap', marginBottom: 12 }}>
        <button className={chip(selected === 'all')} onClick={() => setFilter({})}>
          Everything ({totals?.total ?? 0})
        </button>
        {labels &&
          statuses
            .filter((status) => (totals?.byStatus[status] ?? 0) > 0)
            .map((status) => (
              <button
                key={status}
                className={chip(selected === status)}
                onClick={() => setFilter({ status })}
              >
                {labels[status]} ({totals?.byStatus[status]})
              </button>
            ))}
        {codes.map(([code, count]) => (
          <button
            key={code}
            className={chip(selected === code)}
            title={code}
            onClick={() => setFilter({ code })}
          >
            {codeLabel(code)} ({count})
          </button>
        ))}
      </div>

      {page.loading && !page.data && <Spinner />}
      {page.error && <Banner tone="err">{page.error}</Banner>}

      {page.data && page.data.items.length === 0 && (
        <p className="hint">No items match that filter.</p>
      )}

      {page.data && page.data.items.length > 0 && (
        <>
          <table>
            <thead>
              <tr>
                <th>Title</th>
                <th>Author</th>
                <th>What happened</th>
              </tr>
            </thead>
            <tbody>
              {page.data.items.map((item) => (
                <ItemRow key={item.id} item={item} tone={tone} label={codeLabel} />
              ))}
            </tbody>
          </table>

          {page.data.total > page.data.items.length && (
            <div className="actions">
              <button onClick={() => setLimit((n) => n + 200)}>
                Showing {page.data.items.length} of {page.data.total} — show more
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * The codes say what kind of thing happened and the detail lines say what
 * actually happened to this book — "description: — → The story of… (from
 * googlebooks)". Both, because the chip is what you filter by and the line is
 * what you judge the change on.
 */
function ItemRow({
  item,
  tone,
  label,
}: {
  item: RunItem;
  tone: (code: string) => string;
  label: (code: string) => string;
}) {
  return (
    <tr>
      {/* The path is what someone needs to go and look at the book, and it is
          too long for a column of its own on most libraries. */}
      <td title={item.path}>{item.title}</td>
      <td className="dim">{item.author ?? '—'}</td>
      <td>
        <div>
          {item.codes.length === 0 ? (
            <span className={`badge ${item.status === 'clean' ? 'ok' : ''}`}>
              {item.status === 'clean' ? 'Nothing to do' : 'Passed over'}
            </span>
          ) : (
            item.codes.map((code) => (
              <span key={code} className={`badge ${tone(code)}`} style={{ marginRight: 4 }} title={code}>
                {label(code)}
              </span>
            ))
          )}
        </div>
        {item.detail.map((line, i) => (
          <div key={i} className="dim mono" style={{ fontSize: 12, marginTop: 2 }}>
            {line}
          </div>
        ))}
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
