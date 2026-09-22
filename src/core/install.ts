import { existsSync } from 'node:fs';
import { isEmptyLibrary } from './capability.js';
import { detectDeployment, REPAIR_COMMAND, type Deployment } from './deployment.js';

/**
 * What is wrong with the way abs-butler is installed, as far as it can tell
 * from inside its own container.
 *
 * It cannot fix any of it from here: a mount is fixed when the container is
 * created, and changing that takes the Docker socket, which this process never
 * holds. What it can do is notice, and hand over the one command that does fix
 * it — the installer, run by the person who owns the machine.
 *
 * Deliberately short. An install that works is not nagged about how it was
 * made: a hand-written compose file with the right library mounted is fine.
 */

/**
 * The generation install.sh stamps into .env as BUTLER_INSTALL_VERSION. Kept
 * equal to INSTALL_VERSION there; a test holds the two together.
 */
export const INSTALL_GENERATION = 2;

export type InstallProblemCode = 'library-missing' | 'library-empty' | 'installer-outdated';

export interface InstallProblem {
  code: InstallProblemCode;
  message: string;
}

export interface InstallHealth {
  deployment: Deployment;
  problems: InstallProblem[];
  /** Null outside Docker, where the installer has nothing to do. */
  repairCommand: string | null;
}

/** Where compose mounts the library in this container. */
export function libraryMountPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.BUTLER_LIBRARY_TARGET || '/audiobooks';
}

export function installHealth(
  options: {
    deployment?: Deployment;
    env?: NodeJS.ProcessEnv;
    exists?: (path: string) => boolean;
    isEmpty?: (path: string) => boolean;
  } = {},
): InstallHealth {
  const deployment = options.deployment ?? detectDeployment();
  if (deployment !== 'docker') return { deployment, problems: [], repairCommand: null };

  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;
  const isEmpty = options.isEmpty ?? isEmptyLibrary;
  const problems: InstallProblem[] = [];

  const mount = libraryMountPath(env);
  if (!exists(mount)) {
    problems.push({ code: 'library-missing', message: `Nothing is mounted at ${mount}, where the library belongs.` });
  } else if (isEmpty(mount)) {
    problems.push({
      code: 'library-empty',
      message: `${mount} is empty, so abs-butler cannot see your audiobooks — organize and some repairs need them.`,
    });
  }

  // Absent is an install made by hand, which is not a problem by itself.
  const generation = Number(env.BUTLER_INSTALL_VERSION);
  if (env.BUTLER_INSTALL_VERSION && Number.isInteger(generation) && generation < INSTALL_GENERATION) {
    problems.push({
      code: 'installer-outdated',
      message: 'This install was set up by an older installer; the current one has fixes for it.',
    });
  }

  return { deployment, problems, repairCommand: REPAIR_COMMAND };
}
