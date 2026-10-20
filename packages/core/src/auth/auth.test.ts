import { describe, expect, it } from 'vitest';
import {
  CreateUserRequestSchema,
  LoginRequestSchema,
  SetPermissionGrantsRequestSchema,
} from './contracts';
import { normalizeEmail, parseLoginIdentifier } from './identity';
import { checkPasswordPolicy } from './password-policy';
import {
  canReceiveGrants,
  PERMISSION_KEYS,
  PERMISSIONS,
  resolvePermissions,
  ROLE_DEFAULT_PERMISSIONS,
} from './permissions';

describe('identity normalization', () => {
  it('lowercases and trims emails so capitalization cannot create duplicates', () => {
    expect(normalizeEmail('  Ali.Hassan@AGR.asu.edu.EG ')).toBe('ali.hassan@agr.asu.edu.eg');
  });

  it('parses emails and seat numbers as login identifiers', () => {
    expect(parseLoginIdentifier('ST22425244@agr.asu.edu.eg')).toEqual({
      kind: 'email',
      email: 'st22425244@agr.asu.edu.eg',
    });
    expect(parseLoginIdentifier(' st-1024 ')).toEqual({ kind: 'seat', seatNumber: 'ST-1024' });
    expect(parseLoginIdentifier('not an id!')).toBeNull();
    expect(parseLoginIdentifier('broken@')).toBeNull();
  });
});

describe('password policy', () => {
  it('accepts a long, unrelated passphrase', () => {
    expect(checkPasswordPolicy('green obelisk falcon 7', ['st22425244@agr.asu.edu.eg'])).toEqual(
      [],
    );
  });

  it('rejects short, long, common and identifier-based passwords', () => {
    expect(checkPasswordPolicy('short1')).toEqual(['TOO_SHORT']);
    expect(checkPasswordPolicy('x'.repeat(129))).toEqual(['TOO_LONG']);
    expect(checkPasswordPolicy('Password123')).toEqual(['COMMON']);
    expect(checkPasswordPolicy('st22425244-secret', ['ST22425244@agr.asu.edu.eg'])).toEqual([
      'CONTAINS_IDENTIFIER',
    ]);
    expect(checkPasswordPolicy('my seat ST-1024 pw', [null, 'ST-1024'])).toEqual([
      'CONTAINS_IDENTIFIER',
    ]);
  });

  it('counts characters, not UTF-16 units, for Arabic passwords', () => {
    expect(checkPasswordPolicy('كلمةمرورطويلة')).toEqual([]);
  });
});

describe('permissions', () => {
  it('gives the Super Admin every permission regardless of grants', () => {
    expect(
      resolvePermissions('SUPER_ADMIN', [{ permission: 'audit.read', effect: 'DENY' }]),
    ).toEqual(PERMISSION_KEYS);
  });

  it('never gives students staff permissions, even with grants', () => {
    expect(resolvePermissions('STUDENT', [{ permission: 'users.read', effect: 'ALLOW' }])).toEqual(
      [],
    );
    expect(canReceiveGrants('STUDENT')).toBe(false);
  });

  it('gives the Training Director more than faculty, but no Super-Admin-only scope', () => {
    const director = new Set(resolvePermissions('TRAINING_DIRECTOR'));
    for (const key of ROLE_DEFAULT_PERMISSIONS.FACULTY) expect(director.has(key)).toBe(true);
    expect(director.has('audit.read')).toBe(true);
    expect(director.has('users.manage')).toBe(false);
    expect(director.has('permissions.manage')).toBe(false);
  });

  it('applies ALLOW and DENY grants for faculty', () => {
    const result = resolvePermissions('FACULTY', [
      { permission: 'schedule.group.manage', effect: 'ALLOW' },
      { permission: 'students.import', effect: 'DENY' },
    ]);
    expect(result).toContain('schedule.group.manage');
    expect(result).not.toContain('students.import');
  });

  it('ignores grants of non-grantable permissions', () => {
    const result = resolvePermissions('TRAINING_DIRECTOR', [
      { permission: 'users.manage', effect: 'ALLOW' },
      { permission: 'permissions.manage', effect: 'ALLOW' },
    ]);
    expect(result).not.toContain('users.manage');
    expect(result).not.toContain('permissions.manage');
  });

  it('keeps the non-grantable set to Super-Admin-only capabilities', () => {
    const nonGrantable = PERMISSION_KEYS.filter((k) => !PERMISSIONS[k].grantable);
    expect(nonGrantable).toEqual(['users.manage', 'permissions.manage', 'settings.manage']);
  });
});

describe('request contracts', () => {
  it('normalizes the email and seat number of a new student', () => {
    const parsed = CreateUserRequestSchema.parse({
      role: 'STUDENT',
      email: ' Student@AGR.asu.edu.eg',
      fullName: 'أحمد محمد علي حسن',
      seatNumber: 'st-77',
    });
    expect(parsed).toMatchObject({ email: 'student@agr.asu.edu.eg', seatNumber: 'ST-77' });
  });

  it('rejects a student without a seat number', () => {
    expect(
      CreateUserRequestSchema.safeParse({ role: 'STUDENT', email: 'a@b.eg', fullName: 'A B' })
        .success,
    ).toBe(false);
  });

  it('rejects duplicate permissions in one grant set', () => {
    const result = SetPermissionGrantsRequestSchema.safeParse({
      grants: [
        { permission: 'audit.read', effect: 'ALLOW' },
        { permission: 'audit.read', effect: 'DENY' },
      ],
      reason: 'test',
    });
    expect(result.success).toBe(false);
  });

  it('requires a non-empty password at login', () => {
    expect(LoginRequestSchema.safeParse({ identifier: 'x@y.eg', password: '' }).success).toBe(
      false,
    );
  });
});
