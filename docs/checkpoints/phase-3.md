# Phase 3 checkpoint — Scheduling and Calendar

Date: 2026-10-21 · Scope: §21 Phase 3 only. No Phase 4 work (QR codes, check-in, attendance records, absence processing, biometrics, exports) was started.

## Definition of Done

| Criterion                                                                                                                         | Result     | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Faculty can create visits for one or multiple groups                                                                              | ✅         | API e2e: a faculty member creates a visit for groups A and B (title, details, date, times, place, coordinates, map link); validation of every field on the backend (past dates, dates outside the program, no/duplicate/unknown/archived groups, end before start, half coordinates, non-https map links, timing rules); timing copied from the defaults, overridable only with `attendance.settings.visit`. Playwright: the visit form with the searchable group multi-select, then the confirmation "Visit added to the calendar. 1 student was notified." (§6.4 step 5).                                                                                                 |
| Only affected students receive the correct calendar entries and notifications (verified with a test covering an unselected group) | ✅         | API e2e (`visits.e2e-spec.ts`, DoD case): students in A and B each get exactly one `visit.created` notification linking to the visit and see it in their calendar; the student in **unselected group C** gets no notification, an empty calendar, and 404 on the visit; exactly 2 notification rows exist. Further cases: on regrouping B→kept, A→removed, C→added, each gets the right notification and calendar; schedules and days off notify only their groups' students. Playwright: the same in the browser — group A's student sees the bell count, the notification and the visit; group C's student (Arabic, RTL) sees "لا توجد إشعارات بعد." and gets a 404 page. |
| Migration applied to **Supabase**                                                                                                 | ⚠️ Not run | Applied with `prisma migrate deploy` to fresh PostgreSQL 16 databases (and Postgres 17 in CI config). Not run against Supabase — no credentials were provided and this workspace cannot reach Supabase. Carries over the Phase 0–2 ⚠️ item.                                                                                                                                                                                                                                                                                                                                                                                                                                 |

### Remaining step for the ⚠️ item (on your machine, with your credentials)

```bash
pnpm db:deploy   # applies the earlier migrations and 20261020182827_scheduling_visits_notifications
psql "$DIRECT_URL" -c 'SHOW timezone;'   # must print UTC (see decision 2)
pnpm storage:provision                   # visit-media / visit-documents buckets (private)
pnpm dev         # then GET http://localhost:4000/health/ready → database "up"
```

## Test results (actual output, final run)

Clean run: `pnpm install --frozen-lockfile`, `pnpm format:check`, `turbo run lint typecheck build test --force` (**13/13 tasks**), then `pnpm test:e2e` on a freshly migrated database (**6/6 tasks**).

| Suite                                | Runner          | Result                     |
| ------------------------------------ | --------------- | -------------------------- |
| `@ftms/core` unit                    | Vitest 5        | 50 passed (4 files)        |
| `@ftms/web` unit                     | Vitest 5        | 18 passed (1 file)         |
| `@ftms/api` unit                     | Jest 30         | 100 passed (11 suites)     |
| `@ftms/api` e2e (real Postgres)      | Jest 30         | 456 passed (12 suites)     |
| `@ftms/web` browser e2e (real stack) | Playwright 1.64 | 14 passed (Chromium)       |
| Lint (type-aware ESLint)             | —               | 0 problems in all packages |
| Typecheck                            | TypeScript 6.0  | 0 errors in all packages   |
| Prettier                             | —               | all files formatted        |

The role × endpoint matrix grew from 195 to **315 cases**: 24 new endpoints × 5 callers (Super Admin, Training Director, Faculty, Student, anonymous). `POST /notifications/:id/read` is covered by the feature suite (only the recipient can mark it; anyone else gets 404). New database tests violate the rules directly: UTC sessions, instants across both daylight-saving changes, at least one group per visit (checked at commit), no archived groups, complete cancellations, paired coordinates, https map links, one current program, one cover per visit, one day off per date, frozen ended schedules, one notification per recipient and event. Also verified: client bundles contain no secret names or values; every message key used by the web app exists in both catalogs (790 keys checked).

## What was built

- **Migration `20261020182827_scheduling_visits_notifications`:** `training_programs`, `training_schedules`, `schedule_groups`, `schedule_exceptions`, `training_visits`, `visit_groups`, `visit_files`, `notifications`. Hand-written rules: one current program; value ranges for durations, absences and timing (grace ≤ close); real IANA time zones only; valid weekday sets; visits and schedules always have a group (deferred constraint triggers) and never gain an archived one; complete cancellation state; paired coordinates and https map links; UTC instants derived by the database from the Cairo wall-clock date and times; ended schedules frozen; one cover photo per visit; one day off per date (all schedules) or per schedule and date; notifications unique per recipient and event and immutable except their read time; database time zone pinned to UTC. RLS on every new table.
- **Program settings (API + `/schedule`):** first configuration (pre-filled with suggested values), name/dates (`schedule.manage`) and attendance defaults (`attendance.settings.defaults`) changed separately, with a settings history (§11.3).
- **Recurring schedules:** create, change (re-plans future sessions), end (cancels upcoming sessions); group-specific vs training-wide permissions; days off for one or all schedules, with restore.
- **Visits:** create, edit, cancel with a reason, restore; per-visit timing; cover photo and documents (private storage, content-checked, signed links); history from the audit log.
- **Calendars:** month view (Saturday-first weeks) with an agenda list; students see their group's visits, staff all visits with a group filter; visits page with date/group/status filters; upcoming visits on the dashboard.
- **Notifications:** notification center with unread filter, mark one/all as read, header bell with unread count; visit, schedule, day-off, verification and profile-correction events.
- **Navigation:** Training calendar, Notifications, Visits, Calendar and Training schedule are live.

## Decisions taken (and why)

1. **Schedule sessions are visits.** Each occurrence is a `training_visits` row with `schedule_id` + `occurrence_date` (unique), so one session can be moved or cancelled without touching the definition (§6.1) and Phase 4 attaches attendance to one kind of record. A session changed on its own is marked and never re-planned.
2. **Wall-clock times are the truth; the database derives UTC instants.** Visits store a Cairo date and times; a trigger computes `starts_at`/`ends_at` with PostgreSQL's time-zone rules (a skipped hour moves forward, a repeated hour takes standard time — the API's own conversion matches and is tested on both 2026 changes). **Finding:** Prisma's Postgres adapter writes and reads `timestamptz` as UTC wall-clock text, which silently shifts every stored instant when a server's session time zone is not UTC (the local test cluster defaulted to Africa/Cairo). The migration pins the database time zone to UTC (Supabase's default) and a test checks it.
3. **When a visit is locked.** Before check-in opens everything can change; once it opens, date, time, groups and timing are locked (title, details, place and files remain editable); once it closes (the closing minute itself still counts, §8.2), the visit can no longer be cancelled or restored.
4. **Visits are created in the future and inside the program period**; schedules too. A visit already under way cannot be "created".
5. **Notifications store a type and parameters**, not text, so each reader sees their language (§18.1). Recipients are the linked student accounts currently in the groups; students without an account have nobody to notify yet. Each notification has a key unique per recipient and event, so retries (Phase 4 background jobs) never duplicate.
6. **What is "significant" (§6.5):** date, time, place, groups and timing changes notify; a title or details change alone does not. New groups' students get "new visit", removed groups' students "no longer for your group".
7. **Training-wide vs group-specific schedules:** a schedule that covers every active group is the training-wide schedule and needs `schedule.manage` (Training Director); `schedule.group.manage` (grantable to faculty) covers the rest. A day off for all schedules needs `schedule.manage`.
8. **Editing a schedule removes** its upcoming sessions that no longer match (they were generated, never individual commitments; students get one "schedule changed" notification); **ending a schedule cancels** its upcoming sessions, which stay visible with the reason (§6.5).
9. **Days off create cancelled sessions** (including sessions generated later on that day), so removing the day off restores exactly what it cancelled.
10. **Files:** at most 4 MB per upload (uploads pass through the web server; Vercel's limit), type decided by content (JPEG/PNG/WebP covers; PDF, Word, Excel, PowerPoint or images as documents), at most 10 documents, links valid 10 minutes. Without Supabase (development/tests only) files go to a local, HMAC-signed driver; production requires Supabase at boot.
11. **Student calendar = current group.** §9.4 ("respecting one-active-group rule"); visits of a previous group will appear in attendance history (Phase 4).
12. **Visits of other groups do not exist for a student** (404, not 403), and students do not see the other groups a visit concerns.
13. **One current program.** Starting a new program (next academic year) is not part of Phase 3.

### Small fixes to earlier phases

- Uploaded file names are now decoded as UTF-8 (multer defaulted to latin1, garbling Arabic names of imported spreadsheets).
- Verification and profile-correction decisions now also create in-app notifications (§12), next to the existing emails.

## Not verified live (needs credentials — none were invented)

- Supabase Postgres (the four migrations, including the `ALTER DATABASE … SET timezone` statement) and Supabase Storage (visit files used the local driver in tests).
- Gmail SMTP (codes and decision emails are logged, not sent, without `SMTP_PASS`).
- Upstash Redis rate limiting (stubbed in unit tests).
- GitHub push and a GitHub Actions run.

## Known limitations

- Changing the program's dates does not move existing schedules or visits; groups created after a schedule are not added to it.
- Calendar requests cover at most 100 days (one month is shown at a time).
- In-app notifications only for visits and schedules (§12.1 baseline); no email for them.
- A group can be archived only when empty (Phase 2 rule), so its remaining visits reach nobody.

## Notes for whoever runs Phase 4

- Attendance windows: `training_visits.starts_at` (UTC) and the visit's own `check_in_opens_minutes` / `grace_minutes` / `check_in_closes_minutes`; `visitPhase()` in `@ftms/core` encodes the minute convention (the closing minute is inside the window). Cancelled visits (`status = CANCELLED`) must reject check-ins.
- Who may check in: students whose current group is in `visit_groups` (see `VisitsService.studentGroup`).
- Notifications: `NotificationsService.notify(tx, recipients, { type, data, link, dedupeKey })` inside the transaction; add new types to `NOTIFICATION_TYPES` and texts to `notifications.text` in both catalogs (`lib/notification-text.ts`).
- The visit-details QR code can point at `/visits/<id>`: it already requires sign-in and group membership.
- Absence processing compares instants in SQL — it relies on the database time zone being UTC (decision 2).
- New endpoints: add rows to the matrix in `apps/api/test/authorization.e2e-spec.ts`; new tables: enable RLS and add them to the reset lists (`apps/api/test/helpers/test-app.ts`, `apps/web/e2e/global-setup.ts`).
