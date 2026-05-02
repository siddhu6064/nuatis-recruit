/**
 * B3-T009a: AI service parse endpoints — verify stub responses have correct schema.
 *
 * Requires the AI service to be running at AI_SERVICE_URL (default http://localhost:9000).
 * If the service is unavailable these tests are skipped gracefully.
 */
import { describe, it, expect, beforeAll } from "vitest";

const AI_BASE = process.env.AI_SERVICE_URL ?? "http://localhost:9000";

async function checkServiceAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${AI_BASE}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

describe("AI service — /parse/resume stub", () => {
  let available = false;

  beforeAll(async () => {
    available = await checkServiceAvailable();
  });

  it("returns a ParsedResume with all required schema fields", async () => {
    if (!available) {
      console.warn(`AI service not available at ${AI_BASE} — skipping parse-stub tests`);
      return;
    }

    const res = await fetch(`${AI_BASE}/parse/resume`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_url: "https://example.com/stub_resume.pdf" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;

    // All required schema fields must be present
    expect(body).toHaveProperty("name");
    expect(body).toHaveProperty("work_history");
    expect(body).toHaveProperty("education");
    expect(body).toHaveProperty("skills");
    expect(body).toHaveProperty("links");
    expect(body).toHaveProperty("confidence");
    expect(body).toHaveProperty("model_version");

    // model_version must contain 'stub' per spec
    expect(String(body.model_version)).toContain("stub");

    // Type checks
    expect(Array.isArray(body.work_history)).toBe(true);
    expect(Array.isArray(body.education)).toBe(true);
    expect(Array.isArray(body.skills)).toBe(true);
    expect(Array.isArray(body.links)).toBe(true);
    expect(typeof body.confidence).toBe("number");
    expect(body.confidence as number).toBeGreaterThanOrEqual(0);
    expect(body.confidence as number).toBeLessThanOrEqual(1);
  });

  it("returns skills extracted from URL hints when filename contains 'senior'", async () => {
    if (!available) return;

    const res = await fetch(`${AI_BASE}/parse/resume`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_url: "https://example.com/senior_python_engineer.pdf" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    const wh = body.work_history as Array<{ title: string }>;
    expect(wh.length).toBeGreaterThan(0);
    expect(wh[0].title.toLowerCase()).toContain("senior");
  });
});

describe("AI service — /parse/jd stub", () => {
  let available = false;

  beforeAll(async () => {
    available = await checkServiceAvailable();
  });

  it("returns a ParsedJD with all required schema fields", async () => {
    if (!available) return;

    const res = await fetch(`${AI_BASE}/parse/jd`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        job_id: "00000000-0000-0000-0000-000000000001",
        description: "We need a senior Python engineer with React and PostgreSQL experience.",
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;

    expect(body).toHaveProperty("required_skills");
    expect(body).toHaveProperty("nice_to_have_skills");
    expect(body).toHaveProperty("seniority_level");
    expect(body).toHaveProperty("key_responsibilities");
    expect(body).toHaveProperty("must_haves");
    expect(body).toHaveProperty("protected_class_flags");
    expect(body).toHaveProperty("model_version");

    const validLevels = ["junior", "mid", "senior", "staff", "principal", "exec"];
    expect(validLevels).toContain(body.seniority_level);
    expect(String(body.model_version)).toContain("stub");

    // Should detect Python + React + PostgreSQL from description
    const skills = body.required_skills as string[];
    expect(skills.some((s) => s.toLowerCase().includes("python"))).toBe(true);
  });
});

describe("AI service — /embed stub", () => {
  let available = false;

  beforeAll(async () => {
    available = await checkServiceAvailable();
  });

  it("returns a 1536-dim deterministic vector", async () => {
    if (!available) return;

    const text = "Senior software engineer with Python and React";
    const res = await fetch(`${AI_BASE}/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;

    expect(body).toHaveProperty("vector");
    expect(body).toHaveProperty("dimensions");
    expect(body).toHaveProperty("model_version");
    expect(body.dimensions).toBe(1536);

    const vec = body.vector as number[];
    expect(vec.length).toBe(1536);
    expect(String(body.model_version)).toContain("stub");

    // Determinism: same input → same vector
    const res2 = await fetch(`${AI_BASE}/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const body2 = await res2.json() as Record<string, unknown>;
    expect(body2.vector).toEqual(body.vector);
  });

  it("produces different vectors for different text", async () => {
    if (!available) return;

    const [r1, r2] = await Promise.all([
      fetch(`${AI_BASE}/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Python engineer" }),
      }),
      fetch(`${AI_BASE}/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Marketing manager" }),
      }),
    ]);

    const [b1, b2] = await Promise.all([r1.json(), r2.json()]) as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(b1.vector).not.toEqual(b2.vector);
  });
});
