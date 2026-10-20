import {
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'node:crypto';

export const sha256Hex = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

export const hmacSha256Hex = (key: Buffer, value: string): string =>
  createHmac('sha256', key).update(value, 'utf8').digest('hex');

/** URL-safe random token with `bytes` bytes of entropy. */
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');

/** Uniformly distributed numeric code, zero-padded (e.g. "004217"). */
export const randomNumericCode = (digits = 6): string =>
  randomInt(0, 10 ** digits)
    .toString()
    .padStart(digits, '0');

/** Constant-time comparison of two strings of possibly different length. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) {
    // Compare against itself so the call costs the same either way.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/** Derives an independent sub-key from a secret, so one env secret can serve several purposes safely. */
export const deriveKey = (secret: string, purpose: string): Buffer =>
  Buffer.from(hkdfSync('sha256', secret, 'ftms', purpose, 32));
