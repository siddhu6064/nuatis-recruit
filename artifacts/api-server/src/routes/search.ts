/**
 * Hybrid candidate search
 *
 * GET /api/candidates/search?q=...&cursor=...&stage=...&source=...
 *
 * Algorithm:
 *   - Full-text search via candidates.search_vector (GIN-indexed tsvector)
 *     using ts_rank_cd.
 *   - Semantic search via candidates.embedding (HNSW cosine) when query > 3 words
 *     AND pgvector is available.
 *   - Combined score: 0.6 * norm_fts_rank + 0.4 * norm_cosine_sim
 *   - Cursor pagination: cursor = base64(offset) internally.
 *   - Page size: 25.
 *   - Query embedding cached in-memory for 1h by trimmed-lowercase key.
 *
 * Filters:
 *   stage   — filters candidates who have any application in this stage
 *   source  — filters by candidates.source
 *
 * NOTE: params are built dynamically so only referenced params are passed to
 * pg — PostgreSQL errors (42P18) if a param is supplied but never referenced
 * in the query text and it cannot infer the type.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import { requireAuth } from "@workspace/auth";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const AI_SERVER = "http://localhost:9000";
const PAGE_SIZE = 25;

// ── In-memory embedding cache (Redis later) ───────────────────────────────

type CacheEntry = { vec: number[]; exp: number };
const embedCache = new Map<string, CacheEntry>();
const EMBED_TTL = 60 * 60 * 1000;

async function getQueryEmbedding(q: string): Promise<number[] | null> {
  const key = q.trim().toLowerCase();
  const hit = embedCache.get(key);
  if (hit && hit.exp > Date.now()) return hit.vec;

  try {
    const r = await fetch(`${AI_SERVER}/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: q }),
      signal: AbortSignal.timeout(2000),
    });
    if (!r.ok) return null;
    const data = (await r.json()) as { embedding: number[] };
    embedCache.set(key, { vec: data.embedding, exp: Date.now() + EMBED_TTL });
    return data.embedding;
  } catch {
    return null;
  }
}

// ── GET /api/candidates/search ────────────────────────────────────────────

router.get("/candidates/search", async (req: Request, res: Response) => {
  const user = requireAuth(req, res);
  if (!user) return;

  const q = String(req.query.q ?? "").trim();
  if (!q) {
    res.status(400).json({ error: "q is required" });
    return;
  }

  const cursorRaw = String(req.query.cursor ?? "");
  const offset = cursorRaw
    ? parseInt(Buffer.from(cursorRaw, "base64").toString("utf8"), 10) || 0
    : 0;

  const stageFilter = req.query.stage ? String(req.query.stage) : null;
  const sourceFilter = req.query.source ? String(req.query.source) : null;

  const wordCount = q.split(/\s+/).filter(Boolean).length;
  const useSemanticSearch = wordCount > 3;

  let embedding: number[] | null = null;
  if (useSemanticSearch) {
    embedding = await getQueryEmbedding(q).catch(() => null);
  }

  const client = await pool.connect();
  const start = Date.now();
  try {
    await client.query("BEGIN");
    await client.query(
      `SELECT set_config('app.current_workspace_id', $1, true),
              set_config('app.current_user_id', $2, true)`,
      [user.workspaceId, user.id],
    );

    const vecStr = embedding ? `[${embedding.join(",")}]` : null;
    const hasPgvector = vecStr !== null;

    // Build params dynamically — only include params that are referenced in
    // the query text. PostgreSQL cannot infer the type of unreferenced params.
    // Fixed positions: $1=q, $2=workspaceId, $3=hasPgvector, $4=vecStr
    const params: unknown[] = [q, user.workspaceId, hasPgvector, vecStr];

    let stageClause = "";
    if (stageFilter) {
      params.push(stageFilter);
      stageClause = `AND EXISTS (
        SELECT 1 FROM applications a
        WHERE a.candidate_id = c.id
          AND a.workspace_id = $2
          AND a.stage = $${params.length}
      )`;
    }

    let sourceClause = "";
    if (sourceFilter) {
      params.push(sourceFilter);
      sourceClause = `AND c.source = $${params.length}`;
    }

    params.push(PAGE_SIZE + 1);
    const limitPos = params.length;
    params.push(offset);
    const offsetPos = params.length;

    const result = await client.query<{
      id: string;
      name: string;
      current_title: string | null;
      current_company: string | null;
      source: string | null;
      last_activity_at: Date | null;
      created_at: Date | null;
      fts_rank: number;
      cos_sim: number | null;
      combined_score: number;
    }>(
      `
      WITH base AS (
        SELECT
          c.id,
          c.name,
          c.current_title,
          c.current_company,
          c.source,
          c.last_activity_at,
          c.created_at,
          ts_rank_cd(c.search_vector, plainto_tsquery('english', $1)) AS fts_rank,
          CASE
            WHEN $3::boolean AND c.embedding IS NOT NULL
            THEN 1.0 - (c.embedding <=> $4::vector)
            ELSE NULL
          END AS cos_sim
        FROM candidates c
        WHERE c.workspace_id = $2
          AND c.search_vector @@ plainto_tsquery('english', $1)
          ${stageClause}
          ${sourceClause}
        ORDER BY fts_rank DESC
        LIMIT 200
      ),
      stats AS (
        SELECT
          MIN(fts_rank) AS min_fts, MAX(fts_rank) AS max_fts,
          MIN(cos_sim)  AS min_cos, MAX(cos_sim)  AS max_cos
        FROM base
      ),
      scored AS (
        SELECT
          b.*,
          CASE
            WHEN s.max_fts = s.min_fts THEN 1.0
            ELSE (b.fts_rank - s.min_fts) / NULLIF(s.max_fts - s.min_fts, 0)
          END AS norm_fts,
          CASE
            WHEN b.cos_sim IS NULL THEN 0.0
            WHEN s.max_cos = s.min_cos THEN 1.0
            ELSE (b.cos_sim - s.min_cos) / NULLIF(s.max_cos - s.min_cos, 0)
          END AS norm_cos
        FROM base b CROSS JOIN stats s
      )
      SELECT
        id, name, current_title, current_company, source,
        last_activity_at, created_at,
        fts_rank, cos_sim,
        CASE
          WHEN cos_sim IS NOT NULL
          THEN 0.6 * norm_fts + 0.4 * norm_cos
          ELSE norm_fts
        END AS combined_score
      FROM scored
      ORDER BY combined_score DESC, created_at DESC
      LIMIT $${limitPos} OFFSET $${offsetPos}
      `,
      params,
    );

    await client.query("COMMIT");

    const latency = Date.now() - start;
    logger.info({ q, latency, rows: result.rows.length, semantic: hasPgvector }, "Search completed");

    const rows = result.rows;
    const hasNext = rows.length > PAGE_SIZE;
    const page = rows.slice(0, PAGE_SIZE);

    const nextOffset = hasNext ? offset + PAGE_SIZE : null;
    const nextCursor = nextOffset !== null
      ? Buffer.from(String(nextOffset)).toString("base64")
      : null;

    res.json({
      candidates: page.map((r) => ({
        id: r.id,
        name: r.name,
        currentTitle: r.current_title,
        currentCompany: r.current_company,
        source: r.source,
        lastActivityAt: r.last_activity_at?.toISOString() ?? null,
        createdAt: r.created_at?.toISOString() ?? null,
        score: Math.round(Number(r.combined_score) * 100) / 100,
      })),
      nextCursor,
      latencyMs: latency,
    });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    logger.error({ err }, "Search error");
    res.status(500).json({ error: "Search failed" });
  } finally {
    client.release();
  }
});

export default router;
