import type { IncomingMessage, ServerResponse } from 'node:http';

export interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  /** Parsed JSON body, or undefined for bodies that were empty or not JSON. */
  body: unknown;
  cookies: Record<string, string>;
}

export type Handler = (ctx: RequestContext) => Promise<unknown> | unknown;

interface Route {
  method: string;
  segments: string[];
  handler: Handler;
  /** Routes marked public skip the auth guard (login, health, static assets). */
  isPublic: boolean;
}

/**
 * A small path router. `:name` segments become params; `*` matches the rest.
 * Deliberately hand-rolled — this API has ~20 routes and no need for a
 * framework's middleware stack or its dependency surface.
 */
export class Router {
  private routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler, options: { isPublic?: boolean } = {}): this {
    this.routes.push({
      method: method.toUpperCase(),
      segments: pattern.split('/').filter(Boolean),
      handler,
      isPublic: options.isPublic ?? false,
    });
    return this;
  }

  get(pattern: string, handler: Handler, options?: { isPublic?: boolean }) {
    return this.add('GET', pattern, handler, options);
  }
  post(pattern: string, handler: Handler, options?: { isPublic?: boolean }) {
    return this.add('POST', pattern, handler, options);
  }
  put(pattern: string, handler: Handler, options?: { isPublic?: boolean }) {
    return this.add('PUT', pattern, handler, options);
  }
  patch(pattern: string, handler: Handler, options?: { isPublic?: boolean }) {
    return this.add('PATCH', pattern, handler, options);
  }
  delete(pattern: string, handler: Handler, options?: { isPublic?: boolean }) {
    return this.add('DELETE', pattern, handler, options);
  }

  match(method: string, pathname: string): { route: Route; params: Record<string, string> } | null {
    const parts = pathname.split('/').filter(Boolean);

    for (const route of this.routes) {
      if (route.method !== method.toUpperCase()) continue;

      const params: Record<string, string> = {};
      let matched = true;

      for (let i = 0; i < route.segments.length; i++) {
        const segment = route.segments[i]!;
        if (segment === '*') {
          params.rest = parts.slice(i).join('/');
          return { route, params };
        }
        const part = parts[i];
        if (part === undefined) {
          matched = false;
          break;
        }
        if (segment.startsWith(':')) params[segment.slice(1)] = decodeURIComponent(part);
        else if (segment !== part) {
          matched = false;
          break;
        }
      }

      if (matched && parts.length === route.segments.length) return { route, params };
    }
    return null;
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (message: string) => new HttpError(400, message);
export const unauthorized = (message = 'Authentication required') => new HttpError(401, message);
export const notFound = (message = 'Not found') => new HttpError(404, message);

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const pair of header.split(';')) {
    const index = pair.indexOf('=');
    if (index === -1) continue;
    out[pair.slice(0, index).trim()] = decodeURIComponent(pair.slice(index + 1).trim());
  }
  return out;
}

const MAX_BODY_BYTES = 1024 * 1024;

export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw badRequest('Request body too large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return undefined;

  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw badRequest('Request body is not valid JSON');
  }
}
