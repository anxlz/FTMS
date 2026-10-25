# Attendance and lateness rules

How a check-in becomes Present, Late or refused, how absences are recorded, what the
location policy is, and how guest attendance works (§7, §8, §9, §10, revised in Phase 8). Shared rules live in
`packages/core/src/attendance/` (pure functions, unit-tested); the API applies them with
the server's clock (`apps/api/src/attendance/`).

## Timing settings

Every visit carries three numbers, in minutes:

| Setting                           | Meaning                                       | Suggested default |
| --------------------------------- | --------------------------------------------- | ----------------- |
| `checkInOpensMinutes` (_opens_)   | How long before the start check-in opens      | 15                |
| `graceMinutes` (_grace_)          | How long after the start a student is on time | 15                |
| `checkInClosesMinutes` (_closes_) | How long after the start check-in closes      | 60                |

The Training Director sets the training-wide defaults with the program (`/schedule`,
permission `attendance.settings.defaults`). The settings form only _suggests_ 15/15/60,
12 weeks and 2 allowed absences; nothing in the code assumes them. A visit **copies** the
defaults when it is created; holders of `attendance.settings.visit` can override them for
one visit. Changing the defaults never changes existing visits. Once check-in has opened,
a visit's date, time, groups and timing are locked.

## Classification (§8.2)

Minutes are whole minutes since the scheduled start, seconds discarded:

```
m = ⌊(check-in time − scheduled start) / 1 minute⌋
```

| Condition                   | Result                              |
| --------------------------- | ----------------------------------- |
| `m < −opens`                | Refused: check-in has not opened    |
| `−opens ≤ m ≤ grace`        | **Present**, 0 minutes late         |
| `grace < m ≤ closes`        | **Late**, `m − grace` minutes late  |
| `m > closes`                | Refused: check-in has closed        |
| No check-in by closing time | **Absent** (recorded automatically) |

For a 10:00 visit with 15/15/60 (the §20.2 cases, all covered by tests):

| Check-in time | m   | Result                        |
| ------------- | --- | ----------------------------- |
| 09:44:59      | −16 | refused (not open)            |
| 09:45:00      | −15 | Present                       |
| 10:00:00      | 0   | Present                       |
| 10:15:59      | 15  | Present (last on-time minute) |
| 10:16:00      | 16  | Late, 1 minute                |
| 11:00:59      | 60  | Late, 45 minutes              |
| 11:01:00      | 61  | refused (closed)              |
| none          | —   | Absent                        |

Times are entered and shown in **Africa/Cairo**; the database stores UTC instants derived
from the Cairo date and time (daylight saving included), and the server's clock decides —
never the browser's.

## QR codes (§7)

Each visit has two printable codes (`/visits/<id>/qr`):

- **Details code** → `/visits/<id>` (sign-in required; only members of the visit's
  groups and staff can open it).
- **Attendance code** → `/check-in/<token>`. The token is the visit id plus an
  HMAC-SHA256 tag keyed by `QR_HMAC_SECRET`: stable for the whole visit (one printout
  serves every session), impossible to forge for another visit, and free of personal
  data. The code grants nothing by itself.

## Check-in (§7.2, §8.5, revised in Phase 8)

A scanned link opens `/check-in/<token>`. Signed out, the page offers **Log In** and
**Continue as Guest** (below). A signed-in student checks in with one button: the device
location is read, then sent with the token. **Biometrics are never part of attendance**:
no biometric enrollment, prompt or confirmation is asked for, whether or not the student
turned on biometric login (a sign-in convenience only, see
[authentication.md](authentication.md#biometric-login-optional)).

The API checks, in this order, and refuses with a specific reason at the first failure:

1. a valid attendance token;
2. an active, verified **student** account;
3. a member of one of the visit's groups (at the time of the check-in);
4. a visit that is not cancelled;
5. no existing record for this student and visit;
6. the server time inside the window (classification above);
7. a **location reading**, checked against the program's location policy (below).

Only then is one record created (`source = QR`) with the status, minutes late, check-in
time and the location. The database's unique key (visit, student) turns a concurrent
duplicate into "already recorded". Values sent by the browser — status, minutes, flags,
group — are ignored. Check-ins are rate-limited (20 attempts per 10 minutes per student).
Records made before Phase 8 keep their historical `biometric_verified` value; nothing new
sets it.

### Location policy

Every check-in — signed in or guest — must send a current reading (latitude, longitude,
accuracy). The Training Director may limit it (`/schedule` → program defaults; empty
means no limit):

| Setting             | Column                         | Range (m)  | Refusal                                                 |
| ------------------- | ------------------------------ | ---------- | ------------------------------------------------------- |
| _(always)_          | —                              | —          | no reading → `GEOLOCATION_REQUIRED` (400)               |
| `maxAccuracyMeters` | `location_max_accuracy_meters` | 5–10,000   | accuracy missing or worse → `LOCATION_INACCURATE` (422) |
| `radiusMeters`      | `location_radius_meters`       | 10–100,000 | farther from the visit → `LOCATION_OUTSIDE_AREA` (422)  |

The radius applies only to visits that have coordinates; the settings form suggests 500 m
and 100 m. The distance is computed on the server (haversine) and stored with the record.
The device explains each failure in the user's language: permission denied (with a link
to the app settings in the Android app), location unavailable, poor accuracy, outside the
area. Readings are shown to staff with `attendance.read` on the visit's attendance page;
the audit log notes only that a reading was sent and its distance — never the
coordinates; exports do not include them.

A location reading is **supporting evidence, not proof of presence**: it comes from the
device and can be spoofed by a determined user. See
[security-review.md](security-review.md#geolocation-readings-72-103).

## Guest attendance (Phase 8)

**Continue as Guest** records attendance with no login, account, password, emailed code,
biometrics or identity check — a deliberate policy. The guest scans the visit's attendance
QR code (camera in the Android app, or the phone's camera / a pasted link in a browser),
types a **full name** and **seat number**, and submits; the device location is read and
sent with it. `POST /attendance/guest/context` and `POST /attendance/guest/check-in` are
public endpoints.

The server enforces what it can: the token, that the visit is not cancelled, the window
(server clock, same classification), the form (name 3–200 letters, seat-number format),
the location policy, and abuse limits (300 context reads and 120 submissions per 10
minutes per IP address). Each form load carries a random `submissionKey`; a retried
request with the same key returns the first answer instead of a second submission.

Every submission is stored in `guest_check_ins` exactly as typed, with its status, time,
location and the result of a record-keeping match on the seat number:

| Seat number typed                                     | Result      | Effect                                                                                   |
| ----------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------- |
| a current member of the visit's groups with no record | `RECORDED`  | an attendance record for that student, `source = GUEST`; the student is notified at once |
| a member who already has a record                     | `DUPLICATE` | nothing changes; the existing record stands                                              |
| anything else (unknown, not in the visit's groups)    | `UNMATCHED` | kept for staff review only; listed in exports as "Guest form (no matching student)"      |

The guest always gets the same kind of answer — a receipt with the submission's status,
time and a reference — never whether a seat number exists, whom it belongs to or whether
that student already has a record. Guests see no other data. Staff see every submission
on the visit's attendance page (typed name and seat, result, matched student, whether the
typed name matches the record), can correct the resulting record like any other, and the
audit log records each submission (`attendance.guest_submitted`, without the typed name
or seat number).

> **Limitation, by design.** Guest attendance accepts manually entered identity fields
> without verifying them. A person at the permitted location may enter the same name or
> seat number as another student. Geolocation and QR validation do not establish the
> user's identity. This limitation is intentional and must not be addressed by adding
> mandatory identity verification. See [limitations.md](limitations.md).

## Automatic absences (§8.3)

When a visit's window closes, every **current** member of its groups without a record
gets an `ABSENT` record (`source = AUTOMATIC`, no time). Records are only inserted
(`ON CONFLICT DO NOTHING` on the one-record-per-student key), so repeated or overlapping
runs add nothing and never overwrite a check-in or a correction. Cancelled visits are
skipped; rescheduled visits close at their new time. It runs from Supabase `pg_cron`
every 5 minutes (`POST /internal/attendance/process-absences` with the `CRON_SECRET`
key), and the attendance pages, dashboards, reports and exports finalize a closed visit
themselves, so figures never wait for the scheduler.

## Corrections (§8.4)

Holders of `attendance.correct` set Present, Late (with minutes) or Absent, with an
optional reason, once check-in has opened. The record becomes a manual correction
(`source = MANUAL`) with who and when; the audit log keeps every previous state; the
student is notified and sees the reason but not who corrected it. Absence processing
never touches a corrected record.

## Totals and standing (§9)

Over the finalized records of visits that took place (cancelled visits never count):

- attended = present + late; present; late; absent; total minutes late;
- **remaining absences = max(0, allowed − absent)**, where _allowed_ is the program's
  configured allowance;
- standing: within the limit, at the limit (absences equal a non-zero allowance), or
  over the limit.

Students see their own totals and history (`/attendance`); staff see training-wide,
per-group and per-visit figures; the attendance-standing report and the exports use the
same rules, so every screen and file shows the same numbers.

## Exports (§10.4, §19)

CSV (UTF-8 with BOM, formula-safe), XLSX (right-to-left for Arabic, frozen header,
filters, numbers as numbers) and PDF (IBM Plex Sans Arabic embedded, landscape,
right-to-left for Arabic), built from one query so files match the screens. The source
column distinguishes QR check-ins, guest-form records and corrections; unmatched guest
submissions are listed after the groups when no group or student filter is set. Filters:
visit, date range, group, student, status. Limits: 10,000 rows (3,000 for PDF); 30
downloads per 15 minutes per account. Requires `attendance.read` and `reports.export`;
each export is audited. Verified against the underlying records, including Arabic names,
seat numbers, lateness, missing optional values and multiple groups, in all three formats
([testing.md](testing.md)).
