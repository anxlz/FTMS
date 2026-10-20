import { z } from 'zod';

/**
 * Environment contract for the API. Every variable is documented in the repo-root
 * `.env.example`. Values are validated once at boot; the process refuses to start
 * on an invalid configuration instead of failing later in a request.
 *
 * Outside production, external-service credentials may be absent so the scaffold
 * can boot locally: the affected service then reports `not_configured` on
 * `/health/ready`, and mail is logged instead of sent. In production every
 * credential is mandatory.
 */

/** `.env` files produce `KEY=` for unset placeholders; treat blank as absent. */
const blankToUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess(blankToUndefined, schema.optional());

const postgresUrl = z.url({
  protocol: /^postgres(ql)?$/,
  error: 'must be a postgres:// or postgresql:// connection string',
});

const isValidTimeZone = (zone: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};

/** Secrets used to sign tokens. 32+ chars ≈ 256 bits when generated as recommended. */
const signingSecret = z.string().min(32, 'must be at least 32 characters');

export const EnvObjectSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  APP_TIMEZONE: z
    .string()
    .refine(isValidTimeZone, 'must be a valid IANA time zone')
    .default('Africa/Cairo'),

  // Database (Supabase Postgres). DATABASE_URL is the runtime (pooled) connection.
  DATABASE_URL: z.preprocess(blankToUndefined, postgresUrl),
  // Direct/session connection for `prisma migrate` only; not used at runtime.
  DIRECT_URL: optional(postgresUrl),

  // Supabase Storage (server-side only — the service role key bypasses RLS).
  SUPABASE_URL: optional(z.url({ protocol: /^https?$/ })),
  SUPABASE_SERVICE_ROLE_KEY: optional(z.string().min(20)),
  SUPABASE_ANON_KEY: optional(z.string().min(20)),

  // Upstash Redis (REST).
  UPSTASH_REDIS_REST_URL: optional(z.url({ protocol: /^https$/ })),
  UPSTASH_REDIS_REST_TOKEN: optional(z.string().min(10)),

  // Gmail SMTP via Nodemailer.
  SMTP_HOST: z.preprocess(blankToUndefined, z.string().default('smtp.gmail.com')),
  SMTP_PORT: z.preprocess(blankToUndefined, z.coerce.number().int().min(1).max(65535).default(465)),
  SMTP_USER: z.preprocess(blankToUndefined, z.email().default('ST22425244@agr.asu.edu.eg')),
  SMTP_PASS: optional(z.string().min(1)),

  // Signing secrets — consumed from Phase 1 (JWT) and Phase 4 (QR); validated now.
  JWT_ACCESS_SECRET: optional(signingSecret),
  JWT_REFRESH_SECRET: optional(signingSecret),
  QR_HMAC_SECRET: optional(signingSecret),
});

/** Variables that must be present whenever NODE_ENV=production. */
export const PRODUCTION_REQUIRED = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  'SMTP_PASS',
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
  'QR_HMAC_SECRET',
] as const satisfies readonly (keyof z.infer<typeof EnvObjectSchema>)[];

/** Variables that only make sense together. */
const PAIRS = [
  ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'],
  ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'],
] as const;

export const EnvSchema = EnvObjectSchema.superRefine((env, ctx) => {
  for (const [a, b] of PAIRS) {
    if ((env[a] === undefined) !== (env[b] === undefined)) {
      const missing = env[a] === undefined ? a : b;
      ctx.addIssue({
        code: 'custom',
        path: [missing],
        message: `must be set together with ${missing === a ? b : a}`,
      });
    }
  }

  if (env.NODE_ENV !== 'production') return;

  for (const key of PRODUCTION_REQUIRED) {
    if (env[key] === undefined) {
      ctx.addIssue({ code: 'custom', path: [key], message: 'is required in production' });
    }
  }
  if (env.JWT_ACCESS_SECRET !== undefined && env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET) {
    ctx.addIssue({
      code: 'custom',
      path: ['JWT_REFRESH_SECRET'],
      message: 'must differ from JWT_ACCESS_SECRET',
    });
  }
});

export type Env = z.infer<typeof EnvSchema>;

export class InvalidEnvironmentError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid environment configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'InvalidEnvironmentError';
  }
}

/**
 * Formats issues by variable name only. Values are never echoed, so a malformed
 * secret cannot leak into logs or error trackers.
 */
export function formatIssues(issues: readonly z.core.$ZodIssue[]): string[] {
  return issues.map((issue) => {
    const key = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    const message =
      issue.code === 'invalid_type' && issue.input === undefined ? 'is required' : issue.message;
    return `${key} ${message}`;
  });
}

export function parseEnv(raw: Record<string, unknown>): Env {
  const result = EnvSchema.safeParse(raw);
  if (!result.success) throw new InvalidEnvironmentError(formatIssues(result.error.issues));
  return result.data;
}
