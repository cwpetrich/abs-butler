import { existsSync } from 'node:fs';
import { describeMount, libraryMounts, mountFor, type MountEntry } from './mounts.js';

/**
 * Which of the three supported installs this process is running under.
 *
 * abs-butler ships natively, as a Docker image, and as a snap. All three reach
 * the library through the ordinary filesystem, but each fails to reach it in a
 * different way and needs a different fix — and the fix is never guessable from
 * "permission denied" alone. Detecting the deployment lets a failed probe name
 * the actual remedy instead of leaving the operator to work it out.
 */
export type Deployment = 'snap' | 'docker' | 'native';

/** Roots a strictly-confined snap can reach, via the removable-media interface. */
const SNAP_VISIBLE_ROOTS = ['/mnt', '/media', '/run/media'];

export function detectDeployment(): Deployment {
  // snapd sets both for every app it launches; SNAP alone is too weak a signal,
  // since a user could plausibly export it themselves.
  if (process.env.SNAP && process.env.SNAP_NAME) return 'snap';
  // /.dockerenv is Docker's marker, /run/.containerenv is Podman's.
  if (existsSync('/.dockerenv') || existsSync('/run/.containerenv')) return 'docker';
  return 'native';
}

function reachableBySnap(path: string): boolean {
  return SNAP_VISIBLE_ROOTS.some((root) => path === root || path.startsWith(`${root}/`));
}

/** How this process identifies itself to the kernel, for permission messages. */
function runningAs(): string {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  // Windows has neither; there is nothing useful to say about ownership there.
  if (uid === undefined || gid === undefined) return 'this process';
  return `uid ${uid}, gid ${gid}`;
}

export interface Owner {
  uid: number;
  gid: number;
  /** st_mode, including the file type bits; only the low 12 are reported. */
  mode: number;
}

function describeOwner(owner: Owner): string {
  const permissions = (owner.mode & 0o7777).toString(8).padStart(4, '0');
  return `uid ${owner.uid}, gid ${owner.gid}, mode ${permissions}`;
}

export type DenialKind =
  /** stat succeeded, but the directory cannot be written to. */
  | 'not-writable'
  /** stat itself was refused, so the path may well exist and simply be hidden. */
  | 'not-visible';

export interface DenialContext {
  path: string;
  kind: DenialKind;
  /** Only available for 'not-writable' — a refused stat yields no ownership. */
  owner?: Owner;
  /** Overridable so tests can exercise every deployment on one machine. */
  deployment?: Deployment;
  /** Likewise the mount table, which decides whether ownership is the files' or the share's. */
  mounts?: MountEntry[];
}

/**
 * Turns a filesystem denial into a sentence that names the fix.
 *
 * The generic "permission denied" is close to useless here: under Docker it
 * usually means PUID/PGID are wrong, under snap it almost always means an
 * interface is unconnected, and natively it is a plain ownership problem. Each
 * of those has a different one-line remedy, and the numbers needed to apply it
 * are already in hand at the point the probe fails.
 */
export function explainDenial(ctx: DenialContext): string {
  const deployment = ctx.deployment ?? detectDeployment();
  const { path, kind, owner } = ctx;

  if (kind === 'not-visible') {
    switch (deployment) {
      case 'snap':
        return (
          `${path} cannot be read by abs-butler. A strictly-confined snap sees no media until the ` +
          `interface granting it is connected, so this reports the same way as a missing ` +
          `directory even when the path is really there. ${snapRemedy(path)}`
        );
      case 'docker':
        return (
          `${path} cannot be read by abs-butler (running as ${runningAs()}). Inside a container ` +
          `this usually means a parent directory denies traversal, or a network share's mount ` +
          `options do not grant this uid access. Check the volume mapping and HOST_LIBRARY_PATH.`
        );
      case 'native':
        return (
          `${path} cannot be read by abs-butler (running as ${runningAs()}). A parent directory ` +
          `most likely denies traversal — every directory on the way to it needs execute ` +
          `permission for this user.`
        );
    }
  }

  const ownership = owner ? `; the directory is owned by ${describeOwner(owner)}` : '';
  const preamble = `${path} is not writable by abs-butler (running as ${runningAs()}${ownership}).`;

  switch (deployment) {
    case 'snap':
      return `${preamble} ${snapRemedy(path)}`;
    case 'docker':
      return `${preamble} ${dockerRemedy(owner, mountFor(path, ctx.mounts))}`;
    case 'native':
      return `${preamble} ${nativeRemedy(path, owner)}`;
  }
}

/**
 * Why a path is not there, in terms of this install.
 *
 * Inside a container "does not exist" is true and unhelpful: the path is almost
 * always right somewhere — on the host, or in AudiobookShelf's container — and
 * simply was not mounted into this one. The mount table says what was, which
 * is nearly always the answer.
 */
export function explainMissing(
  path: string,
  options: { deployment?: Deployment; mounts?: MountEntry[]; serverPath?: boolean } = {},
): string {
  const deployment = options.deployment ?? detectDeployment();
  if (deployment !== 'docker') return `${path} does not exist on this machine`;

  const mounts = options.mounts ?? libraryMounts();
  const whose = options.serverPath
    ? ` That is the path AudiobookShelf uses; abs-butler's own container sees the library somewhere else.`
    : '';
  const where =
    mounts.length > 0
      ? ` The library is mounted here at ${mounts.map(describeMount).join(', ')}, so the library root ` +
        'has to be that path or a folder inside it. Test on the Connection page, or abs-butler status, ' +
        'finds both paths by looking for your books.'
      : ' Nothing is mounted for the library at all — check the volumes in docker-compose.yml.';
  return `${path} is not mounted in this container.${whose}${where}`;
}

/** `Z:\Audiobooks`, `\\nas\share`, `//nas/share`: paths only Windows means. */
function windowsPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || /^(\\\\|\/\/)/.test(path);
}

/**
 * Why a library directory is empty, when it is.
 *
 * An empty directory passes every other check — it exists, it is writable —
 * which is exactly why it is worth naming. Under Docker it is almost always the
 * default mount: HOST_LIBRARY_PATH unset, so compose creates ./audiobooks and
 * mounts that. docker-compose.yml passes HOST_LIBRARY_PATH through, set or not,
 * so the difference between "unset" and "set to the wrong thing" is knowable.
 */
export function explainEmpty(
  path: string,
  options: { deployment?: Deployment; env?: NodeJS.ProcessEnv } = {},
): string {
  const deployment = options.deployment ?? detectDeployment();
  const env = options.env ?? process.env;
  const usual = 'Check that it is the folder AudiobookShelf uses.';
  if (deployment !== 'docker') return `${path} is empty. ${usual}`;

  const source = env.HOST_LIBRARY_PATH;
  if (source === undefined) {
    return `${path} is empty. Check that the volume mounted here is the folder AudiobookShelf uses.`;
  }
  if (source.trim() === '') {
    return (
      `${path} is empty. HOST_LIBRARY_PATH is not set, so Docker mounted an empty audiobooks folder ` +
      'beside docker-compose.yml instead of your library. Set HOST_LIBRARY_PATH in .env to the folder ' +
      'AudiobookShelf uses, then run docker compose up -d.'
    );
  }
  if (windowsPath(source)) {
    return (
      `${path} is empty, although HOST_LIBRARY_PATH is ${source}. Docker Desktop cannot see mapped ` +
      'network drives or \\\\server\\share paths, so if that is a NAS share it has to be mounted as a ' +
      'volume instead — see "Libraries on a NAS" in docs/docker.md.'
    );
  }
  return (
    `${path} is empty, although HOST_LIBRARY_PATH is ${source}. ${usual} If it is a network share, ` +
    'check that it was mounted before the container started.'
  );
}

function snapRemedy(path: string): string {
  if (reachableBySnap(path)) {
    return 'Connect the interface and restart: sudo snap connect abs-butler:removable-media';
  }
  return (
    `A snap can only reach media under ${SNAP_VISIBLE_ROOTS.slice(0, -1).join(', ')} or ` +
    `${SNAP_VISIBLE_ROOTS.at(-1)}. Bind-mount the library ` +
    `under one of those and set the library root to the new path — no snap interface grants ` +
    `access to ${path} itself.`
  );
}

function dockerRemedy(owner?: Owner, mount?: MountEntry | null): string {
  // On an SMB share the ownership stat reports is invented by the mount from its
  // own options, so matching PUID/PGID to it can succeed and still not write.
  if (mount && (mount.fsType === 'cifs' || mount.fsType === 'smb3')) {
    return (
      `It is on an SMB share (${mount.source}), where ownership and permissions come from the ` +
      `mount's options, not the files. Add uid=${process.getuid?.() ?? 1000},gid=` +
      `${process.getgid?.() ?? 1000},file_mode=0664,dir_mode=0775 to the volume's options, and ` +
      'check the share account itself may write.'
    );
  }
  if (!owner) return 'Check that the library is mounted read-write, and that PUID/PGID match its owner.';
  return (
    `Set PUID=${owner.uid} and PGID=${owner.gid} in .env and recreate the container. If that is ` +
    `already the case, the mount itself is read-only — see docs/docker.md.`
  );
}

function nativeRemedy(path: string, owner?: Owner): string {
  const uid = process.getuid?.();
  if (!owner || uid === undefined) {
    return `Grant this user write access to ${path}, or run abs-butler as the directory's owner.`;
  }
  // Already the owner, so no amount of chown or group juggling helps — the
  // directory's own permission bits are what deny the write.
  if (owner.uid === uid) {
    return `abs-butler already owns it, so the mode is what denies the write: chmod u+w ${path}`;
  }
  return (
    `Either run abs-butler as uid ${owner.uid}, or grant this user access — adding it to gid ` +
    `${owner.gid} and giving that group write permission keeps the library's existing ownership ` +
    `intact, which chown would not.`
  );
}

/**
 * Extra guidance for a database that opened but refuses writes.
 *
 * SQLite reports this as "attempt to write a readonly database", which is
 * accurate and useless: under snap the database is root-owned because the
 * daemon that writes it is, so reads succeed and only writes fail — the CLI
 * appears to work right up until it does something. Returns null when there is
 * nothing useful to add.
 */
export function explainReadonlyDatabase(
  dataDir: string,
  deployment: Deployment = detectDeployment(),
): string | null {
  if (process.getuid?.() === 0) return null;
  switch (deployment) {
    case 'snap':
      return (
        `${dataDir} belongs to root, because the abs-butler service that writes it runs as root. ` +
        'Reads work without it, which is why this got as far as it did — run the command with sudo.'
      );
    case 'docker':
      return `${dataDir} is not writable by ${runningAs()}. Check the volume's ownership.`;
    case 'native':
      return `${dataDir} is not writable by ${runningAs()}.`;
  }
}
