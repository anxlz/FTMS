# Phase 7 checkpoint — Security, Accessibility, and Final Verification

Date: 2026-10-25 · Scope: §21 Phase 7 (the last phase). No credentials were available for Vercel, Supabase, Upstash, Gmail or GitHub; none were invented.

## Definition of Done

"All required features work together, tests have actual recorded results, and remaining limitations are documented honestly."

| Phase 7 deliverable                                | Result     | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Security review against §17 (biometrics, location) | ✅         | [`security-review.md`](../security-review.md): every §17 control with its test; biometric metadata and location handling; 7 findings fixed (below). New `security.e2e-spec.ts` (9 tests): forged / `alg: none` / wrongly signed / expired / retyped / altered tokens, a correctly signed token claiming `SUPER_ADMIN`, revoked session and suspended account, injection-shaped search text, malformed, oversized and prototype-polluting bodies, mass assignment, headers, no CORS, error bodies, export limit. |
| Permission / privacy testing (§20.7)               | ✅         | The role matrix now has **590 cases** (118 rows × 5 callers), and a new test walks every route of the running API: it fails if a route is public without being on the reviewed list of 14, or has no row in the matrix. A unit test fails if any `@Body`/`@Query` lacks a Zod pipe or any `@Param` lacks a pipe. Students' view of who decided stays hidden (Phase 5/6 tests).                                                                                                                                  |
| Responsive layout checks                           | ✅         | `quality.spec.ts`: every staff and student page and the signed-out pages at 375, 768 and 1280 px — no horizontal overflow (found and fixed: the month calendar widened the page at phone width).                                                                                                                                                                                                                                                                                                                |
| Arabic / English including RTL                     | ✅         | Every page in both languages: `lang`/`dir`, no untranslated message key, no Arabic-Indic digit; switching language keeps the URL and filters; 1,467 message keys present in both catalogs.                                                                                                                                                                                                                                                                                                                      |
| Accessibility                                      | ✅         | axe-core (WCAG 2.1 A/AA) on 54 page loads (8 signed-out, 34 staff, 12 student): **no violations of any impact**.                                                                                                                                                                                                                                                                                                                                                                                                |
| Export validation (§20.6)                          | ✅         | The attendance PDF is now checked against the records too (text extracted with pdf.js): dates, times, seat numbers, check-in times and minutes late exactly, Arabic cells by their letters — plus CSV and XLSX as before (Arabic names, seat numbers, lateness, missing optional values, two groups). The standing report's PDF figures match its CSV.                                                                                                                                                          |
| Error-handling review                              | ✅         | Translated not-found page (real 404), an error boundary for signed-in pages, a last-resort bilingual global error page; body-parser errors 400/413 instead of 500; database or Redis unreachable → 503 `SERVICE_UNAVAILABLE` (translated); navigation shows a pending indicator.                                                                                                                                                                                                                                |
| Production build on Vercel (web + API)             | ✅ (local) | Both projects built with the Vercel CLI from a clean checkout; the built API function was run in isolation in production mode and served health, exports (PDF/XLSX/CSV in both languages), the import template and WebAuthn options; `pnpm smoke` passed 10/10 against it and the production web build. Two deployment blockers were found this way and fixed. **Not deployed** (no accounts).                                                                                                                  |
| Deployment documentation                           | ✅         | [`deployment.md`](../deployment.md): Supabase, Upstash, Gmail, both Vercel projects, domains and WebAuthn, migrations, seed, storage, cron, smoke test, updates, rollback, and what was verified locally.                                                                                                                                                                                                                                                                                                       |
| Environment-variable documentation                 | ✅         | [`environment.md`](../environment.md); `env-docs.spec.ts` fails if a validated variable is missing from either `.env.example` or the docs, if the stated requirement differs from the validation, or if an example file gives a secret a value.                                                                                                                                                                                                                                                                 |
| Backup / recovery recommendations                  | ✅         | [`operations.md`](../operations.md): what holds state, backups (PITR, independent dumps, Storage copies), recovery scenarios, a proposed retention policy with SQL dry-run locally, secret rotation effects, monitoring, incident outline.                                                                                                                                                                                                                                                                      |
| Icons wired for web and ready for Tauri Android    | ✅         | `icons.test.ts`: the source logo's hash, every generated output at its declared size and byte count, all five Android densities (legacy, round, adaptive foreground at 108 dp) and the adaptive XML. Browser: favicon, `icon.png`, `apple-icon.png` and every manifest icon (including the maskable one) served at their declared PNG sizes.                                                                                                                                                                    |

## Test results (actual output, final run)

Clean run: `pnpm install --frozen-lockfile`, `prettier --check .`, `pnpm scan:secrets` (444 files; history: 9 commits, after the commit), `turbo run lint typecheck build test --force` (**13/13 tasks**, no cache), a web build with stand-in secrets then `pnpm scan:bundle`, `pnpm docs:schema` (no difference), then `pnpm test:e2e` on a freshly migrated database (API suite, then the browser suite).

| Suite                                | Runner          | Result                     |
| ------------------------------------ | --------------- | -------------------------- |
| `@ftms/core` unit                    | Vitest 5        | 90 passed (7 files)        |
| `@ftms/web` unit                     | Vitest 5        | 34 passed (2 files)        |
| `@ftms/api` unit                     | Jest 30         | 126 passed (14 suites)     |
| `@ftms/api` e2e (real Postgres)      | Jest 30         | 850 passed (22 suites)     |
| `@ftms/web` browser e2e (real stack) | Playwright 1.64 | 41 passed (Chromium)       |
| Lint (type-aware ESLint)             | —               | 0 problems in all packages |
| Typecheck                            | TypeScript 6.0  | 0 errors in all packages   |
| Prettier                             | —               | all files formatted        |
| Secret scan / bundle scan            | —               | clean / clean              |
| Smoke test (production builds)       | `pnpm smoke`    | 10 passed, 0 failed        |

From Phase 6: API e2e 771 → 850 (new: `security.e2e-spec.ts`, route coverage and 14 matrix rows, PDF content checks), browser 35 → 41 (`quality.spec.ts`), API unit 115 → 126, web unit 27 → 34. Full details: [`testing.md`](../testing.md).

## What was built

- **Security:** `apps/web/lib/security-headers.ts` (nonce CSP per request from the proxy, static headers and HSTS from `next.config`); API security headers; `common/search.ts` (`literal()` for LIKE); exception filter mapping for body-parser and database errors; `ExportThrottle` (30 downloads / 15 min / account); `UpstashRateLimiter` fails closed with 503; error code `SERVICE_UNAVAILABLE` with both translations.
- **Tests:** `security.e2e-spec.ts`; route-coverage test (`test/helpers/routes.ts`) and 14 new matrix rows; `validation-coverage.spec.ts`; `env-docs.spec.ts`; PDF content checks (`test/helpers/pdf-text.mjs`, pdf.js 6.2 as a dev dependency); `quality.spec.ts` (a new Playwright project after `core`); `icons.test.ts`; web policy unit tests; rate-limiter and filter unit tests.
- **Web:** `not-found.tsx`, `(app)/error.tsx`, `global-error.tsx`; navigation pending indicator (`useLinkStatus`); tables contain their visually hidden captions (calendar overflow fix).
- **Deployment:** `apps/web/vercel.json` (build through Turborepo); `apps/api/vercel.json` ships pdfkit's standard fonts.
- **Tooling and CI:** `scripts/scan-secrets.mjs` (`pnpm scan:secrets`, `--history`), `scripts/scan-client-bundle.mjs` (`pnpm scan:bundle`, run after the build with a stand-in secret), `scripts/smoke.mjs` (`pnpm smoke`), `scripts/generate-schema-doc.mjs` (`pnpm docs:schema`, drift-checked in CI); turbo inputs so the docs and branding files re-run the tests that read them.
- **Documentation (§22):** `features.md`, `database.md` (generated), `authentication.md`, `attendance-rules.md`, `environment.md`, `deployment.md`, `operations.md`, `security-review.md`, `testing.md`, `limitations.md`; README status, documentation index, commands, deployment, security and icon notes.

## Findings fixed (and how they were found)

1. **The API would not start on Vercel** — the traced function lacked pdfkit's standard-font files, loaded when `@react-pdf` is imported (found by running the Vercel-built function in isolation). Fixed with `includeFiles`.
2. **The web app would not build on Vercel from a clean checkout** — `@ftms/core` was never compiled (40 × "Can't resolve '@ftms/core'"). Fixed with `apps/web/vercel.json` building through Turborepo.
3. Search text used as a LIKE pattern (`%` matched everything). Escaped everywhere.
4. Oversized / malformed bodies answered 500. Now 413 / 400.
5. No security headers on either app. Added (CSP with nonces on the web app).
6. Unlimited exports. 30 per 15 minutes per account.
7. Redis or database outage answered 500. Now 503, still failing closed.
8. The month calendar widened the page at phone width (an absolutely positioned hidden caption escaped its scroll container). Fixed in CSS.
9. A `loading.tsx` boundary tried for navigation feedback turned 404 pages into 200s; removed in favour of a per-link pending indicator.

## Decisions taken (and why)

1. **Verify the Vercel build locally instead of claiming a deployment.** The Vercel CLI builds the exact output Vercel deploys; running the traced function from an isolated copy is the closest available proof that it boots — and it found two blockers. The live deployment stays an open item.
2. **CSP with per-request nonces and `strict-dynamic`**, `style-src 'unsafe-inline'` kept for React style attributes; the browser suite fails on any CSP violation, so the policy is known not to break pages.
3. **Rate limits fail closed** (503) when Redis is unreachable rather than letting sign-ins through unlimited.
4. **Exports are limited per account** (30 / 15 min) — generous for staff work, a brake on bulk extraction by a compromised account.
5. **Accessibility gate: no serious or critical axe violations**; lesser findings are recorded per page (there were none).
6. **PDF text is compared by letters for Arabic**: the PDF draws Arabic correctly, but its text layer stores shaped glyphs; copying Arabic out of a PDF can reorder letters (documented as a limitation; CSV/XLSX are for data).
7. **The schema documentation is generated** from the schema and migration SQL and drift-checked in CI, so it cannot go stale.
8. **Retention is a recommendation, not code**: deleting personal data and archiving the audit log are institutional decisions; `operations.md` proposes a policy with dry-run SQL.

## Not verified live (needs credentials — none were invented)

- Vercel deployment, Supabase (Postgres pooler, Storage, Vault, `pg_cron`), Upstash Redis, Gmail SMTP delivery, a GitHub repository and an Actions run, biometrics and geolocation on real phones over HTTPS. The student email domain `agr.asu.edu.eg` awaits confirmation.

## Known limitations

See [`limitations.md`](../limitations.md) — the complete list, including the items carried over from Phases 2–6.

## Handover

- Production readiness depends on the open items above: follow [`deployment.md`](../deployment.md) and run `pnpm smoke` plus the manual checklist.
- New routes must be added to the role matrix (or the reviewed public list) — the route-coverage test fails otherwise; new inputs need a Zod pipe — the validation-coverage test fails otherwise.
- After a migration, run `pnpm docs:schema` and commit `docs/database.md`.
