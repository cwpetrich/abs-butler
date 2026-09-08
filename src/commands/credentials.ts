import type { AbsCredentials } from '../abs/client.js';
import { isInteractive, promptLine, promptSecret } from '../util/prompt.js';

/**
 * The terminal, injected so the decision table below can be tested without one.
 */
export interface CredentialPrompts {
  interactive: boolean;
  line(question: string): Promise<string>;
  secret(question: string): Promise<string>;
}

export const terminalPrompts: CredentialPrompts = {
  get interactive() {
    return isInteractive();
  },
  line: promptLine,
  secret: promptSecret,
};

export interface CredentialOptions {
  apiKey?: string;
  username?: string;
  password?: string;
}

const NEEDED =
  'Provide either an API token, or a username and password. ' +
  'Pass --api-key, or --username with --password, when there is no terminal to ask.';

/**
 * Works out which credential to use, asking for it when a terminal is present.
 *
 * Flags always win, so scripted use never becomes interactive. What is missing
 * is asked for in the order the UI recommends: the API token first, with
 * signing in as the fallback for anyone who does not want to go and find it.
 *
 * `required` separates the two callers. `connect` cannot proceed without a
 * credential, so an empty invocation is a prompt. `configure` may be changing
 * something else entirely, so it only asks when a username says that is the
 * intent.
 */
export async function gatherCredentials(
  options: CredentialOptions,
  prompts: CredentialPrompts,
  { required }: { required: boolean },
): Promise<AbsCredentials> {
  // A password on the command line is already in the shell history; nothing is
  // gained by refusing it, so it is honoured as given.
  if (options.apiKey) return { apiKey: options.apiKey };
  if (options.username && options.password) return { ...options };

  if (options.username) {
    if (!prompts.interactive) {
      throw new Error(`--password is required for --username when there is no terminal.`);
    }
    const password = await prompts.secret(`Password for ${options.username}: `);
    if (!password) throw new Error('No password entered.');
    return { username: options.username, password };
  }

  // A password without a username is a mistake worth naming rather than
  // quietly prompting past.
  if (options.password) throw new Error('--password needs --username.');

  if (!required) return {};
  if (!prompts.interactive) throw new Error(NEEDED);

  const apiKey = (await prompts.secret('API token (leave blank to sign in instead): ')).trim();
  if (apiKey) return { apiKey };

  const username = (await prompts.line('Username: ')).trim();
  if (!username) throw new Error(NEEDED);
  const password = await prompts.secret('Password: ');
  if (!password) throw new Error('No password entered.');
  return { username, password };
}
