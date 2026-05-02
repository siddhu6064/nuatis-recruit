/**
 * Public apply endpoint — no auth required.
 *
 * POST /api/public/apply
 *   - Resolves workspace_id from job slug (never trusts client-supplied workspace id)
 *   - Sets RLS context via SET LOCAL before any DB write
 *   - Validates file: MIME, extension, and magic-byte sniff (PDF/DOCX/TXT/RTF)
 *   - Find-or-create candidate by email within workspace (exact match)
 *   - Creates resumes, applications, activities rows
 *   - Rate-limited stub: 10 req/min per IP (workspace-scoped limiter is Phase 6)
 *
 * GET /api/public/jobs/:slug — returns job detail for public render
 */
import { Router, type IRouter, type Request, type Response } from "express";
import multer from "multer";
import rateLimit from "express-rate-limit";
import { pool, db, jobsTable, clientsTable, candidatesTable, applicationsTable, resumesTable, activitiesTable, auditLogsTable } from "@workspace/db";
import { inngest } from "../lib/inngest";
import { eq, and } from "drizzle-orm";
import { uploadResume } from "../lib/storage";
import { logger } from "../lib/logger";
import path from "path";

const router: IRouter = Router();

// ── Rate limiter stub (Phase 6 will add workspace-scoped variant) ──────────
const applyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many applications from this IP, try again in a minute." },
});

// ── Multer — memory storage, 10 MB limit ──────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

// ── Magic-byte sniff helpers ───────────────────────────────────────────────
const ALLOWED_EXTENSIONS = new Set([".pdf", ".docx", ".txt", ".rtf"]);
const ALLOWED_MIME = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
  "application/rtf",
  "text/rtf",
]);

function sniffMime(buf: Buffer): string | null {
  // PDF: %PDF
  if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return "application/pdf";
  // DOCX (PK zip header)
  if (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04)
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  // RTF: {\rt
  if (buf[0] === 0x7b && buf[1] === 0x5c && buf[2] === 0x72 && buf[3] === 0x74) return "application/rtf";
  // TXT — no reliable magic byte, allow if declared text/plain
  return null;
}

function validateResumeFile(file: Express.Multer.File): string | null {
  const ext = path.extname(file.originalname).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return `Extension '${ext}' not allowed. Must be PDF, DOCX, TXT, or RTF.`;
  }
  if (!ALLOWED_MIME.has(file.mimetype)) {
    return `MIME type '${file.mimetype}' not allowed.`;
  }
  const sniffed = sniffMime(file.buffer);
  if (sniffed && sniffed !== file.mimetype) {
    if (!(sniffed === "application/pdf" && file.mimetype === "application/pdf")) {
      // Be lenient on DOCX vs zip
      if (sniffed !== "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
          file.mimetype !== "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
        return `File content does not match declared MIME type.`;
      }
    }
  }
  return null;
}

// ── GET /api/public/jobs/:slug ─────────────────────────────────────────────
router.get("/public/jobs/:slug", async (req: Request, res: Response) => {
  const slug = String(req.params.slug);

  // No RLS context needed for a read that just looks up by slug (status=open)
  const [job] = await db
    .select({
      id: jobsTable.id,
      title: jobsTable.title,
      description: jobsTable.description,
      salaryMin: jobsTable.salaryMin,
      salaryMax: jobsTable.salaryMax,
      location: jobsTable.location,
      employmentType: jobsTable.employmentType,
      status: jobsTable.status,
      slug: jobsTable.slug,
      workspaceId: jobsTable.workspaceId,
      clientId: jobsTable.clientId,
      createdAt: jobsTable.createdAt,
    })
    .from(jobsTable)
    .where(and(eq(jobsTable.slug, slug), eq(jobsTable.status, "open")));

  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  const [client] = await db
    .select({ name: clientsTable.name })
    .from(clientsTable)
    .where(eq(clientsTable.id, job.clientId));

  res.json({
    ...job,
    clientName: client?.name ?? null,
    createdAt: job.createdAt?.toISOString() ?? null,
  });
});

// ── POST /api/public/apply ─────────────────────────────────────────────────
router.post(
  "/public/apply",
  applyLimiter,
  upload.single("resume"),
  async (req: Request, res: Response) => {
    const { slug, name, email, phone, coverLetter } = req.body as Record<string, string>;
    const file = req.file;

    if (!slug || !name?.trim() || !email?.trim()) {
      res.status(400).json({ error: "slug, name, and email are required" });
      return;
    }

    if (!email.includes("@")) {
      res.status(400).json({ error: "Invalid email address" });
      return;
    }

    if (!file) {
      res.status(400).json({ error: "resume file is required" });
      return;
    }

    const fileError = validateResumeFile(file);
    if (fileError) {
      res.status(415).json({ error: fileError });
      return;
    }

    // 1. Resolve job + workspaceId from slug (status must be 'open')
    const [job] = await db
      .select({
        id: jobsTable.id,
        workspaceId: jobsTable.workspaceId,
        title: jobsTable.title,
        status: jobsTable.status,
      })
      .from(jobsTable)
      .where(and(eq(jobsTable.slug, slug), eq(jobsTable.status, "open")));

    if (!job) {
      res.status(404).json({ error: "Job not found or is not currently accepting applications" });
      return;
    }

    const workspaceId = job.workspaceId;

    // 2. Acquire a dedicated client and set RLS context for this workspace
    const pgClient = await pool.connect();
    let committed = false;

    try {
      await pgClient.query("BEGIN");
      await pgClient.query(
        "SELECT set_config('app.current_workspace_id', $1, true)",
        [workspaceId],
      );

      // 3. Find or create candidate by email (exact match within workspace)
      let candidateId: string;
      let candidateCreated = false;

      const emailMatchResult = await pgClient.query<{ id: string }>(
        `SELECT id FROM candidates WHERE workspace_id = $1 AND $2 = ANY(emails) LIMIT 1`,
        [workspaceId, email.toLowerCase().trim()],
      );

      if (emailMatchResult.rows.length > 0) {
        candidateId = emailMatchResult.rows[0].id;
      } else {
        let candInsert: { rows: Array<{ id: string }> };
        if (phone?.trim()) {
          candInsert = await pgClient.query<{ id: string }>(
            `INSERT INTO candidates (workspace_id, name, emails, phones, source)
             VALUES ($1, $2, ARRAY[$3]::text[], ARRAY[$4]::text[], 'public_apply')
             RETURNING id`,
            [workspaceId, name.trim(), email.toLowerCase().trim(), phone.trim()],
          );
        } else {
          candInsert = await pgClient.query<{ id: string }>(
            `INSERT INTO candidates (workspace_id, name, emails, phones, source)
             VALUES ($1, $2, ARRAY[$3]::text[], '{}'::text[], 'public_apply')
             RETURNING id`,
            [workspaceId, name.trim(), email.toLowerCase().trim()],
          );
        }

        candidateId = candInsert.rows[0].id;
        candidateCreated = true;

        // Audit: candidate.create
        await pgClient.query(
          `INSERT INTO audit_logs (workspace_id, action, target_type, target_id, ip, user_agent)
           VALUES ($1, 'candidate.create', 'candidate', $2, $3, $4)`,
          [workspaceId, candidateId, req.ip ?? null, req.headers["user-agent"] ?? null],
        );
      }

      // 4. Check for duplicate application
      const dupCheck = await pgClient.query<{ id: string }>(
        `SELECT id FROM applications WHERE candidate_id = $1 AND job_id = $2 LIMIT 1`,
        [candidateId, job.id],
      );
      if (dupCheck.rows.length > 0) {
        await pgClient.query("ROLLBACK");
        res.status(409).json({ error: "You have already applied to this job." });
        return;
      }

      // 5. Upload resume
      const timestamp = Date.now();
      const sanitizedName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
      const filename = `${timestamp}_${sanitizedName}`;
      const fileUrl = await uploadResume(workspaceId!, filename, file.buffer, file.mimetype);

      // 6. Insert resume row
      const resumeInsert = await pgClient.query<{ id: string }>(
        `INSERT INTO resumes (workspace_id, candidate_id, file_url)
         VALUES ($1, $2, $3) RETURNING id`,
        [workspaceId, candidateId, fileUrl],
      );
      const resumeId = resumeInsert.rows[0].id;

      // 7. Create application
      const appInsert = await pgClient.query<{ id: string; applied_at: Date | null }>(
        `INSERT INTO applications (workspace_id, candidate_id, job_id, stage, source)
         VALUES ($1, $2, $3, 'applied', 'public_apply')
         RETURNING id, applied_at`,
        [workspaceId, candidateId, job.id],
      );
      const application = appInsert.rows[0];

      // 8. Activity row
      await pgClient.query(
        `INSERT INTO activities (workspace_id, candidate_id, type, payload)
         VALUES ($1, $2, 'application.created', $3::jsonb)`,
        [
          workspaceId,
          candidateId,
          JSON.stringify({
            applicationId: application.id,
            jobId: job.id,
            jobTitle: job.title,
            coverLetter: coverLetter?.trim() ?? null,
            resumeId,
          }),
        ],
      );

      // 9. Audit: application.create
      await pgClient.query(
        `INSERT INTO audit_logs (workspace_id, action, target_type, target_id, ip, user_agent)
         VALUES ($1, 'application.create', 'application', $2, $3, $4)`,
        [workspaceId, application.id, req.ip ?? null, req.headers["user-agent"] ?? null],
      );

      await pgClient.query("COMMIT");
      committed = true;

      logger.info(
        { jobId: job.id, candidateId, candidateCreated, applicationId: application.id },
        "Public application submitted",
      );

      // Send response immediately — HTTP client doesn't wait for Inngest
      res.status(201).json({
        applicationId: application.id,
        candidateId,
        appliedAt: application.applied_at?.toISOString() ?? new Date().toISOString(),
      });

      // Await Inngest events AFTER commit + response (response already flushed above)
      await inngest
        .send([
          {
            name: "resume.uploaded",
            data: {
              resumeId,
              candidateId,
              workspaceId: workspaceId!,
              fileUrl,
            },
          },
          {
            name: "application.created",
            data: {
              applicationId: application.id,
              candidateId,
              jobId: job.id,
              workspaceId: workspaceId!,
              resumeId,
            },
          },
        ])
        .catch((e: unknown) =>
          logger.warn({ err: e, applicationId: application.id }, "Inngest send failed"),
        );
    } catch (err) {
      if (!committed) {
        try {
          await pgClient.query("ROLLBACK");
        } catch {
          // ignore
        }
      }
      logger.error({ err }, "Public apply error");
      res.status(500).json({ error: "Internal server error" });
    } finally {
      if (!committed) {
        // noop — already handled above
      }
      pgClient.release();
    }
  },
);

export default router;
