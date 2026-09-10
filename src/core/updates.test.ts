import { afterEach, describe, expect, it } from 'vitest';
import { checkForUpdate, compareVersions, newestTag, resetUpdateCache } from './updates.js';

afterEach(() => resetUpdateCache());

function reply(body: unknown, ok = true, status = 200) {
  return (async () => ({ ok, status, json: async () => body })) as unknown as typeof fetch;
}

describe('compareVersions', () => {
  it('orders by each numeric part, not lexically', () => {
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0);
    expect(compareVersions('0.4.2', '0.4.10')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '0.99.99')).toBeGreaterThan(0);
  });

  it('ignores a leading v and treats missing parts as zero', () => {
    expect(compareVersions('v0.4.2', '0.4.2')).toBe(0);
    expect(compareVersions('0.5', '0.5.0')).toBe(0);
  });
});

describe('newestTag', () => {
  // GitHub returns newest-first today; that is its business, not a promise.
  it('picks the newest regardless of the order given', () => {
    expect(newestTag(['v0.4.0', 'v0.10.0', 'v0.4.2'])).toBe('v0.10.0');
  });

  // A stray tag announced as a release would send people chasing a version
  // that was never published.
  it('ignores tags that are not release-shaped', () => {
    expect(newestTag(['nightly', 'v0.4.2', 'some-branch-tag'])).toBe('v0.4.2');
    expect(newestTag(['nightly', 'wip'])).toBeNull();
    expect(newestTag([])).toBeNull();
  });
});

describe('checkForUpdate', () => {
  it('reports an update when the newest tag is ahead', async () => {
    const s = await checkForUpdate('0.4.2', reply([{ tag_name: 'v0.5.0' }, { tag_name: 'v0.4.2' }]));
    expect(s.available).toBe(true);
    expect(s.latest).toBe('v0.5.0');
  });

  it('reports none when current is the newest', async () => {
    const s = await checkForUpdate('0.4.2', reply([{ tag_name: 'v0.4.2' }]));
    expect(s.available).toBe(false);
  });

  // A tag exists the moment it is pushed; a release exists only once the image
  // it names has been published. Announcing the former sends an operator to a
  // version they cannot pull.
  it('ignores drafts and prereleases', async () => {
    const s = await checkForUpdate(
      '0.4.2',
      reply([
        { tag_name: 'v0.9.0', draft: true },
        { tag_name: 'v0.8.0', prerelease: true },
        { tag_name: 'v0.5.0' },
      ]),
    );
    expect(s.latest).toBe('v0.5.0');
    expect(s.available).toBe(true);
  });

  it('reports nothing when every release is a draft', async () => {
    const s = await checkForUpdate('0.4.2', reply([{ tag_name: 'v0.9.0', draft: true }]));
    expect(s.latest).toBeNull();
    expect(s.available).toBe(false);
  });

  // Running ahead of the newest tag is normal on a development build and must
  // not be announced as an update.
  it('does not offer a downgrade', async () => {
    const s = await checkForUpdate('0.5.0', reply([{ tag_name: 'v0.4.2' }]));
    expect(s.available).toBe(false);
  });

  // Nothing depends on this answer, so a failure is reported, never thrown.
  it('survives GitHub being unreachable', async () => {
    const boom = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const s = await checkForUpdate('0.4.2', boom);
    expect(s.available).toBe(false);
    expect(s.error).toMatch(/network down/);
  });

  it('survives a rate-limited or error response', async () => {
    const s = await checkForUpdate('0.4.2', reply({ message: 'rate limited' }, false, 403));
    expect(s.error).toMatch(/403/);
    expect(s.available).toBe(false);
  });

  it('survives a body that is not the array it expects', async () => {
    const s = await checkForUpdate('0.4.2', reply({ message: 'nope' }));
    expect(s.latest).toBeNull();
    expect(s.available).toBe(false);
  });

  it('caches, so a page refresh does not call GitHub again', async () => {
    let calls = 0;
    const counting = (async () => {
      calls++;
      return { ok: true, status: 200, json: async () => [{ tag_name: 'v0.9.0' }] };
    }) as unknown as typeof fetch;
    await checkForUpdate('0.4.2', counting);
    await checkForUpdate('0.4.2', counting);
    await checkForUpdate('0.4.2', counting);
    expect(calls).toBe(1);
  });
});
