/**
 * Creates the first Super Admin (§2 "Super Admin bootstrap").
 *
 *   pnpm db:seed                      create the account if it does not exist
 *   pnpm db:seed -- --reset-password  issue a new one-time password (recovery)
 *
 * The generated password is printed ONCE to this terminal and never written to
 * a file, the database (only its argon2id hash) or the audit log. The account
 * must replace it at first sign-in.
 */
import { randomBytes } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { checkPasswordPolicy, normalizeEmail } from '@ftms/core';
import { hashPassword } from '../auth/password-hashing';
import { EnvObjectSchema, formatIssues } from '../config/env';
import { loadEnvFiles } from '../config/load-env-files';
import { PrismaClient } from '../generated/prisma/client';

export const SUPER_ADMIN_EMAIL = normalizeEmail('ST22425244@agr.asu.edu.eg');
export const SUPER_ADMIN_DEFAULT_NAME = 'مدير النظام';

/** 144 bits of entropy, URL-safe, re-drawn in the unlikely case it breaks the policy. */
export function generateOneTimePassword(identifiers: string[]): string {
  for (;;) {
    const candidate = randomBytes(18).toString('base64url');
    if (checkPasswordPolicy(candidate, identifiers).length === 0) return candidate;
  }
}

export type SeedResult =
  | { action: 'created' | 'reset'; userId: string; password: string }
  | { action: 'unchanged'; userId: string };

export async function seedSuperAdmin(
  prisma: PrismaClient,
  options: { resetPassword?: boolean; displayName?: string } = {},
): Promise<SeedResult> {
  const existing = await prisma.user.findUnique({ where: { email: SUPER_ADMIN_EMAIL } });

  if (existing && existing.role !== 'SUPER_ADMIN') {
    throw new Error(
      `${SUPER_ADMIN_EMAIL} exists with role ${existing.role}; refusing to change it. Fix the account first.`,
    );
  }
  if (existing && !options.resetPassword) return { action: 'unchanged', userId: existing.id };

  const password = generateOneTimePassword([SUPER_ADMIN_EMAIL]);
  const passwordHash = await hashPassword(password);
  const now = new Date();

  const userId = await prisma.$transaction(async (tx) => {
    if (!existing) {
      const user = await tx.user.create({
        data: {
          email: SUPER_ADMIN_EMAIL,
          role: 'SUPER_ADMIN',
          status: 'ACTIVE',
          displayName: options.displayName?.trim() || SUPER_ADMIN_DEFAULT_NAME,
          passwordHash,
          mustChangePassword: true,
          emailVerifiedAt: now,
        },
      });
      await tx.auditLog.create({
        data: {
          action: 'user.seeded',
          resourceType: 'user',
          resourceId: user.id,
          outcome: 'SUCCESS',
          after: {
            email: user.email,
            role: user.role,
            status: user.status,
            mustChangePassword: true,
          },
          metadata: { source: 'seed-super-admin' },
        },
      });
      return user.id;
    }

    await tx.user.update({
      where: { id: existing.id },
      data: { passwordHash, mustChangePassword: true, status: 'ACTIVE' },
    });
    const revoked = await tx.authSession.updateMany({
      where: { userId: existing.id, revokedAt: null },
      data: { revokedAt: now, revokeReason: 'admin_reset' },
    });
    await tx.auditLog.create({
      data: {
        action: 'user.password_reset_by_seed',
        resourceType: 'user',
        resourceId: existing.id,
        outcome: 'SUCCESS',
        before: { status: existing.status },
        after: { status: 'ACTIVE', mustChangePassword: true },
        metadata: { source: 'seed-super-admin', sessionsRevoked: revoked.count },
      },
    });
    return existing.id;
  });

  return { action: existing ? 'reset' : 'created', userId, password };
}

async function main(): Promise<number> {
  loadEnvFiles();
  const parsed = EnvObjectSchema.pick({ DATABASE_URL: true }).safeParse(process.env);
  if (!parsed.success) {
    process.stderr.write(`Cannot seed:\n  ${formatIssues(parsed.error.issues).join('\n  ')}\n`);
    return 1;
  }
  const args = process.argv.slice(2);
  const nameArg = args.find((a) => a.startsWith('--name='));
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: parsed.data.DATABASE_URL }),
  });
  try {
    const result = await seedSuperAdmin(prisma, {
      resetPassword: args.includes('--reset-password'),
      displayName: nameArg?.slice('--name='.length),
    });
    if (result.action === 'unchanged') {
      process.stdout.write(
        `Super Admin ${SUPER_ADMIN_EMAIL} already exists — nothing changed.\n` +
          'Use --reset-password to issue a new one-time password.\n',
      );
      return 0;
    }
    const line = '─'.repeat(64);
    process.stdout.write(
      [
        line,
        `Super Admin ${result.action === 'created' ? 'created' : 'password reset'}: ${SUPER_ADMIN_EMAIL}`,
        `One-time password: ${result.password}`,
        '',
        'This password is shown only now and is not stored anywhere in readable form.',
        'It must be changed at the first sign-in.',
        line,
        '',
      ].join('\n'),
    );
    return 0;
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(
        `Seeding failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exit(1);
    },
  );
}
