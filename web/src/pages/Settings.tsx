import { useEffect, useRef, useState } from 'react';
import { api, type Meta, type SecurityStatus, type Settings } from '../api';
import { TemplateHelp } from '../components/TemplateHelp';
import { Banner, Spinner, useAsync } from '../lib';

/**
 * Every setting saves itself the moment it changes. There used to be one Save
 * button at the foot of a long page, and a switch ticked and never saved looks
 * exactly like one that is on — until a run is refused for it.
 *
 * Switches and choices save on click. Typed fields save when they are left or
 * Enter is pressed, so a half-typed number is never sent; one the server turns
 * down goes back to what is stored, with the reason.
 */
export function SettingsPage({ meta }: { meta: Meta | undefined }) {
  const loaded = useAsync(() => api.settings(), []);
  // `form` is what is on screen; `saved` is what the server last said is stored.
  const [form, setForm] = useState<Settings | null>(null);
  const [saved, setSaved] = useState<Settings | null>(null);
  const [googleKey, setGoogleKey] = useState('');
  const [saveState, setSaveState] = useState<
    { kind: 'saving' } | { kind: 'saved' } | { kind: 'error'; message: string } | null
  >(null);
  const pending = useRef(0);

  // "Saved" is a confirmation, not a state to keep on screen; an error stays
  // until the next change.
  useEffect(() => {
    if (saveState?.kind !== 'saved') return;
    const timer = setTimeout(() => setSaveState(null), 2000);
    return () => clearTimeout(timer);
  }, [saveState]);

  useEffect(() => {
    if (loaded.data) {
      setForm(loaded.data.settings);
      setSaved(loaded.data.settings);
    }
  }, [loaded.data]);

  if (loaded.loading || !form || !saved) return <Spinner />;
  if (loaded.error) return <Banner tone="err">{loaded.error}</Banner>;

  const commit = async (patch: Partial<Settings> & { googleBooksApiKey?: string }) => {
    pending.current += 1;
    setSaveState({ kind: 'saving' });
    const keys = Object.keys(patch).filter((key) => key !== 'googleBooksApiKey') as Array<keyof Settings>;
    try {
      const { settings } = await api.updateSettings(patch);
      setSaved(settings);
      // Only the fields this save was for: another field may be mid-edit.
      setForm((f) =>
        f
          ? { ...f, ...Object.fromEntries(keys.map((key) => [key, settings[key]])), googleBooksApiKeySet: settings.googleBooksApiKeySet }
          : f,
      );
      pending.current -= 1;
      if (pending.current === 0) setSaveState({ kind: 'saved' });
    } catch (err) {
      pending.current -= 1;
      setSaveState({ kind: 'error', message: (err as Error).message });
      setForm((f) => (f ? { ...f, ...Object.fromEntries(keys.map((key) => [key, saved[key]])) } : f));
    }
  };

  /** A switch or a choice: shown and saved at once. */
  const choose = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setForm((f) => (f ? { ...f, [key]: value } : f));
    void commit({ [key]: value } as Partial<Settings>);
  };

  /** A typed field: shown as typed, saved when it is left. */
  const type = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setForm((f) => (f ? { ...f, [key]: value } : f));

  const settle = (key: keyof Settings) => {
    if (form[key] !== saved[key]) void commit({ [key]: form[key] } as Partial<Settings>);
  };

  /** What a typed field needs to save when it is left, or on Enter. */
  const saveOnLeave = (key: keyof Settings) => ({
    onBlur: () => settle(key),
    onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter') event.currentTarget.blur();
    },
  });

  const saveGoogleKey = () => {
    // Blank leaves the stored key untouched, matching how server API keys behave.
    if (!googleKey) return;
    const key = googleKey;
    setGoogleKey('');
    void commit({ googleBooksApiKey: key });
  };

  return (
    <>
      <div className="page-head">
        <h1>Settings</h1>
      </div>
      <p className="subtitle">
        Everything here is stored in the database as soon as you change it — a switch when it is
        clicked, a typed value when you leave the field — and takes effect without a restart. Only
        the data directory and listen address stay environment variables.
      </p>

      {/* Fixed to the corner: the page is long, and the change that needs
          confirming is usually far from the top of it. */}
      {saveState && (
        <div className={`save-status ${saveState.kind}`} role="status" aria-live="polite">
          {saveState.kind === 'saving'
            ? 'Saving…'
            : saveState.kind === 'saved'
              ? 'Saved'
              : `Not saved: ${saveState.message}`}
        </div>
      )}

      <div>
        <div className="card">
          <h2>File changes</h2>
          <p className="hint">
            <span className="mono">organize</span> moves files, and{' '}
            <span className="mono">repair</span> may update one file's modified time — the gentlest
            way to mend a one-file book. Audit, rate, metadata and normalize work purely over the
            AudiobookShelf API and are unaffected by this.
          </p>

          <label className="checkbox">
            <input
              type="checkbox"
              checked={form.allowFileChanges}
              onChange={(e) => choose('allowFileChanges', e.target.checked)}
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
          <h2>Organizing</h2>

          <label>
            Path template
            <span className="hint">
              The folder layout <span className="mono">organize</span> uses for every run and
              schedule, unless a run is given its own.
            </span>
            <input
              className="mono"
              value={form.organizeTemplate}
              onChange={(e) => type('organizeTemplate', e.target.value)}
              {...saveOnLeave('organizeTemplate')}
              placeholder={meta?.defaultTemplate}
            />
          </label>

          <TemplateHelp help={meta?.templateHelp} />
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
              onChange={(e) => choose('allowMetadataRewrite', e.target.checked)}
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
          <h2>Track repair</h2>
          <p className="hint">
            <span className="mono">repair</span> removes audio records whose files are gone — left
            behind when a library moves to new storage, they make every book list each file twice and
            play at double length. It rewrites the track list and rescans the item; it never changes
            what is in a file.
          </p>

          <label className="checkbox">
            <input
              type="checkbox"
              checked={form.allowTrackRepair}
              onChange={(e) => choose('allowTrackRepair', e.target.checked)}
            />
            Allow track repair
          </label>

          {form.allowTrackRepair ? (
            <Banner tone="warn">
              repair can now rewrite track lists when applied. A book with more than one file is
              mended over the API alone. A one-file book has one of its files touched when file
              changes are allowed, and otherwise has its track list emptied and rebuilt by a rescan.
              Every repair can be put back with revert.
            </Banner>
          ) : (
            <p className="hint">
              repair can still find every damaged book and show how it would mend each — applying
              is what gets refused, whether it comes from here, the CLI, or a schedule.
            </p>
          )}
        </div>

        <div className="card">
          <h2>Auditing</h2>

          <label className="checkbox">
            <input
              type="checkbox"
              checked={form.crossFormatDuplicates}
              onChange={(e) => choose('crossFormatDuplicates', e.target.checked)}
            />
            Count an ebook and an audiobook as duplicates
          </label>

          <p className="hint">
            Off by default: the EPUB and the audiobook of the same book are one book in two formats,
            not a mistake, and a duplicate warning is something people act on. Two copies of the
            same format are always reported, whatever this says.
          </p>
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
              onBlur={saveGoogleKey}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
              }}
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
                onChange={(e) => type('providerConcurrency', Number(e.target.value))}
                {...saveOnLeave('providerConcurrency')}
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
                onChange={(e) => choose('audibleRegion', e.target.value)}
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
                onChange={(e) => type('minConfidence', Number(e.target.value))}
                {...saveOnLeave('minConfidence')}
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
                onChange={(e) => type('historyLimit', Number(e.target.value))}
                {...saveOnLeave('historyLimit')}
              />
            </label>

            <label>
              Log retention (days)
              <input
                type="number"
                min={1}
                max={365}
                value={form.logRetentionDays}
                onChange={(e) => type('logRetentionDays', Number(e.target.value))}
                {...saveOnLeave('logRetentionDays')}
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
                onChange={(e) => type('lookupCacheDays', Number(e.target.value))}
                {...saveOnLeave('lookupCacheDays')}
              />
            </label>
          </div>
        </div>
      </div>

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
