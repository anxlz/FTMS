# Unresolved issues and limitations

What is not done, not verified, or limited by design at the end of Phase 8. Nothing here
blocks local use; the first section must be closed before calling the system
production-ready.

## Not verified — needs the institution's accounts (no credentials were invented)

| Item                                   | What is missing                                                                                                                                                                          | How to close it                                                                                                                            |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Real deployment                        | Both Vercel projects were built with the Vercel CLI and the API function was run locally, but nothing was deployed.                                                                      | [deployment.md](deployment.md) steps 1–9.                                                                                                  |
| Supabase                               | Migrations were applied only to local PostgreSQL 16 databases; pooler connections, Storage and Vault never used.                                                                         | Deployment steps 1, 6–8; `GET /health/ready` must report `up`.                                                                             |
| Upstash Redis                          | Exercised only against a stubbed REST API and the in-memory limiter.                                                                                                                     | Readiness check; a few failed sign-ins return 429.                                                                                         |
| Gmail SMTP                             | No App Password; emails were written to the log in tests.                                                                                                                                | `pnpm --filter @ftms/api mail:verify`, then a real code email.                                                                             |
| `pg_cron` absence job                  | The endpoint and its key are tested; the Supabase job itself is not.                                                                                                                     | `cron:install`, then watch a visit close.                                                                                                  |
| Biometrics and location on real phones | Tested with Chromium's virtual authenticator and a fixed geolocation.                                                                                                                    | Smoke checklist items 3–4 on Android and iOS phones over HTTPS.                                                                            |
| Android APK/AAB                        | **Not built.** No Android SDK/NDK, Android Rust targets or Google Maven access here (see [mobile.md](mobile.md#build-status-in-this-environment)). The Kotlin plugin was never compiled. | `pnpm --filter @ftms/mobile android:init`, then `android:build` on a machine with the SDK; the device checklist in [mobile.md](mobile.md). |
| The app on a physical Android phone    | Not run. Camera scanning, the location permission flow and Keystore biometric login are untested on hardware.                                                                            | [mobile.md](mobile.md#device-checklist) on at least two phones.                                                                            |
| GitHub repository and Actions run      | No repository URL was provided; the workflow was not run on GitHub.                                                                                                                      | Push to the repository; the CI workflow must pass.                                                                                         |
| Student email domain                   | `agr.asu.edu.eg` is the default, awaiting the faculty's confirmation.                                                                                                                    | Set `UNIVERSITY_EMAIL_DOMAINS` if different.                                                                                               |

## Known limitations

**Guest attendance (Phase 8) — identity is not verified, by design**

- Guest attendance accepts manually entered identity fields without verifying them. A
  person at the permitted location may enter the same name or seat number as another
  student. Geolocation and QR validation do not establish the user's identity. This
  limitation is intentional and must not be addressed by adding mandatory identity
  verification.
- What exists instead: the matched student is notified at once; staff see every guest
  submission as typed, with the matched student and whether the typed name matches the
  record, and can correct any record; a guest submission never overwrites an existing
  record; per-IP rate limits apply.
- A guest receipt does not say whether the seat number matched a student — by design, so
  the form cannot be used to look up students.

**Attendance and biometrics**

- Biometric login is optional and for signing in only; attendance never uses it.
- WebAuthn passkeys need HTTPS (or `localhost`) and the phone's main browser; in the
  Android app, biometric login uses the app's Keystore key instead.
- A synced passkey is one credential across its owner's devices (shown as "Synced
  passkey"). An Android app key belongs to one phone and stops working after a new
  fingerprint or face is enrolled on it (turn biometric login on again).
- Location readings can be spoofed by a determined user; the radius and accuracy limits
  are checks on the reported reading, not proof of presence.
- Attendance needs a connection: nothing is queued offline (deliberately — no sensitive
  submissions are stored unprotected on the device).
- Students without an account (imported, never signed in) can be recorded by a correction
  or through the guest form; there is no advance "excused absence" before a visit opens.

**Reports and exports**

- PDF exports draw Arabic correctly, but the PDF's text layer stores shaped glyphs:
  **copying or searching Arabic text inside a PDF can give letters out of order or split
  words**. Use the CSV or XLSX export for data; the PDF is for printing and reading.
- PDFs take about 13 s at the 3,000-row cap (the API function allows 30 s, the web relay
  60 s). Since Phase 8 no export has a biometric column (attendance no longer uses
  biometrics); unmatched guest submissions appear as "Guest form (no matching student)".
- Exports never include location readings (by design).
- Activity-log search covers the actor's name, the action, the record id and the reason —
  not the before/after values. Exported log files carry stable action identifiers with a
  translated category.
- The standing report covers the current program only.

**Data and operations**

- No automatic retention: location readings, ended sessions, expired codes and the
  audit log are kept until the faculty adopts a policy
  ([operations.md](operations.md#data-retention)).
- Supabase backups do not cover Storage files; a separate copy is recommended.
- Uploads pass through the web server and are limited to 4 MB per request (Vercel's
  request-body limit).

**Features (by design or scope)**

- Student import accepts `.xlsx` only; the preview lists the first 300 rows of each
  filter (counts cover the whole file).
- Changing the program's dates does not move existing schedules or visits; groups created
  after a schedule are not added to it; the calendar shows one month at a time (requests
  up to 100 days).
- Visit and schedule notifications are in-app only (email is used for codes and account
  decisions).
- A group can be archived only when empty.
- A swap is always between two students; there is no one-way transfer request (staff can
  move a student from the group page). Tickets are not assigned to a particular staff
  member; attachments cannot be removed once posted.

**Quality checks**

- Accessibility is checked automatically (axe-core, WCAG 2.1 A/AA, every page, both
  languages, three widths: no violations of any impact). No manual screen-reader audit
  was done.
- Browser tests run in Chromium only (desktop engine at phone, tablet and desktop
  widths); Safari/WebKit and Firefox were not automated.
- `style-src 'unsafe-inline'` remains in the Content-Security-Policy (React style
  attributes); scripts are nonce-only.

**Platform**

- The Android app (`apps/mobile`, Tauri 2) loads the deployed web app; it needs the web
  app online. Its source, configuration and tests are complete, but no APK/AAB was built
  here (see above). iOS is not targeted.
- Prisma is deliberately pinned to 7.10.1 until 8.0 is stable.
