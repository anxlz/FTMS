# Security and privacy review (§17)

Review date: 2026-10-25 (Phase 7). Scope: the API (`apps/api`), the web app
(`apps/web`), the database schema and migrations, the deployment configuration, and the
handling of biometric credential metadata and geolocation readings. Every control below
is backed by an automated test that ran in Phase 7 ([testing.md](testing.md)); "evidence"
names the test file.

## Architecture in one paragraph

The browser talks only to the Next.js web server (same origin). The web server keeps the
access and refresh tokens in `httpOnly` cookies and calls the NestJS API server-to-server
with a bearer token; the browser never sees a token and never calls the API (the API sends
no CORS headers). The API decides every authorization from the database on every
request. Only the API holds database, storage, Redis, SMTP and signing credentials. The
database enables Row Level Security with no policies on every table, so Supabase's public
Data API can read or write nothing; the API connects as the owner.

## Controls

| §17 requirement                                            | How it is met                                                                                                                                                                                                                                                                                                                                                                                                           | Evidence                                                                                         |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Secure password hashing                                    | argon2id (`@node-rs/argon2`, 19 MiB, t=2, p=1 — OWASP minimum). Policy: 10–128 characters, not containing the email local part or seat number, not a common password, not the current one.                                                                                                                                                                                                                              | `common.spec.ts` (hashing), `auth.test.ts` (core policy), `auth.e2e-spec.ts`                     |
| University-email verification                              | Students sign up only with an address in `UNIVERSITY_EMAIL_DOMAINS` and prove it with an emailed code before an account exists; records may carry only those domains.                                                                                                                                                                                                                                                   | `linking.e2e-spec.ts`, `students-groups.e2e-spec.ts`                                             |
| Verification-code expiry and rate limiting                 | 6-digit codes, 10 minutes, 5 attempts, single use, a new code replaces the old; stored as an HMAC keyed by a server secret. Limits in Redis: 1 request per minute and 5 per hour per email, 30 per hour per IP; 10 failures per email and 50 per IP per 15 minutes.                                                                                                                                                     | `auth.e2e-spec.ts` (expiry, reuse, attempts, cooldown)                                           |
| Password-recovery protections                              | Same codes; identical answers for unknown emails (nothing sent); a reset ends every session; the policy applies.                                                                                                                                                                                                                                                                                                        | `auth.e2e-spec.ts`                                                                               |
| Secure session / JWT management                            | HS256 access tokens (15 min) with issuer, audience and type checked; algorithm pinned. Refresh tokens rotate on every use (60 s grace for parallel tabs; reuse after that revokes the session as theft); absolute 30-day sessions. Each request re-reads the session and the account: revocation, logout and suspension act on the next request. Cookies: `httpOnly`, `SameSite=Lax`, `Secure` in production.           | `auth.e2e-spec.ts`, `security.e2e-spec.ts` (forged, `alg: none`, other secret, expired, retyped) |
| Authorization on every protected endpoint                  | Global guards (authentication → role → permission) on every route; `@Public` is explicit. A test enumerates **every route of the running API** and fails if a route is public that is not on the reviewed list, or has no case in the role matrix. The matrix runs each protected operation for every role (590 cases).                                                                                                 | `authorization.e2e-spec.ts`                                                                      |
| Input validation                                           | Every `@Body` and `@Query` goes through a Zod schema and every `@Param` through a pipe (UUID); a unit test scans all controllers and fails otherwise. Unknown fields are dropped, so they cannot be mass-assigned.                                                                                                                                                                                                      | `validation-coverage.spec.ts`, `security.e2e-spec.ts`                                            |
| SQL injection and common web vulnerabilities               | Prisma queries are parameterized; raw queries use tagged templates (parameterized) — the only `…Unsafe` calls are two constant statements in the cron installer script. **Phase 7 fix:** user search text is now LIKE-escaped (`%`, `_`, `\` match literally). Malformed JSON → 400, oversized bodies → 413 (**Phase 7 fix**: was 500), prototype-pollution keys have no effect. Security headers on both apps (below). | `security.e2e-spec.ts`, `common.spec.ts`                                                         |
| CSRF protection where applicable                           | The API accepts bearer tokens only (no cookies), so it cannot be driven cross-site. The web app's state changes are Next.js Server Actions (POST, `Origin` checked against the host by the framework) on `SameSite=Lax` cookies; its route handlers are read-only `GET` downloads. `frame-ancestors 'none'` and `X-Frame-Options: DENY` prevent clickjacking.                                                           | `web.test.ts` (policy), `quality.spec.ts` (headers on every page)                                |
| Safe file-upload handling                                  | Type checked by content (magic bytes), not name; size limits per kind (4 MB per request through the web server); private buckets; random storage paths; served only via short-lived signed URLs after an authorization check; spreadsheets are read as values only (a formula's stored result, never evaluated).                                                                                                        | `tickets.e2e-spec.ts`, `imports.e2e-spec.ts`, `visits.e2e-spec.ts`                               |
| Rate limiting on auth and attendance endpoints             | Upstash Redis fixed windows (listed above; check-ins 20 per 10 min per student; biometric options and failures per IP). **Phase 7:** report and export downloads 30 per 15 min per account; if Redis is unreachable the limited action is refused with 503 (fails closed) instead of a bare 500.                                                                                                                        | `auth.e2e-spec.ts`, `biometrics.e2e-spec.ts`, `security.e2e-spec.ts`, `rate-limiter.spec.ts`     |
| Duplicate-attendance prevention                            | Unique key (visit, student) in the database; concurrent duplicates become "already recorded"; absence processing inserts with `ON CONFLICT DO NOTHING`.                                                                                                                                                                                                                                                                 | `attendance.e2e-spec.ts`, `attendance-database.e2e-spec.ts`                                      |
| Protection against student-record enumeration              | Sign-in, code request, recovery, signup matching and the group-swap form answer identically whether or not an account, record or seat number exists. IDs are UUIDv7 and every lookup is authorized; a student sees only their own records and the visits of their own group (404 for others).                                                                                                                           | `auth.e2e-spec.ts`, `linking.e2e-spec.ts`, `group-swaps.e2e-spec.ts`, `visits.e2e-spec.ts`       |
| Logging of security-sensitive actions                      | One audit writer typed against a 71-action catalogue; sign-ins (success and failure), password and code flows, biometric enrollment and revocation, permission grants, role and status changes, exports. Append-only by database trigger.                                                                                                                                                                               | `audit.e2e-spec.ts`, `database.e2e-spec.ts`                                                      |
| Restriction of administrative exports                      | Each export needs its permission pair (`reports.export` with `attendance.read` or `audit.read`), returns only what the caller may read, has row caps, and is itself audited. Phase 7 adds the per-account download limit.                                                                                                                                                                                               | `exports.e2e-spec.ts`, `reports.e2e-spec.ts`, `security.e2e-spec.ts`                             |
| Safe handling of private student data                      | Minimum data in the browser (server-rendered pages); students never see which staff member decided (staff appear as "Training office"); no personal data in rate-limit keys (hashed) or in QR codes; CSV/XLSX are formula-safe; error bodies carry a code and a generic message only.                                                                                                                                   | `group-swaps.e2e-spec.ts`, `tickets.e2e-spec.ts`, `exports.e2e-spec.ts`, `security.e2e-spec.ts`  |
| Never trust role, IDs, status, lateness, flags or location | The role and permissions come from the database, never from the token (a correctly signed token claiming `SUPER_ADMIN` is still refused). Check-in ignores any status, minutes, biometric flag or group sent by the browser; the server's clock decides; biometric confirmation is a fresh WebAuthn assertion bound to the student and the visit.                                                                       | `security.e2e-spec.ts`, `attendance.e2e-spec.ts`                                                 |
| Super Admin and Training Director scopes are distinct      | `users.manage`, `permissions.manage` and `settings.manage` are not grantable to anyone; the last active Super Admin cannot be removed.                                                                                                                                                                                                                                                                                  | `authorization.e2e-spec.ts`, `users` tests in the matrix                                         |
| No secrets in bundles, config, errors or audit records     | `pnpm scan:secrets` (CI) scans every committed file and, with `--history`, every committed change; `pnpm scan:bundle` (CI) fails if the browser bundle names or contains a server-only setting (checked with a stand-in secret set during the build); errors never echo internals; audit values with secret-like names are redacted and the whole table is searched for passwords, codes, tokens and keys.              | `scan-secrets.mjs`, `scan-client-bundle.mjs`, `security.e2e-spec.ts`, `audit.e2e-spec.ts`        |

### Response headers

| App | Headers (production)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web | Per-request nonce **Content-Security-Policy** (`script-src 'self' 'nonce-…' 'strict-dynamic'`, no `unsafe-eval` in production, `connect-src 'self'`, `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `upgrade-insecure-requests` on HTTPS); `X-Frame-Options: DENY`; `X-Content-Type-Options: nosniff`; `Referrer-Policy: strict-origin-when-cross-origin`; `Cross-Origin-Opener-Policy: same-origin`; `Permissions-Policy` allowing only geolocation and WebAuthn for this site (camera, microphone, payment, USB off); HSTS (2 years, subdomains). |
| API | `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`; `X-Frame-Options: DENY`; `X-Content-Type-Options: nosniff`; `Referrer-Policy: no-referrer`; `Cross-Origin-Resource-Policy: same-site`; `Cache-Control: no-store`; HSTS in production; no `X-Powered-By`; no CORS headers.                                                                                                                                                                                                                                                                                             |

The browser suite loads every page of every role in both languages and fails on any CSP
violation reported by Chromium, so the policy is known not to break the app.

## Biometric data (§4.5, §7.2)

- **No biometric sample ever leaves the device.** WebAuthn platform authenticators verify
  the fingerprint or face locally; the server receives only signed assertions.
- **Stored per device:** credential id, public key (COSE), signature counter, transports,
  whether it is synced/backed up, the authenticator model id (AAGUID), a name the owner
  chose, timestamps, revocation. A
  database trigger makes the owner and key immutable; revocation is final.
- **Ceremonies:** user verification required, resident keys, platform attachment,
  attestation `none` (no device fingerprinting). Challenges are single-use, expire after
  5 minutes, are bound to the account (registration, check-in) and, for check-in, to the
  visit; expired ones are deleted after a day.
- **Enrollment needs a password or email-code session**: a biometric session cannot add
  another device. Revoking a device ends the sessions it opened at once.
- **Never logged:** challenges, credential ids and public keys are excluded from the audit
  log (verified by searching the whole table in base64, base64url and hex).

## Geolocation readings (§7.2, §10.3)

- Captured only at check-in, only with the browser's permission (`Permissions-Policy`
  allows geolocation for this site only), sent once with the check-in request.
- **Stored on the attendance record:** latitude, longitude, accuracy (m) and, when the
  visit has coordinates, the distance from them. Database checks reject incomplete or
  out-of-range values.
- **Visible to** staff holding `attendance.read` on the visit's attendance page — never to
  other students. It is supporting context for staff review, not automatic proof or
  rejection of presence.
- **Not copied** into the audit log (it records only that a reading was sent and the
  distance from the visit, never the coordinates) and **not included** in CSV/XLSX/PDF
  exports.
- Retention: kept with the record; [operations.md](operations.md#data-retention) gives a
  recommended purge after the program ends.

## Findings fixed in Phase 7

| #   | Finding                                                                                                                                                                                                                                  | Severity | Fix                                                                                                                                                                                          |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Search text was used as a LIKE pattern: `%` listed every record, `_` matched any character (no injection, but wrong results).                                                                                                            | Low      | `literal()` escapes `\`, `%`, `_` in every search (students, users, tickets, swaps, audit log, reports).                                                                                     |
| 2   | Oversized or malformed bodies rejected by Express's body parser surfaced as 500.                                                                                                                                                         | Low      | The exception filter passes on exposed 4xx statuses: 413 `FILE_TOO_LARGE`, 400 `VALIDATION_FAILED`.                                                                                          |
| 3   | No security headers on either app (no CSP, framing allowed, no HSTS).                                                                                                                                                                    | Medium   | Nonce-based CSP and static headers on the web app; restrictive headers on the API.                                                                                                           |
| 4   | Exports had no rate limit: a compromised staff account could pull data repeatedly.                                                                                                                                                       | Low      | 30 downloads per 15 minutes per account across all exports (429 with `Retry-After`).                                                                                                         |
| 5   | **The API would not have booted on Vercel**: Vercel's file tracer missed pdfkit's standard-font files, which `@react-pdf` loads when the API starts. Found by building with the Vercel CLI and running the traced function in isolation. | High     | `apps/api/vercel.json` `includeFiles` adds `pdfkit/js/standard-fonts/**`; the rebuilt function boots and serves PDF, XLSX and CSV exports ([deployment.md](deployment.md#verified-locally)). |
| 6   | A Redis or database outage answered 500 `INTERNAL_ERROR`.                                                                                                                                                                                | Low      | 503 `SERVICE_UNAVAILABLE` (translated message); rate limits still fail closed.                                                                                                               |
| 7   | Nothing prevented a new public route or an unvalidated parameter from being added unnoticed.                                                                                                                                             | Process  | Route-coverage test over the live route table; validation-coverage test over every controller; secret scan and bundle scan in CI.                                                            |

## Residual risks and recommendations

1. **Credentials never exercised live.** Supabase, Upstash, Gmail SMTP and a real Vercel
   deployment were not available in this environment (no credentials were invented).
   The first deployment must run the smoke test and the manual checks in
   [deployment.md](deployment.md).
2. **`style-src 'unsafe-inline'`** remains in the CSP (React `style` attributes). Inline
   styles cannot run script; scripts are nonce-only.
3. **GET downloads can be triggered cross-site** (a link opened by a signed-in staff
   member downloads a file to their own machine); the attacker cannot read it. Accepted.
4. **Geolocation can be spoofed** by a determined student (browser developer tools,
   mock-location apps). It is documented and shown as supporting context only; the
   biometric assertion and the QR window are the binding controls.
5. **Single shared SMTP account.** If its App Password leaks, mail can be sent as the
   faculty address: keep it only in Vercel, rotate it on staff changes.
6. **Audit log growth and personal data retention** need an institutional policy
   ([operations.md](operations.md#data-retention)).
7. **Dependency updates.** Prisma is deliberately pinned at 7.10.1 until 8.0 is stable;
   run `pnpm audit` and update the other dependencies on a regular schedule.
