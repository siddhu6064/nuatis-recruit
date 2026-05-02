# Resume Parser Eval Harness

## Structure

```
evals/resume-parser/
├── README.md          # this file
├── runner.py          # eval runner (see below)
├── samples/           # 50 sample resume files (PDF/DOCX/TXT)
└── expected/          # corresponding expected ParsedResume JSON outputs
```

## Sample Format

Each sample in `samples/` maps 1:1 to a JSON file in `expected/` with the same base name:

```
samples/001_senior_swe.pdf  →  expected/001_senior_swe.json
```

Each `expected/*.json` file contains a `ParsedResume`-shaped object. Fields may be `null` where ground truth is ambiguous.

## Metrics

- **Field accuracy**: per-field exact match rate across all samples
- **Skills recall**: `|extracted ∩ expected| / |expected|`
- **Skills precision**: `|extracted ∩ expected| / |extracted|`
- **Name accuracy**: exact match (case-insensitive)
- **Seniority accuracy**: exact level match

## Running

```bash
python3 evals/resume-parser/runner.py
```

## TODO

- ML engineer fills in 50 sample/expected pairs
- CI integration in Phase 6
