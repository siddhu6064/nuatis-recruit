/**
 * packages/audit — Audit log helper.
 *
 * withAudit wraps a mutation and inserts an audit_logs row inside the SAME
 * database instance, so the mutation and the audit record are atomic when
 * both go through req.db (the per-request RLS transaction client).
 *
 * NOTE: DB-level triggers ALSO fire on direct SQL mutations.
 * HTTP routes that call withAudit produce two audit rows: one from the trigger
 * (no HTTP context) and one from withAudit (with user_id, ip, user_agent).
 * This is accepted v1 behaviour.
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
  | "member.removed"
  | "client.create"
  | "client.update"
  | "job.create"
  | "job.update"
  | "job.publish"
  | "candidate.create"
  | "candidate.update"
  | "application.create"
  | "application.stage_change"
  | "application.reject"
  | "note.create"
  | "note.update"
  | "note.delete"
  | "task.create"
  | "task.complete"
  | "task.update"
  | "task.delete"
  | "candidate.merged";

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
