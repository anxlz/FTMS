import { ServiceNotConfiguredError } from '../common/errors';
import { testConfig } from '../testing/test-config';
import { RedisService } from './redis.service';

const URL_ = 'https://eu1-example.upstash.io';
const TOKEN = 'upstash-token-0123456789';

const urlOf = (input: Parameters<typeof fetch>[0]): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

/**
 * Stubs `fetch` with a minimal Upstash REST server so the real client code path
 * (request building, auth header, response decoding) is exercised offline.
 */
function stubUpstash(reply: string) {
  const encoded = Buffer.from(reply, 'utf8').toString('base64');
  return jest.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = urlOf(input);
    const base64 = new Headers(init?.headers).get('upstash-encoding') === 'base64';
    const result = base64 ? encoded : reply;
    const body = url.endsWith('/pipeline') ? [{ result }] : { result };
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
}

describe('RedisService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('reports not configured and refuses access without credentials', () => {
    const service = new RedisService(testConfig());
    expect(service.isConfigured).toBe(false);
    expect(() => service.redis).toThrow(ServiceNotConfiguredError);
  });

  describe('with credentials', () => {
    const configured = () =>
      new RedisService(
        testConfig({ UPSTASH_REDIS_REST_URL: URL_, UPSTASH_REDIS_REST_TOKEN: TOKEN }),
      );

    it('sends an authenticated PING to the Upstash REST endpoint and accepts PONG', async () => {
      const fetchSpy = stubUpstash('PONG');
      await expect(configured().ping()).resolves.toBeUndefined();

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [input, init] = fetchSpy.mock.calls[0]!;
      expect(urlOf(input)).toMatch(new RegExp(`^${URL_}`));
      expect(init?.method).toBe('POST');
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
      expect(typeof init?.body === 'string' ? init.body : '').toContain('ping');
    });

    it('rejects an unexpected PING reply', async () => {
      stubUpstash('NOPE');
      await expect(configured().ping()).rejects.toThrow('Unexpected PING reply: NOPE');
    });

    it('propagates transport failures', async () => {
      jest.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
      await expect(configured().ping()).rejects.toThrow();
    });
  });
});
