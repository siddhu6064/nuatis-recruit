/**
 * lib/email/merge-fields.ts
 *
 * Pure merge-field interpolation engine. Zero external dependencies.
 *
 * Token syntax:  {{candidate.name}}, {{job.title}}, etc.
 * Regex: /\{\{\s*([a-z]+\.[a-zA-Z]+)\s*\}\}/g
 *
 * Rules:
 *   - Unknown token  → leave the literal {{...}} in place (surfaces author errors visibly).
 *   - Known token with missing/null value → replace with empty string.
 *   - candidate.firstName derives from the first whitespace-split word of candidate.name.
 *   - recruiter.firstName same derivation.
 *   - job.salaryRange: "$min – $max" if both present; "$min+" if only min; "" if neither.
 *
 * Adding a new token requires its own batch — do NOT expand the allowlist here.
 */

export type MergeContext = {
  candidate?: {
    name?: string | null;
    email?: string | null;
    currentTitle?: string | null;
    currentCompany?: string | null;
    location?: string | null;
  };
  job?: {
    title?: string | null;
    location?: string | null;
    salaryMin?: number | null;
    salaryMax?: number | null;
  };
  client?: {
    name?: string | null;
  };
  recruiter?: {
    name?: string | null;
    email?: string | null;
  };
};

// Explicit allowlist — adding a new token requires its own batch.
const KNOWN_TOKENS = new Set([
  "candidate.name",
  "candidate.firstName",
  "candidate.email",
  "candidate.currentTitle",
  "candidate.currentCompany",
  "candidate.location",
  "job.title",
  "job.location",
  "job.salaryRange",
  "client.name",
  "recruiter.name",
  "recruiter.firstName",
  "recruiter.email",
]);

const TOKEN_RE = /\{\{\s*([a-z]+\.[a-zA-Z]+)\s*\}\}/g;

function firstWord(name: string | null | undefined): string {
  if (!name) return "";
  return name.split(/\s+/)[0] ?? "";
}

function formatSalaryRange(
  min: number | null | undefined,
  max: number | null | undefined,
): string {
  if (min != null && max != null) {
    return `$${min.toLocaleString("en-US")} \u2013 $${max.toLocaleString("en-US")}`;
  }
  if (min != null) return `$${min.toLocaleString("en-US")}+`;
  return "";
}

function resolveKnownToken(token: string, ctx: MergeContext): string {
  switch (token) {
    case "candidate.name":          return ctx.candidate?.name ?? "";
    case "candidate.firstName":     return firstWord(ctx.candidate?.name);
    case "candidate.email":         return ctx.candidate?.email ?? "";
    case "candidate.currentTitle":  return ctx.candidate?.currentTitle ?? "";
    case "candidate.currentCompany": return ctx.candidate?.currentCompany ?? "";
    case "candidate.location":      return ctx.candidate?.location ?? "";
    case "job.title":               return ctx.job?.title ?? "";
    case "job.location":            return ctx.job?.location ?? "";
    case "job.salaryRange":         return formatSalaryRange(ctx.job?.salaryMin, ctx.job?.salaryMax);
    case "client.name":             return ctx.client?.name ?? "";
    case "recruiter.name":          return ctx.recruiter?.name ?? "";
    case "recruiter.firstName":     return firstWord(ctx.recruiter?.name);
    case "recruiter.email":         return ctx.recruiter?.email ?? "";
    default:                        return ""; // unreachable if caller checks KNOWN_TOKENS
  }
}

/**
 * Replace all known {{token}} references with resolved values.
 * Unknown tokens are left verbatim. Missing known fields resolve to "".
 */
export function interpolate(template: string, ctx: MergeContext): string {
  return template.replace(new RegExp(TOKEN_RE.source, "g"), (_match, token: string) => {
    if (!KNOWN_TOKENS.has(token)) return _match;
    return resolveKnownToken(token, ctx);
  });
}

/**
 * Return the list of {{token}} strings that appear in `template`, are known
 * tokens, but resolved to empty string given `ctx`. Used by the render
 * endpoint to surface soft warnings in the UI (missingTokens[]).
 */
export function getMissingTokens(template: string, ctx: MergeContext): string[] {
  const missing: string[] = [];
  const re = new RegExp(TOKEN_RE.source, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(template)) !== null) {
    const token = match[1]!;
    if (!KNOWN_TOKENS.has(token)) continue;
    if (resolveKnownToken(token, ctx) === "") {
      missing.push(`{{${token}}}`);
    }
  }
  // Deduplicate while preserving first-occurrence order
  return [...new Set(missing)];
}
