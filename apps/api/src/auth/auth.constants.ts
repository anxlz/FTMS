/**
 * Authentication tuning. Kept in code (reviewed, versioned) rather than env.
 */
export const AUTH = {
  issuer: 'ftms-api',
  audience: 'ftms',
  /** Short-lived: a stolen access token is useful for minutes, not days. */
  accessTokenSeconds: 15 * 60,
  /** Absolute session lifetime; refresh rotation does not extend it. */
  sessionSeconds: 30 * 24 * 60 * 60,
  /** A just-rotated refresh token stays usable this long (parallel tabs/requests). */
  refreshGraceSeconds: 60,

  codeDigits: 6,
  codeSeconds: 10 * 60,
  codeMaxAttempts: 5,
} as const;

/** Fixed-window limits: `limit` hits per `windowSeconds`. */
export const LIMITS = {
  loginFailuresPerIdentifier: { limit: 10, windowSeconds: 15 * 60 },
  loginFailuresPerIp: { limit: 50, windowSeconds: 15 * 60 },
  codeRequestsPerEmail: { limit: 5, windowSeconds: 60 * 60 },
  codeRequestCooldownPerEmail: { limit: 1, windowSeconds: 60 },
  codeRequestsPerIp: { limit: 30, windowSeconds: 60 * 60 },
  codeFailuresPerEmail: { limit: 10, windowSeconds: 15 * 60 },
  codeFailuresPerIp: { limit: 50, windowSeconds: 15 * 60 },
  passwordChangeFailuresPerUser: { limit: 10, windowSeconds: 15 * 60 },
  biometricOptionsPerIp: { limit: 60, windowSeconds: 15 * 60 },
  biometricFailuresPerIp: { limit: 30, windowSeconds: 15 * 60 },
  checkInAttemptsPerUser: { limit: 20, windowSeconds: 10 * 60 },
  // Guest attendance (Phase 8): no account to count against, so per client IP.
  // A whole group may share one network, so the limits allow a classroom at once.
  guestContextPerIp: { limit: 300, windowSeconds: 10 * 60 },
  guestSubmissionsPerIp: { limit: 120, windowSeconds: 10 * 60 },
  // Device-key sign-in (Phase 8): failures per client IP, like passkeys.
  deviceKeyFailuresPerIp: { limit: 30, windowSeconds: 15 * 60 },
} as const;

export type LimitPolicy = (typeof LIMITS)[keyof typeof LIMITS];
