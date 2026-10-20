# Field Training Management System — Master Implementation Prompt

## 0. How to Work This Prompt

This system is built **in phases, across separate sessions/prompts — never as a single one-shot run.** Each phase below (Phase 0–7) is its own discrete implementation prompt: you will be given one phase at a time as a fresh instruction. Do not attempt to execute Phases 0–7 end-to-end in one continuous session just because the full scope is visible in this document.

For whichever phase you have been asked to execute:

- Treat this document as the shared source of truth for the whole project, but implement **only the phase you were asked to do**. Do not start work on a later phase "while you're at it," even if it looks quick.
- Before starting, confirm what prior phases actually delivered (read the existing code/migrations/tests — don't assume from this document what "should" already exist).
- Verify the current phase against its own "Definition of Done" — actually run the tests, actually run the build, actually check the behavior. A phase is not complete because the UI renders or the code compiles.
- Apply extra effort and extra care throughout: prefer the thorough, correct implementation over the fast one. Do not silently shrink scope to finish faster. If a requirement is expensive to implement correctly, implement it correctly anyway — do not substitute a shortcut and present it as equivalent.
- Report actual test results, not expected or assumed ones. If something fails, say so and either fix it or document it as a known limitation — never claim success you haven't verified.
- Never substitute fake authentication, mock attendance, hardcoded dashboard numbers, or stubbed business logic for real, database-backed functionality. Every button, form, dashboard metric, export, notification, and administrative action must perform its real, advertised operation against the real database.
- Do not invent credentials, API keys, or secrets. Where a real secret is required (Gmail app password, etc.), leave a clearly labeled placeholder in `.env.example` and documentation — never a fabricated value.
- Ask a focused question only when a genuine ambiguity would otherwise force an unsafe or irreversible technical decision. Otherwise, make the reasonable call, document it, and keep going.
- At the end of the phase, stop and checkpoint: summarize what was built, what was tested (with real output), what's left, and what the next phase will need to pick up. Do not continue into the next phase's work — wait for it to be assigned as its own prompt.

---

## 1. Project Overview

Build a complete, secure, responsive web application for managing field training at **Faculty of Agriculture, Ain Shams University, Egypt**.

The application supports students, faculty members, a Training Director, and a Super Admin. Its purpose is to manage field-training visits, student attendance, QR-code check-ins, schedules, student groups, notifications, student support tickets, and group-swap requests.

This is an operational university system, not a generic event-management application. All features are designed around the field-training program and its academic attendance requirements.

### Core objectives

- Digitize field-training attendance using QR codes.
- Automatically calculate attendance status and lateness.
- Provide role-specific dashboards.
- Manage student records and university-email verification.
- Organize students into groups and schedule their visits.
- Display relevant visits on each student's calendar.
- Notify affected students about new visits and important updates.
- Manage complaints, suggestions, questions, and group-swap requests.
- Maintain comprehensive administrative and faculty activity logs.
- Export attendance reports in PDF, Excel, and CSV formats.
- Provide a reliable, maintainable, and secure application suitable for actual university use.

**Scope restriction:** The application is specifically for field training at the Faculty of Agriculture, Ain Shams University. Do not expand it into a general-purpose university ERP or unrelated training platform.

**Mobile app:** Out of scope for the initial web-focused phases below, but the architecture (standalone JWT-authenticated NestJS API) is deliberately chosen so a future **Tauri**-based mobile app can consume the same API without backend changes. Do not build the mobile app now — just don't do anything that would make it harder later (e.g., don't put business logic only reachable from Next.js server components; keep it in the API).

---

## 2. Hard-Committed Technology Stack

This stack is final. Do not re-propose alternative frameworks or databases; adapt within this stack.

| Layer | Choice |
|---|---|
| Monorepo | Turborepo |
| Web frontend | Next.js (App Router, TypeScript), deployed on **Vercel** |
| Backend API | NestJS (TypeScript), deployed on **Vercel** as serverless functions (via a serverless adapter, e.g. `@vendia/serverless-express` or `@nestjs/platform-express` wrapped for Vercel's Node runtime) |
| Database | **Supabase Postgres**, accessed via **Prisma ORM** (migrations + generated types) |
| Auth | Custom Postgres tables (not Supabase Auth — the seat-number/email/OTP/account-linking rules are too custom for it) + NestJS Passport, **local** and **JWT** strategies. Issue JWTs (not cookie-only sessions) so a future mobile client authenticates the same way. Password login is supplemented by optional **device biometric login** (see §4.5). |
| File storage | **Supabase Storage**, private buckets, signed URLs for visit photos, documents, and imported spreadsheets |
| Cache / rate limiting | **Redis via Upstash** (serverless-friendly REST client) — used for OTP/login rate limiting, session/permission lookups, dashboard aggregate caching |
| Background jobs | **Supabase `pg_cron` + `pg_net`**, calling a secured NestJS endpoint on a schedule (for automatic absence processing and any periodic notification sweeps). Do not rely on `@nestjs/schedule` alone — serverless function instances are not persistent. |
| Email | Gmail SMTP via **Nodemailer**. Sending address: `ST22425244@agr.asu.edu.eg`. This same address is seeded as the first **Super Admin** account. |
| QR codes | `qrcode` npm package for generation; **HMAC-signed, stable** visit tokens embedded in the code (never raw sequential IDs, never continuously rotating codes — see §7) |
| Exports | `exceljs` (XLSX), `pdf-lib` or `@react-pdf/renderer` (PDF), native CSV writer |
| i18n | `next-intl`, full RTL support for Arabic |
| Testing | Jest (NestJS default) for backend unit/integration tests; Vitest for frontend unit tests; Playwright for end-to-end flows (login, QR check-in, group-swap, exports) |
| Mobile (future, not now) | **Tauri** ([tauri.app](https://tauri.app/)), wrapping the same web frontend / consuming the same NestJS API, in place of Expo/React Native |

**Monorepo layout:**

```
apps/
  web/      # Next.js frontend
  api/      # NestJS backend
  mobile/   # reserved, empty for now — future Tauri app, do not build
packages/
  core/     # shared Zod schemas, TypeScript types, pure business-logic helpers
            # (attendance classification, group-swap state machine, etc.)
            # so both web and a future mobile app rely on identical rules
```

Keep attendance calculations, authorization, scheduling rules, and group-swap state transitions in testable backend services in `apps/api`, exposed through `packages/core` types — never embedded in frontend components.

### App icons and branding

Use `https://files.catbox.moe/dz8ax8.png` as the single source image for:
- The web app's favicon (`apps/web/app/favicon.ico` and any additional sizes Next.js metadata requires, e.g. `icon.png`, `apple-icon.png`).
- The web app's general "site icon" wherever referenced in `<head>` metadata / PWA manifest.
- The framed Android app icon (adaptive icon foreground/background as needed) for the future Tauri-based mobile build.

Download/derive the needed sizes from that source image at build time or as a committed asset — do not fabricate a different icon. Document in the README where the source image lives and how the derived sizes were generated, so it can be regenerated if the source image changes.

### Environment variables (document these in `.env.example`, no real secrets committed)

```
DATABASE_URL=                 # Supabase Postgres connection string
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=    # server-side only, for Storage access
SUPABASE_ANON_KEY=            # if needed client-side
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_USER=ST22425244@agr.asu.edu.eg
SMTP_PASS=                    # Gmail App Password — placeholder only, never fabricate
JWT_ACCESS_SECRET=
JWT_REFRESH_SECRET=
QR_HMAC_SECRET=
APP_TIMEZONE=Africa/Cairo
NEXT_PUBLIC_API_URL=
APP_ICON_SOURCE_URL=https://files.catbox.moe/dz8ax8.png
```

### Super Admin bootstrap

Do **not** hardcode a Super Admin password anywhere in code or docs. Implement a seed script that:
1. Creates the Super Admin account for `ST22425244@agr.asu.edu.eg` if it doesn't exist.
2. Generates a cryptographically random password.
3. Prints it once to the console/seed log (never commits it to a file in the repo).
4. Forces a password change on first login.

---

## 3. User Roles and Permissions

Exactly four primary role categories.

### 3.1 Super Admin

Highest privilege. Permissions:
- Access and manage all application functionality.
- Manage users, roles, permissions, and account states.
- Manage students, faculty members, groups, visits, schedules, and attendance.
- Manage authentication and application settings.
- Review and manage support tickets and group-swap requests.
- Access all audit logs and administrative records.
- Export available reports.
- Override attendance and other records when authorized by the system's rules.
- Manage global defaults and application configuration.

Super Admin privileges must be enforced by the backend, not just by displaying additional dashboard controls.

### 3.2 Training Director

Supervises field training; greater authority than ordinary faculty. Permissions:
- Access faculty-management functionality.
- Manage and configure the training schedule.
- Establish the recurring weekly schedule.
- Define and modify scheduled training visits and exceptions.
- Configure default attendance rules and lateness grace period.
- Override defaults for individual visits.
- Review training-wide information and attendance reports.
- Access all faculty activity audit logs.
- Review group-swap decisions and the identities of the people who approved or rejected them.
- Review the history of faculty-created, modified, and deleted records.
- Export authorized reports.

The Training Director must be able to determine who performed an administrative operation and when.

### 3.3 Faculty Member

Manages operational activities assigned to them. Permissions:
- Import student records using Excel files.
- Manage student records and their assigned groups, subject to permissions.
- Create and manage student groups.
- Configure group-specific training schedules where authorized.
- Create, edit, and cancel field-training visits.
- Select one or multiple groups per visit.
- Add visit details, location, date, time, photos, optional documents.
- Generate/access QR codes for visit details and attendance registration.
- View attendance records for relevant visits and groups.
- Correct a student's attendance status.
- Enter or correct manually recorded lateness.
- Review and process support tickets.
- Review group-swap requests and approve/reject them.
- Export attendance reports.
- Configure their permitted attendance settings.

Every faculty operation must be logged for the Training Director. Faculty members must not automatically receive unrestricted access to administrative functions reserved for the Training Director or Super Admin.

### 3.4 Student

Own account + training info relevant to their assigned group. Permissions:
- Sign up and log in.
- View and update permitted profile fields.
- Submit profile-change requests when approval is required.
- View dashboard and attendance statistics.
- View assigned training calendar.
- Open visit details.
- Register attendance via QR code.
- Receive notifications.
- Create and track support tickets.
- Submit and respond to group-swap requests.
- View history and outcome of their own tickets.

Students must never view another student's private profile, complete attendance history, or administrative information unless a specific workflow explicitly grants it.

---

## 4. Authentication and Account Management

Implement complete signup, login, email verification, password creation, and account-linking workflows.

### 4.1 Student data import

Faculty upload an Excel spreadsheet. Initial import must support:
- Full name, four name parts where available.
- Seat number.
- University email, if available.
- Assigned training group, if available.
- Additional fields explicitly supported by the student data model.

University email may be missing from imported records.

Import process must:
1. Validate spreadsheet structure and required fields.
2. Detect duplicate seat numbers and conflicting records.
3. Show a preview before committing.
4. Clearly report invalid rows and their errors.
5. Avoid silently overwriting existing student data.
6. Support safe updates to existing records when explicitly confirmed.
7. Record the importing faculty member and import results in the audit log.

Provide a downloadable example spreadsheet template.

### 4.2 Student signup

Signup form requests: four-part full name, seat number, university email. Email must be verified before activation.

After verification, backend checks whether seat number + identity match an existing (faculty-imported) student record.

**Case A — existing record matches:**
- Link authenticated account to existing record.
- Load previously imported info into the account.
- Preserve the existing seat number and other authoritative academic info.
- Do not create a duplicate student record.
- Allow managing permitted profile fields.
- Student must not have to re-enter info already recorded by faculty.

**Case B — no matching record:**
- Do not automatically trust an unverified student-submitted identity.
- Handle through a clearly defined pending-verification workflow.
- Where faculty approval is required, the student must not access protected academic records until verified.
- Never create duplicate accounts due to email capitalization/spelling differences.

### 4.3 Login methods

Support:
- University email + password.
- Seat number + password.
- University email + one-time verification code (when no password yet).
- Device biometric login, once enabled (see §4.5) — a convenience layer on top of the above, never a replacement for the underlying account credentials.

**First login for a preloaded student:**
1. Student enters university email.
2. System sends a time-limited verification code (via Gmail SMTP).
3. Student verifies the code.
4. System identifies and links the matching student record.
5. Student creates a new password.
6. Account becomes available via normal password login.

A student without a password must not be able to log in using only their seat number. Once a password exists, either university email or seat number works with it.

Implement password recovery, rate limiting (via Redis), secure password hashing (bcrypt/argon2), session management, and protections against account enumeration and verification-code abuse.

### 4.4 Profile management

Accounts display authoritative info already stored in the database. Students update permitted profile fields via settings. Changes to protected academic fields (identity, seat number) follow an approval workflow rather than immediately overwriting the official record. Maintain a record of submitted changes, decisions, and who approved them.

### 4.5 Biometric login

Any authenticated user (student or faculty) may enable biometric login from their account settings, on a device that supports it (platform authenticator — Face ID, Touch ID, Windows Hello, Android biometrics, etc.).

- Implement this via a standard device-bound public-key mechanism (e.g. WebAuthn/passkeys) rather than sending any raw biometric data to the backend. The device's own OS handles the biometric check; the server only ever sees a signed assertion from a registered public key.
- **Opt-in, per device:** biometrics must be explicitly enabled in user settings before they can be used to log in. Enabling it on one device does not silently enable it on another.
- Enabling biometric login must itself require the user to be authenticated through a normal method first (password or OTP) — never a bootstrap mechanism on its own.
- Users can view which devices have biometric login enabled and revoke any of them from settings. Revoking must take effect immediately.
- Losing/replacing a device must not lock a user out — password/OTP login remains available at all times as a fallback.
- Treat a successful biometric login the same as a password login for session/JWT issuance purposes, and log it as its own distinct auth method in relevant security logs.
- This same mechanism is reused by §7.2's attendance check-in, where a biometric confirmation is additionally required at the moment of check-in (not just at session login) — see §7.2 and §8 for how that interacts with attendance validation.

---

## 5. Training Groups

Students belong to exactly one active training group at a time.

Faculty can: create groups, edit group names/permitted properties, view membership, assign students, manage group-specific schedules, select groups when creating visits, review group-level attendance stats.

Training Director supervises group/schedule configuration. Super Admin has unrestricted authority.

Enforce one-group-per-student at the database and backend levels, not just frontend validation.

Group membership changes from an approved group-swap request must be processed atomically — the two students exchange groups without an intermediate invalid state.

---

## 6. Training Schedule and Calendar

### 6.1 Recurring weekly schedule

Training Director defines the standard schedule (e.g., two fixed days/week for twelve weeks — a default, not hardcoded).

Support: configurable training duration, fixed recurring weekdays, scheduled start/end times, group-specific schedules, individual visits, multiple visits same day, changes to a single occurrence without altering the recurring schedule, exceptions/cancellations/rescheduling/additional visits.

### 6.2 Group-specific calendars

Visit creation form asks which group(s) the visit concerns — one or multiple, via a searchable multi-select. Only students in selected groups receive the visit in calendars/notifications.

### 6.3 Creating a training visit

Form supports: title, description/details, date, start time, end time (where applicable), group(s), physical location, geo coordinates (where available), optional map link, cover photo, optional document attachments, attendance timing settings (inherited from defaults unless overridden).

Documents optional. Validate dates, times, group assignments, uploaded files on the backend.

### 6.4 Calendar visibility and notifications

Immediately after a visit is created:
1. Add to calendars of students in selected groups.
2. Create a notification for each affected student.
3. Display in the student's notification center.
4. Ensure visibility in the student's calendar.
5. Show confirmation that a new visit was added.

Notifications communicate relevant visit info and link to the details page. Same notification infrastructure must be reusable for schedule changes, cancellations, ticket updates, group-swap decisions, etc. Do not notify unaffected students.

### 6.5 Calendar changes

On visit change: update relevant calendars, notify affected students when significant, record in audit log, preserve history of what changed and when. A cancelled visit must show an appropriate status/notification, not silently disappear.

---

## 7. QR Codes and Visit Details

Two distinct QR-code purposes.

### 7.1 Visit-details QR code

Opens the visit's details page: title, date/time, description, location, training info, image, optional documents. Private student records/attendance info must never be exposed through a public visit URL. Require login when info/action requires an authenticated student.

### 7.2 Attendance QR code

Separate QR code identifying the visit and opening the check-in flow.

**Must be stable per visit — not continuously changing.** Faculty may print it on paper and cannot reprint for every check-in window, so the same visit keeps the same code.

The QR code itself must not grant attendance credit. The backend must verify:
- Student is logged in.
- Account is verified and active.
- Student belongs to a group assigned to the visit.
- Visit exists and is eligible for check-in.
- Current time is inside the permitted window.
- Student hasn't already registered attendance for that visit.
- A fresh device **biometric confirmation** (§4.5) has been performed as part of this specific check-in attempt — not merely an existing login session — and a device **geolocation** reading was captured at the moment of check-in.
- Request is valid and untampered.

**Biometric + geolocation at check-in:** once a student has biometrics enabled (§4.5), registering attendance for a visit requires both a biometric confirmation on that device and the device's current geolocation to be submitted along with the check-in request. Store the captured coordinates (and accuracy, if available) with the attendance record for faculty/audit review, but treat them as supporting context, not as a substitute for the other eligibility checks above — a location reading can be spoofed, so it is one more signal, not proof of presence on its own. If a student's device does not support biometrics or they haven't enabled it, fall back to whatever check-in flow the Training Director has configured as acceptable for that case (document the decision; do not silently skip the check or silently block check-in entirely).

Use secure, server-validated visit identifiers or signed tokens (HMAC). Never expose private student data inside the QR code. A stable QR code cannot prove physical presence by itself — use duplicate-check-in protection, authenticated accounts, server-side validation, biometric confirmation, geolocation capture, and abuse detection together. Do not claim a printed QR code alone — or geolocation alone — prevents sharing/impersonation.

### 7.3 QR-code behavior

Must: open the correct visit; work printed; be tied to one specific visit; be invalid outside its permitted window; reject duplicate check-ins; reject ineligible students. Cancelled visit → attendance registration disabled.

---

## 8. Attendance and Lateness Rules

### 8.1 Default timing configuration

| Setting | Default |
|---|---|
| Check-in opens | 15 min before scheduled start |
| On-time grace period | 15 min after scheduled start |
| Check-in closes | 60 min after scheduled start |
| Late calculation | Minute-by-minute after the 15-min grace period |

Configurable via faculty dashboard settings. Training Director configures overall defaults; authorized faculty override per visit. Changing defaults must not silently rewrite existing visits' rules — each visit keeps its applicable config, editable explicitly.

### 8.2 Attendance classification

**Present:** check-in between 15 min before start and end of grace period, inclusive. Record timestamp.
**Late:** check-in after grace period, no later than closing time. Record timestamp + auto-calculated minutes late.
**Absent:** no valid check-in when window closes. Auto-mark absent after window ends (if visit valid, no authorized correction made).

Example for a 10:00 AM visit: 9:45–10:15 Present; 10:15–11:00 Late (minutes calculated); no check-in by 11:00 → Absent.

Document the minute-rounding convention clearly. One minute after grace period ends = not present.

### 8.3 Automatic absence processing

Must run reliably with nobody watching — via Supabase `pg_cron` + `pg_net` calling a secured NestJS endpoint after each visit's check-in window closes. Idempotent: running more than once must not duplicate records or overwrite an authorized correction. Handle cancelled visits/schedule changes safely.

### 8.4 Faculty attendance corrections

Workflow: select visit → select group/student → choose status (Present/Late/Absent) → if Late, enter/correct minutes → save.

Record responsible faculty member, timestamp, previous status, new status, reason (when provided). A manual correction must not be silently overwritten by the automatic absence job. Audit log retains previous record + correction history.

### 8.5 Duplicate and invalid check-ins

One effective attendance record per student per visit. Second scan → show existing status, no second record.

Reject: unauthenticated check-ins; students outside selected groups; check-ins before opening/after closing time; check-ins for cancelled visits; duplicate submissions; check-ins missing a required biometric confirmation or geolocation reading per §7.2. Backend validation regardless of frontend.

---

## 9. Student Dashboard

### 9.1 Summary cards

Total scheduled visits, visits attended, late arrivals, absences, remaining permitted absences, upcoming visits, unread notifications, open support tickets. Status info must be understandable without relying on color alone.

### 9.2 Attendance calculations

Absence allowance configurable by admins. `remaining = max(0, allowed_absences - counted_absences)`. Count only valid, finalized records per configured rules. Do not hardcode allowance to 2 or duration to 12 weeks. Distinguish excused absences (if configured) from counted ones; don't add undocumented attendance categories.

### 9.3 Attendance history

Table: visit title, date, scheduled time, check-in time (if applicable), status, lateness in minutes, authorized notes. Students inspect their own history only.

### 9.4 Student calendar

Only visits for the student's assigned group(s), respecting one-active-group rule. Include details, location, documents, status. New visits/changes reflected in calendar + notification center.

---

## 10. Faculty Dashboard

### 10.1 Summary

Total/upcoming/completed/remaining scheduled visits, attendance summaries, group-level attendance, pending tickets, pending group-swap requests, recent notifications. Training Director gets training-wide overview; ordinary faculty see their authorized scope only.

### 10.2 Visit management

Create, edit, cancel/reschedule visits; select groups; set visit-specific timing rules; access QR codes; open attendance records; view location/materials. Backend enforces permissions on every operation.

### 10.3 Attendance management

Select a visit → inspect records: student name, seat number, group, status, check-in time, lateness, record source (QR vs. manual correction), captured geolocation (where submitted). Filter by group, status, student.

### 10.4 Exporting attendance records

PDF, XLSX, CSV. Include visit, date, group, student names, seat numbers, statuses, check-in times, lateness. Exports reflect the same underlying data/calculations as the dashboard. Same authorization/data-scope restrictions as dashboard access — never export outside the authorized scope.

---

## 11. Training Settings

### 11.1 Attendance settings

Check-in opening offset, lateness grace period, check-in closing offset, absence-processing behavior, allowed absences, training duration, whether biometric+geolocation confirmation is required or optional for check-in (and the fallback behavior when unavailable, per §7.2). Defaults: 15 min before, 15-min grace, 60-min close. Training Director manages training-wide defaults; authorized faculty override per visit.

### 11.2 Schedule settings

Training Director configures recurring days/times, group-specific scheduling, exceptions, rescheduled visits. Keep recurring schedule definitions and individual visit records clearly separate.

### 11.3 Configuration history

Log changes to important settings: who, when, previous/new values.

---

## 12. Notification System

Centralized, persistent, recipient-associated notifications for: new visit, reschedule/cancel, significant visit-detail changes, relevant attendance info, ticket status changes, group-swap requests/decisions, profile-change outcomes, biometric device enabled/revoked (security notice), other relevant events.

### 12.1 Requirements

Each notification: clear title, concise message, creation timestamp, read/unread status, link to relevant visit/ticket/request, intended recipient. Students see only what's relevant to them. Support unread counts + mark-as-read. Handle notification creation reliably; prevent duplicates on background-job retries. In-app notifications are the required baseline — don't assume email/push providers beyond the Gmail SMTP already specified.

---

## 13. Support Ticket System

### 13.1 Categories

1. Complaint / Report a Problem
2. Suggestion / Question
3. Group-Swap Request

Clear category selector; form adapts to selection.

### 13.2 Standard fields

Category, subject, description, creation date, status, optional attachments, responses/admin notes, status-change history. Don't force re-entry of profile info already on the account.

### 13.3 Ticket history

Students view their own tickets, filterable by category/status. Each shows category, date, status, conversation, outcome. For group-swap: show accepted/rejected outcome, and rejection reason if rejected.

**Privacy requirement:** never reveal the identity of the faculty member who approved/rejected in the student's ticket history. The Training Director's admin audit log retains that identity.

### 13.4 Ticket workflow

Faculty review, respond, update status, close per permissions. Student notified on meaningful updates. Maintain status-change/decision history.

---

## 14. Group-Swap Workflow

A mutual group-swap request, never a unilateral transfer. Requires the other student's consent **and** faculty approval.

### 14.1 Request form

Fields: requester's info (auto-populated), target group (from available groups), counterpart's seat number (required), counterpart's full name (optional, consistency check only). No unnecessary fields.

### 14.2 Validation

Backend validates: requester authenticated; requester belongs to exactly one active group; counterpart is a valid student; counterpart belongs to the target group; target group differs from requester's current group; valid reciprocal exchange possible; neither student already moved by a conflicting pending request; request not duplicated. Seat number is the primary identifier; full name is an additional check if supplied. Never allow self-swap.

### 14.3 Step 1 — Submit

Requester submits → system creates a pending request → notifies counterpart (identified by seat number) with request details. Counterpart can open and explicitly accept/reject.

### 14.4 Step 2 — Counterpart decision

**Reject:** no group change; mark rejected by counterpart; notify requester; record decision+timestamp; requester may submit a new request later.

**Accept:** record consent; notify requester it's moved to faculty review; send to faculty review queue; both students stay in their existing groups until faculty approval. Acceptance alone never changes group membership.

### 14.5 Step 3 — Faculty decision

Faculty inspects both students' identities/seat numbers, current groups, proposed exchange. Can approve, or reject with a **mandatory reason**.

**Reject:** keep original groups; record decision+reason; notify both students; show result+reason in ticket history (never the faculty member's identity); requester may create another request.

**Approve:** revalidate current memberships + pending-request state; exchange both students' groups **atomically in one DB transaction**; update both records, group assignments, future calendar visibility; record final decision + both approvals; notify both students. Never update one student's group if the other's update fails.

### 14.6 Notifications

At: request submitted to counterpart; counterpart accepts; counterpart rejects; faculty review begins; faculty approves; faculty rejects. Avoid duplicates on retries.

### 14.7 Group-swap audit log

Training Director sees: request ID, requester's name+seat, counterpart's name+seat, original group of each, proposed target group, counterpart's decision+identity, faculty decision+identity, rejection reason (if any), timestamps, final status. Separate from the student's ticket history. Rejected requests remain in history and don't block new requests.

---

## 15. Training Director Audit Logs

Mandatory, comprehensive — not a list of recent notifications.

### 15.1 Faculty activity tracking

Record: creating forms; creating/editing/cancelling/deleting visits; creating/modifying groups; importing spreadsheets; adding/editing/removing student info; changing attendance statuses/lateness; changing attendance settings; editing recurring schedules; processing tickets; accepting/rejecting group-swaps; approving/rejecting profile changes; exporting reports (for audit purposes); other meaningful CRUD/admin actions.

### 15.2 Audit log fields

Actor ID, actor's name+role at time of action, action type, affected resource type+ID, timestamp, relevant previous/new values, reason/comment (if given), outcome/failure status (if relevant). Attendance corrections: preserve previous status+lateness. Deletions: retain enough info to know what was deleted and by whom. Never store passwords, verification codes, session tokens, biometric key material, or other secrets in audit logs.

### 15.3 Audit log dashboard

Dedicated Training Director interface: searchable table; filter by faculty member, action type, resource type, date range, outcome; detailed per-event view; before/after comparisons; access to the affected record when still available. Students and ordinary faculty cannot access this interface unless explicitly authorized.

### 15.4 Audit log integrity

Append-only through normal workflows. Ordinary faculty cannot erase/rewrite their own history. Sensitive admin-access changes and audit-permission changes are themselves recorded. Use one shared audit service across the app, not disconnected per-module logging.

---

## 16. Data Model and Backend Requirements

Normalized relational model (Postgres via Prisma): appropriate foreign keys, indexes, uniqueness constraints, transactional operations.

Minimum entities: Users, Student profiles, Faculty profiles, Roles/permissions, Student groups, Group memberships, Training programs/settings, Recurring schedules, Schedule exceptions, Training visits, Visit-group associations, Visit documents/media, Attendance records (including captured geolocation + biometric-confirmation flag per check-in), Attendance timing configurations, Registered biometric devices/credentials, Notifications, Tickets, Ticket messages/status history, Group-swap requests, Group-swap decisions, Profile-change requests, Audit logs, Email-verification challenges, Password-recovery records.

Table design may vary; required relationships/behaviors must be preserved.

### 16.1 Integrity constraints

Unique seat numbers; appropriate uniqueness for university emails; one active group per student; one effective attendance record per student per visit; valid group assignments for attendance; valid group-swap state transitions; valid role/permission assignments; referential integrity for visit/attendance records; a biometric credential may only be registered to the account that enrolled it. Use transactions for multi-record operations.

### 16.2 Time handling

Store timestamps in UTC; display in `Africa/Cairo`. Attendance calculations use the scheduled visit time and its time zone — never the browser's clock. Backend is the authority on early/on-time/late/invalid.

### 16.3 File uploads

Validate size, type, authorization for spreadsheets/documents/images. Private storage (Supabase Storage private buckets) for files with student/admin info. Generate authorized signed access links rather than exposing storage objects publicly.

---

## 17. Security and Privacy

Backend/database-layer security. Required controls: secure password hashing; university-email verification; verification-code expiration + rate limiting (Redis); password-recovery protections; secure session/JWT management; authorization checks on every protected endpoint; input validation; protection against SQL injection and common web vulnerabilities; CSRF protection where applicable; safe file-upload handling; rate limiting on auth + attendance endpoints; duplicate-attendance prevention; protection against student-record enumeration; logging of security-sensitive actions; restriction of administrative exports; safe handling of private student data; safe handling of biometric credential metadata and captured geolocation data (never raw biometric samples — only public-key assertions per §4.5).

Never trust a role, student ID, group ID, attendance status, lateness value, biometric-confirmation flag, or geolocation reading submitted by the frontend without backend validation. Students must not modify attendance records by changing request parameters. Faculty must not bypass permissions via direct API calls. Super Admin and Training Director have distinct permission scopes despite both being extensive. Never expose secrets in client bundles, committed config, error messages, or audit records.

---

## 18. User Interface and Experience

Polished, responsive: desktop, tablet, mobile web.

### 18.1 Language

Arabic + English. Visible language switcher; correct RTL (Arabic) / LTR (English); localized navigation/forms/validation/notifications; consistent date/time/number formatting; Arabic-capable fonts; correct text direction in tables/dashboards. Language changes must not break form state, calendar functionality, or data relationships.

**Default language:** Arabic (`ar`) is the primary and default locale, with RTL layout on first load. English (`en`) is available via a persistent language switcher in the header. The selected language is stored in a cookie (and on the user profile once logged in) and applies across the UI, notifications, emails, and exports. Dates display in `Africa/Cairo`; use Western digits (0–9) consistently in both languages. `defaultLocale` in the `next-intl` config is `ar`.

### 18.2 Navigation

**Student:** Dashboard, Training Calendar, Attendance History, Notifications, Support Tickets, Profile (including biometric login management).
**Faculty:** Dashboard, Visits, Calendar, Groups, Attendance, Tickets, Group-Swap Requests, Settings.
**Training Director** adds: Training Schedule Configuration, Faculty Activity Logs, Training-Wide Reports, Administrative Review Queues.
**Super Admin:** necessary global management interfaces.

Hide unavailable controls in the frontend, but always enforce permissions on the backend.

### 18.3 Accessibility and usability

Clear status labels, readable tables, useful empty states, loading indicators, confirmation dialogs for destructive actions, actionable error messages. Field-level validation errors. Never silently discard changes or show success on a failed backend operation. Prioritize clarity and reliability over visual complexity.

### 18.4 Branding assets

Web favicon/site icon and the future Android app icon are both derived from `https://files.catbox.moe/dz8ax8.png` (see §2, "App icons and branding"). Keep them in sync if the source image is ever replaced.

---

## 19. Reporting and Data Export

Filter attendance reports by: visit, date, group, student, status. Exports include only records the current user is authorized to access.

Formats: PDF (printable), XLSX (structured), CSV (general exchange). Exported figures must match the application. Test date formatting, Arabic text rendering, spreadsheet encoding, missing values, large datasets. Export process must not bypass normal access restrictions.

---

## 20. Testing and Acceptance Criteria

Automated tests alongside features (Jest for NestJS, Vitest for frontend units, Playwright for e2e). A phase is not complete merely because the UI renders.

### 20.1 Authentication tests

Successful signup+verification; linking to existing imported record; duplicate-record prevention; first-time password creation; email/password login; seat-number/password login; rejection of seat-number login without a password; password recovery; verification-code expiration/abuse protection; rejection of unauthorized access; enabling biometric login requires prior authentication; biometric login succeeds only with a valid registered device assertion; revoking a biometric device immediately prevents further biometric logins from it; password/OTP login still works after biometrics are enabled.

### 20.2 Attendance tests

For a 10:00 AM visit: 9:44 AM rejected (not open); 9:45 AM Present; 10:00 AM Present; 10:15 AM Present; 10:16 AM Late (1 min); 11:00 AM Late (45 min); after 11:00 AM rejected; no check-in by closing → Absent.

Also verify: duplicate scans don't duplicate records; unassigned students can't check in; cancelled visits reject check-ins; manual corrections stay intact; automatic absence processing is idempotent; per-visit overrides work; default changes don't silently alter existing visit configs; time-zone boundaries handled correctly; check-in without the required biometric confirmation is rejected per the configured policy; check-in without a submitted geolocation reading is rejected per the configured policy; captured geolocation is stored and visible to faculty on the attendance record.

### 20.3 Calendar tests

Visits appear for selected groups only; multi-group visits work; students get relevant notifications; reschedule/cancel handled correctly; recurring schedules + exceptions work as intended.

### 20.4 Group-swap tests

Full workflow A→B request, notification, accept/reject, rejection leaves groups unchanged, acceptance → faculty review, faculty rejection requires reason and leaves groups unchanged, faculty approval exchanges groups atomically, both students notified correctly, conflicting pending requests can't create invalid memberships, students can't see the deciding faculty member's identity, Training Director can inspect full history, requester can resubmit after rejection.

### 20.5 Audit log tests

Faculty CRUD recorded; attendance corrections preserve before/after; group-swap decisions identify responsible parties; Training Director can filter/inspect; students can't access admin logs; normal workflows can't erase audit records; no credentials or biometric key material ever recorded.

### 20.6 Export tests

PDF/XLSX/CSV match underlying records. Include Arabic names, seat numbers, lateness values, missing optional fields, multiple groups.

### 20.7 Permission tests

Every protected operation tested against every relevant role. Verify hiding a button is not the only protection.

---

## 21. Ordered Implementation Phases

Execute **one phase per prompt/session**, in order — do not one-shot multiple phases from a single instruction, even though all phases are documented together here for reference. Each phase is handed to you as its own separate prompt when it's time to build it. Do not skip foundational dependencies. Verify each phase's Definition of Done with real output before considering that phase's session finished.

### Phase 0 — Environment & Monorepo Scaffolding

Deliver:
- Turborepo monorepo (`apps/web`, `apps/api`, `apps/mobile` reserved/empty for a future Tauri app, `packages/core`).
- NestJS app skeleton on `apps/api`, Next.js app skeleton on `apps/web`.
- Prisma initialized against Supabase Postgres, initial empty migration.
- `.env.example` fully documented per §2, no real secrets.
- Supabase Storage bucket(s) created (private) and wired.
- Upstash Redis client wired in `apps/api`.
- Nodemailer configured against Gmail SMTP with the documented env vars (not yet sending real mail if credentials aren't supplied — stub/log instead, but keep the real implementation path ready).
- Favicon/site icon asset pipeline wired from the source image in §2 ("App icons and branding").
- Base CI: lint, typecheck, build, test scripts at the monorepo root (Turborepo pipeline).
- README with setup instructions.

**Definition of Done:** `pnpm/npm/yarn install && turbo build` succeeds; `apps/api` boots and responds to a health-check route; `apps/web` boots and renders a placeholder page with the correct favicon; Prisma can connect to the Supabase DB and run a migration.

### Phase 1 — Foundation

Deliver: database schema + migrations for core entities (§16); authentication + session/JWT management; role and permission system enforced server-side; student and faculty profile models; Arabic/English i18n foundations (`next-intl` wired, RTL/LTR layout switch); initial role-aware dashboards and navigation shells; Super Admin seed script (§2).

**Definition of Done:** Users can authenticate through the implemented flows; role restrictions are enforced by the backend (tested, not just hidden in UI); database structure is tested; Super Admin can log in with the generated password and is forced to change it.

### Phase 2 — Student Records and Groups

Deliver: Excel import + validation (preview, duplicate detection, error reporting, safe updates) with a downloadable template; student record management; account linking + profile loading (§4.2 Case A/B); student groups + membership management with one-group enforcement at DB level; profile-change request workflow; relevant audit log entries.

**Definition of Done:** Faculty can import valid student records; students can link accounts to existing records without duplication; group membership constraints are enforced at the database level (verified with a test that attempts to violate it).

### Phase 3 — Scheduling and Calendar

Deliver: training program settings; recurring schedules; group-specific scheduling; visit creation/editing with multi-group select; visit locations/attachments (Supabase Storage); calendar views (student + faculty); schedule exceptions; relevant notifications (§6.4, §12).

**Definition of Done:** Faculty can create visits for one or multiple groups; only affected students receive the correct calendar entries and notifications (verified with a test covering an unselected group).

### Phase 4 — QR Attendance, Biometrics, and Reporting

Deliver: visit-details QR codes; stable, HMAC-signed attendance QR codes; secure attendance validation (§7.2, §8.5); biometric login enrollment/management (§4.5); biometric + geolocation confirmation integrated into the attendance check-in flow (§7.2); automatic attendance classification; automatic absence processing via `pg_cron`/`pg_net`; faculty attendance corrections; student attendance dashboards; faculty attendance tables (including geolocation display); PDF/XLSX/CSV exports.

**Definition of Done:** The complete attendance workflow works against the real database and passes every timing-boundary test in §20.2 (including the biometric/geolocation checks and the idempotency test for automatic absence processing); biometric login enrollment, use, and revocation pass the relevant cases in §20.1.

### Phase 5 — Tickets and Group Swaps

Deliver: ticket categories, creation, history, filtering; faculty review tools; mutual group-swap requests with counterpart consent; faculty approval/rejection; atomic group exchange; request notifications; detailed group-swap audit records (§13, §14).

**Definition of Done:** Every group-swap outcome follows the required approval sequence and preserves group integrity — verified against all 13 cases in §20.4.

### Phase 6 — Training Director and Audit Logs

Deliver: Training Director dashboard; training-wide settings; faculty activity history; create/update/delete audit events with before/after comparisons; search/filtering; administrative decision history; permission-restricted reports (§15).

**Definition of Done:** The Training Director can inspect who performed each relevant faculty operation and review the full group-swap decision history — verified against §20.5.

### Phase 7 — Security, Accessibility, and Final Verification

Deliver: security review against §17 (including biometric/geolocation data handling); permission/privacy testing (§20.7); responsive-layout checks; Arabic/English verification including RTL; export validation (§20.6); error handling review; production build on Vercel (web + api); deployment documentation; environment-variable documentation (no fabricated credentials); backup/recovery recommendations; confirmation that the app icon/favicon assets are correctly wired for web and ready for the future Tauri Android build.

**Definition of Done:** All required features work together, tests have actual recorded results, and remaining limitations are documented honestly.

---

## 22. Final Delivery Requirements

At completion, provide:
1. Implemented application source code (monorepo).
2. Database migrations and schema documentation.
3. Authentication and permission documentation (including biometric login).
4. Documented explanation of attendance/lateness rules, including the biometric+geolocation check-in requirement.
5. Setup and local-development instructions.
6. Environment-variable documentation (§2), no fabricated credentials.
7. Test commands and actual test results.
8. Build and deployment instructions (Vercel + Supabase + Upstash).
9. Summary of completed features.
10. List of unresolved issues/limitations, if any.

Do not claim production-readiness if critical security checks, tests, migrations, or deployment steps remain incomplete. Do not mark a feature complete when it's only a static interface.

---

## 23. Final Instruction

Work through this project **one phase per prompt**, never as a single one-shot session covering multiple phases. When given a phase to build, scaffold/implement only that phase, verifying its Definition of Done with real, observed results before that session ends — the next phase will be assigned separately.

Use this document as the source of truth. Preserve: the four-role distinction; the hard-committed stack in §2 (including Tauri as the future mobile framework); the stable printed QR-code requirement; the attendance timing rules; the biometric-login and biometric+geolocation check-in requirements (§4.5, §7.2); the branding/icon source (§2, §18.4); mutual group-swap consent + faculty approval; student-facing privacy around who made swap/ticket decisions; the Training Director's comprehensive audit visibility; and the Africa/Cairo time zone as the display default.

When a genuine ambiguity blocks safe implementation, explain the specific issue and ask one focused question. Otherwise, make the reasonable technical decision, document it, and continue.

**The final result must be a working Field Training Management System for the Faculty of Agriculture, Ain Shams University — not a prototype or a collection of disconnected pages.**
