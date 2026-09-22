import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPAIR_COMMAND } from './deployment.js';
import { INSTALL_GENERATION, installHealth, libraryMountPath } from './install.js';

const docker = (env: NodeJS.ProcessEnv, mount: { exists?: boolean; empty?: boolean } = {}) =>
  installHealth({
    deployment: 'docker',
    env,
    exists: () => mount.exists ?? true,
    isEmpty: () => mount.empty ?? false,
  });

describe('installHealth', () => {
  it('has nothing to say about a working install, however it was made', () => {
    expect(docker({}).problems).toEqual([]);
    expect(docker({ BUTLER_INSTALL_VERSION: String(INSTALL_GENERATION) }).problems).toEqual([]);
  });

  it('names an empty library mount, and hands over the repair command', () => {
    const health = docker({}, { empty: true });
    expect(health.problems.map((p) => p.code)).toEqual(['library-empty']);
    expect(health.problems[0]!.message).toContain('/audiobooks is empty');
    expect(health.repairCommand).toBe(REPAIR_COMMAND);
  });

  it('looks where the installer mounted a volume, not at /audiobooks', () => {
    expect(libraryMountPath({ BUTLER_LIBRARY_TARGET: '/nas' })).toBe('/nas');
    const health = docker({ BUTLER_LIBRARY_TARGET: '/nas' }, { exists: false });
    expect(health.problems[0]!.message).toContain('/nas');
  });

  it('notices an install from an older installer', () => {
    expect(docker({ BUTLER_INSTALL_VERSION: '1' }).problems.map((p) => p.code)).toEqual(['installer-outdated']);
  });

  it('stays out of the way outside Docker', () => {
    expect(installHealth({ deployment: 'native', exists: () => false })).toEqual({
      deployment: 'native',
      problems: [],
      repairCommand: null,
    });
  });

  it('agrees with install.sh about the current generation', () => {
    const script = readFileSync(join(__dirname, '../../install.sh'), 'utf8');
    expect(script).toMatch(new RegExp(`^INSTALL_VERSION=${INSTALL_GENERATION}$`, 'm'));
  });
});
