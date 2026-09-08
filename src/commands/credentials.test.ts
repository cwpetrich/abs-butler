import { describe, expect, it } from 'vitest';
import { gatherCredentials, type CredentialPrompts } from './credentials.js';

/** A scripted terminal: answers in order, and records what it was asked. */
function fakeTerminal(answers: string[], interactive = true) {
  const asked: string[] = [];
  const next = () => {
    if (answers.length === 0) throw new Error('prompted more times than the test expected');
    return Promise.resolve(answers.shift()!);
  };
  const prompts: CredentialPrompts = {
    interactive,
    line: (q) => (asked.push(q), next()),
    secret: (q) => (asked.push(q), next()),
  };
  return { prompts, asked, remaining: () => answers.length };
}

const REQUIRED = { required: true };
const OPTIONAL = { required: false };

describe('gatherCredentials', () => {
  it('uses flags without prompting for anything', async () => {
    const t = fakeTerminal([]);
    await expect(gatherCredentials({ apiKey: 'k' }, t.prompts, REQUIRED)).resolves.toEqual({
      apiKey: 'k',
    });
    expect(t.asked).toEqual([]);
  });

  it('asks only for the password when a username was given', async () => {
    const t = fakeTerminal(['hunter2']);
    await expect(
      gatherCredentials({ username: 'root' }, t.prompts, REQUIRED),
    ).resolves.toEqual({ username: 'root', password: 'hunter2' });
    expect(t.asked).toEqual(['Password for root: ']);
  });

  // The token is offered first because it is the recommended credential; the
  // sign-in path is only reached by declining it.
  it('offers the API token first, then falls back to signing in', async () => {
    const t = fakeTerminal(['', 'root', 'hunter2']);
    await expect(gatherCredentials({}, t.prompts, REQUIRED)).resolves.toEqual({
      username: 'root',
      password: 'hunter2',
    });
    expect(t.asked).toEqual([
      'API token (leave blank to sign in instead): ',
      'Username: ',
      'Password: ',
    ]);
  });

  it('stops at the token when one is typed', async () => {
    const t = fakeTerminal(['  pasted-token  ']);
    await expect(gatherCredentials({}, t.prompts, REQUIRED)).resolves.toEqual({
      apiKey: 'pasted-token',
    });
    expect(t.remaining()).toBe(0);
  });

  // Blocking on a read nobody can answer is the failure mode this guards: a
  // container without a TTY would otherwise hang instead of reporting.
  it('refuses to prompt without a terminal, naming the flag to pass', async () => {
    const t = fakeTerminal([], false);
    await expect(gatherCredentials({}, t.prompts, REQUIRED)).rejects.toThrow(/--api-key/);
    await expect(
      gatherCredentials({ username: 'root' }, t.prompts, REQUIRED),
    ).rejects.toThrow(/--password is required/);
    expect(t.asked).toEqual([]);
  });

  it('treats a password without a username as the mistake it is', async () => {
    const t = fakeTerminal([]);
    await expect(gatherCredentials({ password: 'x' }, t.prompts, REQUIRED)).rejects.toThrow(
      /--password needs --username/,
    );
  });

  it('rejects an empty password rather than sending a blank one', async () => {
    const t = fakeTerminal(['']);
    await expect(
      gatherCredentials({ username: 'root' }, t.prompts, REQUIRED),
    ).rejects.toThrow(/No password entered/);
  });

  // configure is as often used to change a path, so an empty invocation there
  // must stay silent rather than demanding a credential.
  it('asks nothing when credentials are optional and none were named', async () => {
    const t = fakeTerminal([]);
    await expect(gatherCredentials({}, t.prompts, OPTIONAL)).resolves.toEqual({});
    expect(t.asked).toEqual([]);
  });

  it('still completes a half-given credential when optional', async () => {
    const t = fakeTerminal(['hunter2']);
    await expect(gatherCredentials({ username: 'root' }, t.prompts, OPTIONAL)).resolves.toEqual({
      username: 'root',
      password: 'hunter2',
    });
  });
});
