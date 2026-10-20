import { type ArgumentsHost, NotFoundException } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { redactSecrets } from '../audit/audit.service';
import { hashPassword, verifyAgainstDummy, verifyPassword } from '../auth/password-hashing';
import { ApiException, Errors } from './api-exception';
import { ApiExceptionFilter } from './api-exception.filter';
import { randomNumericCode, safeEqual } from './crypto';
import { CLIENT_IP_HEADER, PROXY_KEY_HEADER, resolveClientIp } from './request-context';
import { ZodValidationPipe } from './zod-validation.pipe';

const SECRET = 'bff-secret-0123456789abcdef0123456789';
const req = (headers: Record<string, string>, ip = '10.0.0.1') =>
  ({ headers, ip }) as unknown as Request;

describe('resolveClientIp', () => {
  it('trusts the forwarded IP only with the shared BFF key', () => {
    const forwarded = { [CLIENT_IP_HEADER]: '41.33.12.7', [PROXY_KEY_HEADER]: SECRET };
    expect(resolveClientIp(req(forwarded), SECRET)).toBe('41.33.12.7');
    expect(resolveClientIp(req({ ...forwarded, [PROXY_KEY_HEADER]: 'guess' }), SECRET)).toBe(
      '10.0.0.1',
    );
    expect(resolveClientIp(req({ [CLIENT_IP_HEADER]: '41.33.12.7' }), SECRET)).toBe('10.0.0.1');
  });

  it('ignores forwarded values when no secret is configured, and rejects non-IPs', () => {
    const forwarded = { [CLIENT_IP_HEADER]: '41.33.12.7', [PROXY_KEY_HEADER]: SECRET };
    expect(resolveClientIp(req(forwarded), undefined)).toBe('10.0.0.1');
    const junk = { [CLIENT_IP_HEADER]: 'not-an-ip', [PROXY_KEY_HEADER]: SECRET };
    expect(resolveClientIp(req(junk), SECRET)).toBe('10.0.0.1');
  });
});

describe('redactSecrets', () => {
  it('scrubs secret-looking keys at any depth but keeps boolean facts', () => {
    expect(
      redactSecrets({
        email: 'a@b.eg',
        password: 'p',
        hash: 'h',
        nested: { refreshToken: 't', otpCode: '123456', ok: 1 },
        list: [{ apiSecret: 's' }],
        hasPassword: true,
      }),
    ).toEqual({
      email: 'a@b.eg',
      password: '[redacted]',
      hash: '[redacted]',
      nested: { refreshToken: '[redacted]', otpCode: '[redacted]', ok: 1 },
      list: [{ apiSecret: '[redacted]' }],
      hasPassword: true,
    });
  });
});

describe('password hashing', () => {
  it('uses argon2id and verifies only the right password', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    await expect(verifyPassword(hash, 'correct horse battery')).resolves.toBe(true);
    await expect(verifyPassword(hash, 'wrong horse battery')).resolves.toBe(false);
  });

  it('treats a malformed hash as a failed verification', async () => {
    await expect(verifyPassword('not-a-hash', 'x')).resolves.toBe(false);
  });

  it('dummy verification always fails', async () => {
    await expect(verifyAgainstDummy('anything')).resolves.toBe(false);
  });
});

describe('crypto helpers', () => {
  it('compares strings in constant time, including different lengths', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });

  it('produces zero-padded numeric codes', () => {
    for (let i = 0; i < 200; i += 1) expect(randomNumericCode(6)).toMatch(/^\d{6}$/);
  });
});

describe('ZodValidationPipe', () => {
  const pipe = new ZodValidationPipe(
    z.object({ email: z.email({ error: 'EMAIL_INVALID' }), n: z.number() }),
  );

  it('returns parsed data', () => {
    expect(pipe.transform({ email: 'a@b.eg', n: 1 })).toEqual({ email: 'a@b.eg', n: 1 });
  });

  it('reports field-level codes', () => {
    try {
      pipe.transform({ email: 'nope' });
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiException);
      const body = (error as ApiException).toBody();
      expect(body.code).toBe('VALIDATION_FAILED');
      expect(body.details?.email).toEqual(['EMAIL_INVALID']);
      expect(body.details?.n).toHaveLength(1);
    }
  });
});

describe('ApiExceptionFilter', () => {
  function run(exception: unknown) {
    const res = {
      statusCode: 0,
      body: undefined as unknown,
      headers: {} as Record<string, string>,
      setHeader(k: string, v: string) {
        this.headers[k] = v;
      },
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(body: unknown) {
        this.body = body;
      },
    };
    const host = { switchToHttp: () => ({ getResponse: () => res }) } as unknown as ArgumentsHost;
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    new ApiExceptionFilter().catch(exception, host);
    return res;
  }

  afterEach(() => jest.restoreAllMocks());

  it('passes ApiException bodies through and sets Retry-After', () => {
    const res = run(Errors.rateLimited(42));
    expect(res.statusCode).toBe(429);
    expect(res.headers['Retry-After']).toBe('42');
    expect(res.body).toMatchObject({ code: 'AUTH_RATE_LIMITED', retryAfterSeconds: 42 });
  });

  it('maps framework HTTP errors to stable codes', () => {
    expect(run(new NotFoundException('Cannot GET /x')).body).toEqual({
      statusCode: 404,
      code: 'NOT_FOUND',
      message: 'Cannot GET /x',
    });
  });

  it('hides unexpected errors behind a generic 500', () => {
    const res = run(new Error('connection string postgresql://user:pw@db leaked?'));
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({
      statusCode: 500,
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
    });
  });
});
