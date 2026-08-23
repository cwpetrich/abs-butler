import { existsSync } from 'node:fs';

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
          `this usually means the library was never bind-mounted at this path, or a parent ` +
          `directory denies traversal. Check the volume mapping and HOST_LIBRARY_PATH.`
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
      return `${preamble} ${dockerRemedy(owner)}`;
    case 'native':
      return `${preamble} ${nativeRemedy(path, owner)}`;
  }
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

function dockerRemedy(owner?: Owner): string {
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
