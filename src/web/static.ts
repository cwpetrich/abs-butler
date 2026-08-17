import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerResponse } from 'node:http';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** The built SPA sits next to the compiled server output. */
export function publicDir(): string {
  return resolve(fileURLToPath(new URL('.', import.meta.url)), '..', 'public');
}

export function hasBuiltUi(): boolean {
  return existsSync(join(publicDir(), 'index.html'));
}

/**
 * Serves a built asset, falling back to index.html so client-side routes like
 * /runs/12 work on a hard refresh. Returns false when there is no UI built.
 */
export function serveStatic(res: ServerResponse, pathname: string): boolean {
  const root = publicDir();
  if (!hasBuiltUi()) return false;

  // Resolve then verify containment, so ../ in a request cannot escape the root.
  const requested = normalize(join(root, decodeURIComponent(pathname)));
  const isContained = requested === root || requested.startsWith(root + '/');

  let file = isContained && existsSync(requested) && statSync(requested).isFile() ? requested : null;
  if (!file) file = join(root, 'index.html');

  const ext = extname(file);
  res.statusCode = 200;
  res.setHeader('Content-Type', MIME[ext] ?? 'application/octet-stream');
  // Vite fingerprints asset filenames, so they are safe to cache hard.
  // index.html must not be, or the browser pins an old build forever.
  res.setHeader(
    'Cache-Control',
    file.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
  );
  createReadStream(file).pipe(res);
  return true;
}
