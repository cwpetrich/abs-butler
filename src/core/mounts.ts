import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * What is mounted into this process's view of the filesystem.
 *
 * Under Docker the library is only ever where a volume put it, so the mount
 * table is the honest answer to "where could the media be?" — it is what lets a
 * missing path be explained as "not mounted; /audiobooks is" rather than a bare
 * "does not exist", and it is where path discovery looks for the books.
 *
 * Linux only. Elsewhere there is no /proc, and the list is simply empty.
 */

export interface MountEntry {
  /** Where it is mounted, as this process sees it. */
  path: string;
  fsType: string;
  /** The device or share, e.g. //192.168.1.50/AudioBooks for a cifs mount. */
  source: string;
}

/** Filesystems that are never where a library lives. */
const SYSTEM_FS = new Set([
  'proc',
  'sysfs',
  'cgroup',
  'cgroup2',
  'devpts',
  'devtmpfs',
  'mqueue',
  'securityfs',
  'debugfs',
  'tracefs',
  'pstore',
  'bpf',
  'nsfs',
  'binfmt_misc',
  'configfs',
  'fusectl',
  'hugetlbfs',
  // A snap's squashfs images and autofs triggers: the first is never media, and
  // merely stat-ing under the second can block while it mounts something.
  'squashfs',
  'autofs',
]);

const SYSTEM_ROOTS = ['/proc', '/sys', '/dev', '/etc', '/boot', '/snap', '/usr', '/var/lib/docker', '/var/snap'];

/** Network filesystems, named as such because they fail in their own ways. */
export const NETWORK_FS = new Set(['cifs', 'smb3', 'nfs', 'nfs4', 'fuse.sshfs']);

/** mountinfo escapes space, tab, newline and backslash as octal. */
function unescape(field: string): string {
  return field.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
}

/**
 * Parses /proc/self/mountinfo. The format is fixed-position up to a variable
 * run of optional fields, terminated by a lone "-":
 *
 *   36 35 98:0 /mnt1 /mnt2 rw,noatime master:1 - ext3 /dev/root rw
 */
export function parseMountInfo(text: string): MountEntry[] {
  const mounts: MountEntry[] = [];
  for (const line of text.split('\n')) {
    const fields = line.trim().split(' ');
    const separator = fields.indexOf('-');
    if (fields.length < 5 || separator < 6) continue;
    mounts.push({
      path: unescape(fields[4]!),
      fsType: fields[separator + 1] ?? '',
      source: unescape(fields[separator + 2] ?? ''),
    });
  }
  return mounts;
}

export function readMounts(): MountEntry[] {
  try {
    return parseMountInfo(readFileSync('/proc/self/mountinfo', 'utf8'));
  } catch {
    return [];
  }
}

function under(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

/**
 * The mounts that could plausibly hold a library: not the root filesystem, not
 * kernel or system mounts, and not abs-butler's own data directory.
 */
export function libraryMounts(mounts: MountEntry[] = readMounts(), dataDir?: string): MountEntry[] {
  const data = dataDir ?? (process.env.BUTLER_DATA_DIR ? resolve(process.env.BUTLER_DATA_DIR) : null);
  const seen = new Set<string>();
  return mounts.filter((m) => {
    if (m.path === '/' || SYSTEM_FS.has(m.fsType)) return false;
    // /run is system, except where desktop Linux mounts removable media.
    if (under(m.path, '/run') && !under(m.path, '/run/media')) return false;
    if (SYSTEM_ROOTS.some((root) => under(m.path, root))) return false;
    if (data && under(m.path, data)) return false;
    // A path mounted over twice appears twice in the table; list it once.
    if (seen.has(m.path)) return false;
    seen.add(m.path);
    return true;
  });
}

/** The mount a path lives on: the deepest one containing it. */
export function mountFor(path: string, mounts: MountEntry[] = readMounts()): MountEntry | null {
  let best: MountEntry | null = null;
  for (const mount of mounts) {
    if ((mount.path === '/' || under(path, mount.path)) && mount.path.length >= (best?.path.length ?? -1)) {
      best = mount;
    }
  }
  return best;
}

/** "/audiobooks", or "/audiobooks (cifs //nas/AudioBooks)" when the source says something. */
export function describeMount(mount: MountEntry): string {
  return NETWORK_FS.has(mount.fsType) ? `${mount.path} (${mount.fsType} ${mount.source})` : mount.path;
}
