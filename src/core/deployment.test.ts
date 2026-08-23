import { describe, expect, it } from 'vitest';
import { detectDeployment, explainDenial, explainReadonlyDatabase } from './deployment.js';

const OWNER = { uid: 1000, gid: 1003, mode: 0o40750 };

describe('detectDeployment', () => {
  it('recognises a snap by the pair of variables snapd always sets', () => {
    const restore = { ...process.env };
    process.env.SNAP = '/snap/abs-butler/12';
    process.env.SNAP_NAME = 'abs-butler';
    try {
      expect(detectDeployment()).toBe('snap');
    } finally {
      process.env = restore;
    }
  });

  // SNAP alone is something a user could plausibly have exported themselves.
  it('does not call it a snap on SNAP alone', () => {
    const restore = { ...process.env };
    process.env.SNAP = '/snap/abs-butler/12';
    delete process.env.SNAP_NAME;
    try {
      expect(detectDeployment()).not.toBe('snap');
    } finally {
      process.env = restore;
    }
  });
});

describe('explainDenial', () => {
  it('tells a snap user the exact connect command for media under /mnt', () => {
    const reason = explainDenial({
      path: '/mnt/external1/Audiobooks',
      kind: 'not-writable',
      owner: OWNER,
      deployment: 'snap',
    });
    expect(reason).toContain('snap connect abs-butler:removable-media');
  });

  // No interface reaches outside /mnt, /media, /run/media, so offering the
  // connect command there would send someone chasing a fix that cannot work.
  it('tells a snap user to bind-mount when the path is outside reach', () => {
    const reason = explainDenial({
      path: '/srv/audiobooks',
      kind: 'not-writable',
      owner: OWNER,
      deployment: 'snap',
    });
    expect(reason).toContain('Bind-mount');
    expect(reason).not.toContain('snap connect');
  });

  it('names the PUID and PGID a Docker user needs, rather than describing them', () => {
    const reason = explainDenial({
      path: '/audiobooks',
      kind: 'not-writable',
      owner: OWNER,
      deployment: 'docker',
    });
    expect(reason).toContain('PUID=1000');
    expect(reason).toContain('PGID=1003');
  });

  it('reports the owner and mode of the directory it could not write', () => {
    const reason = explainDenial({
      path: '/srv/audiobooks',
      kind: 'not-writable',
      owner: OWNER,
      deployment: 'native',
    });
    expect(reason).toContain('uid 1000, gid 1003, mode 0750');
  });

  // The failure that looks like a missing directory but is not one.
  it('does not claim a hidden path is missing', () => {
    const reason = explainDenial({
      path: '/mnt/external1/Audiobooks',
      kind: 'not-visible',
      deployment: 'snap',
    });
    expect(reason).toContain('snap connect abs-butler:removable-media');
    expect(reason).not.toMatch(/does not exist/);
  });

  it('survives having no ownership to report', () => {
    const reason = explainDenial({ path: '/audiobooks', kind: 'not-writable', deployment: 'docker' });
    expect(reason).toContain('/audiobooks');
    expect(reason).not.toContain('undefined');
  });
});

describe('explainDenial, native ownership nuances', () => {
  // Suggesting "run as uid N" when we already are uid N is noise; at that point
  // only the permission bits can be at fault.
  it('points at the mode when abs-butler already owns the directory', () => {
    const uid = process.getuid?.();
    if (uid === undefined) return;
    const reason = explainDenial({
      path: '/srv/audiobooks',
      kind: 'not-writable',
      owner: { uid, gid: 1003, mode: 0o40500 },
      deployment: 'native',
    });
    expect(reason).toContain('chmod u+w');
    expect(reason).not.toContain('Either run abs-butler as');
  });

  it('suggests the owning group when a different user owns the directory', () => {
    const uid = process.getuid?.();
    if (uid === undefined) return;
    const reason = explainDenial({
      path: '/srv/audiobooks',
      kind: 'not-writable',
      owner: { uid: uid + 1, gid: 1003, mode: 0o40750 },
      deployment: 'native',
    });
    expect(reason).toContain('gid 1003');
    expect(reason).not.toContain('chmod u+w');
  });
});

describe('explainReadonlyDatabase', () => {
  it('tells a snap user to use sudo, and why reads worked', () => {
    if (process.getuid?.() === 0) return;
    const hint = explainReadonlyDatabase('/var/snap/abs-butler/common', 'snap');
    expect(hint).toContain('sudo');
    expect(hint).toContain('/var/snap/abs-butler/common');
  });

  // Running as root, a readonly database means something else entirely — a
  // read-only mount, say — so the sudo advice would be a wrong turn.
  it('says nothing when already running as root', () => {
    const uid = process.getuid?.();
    if (uid !== 0) return;
    expect(explainReadonlyDatabase('/var/snap/abs-butler/common', 'snap')).toBeNull();
  });

  it('reports the running identity for a native install', () => {
    if (process.getuid?.() === 0) return;
    expect(explainReadonlyDatabase('/srv/butler', 'native')).toContain('uid');
  });
});
