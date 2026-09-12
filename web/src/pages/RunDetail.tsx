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

      <RunItemsPanel run={data} navigate={navigate} />

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
 *
 * It is also where a report gets acted on. A dry run worked out exactly what it
 * would write to each book and, until now, the only way to say yes to it was to
 * run the whole thing again and hope for the same answers. Every row that still
 * has something waiting can be ticked, and the whole report can be applied at
 * once — the same operation either way, with a shorter list.
 */
function RunItemsPanel({ run, navigate }: { run: Run; navigate: (path: string) => void }) {
  const [filter, setFilter] = useState<{ code?: string; status?: RunItemStatus }>({});
  const [limit, setLimit] = useState(100);
  // Books picked out of the report by hand. Kept by item id rather than by row,
  // so a selection survives changing the filter underneath it — picking three
  // books out of *Adult* and two out of *Held back* is one apply, not two.
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState<{ items?: string[]; count: number } | null>(null);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
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

  // How much of what this run decided is still waiting to be carried out. Zero
  // for an audit, which decides nothing to write, and zero for a run that has
  // already written everything it planned.
  const appliable = totals?.appliable ?? 0;
  const rows = page.data?.items ?? [];
  const selectable = rows.filter((item) => item.canApply);
  const allPicked = selectable.length > 0 && selectable.every((item) => picked.has(item.itemId));

  const toggle = (itemId: string) =>
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });

  // Select-all covers what is on screen, not the whole report — the report has
  // its own button, and a tick box that silently reached past the filter would
  // be the easiest way to apply something nobody had looked at.
  const toggleAll = () =>
    setPicked((current) => {
      const next = new Set(current);
      for (const item of selectable) {
        if (allPicked) next.delete(item.itemId);
        else next.add(item.itemId);
      }
      return next;
    });

  const apply = async () => {
    if (!confirming) return;
    setApplying(true);
    setApplyError(null);
    try {
      // A run of its own, queued behind whatever else is running: it writes to
      // AudiobookShelf, which is exactly the work the runner serializes. The
      // new run's page is where its log and its undo record live.
      const created = await api.applyRun(run.id, {
        ...(confirming.items ? { items: confirming.items } : {}),
        apply: true,
      });
      navigate(`/runs/${created.id}`);
    } catch (err) {
      setApplyError((err as Error).message);
      setApplying(false);
      setConfirming(null);
    }
  };

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

      {/* A stopped run reports what it got through, and the rest are absent
          rather than fine. Saying so is the difference between a short report
          and a clean library. */}
      {run.status === 'cancelled' && Number(run.summary?.notReached ?? 0) > 0 && (
        <p className="hint">
          Stopped before the end: {String(run.summary?.notReached)} more item(s) were never reached,
          so they are not listed here.
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

      {appliable > 0 && (
        <ApplyBar
          run={run}
          appliable={appliable}
          picked={picked}
          confirming={confirming}
          applying={applying}
          error={applyError}
          onConfirm={setConfirming}
          onClear={() => setPicked(new Set())}
          onApply={() => void apply()}
        />
      )}

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
                {appliable > 0 && (
                  <th style={{ width: 28 }}>
                    <input
                      type="checkbox"
                      checked={allPicked}
                      disabled={selectable.length === 0}
                      onChange={toggleAll}
                      title={allPicked ? 'Clear these' : 'Pick every book shown'}
                      aria-label="Pick every book shown"
                    />
                  </th>
                )}
                <th>Title</th>
                <th>Author</th>
                <th>What happened</th>
              </tr>
            </thead>
            <tbody>
              {page.data.items.map((item) => (
                <ItemRow
                  key={item.id}
                  item={item}
                  tone={tone}
                  label={codeLabel}
                  {...(appliable > 0
                    ? { picked: picked.has(item.itemId), onToggle: () => toggle(item.itemId) }
                    : {})}
                />
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
 * Saying yes to a report.
 *
 * Two buttons for one operation: the whole report, or the books that have been
 * ticked. They are the same request with a different list, so there is no way
 * for "apply everything" and "apply these three" to disagree about what a
 * change was.
 *
 * Nothing is written on the first click. What follows is a plain sentence about
 * what is about to happen to the library and whether it can be taken back —
 * which differs sharply between rewriting metadata and moving files, so it is
 * worded per command rather than in one line that has to cover both.
 */
function ApplyBar({
  run,
  appliable,
  picked,
  confirming,
  applying,
  error,
  onConfirm,
  onClear,
  onApply,
}: {
  run: Run;
  appliable: number;
  picked: Set<string>;
  confirming: { items?: string[]; count: number } | null;
  applying: boolean;
  error: string | null;
  onConfirm: (value: { items?: string[]; count: number } | null) => void;
  onClear: () => void;
  onApply: () => void;
}) {
  const moves = run.command === 'organize';

  return (
    <>
      {error && <Banner tone="err">{error}</Banner>}

      <p className="hint">
        {run.dryRun
          ? `This was a dry run, and what it decided is still here — ${appliable} book(s) waiting.`
          : `${appliable} book(s) from this run were never written.`}{' '}
        Apply them as they are, or tick the ones you want. Nothing is looked up again: this carries
        out exactly the changes listed below, and skips any book that has changed since.
      </p>

      {confirming ? (
        <div className="banner" style={{ borderColor: 'var(--warn)' }}>
          <div>
            {confirming.items
              ? `Apply the ${confirming.count} book(s) you picked?`
              : `Apply all ${confirming.count} recorded change(s)?`}{' '}
            {moves
              ? 'This moves folders on disk and triggers a rescan. Moves are not undoable — ' +
                'abs-butler records no way back from a file move.'
              : 'This writes to AudiobookShelf as a new run, which records how to put every ' +
                'change back.'}
          </div>
          <div className="actions" style={{ marginTop: 10 }}>
            <button className="primary" type="button" disabled={applying} onClick={onApply}>
              {applying ? 'Starting…' : `Apply ${confirming.count} book(s)`}
            </button>
            <button type="button" disabled={applying} onClick={() => onConfirm(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="actions" style={{ flexWrap: 'wrap', marginBottom: 12 }}>
          <button
            className={picked.size > 0 ? '' : 'primary'}
            type="button"
            onClick={() => onConfirm({ count: appliable })}
          >
            Apply all {appliable} change(s)
          </button>
          {picked.size > 0 && (
            <>
              <button
                className="primary"
                type="button"
                onClick={() => onConfirm({ items: [...picked], count: picked.size })}
              >
                Apply {picked.size} selected
              </button>
              <button className="small" type="button" onClick={onClear}>
                Clear selection
              </button>
            </>
          )}
        </div>
      )}
    </>
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
  picked,
  onToggle,
}: {
  item: RunItem;
  tone: (code: string) => string;
  label: (code: string) => string;
  /** Absent where this run has nothing left to apply, and the column with it. */
  picked?: boolean;
  onToggle?: () => void;
}) {
  return (
    <tr>
      {onToggle && (
        // Empty rather than disabled where there is nothing waiting: a box that
        // cannot be ticked invites working out why, and the answer — this book
        // is already done, or was never going to change — is in the row itself.
        <td>
          {item.canApply && (
            <input
              type="checkbox"
              checked={Boolean(picked)}
              onChange={onToggle}
              aria-label={`Apply the change to ${item.title}`}
            />
          )}
        </td>
      )}
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
