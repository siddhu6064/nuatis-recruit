"""
Nuatis AI Service — Batch 3 scaffold.

All LLM call sites are STUBBED — a human ML engineer owns the actual prompts.
Deterministic scoring math (skills overlap, experience, seniority, location) IS real.
"""
import hashlib
import json
import logging
import os
import struct
import time
import uuid
from typing import Literal

import httpx
import psycopg2
import psycopg2.extras
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

# ── Optional SDK imports (not called — present for ML engineer hand-off) ──────
try:
    import anthropic as _anthropic  # noqa: F401  # TODO: wire real prompts
except ImportError:
    pass
try:
    import openai as _openai  # noqa: F401  # TODO: wire real embeddings
except ImportError:
    pass

logging.basicConfig(level=logging.INFO, format="%(message)s")
log = logging.getLogger("nuatis-ai")

DATABASE_URL = os.environ.get("DATABASE_URL", "")

app = FastAPI(title="Nuatis AI Service", version="0.3.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["https://*.replit.dev", "https://*.repl.co", "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


# ── Structured request logging ─────────────────────────────────────────────────

def structured_log(request_id: str, endpoint: str, latency_ms: float, status: int, **extra):
    log.info(json.dumps({
        "request_id": request_id,
        "endpoint": endpoint,
        "latency_ms": round(latency_ms, 2),
        "status": status,
        **extra,
    }))


# ── DB helper ──────────────────────────────────────────────────────────────────

def get_db_conn():
    if not DATABASE_URL:
        raise RuntimeError("DATABASE_URL not configured")
    return psycopg2.connect(DATABASE_URL, cursor_factory=psycopg2.extras.RealDictCursor)


# ── Bias audit stub ────────────────────────────────────────────────────────────

def strip_protected_signals(text: str) -> tuple[str, list[str]]:
    """
    STUB — returns (text, []) with no signals stripped.
    # TODO: human ML engineer / legal review owns the protected-class taxonomy.
    When a non-empty list is returned, the caller MUST insert a fairness_audit_log row.
    """
    return text, []


def record_fairness_audit(
    workspace_id: str | None, target_type: str, target_id: str, signals: list[str]
):
    """Insert a fairness_audit_log row when protected signals were stripped."""
    if not signals or not DATABASE_URL or not workspace_id:
        return
    try:
        conn = get_db_conn()
        with conn.cursor() as cur:
            cur.execute(
                """INSERT INTO fairness_audit_log
                     (workspace_id, target_type, target_id, signals_stripped)
                   VALUES (%s, %s, %s, %s)""",
                (workspace_id, target_type, target_id, json.dumps(signals)),
            )
        conn.commit()
        conn.close()
    except Exception as e:
        log.warning(f"fairness_audit_log write failed: {e}")


# ── Pydantic schemas ───────────────────────────────────────────────────────────

class WorkHistoryItem(BaseModel):
    title: str
    company: str
    start_date: str
    end_date: str | None = None
    description: str = ""
    current: bool = False


class EducationItem(BaseModel):
    institution: str
    degree: str
    field: str
    year: int | None = None


class FlaggedTerm(BaseModel):
    term: str
    context: str


class ParsedResume(BaseModel):
    name: str
    contact_email: str | None = None
    contact_phone: str | None = None
    location: str | None = None
    summary: str | None = None
    work_history: list[WorkHistoryItem] = []
    education: list[EducationItem] = []
    skills: list[str] = []
    links: list[str] = []
    confidence: float = Field(default=0.5, ge=0.0, le=1.0)
    model_version: str = "claude-sonnet-4-7-stub"


class ParsedJD(BaseModel):
    required_skills: list[str] = []
    nice_to_have_skills: list[str] = []
    seniority_level: Literal["junior", "mid", "senior", "staff", "principal", "exec"] = "mid"
    key_responsibilities: list[str] = []
    must_haves: list[str] = []
    protected_class_flags: list[FlaggedTerm] = []
    model_version: str = "claude-sonnet-4-7-stub"


class MatchBreakdown(BaseModel):
    skills: float = 0
    experience: float = 0
    seniority: float = 0
    location: float = 0


class MatchResult(BaseModel):
    score: int
    breakdown: MatchBreakdown
    rationale: str
    evidence_quotes: list[str] = []
    model_version: str = "claude-sonnet-4-7-stub"


class EmbedResult(BaseModel):
    vector: list[float]
    dimensions: int
    model_version: str = "text-embedding-3-large-stub"


# ── Request bodies ─────────────────────────────────────────────────────────────

class ParseResumeRequest(BaseModel):
    file_url: str
    candidate_id: str | None = None
    workspace_id: str | None = None


class ParseJDRequest(BaseModel):
    job_id: str
    description: str
    workspace_id: str | None = None


class EmbedRequest(BaseModel):
    text: str


class MatchRequest(BaseModel):
    resume_id: str
    job_id: str
    workspace_id: str | None = None


# ── Helpers ────────────────────────────────────────────────────────────────────

SENIORITY_LEVELS = ["junior", "mid", "senior", "staff", "principal", "exec"]
ADJACENT: dict[str, set[str]] = {
    "junior": {"mid"},
    "mid": {"junior", "senior"},
    "senior": {"mid", "staff"},
    "staff": {"senior", "principal"},
    "principal": {"staff", "exec"},
    "exec": {"principal"},
}

SKILL_PATTERNS = [
    "python", "javascript", "typescript", "react", "node", "java",
    "go", "rust", "ruby", "php", "swift", "kotlin",
    "aws", "gcp", "azure", "docker", "kubernetes", "terraform",
    "sql", "postgresql", "mysql", "mongodb", "redis", "elasticsearch",
    "machine learning", "deep learning", "nlp", "llm", "pytorch", "tensorflow",
    "fastapi", "django", "flask", "express", "spring", "rails",
    "graphql", "rest", "grpc", "kafka", "rabbitmq",
    "git", "linux", "bash", "devops", "agile", "scrum",
]


def extract_skills_from_text(text: str) -> list[str]:
    import re
    found = []
    lower = text.lower()
    for skill in SKILL_PATTERNS:
        if re.search(r'\b' + re.escape(skill) + r'\b', lower):
            found.append(skill)
    return found


def guess_seniority(text: str) -> Literal["junior", "mid", "senior", "staff", "principal", "exec"]:
    lower = text.lower()
    word_count = len(text.split())
    if any(w in lower for w in ["staff engineer", "principal"]):
        return "staff"
    if any(w in lower for w in ["exec", "vp ", "vice president", "cto", "ceo"]):
        return "exec"
    if any(w in lower for w in ["senior", "sr.", "lead", "tech lead"]):
        return "senior"
    if any(w in lower for w in ["junior", "jr.", "entry level", "entry-level", "new grad"]):
        return "junior"
    if word_count > 300:
        return "senior"
    return "mid"


def deterministic_fake_vector(text: str, dims: int = 1536) -> list[float]:
    """
    STUB — deterministic fake vector seeded by hash(text).
    Same text always produces the same vector for test stability.
    # TODO: replace with OpenAI text-embedding-3-large call.
    model_version: text-embedding-3-large-stub (contains 'stub' for future re-embed targeting)
    """
    digest = hashlib.sha256(text.encode()).digest()
    seed = int.from_bytes(digest[:4], "big")
    values: list[float] = []
    current = seed
    i = 0
    while len(values) < dims:
        packed = struct.pack(">QQ", current, i)
        chunk = hashlib.sha256(packed).digest()
        for j in range(0, len(chunk) - 3, 4):
            raw = struct.unpack(">I", chunk[j : j + 4])[0]
            val = (raw / 0xFFFFFFFF) * 2.0 - 1.0
            values.append(val)
            if len(values) >= dims:
                break
        current = (
            current * 6364136223846793005 + 1442695040888963407
        ) & 0xFFFFFFFFFFFFFFFF
        i += 1
    magnitude = sum(v * v for v in values) ** 0.5
    if magnitude > 0:
        values = [v / magnitude for v in values]
    return values[:dims]


def download_file_text(file_url: str) -> str:
    """Download a file and extract text. Handles PDF, DOCX, plain text."""
    try:
        if file_url.startswith("http://") or file_url.startswith("https://"):
            resp = httpx.get(file_url, timeout=15)
            resp.raise_for_status()
            content = resp.content
        else:
            log.warning(f"Non-HTTP file_url '{file_url}' — returning stub text")
            return f"STUB_CONTENT_FROM_{file_url}"

        if file_url.lower().endswith(".pdf") or content[:4] == b"%PDF":
            try:
                import io
                from pypdf import PdfReader
                reader = PdfReader(io.BytesIO(content))
                pages = [p.extract_text() or "" for p in reader.pages]
                extracted = "\n".join(pages).strip()
                if not extracted:
                    log.warning("PDF appears image-based — OCR_NOT_IMPLEMENTED")
                    return "OCR_NOT_IMPLEMENTED"
                return extracted
            except Exception as e:
                log.warning(f"PDF parse failed: {e}")
                return f"PDF_PARSE_ERROR: {e}"

        if file_url.lower().endswith(".docx"):
            try:
                import io
                from docx import Document
                doc = Document(io.BytesIO(content))
                return "\n".join(p.text for p in doc.paragraphs)
            except Exception as e:
                log.warning(f"DOCX parse failed: {e}")
                return f"DOCX_PARSE_ERROR: {e}"

        return content.decode("utf-8", errors="replace")
    except Exception as e:
        log.warning(f"File download failed for {file_url}: {e}")
        return f"DOWNLOAD_ERROR: {e}"


# ── Endpoints ──────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    from datetime import datetime, timezone
    return {
        "status": "ok",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "version": "0.3.0",
    }


@app.post("/parse/resume", response_model=ParsedResume)
async def parse_resume(body: ParseResumeRequest, request: Request):
    t0 = time.monotonic()
    req_id = str(uuid.uuid4())
    file_url = body.file_url

    raw_text = download_file_text(file_url)
    # Bias audit — strip protected signals before LLM call
    # TODO: human ML engineer / legal review owns the protected-class taxonomy
    cleaned_text, stripped_signals = strip_protected_signals(raw_text)
    if stripped_signals:
        record_fairness_audit(body.workspace_id, "resume", file_url, stripped_signals)

    fname = file_url.split("/")[-1].lower()
    seniority_hint = "senior" if "senior" in fname else "mid"
    skills_in_text = extract_skills_from_text(cleaned_text)

    # ── STUB: LLM call site ──────────────────────────────────────────────────
    # TODO: human ML engineer owns this prompt — see packages/ai-prompts/resume-parser.md
    # When ready: call Anthropic Claude with the extracted text and structured output schema.
    # current_model = "claude-sonnet-4-5"
    # result = anthropic_client.messages.create(model=current_model, ...)
    # TODO: Portkey routing in Phase 6
    # ─────────────────────────────────────────────────────────────────────────

    result = ParsedResume(
        name="Stub Candidate",
        contact_email="candidate@example.com",
        contact_phone="+1-555-0100",
        location="San Francisco, CA",
        summary="Stub resume summary. ML engineer will replace with Claude-parsed output.",
        work_history=[
            WorkHistoryItem(
                title=f"{'Senior ' if seniority_hint == 'senior' else ''}Software Engineer",
                company="Stub Corp",
                start_date="2020-01",
                end_date=None,
                description="Stub work history entry.",
                current=True,
            )
        ],
        education=[
            EducationItem(
                institution="State University",
                degree="B.S.",
                field="Computer Science",
                year=2019,
            )
        ],
        skills=skills_in_text if skills_in_text else ["python", "javascript"],
        links=["https://github.com/stub"],
        confidence=0.0,
        model_version="claude-sonnet-4-7-stub",
    )

    latency = (time.monotonic() - t0) * 1000
    structured_log(req_id, "/parse/resume", latency, 200, file_url=file_url)
    return result


@app.post("/parse/jd", response_model=ParsedJD)
async def parse_jd(body: ParseJDRequest, request: Request):
    t0 = time.monotonic()
    req_id = str(uuid.uuid4())
    desc = body.description

    cleaned_desc, stripped_signals = strip_protected_signals(desc)
    if stripped_signals:
        record_fairness_audit(body.workspace_id, "job", body.job_id, stripped_signals)

    required_skills = extract_skills_from_text(cleaned_desc)
    seniority = guess_seniority(cleaned_desc)

    # ── STUB: LLM call site ──────────────────────────────────────────────────
    # TODO: human ML engineer owns this prompt — see packages/ai-prompts/jd-parser.md
    # ─────────────────────────────────────────────────────────────────────────

    result = ParsedJD(
        required_skills=required_skills if required_skills else ["python"],
        nice_to_have_skills=[],
        seniority_level=seniority,
        key_responsibilities=["Stub responsibility — ML engineer owns JD parsing prompt."],
        must_haves=required_skills[:3] if required_skills else [],
        protected_class_flags=[],
        model_version="claude-sonnet-4-7-stub",
    )

    latency = (time.monotonic() - t0) * 1000
    structured_log(req_id, "/parse/jd", latency, 200, job_id=body.job_id)
    return result


@app.post("/embed", response_model=EmbedResult)
async def embed(body: EmbedRequest):
    t0 = time.monotonic()
    req_id = str(uuid.uuid4())

    # ── STUB: embedding call site ────────────────────────────────────────────
    # TODO: replace with OpenAI text-embedding-3-large
    # import openai; client = openai.OpenAI()
    # resp = client.embeddings.create(model="text-embedding-3-large", input=body.text)
    # vector = resp.data[0].embedding
    # ─────────────────────────────────────────────────────────────────────────

    vector = deterministic_fake_vector(body.text, dims=1536)

    latency = (time.monotonic() - t0) * 1000
    structured_log(req_id, "/embed", latency, 200, text_len=len(body.text))
    return EmbedResult(
        vector=vector, dimensions=1536, model_version="text-embedding-3-large-stub"
    )


@app.post("/match", response_model=MatchResult)
async def match(body: MatchRequest, request: Request):
    """
    Deterministic match score (no LLM).
    Loads parsed_resume from resumes/candidates, parsed_jd from jobs.
    Scoring weights: skills 40% | experience 30% | seniority 20% | location 10%
    """
    t0 = time.monotonic()
    req_id = str(uuid.uuid4())

    if not DATABASE_URL:
        raise HTTPException(status_code=503, detail="DATABASE_URL not configured")

    try:
        conn = get_db_conn()
        cur = conn.cursor()

        cur.execute(
            "SELECT parsed, candidate_id FROM resumes WHERE id = %s", (body.resume_id,)
        )
        resume_row = cur.fetchone()
        if not resume_row:
            raise HTTPException(status_code=404, detail=f"Resume {body.resume_id} not found")

        candidate_id = resume_row["candidate_id"]
        cur.execute(
            "SELECT parsed_resume, workspace_id FROM candidates WHERE id = %s",
            (candidate_id,),
        )
        cand_row = cur.fetchone()
        workspace_id = body.workspace_id or (
            str(cand_row["workspace_id"]) if cand_row else None
        )

        parsed_resume_data: dict = (
            resume_row["parsed"]
            or (cand_row["parsed_resume"] if cand_row else None)
            or {}
        )
        candidate_skills: list[str] = [
            s.lower() for s in (parsed_resume_data.get("skills") or [])
        ]
        work_history: list[dict] = parsed_resume_data.get("work_history") or []
        candidate_seniority: str = parsed_resume_data.get("seniority_level") or "mid"
        candidate_location: str = parsed_resume_data.get("location") or ""

        cur.execute("SELECT parsed_jd, location FROM jobs WHERE id = %s", (body.job_id,))
        job_row = cur.fetchone()
        if not job_row:
            raise HTTPException(status_code=404, detail=f"Job {body.job_id} not found")

        parsed_jd_data: dict = job_row["parsed_jd"] or {}
        required_skills: list[str] = [
            s.lower() for s in (parsed_jd_data.get("required_skills") or [])
        ]
        job_seniority: str = parsed_jd_data.get("seniority_level") or "mid"
        job_location: str = job_row["location"] or ""

        conn.close()
    except HTTPException:
        raise
    except Exception as e:
        log.error(f"DB load error in /match: {e}")
        raise HTTPException(status_code=500, detail=str(e))

    # Bias audit before scoring
    _, stripped = strip_protected_signals(f"{candidate_skills} {candidate_location}")
    if stripped:
        record_fairness_audit(workspace_id, "match", body.resume_id, stripped)

    # ── Deterministic scoring (this part is real, no LLM) ────────────────────

    # Skills score (40%)
    if required_skills:
        overlap = len(set(required_skills) & set(candidate_skills))
        skills_raw = (overlap / len(required_skills)) * 100.0
    else:
        skills_raw = 50.0

    # Experience score (30%) — sum years from work_history
    import re as _re
    total_months = 0
    for item in work_history:
        try:
            sd = item.get("start_date") or "2020"
            ed = item.get("end_date")
            is_current = item.get("current", False)
            sy = int(_re.search(r"\d{4}", sd).group())  # type: ignore[union-attr]
            if ed and not is_current:
                ey = int(_re.search(r"\d{4}", ed).group())  # type: ignore[union-attr]
            else:
                ey = 2025
            total_months += max(0, (ey - sy) * 12)
        except Exception:
            total_months += 12
    years = total_months / 12
    experience_raw = min(100.0, (years / 15.0) * 100.0)

    # Seniority score (20%)
    if candidate_seniority == job_seniority:
        seniority_raw = 100.0
    elif candidate_seniority in ADJACENT.get(job_seniority, set()):
        seniority_raw = 60.0
    else:
        seniority_raw = 30.0

    # Location score (10%)
    if not job_location or not candidate_location:
        location_raw = 80.0
    else:
        c_loc = candidate_location.lower()
        j_loc = job_location.lower()
        if "remote" in j_loc or "remote" in c_loc:
            location_raw = 80.0
        elif c_loc[:6] == j_loc[:6]:
            location_raw = 100.0
        else:
            location_raw = 40.0

    total = (
        skills_raw * 0.40
        + experience_raw * 0.30
        + seniority_raw * 0.20
        + location_raw * 0.10
    )
    score = max(0, min(100, round(total)))

    breakdown = MatchBreakdown(
        skills=round(skills_raw * 0.40, 1),
        experience=round(experience_raw * 0.30, 1),
        seniority=round(seniority_raw * 0.20, 1),
        location=round(location_raw * 0.10, 1),
    )

    # ── STUB: rationale LLM call site ────────────────────────────────────────
    # TODO: human ML engineer owns rationale generation prompt
    # see packages/ai-prompts/match-rationale.md
    # ─────────────────────────────────────────────────────────────────────────
    rationale = "Match rationale stub — ML engineer owns the prompt."

    result = MatchResult(
        score=score,
        breakdown=breakdown,
        rationale=rationale,
        evidence_quotes=[],
        model_version="claude-sonnet-4-7-stub",
    )

    latency = (time.monotonic() - t0) * 1000
    structured_log(
        req_id, "/match", latency, 200,
        resume_id=body.resume_id, job_id=body.job_id, score=score,
    )
    return result
