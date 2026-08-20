import os
import re
import json
import sqlite3
from pathlib import Path
from datetime import datetime, timezone
from typing import Optional

from dotenv import load_dotenv
from fastapi import (
    FastAPI,
    UploadFile,
    File,
    HTTPException,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from fastapi.middleware.cors import CORSMiddleware

try:
    from google import genai
except ImportError:
    genai = None

try:
    from pypdf import PdfReader
except ImportError:
    PdfReader = None


# ============================================================
# CONFIG
# ============================================================

BASE_DIR = Path(__file__).resolve().parent

load_dotenv(
    BASE_DIR.parent / ".env"
)

GEMINI_API_KEY = os.getenv(
    "GEMINI_API_KEY"
)

MODEL = os.getenv(
    "GEMINI_MODEL",
    "gemini-3.6-flash"
)

DB_PATH = (
    BASE_DIR /
    "interview_database.db"
)

RECORDINGS_DIR = (
    BASE_DIR /
    "interview_records"
)

REPORTS_DIR = (
    BASE_DIR /
    "interview_reports"
)

RECORDINGS_DIR.mkdir(
    parents=True,
    exist_ok=True
)

REPORTS_DIR.mkdir(
    parents=True,
    exist_ok=True
)


# ============================================================
# GEMINI
# ============================================================

if GEMINI_API_KEY and genai is not None:
    client = genai.Client(
        api_key=GEMINI_API_KEY
    )
    print(
        "Gemini API key loaded: True"
    )
else:
    client = None
    print(
        "WARNING: GEMINI_API_KEY not found"
    )


# ============================================================
# FASTAPI
# ============================================================

app = FastAPI(
    title="AI Live Interview Platform",
    version="4.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "https://ai-interview-pro-phi.vercel.app",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ============================================================
# DATABASE
# ============================================================

def now():
    return datetime.now(
        timezone.utc
    ).isoformat()


def get_db():
    db = sqlite3.connect(
        DB_PATH
    )

    db.row_factory = sqlite3.Row

    db.execute(
        "PRAGMA foreign_keys = ON"
    )

    return db


def init_database():

    db = get_db()

    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS candidates (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT,
            resume_filename TEXT NOT NULL,
            resume_text TEXT NOT NULL,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS interviews (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            candidate_id INTEGER NOT NULL,
            duration INTEGER NOT NULL,
            status TEXT DEFAULT 'active',
            started_at TEXT NOT NULL,
            ended_at TEXT,
            average_score REAL DEFAULT 0,
            grade TEXT DEFAULT 'N/A',
            monitoring_score REAL DEFAULT 100,
            recording_filename TEXT,

            FOREIGN KEY(candidate_id)
            REFERENCES candidates(id)
        );

        CREATE TABLE IF NOT EXISTS questions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            interview_id INTEGER NOT NULL,
            question_number INTEGER NOT NULL,
            question TEXT NOT NULL,
            created_at TEXT NOT NULL,

            FOREIGN KEY(interview_id)
            REFERENCES interviews(id)
            ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS answers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            interview_id INTEGER NOT NULL,
            question_id INTEGER,
            question TEXT NOT NULL,
            answer TEXT NOT NULL,
            score REAL DEFAULT 0,
            feedback TEXT DEFAULT '',
            strengths TEXT DEFAULT '[]',
            improvements TEXT DEFAULT '[]',
            created_at TEXT NOT NULL,

            FOREIGN KEY(interview_id)
            REFERENCES interviews(id)
            ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS monitoring_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            interview_id INTEGER NOT NULL,
            event_type TEXT NOT NULL,
            message TEXT NOT NULL,
            severity INTEGER DEFAULT 0,
            created_at TEXT NOT NULL,

            FOREIGN KEY(interview_id)
            REFERENCES interviews(id)
            ON DELETE CASCADE
        );
        """
    )

    # Add recording column if old DB exists
    try:
        db.execute(
            """
            ALTER TABLE interviews
            ADD COLUMN recording_filename TEXT
            """
        )
    except sqlite3.OperationalError:
        pass

    db.commit()
    db.close()

    print(
        "SQLite database initialized."
    )


init_database()


# ============================================================
# REQUEST MODELS
# ============================================================

class StartInterviewRequest(
    BaseModel
):
    candidate_id: int
    duration: int


class QuestionRequest(
    BaseModel
):
    interview_id: int
    previous_question: Optional[str] = ""
    previous_answer: Optional[str] = ""


class AnswerRequest(
    BaseModel
):
    interview_id: int
    question: str
    answer: str


class EndInterviewRequest(
    BaseModel
):
    interview_id: int


class MonitoringEventRequest(
    BaseModel
):
    interview_id: int
    event_type: str
    message: str


# ============================================================
# HELPERS
# ============================================================

def get_interview(
    db,
    interview_id
):
    return db.execute(
        """
        SELECT *
        FROM interviews
        WHERE id = ?
        """,
        (interview_id,)
    ).fetchone()


def get_candidate(
    db,
    interview_id
):
    return db.execute(
        """
        SELECT c.*
        FROM candidates c
        JOIN interviews i
        ON c.id = i.candidate_id
        WHERE i.id = ?
        """,
        (interview_id,)
    ).fetchone()


def calculate_grade(score):

    if score >= 8.5:
        return "Excellent"

    if score >= 7:
        return "Very Good"

    if score >= 5:
        return "Good"

    if score >= 3:
        return "Needs Improvement"

    return "Poor"


def event_severity(
    event_type
):

    values = {
        "interview_started": 0,
        "interview_ended": 0,
        "recording_saved": 0,
        "tab_hidden": 3,
        "fullscreen_exit": 2,
        "screen_share_stopped": 4,
        "camera_stopped": 4,
        "microphone_stopped": 3,
        "time_completed": 0,
    }

    return values.get(
        event_type,
        1
    )


def clean_question(text):

    text = (
        text or ""
    ).strip()

    text = re.sub(
        r"^(question\s*)?\d*\s*[:.)-]\s*",
        "",
        text,
        flags=re.IGNORECASE
    )

    text = text.replace(
        "**",
        ""
    )

    return text.strip()


# ============================================================
# HEALTH
# ============================================================

@app.get("/")
def home():

    return {
        "status": "running",
        "database": str(
            DB_PATH
        ),
        "gemini": bool(
            GEMINI_API_KEY
        ),
    }


@app.get("/health")
def health():

    return {
        "status": "ok",
        "gemini": bool(
            GEMINI_API_KEY
        ),
        "database":
            DB_PATH.exists(),
    }


# ============================================================
# RESUME
# ============================================================

def extract_pdf(path):

    if PdfReader is None:
        raise Exception(
            "Install pypdf first."
        )

    reader = PdfReader(
        str(path)
    )

    text = []

    for page in reader.pages:

        page_text = (
            page.extract_text()
        )

        if page_text:
            text.append(
                page_text
            )

    return "\n".join(text)


def extract_candidate_name(resume_text: str, filename: str) -> str:
    """Try to get the real candidate name from the first part of the resume."""
    text = re.sub(r"\s+", " ", resume_text or "").strip()

    # Common resume heading pattern: Name on the first line.
    lines = [
        re.sub(r"\s+", " ", line).strip()
        for line in (resume_text or "").splitlines()
        if line.strip()
    ]

    for line in lines[:12]:
        candidate = re.sub(
            r"^(name|candidate name)\s*[:\-]\s*",
            "",
            line,
            flags=re.IGNORECASE,
        ).strip()
        if re.fullmatch(r"[A-Za-z][A-Za-z .'-]{2,60}", candidate):
            lower = candidate.lower()
            blocked = {
                "resume", "curriculum vitae", "cv", "education",
                "skills", "projects", "experience", "objective",
                "contact", "profile", "summary",
            }
            if lower not in blocked:
                return candidate

    # If Gemini is available, ask it for the name from the resume text.
    if client is not None and text:
        try:
            prompt = f"""Extract the candidate's full name from this resume.
Return ONLY the person's name. If no name is present, return UNKNOWN.

Resume:
{text[:4000]}"""
            response = client.models.generate_content(
                model=MODEL,
                contents=prompt,
            )
            name = (response.text or "").strip().strip("`").strip()
            if name and name.upper() != "UNKNOWN" and len(name) <= 100:
                return name
        except Exception as error:
            print("Candidate name extraction error:", error)

    return Path(filename).stem.replace("_", " ")


@app.post("/upload-resume")
async def upload_resume(
    file: UploadFile = File(...)
):

    filename = (
        file.filename or
        "resume.pdf"
    )

    if not filename.lower().endswith(
        ".pdf"
    ):
        raise HTTPException(
            status_code=400,
            detail="Please upload a PDF resume."
        )

    content = await file.read()

    temp_dir = (
        BASE_DIR /
        "temp_uploads"
    )

    temp_dir.mkdir(
        exist_ok=True
    )

    safe_name = re.sub(
        r"[^A-Za-z0-9_.-]",
        "_",
        filename
    )

    temp_path = (
        temp_dir /
        safe_name
    )

    temp_path.write_bytes(
        content
    )

    try:

        resume_text = extract_pdf(
            temp_path
        )

    except Exception as error:

        raise HTTPException(
            status_code=400,
            detail=f"Could not read resume: {error}"
        )

    finally:

        try:
            temp_path.unlink()
        except Exception:
            pass

    if not resume_text.strip():

        raise HTTPException(
            status_code=400,
            detail="Could not extract text from resume."
        )

    # Extract the candidate's REAL name from the resume content.
    # Never derive the candidate name from the uploaded filename.
    candidate_name = extract_candidate_name(
        resume_text,
        filename
    )

    db = get_db()

    cursor = db.execute(
        """
        INSERT INTO candidates
        (
            name,
            resume_filename,
            resume_text,
            created_at
        )
        VALUES (?, ?, ?, ?)
        """,
        (
            candidate_name,
            filename,
            resume_text,
            now()
        )
    )

    db.commit()

    candidate_id = (
        cursor.lastrowid
    )

    db.close()

    return {
        "success": True,
        "candidate_id":
            candidate_id,
        "filename": filename,
    }


# ============================================================
# START INTERVIEW
# ============================================================

@app.post("/start-interview")
def start_interview(
    data: StartInterviewRequest
):

    if data.duration not in [
        15,
        20,
        30,
        45,
        60
    ]:
        raise HTTPException(
            status_code=400,
            detail="Invalid duration."
        )

    db = get_db()

    candidate = db.execute(
        """
        SELECT *
        FROM candidates
        WHERE id = ?
        """,
        (
            data.candidate_id,
        )
    ).fetchone()

    if candidate is None:

        db.close()

        raise HTTPException(
            status_code=404,
            detail="Candidate not found."
        )

    cursor = db.execute(
        """
        INSERT INTO interviews
        (
            candidate_id,
            duration,
            status,
            started_at
        )
        VALUES (?, ?, 'active', ?)
        """,
        (
            data.candidate_id,
            data.duration,
            now()
        )
    )

    interview_id = (
        cursor.lastrowid
    )

    db.execute(
        """
        INSERT INTO monitoring_events
        (
            interview_id,
            event_type,
            message,
            severity,
            created_at
        )
        VALUES (?, ?, ?, ?, ?)
        """,
        (
            interview_id,
            "interview_started",
            "Interview started.",
            0,
            now()
        )
    )

    db.commit()
    db.close()

    return {
        "success": True,
        "interview_id":
            interview_id,
    }


# ============================================================
# QUESTION GENERATION
# ============================================================

def generate_question(
    interview_id,
    previous_question="",
    previous_answer=""
):

    db = get_db()

    candidate = get_candidate(
        db,
        interview_id
    )

    previous_questions = db.execute(
        """
        SELECT question
        FROM questions
        WHERE interview_id = ?
        ORDER BY question_number
        """,
        (
            interview_id,
        )
    ).fetchall()

    db.close()

    if not candidate:
        return (
            "Tell me about yourself."
        )

    old_questions = "\n".join(
        f"- {row['question']}"
        for row in previous_questions
    )

    prompt = f"""
You are a professional technical interviewer.

Candidate resume:
{candidate['resume_text'][:15000]}

Previous question:
{previous_question}

Previous answer:
{previous_answer}

Already asked:
{old_questions}

Generate exactly ONE interview question.

Rules:
1. Base it on the candidate's resume.
2. Start easy.
3. Increase difficulty gradually.
4. Never repeat an earlier question.
5. Ask only one question.
6. Return ONLY the question.
"""

    if client is None:

        fallback = [
            "Tell me about yourself.",
            "Which programming language are you most comfortable with?",
            "Explain one project from your resume.",
            "What was your role in that project?",
            "What was the biggest challenge you faced?",
            "How did you solve that challenge?",
            "Explain one technical skill from your resume.",
            "What did you learn from your project?"
        ]

        index = len(
            previous_questions
        )

        return fallback[
            min(
                index,
                len(fallback) - 1
            )
        ]

    try:

        response = (
            client.models.generate_content(
                model=MODEL,
                contents=prompt
            )
        )

        return clean_question(
            response.text
        )

    except Exception as error:

        print(
            "Gemini question error:",
            error
        )

        fallback = [
            "Tell me about yourself.",
            "Which programming language are you most comfortable with?",
            "Explain one project from your resume.",
            "What was your role in that project?",
            "What was the biggest challenge you faced?"
        ]

        index = len(
            previous_questions
        )

        return fallback[
            min(
                index,
                len(fallback) - 1
            )
        ]


# ============================================================
# NEXT QUESTION
# ============================================================

@app.post("/next-question")
def next_question(
    data: QuestionRequest
):

    db = get_db()

    interview = get_interview(
        db,
        data.interview_id
    )

    if interview is None:

        db.close()

        raise HTTPException(
            status_code=404,
            detail="Interview not found."
        )

    if interview["status"] != "active":

        db.close()

        raise HTTPException(
            status_code=400,
            detail="Interview has already ended."
        )

    db.close()

    question = generate_question(
        data.interview_id,
        data.previous_question,
        data.previous_answer
    )

    db = get_db()

    count = db.execute(
        """
        SELECT COUNT(*) AS total
        FROM questions
        WHERE interview_id = ?
        """,
        (
            data.interview_id,
        )
    ).fetchone()["total"]

    question_number = (
        count + 1
    )

    cursor = db.execute(
        """
        INSERT INTO questions
        (
            interview_id,
            question_number,
            question,
            created_at
        )
        VALUES (?, ?, ?, ?)
        """,
        (
            data.interview_id,
            question_number,
            question,
            now()
        )
    )

    db.commit()

    question_id = (
        cursor.lastrowid
    )

    db.close()

    return {
        "success": True,
        "question_id":
            question_id,
        "question":
            question,
        "question_number":
            question_number,
    }


# ============================================================
# ANSWER EVALUATION
# ============================================================

@app.post("/answer")
def evaluate_answer(
    data: AnswerRequest
):

    db = get_db()

    interview = get_interview(
        db,
        data.interview_id
    )

    if interview is None:

        db.close()

        raise HTTPException(
            status_code=404,
            detail="Interview not found."
        )

    if interview["status"] != "active":

        db.close()

        raise HTTPException(
            status_code=400,
            detail="Interview has ended."
        )

    question_row = db.execute(
        """
        SELECT *
        FROM questions
        WHERE interview_id = ?
        AND question = ?
        ORDER BY id DESC
        LIMIT 1
        """,
        (
            data.interview_id,
            data.question
        )
    ).fetchone()

    candidate = get_candidate(
        db,
        data.interview_id
    )

    db.close()

    answer_text = (
        data.answer.strip()
    )

    if not answer_text:

        result = {
            "score": 0,
            "feedback":
                "No answer was provided.",
            "strengths": [],
            "improvements": [
                "Provide a clear answer."
            ],
        }

    elif client is None:

        result = {
            "score": 5,
            "feedback":
                "Answer received. Gemini evaluation is unavailable.",
            "strengths": [
                "Answer was submitted."
            ],
            "improvements": [
                "Add more technical details."
            ],
        }

    else:

        prompt = f"""
You are an expert technical interviewer.

Resume:
{candidate['resume_text'][:12000]}

Question:
{data.question}

Candidate answer:
{answer_text}

Return ONLY valid JSON:

{{
    "score": 0,
    "feedback": "",
    "strengths": [],
    "improvements": []
}}

Score must be between 0 and 10.
"""

        try:

            response = (
                client.models.generate_content(
                    model=MODEL,
                    contents=prompt
                )
            )

            text = (
                response.text
                .strip()
            )

            text = re.sub(
                r"```json",
                "",
                text,
                flags=re.I
            )

            text = (
                text
                .replace(
                    "```",
                    ""
                )
                .strip()
            )

            result = json.loads(
                text
            )

            result["score"] = max(
                0,
                min(
                    10,
                    float(
                        result.get(
                            "score",
                            0
                        )
                    )
                )
            )

        except Exception as error:

            print(
                "Gemini evaluation error:",
                error
            )

            result = {
                "score": 5,
                "feedback":
                    "Answer received, but AI evaluation failed.",
                "strengths": [
                    "Answer was submitted."
                ],
                "improvements": [
                    "Give more technical details."
                ],
            }

    db = get_db()

    db.execute(
        """
        INSERT INTO answers
        (
            interview_id,
            question_id,
            question,
            answer,
            score,
            feedback,
            strengths,
            improvements,
            created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            data.interview_id,
            (
                question_row["id"]
                if question_row
                else None
            ),
            data.question,
            answer_text,
            result["score"],
            result.get(
                "feedback",
                ""
            ),
            json.dumps(
                result.get(
                    "strengths",
                    []
                )
            ),
            json.dumps(
                result.get(
                    "improvements",
                    []
                )
            ),
            now()
        )
    )

    db.commit()
    db.close()

    return result


# ============================================================
# MONITORING
# ============================================================

@app.post("/monitoring-event")
def monitoring_event(
    data: MonitoringEventRequest
):

    db = get_db()

    interview = get_interview(
        db,
        data.interview_id
    )

    if interview is None:

        db.close()

        raise HTTPException(
            status_code=404,
            detail="Interview not found."
        )

    severity = event_severity(
        data.event_type
    )

    db.execute(
        """
        INSERT INTO monitoring_events
        (
            interview_id,
            event_type,
            message,
            severity,
            created_at
        )
        VALUES (?, ?, ?, ?, ?)
        """,
        (
            data.interview_id,
            data.event_type,
            data.message,
            severity,
            now()
        )
    )

    db.commit()
    db.close()

    return {
        "success": True
    }


# ============================================================
# RECORDING
# ============================================================

app.mount(
    "/recordings",
    StaticFiles(
        directory=str(
            RECORDINGS_DIR
        )
    ),
    name="recordings"
)


@app.post("/upload-recording")
async def upload_recording(
    interview_id: int,
    file: UploadFile = File(...)
):

    if interview_id <= 0:

        raise HTTPException(
            status_code=400,
            detail="Invalid interview ID."
        )

    db = get_db()

    interview = get_interview(
        db,
        interview_id
    )

    if interview is None:

        db.close()

        raise HTTPException(
            status_code=404,
            detail="Interview not found."
        )

    folder = (
        RECORDINGS_DIR /
        f"interview_{interview_id}"
    )

    folder.mkdir(
        parents=True,
        exist_ok=True
    )

    filename = (
        f"interview_{interview_id}.webm"
    )

    path = (
        folder /
        filename
    )

    try:

        content = await file.read()

        if not content:
            raise Exception(
                "Uploaded recording is empty."
            )

        path.write_bytes(
            content
        )

    except Exception as error:

        db.close()

        raise HTTPException(
            status_code=500,
            detail=f"Could not save recording: {error}"
        )

    db.execute(
        """
        UPDATE interviews
        SET recording_filename = ?
        WHERE id = ?
        """,
        (
            filename,
            interview_id
        )
    )

    db.execute(
        """
        INSERT INTO monitoring_events
        (
            interview_id,
            event_type,
            message,
            severity,
            created_at
        )
        VALUES (?, ?, ?, ?, ?)
        """,
        (
            interview_id,
            "recording_saved",
            "Interview recording saved.",
            0,
            now()
        )
    )

    db.commit()
    db.close()

    return {
        "success": True,
        "filename": filename,
        "url":
            f"/recordings/interview_{interview_id}/{filename}",
        "size": len(content),
    }


# ============================================================
# REPORT
# ============================================================

def build_report(
    interview_id
):

    db = get_db()

    answers = db.execute(
        """
        SELECT *
        FROM answers
        WHERE interview_id = ?
        ORDER BY id
        """,
        (
            interview_id,
        )
    ).fetchall()

    events = db.execute(
        """
        SELECT *
        FROM monitoring_events
        WHERE interview_id = ?
        ORDER BY id
        """,
        (
            interview_id,
        )
    ).fetchall()

    if answers:

        scores = [
            float(row["score"])
            for row in answers
        ]

        average = (
            sum(scores) /
            len(scores)
        )

    else:
        average = 0

    penalty = sum(
        int(row["severity"])
        for row in events
        if row["event_type"]
        not in [
            "interview_started",
            "interview_ended",
            "recording_saved",
            "time_completed",
        ]
    )

    monitoring_score = max(
        0,
        100 - penalty * 5
    )

    grade = calculate_grade(
        average
    )

    db.execute(
        """
        UPDATE interviews
        SET
            average_score = ?,
            grade = ?,
            monitoring_score = ?
        WHERE id = ?
        """,
        (
            round(
                average,
                2
            ),
            grade,
            monitoring_score,
            interview_id
        )
    )

    db.commit()
    db.close()


def get_report_data(
    interview_id
):

    db = get_db()

    interview = get_interview(
        db,
        interview_id
    )

    if interview is None:

        db.close()

        raise HTTPException(
            status_code=404,
            detail="Interview not found."
        )

    candidate = db.execute(
        """
        SELECT
            id,
            name,
            resume_filename
        FROM candidates
        WHERE id = ?
        """,
        (
            interview[
                "candidate_id"
            ],
        )
    ).fetchone()

    answers = db.execute(
        """
        SELECT *
        FROM answers
        WHERE interview_id = ?
        ORDER BY id
        """,
        (
            interview_id,
        )
    ).fetchall()

    events = db.execute(
        """
        SELECT *
        FROM monitoring_events
        WHERE interview_id = ?
        ORDER BY id
        """,
        (
            interview_id,
        )
    ).fetchall()

    db.close()

    detailed_answers = []

    for row in answers:

        try:
            strengths = json.loads(
                row["strengths"]
            )
        except Exception:
            strengths = []

        try:
            improvements = json.loads(
                row["improvements"]
            )
        except Exception:
            improvements = []

        detailed_answers.append(
            {
                "question":
                    row["question"],
                "answer":
                    row["answer"],
                "score":
                    row["score"],
                "feedback":
                    row["feedback"],
                "strengths":
                    strengths,
                "improvements":
                    improvements,
            }
        )

    recording_filename = (
        interview[
            "recording_filename"
        ]
    )

    recording_url = None

    if recording_filename:

        recording_path = (
            RECORDINGS_DIR /
            f"interview_{interview_id}" /
            recording_filename
        )

        if recording_path.exists():

            recording_url = (
                f"/recordings/"
                f"interview_{interview_id}/"
                f"{recording_filename}"
            )

    all_strengths = []
    all_improvements = []
    for item in detailed_answers:
        all_strengths.extend(item.get("strengths") or [])
        all_improvements.extend(item.get("improvements") or [])

    unique_strengths = list(dict.fromkeys(all_strengths))[:8]
    unique_improvements = list(dict.fromkeys(all_improvements))[:8]

    if detailed_answers:
        overall_feedback = (
            f"You answered {len(detailed_answers)} question(s) with an "
            f"average score of {float(interview['average_score']):.1f}/10. "
            f"Your current grade is {interview['grade']}. "
            "Continue practicing concise, specific answers and support "
            "technical claims with examples from your projects."
        )
    else:
        overall_feedback = (
            "No answer was submitted before the interview ended, so no "
            "answer could be evaluated. Submit each answer before ending "
            "the interview to receive an AI score and detailed feedback."
        )

    return {
        "interview_id":
            interview["id"],

        "candidate":
            dict(candidate)
            if candidate
            else None,

        "duration":
            interview["duration"],

        "status":
            interview["status"],

        "average_score":
            interview["average_score"],

        "grade":
            interview["grade"],

        "monitoring_score":
            interview[
                "monitoring_score"
            ],

        "total_questions":
            len(detailed_answers),
        "answered_questions":
            len(detailed_answers),
        "overall_feedback":
            overall_feedback,
        "strengths":
            unique_strengths,
        "improvements":
            unique_improvements,

        "answers":
            detailed_answers,

        "events": [
            {
                "type":
                    event["event_type"],
                "message":
                    event["message"],
                "severity":
                    event["severity"],
                "created_at":
                    event["created_at"],
            }
            for event in events
        ],

        "recording_url":
            recording_url,
    }


def save_report_json(
    interview_id
):

    report = get_report_data(
        interview_id
    )

    folder = (
        REPORTS_DIR /
        f"interview_{interview_id}"
    )

    folder.mkdir(
        parents=True,
        exist_ok=True
    )

    path = (
        folder /
        "report.json"
    )

    path.write_text(
        json.dumps(
            report,
            indent=4,
            ensure_ascii=False
        ),
        encoding="utf-8"
    )


@app.post("/end-interview")
def end_interview(
    data: EndInterviewRequest
):

    db = get_db()

    interview = get_interview(
        db,
        data.interview_id
    )

    if interview is None:

        db.close()

        raise HTTPException(
            status_code=404,
            detail="Interview not found."
        )

    if interview["status"] != "completed":

        db.execute(
            """
            UPDATE interviews
            SET
                status = 'completed',
                ended_at = ?
            WHERE id = ?
            """,
            (
                now(),
                data.interview_id
            )
        )

        db.execute(
            """
            INSERT INTO monitoring_events
            (
                interview_id,
                event_type,
                message,
                severity,
                created_at
            )
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                data.interview_id,
                "interview_ended",
                "Interview ended.",
                0,
                now()
            )
        )

        db.commit()

    db.close()

    build_report(
        data.interview_id
    )

    save_report_json(
        data.interview_id
    )

    return {
        "success": True,
        "message":
            "Interview ended successfully."
    }


@app.get("/report/{interview_id}")
def report(
    interview_id: int
):

    return get_report_data(
        interview_id
    )


# ============================================================
# ADMIN
# ============================================================

@app.get("/admin/interviews")
def admin_interviews():

    db = get_db()

    rows = db.execute(
        """
        SELECT
            i.id AS id,
            i.id AS interview_id,
            c.name,
            c.resume_filename,
            i.duration,
            i.status,
            i.started_at,
            i.ended_at,
            i.average_score,
            i.grade,
            i.monitoring_score,
            i.recording_filename
        FROM interviews i
        JOIN candidates c
        ON c.id = i.candidate_id
        ORDER BY i.id DESC
        """
    ).fetchall()

    db.close()

    return {
        "success": True,
        "interviews":
            [dict(row)
             for row in rows]
    }


@app.get(
    "/admin/interview/{interview_id}"
)
def admin_interview(
    interview_id: int
):

    return get_report_data(
        interview_id
    )

# ============================================================
# ADMIN COMPATIBILITY + DELETE
# ============================================================

@app.get("/interviews")
def interviews_alias():
    """Compatibility endpoint used by the React admin dashboard."""
    return admin_interviews()


@app.delete("/interviews/{interview_id}")
def delete_interview(interview_id: int):
    """Permanently delete an interview, its database children, report and recording."""
    if interview_id <= 0:
        raise HTTPException(
            status_code=400,
            detail="Invalid interview ID."
        )

    db = get_db()

    interview = db.execute(
        """
        SELECT recording_filename
        FROM interviews
        WHERE id = ?
        """,
        (interview_id,)
    ).fetchone()

    if interview is None:
        db.close()
        raise HTTPException(
            status_code=404,
            detail="Interview not found."
        )

    # Delete report folder from disk first.
    report_folder = REPORTS_DIR / f"interview_{interview_id}"
    if report_folder.exists():
        import shutil
        shutil.rmtree(report_folder, ignore_errors=True)

    # Delete recording folder from disk.
    recording_folder = RECORDINGS_DIR / f"interview_{interview_id}"
    if recording_folder.exists():
        import shutil
        shutil.rmtree(recording_folder, ignore_errors=True)

    # Delete DB row. Child rows use ON DELETE CASCADE.
    # The candidate is intentionally kept because one candidate can have
    # multiple interviews.
    db.execute(
        "DELETE FROM interviews WHERE id = ?",
        (interview_id,)
    )

    db.commit()
    db.close()

    return {
        "success": True,
        "deleted_interview_id": interview_id,
        "message": "Interview, report and recording deleted successfully."
    }
