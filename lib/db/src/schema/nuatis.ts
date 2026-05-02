import { sql } from "drizzle-orm";
import {
  check,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const organizationsTable = pgTable("organizations", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  slug: text("slug").unique().notNull(),
  planTier: text("plan_tier").default("starter"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const workspacesTable = pgTable("workspaces", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  organizationId: uuid("organization_id").references(() => organizationsTable.id),
  name: text("name"),
  settingsJson: jsonb("settings_json").default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const usersTable = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    workspaceId: uuid("workspace_id").references(() => workspacesTable.id),
    externalAuthId: text("external_auth_id").unique().notNull(),
    externalAuthProvider: text("external_auth_provider").notNull().default("replit"),
    email: text("email").notNull(),
    name: text("name"),
    role: text("role").default("recruiter"),
    lastActiveAt: timestamp("last_active_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    check(
      "users_role_check",
      sql`${table.role} IN ('owner', 'recruiter', 'readonly')`,
    ),
  ],
);

export const auditLogsTable = pgTable("audit_logs", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  workspaceId: uuid("workspace_id").references(() => workspacesTable.id),
  userId: uuid("user_id"),
  action: text("action"),
  targetType: text("target_type"),
  targetId: uuid("target_id"),
  diffJson: jsonb("diff_json"),
  ip: text("ip"),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const invitesTable = pgTable("invites", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  workspaceId: uuid("workspace_id")
    .references(() => workspacesTable.id)
    .notNull(),
  email: text("email").notNull(),
  token: text("token").unique().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export type Organization = typeof organizationsTable.$inferSelect;
export type InsertOrganization = typeof organizationsTable.$inferInsert;
export type Workspace = typeof workspacesTable.$inferSelect;
export type InsertWorkspace = typeof workspacesTable.$inferInsert;
export type User = typeof usersTable.$inferSelect;
export type InsertUser = typeof usersTable.$inferInsert;
export type AuditLog = typeof auditLogsTable.$inferSelect;
export type Invite = typeof invitesTable.$inferSelect;
