# Attendance and lateness rules

How a check-in becomes Present, Late or refused, how absences are recorded, and what the
biometric and location requirements are (§7, §8, §9, §10). Shared rules live in
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

## Check-in (§7.2, §8.5)

A scanned link sends a signed-out student through sign-in and back. The API then checks,
in this order, and refuses with a specific reason at the first failure:

1. a valid attendance token;
2. an active, verified **student** account;
3. a member of one of the visit's groups (at the time of the check-in);
4. a visit that is not cancelled;
5. no existing record for this student and visit;
6. the server time inside the window (classification above);
7. the **location reading**, when required (below);
8. the **biometric confirmation**, when required (below): a fresh WebAuthn assertion
   answering a single-use challenge bound to this student **and this visit** (5 minutes;
   a sign-in session never counts).

Only then is one record created (`source = QR`) with the status, minutes late, check-in
time, whether it was biometrically confirmed, the credential used, and the location.
The database's unique key (visit, student) turns a concurrent duplicate into "already
recorded". Values sent by the browser — status, minutes, flags, group — are ignored.
Check-ins are rate-limited (20 attempts per 10 minutes per student).

### Biometric and location requirements

| Student                                | Policy (`/settings`, Training Director) | Biometric                      | Location                   |
| -------------------------------------- | --------------------------------------- | ------------------------------ | -------------------------- |
| Has enrolled a device                  | always                                  | **Required** (fresh assertion) | **Required**               |
| No device; fallback _allow_            | `biometricFallback = ALLOW_UNVERIFIED`  | not possible                   | per `geolocation` policy   |
| No device; fallback _require_          | `biometricFallback = REQUIRE_BIOMETRIC` | refused until enrolled         | —                          |
| Fallback check-in, location _required_ | `geolocation = REQUIRED`                | —                              | Required                   |
| Fallback check-in, location _optional_ | `geolocation = OPTIONAL`                | —                              | Sent if the browser allows |

A fallback record is marked **"not confirmed with biometrics"** for faculty review.

**Location:** latitude, longitude and accuracy from the browser's Geolocation API, sent
once with the check-in; when the visit has coordinates, the distance to them is computed
on the server. Stored with the record and shown to staff with `attendance.read` on the
visit's attendance page. It is supporting context, **not proof of presence**: a reading
far from the visit does not refuse the check-in, and a determined student can spoof it.
The audit log notes only that a reading was sent and its distance from the visit — never
the coordinates; exports do not include it. See
[security-review.md](security-review.md#geolocation-readings-72-103).

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
right-to-left for Arabic), built from one query so files match the screens. Filters:
visit, date range, group, student, status. Limits: 10,000 rows (3,000 for PDF); 30
downloads per 15 minutes per account. Requires `attendance.read` and `reports.export`;
each export is audited. Verified against the underlying records, including Arabic names,
seat numbers, lateness, missing optional values and multiple groups, in all three formats
([testing.md](testing.md)).
