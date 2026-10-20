import { LivenessResponseSchema, type LivenessResponse } from '@ftms/core';

export type ApiStatus =
  | { state: 'not_configured' }
  | { state: 'up'; liveness: LivenessResponse }
  | { state: 'down'; reason: string };

export const API_HEALTH_TIMEOUT_MS = 3_000;

/**
 * Asks the API whether it is alive. Never throws: every failure mode becomes a
 * `down` status with a reason, so the page renders an honest state instead of an
 * error boundary — and never a fake "online" badge.
 */
export async function fetchApiStatus(
  baseUrl: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<ApiStatus> {
  if (!baseUrl?.trim()) return { state: 'not_configured' };

  let url: URL;
  try {
    url = new URL('health', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  } catch {
    return { state: 'down', reason: 'NEXT_PUBLIC_API_URL is not a valid URL' };
  }

  try {
    const res = await fetchImpl(url, {
      cache: 'no-store',
      signal: AbortSignal.timeout(API_HEALTH_TIMEOUT_MS),
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return { state: 'down', reason: `HTTP ${res.status}` };

    const parsed = LivenessResponseSchema.safeParse(await res.json());
    if (!parsed.success) return { state: 'down', reason: 'Unexpected health response' };
    return { state: 'up', liveness: parsed.data };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      return { state: 'down', reason: `No answer within ${API_HEALTH_TIMEOUT_MS} ms` };
    }
    return { state: 'down', reason: error instanceof Error ? error.message : 'Request failed' };
  }
}
