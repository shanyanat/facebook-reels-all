"""editor_queue.py — the editor, in its OWN tab.

Run this in a SEPARATE terminal from monitor.py:

    py editor_queue.py

Why a separate tab: monitor.py prints generation activity (the extension saving
images/videos) while the editor prints its own batch/scan/render output. In one
console those two live streams interleave and become hard to read. Splitting the
editor into this process keeps each tab's log clean and contiguous:

    Tab 1  py monitor.py        -> generation + archive + caption
    Tab 2  py editor_queue.py   -> editing only (this file)

It is SAFE to run alongside monitor.py: editing is guarded by a cross-process
lock (data/editor.lock) inside bot._run_editor_batch, so there is still only ever
ONE editor running — no double-render — even though it is now its own process.

Behaviour is identical to the old in-monitor worker: every EDITOR_SCAN_INTERVAL
seconds it scans complete/<page>/ for reels that have scene clips but no EDITED_
output and runs the Ai Auto Editor over each page (the editor itself skips reels
already rendered). A reel that fails to render MAX_EDIT_ATTEMPTS times in a row is
marked `.editfailed` and skipped, so one un-editable reel can't spin forever.
"""
import sys
import time
from pathlib import Path

from bot import _run_editor_batch, sweep_captions
from notify import notify, notify_error

BASE_DIR = Path(__file__).parent
COMPLETE_DIR = BASE_DIR / "complete"

EDITOR_SCAN_INTERVAL = 30   # seconds between scans of complete/ for unedited reels
MAX_EDIT_ATTEMPTS = 3       # after this many failed passes, stop retrying a reel

# In-memory per-reel failed-edit counter (keyed by folder path). A reel that still
# lacks EDITED_ output after an editor pass gets +1; at MAX_EDIT_ATTEMPTS it is
# marked with a `.editfailed` file and skipped, so a single un-editable reel (e.g.
# a corrupt clip) can't make the loop relaunch the editor — and spam notifies —
# every 30s forever. Delete the `.editfailed` file to let it retry.
_edit_attempts = {}


def log(msg):
    print(f"[editor] {msg}", flush=True)


def _reel_needs_edit(reel_dir: Path) -> bool:
    """A collected reel needs editing if it has scene clips but no EDITED_ output.
    '.-' folders are the user's 'already posted' marker — strictly off-limits.
    A reel marked `.editfailed` (gave up after repeated failures) is skipped."""
    if not reel_dir.is_dir() or reel_dir.name.endswith(".-"):
        return False
    if (reel_dir / ".editfailed").exists():
        return False
    has_clip = any(
        f.suffix.lower() == ".mp4" and not f.name.upper().startswith("EDITED_")
        for f in reel_dir.iterdir()
    )
    if not has_clip:
        return False
    has_edited = any(
        f.name.upper().startswith("EDITED_") and f.suffix.lower() == ".mp4"
        for f in reel_dir.iterdir()
    )
    return not has_edited


def _pages_needing_edit() -> list:
    """Pages under complete/ that have at least one reel needing editing."""
    if not COMPLETE_DIR.exists():
        return []
    pages = []
    for page_dir in sorted(COMPLETE_DIR.iterdir()):
        if not page_dir.is_dir():
            continue
        if any(_reel_needs_edit(r) for r in page_dir.iterdir()):
            pages.append(page_dir.name)
    return pages


def run_once():
    """One scan: render every page that has unedited reels (batch skips done ones)."""
    for page in _pages_needing_edit():
        page_dir = COMPLETE_DIR / page
        # Snapshot which reels need editing BEFORE the pass, so afterwards we can
        # tell which ones the editor failed to render (still no EDITED_).
        before = [r for r in page_dir.iterdir() if _reel_needs_edit(r)]
        log(f"rendering {len(before)} unedited reel(s) in complete/{page}/ ...")
        _run_editor_batch(page, notify)   # cross-process lock lives inside here
        sweep_captions(page)

        rendered = [r for r in before if not _reel_needs_edit(r)]
        for r in rendered:
            _edit_attempts.pop(str(r), None)   # success — reset its counter
        if rendered:
            notify(f"✅ Editor: complete/{page}/ — {len(rendered)} reel(s) "
                   f"edited + caption, ready to post")

        # Reels still un-rendered after the pass: count a failure; give up at the cap.
        for r in before:
            if not _reel_needs_edit(r):
                continue
            n = _edit_attempts.get(str(r), 0) + 1
            _edit_attempts[str(r)] = n
            if n >= MAX_EDIT_ATTEMPTS:
                try:
                    (r / ".editfailed").write_text(
                        f"editor failed {n} times; skipping. delete this file to retry.",
                        encoding="utf-8")
                except OSError:
                    pass
                notify(f"❌ {r.name} ({page}): edit failed {n}x — marked .editfailed "
                       f"and will be skipped. Check its clips; delete .editfailed to retry.")


def main():
    # Tolerate the editor child's ✓/—/emoji prints on legacy consoles (cp874).
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

    log("Editor queue started — this tab handles EDITING only.")
    log("Run `py monitor.py` in another tab for generation. Press Ctrl+C to stop.")
    try:
        while True:
            try:
                run_once()
            except Exception as e:
                log(f"ERROR: {e}")
                notify_error("editor queue", e)
            time.sleep(EDITOR_SCAN_INTERVAL)
    except KeyboardInterrupt:
        log("Stopped.")


if __name__ == "__main__":
    main()
