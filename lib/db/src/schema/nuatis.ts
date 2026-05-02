import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// ─── Batch 3: AI / match score tables ────────────────────────────

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

// ─────────────────────────────────────────────────────────────────
// Batch 2: ATS core objects
// ─────────────────────────────────────────────────────────────────

export const clientsTable = pgTable("clients", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  workspaceId: uuid("workspace_id")
    .references(() => workspacesTable.id)
    .notNull(),
  name: text("name").notNull(),
  primaryContactName: text("primary_contact_name"),
  contactEmail: text("contact_email"),
  contactPhone: text("contact_phone"),
  contractTerms: text("contract_terms"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const jobsTable = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    workspaceId: uuid("workspace_id")
      .references(() => workspacesTable.id)
      .notNull(),
    clientId: uuid("client_id")
      .references(() => clientsTable.id)
      .notNull(),
    title: text("title").notNull(),
    description: text("description"),
    salaryMin: integer("salary_min"),
    salaryMax: integer("salary_max"),
    location: text("location"),
    employmentType: text("employment_type"),
    status: text("status").default("draft").notNull(),
    slug: text("slug").notNull(),
    customFields: jsonb("custom_fields").default({}),
    parsedJd: jsonb("parsed_jd"),
    // NOTE: embedding vector(3072) added via raw SQL in apply-rls migration (pgvector extension).
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    uniqueIndex("jobs_workspace_slug_idx").on(table.workspaceId, table.slug),
    check(
      "jobs_employment_type_check",
      sql`${table.employmentType} IS NULL OR ${table.employmentType} IN ('full_time','part_time','contract','temp','intern')`,
    ),
    check(
      "jobs_status_check",
      sql`${table.status} IN ('draft','open','on_hold','closed','filled')`,
    ),
  ],
);

export const candidatesTable = pgTable("candidates", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  workspaceId: uuid("workspace_id")
    .references(() => workspacesTable.id)
    .notNull(),
  name: text("name").notNull(),
  emails: text("emails").array().default(sql`'{}'::text[]`),
  phones: text("phones").array().default(sql`'{}'::text[]`),
  location: text("location"),
  currentTitle: text("current_title"),
  currentCompany: text("current_company"),
  summary: text("summary"),
  parsedResume: jsonb("parsed_resume"),
  // NOTE: embedding vector(3072) added via raw SQL in apply-rls migration.
  // Nullable + unindexed until Batch 3. TODO Batch 3: add to Drizzle schema.
  source: text("source"),
  lastActivityAt: timestamp("last_activity_at", { withTimezone: true }),
  doNotContact: boolean("do_not_contact").default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const applicationsTable = pgTable(
  "applications",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    workspaceId: uuid("workspace_id")
      .references(() => workspacesTable.id)
      .notNull(),
    candidateId: uuid("candidate_id")
      .references(() => candidatesTable.id)
      .notNull(),
    jobId: uuid("job_id")
      .references(() => jobsTable.id)
      .notNull(),
    stage: text("stage").default("applied"),
    source: text("source"),
    appliedAt: timestamp("applied_at", { withTimezone: true }).defaultNow(),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("applications_candidate_job_idx").on(
      table.candidateId,
      table.jobId,
    ),
  ],
);

export const resumesTable = pgTable("resumes", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  workspaceId: uuid("workspace_id")
    .references(() => workspacesTable.id)
    .notNull(),
  candidateId: uuid("candidate_id")
    .references(() => candidatesTable.id)
    .notNull(),
  fileUrl: text("file_url").notNull(),
  parsed: jsonb("parsed"),
  parserVersion: text("parser_version"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const activitiesTable = pgTable("activities", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  workspaceId: uuid("workspace_id")
    .references(() => workspacesTable.id)
    .notNull(),
  candidateId: uuid("candidate_id")
    .references(() => candidatesTable.id)
    .notNull(),
  userId: uuid("user_id").references(() => usersTable.id),
  type: text("type").notNull(),
  payload: jsonb("payload").default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

// ─── Batch 3 AI tables ────────────────────────────────────────────

export const matchScoresTable = pgTable(
  "match_scores",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    workspaceId: uuid("workspace_id")
      .references(() => workspacesTable.id)
      .notNull(),
    applicationId: uuid("application_id")
      .references(() => applicationsTable.id)
      .notNull(),
    score: integer("score").notNull(),
    breakdown: jsonb("breakdown").default(sql`'{}'::jsonb`),
    rationale: text("rationale"),
    evidenceQuotes: jsonb("evidence_quotes").default(sql`'[]'::jsonb`),
    modelVersion: text("model_version"),
    promptVersion: text("prompt_version"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    uniqueIndex("match_scores_application_id_idx").on(table.applicationId),
    check("match_scores_score_range", sql`${table.score} >= 0 AND ${table.score} <= 100`),
  ],
);

export const fairnessAuditLogTable = pgTable("fairness_audit_log", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  workspaceId: uuid("workspace_id")
    .references(() => workspacesTable.id)
    .notNull(),
  targetType: text("target_type").notNull(),
  targetId: uuid("target_id").notNull(),
  signalsStripped: jsonb("signals_stripped").default(sql`'[]'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

// ─── Types ────────────────────────────────────────────────────────
export type Organization = typeof organizationsTable.$inferSelect;
export type InsertOrganization = typeof organizationsTable.$inferInsert;
export type Workspace = typeof workspacesTable.$inferSelect;
export type InsertWorkspace = typeof workspacesTable.$inferInsert;
export type User = typeof usersTable.$inferSelect;
export type InsertUser = typeof usersTable.$inferInsert;
export type AuditLog = typeof auditLogsTable.$inferSelect;
export type Invite = typeof invitesTable.$inferSelect;

export type Client = typeof clientsTable.$inferSelect;
export type InsertClient = typeof clientsTable.$inferInsert;
export type Job = typeof jobsTable.$inferSelect;
export type InsertJob = typeof jobsTable.$inferInsert;
export type Candidate = typeof candidatesTable.$inferSelect;
export type InsertCandidate = typeof candidatesTable.$inferInsert;
export type Application = typeof applicationsTable.$inferSelect;
export type InsertApplication = typeof applicationsTable.$inferInsert;
export type Resume = typeof resumesTable.$inferSelect;
export type Activity = typeof activitiesTable.$inferSelect;
export type MatchScore = typeof matchScoresTable.$inferSelect;
export type InsertMatchScore = typeof matchScoresTable.$inferInsert;
export type FairnessAuditLog = typeof fairnessAuditLogTable.$inferSelect;
