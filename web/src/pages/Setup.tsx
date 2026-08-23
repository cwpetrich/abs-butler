import { useEffect, useState } from 'react';
import { api, type SetupState } from '../api';
import { Banner } from '../lib';

/**
 * First-run setup.
 *
 * Claiming happens as soon as the page opens: once this browser holds the
 * claim, nobody else can set the password, so the only window anyone could
 * race is the one before you got here.
 */
export function SetupPage({ setup, onSuccess }: { setup: SetupState; onSuccess: () => void }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [code, setCode] = useState('');
  const [claimError, setClaimError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [claimed, setClaimed] = useState(setup.mine);
  const [remaining, setRemaining] = useState<number | null>(null);

  useEffect(() => {
    if (claimed) return;
    void api
      .claimSetup()
      .then(() => setClaimed(true))
      .catch((err: Error) => setClaimError(err.message));
  }, [claimed]);

  useEffect(() => {
    if (!setup.expiresAt) {
      setRemaining(null);
      return;
    }
    const tick = () => setRemaining(Math.max(0, setup.expiresAt! - Date.now()));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [setup.expiresAt]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (password !== confirm) {
      setError('The two passwords do not match.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.completeSetup(password, code || undefined);
      onSuccess();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (claimError) {
    return (
      <div className="login-wrap">
        <div className="card login-card">
          <h2>📚 abs-butler</h2>
          <Banner tone="err">{claimError}</Banner>
          <button onClick={() => window.location.reload()} style={{ width: '100%' }}>
            Try again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="login-wrap">
      <form className="card login-card" onSubmit={submit}>
        <h2>📚 Welcome to abs-butler</h2>
        <p className="subtitle">Choose a password. You will use it to sign in from now on.</p>

        {remaining !== null && (
          <p className="hint">
            Setup stays open for {formatRemaining(remaining)}. If it closes, restart abs-butler to
            reopen it.
          </p>
        )}

        {setup.codeRequired && (
          <Banner tone="warn">
            A setup code is required. It is printed in the abs-butler startup log — or is the value
            of BUTLER_SETUP_CODE if you set one.
          </Banner>
        )}

        {error && <Banner tone="err">{error}</Banner>}

        {setup.codeRequired && (
          <label>
            Setup code
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="ABCD-2345"
              autoFocus
              required
            />
          </label>
        )}

        <label>
          Password
          <span className="hint">At least 8 characters.</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus={!setup.codeRequired}
            autoComplete="new-password"
            minLength={8}
            required
          />
        </label>

        <label>
          Confirm password
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            required
          />
        </label>

        <button
          className="primary"
          type="submit"
          disabled={busy || !claimed}
          style={{ width: '100%' }}
        >
          {busy ? 'Setting up…' : 'Set password and continue'}
        </button>
      </form>
    </div>
  );
}

function formatRemaining(ms: number): string {
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}
