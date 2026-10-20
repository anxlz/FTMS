import { z } from 'zod';

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

export type PasswordPolicyViolation =
  | 'TOO_SHORT'
  | 'TOO_LONG'
  | 'CONTAINS_IDENTIFIER'
  | 'COMMON'
  /** Reported by the server: the new password equals the current one. */
  | 'SAME_AS_CURRENT';

/**
 * A small list of passwords that pass the length rule but are still trivially
 * guessable. Not exhaustive by design; length is the main control (NIST 800-63B).
 */
const COMMON_PASSWORDS = new Set([
  '1234567890',
  '0123456789',
  '1111111111',
  '0000000000',
  'qwertyuiop',
  'password123',
  'password1234',
  'passw0rd123',
  'asdfghjkl1',
  'iloveyou123',
  'welcome1234',
  'admin12345',
  'ainshams123',
  'agriculture1',
]);

/**
 * Returns every rule the password breaks (empty = acceptable). `identifiers` are
 * the account's email local part and seat number; a password containing them is
 * rejected because it is the first thing an attacker tries.
 */
export function checkPasswordPolicy(
  password: string,
  identifiers: readonly (string | null | undefined)[] = [],
): PasswordPolicyViolation[] {
  const violations: PasswordPolicyViolation[] = [];
  const length = [...password].length;
  if (length < PASSWORD_MIN_LENGTH) violations.push('TOO_SHORT');
  if (length > PASSWORD_MAX_LENGTH) violations.push('TOO_LONG');

  const lower = password.toLowerCase();
  const parts = identifiers
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .map((v) => (v.includes('@') ? v.slice(0, v.indexOf('@')) : v).toLowerCase())
    .filter((v) => v.length >= 4);
  if (parts.some((part) => lower.includes(part))) violations.push('CONTAINS_IDENTIFIER');
  if (COMMON_PASSWORDS.has(lower)) violations.push('COMMON');
  return violations;
}

/** Shape-only schema for request bodies; the identifier rule is applied server-side. */
export const NewPasswordSchema = z
  .string()
  .refine((v) => [...v].length >= PASSWORD_MIN_LENGTH, { error: 'PASSWORD_TOO_SHORT' })
  .refine((v) => [...v].length <= PASSWORD_MAX_LENGTH, { error: 'PASSWORD_TOO_LONG' });
