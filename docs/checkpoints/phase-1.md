# Phase 1 checkpoint — Identity, Authentication, Roles & Permissions, i18n, App Shell

Date: 2026-10-20 · Scope: §21 Phase 1 only. No Phase 2 work (student import, groups, schedules, profile-change requests) was started.

## Definition of Done

| Criterion                                                                      | Result     | Evidence                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------ | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Users authenticate through the implemented flows                               | ✅         | API e2e covers password login (email or seat number), first sign-in by emailed code, forgot/reset password, password change, refresh rotation and reuse detection, logout. Playwright drives the same flows in Chromium through the real Next.js server, API and Postgres.                                                    |
| Role restrictions are enforced by the backend and tested                       | ✅         | Four global guards (JWT → password-setup → roles → permissions); role, status and permissions reloaded from the database on every request. **65 role × endpoint cases** plus grant/suspension/promotion cases. Mutation check: deliberately weakening the guards makes these tests fail.                                      |
| The DB structure is tested                                                     | ✅         | 11 cases on a real Postgres: RLS on every table, no table access for Supabase `anon`/`authenticated`, permissions table = `@ftms/core` catalog, append-only audit log (SQL and Prisma), lowercase emails, unique emails/seat numbers + format, profile/role triggers, grant rules, role-change rules, code-attempt bound.     |
| The Super Admin logs in with the generated password and is forced to change it | ✅         | `pnpm db:seed` prints a random one-time password once. Playwright: sign-in with it → redirected to `/set-password`; dashboard and admin pages refuse until changed; after the change the old password no longer works. Seed e2e: idempotent, `--reset-password` revokes sessions, never writes the password to the audit log. |
| Migration applied to **Supabase**                                              | ⚠️ Not run | Applied with `prisma migrate deploy` to fresh PostgreSQL 16 databases (and to Postgres 17 in CI config). **Not run against Supabase: no credentials were provided, and this build workspace cannot reach Supabase.** Carries over the Phase 0 ⚠️ item.                                                                        |

### Remaining step for the ⚠️ item (needs your credentials, on your machine)

```bash
# .env: DATABASE_URL (transaction pooler, 6543), DIRECT_URL (session pooler, 5432),
#       JWT_ACCESS_SECRET, JWT_REFRESH_SECRET (openssl rand -base64 48, different values)
pnpm db:deploy          # applies 20261020071307_init and 20261020114446_identity_auth_audit
pnpm db:seed            # prints the Super Admin's one-time password — once
pnpm storage:provision
pnpm dev                # then GET http://localhost:4000/health/ready → database "up"
```

## Test results (actual output, final run)

Clean run: `pnpm install --frozen-lockfile`, `pnpm format:check`, `turbo run lint typecheck build test --force` (**13/13 tasks, 0 cached**), then `pnpm test:e2e` on a freshly migrated database (**6/6 tasks**).

| Suite                                | Runner          | Result                     |
| ------------------------------------ | --------------- | -------------------------- |
| `@ftms/core` unit                    | Vitest 5        | 23 passed (2 files)        |
| `@ftms/web` unit                     | Vitest 5        | 13 passed (1 file)         |
| `@ftms/api` unit                     | Jest 30         | 77 passed (8 suites)       |
| `@ftms/api` e2e (real Postgres)      | Jest 30         | 129 passed (5 suites)      |
| `@ftms/web` browser e2e (real stack) | Playwright 1.64 | 4 passed (Chromium)        |
| Lint (type-aware ESLint)             | —               | 0 problems in all packages |
| Typecheck                            | TypeScript 6.0  | 0 errors in all packages   |
| Prettier                             | —               | all files formatted        |

Browser cases: (1) Super Admin DoD in Arabic/RTL, including a mismatched-confirmation error and the email kept after a failed sign-in; (2) the chosen language is saved to the account and follows it to a new browser; (3) a Faculty account created by the admin cannot use a password before having one, signs in by emailed code, sets a first password without a "current password" field, sees no Accounts link and gets 404 on `/admin/users`; (4) a language picked on the sign-in page is saved to the account.

Also verified: client bundles (`.next/static`) contain no secret names or values; the only runtime warning is Node's expected `ExperimentalWarning` for VM modules (Jest).

## What was built

- **Schema (migration `20261020114446_identity_auth_audit`):** `users`, `student_profiles`, `faculty_profiles`, `permissions` (seeded from the code catalog), `user_permission_grants`, `auth_sessions`, `auth_challenges`, `audit_logs`. Hand-written constraints and triggers: lowercase emails, seat-number format, profile ↔ role, grant rules, student/staff role boundary, append-only audit log. RLS enabled on every table; Supabase Data API roles revoked.
- **Auth (API):** argon2id passwords (a dummy hash check on unknown accounts keeps timing equal), 15-min access JWT, rotating refresh tokens stored hashed (60 s grace for parallel requests, reuse revokes the session, 30-day absolute sessions), 6-digit codes stored as HMAC (10 min, 5 attempts, newest wins), generic responses + background email sending against account enumeration, fixed-window rate limits (Upstash; in-memory outside production).
- **Roles & permissions:** `SUPER_ADMIN`, `TRAINING_DIRECTOR`, `FACULTY`, `STUDENT`; 22-permission catalog with role defaults and per-user ALLOW/DENY grants (Training Directors and Faculty only; `users.manage`, `permissions.manage`, `settings.manage` never grantable). Admin API: list/search, create (no password; invitation email), status, role, grants — every change audited with before/after.
- **Super Admin seed:** `pnpm db:seed` / `-- --reset-password`.
- **Web (Next.js 16):** server-side BFF — tokens only in `httpOnly` cookies, `proxy.ts` refreshes before render, the browser never calls the API. Pages: sign-in (password / email code), forgot password, set password, role-aware dashboard and side navigation, profile (read-only identity fields, language, password change), Accounts list + account detail (Super Admin).
- **i18n:** `next-intl` without locale routing; Arabic default (RTL) and English (LTR); Western digits in both; language stored on the account.
- **CI:** adds Playwright Chromium and the browser suite after migrations; uploads the report and API log on failure.

## Decisions taken (and why)

1. **BFF instead of browser → API calls.** Tokens never reach JavaScript (XSS can't steal them); server actions get Next's Origin check against CSRF; no CORS surface.
2. **Principal reloaded from the DB on every request** (one indexed query). A suspension or grant change applies on the very next request, not when a token expires. Redis caching deferred until load says otherwise.
3. **Permissions are a code catalog**, mirrored into a table only so grants have a foreign key; a test fails if they drift.
4. **Admin-created accounts have no password.** First sign-in is by emailed code, then the user sets one — no temporary passwords travel by email.
5. **`BFF_SHARED_SECRET` + `WEB_APP_URL`** added (required in production): per-user IP rate limits behind the web server, and links in invitation emails.
6. **JWT secrets required in every environment**, not just production — sign-in cannot work without them.
7. **No `include` queries inside Prisma interactive transactions** (Prisma 7 runs them concurrently on one connection, which `pg` deprecates); relations are reloaded after commit.
8. **Language precedence:** an explicit choice on the sign-in pages is saved to the account; otherwise the account's saved language wins over a cookie left in the browser (shared lab computers).
9. **The two e2e suites run one after the other** (`turbo --concurrency=1`): both reset the same test database.

## Not verified live (needs credentials — none were invented)

- Supabase Postgres (`pnpm db:deploy`, `pnpm db:seed`) and Storage.
- Upstash Redis rate limiting (tested against a stubbed REST endpoint that checks the MULTI/EXEC request).
- Gmail SMTP: codes and invitations are logged, not sent, without `SMTP_PASS` (`delivered: false`, never claimed as sent).
- GitHub push and a GitHub Actions run: no repository URL was provided.

## Notes for whoever runs Phase 2

- Read this file and `README.md` first.
- Student accounts are created one at a time by an admin today; bulk import (`students.import`) and profile-change requests (`profile_changes.decide`) are Phase 2. Student self-signup/linking by seat number is not built.
- Biometric / device sign-in is not built (Phase 4 with attendance).
- New endpoints: declare `@Roles(...)` and/or `@RequirePermissions(...)`; add rows to the role × endpoint matrix in `apps/api/test/authorization.e2e-spec.ts`. Endpoints are authenticated by default (`@Public()` opts out).
- New audit entries go through `AuditService`; it replaces any password/code/token-like field with `[redacted]` as a last line of defence — still never pass secrets to it.
- New UI strings go in both `apps/web/messages/ar.json` and `en.json` (a unit test checks the catalogs match). Use Western digits.
- Browser e2e locally: `pnpm build`, then `DATABASE_URL=… pnpm test:e2e` on a disposable database (see README).
