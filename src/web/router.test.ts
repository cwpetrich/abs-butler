import { describe, expect, it } from 'vitest';
import { parseCookies, Router } from './router.js';

function build(): Router {
  return new Router()
    .get('/api/servers', () => 'list')
    .post('/api/servers', () => 'create')
    .get('/api/servers/:id', () => 'one')
    .get('/api/servers/:id/capability', () => 'cap')
    .get('/api/runs/:runId/logs/:logId', () => 'nested');
}

describe('Router', () => {
  it('matches a literal path and respects the method', () => {
    expect(build().match('GET', '/api/servers')?.route).toBeDefined();
    expect(build().match('POST', '/api/servers')?.route).toBeDefined();
    expect(build().match('DELETE', '/api/servers')).toBeNull();
  });

  it('extracts named parameters', () => {
    expect(build().match('GET', '/api/servers/42')?.params).toEqual({ id: '42' });
    expect(build().match('GET', '/api/runs/7/logs/9')?.params).toEqual({ runId: '7', logId: '9' });
  });

  it('does not let a parameter route swallow a longer path', () => {
    const match = build().match('GET', '/api/servers/42/capability');
    expect(match?.params).toEqual({ id: '42' });
    // The two-segment route must not have matched a three-segment path.
    expect(build().match('GET', '/api/servers/42/nonexistent')).toBeNull();
  });

  it('returns null for unknown paths', () => {
    expect(build().match('GET', '/api/nope')).toBeNull();
    expect(build().match('GET', '/')).toBeNull();
  });

  it('tolerates trailing slashes and decodes parameters', () => {
    expect(build().match('GET', '/api/servers/')?.route).toBeDefined();
    expect(build().match('GET', '/api/servers/a%20b')?.params).toEqual({ id: 'a b' });
  });

  it('marks routes public only when asked', () => {
    const router = new Router()
      .get('/api/open', () => 'ok', { isPublic: true })
      .get('/api/closed', () => 'ok');
    expect(router.match('GET', '/api/open')?.route.isPublic).toBe(true);
    expect(router.match('GET', '/api/closed')?.route.isPublic).toBe(false);
  });
});

describe('parseCookies', () => {
  it('parses a normal cookie header', () => {
    expect(parseCookies('a=1; b=two')).toEqual({ a: '1', b: 'two' });
  });

  it('decodes encoded values and keeps = inside them', () => {
    expect(parseCookies('session=abc%3Ddef')).toEqual({ session: 'abc=def' });
    expect(parseCookies('token=a=b')).toEqual({ token: 'a=b' });
  });

  it('handles a missing or malformed header without throwing', () => {
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies('')).toEqual({});
    expect(parseCookies('novalue')).toEqual({});
  });
});
