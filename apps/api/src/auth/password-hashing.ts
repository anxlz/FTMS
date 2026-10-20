import { hash, verify } from '@node-rs/argon2';

/**
 * argon2id (the library default) with OWASP's recommended minimum parameters:
 * 19 MiB memory, 2 iterations, 1 lane. Parameters are embedded in each hash, so
 * they can be raised later without invalidating existing passwords.
 */
const OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export const hashPassword = (password: string): Promise<string> => hash(password, OPTIONS);

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    // Malformed hash: treat as a failed verification, never as a server error.
    return false;
  }
}

let dummyHash: Promise<string> | undefined;

/**
 * Burns the same work as a real verification. Used when the account does not
 * exist or has no password, so response time does not reveal which case applied.
 */
export async function verifyAgainstDummy(password: string): Promise<false> {
  dummyHash ??= hashPassword('ftms-dummy-password-for-timing-equalization');
  await verifyPassword(await dummyHash, password);
  return false;
}
