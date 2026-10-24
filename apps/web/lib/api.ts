import 'server-only';
import { type ApiErrorCode, ApiErrorResponseSchema } from '@ftms/core';
import { headers } from 'next/headers';

/** Shared with the API so it can trust the browser IP we forward (rate limits, audit). */
const CLIENT_IP_HEADER = 'x-ftms-client-ip';
const PROXY_KEY_HEADER = 'x-ftms-proxy-key';

export type ApiResult<T> =
  | { ok: true; status: number; data: T }
  | {
      ok: false;
      status: number;
      code: ApiErrorCode | 'NETWORK';
      details?: Record<string, string[]>;
      retryAfterSeconds?: number;
    };

/**
 * API base URL, read at runtime. `API_URL` (server-only) wins; the documented
 * `NEXT_PUBLIC_API_URL` is the fallback. Bracket access keeps Next from inlining
 * the value at build time, so one build can target any API.
 */
export function apiBaseUrl(): string | null {
  const url = (process.env['API_URL'] ?? process.env['NEXT_PUBLIC_API_URL'])?.trim();
  return url ? url.replace(/\/+$/, '') : null;
}

/** First address in X-Forwarded-For (set by Vercel on the web function), if any. */
export function clientIpFrom(h: Headers): string | null {
  const forwarded = h.get('x-forwarded-for')?.split(',')[0]?.trim();
  return forwarded || h.get('x-real-ip') || null;
}

/**
 * Server-side call to the NestJS API. The browser never talks to the API
 * directly and never sees a token: the web server attaches the bearer token
 * from its httpOnly cookie.
 */
export async function apiFetch<T>(
  path: string,
  options: {
    method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
    body?: unknown;
    accessToken?: string | null;
    clientIp?: string | null;
    timeoutMs?: number;
  } = {},
): Promise<ApiResult<T>> {
  const base = apiBaseUrl();
  if (!base) return { ok: false, status: 0, code: 'NETWORK' };

  const requestHeaders: Record<string, string> = { accept: 'application/json' };
  if (options.body !== undefined) requestHeaders['content-type'] = 'application/json';
  if (options.accessToken) requestHeaders.authorization = `Bearer ${options.accessToken}`;
  const secret = process.env.BFF_SHARED_SECRET;
  const ip =
    options.clientIp === undefined ? clientIpFrom(await headersOrEmpty()) : options.clientIp;
  if (secret && ip) {
    requestHeaders[CLIENT_IP_HEADER] = ip;
    requestHeaders[PROXY_KEY_HEADER] = secret;
  }

  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method: options.method ?? 'GET',
      headers: requestHeaders,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      cache: 'no-store',
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
  } catch {
    return { ok: false, status: 0, code: 'NETWORK' };
  }
  return readResult<T>(res);
}

async function readResult<T>(res: Response): Promise<ApiResult<T>> {
  if (res.status === 204) return { ok: true, status: 204, data: undefined as T };
  const json: unknown = await res.json().catch(() => null);
  if (res.ok) return { ok: true, status: res.status, data: json as T };

  const error = ApiErrorResponseSchema.safeParse(json);
  return error.success
    ? {
        ok: false,
        status: res.status,
        code: error.data.code,
        details: error.data.details,
        retryAfterSeconds: error.data.retryAfterSeconds,
      }
    : { ok: false, status: res.status, code: 'INTERNAL_ERROR' };
}

/** Forwards a multipart upload (e.g. a spreadsheet) to the API. */
export async function apiUpload<T>(
  path: string,
  form: FormData,
  accessToken: string | null,
): Promise<ApiResult<T>> {
  const base = apiBaseUrl();
  if (!base) return { ok: false, status: 0, code: 'NETWORK' };
  const headers = await forwardingHeaders(accessToken);
  try {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers,
      body: form,
      cache: 'no-store',
      signal: AbortSignal.timeout(60_000),
    });
    return await readResult<T>(res);
  } catch {
    return { ok: false, status: 0, code: 'NETWORK' };
  }
}

/** Raw response for a file download (e.g. the import template). */
export async function apiDownload(
  path: string,
  accessToken: string | null,
  timeoutMs = 30_000,
): Promise<Response | null> {
  const base = apiBaseUrl();
  if (!base) return null;
  try {
    return await fetch(`${base}${path}`, {
      headers: await forwardingHeaders(accessToken),
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return null;
  }
}

async function forwardingHeaders(accessToken: string | null): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  const secret = process.env.BFF_SHARED_SECRET;
  const ip = clientIpFrom(await headersOrEmpty());
  if (secret && ip) {
    headers[CLIENT_IP_HEADER] = ip;
    headers[PROXY_KEY_HEADER] = secret;
  }
  return headers;
}

/** `headers()` is unavailable outside a request (e.g. in tests); treat that as no headers. */
async function headersOrEmpty(): Promise<Headers> {
  try {
    return new Headers(await headers());
  } catch {
    return new Headers();
  }
}
