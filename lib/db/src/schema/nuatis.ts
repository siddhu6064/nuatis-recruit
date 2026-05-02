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
    check("users_role_check", sql`${table.role} IN ('owner', 'recruiter', 'readonly')`),
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
  workspaceId: uuid("workspace_id").references(() => workspacesTable.id).notNull(),
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
  workspaceId: uuid("workspace_id").references(() => workspacesTable.id).notNull(),
  name: text("name").notNull(),
  primaryContactName: text("primary_contact_name"),
  contactEmail: text("contact_email"),
  contactPhone: text("contact_phone"),
  contractTerms: text("contract_terms"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

// Default kanban stages — stored as JSONB default in jobs table
const DEFAULT_STAGES_SQL = sql`'[
  {"key":"sourced",  "label":"Sourced",   "order":0},
  {"key":"applied",  "label":"Applied",   "order":1},
  {"key":"screen",   "label":"Screen",    "order":2},
  {"key":"hm_round", "label":"HM Round",  "order":3},
  {"key":"final",    "label":"Final",     "order":4},
  {"key":"offer",    "label":"Offer",     "order":5},
  {"key":"placed",   "label":"Placed",    "order":6},
  {"key":"rejected", "label":"Rejected",  "order":7}
]'::jsonb`;

export const jobsTable = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    workspaceId: uuid("workspace_id").references(() => workspacesTable.id).notNull(),
    clientId: uuid("client_id").references(() => clientsTable.id).notNull(),
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
    // Batch 4: per-job kanban stage definitions
    stagesJson: jsonb("stages_json").default(DEFAULT_STAGES_SQL).notNull(),
    // NOTE: embedding vector(1536) added via raw SQL in apply-rls migration (pgvector).
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
  workspaceId: uuid("workspace_id").references(() => workspacesTable.id).notNull(),
  name: text("name").notNull(),
  emails: text("emails").array().default(sql`'{}'::text[]`),
  phones: text("phones").array().default(sql`'{}'::text[]`),
  location: text("location"),
  currentTitle: text("current_title"),
  currentCompany: text("current_company"),
  summary: text("summary"),
  parsedResume: jsonb("parsed_resume"),
  // NOTE: embedding vector(1536) added via raw SQL in apply-rls migration.
  source: text("source"),
  lastActivityAt: timestamp("last_activity_at", { withTimezone: true }),
  doNotContact: boolean("do_not_contact").default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const applicationsTable = pgTable(
  "applications",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    workspaceId: uuid("workspace_id").references(() => workspacesTable.id).notNull(),
    candidateId: uuid("candidate_id").references(() => candidatesTable.id).notNull(),
    jobId: uuid("job_id").references(() => jobsTable.id).notNull(),
    stage: text("stage").default("applied").notNull(),
    // Batch 4: gap-based position within stage (multiples of 1000; rebalance when gap < 100).
    // Stage validation is app-layer against jobs.stages_json keys — no DB check constraint,
    // allowing custom stage keys without migrations.
    positionInStage: integer("position_in_stage").default(0).notNull(),
    source: text("source"),
    appliedAt: timestamp("applied_at", { withTimezone: true }).defaultNow(),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("applications_candidate_job_idx").on(table.candidateId, table.jobId),
  ],
);

export const resumesTable = pgTable("resumes", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  workspaceId: uuid("workspace_id").references(() => workspacesTable.id).notNull(),
  candidateId: uuid("candidate_id").references(() => candidatesTable.id).notNull(),
  fileUrl: text("file_url").notNull(),
  parsed: jsonb("parsed"),
  parserVersion: text("parser_version"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const activitiesTable = pgTable("activities", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  workspaceId: uuid("workspace_id").references(() => workspacesTable.id).notNull(),
  candidateId: uuid("candidate_id").references(() => candidatesTable.id).notNull(),
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
    workspaceId: uuid("workspace_id").references(() => workspacesTable.id).notNull(),
    applicationId: uuid("application_id").references(() => applicationsTable.id).notNull(),
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
  workspaceId: uuid("workspace_id").references(() => workspacesTable.id).notNull(),
  targetType: text("target_type").notNull(),
  targetId: uuid("target_id").notNull(),
  signalsStripped: jsonb("signals_stripped").default(sql`'[]'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

// ─── Batch 4: Kanban support tables ──────────────────────────────

/**
 * Per-workspace rejection reasons shown in the bulk-reject modal.
 * 7 default rows seeded by a DB trigger on workspace INSERT.
 * Column `sort_order` avoids the SQL reserved word `order`.
 */
export const rejectionReasonsTable = pgTable("rejection_reasons", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  workspaceId: uuid("workspace_id").references(() => workspacesTable.id).notNull(),
  label: text("label").notNull(),
  sortOrder: integer("sort_order").default(0),
  isDefault: boolean("is_default").default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

/**
 * Stage automation hooks — data model only; UI deferred to Phase 4.
 * job_id nullable = workspace-wide rule.
 * Inngest `stage.entered` handler is a stub (logs + writes activity).
 */
export const stageAutomationsTable = pgTable(
  "stage_automations",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    workspaceId: uuid("workspace_id").references(() => workspacesTable.id).notNull(),
    jobId: uuid("job_id").references(() => jobsTable.id), // nullable = all jobs
    stageKey: text("stage_key").notNull(),
    actionType: text("action_type").notNull(),
    actionPayload: jsonb("action_payload").default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    check(
      "stage_automations_action_type_check",
      sql`${table.actionType} IN ('send_template_email','create_task','notify_recruiter')`,
    ),
  ],
);

// ─── Inferred types ───────────────────────────────────────────────
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
export type RejectionReason = typeof rejectionReasonsTable.$inferSelect;
export type StageAutomation = typeof stageAutomationsTable.$inferSelect;

// Stage definition shape stored in jobs.stages_json
export type StageDefinition = { key: string; label: string; order: number };

export const DEFAULT_STAGE_DEFINITIONS: StageDefinition[] = [
  { key: "sourced",   label: "Sourced",   order: 0 },
  { key: "applied",   label: "Applied",   order: 1 },
  { key: "screen",    label: "Screen",    order: 2 },
  { key: "hm_round",  label: "HM Round",  order: 3 },
  { key: "final",     label: "Final",     order: 4 },
  { key: "offer",     label: "Offer",     order: 5 },
  { key: "placed",    label: "Placed",    order: 6 },
  { key: "rejected",  label: "Rejected",  order: 7 },
];
