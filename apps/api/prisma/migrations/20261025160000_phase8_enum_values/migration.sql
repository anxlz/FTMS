-- ═════════════════════════════════════════════════════════════════════════════
-- Phase 8 (1/2): new enum types and values. PostgreSQL cannot use an enum value
-- in the same transaction that adds it, so the constraints that use them are in
-- the next migration.
-- ═════════════════════════════════════════════════════════════════════════════

-- CreateEnum
CREATE TYPE "BiometricCredentialKind" AS ENUM ('PASSKEY', 'ANDROID_KEY');

-- CreateEnum
CREATE TYPE "GuestCheckInOutcome" AS ENUM ('RECORDED', 'DUPLICATE', 'UNMATCHED');

-- AlterEnum
ALTER TYPE "WebAuthnPurpose" ADD VALUE 'DEVICE_REGISTRATION';
ALTER TYPE "WebAuthnPurpose" ADD VALUE 'DEVICE_LOGIN';

-- AlterEnum
ALTER TYPE "AttendanceSource" ADD VALUE 'GUEST';
