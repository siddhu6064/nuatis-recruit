# Nuatis Recruit

## Overview

AI-native B2B SaaS recruiting platform. pnpm monorepo with TypeScript, Express 5 API server, React/Vite web frontend, PostgreSQL + Drizzle ORM, and Replit Auth (OIDC/PKCE).

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)
- **Auth**: Replit Auth (OIDC/PKCE via `@workspace/auth`)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/db run migrate:rls` — apply RLS policies, nuatis_app role, and audit triggers (idempotent)
- `pnpm --filter @workspace/api-server run dev` — run API server locally
- `pnpm test` — run all tests (vitest)

## Architecture

### Multi-tenancy & RLS

- **nuatis_app role**: A non-superuser PostgreSQL role (no BYPASSRLS) created by `migrate:rls`. The `db` pool in `lib/db/src/index.ts` switches to this role on every connection via `SET ROLE nuatis_app`, making RLS policies effective. PostgreSQL superusers bypass RLS by default; this is the workaround.
- **RLS policies**: All four tenant-scoped tables (`workspaces`, `users`, `audit_logs`, `invites`) have `ENABLE + FORCE ROW LEVEL SECURITY` with workspace isolation policies. The USING expression uses `NULLIF(current_setting('app.current_workspace_id', true), '') IS NULL` to treat both NULL and `''` as "no context" (necessary because reused pool connections return `''` not `NULL` after a transaction ROLLBACK of a locally-set GUC).
- **rlsMiddleware**: Express middleware that sets `app.current_workspace_id` for authenticated requests via `SET LOCAL` in a transaction.
- **withAudit**: HTTP-level audit helper in `packages/audit`. Writes audit rows in addition to the DB-level trigger rows (v1 trade-off, TODO to dedup).

### Audit Triggers

Four `SECURITY DEFINER` trigger functions write to `audit_logs` automatically:
- `workspace_audit_create` — fires on `workspaces` INSERT
- `invite_audit_create` — fires on `invites` INSERT
- `user_audit_role_change` — fires on `users` UPDATE (role column diff)
- `user_audit_remove` — fires on `users` DELETE

### Packages

- `lib/db` — Drizzle schema, pool singleton, migrations
- `lib/auth` — Replit Auth OIDC/PKCE helpers, invite flow
- `packages/audit` — `withAudit` HTTP-layer audit helper
- `artifacts/api-server` — Express 5 API (workspaces, invites, auth routes)
- `artifacts/web` — React/Vite frontend

### Test Suite (11/11 passing)

- `tests/audit/audit-log.test.ts` — 4 trigger audit tests
- `tests/security/rls.test.ts` — 3 RLS isolation tests
- `tests/invite/invite-flow.test.ts` — 4 invite flow tests

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
