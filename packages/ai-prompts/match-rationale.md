# Match Rationale Prompt

version: 0.0.0-stub

TODO: human ML engineer / legal review owns this. See PRD section on match scoring for rationale format, evidence quote extraction, and fairness guardrails.

## Purpose

Given a numeric match score + breakdown (skills, experience, seniority, location), generate:
1. A 3–5 sentence plain-English rationale explaining WHY this candidate scored this way
2. Up to 5 `evidence_quotes` — verbatim excerpts from the resume that support the score

## Output Schema

See `MatchResult` in `artifacts/ai-server/main.py`:
- `rationale` (str) — recruiter-facing explanation (no PII, no protected-class language)
- `evidence_quotes` (list[str]) — direct resume quotes, max 100 chars each

## Constraints

1. The rationale MUST NOT mention age, gender, race, national origin, religion, disability, or any other protected class
2. Evidence quotes must be exact excerpts from the cleaned (bias-stripped) resume text, not from the raw text
3. Rationale should be affirmative where possible ("Strong Python background...") rather than deficit-framing ("Lacks Java...")
4. If score < 40, rationale should focus on what skills/experience WOULD improve the match, not on candidate deficiencies

## Deterministic Score Note

The numeric score is computed deterministically (see `/match` endpoint). The rationale prompt only fills in the human-readable explanation. Do NOT have the LLM re-compute the score.

## Bias Audit Integration Point

`strip_protected_signals(rationale_output)` should be run on the LLM response before storing. ML engineer owns this review loop.
