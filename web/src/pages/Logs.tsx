import { useState } from 'react';
import { api } from '../api';
import { Banner, Empty, formatTime, Link, Spinner, useAsync } from '../lib';

const LEVELS = ['error', 'warn', 'success', 'info', 'debug'];

export function LogsPage({ navigate }: { navigate: (path: string) => void }) {
  const [level, setLevel] = useState('');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');

  const logs = useAsync(
    () => api.logs({ level, search: query, limit: 500 }),
    [level, query],
    { pollMs: 5000 },
  );

  return (
    <>
      <div className="page-head">
        <h1>Logs</h1>
      </div>
      <p className="subtitle">
        Every line from every run, newest last. Use the run link to see one job in isolation.
      </p>

      <div className="card">
        <form
          className="actions"
          style={{ marginBottom: 12 }}
          onSubmit={(event) => {
            event.preventDefault();
            setQuery(search);
          }}
        >
          <select value={level} onChange={(e) => setLevel(e.target.value)} style={{ width: 'auto' }}>
            <option value="">All levels</option>
            {LEVELS.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
          <input
            placeholder="Search messages…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ width: 260 }}
          />
          <button type="submit">Search</button>
          {query && (
            <button
              type="button"
              onClick={() => {
                setSearch('');
                setQuery('');
              }}
            >
              Clear
            </button>
          )}
        </form>

        {logs.error && <Banner tone="err">{logs.error}</Banner>}
        {logs.loading && <Spinner />}
        {logs.data?.logs.length === 0 && <Empty>No log entries match.</Empty>}

        {(logs.data?.logs.length ?? 0) > 0 && (
          <div className="log-view">
            {logs.data!.logs.map((entry) => (
              <div className="log-line" key={entry.id}>
                <span className="log-time">{formatTime(entry.ts)}</span>
                <span className={`log-level ${entry.level}`}>{entry.level}</span>
                {entry.runId !== null && (
                  <Link to={`/runs/${entry.runId}`} navigate={navigate}>
                    #{entry.runId}
                  </Link>
                )}
                <span>{entry.message}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
