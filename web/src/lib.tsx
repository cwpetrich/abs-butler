import { useCallback, useEffect, useRef, useState } from 'react';

// ---------------------------------------------------------------------------
// Routing — history-based, hand-rolled. The whole app has six routes, and the
// static server already falls back to index.html so deep links work.
// ---------------------------------------------------------------------------

export function useRoute(): [string, (path: string) => void] {
  const [path, setPath] = useState(window.location.pathname);

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = useCallback((next: string) => {
    if (next === window.location.pathname) return;
    window.history.pushState({}, '', next);
    setPath(next);
  }, []);

  return [path, navigate];
}

export function Link({
  to,
  navigate,
  className,
  children,
}: {
  to: string;
  navigate: (path: string) => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <a
      href={to}
      className={className}
      onClick={(event) => {
        // Let modified clicks open a new tab, as any real link would.
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

export interface AsyncState<T> {
  data: T | undefined;
  error: string | undefined;
  loading: boolean;
  reload: () => void;
}

/**
 * Loads data, optionally re-polling. `deps` controls when the loader is
 * rebuilt; the poll interval never re-triggers a render on its own.
 */
export function useAsync<T>(
  loader: () => Promise<T>,
  deps: unknown[] = [],
  options: { pollMs?: number } = {},
): AsyncState<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  useEffect(() => {
    let cancelled = false;

    const run = async (isInitial: boolean) => {
      if (isInitial) setLoading(true);
      try {
        const result = await loaderRef.current();
        if (cancelled) return;
        setData(result);
        setError(undefined);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      } finally {
        if (!cancelled && isInitial) setLoading(false);
      }
    };

    void run(true);

    if (!options.pollMs) return () => { cancelled = true; };
    const timer = setInterval(() => void run(false), options.pollMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce, options.pollMs]);

  return { data, error, loading, reload: () => setNonce((n) => n + 1) };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatTime(ms: number | null | undefined): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour12: false });
}

export function formatDuration(start: number | null, end: number | null): string {
  if (!start) return '—';
  const elapsed = (end ?? Date.now()) - start;
  if (elapsed < 1000) return `${elapsed}ms`;
  const seconds = Math.round(elapsed / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

export function formatInterval(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  if (minutes % (60 * 24) === 0) return `${minutes / (60 * 24)}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

// ---------------------------------------------------------------------------
// Small shared components
// ---------------------------------------------------------------------------

export function StatusBadge({ status }: { status: string }) {
  const tone =
    status === 'success' ? 'ok' : status === 'failed' ? 'err' : status === 'running' ? 'accent' : 'dim';
  return <span className={`badge ${tone}`}>{status}</span>;
}

export function Banner({ tone, children }: { tone: 'warn' | 'err'; children: React.ReactNode }) {
  return <div className={`banner ${tone}`}>{children}</div>;
}

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return <div className="spinner">{label}</div>;
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="empty">{children}</div>;
}
