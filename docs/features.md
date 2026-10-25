# Completed features

The Field Training Management System of the Faculty of Agriculture, Ain Shams
University, as delivered at the end of Phase 8. Every feature below works end to end
(database → API → web interface) and is covered by automated tests on a real Postgres
([testing.md](testing.md)); nothing listed is a static screen. Per-phase detail is in
[`checkpoints/`](checkpoints/).

## Everyone

- Arabic (default, right-to-left) and English (left-to-right) with a persistent
  switcher; the choice is saved to the account. Western digits, Africa/Cairo times.
- Sign-in by email or seat number + password, by emailed code, or — optionally — by
  fingerprint/face (WebAuthn passkey in a browser, a Keystore key in the Android app);
  password recovery; forced password change where required
  ([authentication.md](authentication.md)).
- **Android app** (Phase 8, Tauri 2): the same web app with native camera QR scanning,
  the device location and optional biometric login ([mobile.md](mobile.md)).
- **Guest attendance** (Phase 8): from a visit's QR code or the landing screen (`/start`,
  where the Android app opens: **Log In** / **Continue as Guest**), "Continue as Guest" records
  attendance with a typed full name and seat number and the device location — no account,
  password, code or identity check; the typed details are not verified
  ([attendance-rules.md](attendance-rules.md#guest-attendance-phase-8)).
- Notification center with unread count; every notification in the reader's language.
- Responsive layout from phone to desktop; accessible pages (WCAG 2.1 A/AA checks pass on
  every page); translated error and not-found pages.

## Students

- **Account:** sign up with the university email and seat number (linked to the imported
  record automatically or after review); first sign-in of imported students by emailed
  code; profile with phone change and protected corrections (name, seat number) by
  request; Profile → Security: optional biometric login (turn on, name, remove), never
  needed for attendance.
- **Calendar:** visits of their current group only, with details, place, map link, cover
  photo and documents; changes and cancellations notified.
- **Attendance:** QR check-in (camera scanner in the Android app) with the device
  location — no biometric step — and the result explained (present / late with minutes /
  not open / closed / already recorded / location problems); notified when a guest
  submission used their seat number; history, totals and remaining permitted absences.
- **Support tickets:** complaints and problems, suggestions and questions with
  attachments; conversation, status and outcome — without seeing which staff member
  answered or decided.
- **Group swaps:** request a mutual swap with a named student of another group; the other
  student accepts or declines; faculty approve or reject with a reason; both groups
  change atomically on approval.

## Faculty

- **Students:** search, create, edit, delete (when safe); Excel import with a row-by-row
  preview and explicit confirmation; account verification queue; profile-correction
  decisions.
- **Groups:** create, rename, archive (when empty); add, move and remove members with
  history (one active group per student, enforced by the database).
- **Visits:** create, edit, cancel and restore visits for one or several groups with
  place, coordinates, cover photo and documents; per-visit timing overrides; printable
  details and attendance QR codes.
- **Attendance:** per-visit table with status, minutes late, how it was recorded (QR,
  guest form, correction, automatic) and location; every guest submission as typed, with
  its match; corrections with reasons; training-wide and per-group dashboards; CSV, XLSX
  and PDF exports with filters.
- **Tickets:** queue with search and filters; replies, internal notes, status and outcome.
- **Group swaps:** review queue showing both students' groups then and now; approve or
  reject with a mandatory reason.

## Training Director

Everything faculty can do, plus:

- **Program and schedule:** program settings (start, duration, allowed absences, default
  check-in timing — all configurable), weekly schedules that generate visits, days off;
  configuration history with previous and new values.
- **Check-in location policy:** maximum distance from the visit and required accuracy
  (each optional); a location reading is always required.
- **Oversight:** the activity (audit) log with search, filters, per-event before/after
  comparison, the affected record and related events; decisions view; faculty activity
  per staff member; group-swap decision history with who decided.
- **Reports:** attendance standing per student, faculty activity report, activity-log
  export — each permission-restricted and audited.
- **Staff:** view accounts, create and suspend faculty accounts.

## Super Admin

- Every permission; creates any account, changes roles and account states, grants or
  denies individual permissions to directors and faculty (with a reason, audited); the
  last active Super Admin cannot be removed. First account seeded by `pnpm db:seed` with
  a one-time password.

## Platform

- NestJS API on Vercel (serverless), Next.js web app on Vercel, Supabase Postgres and
  private Storage, Upstash Redis rate limits, Gmail SMTP — wired, validated at boot, and
  reported on `GET /health/ready`.
- 31 tables with database-enforced rules (checks, triggers, partial unique indexes, Row
  Level Security) — [database.md](database.md).
- Append-only audit log of every administrative and security-sensitive action, without
  secrets.
- Automatic absence processing by `pg_cron`, idempotent.
- Security headers and nonce-based Content-Security-Policy; secret and bundle scans in CI
  ([security-review.md](security-review.md)).
- Icons for the web (favicon, PWA manifest including a maskable icon) and the Android
  launcher set used by the app, generated from the official logo.
