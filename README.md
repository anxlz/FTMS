# FTMS — Field Training Management System

**نظام إدارة التدريب الميداني — كلية الزراعة، جامعة عين شمس**
Field training management for the Faculty of Agriculture, Ain Shams University, Egypt.

> **Status: Phase 0 — environment & monorepo scaffolding.** No business features yet.
> The master prompt (`docs/master-prompt.md`) is the source of truth; each phase is
> implemented in its own session. See [`docs/checkpoints/phase-0.md`](docs/checkpoints/phase-0.md)
> for what Phase 0 delivered, what was verified, and what Phase 1 picks up.

## Stack

| Layer           | Choice                                                                     |
| --------------- | -------------------------------------------------------------------------- |
| Monorepo        | Turborepo 2 + pnpm 10 workspaces                                           |
| Runtime         | Node.js 24 LTS                                                             |
| Web             | Next.js 16 (App Router, TypeScript) → Vercel                               |
| API             | NestJS 12 (TypeScript) → Vercel serverless function                        |
| Database        | Supabase Postgres via Prisma ORM 7 (`@prisma/adapter-pg`)                  |
| Storage         | Supabase Storage, private buckets + signed URLs                            |
| Cache / limits  | Upstash Redis (REST)                                                       |
| Email           | Gmail SMTP via Nodemailer, sender `ST22425244@agr.asu.edu.eg`              |
| Shared code     | `packages/core` — Zod schemas, types, pure business rules                  |
| Tests           | Jest (API), Vitest (web, core); Playwright arrives with the first UI flows |
| Mobile (future) | Tauri, consuming the same JWT API — `apps/mobile` is reserved and empty    |

## Repository layout

```
apps/
  api/        NestJS API — all business rules live here
  web/        Next.js frontend (Arabic default, RTL)
  mobile/     reserved for the future Tauri app — intentionally empty
packages/
  core/           shared Zod schemas, types and pure helpers
  eslint-config/  shared flat ESLint configs (base / nest / next)
assets/branding/  official logo (source) + derived icons (generated)
scripts/          repo tooling (icon generation)
docs/             master prompt and per-phase checkpoints
```

## Prerequisites

- **Node.js 24 LTS** (`.nvmrc`) and **pnpm 10** (`corepack enable` picks the pinned version).
- A **Supabase** project (database + storage).
- An **Upstash Redis** database (REST URL + token).
- A **Gmail App Password** for `ST22425244@agr.asu.edu.eg` (needs 2-Step Verification
  on that account; if the university's Google Workspace admin has disabled app passwords,
  SMTP login will fail and an admin-approved alternative is needed).

Only the database is needed to boot locally; the other services report `not_configured`
until their credentials are added, and emails are logged instead of sent.

## Local setup

```bash
pnpm install
cp .env.example .env                       # fill in DATABASE_URL at minimum
cp apps/web/.env.example apps/web/.env.local

pnpm db:generate                           # generate the Prisma client
pnpm db:deploy                             # apply migrations (uses DIRECT_URL)
pnpm storage:provision                     # create the private Supabase buckets
pnpm --filter @ftms/api mail:verify        # optional: real SMTP login check

pnpm dev                                   # api → http://localhost:4000, web → http://localhost:3000
```

### Supabase connection strings

Supabase → **Connect**. Use two different URLs:

- `DATABASE_URL` — **transaction pooler** (port `6543`). What the API uses at runtime;
  serverless instances share connections through it.
- `DIRECT_URL` — **session pooler** (port `5432` on the pooler host) or the direct
  connection. Used only by `prisma migrate`; the transaction pooler cannot run migrations.

A plain local Postgres works too: set only `DATABASE_URL`.

## Commands

| Command                               | What it does                                                  |
| ------------------------------------- | ------------------------------------------------------------- |
| `pnpm dev`                            | Run API and web in watch mode                                 |
| `pnpm build`                          | Build every package (generates the Prisma client first)       |
| `pnpm lint` / `pnpm typecheck`        | ESLint (type-aware) / TypeScript across the monorepo          |
| `pnpm test`                           | Unit tests (no network, no database)                          |
| `pnpm test:e2e`                       | API end-to-end tests against a real Postgres (`DATABASE_URL`) |
| `pnpm verify`                         | lint + typecheck + build + test, as CI runs them              |
| `pnpm format` / `pnpm format:check`   | Prettier                                                      |
| `pnpm db:generate`                    | Generate the Prisma client                                    |
| `pnpm db:migrate`                     | Create + apply a migration in development                     |
| `pnpm db:deploy`                      | Apply pending migrations (CI / production)                    |
| `pnpm storage:provision`              | Create/repair private storage buckets (idempotent)            |
| `pnpm --filter @ftms/api mail:verify` | Real Gmail SMTP handshake + login, sends nothing              |
| `pnpm icons`                          | Regenerate every icon from the official logo                  |

## Health endpoints

- `GET /health` — liveness. Always 200 while the process serves HTTP; touches no dependency.
- `GET /health/ready` — readiness. Probes Postgres (`SELECT 1`), Redis (`PING`), Storage
  (all buckets exist and are private) and SMTP (real handshake, cached 5 min), each with a
  3 s timeout. Status is `ready`, `degraded` (development only: something not configured)
  or `not_ready` (HTTP 503). Failure details are shown in development and kept in server
  logs only in production.

The response contracts are Zod schemas in `@ftms/core`, parsed by both the API tests and
the web app.

## Configuration rules

Validated once at boot by `apps/api/src/config/env.ts`:

- `DATABASE_URL` is required everywhere.
- In **production** every service credential and signing secret is required (≥ 32
  characters; access and refresh secrets must differ). The API refuses to start otherwise
  and names the missing variables — never their values.
- Paired variables (`SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`, Upstash URL + token)
  must be set together.
- `.env` files never override variables already set in the shell, CI or Vercel.
- The web app receives only `NEXT_PUBLIC_API_URL`; backend secrets never enter its process.

## Storage buckets

Defined once in `apps/api/src/storage/buckets.ts`; all **private**.

| Bucket               | Purpose                             | Limit |
| -------------------- | ----------------------------------- | ----- |
| `visit-media`        | Visit cover photos / images         | 10 MB |
| `visit-documents`    | Optional visit documents            | 25 MB |
| `student-imports`    | Uploaded student spreadsheets       | 10 MB |
| `ticket-attachments` | Optional support-ticket attachments | 10 MB |

`pnpm storage:provision` creates missing buckets and re-applies settings (forcing any
public bucket back to private), then verifies. Files are served only through signed URLs
(max 1 h) issued by the API after an authorization check.

## App icons and branding

- **Source:** `assets/branding/source/agr-logo.png` — the official Faculty of Agriculture
  logo (2087 × 2088 px, SHA-256 recorded in `assets/branding/generated/manifest.json`).
- **Generator:** `scripts/generate-icons.mjs` (`pnpm icons`, uses `sharp`). Outputs are
  committed, so builds need no image tooling or network. CI regenerates them and fails if
  they drift from the committed files.
- **Small icons use the emblem.** Below ~96 px the logo's text is unreadable, so favicons
  and launcher icons use the obelisk-and-falcons emblem cropped from the same logo. The
  crop box is tied to the source's SHA-256; if the source changes, the script falls back to
  the full logo and asks for the box to be re-measured. `ICON_SUBJECT=full pnpm icons`
  always uses the full logo.
- **Replacing the logo:** overwrite the source file (or set `APP_ICON_SOURCE_URL` to
  download it), run `pnpm icons`, review the diff.

| Output                                                         | Use                                   |
| -------------------------------------------------------------- | ------------------------------------- |
| `apps/web/app/favicon.ico` (16/32/48)                          | Browser favicon                       |
| `apps/web/app/icon.png` (192), `apple-icon.png` (180)          | `<link rel="icon">`, Apple touch icon |
| `apps/web/public/icons/icon-{192,512}.png`, `maskable-512.png` | Web app manifest                      |
| `apps/web/public/brand/agr-logo.png`                           | Full logo shown in the UI             |
| `assets/branding/generated/app-icon-1024.png`                  | Master for `tauri icon` (future)      |
| `assets/branding/generated/android/res/mipmap-*/…`             | Android adaptive + legacy + round     |
| `assets/branding/generated/android/playstore-icon-512.png`     | Play Store listing                    |

Android adaptive icons keep the emblem inside the 66 dp safe circle on a white background
layer, so every launcher mask frames it without clipping.

## Deployment (Vercel)

Two Vercel projects from this repository (full production verification is Phase 7):

**Web** — Root Directory `apps/web`, framework Next.js, Node.js 24. Environment:
`NEXT_PUBLIC_API_URL`.

**API** — Root Directory `apps/api`, Node.js 24. `apps/api/vercel.json` builds with
Turborepo, routes every path to `api/index.js` (the compiled Nest app wrapped for Vercel's
Node runtime, booted once per warm instance), and serves no static files besides a
`robots.txt`. Environment: everything in `.env.example` except `NEXT_PUBLIC_API_URL`,
with `NODE_ENV=production`.

After the first deploy: run `pnpm db:deploy` against production (`DIRECT_URL`), then
`pnpm storage:provision`, then check `GET /health/ready` returns `ready`.

## Running the tests

```bash
pnpm test                         # unit tests: core, api, web
DATABASE_URL=postgresql://… pnpm db:deploy
DATABASE_URL=postgresql://… pnpm test:e2e
```

E2E tests boot the real Nest application (and the Vercel handler) against the given
Postgres. They need the migrations applied and use a throwaway database in CI.

## Super Admin

`ST22425244@agr.asu.edu.eg` is both the email sender and the first Super Admin. Its seed
script (random password printed once, forced change on first login) is part of Phase 1.
