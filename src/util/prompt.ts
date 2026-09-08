import { createInterface } from 'node:readline';

/**
 * Terminal input for the one secret abs-butler asks for by hand.
 *
 * Prompting is only ever offered when both ends are a terminal. A container
 * started without a TTY, a CI job, or a piped script must fail with a message
 * naming the flag to pass instead — never block forever on a read that has
 * nobody to answer it.
 */
export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export class PromptAbortedError extends Error {
  constructor() {
    super('Cancelled.');
    this.name = 'PromptAbortedError';
  }
}

function ask(question: string, hidden: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });

    // readline re-renders the whole line on every keypress. Muting its writer
    // after the question has been printed echoes nothing at all — no asterisks
    // either, so the length of the secret does not end up on screen or in a
    // scrollback someone screenshots.
    let muted = false;
    const rlInternal = rl as unknown as { _writeToOutput(chunk: string): void };
    const write = rlInternal._writeToOutput.bind(rl);
    rlInternal._writeToOutput = (chunk: string) => {
      if (!muted) write(chunk);
    };

    rl.question(question, (answer) => {
      // The newline the user typed was swallowed with everything else.
      if (muted) process.stdout.write('\n');
      rl.close();
      resolve(answer);
    });
    muted = hidden;

    rl.on('SIGINT', () => {
      if (muted) process.stdout.write('\n');
      rl.close();
      reject(new PromptAbortedError());
    });
  });
}

/** Reads a visible line, e.g. a username. */
export function promptLine(question: string): Promise<string> {
  return ask(question, false);
}

/** Reads a line without echoing it. */
export function promptSecret(question: string): Promise<string> {
  return ask(question, true);
}
