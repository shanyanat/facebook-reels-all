"""
repair_contents.py — fix a corrupt data/contents.json (stdlib only, no Claude Code needed).

Run from the project root on ANY machine:
    py repair_contents.py

What it does:
  1. Tries to load data/contents.json. If valid, does nothing.
  2. If corrupt, tries to recover in this order:
        a. "Extra data" corruption  -> keeps the first complete JSON array
           (lossless except for a duplicate that was wrongly appended)
        b. falls back to data/contents.json.bak if that one is valid
  3. Saves a timestamped copy of the corrupt file (…​.corrupt-<time>) so nothing
     is ever lost, then writes a clean, re-indented contents.json.

Safe to run repeatedly. Only the standard library is used.
"""

import json
import shutil
import sys
import time
from pathlib import Path

DATA = Path(__file__).parent / "data"
MAIN = DATA / "contents.json"
BAK = DATA / "contents.json.bak"


def _load_valid(path: Path):
    """Return parsed list if path is fully valid JSON, else None."""
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except (json.JSONDecodeError, OSError):
        return None


def _recover_first_doc(path: Path):
    """Recover the first complete JSON array from an 'Extra data' corrupt file."""
    try:
        raw = path.read_text(encoding="utf-8-sig").lstrip("﻿")
        obj, _end = json.JSONDecoder().raw_decode(raw)
        return obj
    except (json.JSONDecodeError, OSError):
        return None


def main():
    if not MAIN.exists() and not BAK.exists():
        sys.exit("No data/contents.json or .bak found — nothing to repair.")

    # 1. Already fine?
    data = _load_valid(MAIN)
    if data is not None:
        print(f"contents.json is already valid ({len(data)} projects). Nothing to do.")
        return

    print("contents.json is corrupt — attempting recovery...")

    # 2a. Try to salvage the first complete array from the corrupt main file
    data = _recover_first_doc(MAIN)
    source = "first valid array inside the corrupt contents.json"

    # 2b. Otherwise fall back to a valid .bak
    if data is None:
        data = _load_valid(BAK)
        source = "contents.json.bak"

    if data is None:
        sys.exit("Could not recover from contents.json or contents.json.bak. "
                 "Restore data/contents.json from a healthy machine's copy.")

    # 3. Quarantine the corrupt file, then write a clean one
    stamp = int(time.time())
    if MAIN.exists():
        quarantine = DATA / f"contents.json.corrupt-{stamp}"
        shutil.copyfile(MAIN, quarantine)
        print(f"Saved corrupt file -> {quarantine.name}")

    MAIN.write_text(
        json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"Repaired contents.json from: {source}")
    print(f"Recovered {len(data)} projects. Now run:  py bot.py status")


if __name__ == "__main__":
    main()
