-- CreateEnum
CREATE TYPE "Role" AS ENUM ('SUPER_ADMIN', 'TRAINING_DIRECTOR', 'FACULTY', 'STUDENT');

-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "Locale" AS ENUM ('ar', 'en');

-- CreateEnum
CREATE TYPE "GrantEffect" AS ENUM ('ALLOW', 'DENY');

-- CreateEnum
CREATE TYPE "AuthMethod" AS ENUM ('PASSWORD', 'EMAIL_CODE');

-- CreateEnum
CREATE TYPE "ChallengePurpose" AS ENUM ('LOGIN', 'PASSWORD_RESET');

-- CreateEnum
CREATE TYPE "AuditOutcome" AS ENUM ('SUCCESS', 'FAILURE');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "role" "Role" NOT NULL,
    "status" "AccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "display_name" VARCHAR(200) NOT NULL,
    "password_hash" TEXT,
    "must_change_password" BOOLEAN NOT NULL DEFAULT false,
    "password_changed_at" TIMESTAMPTZ(3),
    "email_verified_at" TIMESTAMPTZ(3),
    "preferred_locale" "Locale" NOT NULL DEFAULT 'ar',
    "last_login_at" TIMESTAMPTZ(3),
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_profiles" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "seat_number" VARCHAR(20) NOT NULL,
    "full_name" VARCHAR(200) NOT NULL,
    "first_name" VARCHAR(60),
    "father_name" VARCHAR(60),
    "grandfather_name" VARCHAR(60),
    "family_name" VARCHAR(60),
    "university_email" VARCHAR(254),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "student_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "faculty_profiles" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "full_name" VARCHAR(200) NOT NULL,
    "academic_title" VARCHAR(100),
    "department" VARCHAR(200),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "faculty_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "key" VARCHAR(64) NOT NULL,
    "description" VARCHAR(200) NOT NULL,
    "grantable" BOOLEAN NOT NULL,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "user_permission_grants" (
    "user_id" UUID NOT NULL,
    "permission_key" VARCHAR(64) NOT NULL,
    "effect" "GrantEffect" NOT NULL,
    "granted_by_id" UUID,
    "reason" VARCHAR(500) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_permission_grants_pkey" PRIMARY KEY ("user_id","permission_key")
);

-- CreateTable
CREATE TABLE "auth_sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "method" "AuthMethod" NOT NULL,
    "current_refresh_hash" CHAR(64) NOT NULL,
    "previous_refresh_hash" CHAR(64),
    "rotated_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "revoke_reason" VARCHAR(64),
    "ip" VARCHAR(64),
    "user_agent" VARCHAR(512),

    CONSTRAINT "auth_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_challenges" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "purpose" "ChallengePurpose" NOT NULL,
    "code_hash" CHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL,
    "consumed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "request_ip" VARCHAR(64),

    CONSTRAINT "auth_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" BIGSERIAL NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_id" UUID,
    "actor_name" VARCHAR(200),
    "actor_role" "Role",
    "action" VARCHAR(100) NOT NULL,
    "resource_type" VARCHAR(64) NOT NULL,
    "resource_id" VARCHAR(64),
    "outcome" "AuditOutcome" NOT NULL,
    "reason" VARCHAR(500),
    "before" JSONB,
    "after" JSONB,
    "metadata" JSONB,
    "ip" VARCHAR(64),
    "user_agent" VARCHAR(512),

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_role_status_idx" ON "users"("role", "status");

-- CreateIndex
CREATE UNIQUE INDEX "student_profiles_user_id_key" ON "student_profiles"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "student_profiles_seat_number_key" ON "student_profiles"("seat_number");

-- CreateIndex
CREATE UNIQUE INDEX "student_profiles_university_email_key" ON "student_profiles"("university_email");

-- CreateIndex
CREATE UNIQUE INDEX "faculty_profiles_user_id_key" ON "faculty_profiles"("user_id");

-- CreateIndex
CREATE INDEX "auth_sessions_user_id_revoked_at_idx" ON "auth_sessions"("user_id", "revoked_at");

-- CreateIndex
CREATE INDEX "auth_challenges_user_id_purpose_created_at_idx" ON "auth_challenges"("user_id", "purpose", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_occurred_at_idx" ON "audit_logs"("occurred_at");

-- CreateIndex
CREATE INDEX "audit_logs_actor_id_occurred_at_idx" ON "audit_logs"("actor_id", "occurred_at");

-- CreateIndex
CREATE INDEX "audit_logs_resource_type_resource_id_idx" ON "audit_logs"("resource_type", "resource_id");

-- CreateIndex
CREATE INDEX "audit_logs_action_occurred_at_idx" ON "audit_logs"("action", "occurred_at");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_profiles" ADD CONSTRAINT "student_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "faculty_profiles" ADD CONSTRAINT "faculty_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_permission_grants" ADD CONSTRAINT "user_permission_grants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_permission_grants" ADD CONSTRAINT "user_permission_grants_granted_by_id_fkey" FOREIGN KEY ("granted_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_permission_grants" ADD CONSTRAINT "user_permission_grants_permission_key_fkey" FOREIGN KEY ("permission_key") REFERENCES "permissions"("key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_challenges" ADD CONSTRAINT "auth_challenges_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ═════════════════════════════════════════════════════════════════════════════
-- Hand-written below: rules Prisma's schema language cannot express.
-- Covered by apps/api/test/database.e2e-spec.ts.
-- ═════════════════════════════════════════════════════════════════════════════

-- ── Normalized identities (§4.2: no duplicates through capitalization) ──────
ALTER TABLE "users"
  ADD CONSTRAINT "users_email_normalized"
  CHECK ("email" = lower(btrim("email")) AND position('@' IN "email") > 1);
ALTER TABLE "users"
  ADD CONSTRAINT "users_display_name_present" CHECK (btrim("display_name") <> '');
ALTER TABLE "student_profiles"
  ADD CONSTRAINT "student_profiles_seat_number_format" CHECK ("seat_number" ~ '^[A-Z0-9-]{1,20}$');
ALTER TABLE "student_profiles"
  ADD CONSTRAINT "student_profiles_university_email_normalized"
  CHECK ("university_email" IS NULL OR "university_email" = lower(btrim("university_email")));
ALTER TABLE "student_profiles"
  ADD CONSTRAINT "student_profiles_full_name_present" CHECK (btrim("full_name") <> '');
ALTER TABLE "faculty_profiles"
  ADD CONSTRAINT "faculty_profiles_full_name_present" CHECK (btrim("full_name") <> '');
ALTER TABLE "auth_challenges"
  ADD CONSTRAINT "auth_challenges_attempts_range"
  CHECK ("attempts" >= 0 AND "max_attempts" > 0 AND "attempts" <= "max_attempts");
ALTER TABLE "auth_sessions"
  ADD CONSTRAINT "auth_sessions_expiry_after_creation" CHECK ("expires_at" > "created_at");

-- ── Permission catalog (generated from @ftms/core PERMISSIONS) ──────────────
INSERT INTO "permissions" ("key", "description", "grantable") VALUES
  ('users.read', 'View user accounts', true),
  ('users.manage', 'Create any account, change roles and account states', false),
  ('faculty.manage', 'Create and suspend faculty accounts', true),
  ('permissions.manage', 'Grant or revoke individual permissions', false),
  ('settings.manage', 'Manage global application settings', false),
  ('audit.read', 'Read administrative audit logs', true),
  ('students.read', 'View student records', true),
  ('students.manage', 'Edit student records', true),
  ('students.import', 'Import students from spreadsheets', true),
  ('profile_changes.decide', 'Approve or reject protected profile changes', true),
  ('groups.manage', 'Create groups and manage membership', true),
  ('schedule.manage', 'Configure the training-wide schedule', true),
  ('schedule.group.manage', 'Configure group-specific training schedules', true),
  ('visits.manage', 'Create, edit and cancel training visits', true),
  ('attendance.read', 'View attendance records', true),
  ('attendance.correct', 'Correct attendance status and lateness', true),
  ('attendance.settings.defaults', 'Configure training-wide attendance defaults', true),
  ('attendance.settings.visit', 'Override attendance settings for a visit', true),
  ('tickets.process', 'Review and process support tickets', true),
  ('group_swaps.decide', 'Approve or reject group-swap requests', true),
  ('group_swaps.audit', 'See who decided group-swap requests', true),
  ('reports.export', 'Export attendance reports', true);

-- ── Valid role / profile / grant combinations (§16.1) ──────────────────────
-- A student profile can only belong to a STUDENT account, a faculty profile
-- only to a staff account, and per-user grants only to Training Directors and
-- Faculty, and never for a Super-Admin-only (non-grantable) permission.
CREATE FUNCTION "ftms_check_profile_role"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  account_role "Role";
BEGIN
  IF NEW."user_id" IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT "role" INTO account_role FROM "users" WHERE "id" = NEW."user_id";
  IF TG_TABLE_NAME = 'student_profiles' AND account_role <> 'STUDENT' THEN
    RAISE EXCEPTION 'student profile % cannot belong to a % account', NEW."id", account_role
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_TABLE_NAME = 'faculty_profiles' AND account_role = 'STUDENT' THEN
    RAISE EXCEPTION 'faculty profile % cannot belong to a STUDENT account', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "student_profiles_role_check"
  BEFORE INSERT OR UPDATE OF "user_id" ON "student_profiles"
  FOR EACH ROW EXECUTE FUNCTION "ftms_check_profile_role"();
CREATE TRIGGER "faculty_profiles_role_check"
  BEFORE INSERT OR UPDATE OF "user_id" ON "faculty_profiles"
  FOR EACH ROW EXECUTE FUNCTION "ftms_check_profile_role"();

CREATE FUNCTION "ftms_check_permission_grant"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  account_role "Role";
  is_grantable BOOLEAN;
BEGIN
  SELECT "role" INTO account_role FROM "users" WHERE "id" = NEW."user_id";
  SELECT "grantable" INTO is_grantable FROM "permissions" WHERE "key" = NEW."permission_key";
  IF account_role NOT IN ('TRAINING_DIRECTOR', 'FACULTY') THEN
    RAISE EXCEPTION 'permission grants are not allowed for % accounts', account_role
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT is_grantable THEN
    RAISE EXCEPTION 'permission % cannot be granted', NEW."permission_key"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "user_permission_grants_check"
  BEFORE INSERT OR UPDATE ON "user_permission_grants"
  FOR EACH ROW EXECUTE FUNCTION "ftms_check_permission_grant"();

-- Students and staff are different kinds of identity: a role change across that
-- line would orphan a profile, and a role that cannot hold grants must not keep any.
CREATE FUNCTION "ftms_check_role_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."role" = OLD."role" THEN
    RETURN NEW;
  END IF;
  IF OLD."role" = 'STUDENT' OR NEW."role" = 'STUDENT' THEN
    RAISE EXCEPTION 'cannot change role between STUDENT and staff (user %)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."role" NOT IN ('TRAINING_DIRECTOR', 'FACULTY')
     AND EXISTS (SELECT 1 FROM "user_permission_grants" WHERE "user_id" = NEW."id") THEN
    RAISE EXCEPTION 'remove permission grants before changing user % to %', NEW."id", NEW."role"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "users_role_change_check"
  BEFORE UPDATE OF "role" ON "users"
  FOR EACH ROW EXECUTE FUNCTION "ftms_check_role_change"();

-- ── Append-only audit log (§15.4) ──────────────────────────────────────────
CREATE FUNCTION "ftms_audit_logs_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE TRIGGER "audit_logs_no_update_delete"
  BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION "ftms_audit_logs_append_only"();
CREATE TRIGGER "audit_logs_no_truncate"
  BEFORE TRUNCATE ON "audit_logs"
  FOR EACH STATEMENT EXECUTE FUNCTION "ftms_audit_logs_append_only"();

-- ── Row Level Security (Supabase) ──────────────────────────────────────────
-- Supabase exposes the `public` schema through its Data API to anyone holding
-- the anon key. FTMS never uses that API: all access goes through the NestJS
-- API, which connects as the table owner (owners bypass RLS). Enabling RLS with
-- no policies therefore denies the Data API everything. Every future migration
-- that creates a table must enable RLS too — the structure test enforces it.
DO $$
BEGIN
  -- Absent in Prisma's shadow database, present everywhere migrations are recorded.
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    ALTER TABLE "_prisma_migrations" ENABLE ROW LEVEL SECURITY;
  END IF;
END $$;
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "student_profiles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "faculty_profiles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "permissions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_permission_grants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "auth_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "auth_challenges" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_logs" ENABLE ROW LEVEL SECURITY;

-- On Supabase, also withdraw the Data API roles' table privileges, now and for
-- tables created later. (These roles do not exist on a plain Postgres.)
DO $$
DECLARE
  api_role TEXT;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', api_role);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', api_role);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', api_role);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
