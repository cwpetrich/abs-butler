import { describe, expect, it } from 'vitest';
import {
  detectDeployment,
  explainDenial,
  explainEmpty,
  REPAIR_COMMAND,
  explainMissing,
  explainReadonlyDatabase,
} from './deployment.js';
import type { MountEntry } from './mounts.js';

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

describe('explainMissing', () => {
  const mounts: MountEntry[] = [{ path: '/audiobooks', fsType: 'ext4', source: '/dev/vda1' }];

  it('keeps it plain outside a container', () => {
    expect(explainMissing('/srv/books', { deployment: 'native' })).toBe(
      '/srv/books does not exist on this machine',
    );
  });

  // AudiobookShelf's path typed into both fields: the setup this was written for.
  it('names what is mounted, and says when the path is AudiobookShelf\'s', () => {
    const reason = explainMissing('/nas/AudioBooks', { deployment: 'docker', mounts, serverPath: true });
    expect(reason).toContain('/nas/AudioBooks is not mounted in this container');
    expect(reason).toContain('path AudiobookShelf uses');
    expect(reason).toContain('mounted here at /audiobooks');
  });

  it('names the share behind a network mount', () => {
    const reason = explainMissing('/library', {
      deployment: 'docker',
      mounts: [{ path: '/audiobooks', fsType: 'cifs', source: '//nas/AudioBooks' }],
    });
    expect(reason).toContain('/audiobooks (cifs //nas/AudioBooks)');
  });

  it('says when nothing is mounted at all', () => {
    expect(explainMissing('/audiobooks', { deployment: 'docker', mounts: [] })).toContain(
      'Nothing is mounted',
    );
  });
});

describe('explainEmpty', () => {
  it('blames the unset HOST_LIBRARY_PATH when compose passed it through empty', () => {
    const reason = explainEmpty('/audiobooks', { deployment: 'docker', env: { HOST_LIBRARY_PATH: '' } });
    expect(reason).toContain('HOST_LIBRARY_PATH is not set');
  });

  it('warns that Docker Desktop cannot mount a mapped network drive', () => {
    for (const source of ['Z:\\AudioBooks', '\\\\nas\\AudioBooks', '//nas/AudioBooks']) {
      const reason = explainEmpty('/audiobooks', { deployment: 'docker', env: { HOST_LIBRARY_PATH: source } });
      expect(reason).toContain('mapped network drives');
    }
  });

  it('points at the folder itself when HOST_LIBRARY_PATH is set to something ordinary', () => {
    const reason = explainEmpty('/audiobooks', {
      deployment: 'docker',
      env: { HOST_LIBRARY_PATH: '/mnt/media/books' },
    });
    expect(reason).toContain('although HOST_LIBRARY_PATH is /mnt/media/books');
    expect(reason).not.toContain('mapped network drives');
  });

  it('names the volume when the installer mounted one, and hands over the repair', () => {
    const reason = explainEmpty('/nas', {
      deployment: 'docker',
      env: { BUTLER_LIBRARY_VOLUME: 'audiobookshelf_synology_media', HOST_LIBRARY_PATH: '' },
    });
    expect(reason).toContain('the Docker volume audiobookshelf_synology_media');
    expect(reason).not.toContain('HOST_LIBRARY_PATH');
    expect(reason).toContain(REPAIR_COMMAND);
  });

  it('makes no claim about HOST_LIBRARY_PATH outside Docker', () => {
    expect(explainEmpty('/srv/books', { deployment: 'native' })).not.toContain('HOST_LIBRARY_PATH');
  });
});

describe('explainDenial on an SMB share', () => {
  // A cifs mount invents ownership from its options, so PUID/PGID matching the
  // reported owner can be exactly right and still not write.
  it('points at the mount options rather than PUID/PGID', () => {
    const reason = explainDenial({
      path: '/audiobooks/Author',
      kind: 'not-writable',
      owner: OWNER,
      deployment: 'docker',
      mounts: [
        { path: '/', fsType: 'overlay', source: 'overlay' },
        { path: '/audiobooks', fsType: 'cifs', source: '//nas/AudioBooks' },
      ],
    });
    expect(reason).toContain('SMB share (//nas/AudioBooks)');
    expect(reason).toContain('file_mode=0664');
    expect(reason).not.toContain('PUID=');
  });
});
