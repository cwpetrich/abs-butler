import { useEffect, useState } from 'react';
import { api, type SecurityStatus, type Settings } from '../api';
import { Banner, Spinner, useAsync } from '../lib';

export function SettingsPage() {
  const loaded = useAsync(() => api.settings(), []);
  const [form, setForm] = useState<Settings | null>(null);
  const [googleKey, setGoogleKey] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (loaded.data) setForm(loaded.data.settings);
  }, [loaded.data]);

  if (loaded.loading || !form) return <Spinner />;
  if (loaded.error) return <Banner tone="err">{loaded.error}</Banner>;

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setForm((f) => (f ? { ...f, [key]: value } : f));

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setStatus(null);
    try {
      const { googleBooksApiKeySet: _ignored, ...rest } = form;
      await api.updateSettings({
        ...rest,
        // Blank leaves the stored key untouched, matching how server API keys behave.
        ...(googleKey ? { googleBooksApiKey: googleKey } : {}),
      });
      setGoogleKey('');
      setStatus('Settings saved.');
      loaded.reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="page-head">
        <h1>Settings</h1>
      </div>
      <p className="subtitle">
        Everything here is stored in the database and takes effect without a restart. Only the data
        directory and listen address stay environment variables.
      </p>

      {error && <Banner tone="err">{error}</Banner>}
      {status && <div className="banner" style={{ borderColor: 'var(--ok)', color: 'var(--ok)' }}>{status}</div>}

      <form onSubmit={save}>
        <div className="card">
          <h2>File changes</h2>
          <p className="hint">
            Only <span className="mono">organize</span> touches the filesystem. Audit, rate,
            metadata and normalize work purely over the AudiobookShelf API and are unaffected by
            this.
          </p>

          <label className="checkbox">
            <input
              type="checkbox"
              checked={form.allowFileChanges}
              onChange={(e) => set('allowFileChanges', e.target.checked)}
            />
            Allow file changes
          </label>

          {form.allowFileChanges ? (
            <Banner tone="warn">
              organize can now move files in your library when applied. Turning this back off
              afterwards keeps an accidental apply from doing anything.
            </Banner>
          ) : (
            <p className="hint">
              organize can still plan a reorganization and show you exactly what it would do —
              applying one is what gets refused, whether it comes from here, the CLI, or a schedule.
            </p>
          )}
        </div>

        <div className="card">
          <h2>Metadata rewriting</h2>
          <p className="hint">
            <span className="mono">normalize</span> is the only command that replaces metadata a
            person can already see — titles, authors, narrators and series names.{' '}
            <span className="mono">metadata</span> only fills fields that are blank, so it is not
            affected by this.
          </p>

          <label className="checkbox">
            <input
              type="checkbox"
              checked={form.allowMetadataRewrite}
              onChange={(e) => set('allowMetadataRewrite', e.target.checked)}
            />
            Allow metadata rewrite
          </label>

          {form.allowMetadataRewrite ? (
            <Banner tone="warn">
              normalize can now overwrite titles, authors, narrators and series names when applied.
              A provider answer is only used when an ASIN or ISBN matched exactly, but the library's
              own majority spelling is enough on its own — so review a dry run before applying.
            </Banner>
          ) : (
            <p className="hint">
              normalize can still show every change it would make — applying one is what gets
              refused, whether it comes from here, the CLI, or a schedule.
            </p>
          )}
        </div>

        <div className="card">
          <h2>Metadata providers</h2>

          <label>
            Google Books API key
            <span className="hint">
              {loaded.data?.settings.googleBooksApiKeySet
                ? 'A key is stored. Leave blank to keep it.'
                : 'Without a key, Google Books shares a per-IP quota that is usually exhausted, and ratings fall back to Open Library alone.'}
            </span>
            <input
              type="password"
              value={googleKey}
              onChange={(e) => setGoogleKey(e.target.value)}
              placeholder={loaded.data?.settings.googleBooksApiKeySet ? '••••••••' : 'not set'}
              autoComplete="new-password"
            />
          </label>

          <div className="field-grid">
            <label>
              Concurrent provider lookups
              <span className="hint">Higher is faster but more likely to be rate limited.</span>
              <input
                type="number"
                min={1}
                max={16}
                value={form.providerConcurrency}
                onChange={(e) => set('providerConcurrency', Number(e.target.value))}
              />
            </label>

            <label>
              Audible region
              <span className="hint">
                Which marketplace the two Audible sources are asked about. A book absent from it
                falls through to a title search, and the other providers answer alongside.
              </span>
              <select
                value={form.audibleRegion}
                onChange={(e) => set('audibleRegion', e.target.value)}
              >
                {['us', 'ca', 'uk', 'au', 'fr', 'de', 'jp', 'it', 'in', 'es'].map((region) => (
                  <option key={region} value={region}>
                    {region.toUpperCase()}
                  </option>
                ))}
              </select>
            </label>

            <label>
              Minimum rating confidence
              <span className="hint">
                Below this, an age band is recorded but no tag is written. 0.35 is the default.
              </span>
              <input
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={form.minConfidence}
                onChange={(e) => set('minConfidence', Number(e.target.value))}
              />
            </label>
          </div>
        </div>

        <div className="card">
          <h2>Retention</h2>
          <div className="field-grid">
            <label>
              Runs kept in history
              <input
                type="number"
                min={10}
                max={10000}
                value={form.historyLimit}
                onChange={(e) => set('historyLimit', Number(e.target.value))}
              />
            </label>

            <label>
              Log retention (days)
              <input
                type="number"
                min={1}
                max={365}
                value={form.logRetentionDays}
                onChange={(e) => set('logRetentionDays', Number(e.target.value))}
              />
            </label>

            <label>
              Provider cache (days)
              <span className="hint">
                How long an answer from a provider is reused instead of asked again. "Nothing found"
                expires at a quarter of this, since that usually reflects the library rather than
                the book.
              </span>
              <input
                type="number"
                min={1}
                max={365}
                value={form.lookupCacheDays}
                onChange={(e) => set('lookupCacheDays', Number(e.target.value))}
              />
            </label>
          </div>
        </div>

        <div className="actions">
          <button className="primary" type="submit" disabled={saving}>
            {saving ? 'Saving…' : 'Save settings'}
          </button>
        </div>
      </form>

      <PasswordCard />
      {loaded.data && <SecurityCard security={loaded.data.security} onRotated={loaded.reload} />}
    </>
  );
}

function PasswordCard() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (next !== confirm) {
      setError('The two new passwords do not match.');
      return;
    }
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      await api.changePassword(current, next);
      setCurrent('');
      setNext('');
      setConfirm('');
      setStatus('Password changed. Any other signed-in browser has been signed out.');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card" onSubmit={submit}>
      <h2>Password</h2>
      <p className="hint">
        Changing it signs out every other browser, since the usual reason to change a password is
        that someone else may have it.
      </p>
      {error && <Banner tone="err">{error}</Banner>}
      {status && (
        <div className="banner" style={{ borderColor: 'var(--ok)', color: 'var(--ok)' }}>
          {status}
        </div>
      )}

      <label>
        Current password
        <input
          type="password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          autoComplete="current-password"
          required
        />
      </label>

      <div className="field-grid">
        <label>
          New password
          <span className="hint">At least 8 characters.</span>
          <input
            type="password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            autoComplete="new-password"
            minLength={8}
            required
          />
        </label>
        <label>
          Confirm new password
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            required
          />
        </label>
      </div>

      <div className="actions">
        <button className="primary" type="submit" disabled={busy}>
          {busy ? 'Changing…' : 'Change password'}
        </button>
      </div>
    </form>
  );
}

function SecurityCard({
  security,
  onRotated,
}: {
  security: SecurityStatus;
  onRotated: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const rotate = async () => {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      await api.rotateKey();
      setConfirming(false);
      setStatus('Encryption key rotated. The stored API token was re-encrypted under the new key.');
      onRotated();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h2>Encryption</h2>
      <p className="hint">
        The AudiobookShelf API token is sealed with AES-256-GCM before it is written to the
        database, so a copy of the database is not a copy of your credentials.
      </p>

      {error && <Banner tone="err">{error}</Banner>}
      {status && (
        <div className="banner" style={{ borderColor: 'var(--ok)', color: 'var(--ok)' }}>
          {status}
        </div>
      )}

      <table>
        <tbody>
          <tr>
            <td>Key source</td>
            <td className="mono">
              {security.keySource === 'env' ? 'BUTLER_SECRET' : security.keyPath}
            </td>
          </tr>
          <tr>
            <td>Stored API token</td>
            <td>
              <span className={`badge ${security.apiKeyEncrypted ? 'ok' : 'warn'}`}>
                {security.apiKeyEncrypted ? 'encrypted' : 'not stored'}
              </span>
            </td>
          </tr>
        </tbody>
      </table>

      {security.keySource === 'env' ? (
        <p className="hint" style={{ marginTop: 12 }}>
          The key comes from BUTLER_SECRET, so it is managed outside abs-butler and cannot be
          rotated here.
        </p>
      ) : confirming ? (
        <div className="actions">
          <button className="danger" onClick={rotate} disabled={busy}>
            {busy ? 'Rotating…' : 'Yes, rotate the key'}
          </button>
          <button onClick={() => setConfirming(false)}>Cancel</button>
        </div>
      ) : (
        <div className="actions">
          <button onClick={() => setConfirming(true)}>Rotate encryption key</button>
        </div>
      )}
    </div>
  );
}
