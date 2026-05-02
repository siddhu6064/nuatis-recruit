# Job Description Parser Prompt

version: 0.0.0-stub

TODO: human ML engineer owns this. See PRD section on JD parsing for output schema and edge cases (legal boilerplate, buzzword inflation, implicit seniority signals).

## Expected Output Schema

See `ParsedJD` in `artifacts/ai-server/main.py` for the full Pydantic v2 schema.

Fields:
- `required_skills` (list[str]) — must-have technical skills, normalized lowercase
- `nice_to_have_skills` (list[str]) — bonus/preferred skills
- `seniority_level` (Literal) — one of: junior, mid, senior, staff, principal, exec
- `key_responsibilities` (list[str]) — 3–8 bullets
- `must_haves` (list[str]) — non-negotiable requirements (years experience, certifications, etc.)
- `protected_class_flags` (list[FlaggedTerm]) — terms that may signal bias (e.g., "young and energetic") — empty list in stub

## Edge Cases to Handle

1. Seniority mismatch — JD says "Senior" but lists only 1 year experience requirement; flag this
2. Buzzword inflation — "rockstar", "ninja", "10x" — normalize to standard seniority signals
3. Implicit skill requirements — "you'll work with our ML platform" → implies Python/ML skills
4. Legal boilerplate — EOE statements should not be parsed as requirements
5. Salary ranges embedded in JD — extract and surface separately

## Bias Audit Integration Point

`protected_class_flags` should be populated by the ML engineer's legal-reviewed taxonomy. The stub always returns `[]`.
