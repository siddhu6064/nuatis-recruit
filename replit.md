# Nuatis Recruit

## Overview

AI-native B2B SaaS recruiting platform. pnpm monorepo with TypeScript, Express 5 API server, React/Vite web frontend, PostgreSQL + Drizzle ORM, and Replit Auth (OIDC/PKCE).

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM + pgvector (vector embeddings, 1536-dim)
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)
- **Auth**: Replit Auth (OIDC/PKCE via `@workspace/auth`)
- **Background jobs**: Inngest v4 (`inngest` package, serve endpoint at `/api/inngest`)
- **Object storage**: `@replit/object-storage` (resume file uploads)
- **AI service**: Python/FastAPI at `/ai` (stubbed LLM; Anthropic + OpenAI wired for Batch 4)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/db run migrate:rls` — apply RLS policies, nuatis_app role, audit triggers, pgvector extension, HNSW indexes (idempotent)
- `pnpm --filter @workspace/api-server run dev` — run API server locally
- `pnpm test` — run all tests (vitest)

## Architecture

### Multi-tenancy & RLS

- **nuatis_app role**: A non-superuser PostgreSQL role (no BYPASSRLS) created by `migrate:rls`. The `db` pool in `lib/db/src/index.ts` switches to this role on every connection via `SET ROLE nuatis_app`, making RLS policies effective. PostgreSQL superusers bypass RLS by default; this is the workaround.
- **RLS policies**: All tenant-scoped tables have `ENABLE + FORCE ROW LEVEL SECURITY` with workspace isolation policies. The USING expression uses `NULLIF(current_setting('app.current_workspace_id', true), '') IS NULL` to treat both NULL and `''` as "no context" (necessary because reused pool connections return `''` not `NULL` after a transaction ROLLBACK of a locally-set GUC).
- **rlsMiddleware**: Express middleware that sets `app.current_workspace_id` for authenticated requests via `SET LOCAL` in a transaction.
- **withAudit**: HTTP-level audit helper in `packages/audit`. Writes audit rows in addition to the DB-level trigger rows (v1 trade-off, TODO to dedup).

### Audit Triggers

Four `SECURITY DEFINER` trigger functions write to `audit_logs` automatically:
- `workspace_audit_create` — fires on `workspaces` INSERT
- `invite_audit_create` — fires on `invites` INSERT
- `user_audit_role_change` — fires on `users` UPDATE (role column diff)
- `user_audit_remove` — fires on `users` DELETE

### Database Schema (all tables have RLS)

**Batch 1 — Auth + Audit**
- `organizations`, `workspaces`, `users`, `invites`, `audit_logs`

**Batch 2 — Core ATS Objects**
- `clients` — hiring clients / companies
- `jobs` — job requisitions (with `parsed_jd jsonb`, `embedding vector(1536)`)
- `candidates` — candidate profiles (with `parsed_resume jsonb`, `embedding vector(1536)`)
- `applications` — links candidates to jobs (stage, source)
- `resumes` — uploaded resume files (object storage path + parsed JSON)
- `activities` — timeline events for candidates

**Batch 3 — AI Scoring**
- `match_scores` — one row per application; score 0–100 with breakdown + rationale; unique on `application_id`
- `fairness_audit_log` — tracks protected-class signals stripped before scoring

### AI Pipeline (Batch 3 — Stubbed)

Three Inngest v4 durable functions:
1. **`resume.uploaded`** → parse resume via `/ai/parse/resume` → embed via `/ai/embed` → save to `resumes` + `candidates`
2. **`job.created`** → parse JD via `/ai/parse/jd` → embed via `/ai/embed` → save to `jobs.parsed_jd`
3. **`application.created`** → match via `/ai/match` → upsert `match_scores`

Inngest serve endpoint: `POST /api/inngest`

AI service (`artifacts/ai-server`) runs Python/FastAPI at port 9000 (`/ai` path):
- `GET /health`
- `POST /parse/resume` — returns `ParsedResume` with stub LLM
- `POST /parse/jd` — returns `ParsedJD` with stub LLM
- `POST /embed` — returns deterministic 1536-dim vector (sha256 seeded)
- `POST /match` — returns score + breakdown (skills 40%, experience 30%, seniority 20%, location 10%)

### drizzle-orm Peer Dep Note

`inngest` brings in `@opentelemetry/api` as a peer dep, which caused pnpm to create two drizzle-orm resolution instances. Fix: `@opentelemetry/api` is declared as a devDep in `lib/db`, `packages/auth`, `packages/audit`, and `artifacts/api-server` to unify the resolution. Routes that import drizzle-orm tables from `@workspace/db` alongside the Inngest package use raw SQL (`pool.query`) or `as unknown as T` casts where needed.

### Packages

- `lib/db` — Drizzle schema, pool singleton, migrations, apply-rls script
- `packages/auth` — Replit Auth OIDC/PKCE helpers, invite flow
- `packages/audit` — `withAudit` HTTP-layer audit helper
- `packages/ai-prompts` — placeholder Markdown prompt files for Batch 4 (real LLM wiring)
- `artifacts/api-server` — Express 5 API
- `artifacts/web` — React/Vite frontend
- `artifacts/ai-server` — Python FastAPI AI microservice
- `evals/` — evaluation harness skeleton for AI output quality

### API Routes

- `GET /api/healthz`
- `GET /api/auth/me`, `GET /api/auth/login`, `GET /api/auth/logout`, `GET /api/auth/callback`
- `GET/PUT /api/workspace`, `GET /api/workspace/members`, `PATCH /api/workspace/members/:userId`, `DELETE /api/workspace/members/:userId`
- `GET/POST /api/workspace/invites`, `POST /api/workspace/invites/accept`
- `GET/POST /api/clients`, `GET/PUT/DELETE /api/clients/:id`
- `GET/POST /api/jobs`, `GET/PUT/DELETE /api/jobs/:slug`
- `GET/POST /api/candidates`, `GET/PUT /api/candidates/:id`
- `GET/POST /api/applications`, `GET/PUT /api/applications/:id`
- `POST /api/resumes/upload`, `GET /api/resumes/:id`
- `GET /api/match-scores?application_id=&job_id=`
- `GET/POST /api/activities`
- `POST /api/inngest` (Inngest serve endpoint)
- `GET /api/public/jobs`, `GET /api/public/jobs/:slug`, `POST /api/public/jobs/:slug/apply`

### Inngest Workflow Wiring (Batch 3.5)

- Inngest Dev Server runs on port 8008; API server registers functions at `POST /api/inngest`
- `POST /api/_test/inngest-send` — dev-only endpoint to fire events via SDK (bypasses Inngest's `/e` direct HTTP)
- All three Inngest functions verified end-to-end: `job.created` → `parsed_jd`, `resume.uploaded` → `parsed_resume`, `application.created` → `match_scores`
- Demo loop script: `pnpm --filter @workspace/scripts run demo-loop` — seeds, publishes a job, submits an application via HTTP, polls for a match score, then cleans up

### Object Storage Notes

- `@replit/object-storage` requires `DEFAULT_OBJECT_STORAGE_BUCKET_ID` env var; the `Client` is constructed with `{ bucketId }` explicitly to bypass sidecar discovery
- In `NODE_ENV=development`, upload failures fall back gracefully to the stub object path (AI service is stubbed and doesn't need the actual file)
- `PRIVATE_OBJECT_DIR` contains the bucket-prefixed path prefix (e.g. `/replit-objstore-xxxx/.private`)

### Test Suite (41/41 passing)

- `tests/security/rls.test.ts` — 20 RLS isolation tests (all tables including match_scores + fairness_audit_log)
- `tests/audit/audit-log.test.ts` — 4 trigger audit tests
- `tests/invite/invite-flow.test.ts` — 4 invite flow tests
- `tests/public-apply/apply-flow.test.ts` — 3 public apply DB assertion tests
- `tests/ai-pipeline/parse-stub.test.ts` — 5 AI service parse/embed tests
- `tests/ai-pipeline/match-flow.test.ts` — 5 match pipeline + DB integration tests
- `tests/e2e/demo-loop.test.ts` — 5 E2E tests (apply → Inngest → match_scores within 30 s)

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
