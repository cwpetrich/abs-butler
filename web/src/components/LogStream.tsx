import { useEffect, useRef, useState } from 'react';
import { api, type LogEntry } from '../api';
import { formatClock } from '../lib';

/**
 * Incrementally tails a run's log.
 *
 * Only entries newer than the last seen id are fetched, so a long run does not
 * re-download thousands of lines every poll. Auto-scroll releases as soon as the
 * reader scrolls up, and re-engages when they return to the bottom.
 */
export function LogStream({ runId, live }: { runId: number; live: boolean }) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
  const lastIdRef = useRef(0);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLogs([]);
    lastIdRef.current = 0;
  }, [runId]);

  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      try {
        const result = await api.logs({ runId, afterId: lastIdRef.current, limit: 1000 });
        if (cancelled || result.logs.length === 0) return;
        lastIdRef.current = result.logs[result.logs.length - 1]!.id;
        setLogs((previous) => [...previous, ...result.logs]);
        setError(null);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    };

    void poll();
    if (!live) return () => { cancelled = true; };

    const timer = setInterval(() => void poll(), 1500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [runId, live]);

  useEffect(() => {
    if (!follow || !boxRef.current) return;
    boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [logs, follow]);

  const onScroll = () => {
    const box = boxRef.current;
    if (!box) return;
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    setFollow(atBottom);
  };

  if (error) return <div className="banner err">{error}</div>;
  if (logs.length === 0) {
    return <div className="empty">{live ? 'Waiting for output…' : 'No log output for this run.'}</div>;
  }

  return (
    <>
      <div className="log-view" ref={boxRef} onScroll={onScroll}>
        {logs.map((entry) => (
          <div className="log-line" key={entry.id}>
            <span className="log-time">{formatClock(entry.ts)}</span>
            <span className={`log-level ${entry.level}`}>{entry.level}</span>
            <span>{entry.message}</span>
          </div>
        ))}
      </div>
      {live && !follow && (
        <button className="small" style={{ marginTop: 8 }} onClick={() => setFollow(true)}>
          Resume auto-scroll
        </button>
      )}
    </>
  );
}
