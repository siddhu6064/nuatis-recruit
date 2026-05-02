# Match Scoring Eval Harness

## Structure

```
evals/match-scoring/
├── README.md          # this file
├── runner.py          # eval runner (see below)
└── cases/             # 30 (resume_json, jd_json, expected_band) tuples
```

## Case Format

Each case is a JSON file in `cases/`:

```json
{
  "case_id": "001",
  "description": "Senior Python engineer applying to mid-level Python role",
  "resume": { ... ParsedResume-shaped ... },
  "jd": { ... ParsedJD-shaped ... },
  "expected_band": "high",   // "high" >= 75, "medium" 50-74, "low" < 50
  "expected_score_min": 70,
  "expected_score_max": 100
}
```

## Metrics

- **Band accuracy**: % of cases where score falls in expected_band
- **Score range accuracy**: % of cases where score is within [expected_score_min, expected_score_max]
- **Breakdown completeness**: all 4 breakdown keys present and sum within ±2 of total score

## Running

```bash
python3 evals/match-scoring/runner.py
```

## TODO

- ML engineer fills in 30 (resume, JD, expected_band) tuples
- CI integration in Phase 6
