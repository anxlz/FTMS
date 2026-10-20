# Phase 0 checkpoint — Environment & Monorepo Scaffolding

Date: 2026-10-20 · Scope: §21 Phase 0 only. No Phase 1 work (schema, auth, i18n wiring) was started.

## Definition of Done

| Criterion                                                   | Result    | Evidence                                                                                                                                                                                                                                                 |
| ----------------------------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install && turbo build` succeeds                      | ✅        | Clean tree (all `node_modules`, `dist`, `.next`, generated client deleted) → `pnpm install --frozen-lockfile` → `pnpm verify`: **13/13 Turbo tasks successful, 0 cached**.                                                                               |
| `apps/api` boots and answers a health check                 | ✅        | `node dist/main.js` → `GET /health` **200** `{"status":"ok","service":"ftms-api",…}`; `GET /health/ready` **200** `degraded` with `database: up`. Also served through the Vercel entry `api/index.js` from a plain Node HTTP server.                     |
| `apps/web` renders a placeholder with the correct favicon   | ✅        | `next start` → `/favicon.ico` **200**, byte-identical to the file generated from the official logo; page renders RTL (`<html lang="ar" dir="rtl">`) and shows live API status (`Online`, and `Unreachable` after stopping the API).                      |
| Prisma connects to the **Supabase** DB and runs a migration | ⚠️ Partly | Verified against a real **PostgreSQL 16** (connect via `@prisma/adapter-pg`, `prisma migrate deploy` on a fresh database, `migrate status` up to date, e2e test reads `_prisma_migrations`). **Not run against Supabase: no credentials were provided.** |

### Remaining step for the ⚠️ item (needs your credentials)

```bash
# .env: DATABASE_URL (transaction pooler, 6543) and DIRECT_URL (session pooler, 5432)
pnpm db:deploy          # applies 20261020071307_init
pnpm storage:provision  # creates the 4 private buckets
pnpm dev                # then GET http://localhost:4000/health/ready → database/storage "up"
```

## Test results (actual output, final run)

| Suite                           | Runner         | Result                                            |
| ------------------------------- | -------------- | ------------------------------------------------- |
| `@ftms/core` unit               | Vitest 5       | 8 passed (1 file)                                 |
| `@ftms/web` unit                | Vitest 5       | 7 passed (1 file)                                 |
| `@ftms/api` unit                | Jest 30        | 59 passed (6 suites)                              |
| `@ftms/api` e2e (real Postgres) | Jest 30        | 8 passed (1 suite)                                |
| Lint (type-aware ESLint)        | —              | 0 problems in all packages                        |
| Typecheck                       | TypeScript 6.0 | 0 errors in all packages                          |
| Prettier                        | —              | all files formatted                               |
| Icon determinism                | —              | 28 generated files byte-identical across two runs |

E2E cases: liveness payload + `no-store` + no `x-powered-by`; readiness with Prisma
`database: up` and other services honestly `not_configured`; `_prisma_migrations` contains
the applied `…_init` migration; 404 for unknown routes; Vercel handler serves `/health`;
Vercel handler boots Nest exactly once across invocations; with an unreachable database
the API still boots and `/health/ready` returns **503 `not_ready`**.

Also verified manually: `NODE_ENV=production` without credentials refuses to boot and
lists the 8 missing variables by name (no values printed).

## What was built

- **Monorepo:** pnpm 10 workspaces + Turborepo 2 (`apps/api`, `apps/web`, `apps/mobile`
  reserved/empty, `packages/core`, `packages/eslint-config`), shared `tsconfig.base.json`,
  Prettier, `.nvmrc` (Node 24).
- **API (NestJS 12):** validated env (`src/config/env.ts`), `PrismaService` (lazy pooled
  connection), `RedisService` (Upstash REST), `StorageService` (private buckets, signed URLs
  ≤ 1 h, path-traversal guard), `MailService` (Gmail SMTP; log-only fallback outside
  production), `/health` + `/health/ready`, Vercel handler (`src/vercel.ts`, `api/index.js`,
  `vercel.json`), scripts `storage:provision` and `mail:verify`.
- **Prisma 7.10.1:** `prisma.config.ts`, empty `schema.prisma`, migration `20261020071307_init`.
- **Web (Next.js 16):** Arabic-default RTL placeholder page, live API status, web manifest.
- **Branding:** `scripts/generate-icons.mjs` derives 27 files (favicon, PWA, Apple, Android
  adaptive/legacy/round, Play Store, Tauri master) from `assets/branding/source/agr-logo.png`.
- **Core:** health contracts (Zod) + `aggregateReadiness`, `APP_TIMEZONE`, brand colors.
- **CI:** `.github/workflows/ci.yml` — format, lint, typecheck, build, unit tests, migrations
  on a Postgres 17 service, e2e, icon drift check. (Written; not yet run on GitHub.)

## Decisions taken (and why)

Approved by the project owner on 2026-10-20: decisions 1, 2, 4, 5 and 8.

1. **Node 24 LTS.** `@nestjs/schematics` 12 requires Node ≥ 22.22.3 / 24.15; Vercel defaults to 24.
2. **TypeScript 6.0, not 7.** Nest CLI 12 pins `~6.0`; `ts-jest` and `typescript-eslint` don't support 7 yet.
3. **ESLint 9, not 10.** `eslint-config-next`'s plugins don't declare ESLint 10 support.
4. **Prisma 7.10.1 (stable).** npm's `latest` tag currently points at `8.0.0-rc.23`, a release candidate — not used for a production system. **Rule:** `prisma`, `@prisma/client` and `@prisma/adapter-pg` stay pinned to the exact version `7.10.1` until Prisma 8.0 ships as a stable release; never upgrade them automatically.
5. **Added `DIRECT_URL`** (not in §2's list): Supabase's transaction pooler can't run `prisma migrate`.
6. **Vercel adapter:** the compiled Express instance is exported as a Node handler — no `@vendia/serverless-express` (that adapts AWS Lambda events, which Vercel's Node runtime doesn't use).
7. **Icon source = the logo provided in chat** (per your answer), committed in the repo. `APP_ICON_SOURCE_URL` stays as an optional override; empty by default.
8. **Small icons use the emblem** cropped from that logo; the full lockup is unreadable below ~96 px. `ICON_SUBJECT=full` switches back.
9. **The web app gets no backend secrets** — only `NEXT_PUBLIC_API_URL` from `apps/web/.env.local`.
10. **Readiness details hidden in production** (kept in server logs).
11. **Storage buckets:** `visit-media` 10 MB, `visit-documents` 25 MB, `student-imports` 10 MB, `ticket-attachments` 10 MB — all private; limits live in `buckets.ts`.

## Not verified live (needs credentials — none were invented)

- Supabase Postgres and Storage (`pnpm db:deploy`, `pnpm storage:provision`).
- Upstash Redis (`PING` tested against a stubbed REST server that checks URL, auth header and decoding).
- Gmail SMTP (`pnpm --filter @ftms/api mail:verify`). Note: if the university's Google Workspace admin disables app passwords, SMTP login will fail.
- GitHub Actions run and Vercel deployment (Phase 7 owns production deployment).

## Notes for whoever runs Phase 1

- Read this file and `README.md` first; `docs/master-prompt.md` is the unmodified master prompt.
- Phase 1 needs: real `DATABASE_URL`/`DIRECT_URL`, `JWT_*` secrets, and ideally `SMTP_PASS` (OTP emails; without it emails are logged, never claimed as sent — `MailService.send()` returns `delivered: false`).
- Prisma: add models to `apps/api/prisma/schema.prisma`, then `pnpm db:migrate --name <name>`. The generated client lives in `apps/api/src/generated/prisma` (gitignored, regenerated by every build).
- Shared request/response schemas go in `packages/core`; business rules stay in `apps/api` services.
- `next-intl` is not installed yet (Phase 1). The placeholder hardcodes `lang="ar" dir="rtl"`.
- Jest runs with `--experimental-vm-modules` (NestJS 12's default); the resulting `ExperimentalWarning` line is expected.
- In this build sandbox, Prisma's engine download host and container registries were blocked, so the schema engine was compiled from Prisma's official source at the matching commit and a local PostgreSQL 16 was used. Normal machines and CI download engines automatically — nothing in the repo depends on that workaround.
