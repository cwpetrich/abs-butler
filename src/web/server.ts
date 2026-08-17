import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { WebConfig } from '../config.js';
import type { Db } from '../db/index.js';
import { JobRunner } from '../core/jobs.js';
import { color, log } from '../logger.js';
import { Auth } from './auth.js';
import { buildApiRouter } from './api.js';
import { HttpError, parseCookies, readJsonBody, type RequestContext } from './router.js';
import { hasBuiltUi, serveStatic } from './static.js';

export interface WebServer {
  server: Server;
  runner: JobRunner;
  close: () => Promise<void>;
}

export function startWebServer(db: Db, config: WebConfig): Promise<WebServer> {
  const runner = new JobRunner(db);
  runner.recover();

  const exposed = config.host !== '127.0.0.1' && config.host !== 'localhost';
  const auth = new Auth(db, { password: config.password, exposed });
  auth.warnIfInsecure();

  const router = buildApiRouter({
    db,
    runner,
    auth,
    isSecure: (ctx) => isSecureRequest(ctx.req),
  });

  const server = createServer((req, res) => {
    void handle(req, res).catch((err) => {
      log.error(`unhandled request error: ${(err as Error).message}`);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: 'Internal error' }));
      }
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    // The API is same-origin only; there is no browser client on another host.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');

    if (!url.pathname.startsWith('/api/')) {
      if (serveStatic(res, url.pathname)) return;
      res.statusCode = 503;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('The web UI has not been built. Run: npm run build:web\n');
      return;
    }

    const matched = router.match(req.method ?? 'GET', url.pathname);
    if (!matched) {
      sendJson(res, 404, { error: `No route for ${req.method} ${url.pathname}` });
      return;
    }

    const ctx: RequestContext = {
      req,
      res,
      url,
      params: matched.params,
      body: undefined,
      cookies: parseCookies(req.headers.cookie),
    };

    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        // Session cookies are SameSite=Lax, which stops cross-site form posts,
        // but an Origin check costs nothing and covers same-site subdomains.
        assertSameOrigin(req, url);
        ctx.body = await readJsonBody(req);
      }
      if (!matched.route.isPublic) auth.requireAuth(ctx);

      const result = await matched.route.handler(ctx);
      if (res.writableEnded) return;
      sendJson(res, 200, result ?? { ok: true });
    } catch (err) {
      if (err instanceof HttpError) {
        sendJson(res, err.status, { error: err.message });
        return;
      }
      const message = (err as Error).message;
      log.debug(`request failed: ${message}`);
      sendJson(res, 400, { error: message });
    }
  }

  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.removeListener('error', reject);
      const shown = config.host === '0.0.0.0' ? 'localhost' : config.host;
      log.success(`abs-butler web UI on ${color.cyan(`http://${shown}:${config.port}`)}`);
      if (!hasBuiltUi()) {
        log.warn('No built UI found — serving the API only. Run: npm run build:web');
      }
      runner.startScheduler();

      resolvePromise({
        server,
        runner,
        close: () =>
          new Promise<void>((done) => {
            runner.stop();
            server.close(() => done());
          }),
      });
    });
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.end(body);
}

function isSecureRequest(req: IncomingMessage): boolean {
  if ((req.socket as { encrypted?: boolean }).encrypted) return true;
  return String(req.headers['x-forwarded-proto'] ?? '').split(',')[0]?.trim() === 'https';
}

function assertSameOrigin(req: IncomingMessage, url: URL): void {
  const origin = req.headers.origin;
  if (!origin) return; // Non-browser clients (curl, the CLI) send no Origin.
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new HttpError(403, 'Invalid Origin header');
  }
  if (originHost !== url.host) {
    throw new HttpError(403, `Cross-origin request from ${originHost} refused`);
  }
}
