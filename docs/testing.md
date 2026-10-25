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
```

CI (`.github/workflows/ci.yml`) runs all of these on every push and pull request against
a throwaway PostgreSQL 17, then regenerates the icons and the schema document and fails
on any difference.

| Suite                   | Runner                                                    | What it covers                                                                                                                                                                                                                                                              |
| ----------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@ftms/core` unit       | Vitest                                                    | Shared rules: attendance classification and totals, password policy, permissions, audit catalogue and comparison, student and request rules, scheduling and time zones, health contracts.                                                                                   |
| `@ftms/web` unit        | Vitest                                                    | Message catalogs (every key and every API error code in both languages), the browser security policy, icons.                                                                                                                                                                |
| `@ftms/api` unit        | Jest                                                      | Configuration validation, environment documentation, validation coverage of every controller, crypto and password hashing, rate limiters, error mapping, health aggregation, mail, Redis, storage paths and provisioning, imports, scheduling, attendance, student linking. |
| `@ftms/api` e2e         | Jest + real Postgres                                      | The real Nest application (and the Vercel handler) over HTTP: every feature, the database rules, the role × endpoint matrix and route coverage, security, exports.                                                                                                          |
| `@ftms/web` browser e2e | Playwright (Chromium) + built API and web + real Postgres | Every user flow end to end, then accessibility, layout, languages and headers on every page.                                                                                                                                                                                |

## §20 acceptance criteria → tests

| §20                 | Where                                                                                                                                                                                                                                                                            |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 20.1 Authentication | `auth.e2e-spec.ts`, `linking.e2e-spec.ts`, `biometrics.e2e-spec.ts`, `seed.e2e-spec.ts`; browser `auth.spec.ts`, `students.spec.ts`, `attendance.spec.ts` (virtual authenticator)                                                                                                |
| 20.2 Attendance     | `attendance.e2e-spec.ts` (all eight timing cases at the second boundaries, duplicates, unassigned, cancelled, corrections, idempotent absences, overrides, defaults, time zones, biometric and location policy), `attendance-database.e2e-spec.ts`; browser `attendance.spec.ts` |
| 20.3 Calendar       | `visits.e2e-spec.ts`, `schedules.e2e-spec.ts`, `scheduling-database.e2e-spec.ts`; browser `visits.spec.ts`                                                                                                                                                                       |
| 20.4 Group swaps    | `group-swaps.e2e-spec.ts`, `requests-database.e2e-spec.ts`; browser `requests.spec.ts`                                                                                                                                                                                           |
| 20.5 Audit log      | `audit.e2e-spec.ts`, `database.e2e-spec.ts` (append-only); browser `audit.spec.ts`                                                                                                                                                                                               |
| 20.6 Exports        | `exports.e2e-spec.ts` (CSV, XLSX and PDF contents against the records), `reports.e2e-spec.ts`                                                                                                                                                                                    |
| 20.7 Permissions    | `authorization.e2e-spec.ts` (every protected operation × every role, every route covered), `security.e2e-spec.ts`; browser checks that hidden links are also refused                                                                                                             |

## Recorded results — final Phase 7 run (2026-10-25)

Clean run on the Phase 7 tree: `pnpm install --frozen-lockfile`, `pnpm format:check`,
`pnpm scan:secrets` (and `--history`), `turbo run lint typecheck build test --force` (no
cache, **13/13 tasks**), a web build with stand-in secrets followed by `pnpm scan:bundle`,
`pnpm docs:schema` (no difference), then `pnpm test:e2e` on a freshly migrated PostgreSQL
16 database (`ftms_final7`): the API suite, then the browser suite (9 min 18 s in all).

| Suite                                | Runner                    | Result                                                                |
| ------------------------------------ | ------------------------- | --------------------------------------------------------------------- |
| `@ftms/core` unit                    | Vitest 5                  | **90 passed** (7 files)                                               |
| `@ftms/web` unit                     | Vitest 5                  | **34 passed** (2 files)                                               |
| `@ftms/api` unit                     | Jest 30                   | **126 passed** (14 suites)                                            |
| `@ftms/api` e2e (real Postgres)      | Jest 30                   | **850 passed** (22 suites, 349 s)                                     |
| `@ftms/web` browser e2e (real stack) | Playwright 1.64, Chromium | **41 passed** (core 14, attendance 7, requests 8, audit 6, quality 6) |
| Lint (type-aware ESLint)             | —                         | 0 problems in all packages                                            |
| Typecheck                            | TypeScript 6.0            | 0 errors in all packages                                              |
| Prettier                             | —                         | all files formatted                                                   |
| Secret scan                          | `scan-secrets.mjs`        | none in 444 files; none in the history (9 commits)                    |
| Browser bundle scan                  | `scan-client-bundle.mjs`  | clean: 41 files, 2 stand-in secret values, 11 names, 4 patterns       |
| Message catalogs                     | i18n check                | 1,467 keys used, 0 missing in either language                         |
| Schema document                      | `pnpm docs:schema`        | identical to the committed `docs/database.md`                         |

Details worth recording:

- **Role matrix:** 590 cases (118 rows × 5 callers: anonymous, student, faculty, Training
  Director, Super Admin); the route-coverage test found every route of the running API
  either in the matrix or on the reviewed public list (14 routes).
- **Accessibility:** axe-core with the WCAG 2.0/2.1 A and AA rule sets on 54 page loads
  (signed-out pages ×2 languages, 17 staff pages ×2, 6 student pages ×2): no violations of
  any impact (16–31 rules passing per page; the rest do not apply to the page).
- **Layout:** the same pages at 375, 768 and 1280 px — nothing wider than the window.
- **Exports (§20.6):** CSV, XLSX and PDF of the same records compared with the records:
  Arabic and English names, a formula-shaped name (neutralized in CSV/XLSX, shown as typed
  in PDF), seat numbers, scheduled times, check-in times, minutes late, sources, a missing
  check-in time and note, two groups, a cancelled visit excluded, an absence finalized by
  the export itself; Arabic PDF text compared by letters (see
  [limitations.md](limitations.md)).

### Production build (Vercel CLI) and smoke test

Recorded in [deployment.md](deployment.md#verified-locally): both projects built from a
clean checkout with Vercel CLI 62.7.0; the traced API function started in isolation in
production mode (health 200; readiness 503 only because the placeholder Redis, storage and
mail hosts are unreachable; a sign-in then answers 503 `SERVICE_UNAVAILABLE`); 20/20 file
and WebAuthn paths served by the same function in development mode; `pnpm smoke` **10
passed, 0 failed** against it and the production web build.

### Earlier phases

Each checkpoint in [`checkpoints/`](checkpoints/) records that phase's final run. Phase 6
ended with 771 API e2e and 35 browser tests; Phase 7 adds the security, route-coverage,
PDF-content and quality suites.
