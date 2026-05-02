"""
Resume Parser Eval Runner.

# TODO: ML engineer fills in cases; CI integration in Phase 6.

Usage:
    python3 evals/resume-parser/runner.py [--samples-dir samples/] [--expected-dir expected/]

Expected directory structure:
    samples/001_senior_swe.pdf
    expected/001_senior_swe.json   <- ParsedResume-shaped dict

Metrics reported:
    - per-field accuracy
    - skills precision/recall
    - overall pass rate
"""
import json
import os
import sys
import time
from pathlib import Path

AI_SERVICE_URL = os.environ.get("AI_SERVICE_URL", "http://localhost:9000")
SAMPLES_DIR = Path(__file__).parent / "samples"
EXPECTED_DIR = Path(__file__).parent / "expected"


def run_eval():
    try:
        import httpx
    except ImportError:
        print("ERROR: httpx not installed. Run: pip install httpx")
        sys.exit(1)

    samples = sorted(SAMPLES_DIR.glob("*")) if SAMPLES_DIR.exists() else []
    if not samples:
        print("No samples found. Add files to evals/resume-parser/samples/ to run evals.")
        print("Exiting with 0 cases.")
        return

    results = []
    for sample_path in samples:
        expected_path = EXPECTED_DIR / (sample_path.stem + ".json")
        if not expected_path.exists():
            print(f"SKIP {sample_path.name}: no expected file at {expected_path}")
            continue

        with open(expected_path) as f:
            expected = json.load(f)

        # TODO: for real file uploads, use a presigned URL or direct POST with file bytes
        resp = httpx.post(
            f"{AI_SERVICE_URL}/parse/resume",
            json={"file_url": str(sample_path.resolve())},
            timeout=30,
        )
        if resp.status_code != 200:
            print(f"FAIL {sample_path.name}: HTTP {resp.status_code}")
            results.append({"file": sample_path.name, "pass": False, "error": resp.text})
            continue

        actual = resp.json()
        case_pass = True
        field_errors = []

        # Name check
        if expected.get("name") and actual.get("name", "").lower() != expected["name"].lower():
            case_pass = False
            field_errors.append(f"name: expected={expected['name']!r} got={actual.get('name')!r}")

        # Skills recall/precision
        exp_skills = set(s.lower() for s in (expected.get("skills") or []))
        act_skills = set(s.lower() for s in (actual.get("skills") or []))
        if exp_skills:
            recall = len(exp_skills & act_skills) / len(exp_skills)
            precision = len(exp_skills & act_skills) / len(act_skills) if act_skills else 0.0
            if recall < 0.5:
                case_pass = False
                field_errors.append(f"skills recall={recall:.2f} (< 0.5)")

        results.append({
            "file": sample_path.name,
            "pass": case_pass,
            "errors": field_errors,
        })

    total = len(results)
    passed = sum(1 for r in results if r["pass"])
    print(f"\nResume Parser Eval: {passed}/{total} passed")
    for r in results:
        status = "PASS" if r["pass"] else "FAIL"
        errs = "; ".join(r.get("errors", []))
        print(f"  [{status}] {r['file']}" + (f" — {errs}" if errs else ""))


if __name__ == "__main__":
    run_eval()
