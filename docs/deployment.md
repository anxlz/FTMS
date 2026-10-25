# Build and deployment (Vercel + Supabase + Upstash)

Production runs as **two Vercel projects** from this one repository — the web app and
the API — plus a Supabase project (Postgres + Storage + `pg_cron`), an Upstash Redis
database, and the Gmail account `ST22425244@agr.asu.edu.eg` for email.

```
browser ──HTTPS──▶ Vercel: web (Next.js, apps/web) ──HTTPS + bearer token──▶ Vercel: API (NestJS, apps/api)
                                                                             │
                     Supabase Postgres (pooler) ◀────────────────────────────┤
                     Supabase Storage (private buckets) ◀────────────────────┤
                     Upstash Redis (rate limits) ◀───────────────────────────┤
                     Gmail SMTP (codes, notices) ◀───────────────────────────┘
Supabase pg_cron ──every 5 min──▶ API POST /internal/attendance/process-absences
```

> **Status:** both projects were built with the Vercel CLI from a clean checkout and the
> built API function was booted and exercised locally ([below](#verified-locally)). No
> real deployment was made: that needs the institution's Vercel, Supabase, Upstash and
> Gmail credentials, which were not available and were not invented.

Every variable is described in [environment.md](environment.md).

## 1. Supabase

1. Create a project (Postgres 17). Pick a region close to Egypt and to the Vercel
   function region you will use, e.g. **Frankfurt (eu-central-1)** with Vercel `fra1`.
2. **Connect** → copy two connection strings (with the database password):
   - Transaction pooler, port `6543` → `DATABASE_URL` (runtime).
   - Session pooler, port `5432` (or the direct connection) → `DIRECT_URL` (migrations,
     `cron:install`).
3. **Project Settings → API**: copy the project URL → `SUPABASE_URL`, and the
   `service_role` / secret key → `SUPABASE_SERVICE_ROLE_KEY`.
4. Check the database time zone is UTC: `show timezone;` (Supabase's default). If not:
   `alter database postgres set timezone to 'UTC';`.
5. Enable backups suited to the data (see [operations.md](operations.md#backups)).
   Point-in-time recovery is strongly recommended for attendance data.

No table, bucket or extension needs creating by hand: migrations, `storage:provision` and
`cron:install` (steps 6–8) do it, and the migrations enable Row Level Security without
policies on every table, so the Data API exposes nothing.

## 2. Upstash Redis

Create a Redis database (regional, same region as the API), open **REST API**, copy the
URL → `UPSTASH_REDIS_REST_URL` and the read-write token → `UPSTASH_REDIS_REST_TOKEN`.
The API uses it only for rate-limit counters (keys are hashed; no personal data).

## 3. Gmail

On the account `ST22425244@agr.asu.edu.eg`: turn on 2-Step Verification, then create an
**App password** → `SMTP_PASS`. If the university's Google Workspace administrator has
disabled app passwords, SMTP sign-in fails; ask the administrator to allow it for this
account (or to provide an approved relay). Verify from a trusted machine:
`SMTP_PASS=… pnpm --filter @ftms/api mail:verify` (handshake and login, sends nothing).

## 4. Secrets

Generate five different values with `openssl rand -base64 48`: `JWT_ACCESS_SECRET`,
`JWT_REFRESH_SECRET`, `QR_HMAC_SECRET`, `BFF_SHARED_SECRET`, `CRON_SECRET`. Keep a copy
in the institution's password manager; `QR_HMAC_SECRET` in particular must survive (it
keeps printed QR codes valid).

## 5. Vercel projects

Import the GitHub repository twice (**Add New → Project**).

### API project

| Setting                                  | Value                                                                                                                                      |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Root Directory                           | `apps/api`                                                                                                                                 |
| Framework Preset                         | Other (the build is defined by `apps/api/vercel.json`)                                                                                     |
| Include files outside the root directory | Enabled (default) — the build runs Turborepo from the repository root                                                                      |
| Node.js Version                          | 24.x                                                                                                                                       |
| Function region                          | Same as Supabase, e.g. `fra1`                                                                                                              |
| Environment (Production)                 | Every API variable of [environment.md](environment.md#api-appsapi) with `NODE_ENV=production`; `WEB_APP_URL` = the web project's final URL |

`apps/api/vercel.json` installs with the frozen lockfile, builds `@ftms/api` (and
`@ftms/core` first) with Turborepo, routes every path to `api/index.js` — the compiled
Nest app booted once per warm instance — and gives the function 30 s. It also ships the
report fonts (`assets/`) and pdfkit's standard-font files, which Vercel's file tracer
does not find on its own (without them the API cannot start; found in Phase 7).

### Web project

| Setting                                  | Value                                                              |
| ---------------------------------------- | ------------------------------------------------------------------ |
| Root Directory                           | `apps/web`                                                         |
| Framework Preset                         | Next.js (also set in `apps/web/vercel.json`)                       |
| Include files outside the root directory | Enabled (default)                                                  |
| Node.js Version                          | 24.x                                                               |
| Environment (Production)                 | `NEXT_PUBLIC_API_URL` = the API project's URL; `BFF_SHARED_SECRET` |

`apps/web/vercel.json` builds through Turborepo so `@ftms/core` is compiled first — a
plain `next build` fails on a clean checkout with "Can't resolve '@ftms/core'" (found in
Phase 7).

Both projects: the `packageManager` field pins pnpm 10.28.0; if Vercel picks another pnpm
version, set `ENABLE_EXPERIMENTAL_COREPACK=1` in the project's environment.

### Domains and biometric login

Give the web project its final domain **before** anyone turns on biometric login in a
browser, then set `WEB_APP_URL` on the API project to that `https://` URL and redeploy the
API. The WebAuthn relying party is that host (or `WEBAUTHN_RP_ID`); changing it later
invalidates every enrolled passkey (Android app keys are not affected). QR codes and email
links also use `WEB_APP_URL`. Build the Android app with `FTMS_WEB_URL` set to the same web
origin ([mobile.md](mobile.md)).

## 6. Database migrations

From a trusted machine with the repository at the deployed commit:

```bash
pnpm install --frozen-lockfile
DATABASE_URL='<transaction pooler URL>' DIRECT_URL='<session pooler URL>' pnpm db:deploy
```

`db:deploy` runs `prisma migrate deploy` (forward-only, applies pending migrations in
order). Never run `prisma migrate dev` or `migrate reset` against production.

## 7. First Super Admin and storage

```bash
DATABASE_URL='…' pnpm db:seed
SUPABASE_URL='…' SUPABASE_SERVICE_ROLE_KEY='…' pnpm storage:provision
```

`db:seed` prints a one-time password for `ST22425244@agr.asu.edu.eg` **once** (never
stored readable); it must be changed at first sign-in. Run it in a terminal nobody else
sees. `storage:provision` creates the four private buckets and verifies them.

## 8. Automatic absences

```bash
DATABASE_URL='…' DIRECT_URL='…' CRON_SECRET='<same as the API>' \
  pnpm --filter @ftms/api cron:install -- --api-url=https://<api host>
```

Enables `pg_cron` and `pg_net`, stores `CRON_SECRET` in Supabase Vault, and schedules a
call to `POST /internal/attendance/process-absences` every 5 minutes. (Attendance pages,
dashboards and exports also finalize closed visits themselves.)

## 9. Smoke test

```bash
pnpm smoke --api https://<api host> --web https://<web host>
```

Read-only; checks liveness, readiness (database, Redis, storage, mail all `up`), the
security headers and HSTS, refusal of unauthenticated and cross-origin calls, the sign-in
page in Arabic, the redirect of a protected page, icons and manifest, and the 404 page.
Then by hand, on a phone over HTTPS:

1. Sign in as the Super Admin with the one-time password; set the new password.
2. Request an email code for a second account; the email arrives from the faculty
   address.
3. Optional biometric login: turn it on in Profile → Security on a phone (fingerprint or
   face), sign out, sign in with it; turn it off.
4. Create a group, a visit for it starting soon, print its attendance QR code; scan it
   with a student's phone; check in (location only — no biometric step); check the record
   (and the location) on the visit's attendance page. Scan it again signed out and use
   **Continue as Guest** with another student's seat number; the submission appears under
   "Guest submissions" and that student is notified.
5. Wait for the window to close; the absent members appear as Absent within 5 minutes.
6. Download the attendance export as PDF, XLSX and CSV; open each.
7. `/audit` shows each of these actions.

## Updating

1. CI is green on the commit (format, secret scan, lint, typecheck, build, bundle scan,
   unit and e2e tests, icons, schema doc).
2. If the commit adds a migration: apply it first (`pnpm db:deploy`). Migrations are
   written to be compatible with the previous code (add, then use, then remove later).
3. Deploy the API, then the web app (Vercel deploys both on merge to the production
   branch).
4. Run the smoke test.

## Rollback

- **Code:** Vercel → Deployments → the previous production deployment → **Promote** (or
  Instant Rollback). Roll back the web app and the API together if the change touched
  both.
- **Database:** migrations are forward-only. A bad migration is fixed with a new
  migration; data damage is repaired from a backup or point-in-time recovery
  ([operations.md](operations.md#recovery)).
- **Secrets:** see [operations.md](operations.md#rotating-secrets).

## Verified locally

Run on 2026-10-25 with Vercel CLI 62.7.0, Node.js 24, PostgreSQL 16, from a copy of the
repository containing only committed (and to-be-committed) files — no build outputs, no
`node_modules`:

| Check                                                                                                    | Result                                                                                                                                                                                                                                    |
| -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vercel build --prod`, web project (`apps/web`) — without `apps/web/vercel.json`                         | **Failed**: 40 × "Module not found: Can't resolve '@ftms/core'" (fixed by the new `vercel.json`)                                                                                                                                          |
| `vercel build --prod`, web project — with it                                                             | Build completed; Turborepo built `@ftms/core` then `@ftms/web` (2/2 tasks)                                                                                                                                                                |
| `vercel build --prod`, API project (`apps/api`)                                                          | Build completed (3/3 tasks); one function `api/index.func`, runtime `nodejs24.x`, 30 s, 908 traced entries, about 38 MB unpacked                                                                                                          |
| Traced API function copied to an isolated folder and started with `NODE_ENV=production` (before the fix) | **Crashed at start**: `Cannot find module …/pdfkit/js/standard-fonts/Helvetica.cjs` (fixed by `includeFiles`)                                                                                                                             |
| Same, after the fix, with placeholder service credentials                                                | Starts; `GET /health` 200; `/health/ready` 503 with database `up`, Redis/storage/mail `down` (placeholders unreachable — expected); a sign-in answers 503 `SERVICE_UNAVAILABLE` (fails closed)                                            |
| Same function in development mode (no external services) against a migrated database                     | 20/20: seeded Super Admin signs in, changes the password, signs in again; attendance, standing and faculty-activity exports in PDF (ar, en), XLSX and CSV; audit-log XLSX/CSV; import template; WebAuthn registration and sign-in options |
| `pnpm smoke` against that function (production mode) and the web app (`next start`, production)          | 10 passed, 0 failed (readiness accepted as 503 with `--allow-not-ready`)                                                                                                                                                                  |
| Browser bundle after `next build` with stand-in secrets (`pnpm scan:bundle`)                             | Clean: 41 files, the stand-in `BFF_SHARED_SECRET` and `API_URL` values absent, no server-only names                                                                                                                                       |

Not verified (needs the real accounts): the deployment itself, Supabase pooler
connections and Storage, Upstash, Gmail delivery, `pg_cron`, HTTPS/HSTS on real domains,
and biometrics on real phones.

## Android app

Not part of the Vercel deployment: an APK/AAB is built from `apps/mobile` on a machine
with the Android SDK and NDK, against the deployed web app's address, signed with the
faculty's own release key (never committed) and distributed by the faculty (side-loading
or a store listing). Steps, prerequisites and the device checklist:
[mobile.md](mobile.md). Phase 8 could not build it in its environment (no Android SDK/NDK
or Google Maven access).
