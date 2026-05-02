/**
 * Inngest client + function definitions for Nuatis Recruit.
 *
 * Three durable functions:
 *   a. resume.uploaded  → parse resume → embed → update candidates
 *   b. job.created      → parse JD → embed → update jobs
 *   c. application.created → match → upsert match_scores
 *
 * All LLM calls inside the AI service are STUBBED (see artifacts/ai-server).
 * Failures retry 3× with exponential backoff.
 */
import { Inngest } from "inngest";
import { logger } from "./logger";

const AI_BASE = process.env.AI_SERVICE_URL ?? "http://localhost:9000";

export const inngest = new Inngest({ id: "nuatis-recruit" });

// ── Helper: call AI service endpoints ─────────────────────────────────────

async function callAI<T>(
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
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

// ── DB helper (raw pg — avoids RLS SET ROLE for background jobs) ───────────

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
      return callAI<{ vector: number[]; model_version: string }>("/embed", {
        text,
      });
    });

    await step.run("save-parsed-resume", async () => {
      await dbQuery(
        `UPDATE resumes SET parsed = $1, parser_version = $2 WHERE id = $3`,
        [JSON.stringify(parsed), parsed.model_version ?? "stub", resumeId],
      );
      // Store parsed_resume on candidate for quick access in /match
      await dbQuery(
        `UPDATE candidates SET parsed_resume = $1 WHERE id = $2`,
        [JSON.stringify(parsed), candidateId],
      );
      logger.info({ resumeId, candidateId }, "Parsed resume saved");
    });

    await step.run("save-embedding", async () => {
      // Only write if pgvector extension is present (column may not exist in older envs)
      try {
        await dbQuery(
          `UPDATE candidates SET embedding = $1::vector WHERE id = $2`,
          [`[${embedResult.vector.join(",")}]`, candidateId],
        );
        logger.info({ candidateId }, "Candidate embedding saved");
      } catch (err) {
        // [SENTRY] TODO: route to Sentry once set up
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
      return callAI<{ vector: number[]; model_version: string }>("/embed", {
        text,
      });
    });

    await step.run("save-parsed-jd", async () => {
      await dbQuery(
        `UPDATE jobs SET parsed_jd = $1 WHERE id = $2`,
        [JSON.stringify(parsedJD), jobId],
      );
      logger.info({ jobId }, "Parsed JD saved");
    });

    await step.run("save-job-embedding", async () => {
      try {
        await dbQuery(
          `UPDATE jobs SET embedding = $1::vector WHERE id = $2`,
          [`[${embedResult.vector.join(",")}]`, jobId],
        );
        logger.info({ jobId }, "Job embedding saved");
      } catch (err) {
        // [SENTRY] TODO: route to Sentry once set up
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

    // Find the most recent resume for this candidate if none supplied
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
         ON CONFLICT (application_id)
         DO UPDATE SET
           score = EXCLUDED.score,
           breakdown = EXCLUDED.breakdown,
           rationale = EXCLUDED.rationale,
           evidence_quotes = EXCLUDED.evidence_quotes,
           model_version = EXCLUDED.model_version,
           created_at = now()`,
        [
          workspaceId,
          applicationId,
          matchResult.score,
          JSON.stringify(matchResult.breakdown),
          matchResult.rationale,
          JSON.stringify(matchResult.evidence_quotes),
          matchResult.model_version,
        ],
      );
      logger.info({ applicationId, score: matchResult.score }, "Match score upserted");
    });

    return { applicationId, score: matchResult.score };
  },
);

export const functions = [parseResumeJob, parseJobJob, scoreApplicationJob];
