# Tests: commands and recorded results

## Commands

```bash
pnpm install --frozen-lockfile
pnpm format:check                 # Prettier
pnpm scan:secrets                 # committed files (add --history for every past commit)
pnpm verify                       # lint + typecheck + build + unit tests (all packages)
pnpm scan:bundle                  # after a build: no server-only data in the browser bundle
pnpm docs:schema && git diff --exit-code docs/database.md

# End-to-end, on a DISPOSABLE database (both suites wipe it):
DATABASE_URL=postgresql://…/ftms_test pnpm db:deploy
pnpm --filter @ftms/web exec playwright install chromium     # once per machine
DATABASE_URL=postgresql://…/ftms_test pnpm test:e2e          # API suite, then browser suite

# Android app (Phase 8): Node tests run with `pnpm verify`; the Rust checks need Rust and,
# on Linux, the WebKitGTK 4.1 development packages (they compile for the host).
pnpm --filter @ftms/mobile native:check                       # rustfmt + clippy -D warnings
pnpm --filter @ftms/mobile native:test                        # Rust unit tests
```

CI (`.github/workflows/ci.yml`) runs all of these on every push and pull request against
a throwaway PostgreSQL 17, then regenerates the icons and the schema document and fails
on any difference; a second job (`mobile-native`) runs the Android app's Rust checks. No
automated test builds or runs the Android APK (see [mobile.md](mobile.md)).

| Suite                   | Runner                                                    | What it covers                                                                                                                                                                                                                                                              |
| ----------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@ftms/core` unit       | Vitest                                                    | Shared rules: attendance classification and totals, password policy, permissions, audit catalogue and comparison, student and request rules, scheduling and time zones, health contracts.                                                                                   |
| `@ftms/web` unit        | Vitest                                                    | Message catalogs (every key and every API error code in both languages), the browser security policy, icons.                                                                                                                                                                |
| `@ftms/api` unit        | Jest                                                      | Configuration validation, environment documentation, validation coverage of every controller, crypto and password hashing, rate limiters, error mapping, health aggregation, mail, Redis, storage paths and provisioning, imports, scheduling, attendance, student linking. |
| `@ftms/api` e2e         | Jest + real Postgres                                      | The real Nest application (and the Vercel handler) over HTTP: every feature, the database rules, the role × endpoint matrix and route coverage, security, exports.                                                                                                          |
| `@ftms/web` browser e2e | Playwright (Chromium) + built API and web + real Postgres | Every user flow end to end, then accessibility, layout, languages and headers on every page.                                                                                                                                                                                |
| `@ftms/mobile`          | Node test runner                                          | App configuration (`FTMS_WEB_URL` validation, the remote capability), the launcher's logic, the web ↔ build.rs ↔ Kotlin command contract and key settings, the shipped launcher icons.                                                                                      |
| `@ftms/mobile` native   | `cargo test` / clippy (host target)                       | The navigation allow-list and configuration parsing of the Rust shell; formatting and lints of the shell and the device-key plugin.                                                                                                                                         |

## §20 acceptance criteria → tests

| §20                 | Where                                                                                                                                                                                                                                                                                                                       |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 20.1 Authentication | `auth.e2e-spec.ts`, `linking.e2e-spec.ts`, `biometrics.e2e-spec.ts`, `device-keys.e2e-spec.ts` (Phase 8), `seed.e2e-spec.ts`; browser `auth.spec.ts`, `students.spec.ts`, `attendance.spec.ts` (virtual authenticator)                                                                                                      |
| 20.2 Attendance     | `attendance.e2e-spec.ts` (all eight timing cases at the second boundaries, duplicates, unassigned, cancelled, corrections, idempotent absences, overrides, defaults, time zones, location policy, no biometrics), `guest-attendance.e2e-spec.ts` (Phase 8), `attendance-database.e2e-spec.ts`; browser `attendance.spec.ts` |
| 20.3 Calendar       | `visits.e2e-spec.ts`, `schedules.e2e-spec.ts`, `scheduling-database.e2e-spec.ts`; browser `visits.spec.ts`                                                                                                                                                                                                                  |
| 20.4 Group swaps    | `group-swaps.e2e-spec.ts`, `requests-database.e2e-spec.ts`; browser `requests.spec.ts`                                                                                                                                                                                                                                      |
| 20.5 Audit log      | `audit.e2e-spec.ts`, `database.e2e-spec.ts` (append-only); browser `audit.spec.ts`                                                                                                                                                                                                                                          |
| 20.6 Exports        | `exports.e2e-spec.ts` (CSV, XLSX and PDF contents against the records), `reports.e2e-spec.ts`                                                                                                                                                                                                                               |
| 20.7 Permissions    | `authorization.e2e-spec.ts` (every protected operation × every role, every route covered), `security.e2e-spec.ts`; browser checks that hidden links are also refused                                                                                                                                                        |

## Recorded results — final Phase 8 run (2026-10-25)

Clean run on the Phase 8 tree: `pnpm install --frozen-lockfile`, `pnpm format:check`,
`pnpm scan:secrets`, `turbo run lint typecheck build test --force` (no cache, **14/14
tasks**, with stand-in secrets) followed by `pnpm scan:bundle`, `pnpm docs:schema` (no
difference), the mobile Rust checks, then `pnpm test:e2e` on a freshly migrated PostgreSQL
16 database (`ftms_final8`): the API suite, then the browser suite (546 s in all).

| Suite                                | Runner                    | Result                                                                |
| ------------------------------------ | ------------------------- | --------------------------------------------------------------------- |
| `@ftms/core` unit                    | Vitest 5                  | **99 passed** (7 files)                                               |
| `@ftms/web` unit                     | Vitest 5                  | **39 passed** (2 files)                                               |
| `@ftms/api` unit                     | Jest 30                   | **126 passed** (14 suites)                                            |
| `@ftms/mobile` (Node)                | `node --test`             | **13 passed** (4 files)                                               |
| `@ftms/mobile` native (host target)  | `cargo test`, clippy      | **3 passed**; rustfmt clean; clippy `-D warnings` clean               |
| `@ftms/api` e2e (real Postgres)      | Jest 30                   | **888 passed** (24 suites, 324 s)                                     |
| `@ftms/web` browser e2e (real stack) | Playwright 1.64, Chromium | **41 passed** (core 14, attendance 7, requests 8, audit 6, quality 6) |
| Lint (type-aware ESLint)             | —                         | 0 problems in all packages                                            |
| Typecheck                            | TypeScript 6.0            | 0 errors in all packages                                              |
| Prettier                             | —                         | all files formatted                                                   |
| Secret scan                          | `scan-secrets.mjs`        | none in 526 files                                                     |
| Browser bundle scan                  | `scan-client-bundle.mjs`  | clean: 48 files, 2 stand-in secret values, 11 names, 4 patterns       |
| Message catalogs                     | i18n check                | 1,569 keys used, 0 missing in either language                         |
| Schema document                      | `pnpm docs:schema`        | identical to the committed `docs/database.md`                         |
| Migration upgrade                    | `prisma migrate deploy`   | a populated Phase 6 copy upgraded: every row kept, no schema drift    |

Not run: an Android build, an emulator or a physical phone (no Android SDK/NDK, Google
Maven or Rust Android targets in this environment — [mobile.md](mobile.md)). The desktop
debug build of the shell was started under Xvfb against a local web app and showed the
launcher handing over to the web app's sign-in page; that is a check of the shell's
configuration, not of Android.

Phase 8 changes to the suites: API e2e 850 → 888 (`guest-attendance.e2e-spec.ts` 12,
`device-keys.e2e-spec.ts` 7, the revised check-in and export tests, 5 matrix rows added
and the removed check-in options row dropped);
browser `attendance.spec.ts` now checks Log In / Continue as Guest, a check-in with no
biometric step, matched and unmatched guest submissions and the optional biometric login;
the quality suite adds `/start`, `/guest` and the guest pages.

### Phase 7 run (for comparison)

Core 90, web 34, API unit 126, API e2e 850 (22 suites), browser 41; role matrix 590 cases;
axe-core on 54 page loads with no violations; exports compared with the records in all
three formats.

### Production build (Vercel CLI) and smoke test

Recorded in [deployment.md](deployment.md#verified-locally): both projects built from a
clean checkout with Vercel CLI 62.7.0; the traced API function started in isolation in
production mode (health 200; readiness 503 only because the placeholder Redis, storage and
mail hosts are unreachable; a sign-in then answers 503 `SERVICE_UNAVAILABLE`); 20/20 file
and WebAuthn paths served by the same function in development mode; `pnpm smoke` **10
passed, 0 failed** against it and the production web build.

### Earlier phases

Each checkpoint in [`checkpoints/`](checkpoints/) records that phase's final run. Phase 6
ended with 771 API e2e and 35 browser tests; Phase 7 added the security, route-coverage,
PDF-content and quality suites; Phase 8 the guest-attendance, device-key and mobile
suites.
