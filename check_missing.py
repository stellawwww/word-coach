#!/usr/bin/env python3
"""List vocabulary words that still have no entry in contexts.json.

Usage:  python3 check_missing.py
Then paste the output to Claude Code and ask it to write the missing entries
(no API key needed -- Claude writes them directly into contexts.json).
"""
import csv, json, os
from pathlib import Path

APP = Path(__file__).resolve().parent
if os.environ.get("WORD_COACH_VAULT"):
    _csv = Path(os.environ["WORD_COACH_VAULT"]) / "Vocabulary" / "Youdao Vocabulary.csv"
else:
    _csv = APP / "sample" / "vocabulary.csv"
CSV_PATH = Path(os.environ.get("WORD_COACH_CSV", _csv))
CTX_PATH = Path(os.environ.get("WORD_COACH_CONTEXTS", APP / "contexts.json"))
FIELDS = ("meaning", "daily", "natural", "scene")

ctx = json.loads(CTX_PATH.read_text(encoding="utf-8"))
words = []
with CSV_PATH.open(encoding="utf-8-sig", newline="") as fh:
    for row in csv.DictReader(fh):
        w = (row.get("word") or "").strip()
        if w:
            words.append(w)

uniq = sorted({w.lower() for w in words})
missing = [w for w in uniq if w not in ctx]
incomplete = sorted(k for k, v in ctx.items() if not all(v.get(f) for f in FIELDS))

print(f"CSV words        : {len(uniq)} unique ({len(words)} rows)")
print(f"contexts.json    : {len(ctx)} entries")
print(f"missing context  : {len(missing)}")
print(f"incomplete entry : {len(incomplete)}")
if missing:
    print("\nMISSING:\n" + ", ".join(missing))
if incomplete:
    print("\nINCOMPLETE:\n" + ", ".join(incomplete))
if not missing and not incomplete:
    print("\nAll words have complete context. Nothing to do.")
