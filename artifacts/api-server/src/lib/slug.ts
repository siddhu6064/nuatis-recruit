/**
 * Slug generation helpers for jobs.
 * Slugs are scoped per workspace — collisions are resolved by appending -2, -3, etc.
 */
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq, and, like } from "drizzle-orm";
import { jobsTable } from "@workspace/db";

function baseSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function generateJobSlug(db: NodePgDatabase<any>, workspaceId: string, title: string, excludeId?: string): Promise<string> {
  const base = baseSlug(title) || "job";

  const existing = await db
    .select({ slug: jobsTable.slug })
    .from(jobsTable)
    .where(
      and(
        eq(jobsTable.workspaceId, workspaceId),
        like(jobsTable.slug, `${base}%`),
      ),
    );

  const slugSet = new Set(
    existing
      .filter((r) => !excludeId)
      .map((r) => r.slug),
  );

  if (!slugSet.has(base)) return base;

  let counter = 2;
  while (slugSet.has(`${base}-${counter}`)) {
    counter++;
  }
  return `${base}-${counter}`;
}
