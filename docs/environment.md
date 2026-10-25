# Environment variables

Every setting the system reads, where it is read, and whether it is required. No real
value appears in this repository: `.env.example` (API, scripts) and
`apps/web/.env.example` (web) list the same variables with empty or placeholder values.
`apps/api/src/config/env.spec.ts` and `env-docs.spec.ts` keep the schema, both example
files and this page in step.

**Where values go**

| Environment               | API and scripts                         | Web                                      |
| ------------------------- | --------------------------------------- | ---------------------------------------- |
| Local development         | `.env` at the repository root           | `apps/web/.env.local`                    |
| Vercel                    | API project → Settings → Environment    | Web project → Settings → Environment     |
| One-off production script | your shell, from a trusted machine only | —                                        |
| CI                        | workflow `env:` (test values only)      | workflow `env:` (a stand-in for the BFF) |

`.env` files never override a variable already set by the shell, CI or Vercel. The API
validates everything once at boot (`apps/api/src/config/env.ts`) and refuses to start
with a list of the variables that are missing or malformed — names only, never values.

**Required** column: _Always_ = the API does not start without it in any environment;
_Production_ = required when `NODE_ENV=production` (the API refuses to start without
it); _Optional_ = has a default or a safe fallback.

## API (`apps/api`)

| Variable                    | Required   | Secret | Purpose and format                                                                                                                                                                                                                                               |
| --------------------------- | ---------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                  | Optional   | no     | `development` (default), `test` or `production`. Set `production` on the Vercel API project: it turns on the production requirements below, HSTS, and hides failure details on `/health/ready`.                                                                  |
| `PORT`                      | Optional   | no     | Port of the long-running local server (`pnpm dev`, `pnpm start`), default `4000`. Vercel ignores it.                                                                                                                                                             |
| `APP_TIMEZONE`              | Optional   | no     | IANA time zone used for display, default `Africa/Cairo`. Storage is always UTC.                                                                                                                                                                                  |
| `DATABASE_URL`              | Always     | yes    | Runtime Postgres connection. On Vercel: Supabase **transaction pooler**, port `6543` (`postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres`). Locally any Postgres 16+.                                                      |
| `DIRECT_URL`                | Optional   | yes    | Used only by `pnpm db:deploy` (migrations) and `cron:install`: Supabase **session pooler** (port `5432`) or the direct connection — the transaction pooler cannot run migrations. Falls back to `DATABASE_URL`.                                                  |
| `SUPABASE_URL`              | Production | no     | `https://<ref>.supabase.co` — Storage for visit files, ticket attachments and import files. Set together with the service role key. Without both (development only), files are kept on local disk.                                                               |
| `SUPABASE_SERVICE_ROLE_KEY` | Production | yes    | Supabase service role (or `sb_secret_…`) key. Server-only: it bypasses Row Level Security. Never in the web project.                                                                                                                                             |
| `SUPABASE_ANON_KEY`         | Optional   | no     | Not used by any code today; leave empty. (Row Level Security without policies means it can read nothing anyway.)                                                                                                                                                 |
| `UPSTASH_REDIS_REST_URL`    | Production | no     | `https://<name>.upstash.io` — rate-limit counters shared by every serverless instance. Set together with the token. Without both (development only) an in-memory limiter is used.                                                                                |
| `UPSTASH_REDIS_REST_TOKEN`  | Production | yes    | Upstash REST token (the read-write one).                                                                                                                                                                                                                         |
| `SMTP_HOST`                 | Optional   | no     | Default `smtp.gmail.com`.                                                                                                                                                                                                                                        |
| `SMTP_PORT`                 | Optional   | no     | Default `465` (implicit TLS).                                                                                                                                                                                                                                    |
| `SMTP_USER`                 | Optional   | no     | Sender account, default `ST22425244@agr.asu.edu.eg` (§2).                                                                                                                                                                                                        |
| `SMTP_PASS`                 | Production | yes    | A **Gmail App Password** for `SMTP_USER` (Google Account → Security → 2-Step Verification → App passwords; 16 characters). Check it with `pnpm --filter @ftms/api mail:verify`. Without it (development only) emails are written to the API log instead of sent. |
| `JWT_ACCESS_SECRET`         | Always     | yes    | Signs 15-minute access tokens. At least 32 characters (`openssl rand -base64 48`). Rotating it invalidates the access tokens already issued (they last 15 minutes): people may have to sign in again.                                                            |
| `JWT_REFRESH_SECRET`        | Always     | yes    | Signs refresh tokens. At least 32 characters and different from the access secret. Rotating it ends every session (everyone signs in again).                                                                                                                     |
| `QR_HMAC_SECRET`            | Production | yes    | Signs the stable attendance QR codes (§7.2). At least 32 characters. **Changing it invalidates every printed attendance QR code.** Outside production a key derived from `JWT_ACCESS_SECRET` is used when empty.                                                 |
| `BFF_SHARED_SECRET`         | Production | yes    | Shared by the web server and the API (the same value on both Vercel projects). Lets the API trust the client IP the web server forwards, so rate limits and audit records apply per person. At least 32 characters.                                              |
| `WEB_APP_URL`               | Production | no     | Public URL of the web app (`https://…`): links in emails and QR codes, and the WebAuthn origin for biometric sign-in and check-in.                                                                                                                               |
| `WEBAUTHN_RP_ID`            | Optional   | no     | WebAuthn relying-party id; default the host of `WEB_APP_URL`. Set a parent domain only if passkeys must work on several subdomains. **Changing it invalidates every enrolled biometric credential.**                                                             |
| `CRON_SECRET`               | Production | yes    | Shared with the Supabase `pg_cron` job that triggers automatic absences (`x-ftms-cron-key` header). At least 32 characters. `cron:install` stores it in Supabase Vault. Without it the internal endpoint is disabled.                                            |
| `UNIVERSITY_EMAIL_DOMAINS`  | Optional   | no     | Comma-separated email domains students may sign up with and student records may carry; subdomains match. Default `agr.asu.edu.eg`.                                                                                                                               |
| `VERCEL`                    | —          | no     | Set to `1` by Vercel itself; the API then trusts Vercel's proxy headers for the connecting address. Do not set it by hand.                                                                                                                                       |

## Web (`apps/web`)

The web server receives no database or service credential, and nothing secret reaches
a browser (checked after every build by `pnpm scan:bundle`).

| Variable              | Required   | Secret | Purpose and format                                                                                                       |
| --------------------- | ---------- | ------ | ------------------------------------------------------------------------------------------------------------------------ |
| `NEXT_PUBLIC_API_URL` | Always     | no     | Base URL of the API, e.g. `https://ftms-api.example.app`. Only the web **server** calls the API; the browser never does. |
| `API_URL`             | Optional   | no     | Overrides `NEXT_PUBLIC_API_URL` on the server, e.g. a private address. Never sent to browsers.                           |
| `BFF_SHARED_SECRET`   | Production | yes    | The same value as the API's. Server-only.                                                                                |
| `NODE_ENV`            | —          | no     | Set by Next.js (`production` for `next build`/`next start`). In production cookies are `Secure` and HSTS is sent.        |

## Android app (`apps/mobile`, build time)

The app holds no secret: it only needs the address of the deployed web app. It is read by
`pnpm --filter @ftms/mobile configure` (run by `android:dev` and `android:build`), which
writes the git-ignored `src/config.json` and `src-tauri/capabilities/remote.json`
([mobile.md](mobile.md)).

| Variable       | Required         | Secret | Purpose and format                                                                                                                                                                                                                                                                                                   |
| -------------- | ---------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FTMS_WEB_URL` | For an app build | no     | Origin of the deployed **web app** (not the API), e.g. `https://ftms.example.edu`: the only site the app opens and the only one allowed to use its native features. `https://` only; `http://` is accepted for `localhost`, `127.0.0.1` and the emulator's `10.0.2.2` in development. No path, query or credentials. |

## Scripts and tests only

| Variable                              | Used by           | Purpose                                                                                                              |
| ------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------- |
| `APP_ICON_SOURCE_URL`                 | `pnpm icons`      | Optional image URL to download a replacement logo before regenerating icons. Empty: use the committed official logo. |
| `ICON_SUBJECT`                        | `pnpm icons`      | `full` uses the full logo for small icons instead of the emblem.                                                     |
| `CI`                                  | Playwright config | Set by CI: forbids `test.only`, adds the HTML report.                                                                |
| `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` | Playwright config | Optional path to an already-installed Chromium.                                                                      |

`pnpm test:e2e` needs `DATABASE_URL` pointing to a **disposable** database (both suites
wipe it; the browser suite refuses a `supabase.co` URL). The e2e suites set their own test
secrets; none of them is a real credential.

## Generating secrets

```bash
openssl rand -base64 48     # one per variable: JWT_ACCESS_SECRET, JWT_REFRESH_SECRET,
                            # QR_HMAC_SECRET, BFF_SHARED_SECRET, CRON_SECRET
```

Use a different value for each, store them only in Vercel (and a password manager for
recovery), and never paste them into tickets, chats or commits. `pnpm scan:secrets`
(also in CI) fails if a committed file looks like it contains one. Rotation is described
in [operations.md](operations.md#rotating-secrets).
