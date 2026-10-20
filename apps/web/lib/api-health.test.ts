import { describe, expect, it, vi } from 'vitest';
import { fetchApiStatus } from './api-health';

const liveness = {
  status: 'ok',
  service: 'ftms-api',
  version: '0.0.0',
  timestamp: '2026-10-20T07:00:00.000Z',
  uptimeSeconds: 3.2,
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('fetchApiStatus', () => {
  it('reports not_configured when no API URL is set', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(fetchApiStatus(undefined, fetchImpl)).resolves.toEqual({
      state: 'not_configured',
    });
    await expect(fetchApiStatus('  ', fetchImpl)).resolves.toEqual({ state: 'not_configured' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('calls /health relative to the base URL, with or without a trailing slash', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse(liveness)));
    await fetchApiStatus('https://api.example.edu.eg', fetchImpl);
    await fetchApiStatus('https://api.example.edu.eg/', fetchImpl);
    const urls = fetchImpl.mock.calls.map(([input]) =>
      input instanceof URL ? input.href : typeof input === 'string' ? input : input.url,
    );
    expect(urls).toEqual([
      'https://api.example.edu.eg/health',
      'https://api.example.edu.eg/health',
    ]);
  });

  it('returns up with the parsed liveness payload', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse(liveness)));
    await expect(fetchApiStatus('http://localhost:4000', fetchImpl)).resolves.toEqual({
      state: 'up',
      liveness,
    });
  });

  it('returns down on an HTTP error', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse({}, 503)));
    await expect(fetchApiStatus('http://localhost:4000', fetchImpl)).resolves.toEqual({
      state: 'down',
      reason: 'HTTP 503',
    });
  });

  it('returns down when the payload does not match the shared contract', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(jsonResponse({ ...liveness, service: 'other' })),
    );
    await expect(fetchApiStatus('http://localhost:4000', fetchImpl)).resolves.toEqual({
      state: 'down',
      reason: 'Unexpected health response',
    });
  });

  it('returns down on a network failure', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.reject(new TypeError('fetch failed')));
    await expect(fetchApiStatus('http://localhost:4000', fetchImpl)).resolves.toEqual({
      state: 'down',
      reason: 'fetch failed',
    });
  });

  it('returns down for an invalid base URL without calling fetch', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(fetchApiStatus('not a url', fetchImpl)).resolves.toEqual({
      state: 'down',
      reason: 'NEXT_PUBLIC_API_URL is not a valid URL',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
