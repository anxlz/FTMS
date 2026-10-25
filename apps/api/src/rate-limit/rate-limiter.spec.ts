import { Logger } from '@nestjs/common';
import { Redis } from '@upstash/redis';
import { MemoryRateLimiter, rateLimitKey, UpstashRateLimiter } from './rate-limiter';

describe('rateLimitKey', () => {
  it('hashes the subject so no personal data reaches Redis', () => {
    const key = rateLimitKey('login-id', 'Student@AGR.asu.edu.eg');
    expect(key).toMatch(/^ftms:rl:login-id:[0-9a-f]{64}$/);
    expect(key).not.toContain('student');
    expect(rateLimitKey('login-id', 'student@agr.asu.edu.eg')).toBe(key);
  });
});

describe('MemoryRateLimiter', () => {
  it('counts hits within a window and resets after it', async () => {
    let now = 1_000_000;
    const limiter = new MemoryRateLimiter(() => now);
    expect(await limiter.hit('k', 60)).toEqual({ count: 1, resetInSeconds: 60 });
    now += 30_000;
    expect(await limiter.hit('k', 60)).toEqual({ count: 2, resetInSeconds: 30 });
    expect(await limiter.peek('k')).toEqual({ count: 2, resetInSeconds: 30 });
    now += 30_000;
    expect(await limiter.peek('k')).toEqual({ count: 0, resetInSeconds: 0 });
    expect(await limiter.hit('k', 60)).toEqual({ count: 1, resetInSeconds: 60 });
  });

  it('resets a single key', async () => {
    const limiter = new MemoryRateLimiter();
    await limiter.hit('a', 60);
    await limiter.hit('b', 60);
    await limiter.reset('a');
    expect((await limiter.peek('a')).count).toBe(0);
    expect((await limiter.peek('b')).count).toBe(1);
  });
});

describe('UpstashRateLimiter (against a stubbed Upstash REST API)', () => {
  afterEach(() => jest.restoreAllMocks());

  /** Minimal in-memory Redis behind Upstash's /multi-exec and /pipeline endpoints. */
  function stubUpstash() {
    const store = new Map<string, { value: number; ttl: number }>();
    const run = (cmd: (string | number)[]): unknown => {
      const [name, key, ...args] = cmd.map(String);
      switch (name!.toLowerCase()) {
        case 'set': {
          const nx = args.map((a) => a.toLowerCase()).includes('nx');
          if (nx && store.has(key!)) return null;
          const ex = args.findIndex((a) => a.toLowerCase() === 'ex');
          store.set(key!, { value: Number(args[0]), ttl: ex >= 0 ? Number(args[ex + 1]) : -1 });
          return 'OK';
        }
        case 'incr': {
          const entry = store.get(key!) ?? { value: 0, ttl: -1 };
          entry.value += 1;
          store.set(key!, entry);
          return entry.value;
        }
        case 'ttl':
          return store.get(key!)?.ttl ?? -2;
        case 'get':
          return store.has(key!) ? String(store.get(key!)!.value) : null;
        case 'del':
          return store.delete(key!) ? 1 : 0;
        default:
          throw new Error(`unsupported command ${name}`);
      }
    };
    const encode = (v: unknown) => (typeof v === 'string' ? Buffer.from(v).toString('base64') : v);
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : 'null') as
        (string | number)[] | (string | number)[][];
      const base64 = new Headers(init?.headers).get('upstash-encoding') === 'base64';
      const wrap = (v: unknown) => ({ result: base64 ? encode(v) : v });
      const payload =
        url.endsWith('/multi-exec') || url.endsWith('/pipeline')
          ? (body as (string | number)[][]).map((c) => wrap(run(c)))
          : wrap(run(body as (string | number)[]));
      return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }));
    });
    const redis = new Redis({
      url: 'https://eu1-example.upstash.io',
      token: 'token-0123456789',
      enableTelemetry: false,
      enableAutoPipelining: false,
    });
    return { limiter: new UpstashRateLimiter(redis), fetchSpy, store };
  }

  it('opens a window atomically in one MULTI/EXEC round trip and counts', async () => {
    const { limiter, fetchSpy } = stubUpstash();
    expect(await limiter.hit('ftms:rl:t:abc', 900)).toEqual({ count: 1, resetInSeconds: 900 });
    expect(await limiter.hit('ftms:rl:t:abc', 900)).toEqual({ count: 2, resetInSeconds: 900 });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const first = fetchSpy.mock.calls[0]![0];
    const firstUrl =
      typeof first === 'string' ? first : first instanceof URL ? first.href : first.url;
    expect(firstUrl).toMatch(/\/multi-exec$/);
  });

  it('peeks without incrementing, and resets', async () => {
    const { limiter } = stubUpstash();
    await limiter.hit('k', 60);
    expect(await limiter.peek('k')).toEqual({ count: 1, resetInSeconds: 60 });
    expect(await limiter.peek('k')).toEqual({ count: 1, resetInSeconds: 60 });
    await limiter.reset('k');
    expect(await limiter.peek('k')).toEqual({ count: 0, resetInSeconds: 0 });
  });

  it('fails closed with 503 SERVICE_UNAVAILABLE when Redis cannot be reached', async () => {
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const limiter = new UpstashRateLimiter(
      new Redis({
        url: 'https://eu1-example.upstash.io',
        token: 'token-0123456789',
        enableTelemetry: false,
        enableAutoPipelining: false,
        retry: false,
      }),
    );
    for (const call of [
      () => limiter.hit('k', 60),
      () => limiter.peek('k'),
      () => limiter.reset('k'),
    ]) {
      await expect(call()).rejects.toMatchObject({
        statusCode: 503,
        code: 'SERVICE_UNAVAILABLE',
      });
    }
  });
});
