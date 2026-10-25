# Operations: backups, recovery, retention, secrets

Recommendations for running FTMS in production. They describe what to configure in
Supabase, Vercel and Upstash and what the institution should decide; nothing here has
been exercised against the real services (no credentials were available).

## What holds state

| Store             | Contents                                                                                      | Loss impact                                      |
| ----------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Supabase Postgres | Everything that matters: accounts, records, groups, visits, attendance, tickets, swaps, audit | Critical                                         |
| Supabase Storage  | Visit photos and documents, ticket attachments, uploaded import spreadsheets                  | Moderate (records survive; files are supporting) |
| Upstash Redis     | Rate-limit counters only                                                                      | None (counters restart; nothing to back up)      |
| Vercel            | Built code and environment variables                                                          | Rebuildable from Git; variables must be recorded |
| Password manager  | The five signing secrets, the Gmail App Password, service keys                                | `QR_HMAC_SECRET` loss = reprint every QR code    |

## Backups

- **Database:** use a Supabase plan with daily backups, and enable **Point-in-Time
  Recovery** (PITR) for the training period — attendance is recorded minute by minute and
  daily snapshots would lose a day of check-ins. Keep at least 7 days.
- **Independent copy:** weekly (and before every migration), from a trusted machine:

  ```bash
  pg_dump "$DIRECT_URL" --format=custom --no-owner --file="ftms-$(date +%F).dump"
  ```

  Store it encrypted outside Supabase (the university's storage), keep 8 weekly and 12
  monthly copies, and restrict access: it contains personal data and the audit log.

- **Storage:** Supabase backups do not include Storage objects. Copy the four buckets
  weekly with the Supabase CLI or S3-compatible tooling, or accept that photos and
  attachments are best-effort (the records that reference them are in the database).
- **Configuration:** keep an up-to-date list of every Vercel environment variable (names
  in [environment.md](environment.md); values in the password manager).

## Recovery

| Situation                       | Action                                                                                                                                                                                                      |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bad deployment                  | Vercel → Promote the previous deployment (web and API).                                                                                                                                                     |
| Data damaged by a person or bug | PITR to a **new** Supabase project at the moment before the damage; copy the affected rows back with SQL, or switch `DATABASE_URL`/`DIRECT_URL` to the restored project if the whole database must go back. |
| Database lost                   | Restore the latest backup/PITR into a new project; `pnpm db:deploy` (applies nothing if current); run `cron:install` again; update the URLs on the API project; redeploy; smoke test.                       |
| Restore from a `pg_dump` file   | `pg_restore --no-owner --dbname="$DIRECT_URL" ftms-YYYY-MM-DD.dump` into an empty database created from the same migrations, then the steps above.                                                          |
| Storage lost                    | Recreate buckets with `pnpm storage:provision`; copy objects back from the weekly copy. Missing files show as unavailable; records are unaffected.                                                          |
| Redis lost                      | Nothing to restore: create a new database and update the two Upstash variables.                                                                                                                             |
| Super Admin locked out          | `pnpm db:seed -- --reset-password` from a trusted machine (new one-time password, sessions revoked).                                                                                                        |

Test a restore at least once before the training period starts (restore to a scratch
project, run the API against it, run `pnpm smoke`).

The audit log is append-only by trigger. A point-in-time restore is the only way to go
back; never disable the trigger to "fix" the log.

## Data retention

Personal data should be kept only as long as the faculty needs it. Proposed policy (to be
approved by the faculty; nothing is deleted automatically today):

| Data                                                                 | Proposal                                                                                                                                                                                                                  |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Check-in location readings (latitude, longitude, accuracy, distance) | Clear 90 days after the program ends (the attendance record itself stays).                                                                                                                                                |
| Expired email codes (`auth_challenges`)                              | Delete 7 days after expiry.                                                                                                                                                                                               |
| Ended sessions (`auth_sessions`)                                     | Delete 90 days after expiry or revocation.                                                                                                                                                                                |
| Expired WebAuthn challenges                                          | Already deleted automatically after a day.                                                                                                                                                                                |
| Uploaded import spreadsheets                                         | Delete 1 year after upload (the imported records stay).                                                                                                                                                                   |
| Attendance, tickets, swaps, groups                                   | Keep per the faculty's academic-records policy.                                                                                                                                                                           |
| Audit log                                                            | Keep at least for the academic year plus the appeal period; archive older years to an encrypted export before any removal (removal requires a deliberate, documented database change because of the append-only trigger). |

Example cleanup (run from a trusted machine or as a `pg_cron` job once approved):

```sql
-- Location readings of a program that ended at least 90 days ago.
update attendance_records ar
   set latitude = null, longitude = null, accuracy_meters = null, distance_meters = null
  from training_visits v
 where ar.visit_id = v.id and v.program_id = '<program id>';
delete from auth_challenges where expires_at < now() - interval '7 days';
delete from auth_sessions where coalesce(revoked_at, expires_at) < now() - interval '90 days';
```

These statements were dry-run in a rolled-back transaction against a local test database
in Phase 7. The database's checks require the four location columns to be cleared
together, as here; see [database.md](database.md) for the tables.

## Rotating secrets

Rotate on a schedule (yearly), when someone with access leaves, and immediately on any
suspicion of exposure. Change the value in Vercel, redeploy the project(s), then:

| Secret                      | Effect of rotating                                                                            |
| --------------------------- | --------------------------------------------------------------------------------------------- |
| `JWT_ACCESS_SECRET`         | Access tokens already issued stop working; people may have to sign in again.                  |
| `JWT_REFRESH_SECRET`        | Every session ends; everyone signs in again.                                                  |
| `BFF_SHARED_SECRET`         | Set the same new value on both projects, then redeploy both.                                  |
| `CRON_SECRET`               | Run `cron:install` again with the new value (it updates Vault).                               |
| `QR_HMAC_SECRET`            | **Every printed attendance QR code becomes invalid**; reprint them. Rotate only if it leaked. |
| `SUPABASE_SERVICE_ROLE_KEY` | Roll the key in Supabase first, then update the API.                                          |
| `UPSTASH_REDIS_REST_TOKEN`  | Reset the token in Upstash, then update the API.                                              |
| `SMTP_PASS`                 | Revoke the App Password in the Google account, create a new one, update the API.              |
| Database password           | Reset it in Supabase, update `DATABASE_URL` (and `DIRECT_URL` where kept).                    |

## Monitoring

- Point an uptime monitor at `GET <api>/health/ready` (200 when every dependency is up;
  503 otherwise — details are in the API's logs, never in the response).
- Watch Vercel function logs for `ERROR` lines (`ApiExceptionFilter`, `RateLimiter`
  "Redis unavailable", readiness probe failures) and for 503 responses.
- Review the audit log's failed sign-ins and the "Faculty activity" page regularly.

## Incident response (outline)

1. Contain: rotate the exposed secret(s) (table above); suspend affected accounts
   (`/admin/users`); revoke biometric devices if relevant (their sessions end).
2. Assess: the audit log records who did what, from which IP and browser; Vercel logs
   hold request logs; Supabase logs hold database access.
3. Recover: restore data if needed (above).
4. Notify the faculty administration and, where personal data was exposed, follow the
   university's data-protection procedure.
