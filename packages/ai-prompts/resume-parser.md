# Resume Parser Prompt

version: 0.0.0-stub

TODO: human ML engineer owns this. See PRD section on resume parsing for output schema and edge cases (multi-column layouts, non-English names, scanned PDFs).

## Expected Output Schema

See `ParsedResume` in `artifacts/ai-server/main.py` for the full Pydantic v2 schema.

Fields:
- `name` (str) — candidate full name
- `contact_email` (str | None)
- `contact_phone` (str | None)
- `location` (str | None) — city/region, NOT full address
- `summary` (str | None) — 2–4 sentence professional summary
- `work_history` (list[WorkHistoryItem]) — chronological, most-recent first
- `education` (list[EducationItem])
- `skills` (list[str]) — normalized lowercase skill tokens
- `links` (list[str]) — GitHub, LinkedIn, portfolio URLs
- `confidence` (float 0-1) — overall parse confidence

## Edge Cases to Handle

1. Multi-column PDF layouts — pypdf may concatenate columns incorrectly; ML engineer should consider a layout-aware parser
2. Non-English names — do not anglicize; preserve Unicode
3. Scanned PDFs — OCR_NOT_IMPLEMENTED is returned; ML engineer to integrate a real OCR service
4. Date formats — normalize to YYYY-MM (e.g., "January 2020" → "2020-01")
5. Multiple roles at same company — expand into separate WorkHistoryItem entries

## Bias Audit Integration Point

`strip_protected_signals(text)` is called BEFORE this prompt. The ML engineer must ensure the prompt itself does not re-introduce protected-class signals from the raw text.
