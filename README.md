# FTMS — Field Training Management System

**نظام إدارة التدريب الميداني — كلية الزراعة، جامعة عين شمس**
Field training management for the Faculty of Agriculture, Ain Shams University, Egypt.

> **Status: Phase 4 — QR codes, check-in with biometrics and location, automatic
> lateness and absences, faculty corrections, attendance dashboards and PDF/XLSX/CSV
> exports** (on top of Phase 3: program settings, schedules, visits, calendars,
> notifications; Phase 2: student records, import, account linking, groups; Phase 1:
> identity, authentication, roles and permissions, i18n). The master prompt
> (`docs/master-prompt.md`) is the source of truth; each phase is implemented separately.
> Checkpoints: [`phase-0`](docs/checkpoints/phase-0.md),
> [`phase-1`](docs/checkpoints/phase-1.md), [`phase-2`](docs/checkpoints/phase-2.md),
> [`phase-3`](docs/checkpoints/phase-3.md), [`phase-4`](docs/checkpoints/phase-4.md) — what
> each delivered, what was verified, and what is still open.

## Stack

| Layer           | Choice                                                                  |
| --------------- | ----------------------------------------------------------------------- |
| Monorepo        | Turborepo 2 + pnpm 10 workspaces                                        |
| Runtime         | Node.js 24 LTS                                                          |
| Web             | Next.js 16 (App Router, TypeScript) → Vercel                            |
| API             | NestJS 12 (TypeScript) → Vercel serverless function                     |
| Database        | Supabase Postgres via Prisma ORM 7 (`@prisma/adapter-pg`)               |
| Storage         | Supabase Storage, private buckets + signed URLs                         |
| Cache / limits  | Upstash Redis (REST)                                                    |
| Email           | Gmail SMTP via Nodemailer, sender `ST22425244@agr.asu.edu.eg`           |
| Shared code     | `packages/core` — Zod schemas, types, pure business rules               |
| Tests           | Jest (API), Vitest (web, core), Playwright (browser flows)              |
| Mobile (future) | Tauri, consuming the same JWT API — `apps/mobile` is reserved and empty |

## Repository layout

```
apps/
  api/        NestJS API — all business rules live here
  web/        Next.js frontend (Arabic default, RTL)
  mobile/     reserved for the future Tauri app — intentionally empty
packages/
  core/           shared Zod schemas, types and pure helpers
  eslint-config/  shared flat ESLint configs (base / nest / next)
assets/branding/  official logo (source) + derived icons (generated)
scripts/          repo tooling (icon generation)
docs/             master prompt and per-phase checkpoints
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
below the bucket limits.

**Without Supabase (development and tests only):** the API keeps visit files on local disk
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
| `assets/branding/generated/app-icon-1024.png`                  | Master for `tauri icon` (future)      |
| `assets/branding/generated/android/res/mipmap-*/…`             | Android adaptive + legacy + round     |
| `assets/branding/generated/android/playstore-icon-512.png`     | Play Store listing                    |

Android adaptive icons keep the emblem inside the 66 dp safe circle on a white background
layer, so every launcher mask frames it without clipping.

## Deployment (Vercel)

Two Vercel projects from this repository (full production verification is Phase 7):

**Web** — Root Directory `apps/web`, framework Next.js, Node.js 24. Environment:
`NEXT_PUBLIC_API_URL` (or `API_URL`) and `BFF_SHARED_SECRET`.

**API** — Root Directory `apps/api`, Node.js 24. `apps/api/vercel.json` builds with
Turborepo, routes every path to `api/index.js` (the compiled Nest app wrapped for Vercel's
Node runtime, booted once per warm instance), and serves no static files besides a
`robots.txt`. Environment: everything in `.env.example` except `NEXT_PUBLIC_API_URL`,
with `NODE_ENV=production`.

After the first deploy: run `pnpm db:deploy` against production (`DIRECT_URL`), then
`pnpm db:seed` (from a trusted terminal — it prints the one-time password), then
`pnpm storage:provision`, then `pnpm --filter @ftms/api cron:install -- --api-url=https://<api
host>` (automatic absences), then check `GET /health/ready` returns `ready`. The API's
`vercel.json` ships `assets/` (the report fonts) with the function.

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
a weekly schedule and a day off, and — with Chromium's virtual platform authenticator and
a fixed geolocation — biometric enrollment and sign-in, a scanned check-in link that goes
through sign-in, a confirmed check-in, faculty corrections and a report download; it reads
emailed codes from the API's log (no SMTP in tests). The two suites run one after the
other because they share the database.

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
- **Check-in (§7.2, §8.5).** A scanned link sends a signed-out student through sign-in and
  back. The API then checks, in order: a valid token; an active, verified student; of one
  of the visit's groups; a visit that is not cancelled; no existing record; the server
  time inside the window; the location reading; a fresh biometric assertion bound to this
  student **and this visit** (a sign-in session never counts). Only then is one record
  created; the database's unique key turns a concurrent duplicate into "already recorded".
  Values sent by the browser (status, minutes, flags) are ignored. Check-ins are
  rate-limited per student.
- **Biometrics and location.** A student with biometric sign-in enabled always confirms
  with it and sends the device location. For students without it, the Training Director
  chooses the fallback (`/settings`): allow the check-in, marked "not confirmed with
  biometrics", or refuse it until biometrics are enabled; and whether the location is
  required. Coordinates and accuracy are stored with the record (and the distance from
  the visit's coordinates when known) for faculty review only; they are supporting
  context, not proof of presence. The audit log notes that a reading was sent, not where.
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

## Biometric sign-in (§4.5)

Platform passkeys (WebAuthn) with user verification: the phone or laptop checks the
fingerprint or face; the server stores only the credential's public key and counter.
Students and staff enable it from `/profile` after a password or email-code sign-in (a
biometric session cannot enroll another device), name each device, and remove it there —
removal takes effect at once and ends the sessions that device opened. Sign-in is
usernameless ("Sign in with fingerprint or face"), so it reveals no account. Password and
email-code sign-in always remain. The relying party is the web app's host
(`WEB_APP_URL`, or `WEBAUTHN_RP_ID` for a parent domain); browsers require HTTPS outside
`localhost`.

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
