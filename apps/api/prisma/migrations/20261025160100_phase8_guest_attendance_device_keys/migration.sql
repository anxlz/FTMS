-- ═════════════════════════════════════════════════════════════════════════════
-- Phase 8 (2/2): Android app support.
--
-- * Attendance no longer depends on biometrics: the Phase 4 check-in policy
--   (biometric fallback, optional location) is replaced by a location policy —
--   a reading is always required; the program may limit its distance from the
--   visit and its accuracy. The two old policy columns are dropped: they hold
--   one setting each (no records), and their history stays in the audit log.
-- * Guest attendance: submissions without signing in, typed name and seat number
--   (NOT verified), stored append-only; a matched seat number creates an
--   attendance record with source GUEST.
-- * Biometric sign-in with an Android Keystore key (ANDROID_KEY credentials) next
--   to WebAuthn passkeys, with challenges bound to the credential.
-- Existing rows are kept unchanged. Covered by apps/api/test/guest-attendance,
-- device-keys and attendance-database e2e suites.
-- ═════════════════════════════════════════════════════════════════════════════

-- AlterTable
ALTER TABLE "training_programs" DROP COLUMN "biometric_fallback",
DROP COLUMN "geolocation_policy",
ADD COLUMN     "location_max_accuracy_meters" INTEGER,
ADD COLUMN     "location_radius_meters" INTEGER;

-- AlterTable
ALTER TABLE "webauthn_credentials" ADD COLUMN     "kind" "BiometricCredentialKind" NOT NULL DEFAULT 'PASSKEY';

-- AlterTable
ALTER TABLE "webauthn_challenges" ADD COLUMN     "credential_id" VARCHAR(1024);

-- DropEnum
DROP TYPE "BiometricFallback";

-- DropEnum
DROP TYPE "GeolocationPolicy";

-- CreateTable
CREATE TABLE "guest_check_ins" (
    "id" UUID NOT NULL,
    "visit_id" UUID NOT NULL,
    "submission_key" UUID NOT NULL,
    "full_name" VARCHAR(200) NOT NULL,
    "seat_number" VARCHAR(20) NOT NULL,
    "status" "AttendanceStatus" NOT NULL,
    "minutes_late" INTEGER NOT NULL DEFAULT 0,
    "submitted_at" TIMESTAMPTZ(3) NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "accuracy_meters" DOUBLE PRECISION,
    "distance_meters" INTEGER,
    "outcome" "GuestCheckInOutcome" NOT NULL,
    "student_id" UUID,
    "attendance_record_id" UUID,
    "name_matches" BOOLEAN,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "guest_check_ins_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "guest_check_ins_attendance_record_id_key" ON "guest_check_ins"("attendance_record_id");

-- CreateIndex
CREATE INDEX "guest_check_ins_visit_id_seat_number_idx" ON "guest_check_ins"("visit_id", "seat_number");

-- CreateIndex
CREATE UNIQUE INDEX "guest_check_ins_visit_id_submission_key_key" ON "guest_check_ins"("visit_id", "submission_key");

-- AddForeignKey
ALTER TABLE "guest_check_ins" ADD CONSTRAINT "guest_check_ins_visit_id_fkey" FOREIGN KEY ("visit_id") REFERENCES "training_visits"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guest_check_ins" ADD CONSTRAINT "guest_check_ins_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "student_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guest_check_ins" ADD CONSTRAINT "guest_check_ins_attendance_record_id_fkey" FOREIGN KEY ("attendance_record_id") REFERENCES "attendance_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Location policy (§7.2 as revised in Phase 8) ─────────────────────────────
ALTER TABLE "training_programs"
  ADD CONSTRAINT "training_programs_location_policy" CHECK (
    ("location_radius_meters" IS NULL OR "location_radius_meters" BETWEEN 10 AND 100000) AND
    ("location_max_accuracy_meters" IS NULL OR "location_max_accuracy_meters" BETWEEN 5 AND 10000));

-- ── Biometric sign-in credentials: passkeys and Android device keys ──────────
-- An Android key has no authenticator counter, transports or model id.
ALTER TABLE "webauthn_credentials"
  ADD CONSTRAINT "webauthn_credentials_kind" CHECK (
    "kind" = 'PASSKEY' OR ("sign_count" = 0 AND cardinality("transports") = 0 AND "aaguid" IS NULL));

-- The kind joins the fields that never change after enrollment.
CREATE OR REPLACE FUNCTION "ftms_check_credential_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."user_id" <> OLD."user_id" OR NEW."credential_id" <> OLD."credential_id"
     OR NEW."public_key" <> OLD."public_key" OR NEW."created_at" <> OLD."created_at"
     OR NEW."kind" <> OLD."kind" THEN
    RAISE EXCEPTION 'credential % belongs to the account that enrolled it', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."revoked_at" IS NOT NULL AND NEW."revoked_at" IS DISTINCT FROM OLD."revoked_at" THEN
    RAISE EXCEPTION 'credential % has been revoked', OLD."id" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- Registration challenges name the account; a device sign-in challenge names the
-- credential and no account; a check-in challenge (Phase 4 rows) names the visit.
ALTER TABLE "webauthn_challenges" DROP CONSTRAINT "webauthn_challenges_binding";
ALTER TABLE "webauthn_challenges"
  ADD CONSTRAINT "webauthn_challenges_binding" CHECK (
    ("purpose" = 'CHECK_IN') = ("visit_id" IS NOT NULL) AND
    ("purpose" = 'DEVICE_LOGIN') = ("credential_id" IS NOT NULL) AND
    ("purpose" IN ('AUTHENTICATION', 'DEVICE_LOGIN') OR "user_id" IS NOT NULL) AND
    ("purpose" <> 'DEVICE_LOGIN' OR "user_id" IS NULL) AND
    "expires_at" > "created_at");

-- ── Attendance sources: a guest record has a time and is never biometric ─────
ALTER TABLE "attendance_records" DROP CONSTRAINT "attendance_records_source";
ALTER TABLE "attendance_records"
  ADD CONSTRAINT "attendance_records_source" CHECK (
    ("source" NOT IN ('QR', 'GUEST') OR "checked_in_at" IS NOT NULL) AND
    ("source" <> 'MANUAL' OR "corrected_at" IS NOT NULL) AND
    ("source" <> 'AUTOMATIC' OR ("status" = 'ABSENT' AND "checked_in_at" IS NULL)) AND
    ("source" <> 'GUEST' OR ("status" <> 'ABSENT' AND "biometric_verified" = false)) AND
    ("biometric_verified" = false OR "checked_in_at" IS NOT NULL));

-- ── Guest submissions ────────────────────────────────────────────────────────
ALTER TABLE "guest_check_ins"
  ADD CONSTRAINT "guest_check_ins_values" CHECK (
    "full_name" = btrim("full_name") AND length("full_name") >= 3 AND
    "seat_number" ~ '^[A-Z0-9-]{1,20}$' AND
    "status" IN ('PRESENT', 'LATE') AND
    ("status" = 'LATE') = ("minutes_late" > 0) AND "minutes_late" BETWEEN 0 AND 720 AND
    "latitude" BETWEEN -90 AND 90 AND "longitude" BETWEEN -180 AND 180 AND
    ("accuracy_meters" IS NULL OR "accuracy_meters" >= 0) AND
    ("distance_meters" IS NULL OR "distance_meters" >= 0));
ALTER TABLE "guest_check_ins"
  ADD CONSTRAINT "guest_check_ins_outcome" CHECK (
    ("outcome" = 'RECORDED') = ("attendance_record_id" IS NOT NULL) AND
    ("outcome" <> 'RECORDED' OR "student_id" IS NOT NULL) AND
    ("outcome" <> 'UNMATCHED' OR "student_id" IS NULL) AND
    ("student_id" IS NULL) = ("name_matches" IS NULL));

-- A submission concerns a visit that takes place; the record it created is the
-- guest record of the same visit and student.
CREATE FUNCTION "ftms_check_guest_check_in"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  visit_status "VisitStatus";
BEGIN
  SELECT "status" INTO visit_status FROM "training_visits" WHERE "id" = NEW."visit_id" FOR SHARE;
  IF visit_status IS DISTINCT FROM 'SCHEDULED' THEN
    RAISE EXCEPTION 'visit % is cancelled: attendance cannot be registered', NEW."visit_id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."attendance_record_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "attendance_records"
    WHERE "id" = NEW."attendance_record_id" AND "visit_id" = NEW."visit_id"
      AND "student_id" = NEW."student_id" AND "source" = 'GUEST'
  ) THEN
    RAISE EXCEPTION 'guest submission % does not match its attendance record', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "guest_check_ins_check"
  BEFORE INSERT ON "guest_check_ins"
  FOR EACH ROW EXECUTE FUNCTION "ftms_check_guest_check_in"();
CREATE TRIGGER "guest_check_ins_append_only"
  BEFORE UPDATE OR DELETE ON "guest_check_ins"
  FOR EACH ROW EXECUTE FUNCTION "ftms_append_only"();

-- ── Row Level Security (Supabase Data API gets nothing; see Phase 1) ────────
ALTER TABLE "guest_check_ins" ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  api_role TEXT;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', api_role);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
