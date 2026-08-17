import { useEffect, useState } from 'react';
import { api, type Settings } from '../api';
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
        These apply to every server. Values that must exist before startup — the listen address,
        password, and encryption secret — stay environment variables.
      </p>

      {!loaded.data?.encryptionEnabled && (
        <Banner tone="warn">
          BUTLER_SECRET is not set, so AudiobookShelf API keys are stored unencrypted. Set it and
          re-enter each key to seal them.
        </Banner>
      )}
      {!loaded.data?.authRequired && (
        <Banner tone="warn">
          No BUTLER_PASSWORD is set, so this UI is unauthenticated. Anyone who can reach this port
          can manage your servers.
        </Banner>
      )}
      {error && <Banner tone="err">{error}</Banner>}
      {status && <div className="banner" style={{ borderColor: 'var(--ok)', color: 'var(--ok)' }}>{status}</div>}

      <form onSubmit={save}>
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
          </div>
        </div>

        <div className="actions">
          <button className="primary" type="submit" disabled={saving}>
            {saving ? 'Saving…' : 'Save settings'}
          </button>
        </div>
      </form>
    </>
  );
}
