/**
 * packages/audit — Audit log helper.
 *
 * withAudit wraps a mutation and inserts an audit_logs row inside the SAME
 * database instance, so the mutation and the audit record are atomic when
 * both go through req.db (the per-request RLS transaction client).
 *
 * Usage in a route handler:
 *
 *   const txDb = req.db ?? db;   // prefer the RLS-scoped client
 *   const result = await withAudit(
 *     txDb,
 *     {
 *       workspaceId: user.workspaceId,
 *       action: "member.role_change",
 *       targetType: "user",
 *       targetId: memberId,
 *       diff: { from: oldRole, to: newRole },
 *       userId: user.id,
 *       ip: req.ip ?? null,
 *       userAgent: req.headers["user-agent"] ?? null,
 *     },
 *     () => txDb.update(usersTable).set({ role }).where(eq(usersTable.id, memberId)),
 *   );
 *
 * Audit action strings that callers MUST use (matched exactly by tests):
 *   workspace.create | invite.create | member.role_change | member.removed
 *
 * NOTE: DB-level triggers (_audit_workspace_create, _audit_invite_create,
 * _audit_user_role_change, _audit_user_remove) ALSO fire on direct SQL mutations.
 * HTTP routes that call withAudit will therefore produce two audit rows: one
 * from the trigger (no HTTP context) and one from withAudit (with user_id, ip,
 * user_agent). This is accepted v1 behaviour — the withAudit row is the
 * authoritative HTTP-layer record.
 * TODO: deduplicate once a single canonical source is chosen.
 */
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { auditLogsTable } from "@workspace/db";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AuditTx = NodePgDatabase<any>;

export type AuditAction =
  | "workspace.create"
  | "invite.create"
  | "member.role_change"
  | "member.removed";

export type AuditParams = {
  workspaceId: string;
  action: AuditAction;
  targetType: string;
  targetId?: string | null;
  diff?: Record<string, unknown> | null;
  userId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
};

export async function withAudit<T>(
  tx: AuditTx,
  params: AuditParams,
  fn: () => Promise<T>,
): Promise<T> {
  const result = await fn();

  await tx.insert(auditLogsTable).values({
    workspaceId: params.workspaceId,
    action: params.action,
    targetType: params.targetType,
    targetId: params.targetId ?? null,
    diffJson: params.diff ?? null,
    userId: params.userId ?? null,
    ip: params.ip ?? null,
    userAgent: params.userAgent ?? null,
  });

  return result;
}
