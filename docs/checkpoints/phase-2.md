# Phase 2 checkpoint — Student Records and Groups

Date: 2026-10-20 · Scope: §21 Phase 2 only. No Phase 3 work (schedules, visits, calendar, in-app notifications) was started.

## Definition of Done

| Criterion                                                                                                          | Result     | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Faculty can import valid student records                                                                           | ✅         | API e2e (10 import cases): the downloadable template, filled and uploaded, previews and commits; cell normalization (Arabic digits, numeric cells, hyperlinked emails); every row error reported with its reason; commit refused until invalid rows are explicitly skipped; updates to existing students only with explicit confirmation, blanks never erase; stale previews refused; only the uploader commits, once. Playwright: upload → preview (2 new, 1 error) → refused → skip confirmed → imported → students listed.                                                                                                                                |
| Students can link accounts to existing records without duplication                                                 | ✅         | API e2e (16 linking cases): first sign-in by email code creates the account and links the imported record (record count unchanged); signup matching a record links it at once (also with Arabic spelling variants); a seat number with another email, an already linked seat or a different name never links automatically; two people racing for one record → exactly one linked; a pending student fixing a typo is linked on resubmission; capitalization never creates a second account. Playwright: imported student signs in by code, sees the faculty's data, then signs in with the seat number; signup Case A and Case B (reviewed, then admitted). |
| Group membership constraints are enforced at the database level (verified with a test that attempts to violate it) | ✅         | `group_memberships_one_active_per_student` (partial unique index). The test inserts a second active membership directly through Prisma **and** with raw SQL — both rejected — and only one row exists afterwards. Also tested: ended memberships are immutable, archived groups take no members, non-empty groups cannot be archived, concurrent moves leave exactly one active membership.                                                                                                                                                                                                                                                                  |
| Migration applied to **Supabase**                                                                                  | ⚠️ Not run | Applied with `prisma migrate deploy` to fresh PostgreSQL 16 databases (and Postgres 17 in CI config). Not run against Supabase — no credentials were provided and this workspace cannot reach Supabase. Carries over the Phase 0/1 ⚠️ item.                                                                                                                                                                                                                                                                                                                                                                                                                  |

### Remaining step for the ⚠️ item (on your machine, with your credentials)

```bash
pnpm db:deploy   # applies …_init, …_identity_auth_audit and 20261020131936_students_groups_imports
pnpm db:seed     # if not done yet
pnpm dev         # then GET http://localhost:4000/health/ready → database "up"
```

## Test results (actual output, final run)

Clean run: `pnpm install --frozen-lockfile`, `pnpm format:check`, `turbo run lint typecheck build test --force` (**13/13 tasks**), then `pnpm test:e2e` on a freshly migrated database (**6/6 tasks**).

| Suite                                | Runner          | Result                     |
| ------------------------------------ | --------------- | -------------------------- |
| `@ftms/core` unit                    | Vitest 5        | 37 passed (3 files)        |
| `@ftms/web` unit                     | Vitest 5        | 14 passed (1 file)         |
| `@ftms/api` unit                     | Jest 30         | 93 passed (10 suites)      |
| `@ftms/api` e2e (real Postgres)      | Jest 30         | 310 passed (9 suites)      |
| `@ftms/web` browser e2e (real stack) | Playwright 1.64 | 9 passed (Chromium)        |
| Lint (type-aware ESLint)             | —               | 0 problems in all packages |
| Typecheck                            | TypeScript 6.0  | 0 errors in all packages   |
| Prettier                             | —               | all files formatted        |

The role × endpoint matrix grew from 65 to **195 cases**: 26 new endpoints × 5 callers (Super Admin, Training Director, Faculty, Student, anonymous). The remaining new endpoints (import detail/commit/discard, request details and decisions, signup verification) share their controller's class-level permission and are exercised by the feature suites, including refusals (another faculty member committing an import, a faculty member denied `profile_changes.decide`, a student opening a review queue). Also verified: client bundles contain no secret names or values; every message key used by the web app exists in both catalogs (537 keys checked).

## What was built

- **Migration `20261020131936_students_groups_imports`:** `training_groups`, `group_memberships`, `student_imports`, `student_verification_requests`, `profile_change_requests`; student records gain phone, creator, link time and a search key; codes are keyed by email. Hand-written rules: one active group per student, immutable membership history, archive rules, case/space-insensitive unique group names, one open request per student/account, complete decisions (a rejection always has a reason), only students can be pending, and an ACTIVE student account must be linked to a record (deferred constraint trigger). RLS on every new table.
- **Student records (API + web):** list/search (Arabic names match whatever the spelling: a database-maintained search key), filters by group and account, create, edit with before/after audit, delete (unlinked only, snapshot kept), group history, unlink a wrongly linked account.
- **Excel import:** downloadable bilingual template; upload (≤ 4 MB, ≤ 5,000 rows) → per-row validation → preview with filters → explicit commit; original file kept in the private `student-imports` bucket when Storage is configured.
- **Account linking:** first sign-in of an imported student by email code (§4.3); student signup with four-part name, seat number and verified university email (§4.2 Case A/B); a verification page for pending accounts; reviewer queue to link, create or reject.
- **Groups:** create, rename, archive/restore, members with add (from search or ungrouped students), move (explicit), remove.
- **Profile management (§4.4):** students see their record, change their phone directly, and request corrections of name parts or seat number; reviewers approve (applied atomically) or reject with a reason; decision emails.
- **Navigation:** Students, Groups and Review queues are live; the dashboard shows real student/group/review counts.

## Decisions taken (and why)

1. **Records exist before accounts.** Faculty data is authoritative; an account links to one record (unique), never creating a second one.
2. **Codes are keyed by email**, so a code can be sent to an imported student's address before any account exists — the account is created only after the code proves the address.
3. **Case A rule:** the verified email matches the email on the record, or — when the record has no email — the full name matches (diacritics, hamza forms, ة/ه, ى/ي and spacing ignored). Anything else is Case B. A taken seat number or an email already on another record never links automatically.
4. **Case B accounts can sign in** but a guard confines them to their verification page; they can correct and resubmit their details (matched automatically, 5 tries a day). Admins cannot "activate" them around the review.
5. **University email domains** are a setting, `UNIVERSITY_EMAIL_DOMAINS`, defaulting to `agr.asu.edu.eg` (the sender's domain) with subdomains accepted. **Please confirm the real student email domain(s)** — if they differ, only this variable changes.
6. **Import safety:** the plan is recomputed against live data for each preview and inside the commit; the commit carries the digest of what the user saw and is refused if anything changed. Blank cells never erase; a full-name-only cell replaces the name parts (it cannot be split reliably); a linked student's email cannot be changed by import; unknown groups are errors (no groups are created implicitly); group cells need `groups.manage`.
7. **Phone numbers:** a new self-service field (§4.4 "permitted profile fields"). Egyptian mobiles stored as numbers in Excel lose their leading zero; it is restored for exactly that shape (`1[0125]` + 8 digits).
8. **Protected fields** = the four name parts and the seat number. University email is the sign-in identity and is not changeable through a profile request.
9. **Faculty scope is training-wide** for student records and groups: the master prompt defines no faculty-to-group assignment. Permissions (`students.*`, `groups.manage`, `profile_changes.decide`) decide who may act.
10. **Decision emails** (verification and profile changes) are sent now through the existing mail service; in-app notifications are Phase 3 (§12).
11. **Faculty-created student accounts** (Phase 1 admin form) are kept; they now require a university email like every student path.

## Not verified live (needs credentials — none were invented)

- Supabase Postgres (the three migrations) and Storage (import files are stored only when Storage is configured; in tests `storedFile: false`).
- Gmail SMTP: codes and decision emails are logged, not sent, without `SMTP_PASS`.
- Upstash Redis rate limiting (stubbed in unit tests).
- GitHub push and a GitHub Actions run.

## Known limitations

- Only `.xlsx` is accepted (the template is `.xlsx`); `.xls`/`.csv` are refused with a clear error.
- The preview page shows the first 300 rows of each filter; the counts always cover the whole file.
- Bulk group assignment is through import or the group page (up to 50 search results at a time).

## Notes for whoever runs Phase 3

- Visits target groups: use `group_memberships` with `ended_at IS NULL` for "students in group G now"; membership history is available for past visits.
- In-app notifications (§12) should also cover the Phase 2 events that currently only email: verification decisions and profile-change decisions.
- `GroupsService.moveInTx` is the one place that changes membership (Phase 5's atomic swap should build on it, inside one transaction).
- New endpoints: add rows to the matrix in `apps/api/test/authorization.e2e-spec.ts`; new tables: enable RLS (the structure test checks it) and add them to the test reset lists (`apps/api/test/helpers/test-app.ts`, `apps/web/e2e/global-setup.ts`).
