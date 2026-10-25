# Unresolved issues and limitations

What is not done, not verified, or limited by design at the end of Phase 7. Nothing here
blocks local use; the first section must be closed before calling the system
production-ready.

## Not verified — needs the institution's accounts (no credentials were invented)

| Item                                   | What is missing                                                                                                     | How to close it                                                 |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Real deployment                        | Both Vercel projects were built with the Vercel CLI and the API function was run locally, but nothing was deployed. | [deployment.md](deployment.md) steps 1–9.                       |
| Supabase                               | Migrations were applied only to local PostgreSQL 16 databases; pooler connections, Storage and Vault never used.    | Deployment steps 1, 6–8; `GET /health/ready` must report `up`.  |
| Upstash Redis                          | Exercised only against a stubbed REST API and the in-memory limiter.                                                | Readiness check; a few failed sign-ins return 429.              |
| Gmail SMTP                             | No App Password; emails were written to the log in tests.                                                           | `pnpm --filter @ftms/api mail:verify`, then a real code email.  |
| `pg_cron` absence job                  | The endpoint and its key are tested; the Supabase job itself is not.                                                | `cron:install`, then watch a visit close.                       |
| Biometrics and location on real phones | Tested with Chromium's virtual authenticator and a fixed geolocation.                                               | Smoke checklist items 3–4 on Android and iOS phones over HTTPS. |
| GitHub repository and Actions run      | No repository URL was provided; the workflow was not run on GitHub.                                                 | Push to the repository; the CI workflow must pass.              |
| Student email domain                   | `agr.asu.edu.eg` is the default, awaiting the faculty's confirmation.                                               | Set `UNIVERSITY_EMAIL_DOMAINS` if different.                    |

## Known limitations

**Attendance and biometrics**

- WebAuthn needs HTTPS (or `localhost`) and the phone's main browser; some in-app
  browsers (QR scanner views) do not support it — the check-in page says so.
- A synced passkey is one credential across its owner's devices (shown as "Synced
  passkey").
- Location readings can be spoofed by a determined student; they are supporting context,
  not proof (the biometric assertion and the time window are the binding checks).
- Students without an account (imported, never signed in) can only be recorded by a
  correction; there is no advance "excused absence" before a visit opens.

**Reports and exports**

- PDF exports draw Arabic correctly, but the PDF's text layer stores shaped glyphs:
  **copying or searching Arabic text inside a PDF can give letters out of order or split
  words**. Use the CSV or XLSX export for data; the PDF is for printing and reading.
- PDFs take about 13 s at the 3,000-row cap (the API function allows 30 s, the web relay
  60 s). The attendance PDF omits the biometric column for width; CSV/XLSX include it.
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

- The future mobile app is not built (`apps/mobile` is reserved and empty, per §2); its
  Android launcher icons are generated and checked.
- Prisma is deliberately pinned to 7.10.1 until 8.0 is stable.
