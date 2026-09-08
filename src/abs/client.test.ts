import { afterEach, describe, expect, it, vi } from 'vitest';
import { AbsClient, resolveApiKey } from './client.js';

/** Captures what was sent, so a test can assert on the request as well as the reply. */
function mockFetch(reply: unknown, status = 200) {
  const calls: Array<{ url: string; method?: string; body?: unknown }> = [];
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((async (url: URL, init: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(reply),
    };
  }) as unknown as typeof fetch);
  return { calls, spy };
}

afterEach(() => vi.restoreAllMocks());

describe('AbsClient.login', () => {
  it('posts the credentials and returns the long-lived token', async () => {
    const { calls } = mockFetch({ user: { token: 'permanent', accessToken: 'expires-in-an-hour' } });

    const token = await new AbsClient({ baseUrl: 'http://abs.test' }).login('root', 'hunter2');

    expect(token).toBe('permanent');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://abs.test/login');
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.body).toEqual({ username: 'root', password: 'hunter2' });
  });

  // accessToken carries an exp claim and dies in an hour. Storing it would
  // leave a scheduler that runs unattended broken by morning, so a response
  // without the durable field has to fail loudly rather than fall back.
  it('refuses an accessToken-only response instead of storing a token that expires', async () => {
    mockFetch({ user: { accessToken: 'expires-in-an-hour' } });

    await expect(
      new AbsClient({ baseUrl: 'http://abs.test' }).login('root', 'hunter2'),
    ).rejects.toThrow(/no long-lived API token/);
  });

  it('does not retry a rejected password', async () => {
    const { calls } = mockFetch({ error: 'nope' }, 401);

    await expect(
      new AbsClient({ baseUrl: 'http://abs.test' }).login('root', 'wrong'),
    ).rejects.toThrow(/rejected the credentials/);
    expect(calls).toHaveLength(1);
  });
});

describe('resolveApiKey', () => {
  it('uses a token as-is, without contacting the server', async () => {
    const { calls } = mockFetch({});
    await expect(resolveApiKey('http://abs.test', { apiKey: 'from-the-ui' })).resolves.toBe(
      'from-the-ui',
    );
    expect(calls).toHaveLength(0);
  });

  it('exchanges a username and password for a token', async () => {
    mockFetch({ user: { token: 'minted' } });
    await expect(
      resolveApiKey('http://abs.test', { username: 'root', password: 'hunter2' }),
    ).resolves.toBe('minted');
  });

  // A token can be revoked in AudiobookShelf without a password change, so it
  // wins when both somehow arrive together.
  it('prefers the token when given both', async () => {
    const { calls } = mockFetch({ user: { token: 'minted' } });
    await expect(
      resolveApiKey('http://abs.test', {
        apiKey: 'from-the-ui',
        username: 'root',
        password: 'hunter2',
      }),
    ).resolves.toBe('from-the-ui');
    expect(calls).toHaveLength(0);
  });

  it('rejects a half-filled form rather than guessing', async () => {
    mockFetch({});
    await expect(resolveApiKey('http://abs.test', { username: 'root' })).rejects.toThrow(
      /either an API token, or a username and password/,
    );
    await expect(resolveApiKey('http://abs.test', {})).rejects.toThrow();
  });
});
