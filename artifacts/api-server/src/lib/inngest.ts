/**
 * Inngest client + function definitions for Nuatis Recruit.
 *
 * Four durable functions:
 *   a. resume.uploaded      → parse resume → embed → update candidates
 *   b. job.created          → parse JD → embed → update jobs
 *   c. application.created  → match → upsert match_scores
 *   d. stage.entered        → execute stage automations (STUB — Phase 4 for real execution)
 *
 * All LLM calls inside the AI service are STUBBED (see artifacts/ai-server).
 * Failures retry 3× with exponential backoff.
 */
import { Inngest } from "inngest";
import { logger } from "./logger";

const AI_BASE = process.env.AI_SERVICE_URL ?? "http://localhost:9000";

export const inngest = new Inngest({ id: "nuatis-recruit" });

// ── Helper: call AI service endpoints ─────────────────────────────────────

async function callAI<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${AI_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`AI service ${path} failed: ${res.status} — ${text}`);
  }
  return res.json() as Promise<T>;
}

// ── DB helper (raw pg — bypasses RLS SET ROLE for background jobs) ─────────

async function dbQuery(sql: string, params: unknown[] = []) {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    return await client.query(sql, params);
  } finally {
    await client.end();
  }
}

// ── Event type definitions ─────────────────────────────────────────────────

type ResumeUploadedEvent = {
  name: "resume.uploaded";
  data: {
    resumeId: string;
    candidateId: string;
    workspaceId: string;
    fileUrl: string;
  };
};

type JobCreatedEvent = {
  name: "job.created";
  data: {
    jobId: string;
    workspaceId: string;
    description: string;
  };
};

type ApplicationCreatedEvent = {
  name: "application.created";
  data: {
    applicationId: string;
    candidateId: string;
    jobId: string;
    workspaceId: string;
    resumeId: string | null;
  };
};

type StageEnteredEvent = {
  name: "stage.entered";
  data: {
    applicationId: string;
    candidateId: string;
    jobId: string;
    workspaceId: string;
    stageKey: string;
    automationIds: string[];
  };
};

// ── Function: resume.uploaded ──────────────────────────────────────────────

export const parseResumeJob = inngest.createFunction(
  {
    id: "parse-resume",
    name: "Parse + embed resume on upload",
    retries: 3,
    triggers: [{ event: "resume.uploaded" }],
  },
  async ({ event, step }) => {
    const { resumeId, candidateId, workspaceId, fileUrl } =
      (event as unknown as ResumeUploadedEvent).data;

    const parsed = await step.run("parse-resume", async () => {
      return callAI<Record<string, unknown>>("/parse/resume", {
        file_url: fileUrl,
        candidate_id: candidateId,
        workspace_id: workspaceId,
      });
    });

    const embedResult = await step.run("embed-resume", async () => {
      const text = [
        (parsed.name as string) ?? "",
        (parsed.summary as string) ?? "",
        ((parsed.skills as string[]) ?? []).join(" "),
      ].join(" ");
      return callAI<{ vector: number[]; model_version: string }>("/embed", { text });
    });

    await step.run("save-parsed-resume", async () => {
      await dbQuery(`UPDATE resumes SET parsed = $1, parser_version = $2 WHERE id = $3`,
        [JSON.stringify(parsed), parsed.model_version ?? "stub", resumeId]);
      await dbQuery(`UPDATE candidates SET parsed_resume = $1 WHERE id = $2`,
        [JSON.stringify(parsed), candidateId]);
      logger.info({ resumeId, candidateId }, "Parsed resume saved");
    });

    await step.run("save-embedding", async () => {
      try {
        await dbQuery(`UPDATE candidates SET embedding = $1::vector WHERE id = $2`,
          [`[${embedResult.vector.join(",")}]`, candidateId]);
        logger.info({ candidateId }, "Candidate embedding saved");
      } catch (err) {
        logger.warn({ err, candidateId }, "Embedding save skipped (pgvector unavailable?)");
      }
    });

    return { resumeId, candidateId, parsedFields: Object.keys(parsed) };
  },
);

// ── Function: job.created ──────────────────────────────────────────────────

export const parseJobJob = inngest.createFunction(
  {
    id: "parse-job",
    name: "Parse + embed job description on create/update",
    retries: 3,
    triggers: [{ event: "job.created" }],
  },
  async ({ event, step }) => {
    const { jobId, workspaceId, description } = (event as unknown as JobCreatedEvent).data;

    const parsedJD = await step.run("parse-jd", async () => {
      return callAI<Record<string, unknown>>("/parse/jd", {
        job_id: jobId,
        description,
        workspace_id: workspaceId,
      });
    });

    const embedResult = await step.run("embed-jd", async () => {
      const text = [
        ((parsedJD.required_skills as string[]) ?? []).join(" "),
        ((parsedJD.key_responsibilities as string[]) ?? []).join(" "),
      ].join(" ");
      return callAI<{ vector: number[]; model_version: string }>("/embed", { text });
    });

    await step.run("save-parsed-jd", async () => {
      await dbQuery(`UPDATE jobs SET parsed_jd = $1 WHERE id = $2`,
        [JSON.stringify(parsedJD), jobId]);
      logger.info({ jobId }, "Parsed JD saved");
    });

    await step.run("save-job-embedding", async () => {
      try {
        await dbQuery(`UPDATE jobs SET embedding = $1::vector WHERE id = $2`,
          [`[${embedResult.vector.join(",")}]`, jobId]);
        logger.info({ jobId }, "Job embedding saved");
      } catch (err) {
        logger.warn({ err, jobId }, "Job embedding save skipped (pgvector unavailable?)");
      }
    });

    return { jobId, parsedSkills: parsedJD.required_skills };
  },
);

// ── Function: application.created ─────────────────────────────────────────

export const scoreApplicationJob = inngest.createFunction(
  {
    id: "score-application",
    name: "Score match on new application",
    retries: 3,
    triggers: [{ event: "application.created" }],
  },
  async ({ event, step }) => {
    const { applicationId, candidateId, jobId, workspaceId, resumeId } =
      (event as unknown as ApplicationCreatedEvent).data;

    const effectiveResumeId = await step.run("resolve-resume", async () => {
      if (resumeId) return resumeId;
      const result = await dbQuery(
        `SELECT id FROM resumes WHERE candidate_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [candidateId],
      );
      return (result.rows[0]?.id as string | undefined) ?? null;
    });

    if (!effectiveResumeId) {
      logger.info({ applicationId }, "No resume — skipping match score");
      return { applicationId, skipped: true };
    }

    const matchResult = await step.run("compute-match", async () => {
      return callAI<{
        score: number;
        breakdown: Record<string, number>;
        rationale: string;
        evidence_quotes: string[];
        model_version: string;
      }>("/match", {
        resume_id: effectiveResumeId,
        job_id: jobId,
        workspace_id: workspaceId,
      });
    });

    await step.run("upsert-match-score", async () => {
      await dbQuery(
        `INSERT INTO match_scores
           (workspace_id, application_id, score, breakdown, rationale, evidence_quotes, model_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (application_id) DO UPDATE SET
           score = EXCLUDED.score, breakdown = EXCLUDED.breakdown,
           rationale = EXCLUDED.rationale, evidence_quotes = EXCLUDED.evidence_quotes,
           model_version = EXCLUDED.model_version, created_at = now()`,
        [
          workspaceId, applicationId, matchResult.score,
          JSON.stringify(matchResult.breakdown), matchResult.rationale,
          JSON.stringify(matchResult.evidence_quotes), matchResult.model_version,
        ],
      );
      logger.info({ applicationId, score: matchResult.score }, "Match score upserted");
    });

    return { applicationId, score: matchResult.score };
  },
);

// ── Function: stage.entered (STUB) ─────────────────────────────────────────
// Fires when an application moves into a stage that has matching automations.
// Phase 4 will implement actual email/task/notification execution.

export const stageEnteredJob = inngest.createFunction(
  {
    id: "stage-entered",
    name: "Execute stage automations on stage entry (stub)",
    retries: 3,
    triggers: [{ event: "stage.entered" }],
  },
  async ({ event, step }) => {
    const { applicationId, candidateId, workspaceId, stageKey, automationIds } =
      (event as unknown as StageEnteredEvent).data;

    for (const automationId of automationIds) {
      await step.run(`stub-automation-${automationId}`, async () => {
        logger.info(
          { automationId, applicationId, stageKey },
          "STUB: would execute stage automation",
        );
        // Write an activity so the stub is observable in DB
        await dbQuery(
          `INSERT INTO activities (workspace_id, candidate_id, type, payload)
           VALUES ($1, $2, 'automation.stub', $3)`,
          [
            workspaceId,
            candidateId,
            JSON.stringify({ automationId, stageKey, applicationId, stub: true }),
          ],
        );
      });
    }

    return { applicationId, stageKey, automationsStubbed: automationIds.length };
  },
);

// ── Event type: email.mention ──────────────────────────────────────────────

type EmailMentionEvent = {
  name: "email.mention";
  data: {
    notificationId: string;
    mentionerUserId: string;
    recipientUserId: string;
    candidateId: string;
    noteId: string;
    workspaceId: string;
    candidateName: string;
    mentionerName: string;
    recipientEmail: string;
    recipientName: string;
  };
};

// ── Function: email.mention ────────────────────────────────────────────────
// Sends a Postmark transactional email to a workspace user who was @-mentioned
// in a candidate note. Idempotent on notificationId.

export const sendSystemMentionEmailJob = inngest.createFunction(
  {
    id: "send-system-mention-email",
    name: "Send system @mention notification email",
    retries: 3,
    triggers: [{ event: "email.mention" }],
    idempotency: "event.data.notificationId",
  },
  async ({ event, step }) => {
    const {
      notificationId,
      workspaceId,
      candidateId,
      noteId,
      candidateName,
      mentionerName,
      recipientEmail,
      recipientName,
    } = (event as unknown as EmailMentionEvent).data;

    if (!recipientEmail) {
      logger.warn({ notificationId }, "email.mention: recipientEmail is empty — skipping send");
      return { notificationId, skipped: true, reason: "no recipient email" };
    }

    const result = await step.run("send-postmark-email", async () => {
      const { sendTransactional } = await import("./email/postmark");
      const { renderMentionEmail } = await import("./email/templates/mention");

      const appBaseUrl =
        process.env.APP_BASE_URL ??
        `https://${(process.env.REPLIT_DOMAINS ?? "localhost").split(",")[0]}`;

      const template = renderMentionEmail({
        mentionerName,
        candidateName,
        candidateId,
        noteId,
        snippet: "",
        appBaseUrl,
      });

      return sendTransactional({
        to: recipientEmail,
        subject: template.subject,
        html: template.html,
        text: template.text,
        tag: "system-mention",
        metadata: { workspaceId, noteId, candidateId, notificationId },
      });
    });

    await step.run("write-email-message-row", async () => {
      const fromAddress = process.env.POSTMARK_FROM_ADDRESS ?? "";
      const now = new Date().toISOString();

      await dbQuery(
        `INSERT INTO email_messages
           (workspace_id, thread_id, postmark_message_id, direction, from_address,
            to_addresses, subject, body_text, sent_at, status)
         VALUES ($1, NULL, $2, 'outbound', $3, ARRAY[$4]::text[], $5, $6, $7, 'sent')`,
        [
          workspaceId,
          result.postmarkMessageId,
          fromAddress,
          recipientEmail,
          `${mentionerName} mentioned you in a note on ${candidateName}`,
          `${mentionerName} mentioned you in a note on candidate ${candidateName}.`,
          now,
        ],
      );

      logger.info(
        { notificationId, postmarkMessageId: result.postmarkMessageId, recipientEmail },
        "System mention email sent and email_messages row written",
      );
    });

    await step.run("write-audit-log", async () => {
      await dbQuery(
        `INSERT INTO audit_logs (workspace_id, action, target_type, diff_json)
         VALUES ($1, 'email.sent', 'email_message', $2)`,
        [
          workspaceId,
          JSON.stringify({
            notificationId,
            postmarkMessageId: result.postmarkMessageId,
            recipientEmail,
          }),
        ],
      );
    });

    return {
      notificationId,
      postmarkMessageId: result.postmarkMessageId,
      recipientEmail,
    };
  },
);

// ── Event types: nylas ─────────────────────────────────────────────────────

type NylasMessageReceivedEvent = {
  name: "nylas.message_received";
  data: {
    grantId: string;
    messageId: string;
    threadId: string;
  };
};

type NylasGrantExpiredEvent = {
  name: "nylas.grant_expired";
  data: {
    grantId: string;
  };
};

// ── Function: nylas.message_received ──────────────────────────────────────
// Delegates core logic to ingestNylasMessageFn for direct testability.

export const ingestNylasMessageJob = inngest.createFunction(
  {
    id: "ingest-nylas-message",
    name: "Ingest inbound Nylas message",
    retries: 3,
    triggers: [{ event: "nylas.message_received" }],
  },
  async ({ event, step }) => {
    const { grantId, messageId, threadId } =
      (event as unknown as NylasMessageReceivedEvent).data;

    const result = await step.run("ingest-message", async () => {
      const { ingestNylasMessageFn } = await import("./email/ingest-nylas-message");
      return ingestNylasMessageFn({ grantId, messageId, threadId });
    });

    logger.info({ messageId, result }, "nylas.message_received processed");
    return result;
  },
);

// ── Function: nylas.grant_expired ─────────────────────────────────────────

export const handleGrantExpiredJob = inngest.createFunction(
  {
    id: "handle-grant-expired",
    name: "Mark connected email account as error on grant expiry",
    retries: 2,
    triggers: [{ event: "nylas.grant_expired" }],
  },
  async ({ event, step }) => {
    const { grantId } = (event as unknown as NylasGrantExpiredEvent).data;

    await step.run("mark-account-error", async () => {
      await dbQuery(
        `UPDATE connected_email_accounts SET status = 'error' WHERE nylas_grant_id = $1`,
        [grantId],
      );

      const res = await dbQuery(
        `SELECT workspace_id, email_address FROM connected_email_accounts WHERE nylas_grant_id = $1 LIMIT 1`,
        [grantId],
      );
      if (res.rows.length) {
        const { workspace_id: workspaceId, email_address: emailAddress } =
          res.rows[0] as { workspace_id: string; email_address: string };
        await dbQuery(
          `INSERT INTO audit_logs (workspace_id, action, target_type, diff_json)
           VALUES ($1, 'email_account.revoked', 'connected_email_account', $2)`,
          [workspaceId, JSON.stringify({ grantId, emailAddress, reason: "grant_expired" })],
        );
        logger.info({ grantId, workspaceId, emailAddress }, "Grant expired — account marked error");
      }
    });

    return { grantId };
  },
);

export const functions = [
  parseResumeJob,
  parseJobJob,
  scoreApplicationJob,
  stageEnteredJob,
  sendSystemMentionEmailJob,
  ingestNylasMessageJob,
  handleGrantExpiredJob,
];
