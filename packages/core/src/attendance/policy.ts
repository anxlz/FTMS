import { z } from 'zod';

/* ─────────────────────────── check-in policy (§7.2, §11.1) ─────────────────────────── */

/**
 * What happens when a student has no biometric credential enrolled (§7.2
 * fallback): check in without it — the record is marked "not biometrically
 * confirmed" for faculty review — or be refused until biometrics are enabled.
 * Students who have enrolled a credential must always confirm with it.
 */
export const BIOMETRIC_FALLBACKS = ['ALLOW_UNVERIFIED', 'REQUIRE_BIOMETRIC'] as const;
export type BiometricFallback = (typeof BIOMETRIC_FALLBACKS)[number];

/**
 * Whether a check-in without biometrics (the fallback flow) must carry the
 * device's current location. A student with an enrolled device always submits
 * both the biometric confirmation and the location (§7.2).
 */
export const GEOLOCATION_POLICIES = ['REQUIRED', 'OPTIONAL'] as const;
export type GeolocationPolicy = (typeof GEOLOCATION_POLICIES)[number];

export const CheckInPolicySchema = z.object({
  biometricFallback: z.enum(BIOMETRIC_FALLBACKS),
  geolocation: z.enum(GEOLOCATION_POLICIES),
});
export type CheckInPolicy = z.infer<typeof CheckInPolicySchema>;
