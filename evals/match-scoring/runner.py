"""
Match Scoring Eval Runner.

# TODO: ML engineer fills in cases; CI integration in Phase 6.

Usage:
    python3 evals/match-scoring/runner.py [--cases-dir cases/]

Each case JSON has:
    case_id, description, resume (ParsedResume dict), jd (ParsedJD dict),
    expected_band ("high"|"medium"|"low"),
    expected_score_min, expected_score_max

The runner calls POST /match by first writing the resume/jd to the DB
(or using a test fixture endpoint if available), then asserting the score band.
"""
import json
import os
import sys
from pathlib import Path

AI_SERVICE_URL = os.environ.get("AI_SERVICE_URL", "http://localhost:9000")
CASES_DIR = Path(__file__).parent / "cases"


def score_to_band(score: int) -> str:
    if score >= 75:
        return "high"
    if score >= 50:
        return "medium"
    return "low"


def run_eval():
    try:
        import httpx
    except ImportError:
        print("ERROR: httpx not installed. Run: pip install httpx")
        sys.exit(1)

    cases = sorted(CASES_DIR.glob("*.json")) if CASES_DIR.exists() else []
    if not cases:
        print("No cases found. Add files to evals/match-scoring/cases/ to run evals.")
        print("Exiting with 0 cases.")
        return

    results = []
    for case_path in cases:
        with open(case_path) as f:
            case = json.load(f)

        case_id = case.get("case_id", case_path.stem)
        expected_band = case.get("expected_band", "medium")
        score_min = case.get("expected_score_min", 0)
        score_max = case.get("expected_score_max", 100)

        # TODO: write resume/jd to DB as test fixtures, then call /match with real IDs
        # For now, this is a structure-only placeholder.
        print(f"SKIP {case_id}: DB fixture setup not yet implemented (ML engineer task)")
        results.append({"case_id": case_id, "status": "skip"})

    total = len(results)
    passed = sum(1 for r in results if r.get("status") == "pass")
    skipped = sum(1 for r in results if r.get("status") == "skip")
    print(f"\nMatch Scoring Eval: {passed}/{total} passed, {skipped} skipped")


if __name__ == "__main__":
    run_eval()
