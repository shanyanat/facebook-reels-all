"""
preflight.py — pre-run safety checks for the Reels pipeline (stdlib only).

Run this BEFORE an images/videos phase or a scheduled pipeline run. It heads off
the three failure modes that turn a small problem into a crash-into-corruption loop:

  1. Stray Chrome  — a crashed previous run can leave a chrome.exe holding the
     shared profile lock (C:/temp/chrome-bot), so the next launch fails. We kill
     only Chrome processes whose command line points at THAT profile.
  2. Low disk      — if the disk is nearly full, save_contents() can't write its
     temp file and you risk a broken state. We abort + Telegram-alert below a
     threshold so the run never starts on a doomed machine.
  3. Old quarantine — repair_contents.py leaves data/*.corrupt-* files behind.
     We delete ones older than N days so they don't pile up.

Never raises for routine conditions; returns an ok/not-ok result the caller acts on.

CLI:
    py preflight.py                 # run all checks (10 GB min free, 7-day corrupt age)
    py preflight.py --min-free 5    # custom disk threshold in GB
    py preflight.py --no-kill       # skip the stray-Chrome kill
Exit code is 0 if OK, 1 if a blocking check failed (low disk).

Note: do NOT run this while a phase you want to keep is mid-run — it will kill
that phase's Chrome. It is a pre-run step, not a concurrent one.
"""

import argparse
import shutil
import subprocess
import sys
import time
from pathlib import Path

from notify import notify

BASE_DIR = Path(__file__).parent
DATA_DIR = BASE_DIR / "data"
CHROME_PROFILE = Path("C:/temp/chrome-bot")          # must match phases/*.py
# A unique token from the profile path so we only match OUR Chrome, not the
# user's normal browser.
_PROFILE_TOKEN = "chrome-bot"


def log(msg: str):
    line = f"[preflight] {msg}"
    try:
        print(line, flush=True)
    except UnicodeEncodeError:
        # Some Windows consoles use a legacy codepage (e.g. cp874) that can't
        # encode emoji. Degrade gracefully instead of crashing the run.
        enc = sys.stdout.encoding or "ascii"
        print(line.encode(enc, "replace").decode(enc), flush=True)


# ── 1. Kill stray Chrome bound to the bot profile ──────────────────────────────

def kill_stray_chrome() -> int:
    """Kill chrome.exe processes whose command line references the bot profile.
    Windows-only (uses CIM); a no-op elsewhere. Returns how many were killed."""
    if not sys.platform.startswith("win"):
        log("Not Windows — skipping stray-Chrome check.")
        return 0

    ps_cmd = (
        "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" "
        f"| Where-Object {{ $_.CommandLine -like '*{_PROFILE_TOKEN}*' }} "
        "| Select-Object -ExpandProperty ProcessId"
    )
    try:
        res = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", ps_cmd],
            capture_output=True, text=True, timeout=30,
        )
    except Exception as e:
        log(f"WARNING: could not query Chrome processes ({e}) — skipping kill.")
        return 0

    pids = [ln.strip() for ln in res.stdout.splitlines() if ln.strip().isdigit()]
    if not pids:
        log("No stray bot-Chrome processes found.")
        return 0

    killed = 0
    for pid in pids:
        try:
            subprocess.run(["taskkill", "/PID", pid, "/F", "/T"],
                           capture_output=True, text=True, timeout=15)
            killed += 1
        except Exception as e:
            log(f"WARNING: could not kill PID {pid} ({e})")
    log(f"Killed {killed} stray bot-Chrome process(es): {', '.join(pids)}")
    return killed


# ── 2. Disk space ──────────────────────────────────────────────────────────────

def check_disk(min_free_gb: float) -> bool:
    """Return True if free space on the project's drive is >= min_free_gb."""
    usage = shutil.disk_usage(str(BASE_DIR))
    free_gb = usage.free / (1024 ** 3)
    log(f"Disk free: {free_gb:.1f} GB (need >= {min_free_gb:.1f} GB)")
    if free_gb < min_free_gb:
        msg = (f"🛑 Low disk on {BASE_DIR.drive or BASE_DIR}: "
               f"{free_gb:.1f} GB free (< {min_free_gb:.1f} GB). "
               f"Run aborted — clear space (py bot.py cleanup / prune).")
        log(msg)
        notify(msg)
        return False
    return True


# ── 3. Old quarantine files ────────────────────────────────────────────────────

def clean_corrupt(age_days: float) -> int:
    """Delete data/*.corrupt-* files older than age_days. Returns count deleted."""
    if not DATA_DIR.exists():
        return 0
    cutoff = time.time() - age_days * 86400
    deleted = 0
    for f in DATA_DIR.glob("*.corrupt-*"):
        try:
            if f.is_file() and f.stat().st_mtime < cutoff:
                f.unlink()
                deleted += 1
        except OSError:
            pass
    if deleted:
        log(f"Deleted {deleted} old quarantine file(s) (older than {age_days:g} days).")
    return deleted


# ── Orchestration ──────────────────────────────────────────────────────────────

def preflight(min_free_gb: float = 10.0,
              corrupt_age_days: float = 7.0,
              kill_chrome: bool = True) -> bool:
    """Run all checks. Returns True if it is safe to proceed, False if a blocking
    check failed (currently only low disk blocks)."""
    log("Running pre-run checks ...")
    if kill_chrome:
        kill_stray_chrome()
    clean_corrupt(corrupt_age_days)
    ok = check_disk(min_free_gb)
    log("Preflight OK" if ok else "Preflight FAILED")
    return ok


def main():
    parser = argparse.ArgumentParser(description="Pre-run safety checks for the Reels pipeline")
    parser.add_argument("--min-free", type=float, default=10.0,
                        help="Minimum free disk in GB before a run is allowed (default 10)")
    parser.add_argument("--corrupt-age", type=float, default=7.0,
                        help="Delete data/*.corrupt-* older than this many days (default 7)")
    parser.add_argument("--no-kill", action="store_true",
                        help="Skip killing stray bot-Chrome processes")
    args = parser.parse_args()

    ok = preflight(min_free_gb=args.min_free,
                   corrupt_age_days=args.corrupt_age,
                   kill_chrome=not args.no_kill)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
