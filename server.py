#!/usr/bin/env python3
"""Local Obsidian-first vocabulary coach.

The browser is only the interface. Notes and review state are stored as Markdown
inside the vault so Obsidian remains the source of truth.
"""

from __future__ import annotations

import base64
import csv
import io
import json
import mimetypes
import os
import re
import shutil
import threading
import time
import urllib.error
import urllib.request
import webbrowser
import zipfile
from datetime import datetime, timedelta
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse


APP_ROOT = Path(__file__).resolve().parent
# With WORD_COACH_VAULT set, data lives in that (Obsidian) vault. Without it the
# app runs against the bundled sample/ folder so a fresh clone works immediately.
if os.environ.get("WORD_COACH_VAULT"):
    VAULT_ROOT = Path(os.environ["WORD_COACH_VAULT"])
    _DEFAULT_CSV = VAULT_ROOT / "Vocabulary" / "Youdao Vocabulary.csv"
    _DEFAULT_NOTES = VAULT_ROOT / "Source Material" / "Vocabulary"
else:
    VAULT_ROOT = APP_ROOT / "sample"
    _DEFAULT_CSV = VAULT_ROOT / "vocabulary.csv"
    _DEFAULT_NOTES = VAULT_ROOT / "notes"
CSV_PATH = Path(os.environ.get("WORD_COACH_CSV", _DEFAULT_CSV))
NOTES_DIR = Path(os.environ.get("WORD_COACH_NOTES_DIR", _DEFAULT_NOTES))
PUBLIC_DIR = APP_ROOT / "public"
CONTEXT_PATH = Path(os.environ.get("WORD_COACH_CONTEXTS", APP_ROOT / "contexts.json"))
SETTINGS_PATH = APP_ROOT / ".word-coach-settings.json"
BACKUP_DIR = NOTES_DIR / ".word-coach-backups"
LOG_PATH = NOTES_DIR / "_Review Log.md"
HOST = "127.0.0.1"
PORT = int(os.environ.get("WORD_COACH_PORT", "8765"))
ENV_OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "").strip()
ENV_OPENAI_MODEL = os.environ.get("WORD_COACH_AI_MODEL", "gpt-5.6-luna").strip() or "gpt-5.6-luna"
WORDS_LOCK = threading.Lock()

MANAGED_START = "<!-- word-coach:start -->"
MANAGED_END = "<!-- word-coach:end -->"
OUR_KEYS = [
    "word",
    "source_number",
    "mastery",
    "review_count",
    "last_reviewed",
    "next_review",
    "ease",
    "interval_days",
    "updated_at",
    "tags",
]


class AIUnavailableError(RuntimeError):
    pass


class AIRequestError(RuntimeError):
    pass


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def load_words() -> tuple[list[dict], dict[int, dict]]:
    words: list[dict] = []
    with CSV_PATH.open("r", encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            word = (row.get("word") or "").strip()
            if not word:
                continue
            number = int(row["source_number"])
            words.append({"source_number": number, "word": word})
    return words, {row["source_number"]: row for row in words}


WORDS, WORD_BY_NUMBER = load_words()


def load_ai_settings() -> dict:
    settings = {
        "provider": "openai",
        "api_key": ENV_OPENAI_API_KEY,
        "base_url": "https://api.openai.com/v1",
        "model": ENV_OPENAI_MODEL,
    }
    if SETTINGS_PATH.exists():
        try:
            saved = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
            if isinstance(saved, dict):
                settings.update({key: saved[key] for key in settings if key in saved})
        except (json.JSONDecodeError, OSError):
            pass
    settings["provider"] = str(settings.get("provider") or "openai").strip().lower()
    settings["api_key"] = str(settings.get("api_key") or "").strip()
    settings["base_url"] = str(settings.get("base_url") or "").strip().rstrip("/")
    settings["model"] = str(settings.get("model") or ENV_OPENAI_MODEL).strip()
    return settings


def public_ai_settings() -> dict:
    settings = load_ai_settings()
    key = settings["api_key"]
    return {
        "configured": bool(key),
        "provider": settings["provider"],
        "base_url": settings["base_url"],
        "model": settings["model"] if key else settings["model"],
        "token_hint": f"••••{key[-4:]}" if len(key) >= 4 else ("Saved" if key else ""),
    }


def save_ai_settings(payload: dict) -> dict:
    current = load_ai_settings()
    provider = str(payload.get("provider", current["provider"])).strip().lower()
    if provider not in {"openai", "compatible"}:
        raise ValueError("Choose OpenAI or an OpenAI-compatible provider.")
    base_url = str(payload.get("base_url", current["base_url"])).strip().rstrip("/")
    if provider == "openai" and not base_url:
        base_url = "https://api.openai.com/v1"
    parsed = urlparse(base_url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("Enter a valid provider Base URL beginning with http:// or https://.")
    model = str(payload.get("model", current["model"])).strip()
    if not model or len(model) > 120:
        raise ValueError("Enter the model name supplied by your provider.")
    token = str(payload.get("api_key", "")).strip()
    if not token:
        token = current["api_key"]
    settings = {"provider": provider, "api_key": token, "base_url": base_url, "model": model}
    tmp = SETTINGS_PATH.with_suffix(".json.tmp")
    with tmp.open("w", encoding="utf-8", newline="\n") as handle:
        json.dump(settings, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(tmp, 0o600)
    os.replace(tmp, SETTINGS_PATH)
    return public_ai_settings()


def safe_word(word: str) -> str:
    clean = re.sub(r"[\\/:*?\"<>|\x00-\x1f]", "-", word).strip(" .")
    return clean[:100] or "word"


def note_path(number: int, word: str) -> Path:
    return NOTES_DIR / f"{number} - {safe_word(word)}.md"


def yaml_value(value):
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, list):
        return json.dumps(value, ensure_ascii=False)
    return json.dumps(str(value), ensure_ascii=False)


def parse_yaml_value(value: str):
    value = value.strip()
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        if re.fullmatch(r"-?\d+", value):
            return int(value)
        return value


def split_frontmatter(text: str) -> tuple[dict, list[str], str]:
    if not text.startswith("---\n"):
        return {}, [], text
    end = text.find("\n---\n", 4)
    if end == -1:
        return {}, [], text
    raw_lines = text[4:end].splitlines()
    values = {}
    extra = []
    for line in raw_lines:
        match = re.match(r"^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$", line)
        if not match:
            extra.append(line)
            continue
        key, raw = match.groups()
        if key in OUR_KEYS:
            values[key] = parse_yaml_value(raw)
        else:
            extra.append(line)
    return values, extra, text[end + 5 :]


def section(block: str, title: str) -> str:
    match = re.search(rf"(?ms)^## {re.escape(title)}\s*\n(.*?)(?=^## |\Z)", block)
    return match.group(1).strip() if match else ""


def parse_real_examples(block: str) -> list[dict]:
    examples = []
    for raw in re.findall(r"<!-- word-coach:real-example (.*?) -->", block):
        try:
            if raw.startswith("{"):
                item = json.loads(raw)  # backward compatibility with early local tests
            else:
                padding = "=" * (-len(raw) % 4)
                decoded = base64.urlsafe_b64decode(raw + padding).decode("utf-8")
                item = json.loads(decoded)
        except (json.JSONDecodeError, UnicodeDecodeError, ValueError):
            continue
        if isinstance(item, dict) and item.get("caption"):
            examples.append(item)
    return examples


def render_real_examples(examples: list[dict]) -> str:
    if not examples:
        return ""
    entries = []
    for item in examples:
        raw_marker = json.dumps(item, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        marker = base64.urlsafe_b64encode(raw_marker).decode("ascii").rstrip("=")
        caption = str(item.get("caption", "")).strip()
        video = str(item.get("video_url", "")).strip()
        accent = str(item.get("accent", "US")).upper()
        saved = str(item.get("saved", ""))
        entries.append(
            f"<!-- word-coach:real-example {marker} -->\n"
            f"> {caption}\n\n"
            f"- Source: YouGlish / YouTube\n"
            f"- Video: [Open original clip]({video})\n"
            f"- Accent: {accent}\n"
            f"- Saved: {saved}"
        )
    return "## Real-world examples\n\n" + "\n\n---\n\n".join(entries)


def read_note(number: int, word: str) -> dict:
    path = note_path(number, word)
    defaults = {
        "note": "",
        "example": "",
        "context": "",
        "pronunciation_note": "",
        "real_examples": [],
        "mastery": "new",
        "review_count": 0,
        "last_reviewed": "",
        "next_review": "",
        "ease": 2.5,
        "interval_days": 0,
        "updated_at": "",
        "has_note_file": False,
    }
    if not path.exists():
        return defaults
    text = path.read_text(encoding="utf-8")
    meta, _, body = split_frontmatter(text)
    if MANAGED_START in body and MANAGED_END in body:
        block = body.split(MANAGED_START, 1)[1].split(MANAGED_END, 1)[0]
    else:
        block = body
    return {
        **defaults,
        "note": section(block, "My note"),
        "example": section(block, "My example"),
        "context": section(block, "Context I want to remember"),
        "pronunciation_note": section(block, "Pronunciation reminder"),
        "real_examples": parse_real_examples(block),
        "mastery": str(meta.get("mastery", "new")),
        "review_count": int(meta.get("review_count", 0) or 0),
        "last_reviewed": str(meta.get("last_reviewed", "")),
        "next_review": str(meta.get("next_review", "")),
        "ease": float(meta.get("ease", 2.5) or 2.5),
        "interval_days": int(meta.get("interval_days", 0) or 0),
        "updated_at": str(meta.get("updated_at", "")),
        "has_note_file": True,
        "obsidian_path": str(path.relative_to(VAULT_ROOT)),
    }


def atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    if path.exists():
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
        shutil.copy2(path, BACKUP_DIR / f"{path.stem}.{stamp}.md")
        old = sorted(BACKUP_DIR.glob(f"{path.stem}.*.md"), reverse=True)
        for stale in old[5:]:
            stale.unlink(missing_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8", newline="\n") as handle:
        handle.write(text)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, path)


def write_note(number: int, payload: dict, progress_updates: dict | None = None) -> dict:
    word_row = WORD_BY_NUMBER.get(number)
    if not word_row:
        raise ValueError("Unknown source number")
    word = word_row["word"]
    path = note_path(number, word)
    existing = path.read_text(encoding="utf-8") if path.exists() else ""
    meta, extras, body = split_frontmatter(existing)
    current = read_note(number, word)

    meta.update(
        {
            "word": word,
            "source_number": number,
            "mastery": current["mastery"],
            "review_count": current["review_count"],
            "last_reviewed": current["last_reviewed"],
            "next_review": current["next_review"],
            "updated_at": now_iso(),
            "tags": ["vocabulary", "word-coach"],
        }
    )
    if progress_updates:
        meta.update(progress_updates)

    note = str(payload.get("note", current["note"])).strip()
    example = str(payload.get("example", current["example"])).strip()
    context = str(payload.get("context", current["context"])).strip()
    pronunciation_note = str(payload.get("pronunciation_note", current["pronunciation_note"])).strip()
    real_examples = payload.get("real_examples", current["real_examples"])
    examples_markdown = render_real_examples(real_examples)
    managed = (
        f"{MANAGED_START}\n"
        f"## My note\n\n{note}\n\n"
        f"## My example\n\n{example}\n\n"
        f"## Context I want to remember\n\n{context}\n"
        f"\n## Pronunciation reminder\n\n{pronunciation_note}\n"
        + (f"\n{examples_markdown}\n" if examples_markdown else "")
        + f"{MANAGED_END}"
    )

    if MANAGED_START in body and MANAGED_END in body:
        prefix, rest = body.split(MANAGED_START, 1)
        _, suffix = rest.split(MANAGED_END, 1)
        new_body = f"{prefix.rstrip()}\n\n{managed}{suffix}"
    else:
        preserved = body.strip()
        new_body = f"# {word}\n\n{managed}"
        if preserved:
            new_body += f"\n\n## Earlier content preserved by Word Coach\n\n{preserved}"

    front_lines = ["---"]
    for key in OUR_KEYS:
        front_lines.append(f"{key}: {yaml_value(meta.get(key, ''))}")
    front_lines.extend(extras)
    front_lines.append("---")
    atomic_write(path, "\n".join(front_lines) + "\n\n" + new_body.strip() + "\n")
    return read_note(number, word)


def append_review_log(number: int, word: str, rating: str, next_review: str) -> None:
    NOTES_DIR.mkdir(parents=True, exist_ok=True)
    link = f"[[{number} - {word}]]"
    line = f"- {now_iso()} | {link} | **{rating}** | next: {next_review}\n"
    if not LOG_PATH.exists():
        atomic_write(
            LOG_PATH,
            "# Vocabulary Review Log\n\n"
            "> Append-only history created by Stella Word Coach.\n\n"
            + line,
        )
        return
    with LOG_PATH.open("a", encoding="utf-8", newline="\n") as handle:
        handle.write(line)
        handle.flush()
        os.fsync(handle.fileno())


def review_word(number: int, rating: str, payload: dict) -> dict:
    # Adapted from SM-2 (SuperMemo-2 / the algorithm behind Anki): each word carries its own
    # "ease" so the schedule reflects how hard THAT word actually is for this learner, rather
    # than a fixed count-based ladder. "Good" answers push the interval out by a multiplicative
    # ease factor (the spacing effect: longer gaps between successful recalls build durable
    # memory); "again"/"hard" shrink the interval and the ease so a mis-remembered word comes
    # back soon, at the point it's about to be forgotten (desirable difficulty).
    valid = {"again", "hard", "good"}
    if rating not in valid:
        raise ValueError("Invalid rating")
    row = WORD_BY_NUMBER[number]
    current = read_note(number, row["word"])
    count = current["review_count"] + 1
    ease = current["ease"] or 2.5
    interval = current["interval_days"] or 0

    if rating == "again":
        interval = 1
        ease = max(1.3, round(ease - 0.2, 2))
        mastery = "learning"
    elif rating == "hard":
        interval = max(1, round((interval or 1) * 1.2))
        ease = max(1.3, round(ease - 0.15, 2))
        mastery = "learning"
    else:
        if interval <= 0:
            interval = 1
        elif interval == 1:
            interval = 6
        else:
            interval = round(interval * ease)
        interval = min(180, interval)
        ease = min(2.8, round(ease + 0.1, 2))
        mastery = "familiar" if count < 5 else "mastered"

    next_review = (datetime.now().date() + timedelta(days=interval)).isoformat()
    result = write_note(
        number,
        payload,
        {
            "mastery": mastery,
            "review_count": count,
            "last_reviewed": datetime.now().date().isoformat(),
            "next_review": next_review,
            "ease": ease,
            "interval_days": interval,
        },
    )
    append_review_log(number, row["word"], rating, next_review)
    return result


def save_real_example(number: int, payload: dict) -> dict:
    row = WORD_BY_NUMBER.get(number)
    if not row:
        raise ValueError("Unknown source number")
    caption = re.sub(r"\s+", " ", str(payload.get("caption", ""))).strip()
    video_id = str(payload.get("video_id", "")).strip()
    accent = str(payload.get("accent", "us")).lower()
    if not caption or len(caption) > 600:
        raise ValueError("The current caption is empty or too long.")
    if not re.fullmatch(r"[A-Za-z0-9_-]{6,20}", video_id):
        raise ValueError("The current video link is unavailable.")
    if accent not in {"us", "uk", "ca", "aus", "ie", "sco", "nz"}:
        accent = "us"
    current = read_note(number, row["word"])
    item = {
        "caption": caption,
        "video_url": f"https://www.youtube.com/watch?v={video_id}",
        "video_id": video_id,
        "accent": accent,
        "saved": datetime.now().date().isoformat(),
    }
    examples = list(current["real_examples"])
    duplicate = any(
        existing.get("caption") == caption and existing.get("video_id") == video_id
        for existing in examples
    )
    if not duplicate:
        examples.append(item)
    return write_note(number, {"real_examples": examples})


def add_word(payload: dict) -> dict:
    global WORDS, WORD_BY_NUMBER
    word = re.sub(r"\s+", " ", str(payload.get("word", ""))).strip()
    if not word or len(word) > 100:
        raise ValueError("Enter a word or short phrase under 100 characters.")
    note = str(payload.get("note", "")).strip()
    with WORDS_LOCK:
        duplicate = next((row for row in WORDS if row["word"].casefold() == word.casefold()), None)
        if duplicate:
            result = {**duplicate, **read_note(duplicate["source_number"], duplicate["word"])}
            return {"word": result, "created": False}

        with CSV_PATH.open("r", encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle)
            fieldnames = list(reader.fieldnames or ["source_number", "word", "extraction_status", "source_image"])
            rows = list(reader)
        for required in ["source_number", "word", "extraction_status", "source_image"]:
            if required not in fieldnames:
                fieldnames.append(required)
        number = max((int(row.get("source_number") or 0) for row in rows), default=0) + 1
        rows.append(
            {
                **{key: "" for key in fieldnames},
                "source_number": str(number),
                "word": word,
                "extraction_status": "manual",
                "source_image": "Stella Word Coach",
            }
        )

        BACKUP_DIR.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
        backup = BACKUP_DIR / f"Youdao Vocabulary.{stamp}.csv"
        shutil.copy2(CSV_PATH, backup)
        for stale in sorted(BACKUP_DIR.glob("Youdao Vocabulary.*.csv"), reverse=True)[5:]:
            stale.unlink(missing_ok=True)
        tmp = CSV_PATH.with_suffix(".csv.tmp")
        with tmp.open("w", encoding="utf-8-sig", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(rows)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, CSV_PATH)

        added = {"source_number": number, "word": word}
        WORDS.append(added)
        WORD_BY_NUMBER[number] = added

    if note:
        write_note(number, {"note": note})
    return {"word": {**added, **read_note(number, word)}, "created": True}


def backup_zip() -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.write(CSV_PATH, "Youdao Vocabulary.csv")
        if NOTES_DIR.exists():
            for file in NOTES_DIR.glob("*.md"):
                archive.write(file, f"Source Material/Vocabulary/{file.name}")
    return output.getvalue()


def extract_openai_text(response: dict) -> str:
    parts = []
    for item in response.get("output", []):
        if item.get("type") != "message":
            continue
        for content in item.get("content", []):
            if content.get("type") == "output_text" and content.get("text"):
                parts.append(str(content["text"]).strip())
    return "\n\n".join(part for part in parts if part).strip()


def extract_chat_text(response: dict) -> str:
    try:
        content = response["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        return ""
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        return "\n".join(str(part.get("text", "")).strip() for part in content if isinstance(part, dict)).strip()
    return ""


def ask_ai(payload: dict) -> dict:
    settings = load_ai_settings()
    if not settings["api_key"]:
        raise AIUnavailableError("AI is not connected yet. Open Settings and add your provider token.")

    number = int(payload["source_number"])
    row = WORD_BY_NUMBER.get(number)
    if not row:
        raise ValueError("Unknown source number")

    question = re.sub(r"\s+", " ", str(payload.get("question", ""))).strip()
    if not question:
        raise ValueError("Ask a question first.")
    if len(question) > 1200:
        raise ValueError("Please keep the question under 1,200 characters.")

    meaning = str(payload.get("meaning", "")).strip()[:1000]
    example = str(payload.get("example", "")).strip()[:1200]
    learner_note = str(payload.get("note", "")).strip()[:2000]
    video_context = re.sub(r"\s+", " ", str(payload.get("video_context", ""))).strip()[:2000]
    video_accent = str(payload.get("video_accent", "")).strip()[:30]
    raw_history = payload.get("history", [])
    history_lines = []
    if isinstance(raw_history, list):
        for item in raw_history[-8:]:
            if not isinstance(item, dict):
                continue
            role = "Learner" if item.get("role") == "user" else "Coach"
            content = re.sub(r"\s+", " ", str(item.get("content", ""))).strip()[:1000]
            if content:
                history_lines.append(f"{role}: {content}")

    conversation = "\n".join(history_lines) or "No earlier conversation."
    input_text = (
        f"Current word: {row['word']}\n"
        f"Plain-English meaning shown in the app: {meaning or 'Not provided'}\n"
        f"Example shown in the app: {example or 'Not provided'}\n"
        f"Learner's current Obsidian note: {learner_note or 'None'}\n\n"
        f"Current YouGlish video context ({video_accent or 'accent unknown'}): {video_context or 'No caption captured yet'}\n\n"
        f"Conversation so far:\n{conversation}\n\n"
        f"New question: {question}"
    )
    instructions = (
        "You are Stella's practical English usage coach. She is an advanced Mandarin-English bilingual learner. "
        "Answer the exact question directly and correct her interpretation when needed. Focus on connotation, "
        "register, everyday American English, and what a native speaker would infer. The app may provide a current "
        "YouGlish caption; treat it as imperfect auto-caption context and say so if it is incomplete. Give a concise "
        "verdict first, then the important nuance, followed by one or two natural examples. If useful, end with one "
        "short sentence labeled 'Note-ready:' that she could save. Do not invent movie quotations or claim a phrase "
        "is common without confidence. Keep the whole answer under 180 words. Reply in the learner's language."
    )
    if settings["provider"] == "openai":
        endpoint = f"{settings['base_url']}/responses"
        request_body = {
            "model": settings["model"],
            "store": False,
            "max_output_tokens": 500,
            "text": {"verbosity": "low"},
            "instructions": instructions,
            "input": input_text,
        }
    else:
        endpoint = f"{settings['base_url']}/chat/completions"
        request_body = {
            "model": settings["model"],
            # Reasoning models on OpenAI-compatible gateways spend part of this
            # budget on hidden reasoning; 500 can leave no visible text.
            "max_tokens": 1600,
            "messages": [
                {"role": "system", "content": instructions},
                {"role": "user", "content": input_text},
            ],
        }
    request = urllib.request.Request(
        endpoint,
        data=json.dumps(request_body, ensure_ascii=False).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {settings['api_key']}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=45) as response:
            result = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        if exc.code == 401:
            raise AIUnavailableError("The provider rejected this token. Check the token in Settings.") from exc
        if exc.code == 429:
            raise AIRequestError("The AI usage limit was reached. Check your provider balance or try again later.") from exc
        raise AIRequestError(f"The AI provider returned an error ({exc.code}). Check the Base URL and model in Settings.") from exc
    except (urllib.error.URLError, TimeoutError) as exc:
        raise AIRequestError("Could not reach the AI provider. Check its Base URL and your internet connection.") from exc

    answer = extract_openai_text(result) if settings["provider"] == "openai" else extract_chat_text(result)
    if not answer:
        raise AIRequestError("The AI response was empty. Please try again.")
    return {"answer": answer, "model": settings["model"]}


class Handler(BaseHTTPRequestHandler):
    server_version = "StellaWordCoach/1.0"

    def log_message(self, fmt, *args):
        print(f"[{self.log_date_time_string()}] {fmt % args}")

    def send_json(self, payload, status=HTTPStatus.OK):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def read_json(self):
        length = int(self.headers.get("Content-Length", "0"))
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/ai-status":
            self.send_json(public_ai_settings())
            return
        if parsed.path == "/api/settings":
            self.send_json(public_ai_settings())
            return
        if parsed.path == "/api/word":
            try:
                number = int(parse_qs(parsed.query).get("number", [""])[0])
                row = WORD_BY_NUMBER[number]
            except (ValueError, KeyError):
                self.send_json({"error": "Unknown source number"}, HTTPStatus.BAD_REQUEST)
                return
            self.send_json({"word": {**row, **read_note(number, row["word"])}})
            return
        if parsed.path == "/api/words":
            result = []
            for row in WORDS:
                result.append({**row, **read_note(row["source_number"], row["word"])})
            self.send_json(
                {
                    "words": result,
                    "notes_directory": str(NOTES_DIR.relative_to(VAULT_ROOT)),
                    "word_count": len(result),
                }
            )
            return
        if parsed.path == "/api/contexts":
            self.send_json(json.loads(CONTEXT_PATH.read_text(encoding="utf-8")))
            return
        if parsed.path == "/api/backup":
            data = backup_zip()
            stamp = datetime.now().strftime("%Y-%m-%d")
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/zip")
            self.send_header("Content-Disposition", f'attachment; filename="stella-word-coach-{stamp}.zip"')
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        self.serve_static(parsed.path)

    def do_POST(self):
        try:
            payload = self.read_json()
            if self.path == "/api/save":
                number = int(payload["source_number"])
                self.send_json({"saved": True, "word": write_note(number, payload)})
                return
            if self.path == "/api/review":
                number = int(payload["source_number"])
                self.send_json(
                    {
                        "saved": True,
                        "word": review_word(number, str(payload["rating"]), payload),
                    }
                )
                return
            if self.path == "/api/save-real-example":
                number = int(payload["source_number"])
                self.send_json(
                    {
                        "saved": True,
                        "word": save_real_example(number, payload),
                    }
                )
                return
            if self.path == "/api/add-word":
                self.send_json({"saved": True, **add_word(payload)})
                return
            if self.path == "/api/settings":
                self.send_json({"saved": True, "settings": save_ai_settings(payload)})
                return
            if self.path == "/api/ask-ai":
                self.send_json({"ok": True, **ask_ai(payload)})
                return
            self.send_error(HTTPStatus.NOT_FOUND)
        except AIUnavailableError as exc:
            self.send_json({"ok": False, "error": str(exc)}, HTTPStatus.SERVICE_UNAVAILABLE)
        except AIRequestError as exc:
            self.send_json({"ok": False, "error": str(exc)}, HTTPStatus.BAD_GATEWAY)
        except (ValueError, KeyError, json.JSONDecodeError) as exc:
            self.send_json({"saved": False, "error": str(exc)}, HTTPStatus.BAD_REQUEST)
        except Exception as exc:  # keep the UI informed without exposing internals
            print(f"Save error: {exc!r}")
            self.send_json({"saved": False, "error": "Could not save to Obsidian."}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def serve_static(self, path: str):
        relative = "index.html" if path in {"", "/"} else unquote(path.lstrip("/"))
        target = (PUBLIC_DIR / relative).resolve()
        if PUBLIC_DIR.resolve() not in target.parents and target != PUBLIC_DIR.resolve():
            self.send_error(HTTPStatus.FORBIDDEN)
            return
        if not target.is_file():
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        data = target.read_bytes()
        content_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main():
    NOTES_DIR.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    url = f"http://{HOST}:{PORT}"
    print(f"\nStella Word Coach is running at {url}")
    print(f"Notes save to: {NOTES_DIR}\n")
    if os.environ.get("WORD_COACH_NO_BROWSER") != "1":
        threading.Timer(0.7, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping Word Coach.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
