# FTMS — Field Training Management System

**نظام إدارة التدريب الميداني — كلية الزراعة، جامعة عين شمس**
Field training management for the Faculty of Agriculture, Ain Shams University, Egypt.

> **Status: Phase 8 — Android app (Tauri 2) with camera QR scanning and the device
> location; biometric login made optional and for signing in only; guest attendance
> without an account; a configurable location policy for every check-in** (on top of
> Phase 7: security review, accessibility, export validation, production builds; Phase 6:
> activity log and reports; Phase 5: support tickets and mutual group swaps; Phase 4: QR
> check-in, lateness, absences, corrections, dashboards and exports; Phase 3: program
> settings, schedules, visits, calendars, notifications; Phase 2: student records, import,
> account linking, groups; Phase 1: identity, authentication, roles and permissions,
> i18n). **Not yet deployed:** the live services (Vercel, Supabase, Upstash, Gmail) need
> the institution's credentials, and **no Android APK/AAB has been built yet** (the build
> environment had no Android SDK) — see [`docs/limitations.md`](docs/limitations.md).
> Checkpoints:
> [`phase-0`](docs/checkpoints/phase-0.md), [`phase-1`](docs/checkpoints/phase-1.md),
> [`phase-2`](docs/checkpoints/phase-2.md), [`phase-3`](docs/checkpoints/phase-3.md),
> [`phase-4`](docs/checkpoints/phase-4.md), [`phase-5`](docs/checkpoints/phase-5.md),
> [`phase-6`](docs/checkpoints/phase-6.md), [`phase-7`](docs/checkpoints/phase-7.md),
> [`phase-8`](docs/checkpoints/phase-8.md).

## Documentation

| Document                                               | Contents (§22)                                                      |
| ------------------------------------------------------ | ------------------------------------------------------------------- |
| [`docs/features.md`](docs/features.md)                 | Completed features by role                                          |
| [`docs/database.md`](docs/database.md)                 | Migrations and schema (generated from the schema and migration SQL) |
| [`docs/authentication.md`](docs/authentication.md)     | Sign-in, sessions, permissions, optional biometric login            |
| [`docs/attendance-rules.md`](docs/attendance-rules.md) | Attendance and lateness rules, location policy, guest attendance    |
| [`docs/mobile.md`](docs/mobile.md)                     | Android app: structure, build, permissions, biometric login, tests  |
| [`docs/environment.md`](docs/environment.md)           | Every environment variable                                          |
| [`docs/deployment.md`](docs/deployment.md)             | Build and deployment (Vercel + Supabase + Upstash), rollback        |
| [`docs/operations.md`](docs/operations.md)             | Backups, recovery, retention, secret rotation                       |
| [`docs/security-review.md`](docs/security-review.md)   | §17 review, biometric, location and guest data handling, findings   |
| [`docs/testing.md`](docs/testing.md)                   | Test commands and actual results                                    |
| [`docs/limitations.md`](docs/limitations.md)           | Unresolved issues and limitations                                   |
| This README                                            | Setup and local development, commands, module overviews             |

## Stack

| Layer          | Choice                                                        |
| -------------- | ------------------------------------------------------------- |
| Monorepo       | Turborepo 2 + pnpm 10 workspaces                              |
| Runtime        | Node.js 24 LTS                                                |
| Web            | Next.js 16 (App Router, TypeScript) → Vercel                  |
| API            | NestJS 12 (TypeScript) → Vercel serverless function           |
| Database       | Supabase Postgres via Prisma ORM 7 (`@prisma/adapter-pg`)     |
| Storage        | Supabase Storage, private buckets + signed URLs               |
| Cache / limits | Upstash Redis (REST)                                          |
| Email          | Gmail SMTP via Nodemailer, sender `ST22425244@agr.asu.edu.eg` |
| Shared code    | `packages/core` — Zod schemas, types, pure business rules     |
| Tests          | Jest (API), Vitest (web, core), Playwright (browser flows)    |
| Mobile         | Tauri 2 Android shell around the web app (`apps/mobile`)      |

## Repository layout

```
apps/
  api/        NestJS API — all business rules live here
  web/        Next.js frontend (Arabic default, RTL)
  mobile/     Tauri 2 Android app: launcher, Rust shell, device-key plugin (Kotlin)
packages/
  core/           shared Zod schemas, types and pure helpers
  eslint-config/  shared flat ESLint configs (base / nest / next)
assets/branding/  official logo (source) + derived icons (generated)
scripts/          repo tooling (icons, schema doc, secret and bundle scans, smoke test)
docs/             master prompt, documentation set, per-phase checkpoints
```

## Prerequisites

- **Node.js 24 LTS** (`.nvmrc`) and **pnpm 10** (`corepack enable` picks the pinned version).
- A **Supabase** project (database + storage).
- An **Upstash Redis** database (REST URL + token).
- A **Gmail App Password** for `ST22425244@agr.asu.edu.eg` (needs 2-Step Verification
  on that account; if the university's Google Workspace admin has disabled app passwords,
  SMTP login will fail and an admin-approved alternative is needed).

Only the database is needed to boot locally; the other services report `not_configured`
until their credentials are added, and emails are logged instead of sent.

## Local setup

```bash
pnpm install
cp .env.example .env                       # fill in DATABASE_URL at minimum
cp apps/web/.env.example apps/web/.env.local

pnpm db:generate                           # generate the Prisma client
pnpm db:deploy                             # apply migrations (uses DIRECT_URL)
pnpm db:seed                               # first Super Admin; prints its one-time password
pnpm storage:provision                     # create the private Supabase buckets
pnpm --filter @ftms/api mail:verify        # optional: real SMTP login check

pnpm dev                                   # api → http://localhost:4000, web → http://localhost:3000
```

### Supabase connection strings

Supabase → **Connect**. Use two different URLs:

- `DATABASE_URL` — **transaction pooler** (port `6543`). What the API uses at runtime;
  serverless instances share connections through it.
- `DIRECT_URL` — **session pooler** (port `5432` on the pooler host) or the direct
  connection. Used only by `prisma migrate`; the transaction pooler cannot run migrations.

A plain local Postgres works too: set only `DATABASE_URL`.

## Commands

| Command                                | What it does                                                  |
| -------------------------------------- | ------------------------------------------------------------- |
| `pnpm dev`                             | Run API and web in watch mode                                 |
| `pnpm build`                           | Build every package (generates the Prisma client first)       |
| `pnpm lint` / `pnpm typecheck`         | ESLint (type-aware) / TypeScript across the monorepo          |
| `pnpm test`                            | Unit tests (no network, no database)                          |
| `pnpm test:e2e`                        | API + browser end-to-end tests on a real Postgres (see below) |
| `pnpm verify`                          | lint + typecheck + build + test, as CI runs them              |
| `pnpm format` / `pnpm format:check`    | Prettier                                                      |
| `pnpm db:generate`                     | Generate the Prisma client                                    |
| `pnpm db:migrate`                      | Create + apply a migration in development                     |
| `pnpm db:deploy`                       | Apply pending migrations (CI / production)                    |
| `pnpm db:seed`                         | Create the first Super Admin (`-- --reset-password` recovers) |
| `pnpm storage:provision`               | Create/repair private storage buckets (idempotent)            |
| `pnpm --filter @ftms/api cron:install` | Schedule automatic absences with `pg_cron` (see below)        |
| `pnpm --filter @ftms/api mail:verify`  | Real Gmail SMTP handshake + login, sends nothing              |
| `pnpm icons`                           | Regenerate every icon from the official logo                  |
| `pnpm docs:schema`                     | Regenerate `docs/database.md` from the schema and migrations  |
| `pnpm scan:secrets`                    | Fail on anything secret-shaped in committed files             |
| `pnpm scan:bundle`                     | Fail on server-only data in the built browser bundle          |
| `pnpm smoke --api <url> --web <url>`   | Read-only post-deployment smoke test                          |

## Health endpoints

- `GET /health` — liveness. Always 200 while the process serves HTTP; touches no dependency.
- `GET /health/ready` — readiness. Probes Postgres (`SELECT 1`), Redis (`PING`), Storage
  (all buckets exist and are private) and SMTP (real handshake, cached 5 min), each with a
  3 s timeout. Status is `ready`, `degraded` (development only: something not configured)
  or `not_ready` (HTTP 503). Failure details are shown in development and kept in server
  logs only in production.

The response contracts are Zod schemas in `@ftms/core`, parsed by both the API tests and
the web app.

## Configuration rules

Validated once at boot by `apps/api/src/config/env.ts`:

- `DATABASE_URL`, `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` are required everywhere
  (secrets ≥ 32 characters; access and refresh must differ).
- In **production** every service credential and secret is also required, plus
  `BFF_SHARED_SECRET` and `WEB_APP_URL`. The API refuses to start otherwise and names the
  missing variables — never their values.
- Paired variables (`SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`, Upstash URL + token)
  must be set together.
- `UNIVERSITY_EMAIL_DOMAINS` (default `agr.asu.edu.eg`, subdomains included) decides which
  addresses students may sign up with and student records may carry.
- `.env` files never override variables already set in the shell, CI or Vercel.
- The web app receives only the API URL and `BFF_SHARED_SECRET`; no database or service
  credential enters its process, and nothing secret reaches the browser.
- **Database sessions run in UTC.** Prisma's Postgres adapter writes and reads
  `timestamptz` values as UTC wall-clock text, so the Phase 3 migration pins the database's
  `timezone` setting to `UTC` (Supabase's default). If that statement is not permitted on
  your server it prints a notice instead; then check `SHOW timezone;` returns `UTC` (on
  Supabase: `alter database postgres set timezone to 'UTC';`).

## Storage buckets

Defined once in `apps/api/src/storage/buckets.ts`; all **private**.

| Bucket               | Purpose                             | Limit |
| -------------------- | ----------------------------------- | ----- |
| `visit-media`        | Visit cover photos / images         | 10 MB |
| `visit-documents`    | Optional visit documents            | 25 MB |
| `student-imports`    | Uploaded student spreadsheets       | 10 MB |
| `ticket-attachments` | Optional support-ticket attachments | 10 MB |

`pnpm storage:provision` creates missing buckets and re-applies settings (forcing any
public bucket back to private), then verifies. Files are served only through signed URLs
(max 1 h; visit files 10 min) issued by the API after an authorization check. Uploads pass
through the web server, so each file is limited to **4 MB** (Vercel's request-body limit),
below the bucket limits; a ticket post carries at most 3 files and 4 MB in total (10 files
per ticket).

**Without Supabase (development and tests only):** the API keeps visit files and ticket
attachments on local disk
(the system temp folder, `ftms-local-storage/`) and issues HMAC-signed, expiring links
`/files/<token>`, which the web app proxies to the API. Production never uses this driver:
it requires the Supabase variables at boot.

## App icons and branding

- **Source:** `assets/branding/source/agr-logo.png` — the official Faculty of Agriculture
  logo (2087 × 2088 px, SHA-256 recorded in `assets/branding/generated/manifest.json`).
- **Generator:** `scripts/generate-icons.mjs` (`pnpm icons`, uses `sharp`). Outputs are
  committed, so builds need no image tooling or network. CI regenerates them and fails if
  they drift from the committed files.
- **Small icons use the emblem.** Below ~96 px the logo's text is unreadable, so favicons
  and launcher icons use the obelisk-and-falcons emblem cropped from the same logo. The
  crop box is tied to the source's SHA-256; if the source changes, the script falls back to
  the full logo and asks for the box to be re-measured. `ICON_SUBJECT=full pnpm icons`
  always uses the full logo.
- **Replacing the logo:** overwrite the source file (or set `APP_ICON_SOURCE_URL` to
  download it), run `pnpm icons`, review the diff.

| Output                                                         | Use                                   |
| -------------------------------------------------------------- | ------------------------------------- |
| `apps/web/app/favicon.ico` (16/32/48)                          | Browser favicon                       |
| `apps/web/app/icon.png` (192), `apple-icon.png` (180)          | `<link rel="icon">`, Apple touch icon |
| `apps/web/public/icons/icon-{192,512}.png`, `maskable-512.png` | Web app manifest                      |
| `apps/web/public/brand/agr-logo.png`                           | Full logo shown in the UI             |
| `assets/branding/generated/app-icon-1024.png`                  | Master for `tauri icon`               |
| `assets/branding/generated/android/res/mipmap-*/…`             | Android adaptive + legacy + round     |
| `assets/branding/generated/android/playstore-icon-512.png`     | Play Store listing                    |

Android adaptive icons keep the emblem inside the 66 dp safe circle on a white background
layer, so every launcher mask frames it without clipping.

Checked by `apps/web/lib/icons.test.ts` (source hash, every output at its declared size and
byte count, every Android density including round and adaptive layers) and by the browser
suite (favicon, icons and every manifest icon served at its declared size). The Android
app uses them: `apps/mobile/src-tauri/icons/android/` is a copy of
`assets/branding/generated/android/res/`, put into the generated Android project by
`pnpm --filter @ftms/mobile android:init` ([`docs/mobile.md`](docs/mobile.md)).

## Deployment (Vercel)

Two Vercel projects from this repository — **web** (Root Directory `apps/web`) and
**API** (Root Directory `apps/api`) — each with a `vercel.json` that builds through
Turborepo, plus Supabase, Upstash and Gmail. Step-by-step setup, migrations, the first
Super Admin, storage, the absence job, the smoke test, updates and rollback:
[`docs/deployment.md`](docs/deployment.md). Variables:
[`docs/environment.md`](docs/environment.md).

## Running the tests

```bash
pnpm test                                   # unit tests: core, api, web
DATABASE_URL=postgresql://… pnpm db:deploy
pnpm build
pnpm --filter @ftms/web exec playwright install chromium   # once per machine
DATABASE_URL=postgresql://… pnpm test:e2e   # API suite, then the browser suite
```

**Use a disposable database: both suites wipe its account tables.** (The browser suite
refuses a `supabase.co` URL.) The API suite boots the real Nest application (and the
Vercel handler) and covers every role × endpoint combination. The browser suite starts
the built API and web servers on ports 4100/3100, seeds the Super Admin with the real seed
script, and drives in Chromium the sign-in, forced password change, email-code and
language flows, the spreadsheet import, first sign-in of an imported student, signup (both
matched and reviewed), profile corrections and group moves, program settings, a visit for
two of three groups (the third sees and receives nothing), document links, cancellation,
a weekly schedule and a day off, and — with a fixed geolocation — a scanned check-in link
that offers Log In or Continue as Guest, a signed-in check-in with no biometric step, a
guest submission (matched and unmatched), optional biometric login turned on and used
(Chromium's virtual platform authenticator), faculty review of guest submissions,
corrections and a report download, then a
complaint with an attachment answered and resolved by staff (with an internal note the
student never sees) and a group swap accepted by the other student and approved by the
faculty, checked from both students' side and in the audit history, and finally a
faculty member's operations found in the activity log, opened with their before/after
comparison, summarized per staff member and exported — while that faculty member is
refused the log; it reads
emailed codes from the API's log (no SMTP in tests). The two suites run one after the
other because they share the database.

The browser suite's last project (`quality`) then opens every page of every role in Arabic
and English and checks accessibility (axe-core, WCAG 2.1 A/AA), layout at phone, tablet and
desktop widths, direction, untranslated keys, digits, the security headers and CSP
violations. Commands and the latest recorded results: [`docs/testing.md`](docs/testing.md).

## Authentication and access

- **Sign-in:** email (or student seat number) + password, or a 6-digit code emailed to
  the account (10 min, 5 attempts, a new code replaces the old). Forgot-password uses the
  same codes. Responses never reveal whether an account exists.
- **Tokens:** 15-minute access JWT + rotating refresh token (30-day sessions; reusing a
  rotated token revokes the session). The browser never sees them: the Next.js server
  keeps them in `httpOnly` cookies and calls the API itself.
- **Authorization is decided by the API on every request**, from the database: role,
  account status and effective permissions (role defaults plus per-user allow/deny
  grants for Training Directors and Faculty). The web app only hides what the API would
  refuse anyway.
- **First password:** accounts created by an admin have no password; they sign in with an
  emailed code and must set one. The Super Admin's generated password must be replaced at
  first sign-in.
- **Rate limits** (Upstash; in-memory outside production when unconfigured) on failed
  sign-ins, code requests and code failures, per account and per client IP.
- **Audit log:** append-only (enforced by a database trigger). Passwords, codes and
  tokens are never written to it.

## Students and groups

- **Records come first.** Faculty create student records one by one or import them from
  Excel (`/students/import`, template downloadable there). An import is uploaded, checked
  row by row and **previewed**; nothing is written until the uploader confirms. Changes to
  existing students (same seat number) and skipping invalid rows each need an explicit
  checkbox; blank cells never erase data; if the data changed since the preview, the
  commit is refused and the preview refreshed. The original file is kept in the private
  `student-imports` bucket when Storage is configured.
- **Account linking (§4.2, §4.3).** A student whose imported record has their university
  email signs in the first time with an emailed code: the account is created and linked
  to that record. Others sign up (four-part name, seat number, university email + code):
  if the seat number and identity match an unlinked record, the account is linked at once;
  otherwise it waits for review (`PENDING_VERIFICATION`) and can only see its
  verification page until a reviewer links it to a record or creates one. One record per
  seat number, one account per record, one account per email — all enforced by the
  database.
- **Groups (§5).** A student has at most one active group — a partial unique index in the
  database, not just a check in code. Moving a student ends the old membership and starts
  a new one (history is kept and cannot be edited). Only empty groups can be archived.
- **Profile corrections (§4.4).** Students change their phone directly; name parts and
  seat number change only through a request a reviewer approves (applied atomically) or
  rejects with a reason. Students never see who decided.
- Every change is in the audit log with before/after values.

## Schedules, visits and notifications

- **Program settings (§11).** The Training Director configures the current program once:
  name, start date, duration, allowed absences and the default check-in timing (opens
  before / on time until / closes after the start). The form starts from suggested values
  (12 weeks, 2 absences, 15/15/60 minutes); nothing in the system assumes them. Each change
  is recorded with before/after values (`/schedule`, settings history).
- **Visits (§6.3).** Title, details, date, start/end time, one or several groups
  (searchable multi-select), place, coordinates, map link, cover photo and documents. Each
  visit copies the timing defaults when it is created; holders of
  `attendance.settings.visit` can override them per visit. Changing the defaults never
  rewrites existing visits (§8.1).
- **Who sees what (§6.2, §9.4).** A visit is in the calendar and notification center of
  the students currently in its groups — and nobody else; for other students it does not
  exist (404). Staff see every visit, optionally by group.
- **Changes (§6.5).** Moving a visit, changing its place, groups or timing notifies the
  affected students (a new group's students get "new visit", a removed group's "no longer
  for your group"); a title alone does not. A cancelled visit stays in the calendar with
  its reason. Once check-in opens, date, time, groups and timing are locked; once it
  closes, the visit can no longer be cancelled. History comes from the audit log.
- **Times (§16.2).** Dates and times are entered and shown in Africa/Cairo; the database
  derives the UTC instants from them (daylight saving included), so the stored instant can
  never disagree with what students see.
- **Weekly schedules (§6.1, §11.2).** A schedule (days, times, period, place, groups)
  creates its sessions as visits. Changing a schedule re-plans only sessions that have not
  started and were not changed on their own; ending it cancels its sessions that have not
  started. A schedule for every group is the training-wide one (`schedule.manage`);
  `schedule.group.manage` covers group-specific ones.
- **Days off.** A day off (for one schedule or all) cancels that day's sessions with its
  reason and tells their students; removing it restores them. Sessions created later on a
  day off are created cancelled.
- **Notifications (§12).** Stored as a type and parameters and shown in the reader's
  language; unread count in the header, mark one or all as read. Each is unique per
  recipient and event, so retries never duplicate. They also cover account-verification
  and profile-correction decisions (Phase 2), alongside the emails.

## Attendance (Phase 4)

- **QR codes (§7).** Each visit has a details code (opens `/visits/<id>`, sign-in
  required) and an attendance code (`/check-in/<token>`). The token is the visit id plus
  an HMAC-SHA256 tag (`QR_HMAC_SECRET`): stable for the whole visit, so one printout
  serves every session, impossible to forge for another visit, and free of personal data.
  Staff print both from `/visits/<id>/qr`. The code grants nothing by itself.
- **Check-in (§7.2, §8.5, revised in Phase 8).** A scanned link offers **Log In** or
  **Continue as Guest** when signed out. Signed in, the API checks, in order: a valid
  token; an active, verified student; of one of the visit's groups; a visit that is not
  cancelled; no existing record; the server time inside the window; a location reading
  that satisfies the location policy. Only then is one record created; the database's
  unique key turns a concurrent duplicate into "already recorded". Values sent by the
  browser (status, minutes, flags) are ignored. Check-ins are rate-limited per student.
  **Attendance never involves biometrics.**
- **Location policy (Phase 8).** Every check-in — signed in or guest — must send a current
  reading. The Training Director may require a maximum distance from the visit (visits
  with coordinates) and a minimum accuracy (`/schedule`, empty = no limit); the API
  refuses with a specific reason (no reading, inaccurate, outside the area). Readings are
  stored for staff review; they are supporting evidence, not proof of presence. The audit
  log notes that a reading was sent, not where.
- **Guest attendance (Phase 8).** No login, account, password, code or identity check:
  the guest types a full name and seat number and the location is sent. The server applies
  the token, window and location policy and rate limits per IP; a seat number of a visit
  member with no record becomes that student's record (`GUEST`, notified), otherwise the
  submission is kept for staff review; the guest gets the same receipt either way.
  **The typed identity is not verified** — by design; see
  [`docs/attendance-rules.md`](docs/attendance-rules.md#guest-attendance-phase-8).
- **Classification (§8.2).** Minutes are whole minutes since the start, rounded down:
  `m = floor((check-in − start) / 1 min)`. Present when `−opens ≤ m ≤ grace`; Late when
  `grace < m ≤ closes`, with `m − grace` minutes late; refused otherwise. For a 10:00
  visit with 15/15/60: 09:44:59 refused, 09:45 present, 10:15:59 present, 10:16 late 1,
  11:00:59 late 45, 11:01 closed. Every visit keeps the timing it was created with.
- **Automatic absences (§8.3).** When a visit's window closes, every current member of its
  groups without a record gets an ABSENT record. Records are only ever inserted (`ON
CONFLICT DO NOTHING` on the one-record-per-student key), so repeated or overlapping runs
  add nothing and never overwrite a check-in or a correction; cancelled visits are
  skipped; rescheduled visits close at their new time. It runs from Supabase `pg_cron`
  every 5 minutes through `pg_net`, calling `POST /internal/attendance/process-absences`
  with the `x-ftms-cron-key: CRON_SECRET` header (`cron:install` stores the secret in
  Supabase Vault — never in the job text). The attendance pages, dashboards and exports
  also finalize a closed visit themselves, so figures never wait for the scheduler.
- **Corrections (§8.4).** Holders of `attendance.correct` set Present / Late (minutes) /
  Absent with an optional reason, once check-in has opened. The record becomes a manual
  correction with who and when; the audit log keeps every previous state; the student is
  notified and sees the reason but not who corrected it.
- **Dashboards (§9, §10).** Students see their totals, remaining permitted absences (from
  the program setting) and history at `/attendance`; staff see training-wide and
  per-group figures there, and per visit at `/visits/<id>/attendance` (filters, location,
  corrections).
- **Exports (§10.4, §19).** CSV (UTF-8 with BOM, formula-safe), XLSX (right-to-left for
  Arabic, frozen header, filters) and PDF (IBM Plex Sans Arabic, landscape, right-to-left
  for Arabic) from one query, so files match the screens. Filters: visit, dates, group,
  student, status; at most 10,000 rows (3,000 for PDF). Needs `attendance.read` and
  `reports.export`; each export is audited.

## Biometric login (optional)

Biometric login is an optional convenience feature for signing in. It is not required
for attendance. Off by default; users turn it on or off in **Profile → Security** after a
password or email-code sign-in (a biometric session cannot enroll another device). In a
browser it is a platform passkey (WebAuthn, user verification required); in the Android
app it is an EC P-256 key in the Android Keystore that signs a server challenge only right
after a strong biometric check. The server stores only public keys. Removing or turning
it off takes effect at once and ends the sessions that device opened; offline, the app
says it was not turned off. Password and email-code sign-in always remain. Details:
[`docs/authentication.md`](docs/authentication.md#biometric-login-optional).

## Android app (Phase 8)

`apps/mobile` is a Tauri 2 shell around the deployed web app: a bundled launcher checks
the connection and opens the web app, which then uses the camera QR scanner, the device
location and the optional biometric login. The app holds no secrets — only the web app's
address (`FTMS_WEB_URL`); only that origin may load or call native code.

```bash
pnpm --filter @ftms/mobile test                     # Node tests
pnpm --filter @ftms/mobile native:test              # Rust tests (host target)
pnpm --filter @ftms/mobile android:init             # needs the Android SDK + NDK
FTMS_WEB_URL=https://… pnpm --filter @ftms/mobile android:build
```

**No APK/AAB has been built yet**: the Phase 8 environment had no Android SDK/NDK and no
access to Google Maven or the Rust Android targets. Prerequisites, signing, permissions
and the device checklist: [`docs/mobile.md`](docs/mobile.md).

## Support tickets and group swaps (Phase 5)

- **Tickets (§13).** Students open `/tickets`, pick a category — complaint / problem,
  suggestion / question, or group swap — and the form follows the choice; their name,
  seat number and group come from the account. Complaints and suggestions take a subject,
  a description and optional files (PDF, JPEG, PNG, WebP; checked by content, stored in
  the private `ticket-attachments` bucket, opened through short-lived signed links). The
  list filters by category and status. Each ticket shows the conversation, the outcome
  and the status history.
- **Processing (§13.4).** Holders of `tickets.process` see the queue (open and in progress
  by default; search by number, subject, student name or seat), reply, add internal notes
  the student never sees, and set the status with an optional outcome. The first staff
  reply marks a ticket in progress; a student reply reopens a resolved one; closed tickets
  take no messages until staff reopen them. The student is notified of replies and status
  changes. **Students never see which staff member answered or decided** — staff appear as
  "Training office"; the names stay in the staff views and the audit log.
- **Group swaps (§14).** A swap is a ticket plus a request: the student chooses another
  active group and gives the seat number of a student in it (the full name is an optional
  consistency check). An unknown seat, a student not in that group or without an active
  account, and a name that does not match all get the same answer, so the form reveals
  nothing about other students; self swaps and the student's own group are refused. The other student is notified, opens the request and
  accepts or declines (optional reason); acceptance alone changes nothing and sends it to
  `group_swaps.decide` holders at `/group-swaps`, who see both students' groups then and
  now, and approve or reject with a **mandatory reason** shown to both students. The
  requester may withdraw an open request. Rejected requests stay in history and never
  block a new one.
- **Integrity.** A student takes part in at most one open request (as either side),
  enforced in the service under row locks and by a database trigger. Approval locks both
  students, rechecks their current groups, and moves both in one transaction (membership
  source `SWAP`); a deferred database check refuses to commit an approval without the full
  exchange. If either student's group changed by other means, open requests are closed
  automatically (`GROUP_CHANGED`) and both students are told; an approval attempt on such
  a request closes it instead. Attendance records keep the group they were made under.
- **Audit (§14.7).** `/group-swaps/history` (`group_swaps.audit`, the Training Director)
  lists every request with both students, their original groups, the target, each
  decision with who made it (name and role), reasons, timestamps and the final status.
- **Limits.** 10 new tickets and 10 swap requests per student per hour; 60 messages per
  hour.

## Activity log and reports (Phase 6)

- **One audit writer (§15.4).** Every module records through `AuditService`; its `action`
  and `resourceType` are typed against the shared catalogue in
  `packages/core/src/audit/catalogue.ts` (`AUDIT_ACTIONS`, 71 actions in 13 categories), so
  an unlisted action does not compile and every action has a label in both languages.
  Each event keeps the actor's id, name and role at the time, the action, the record type
  and id, previous and new values, the reason, the outcome, the IP address and browser.
  Values whose names look secret (passwords, codes, tokens, hashes, credentials) are
  redacted before writing, and the flows that handle secrets record only facts.
- **Append-only.** `audit_logs` refuses `UPDATE`, `DELETE` and `TRUNCATE` by trigger (since
  Phase 1); the API has read routes only. Deleting a record leaves its events, including
  a snapshot of what was deleted and by whom.
- **The log (§15.3).** `/audit` (permission `audit.read`: the Training Director and Super
  Admin by default, or an account the Super Admin explicitly authorizes — that grant is
  itself recorded) searches by name, action, record id or reason and filters by staff
  member, whose actions (staff, students, system, everyone), category, action, record
  type, outcome and period (Africa/Cairo days). Each event (`/audit/<id>`) shows the
  before/after comparison field by field, the context, the record as it is now with a
  link when it still exists, and the other events about the same record. The
  **Decisions** view lists administrative decisions only: account verifications, profile
  corrections, both students' and the faculty's group-swap decisions, attendance
  corrections, ticket outcomes and changes to accounts' status, role and permissions.
- **Faculty activity (§15.1).** `/audit/activity`: for a period (last 30 days by
  default), every staff account — including those with no activity — with its actions,
  decisions, failed attempts, actions per category and last action, each linking into the
  filtered log. The Training Director's dashboard shows the last 7 days and the latest
  staff actions.
- **Training-wide settings (§11.3).** `/settings` shows the program (name, period,
  duration, time zone), the attendance defaults and check-in policy, and the
  configuration history with previous and new values.
- **Reports.** `/reports` (permission `reports.export`) shows each report only to holders
  of its permissions, and the API enforces the same rules: the student attendance
  standing (every student's recorded visits, present, late, absent, minutes late,
  remaining absences and standing against the allowance — the same rules as the
  dashboards; `attendance.read`) as XLSX, CSV or PDF; the faculty activity report
  (`audit.read`) as XLSX, CSV or PDF; and the filtered activity log (`audit.read`) as XLSX
  or CSV (at most 10,000 events). Every download is recorded (`report.exported`,
  `audit.exported`, `attendance.exported`).

## Security (Phase 7)

The §17 review, the handling of biometric credentials, location readings, guest
submissions and the Android app, and the findings fixed in Phase 7 are in [`docs/security-review.md`](docs/security-review.md). In
short: both apps send strict security headers (a per-request nonce CSP on the web app);
search text is matched literally; every route is covered by the role matrix and every
input by a validation pipe (both enforced by tests); exports are rate-limited per
account; an unreachable Redis or database answers 503 and limits fail closed; CI scans
committed files and the browser bundle for secrets.

## Languages

Arabic (default, right-to-left) and English (left-to-right), via `next-intl`. Numbers
use Western digits in both. A language picked before signing in is saved to the account;
otherwise the account's saved language applies on every device.

## Super Admin

`ST22425244@agr.asu.edu.eg` is both the email sender and the first Super Admin.

```bash
pnpm db:seed                          # creates the account if missing
pnpm db:seed -- --reset-password      # recovery: new one-time password, sessions revoked
```

The random one-time password is printed **once** to that terminal — never stored readable,
never logged, never committed — and must be replaced at the first sign-in.
