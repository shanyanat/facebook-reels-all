"""
bot.py — FB Reels Automation CLI (Option B: Playwright/terminal)

Usage:
    py bot.py status                  # show project queue
    py bot.py images [reel_id]        # run ChatGPT image phase
    py bot.py videos [reel_id]        # run Google Flow video phase

Requires Chrome running with --remote-debugging-port=9222.
"""

import argparse
import asyncio
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

from parse_analysis import load_contents, save_contents

BASE_DIR     = Path(__file__).parent
PAGES_DIR    = BASE_DIR / "pages"
COMPLETE_DIR = BASE_DIR / "complete"
ARCHIVE_FILE = BASE_DIR / "data" / "contents.archive.json"
EDITOR_DIR   = BASE_DIR.parent / "Ai Auto Editor"      # sibling tool (FFmpeg + Gemini)
EDITOR_MAIN  = EDITOR_DIR / "main.py"


def _disk_status(pid: str, total: int, working_dir: Path, ready_dir: Path):
    """Count scene files on disk and derive status — never reads contents.json."""
    done_img = done_vid_w = done_vid_r = 0
    for n in range(1, total + 1):
        nn = str(n).zfill(2)
        img_ok = (working_dir / f"{pid}-scene-{nn}.png").exists()
        vdo_w  = (working_dir / f"{pid}-scene-{nn}-vdo.mp4").exists()
        vdo_r  = (ready_dir   / f"scene-{nn}.mp4").exists()
        if img_ok or vdo_w or vdo_r:
            done_img += 1
        if vdo_w:
            done_vid_w += 1
        if vdo_r:
            done_vid_r += 1
    done_vid = done_vid_w + done_vid_r

    if done_vid_r == total and total > 0:
        st = "archived"
    elif done_vid == total and total > 0:
        st = "videos_done"
    elif done_vid > 0:
        st = "videos_in_progress"
    elif done_img == total and total > 0:
        st = "images_done"
    elif (working_dir / f"{pid}-storyboard.png").exists():
        st = "storyboard_done"
    else:
        st = "pending"
    return done_img, done_vid, st


def show_status():
    """
    Build status entirely from the pages/ folder structure on disk.
    contents.json is only used to look up reel IDs and scene counts for
    .txt files we find — it never drives the project list.
    """
    contents = load_contents()
    by_key   = {(p.get("page"), p.get("source_txt")): p for p in contents}
    by_id    = {p["id"]: p for p in contents}
    seen_ids = set()
    rows     = []

    if PAGES_DIR.exists():
        for page_dir in sorted(PAGES_DIR.iterdir()):
            if not page_dir.is_dir():
                continue
            page        = page_dir.name
            working_dir = page_dir / "working"
            ready_base  = page_dir / "ready"

            # 1. Every .txt currently in briefs/ — this is the ground truth queue
            briefs_dir = page_dir / "briefs"
            if briefs_dir.exists():
                for f in sorted(briefs_dir.iterdir()):
                    if f.suffix.lower() != ".txt":
                        continue
                    project = by_key.get((page, f.name))
                    if project:
                        pid = project["id"]
                        seen_ids.add(pid)
                        img, vid, st = _disk_status(
                            pid, project["total_scenes"], working_dir, ready_base / pid
                        )
                        if project.get("project_status") == "complete" and (ready_base / pid).exists():
                            st = "archived"
                        rows.append((pid, page, f.name, st, img, vid, project["total_scenes"]))
                    else:
                        # .txt exists on disk but has no contents.json entry yet
                        rows.append(("(new)", page, f.name, "not queued yet", "-", "-", "-"))

            # 2. Archived reels whose brief was moved into ready/reel_id/
            if ready_base.exists():
                for reel_dir in sorted(ready_base.iterdir()):
                    if not reel_dir.is_dir():
                        continue
                    pid = reel_dir.name
                    if pid in seen_ids:
                        continue
                    project = by_id.get(pid)
                    if project:
                        seen_ids.add(pid)
                        img, vid, st = _disk_status(
                            pid, project["total_scenes"], working_dir, reel_dir
                        )
                        if project.get("project_status") == "complete":
                            st = "archived"
                        rows.append((pid, page, project.get("source_txt", "-"), st,
                                     img, vid, project["total_scenes"]))

    # 3. contents.json entries not found anywhere on disk
    for p in contents:
        pid = p["id"]
        if pid in seen_ids:
            continue
        page        = p.get("page") or "unknown"
        working_dir = PAGES_DIR / page / "working"
        ready_dir   = PAGES_DIR / page / "ready" / pid
        img, vid, st = _disk_status(pid, p["total_scenes"], working_dir, ready_dir)
        if p.get("project_status") == "complete" and ready_dir.exists():
            st = "archived"

        if not (PAGES_DIR / page).exists():
            # Page folder was deleted — show only if user should know about it
            if img > 0 or vid > 0:
                rows.append((pid, page, p.get("source_txt", "-"), "PAGE FOLDER MISSING",
                             img, vid, p["total_scenes"]))
            # Silently skip: no folder + no files = fully orphaned, nothing to act on
        elif img > 0 or vid > 0:
            # Has progress files but brief was renamed/deleted
            rows.append((pid, page, p.get("source_txt", "-"), st + " (brief renamed?)",
                         img, vid, p["total_scenes"]))
        # Silently skip: page exists but brief gone and no files = user cleaned it up

    if not rows:
        print("No projects found. Drop a .txt brief into pages/<page>/briefs/ to start.")
        return

    print(f"{'ID':<12} {'PAGE':<16} {'BRIEF':<28} {'STATUS':<24} {'IMG':<8} VID")
    print("-" * 94)
    for pid, page, brief, status, done_img, done_vid, total in rows:
        img_s = f"{done_img}/{total}" if isinstance(done_img, int) else "-"
        vid_s = f"{done_vid}/{total}" if isinstance(done_vid, int) else "-"
        print(f"{pid:<12} {page:<16} {brief:<28} {status:<24} {img_s:<8} {vid_s}")


def pick_project(project_id):
    contents = load_contents()
    if project_id:
        p = next((x for x in contents if x["id"] == project_id), None)
        if not p:
            sys.exit(f"Project '{project_id}' not found in contents.json")
        return p
    # Auto-select first non-complete project
    p = next((x for x in contents if x["project_status"] != "complete"), None)
    if not p:
        sys.exit("No pending project found. All projects are complete.")
    print(f"Auto-selected project: {p['id']} [{p['project_status']}]")
    return p


def do_archive(project_id: str):
    """
    Archive a completed project to pages/<page>/ready/<reel_id>/:
      - Move  pages/<page>/briefs/<source_txt>      -> ready/<reel_id>/<source_txt>
      - Move  working/<reel_id>-storyboard.png      -> ready/<reel_id>/storyboard.png
      - Move  working/<reel_id>-scene-NN-vdo.mp4    -> ready/<reel_id>/scene-NN.mp4
      - Delete any remaining working/<reel_id>-* files (scene PNGs, etc.)
      - Remove working/ folder if it is now empty
    """
    contents = load_contents()
    project = next((p for p in contents if p["id"] == project_id), None)
    if not project:
        sys.exit(f"Project '{project_id}' not found in contents.json")

    page = project.get("page")
    if not page:
        sys.exit(f"Project '{project_id}' has no 'page' field in contents.json — "
                 f"add it manually: {{\"page\": \"page-a\"}}")

    src_txt_name = project.get("source_txt")
    working_dir = PAGES_DIR / page / "working"
    dest_dir = PAGES_DIR / page / "ready" / project_id
    dest_dir.mkdir(parents=True, exist_ok=True)
    print(f"Archiving {project_id} -> pages/{page}/ready/{project_id}/")

    # 1. Move brief .txt from briefs/ to ready/{reel_id}/
    if src_txt_name:
        src_txt = PAGES_DIR / page / "briefs" / src_txt_name
        if src_txt.exists():
            shutil.move(str(src_txt), dest_dir / src_txt_name)
            print(f"  Moved   {src_txt_name}  (brief)")
        else:
            print(f"  WARNING: brief '{src_txt_name}' not in briefs/ — may already be archived")

    # 2. Move storyboard to ready/
    storyboard_src = working_dir / f"{project_id}-storyboard.png"
    if storyboard_src.exists():
        shutil.move(str(storyboard_src), dest_dir / "storyboard.png")
        print("  Moved   storyboard.png")
    else:
        print(f"  WARNING: {storyboard_src.name} not found in working/")

    # 2.5 Move thumbnail to ready/ (never deleted — kept as a deliverable)
    thumbnail_src = working_dir / f"{project_id}-thumbnail.png"
    if thumbnail_src.exists():
        shutil.move(str(thumbnail_src), dest_dir / "thumbnail.png")
        print("  Moved   thumbnail.png")

    # 3. Move -vdo.mp4 clips -> scene-NN.mp4 (strip project prefix + -vdo suffix)
    vdo_re = re.compile(
        rf"^{re.escape(project_id)}-scene-(\d{{2}})-vdo\.mp4$", re.IGNORECASE
    )
    moved = 0
    for f in sorted(working_dir.iterdir()):
        m = vdo_re.match(f.name)
        if m:
            dst = dest_dir / f"scene-{m.group(1)}.mp4"
            shutil.move(str(f), str(dst))
            print(f"  Moved   scene-{m.group(1)}.mp4")
            moved += 1
    if not moved:
        print("  WARNING: No -vdo.mp4 clips found — videos may still be generating")

    # 4. Delete any remaining files for this project (scene PNGs, etc.)
    leftover_re = re.compile(rf"^{re.escape(project_id)}-", re.IGNORECASE)
    deleted = 0
    for f in list(working_dir.iterdir()):
        if leftover_re.match(f.name):
            f.unlink()
            deleted += 1
    if deleted:
        print(f"  Deleted {deleted} leftover file(s) from working/")

    # 5. Remove working/ if now empty
    try:
        working_dir.rmdir()
        print("  Removed working/ (empty)")
    except OSError:
        pass  # not empty — other projects still have files there

    # 6. Mark complete in contents.json so status shows "archived"
    contents = load_contents()
    for p in contents:
        if p["id"] == project_id:
            p["project_status"] = "complete"
            break
    save_contents(contents)

    has_thumb = (dest_dir / "thumbnail.png").exists()
    thumb_str = " + thumbnail" if has_thumb else ""
    print(f"\n  Done -> pages/{page}/ready/{project_id}/")
    print(f"  Brief + storyboard{thumb_str} + {moved} clip(s) ready for CapCut.")


def do_queue():
    """Scan all pages/*/briefs/ and queue any .txt files not yet in contents.json."""
    from parse_analysis import add_project
    contents = load_contents()
    queued_keys = {(p.get("page"), p.get("source_txt")) for p in contents}

    found = 0
    if not PAGES_DIR.exists():
        print("No pages/ folder found.")
        return

    for page_dir in sorted(PAGES_DIR.iterdir()):
        if not page_dir.is_dir():
            continue
        page = page_dir.name
        briefs_dir = page_dir / "briefs"
        if not briefs_dir.exists():
            continue
        for f in sorted(briefs_dir.iterdir()):
            if f.suffix.lower() != ".txt":
                continue
            if (page, f.name) in queued_keys:
                print(f"  Already queued: {f.name} ({page})")
                continue
            result = add_project(str(f), page_name=page)
            if result:
                print(f"  Queued: {f.name} -> {result} ({page})")
                found += 1

    if found == 0:
        print("No new briefs to queue.")
    else:
        print(f"\n{found} brief(s) queued. Run 'py bot.py status' to confirm.")


def do_addpage(page_name: str):
    """Create pages/<page>/briefs/ and pages/<page>/ready/ folders."""
    page_dir = PAGES_DIR / page_name
    if page_dir.exists():
        print(f"Page '{page_name}' already exists at pages/{page_name}/")
        return
    (page_dir / "briefs").mkdir(parents=True)
    (page_dir / "ready").mkdir(parents=True)
    print(f"Created pages/{page_name}/briefs/")
    print(f"Created pages/{page_name}/ready/")
    print(f"\nNext steps:")
    print(f"  1. Place character sheet image(s) in pages/{page_name}/briefs/")
    print(f"  2. Restart monitor.py so it watches pages/{page_name}/briefs/")
    print(f"  3. Drop .txt brief files into pages/{page_name}/briefs/ to queue content")


def do_renamepage(old_name: str, new_name: str):
    """Rename a page folder on disk and update all references in contents.json."""
    old_dir = PAGES_DIR / old_name
    new_dir = PAGES_DIR / new_name

    if not old_dir.exists():
        sys.exit(f"Page folder not found: pages/{old_name}/")
    if new_dir.exists():
        sys.exit(f"Destination already exists: pages/{new_name}/ — choose a different name.")

    old_dir.rename(new_dir)
    print(f"Renamed on disk: pages/{old_name}/ -> pages/{new_name}/")

    contents = load_contents()
    updated = 0
    for p in contents:
        if p.get("page") == old_name:
            p["page"] = new_name
            updated += 1
    save_contents(contents)

    if updated:
        print(f"Updated {updated} project(s) in contents.json.")
    else:
        print(f"No projects in contents.json referenced '{old_name}' - nothing to update.")
    print("Done. Run 'py bot.py status' to confirm.")


def do_collect():
    """Move all ready/reel_*/ folders into complete/<page>/reel_*/ for editing."""
    moved = 0
    for page_dir in sorted(PAGES_DIR.iterdir()):
        if not page_dir.is_dir():
            continue
        ready_dir = page_dir / "ready"
        if not ready_dir.exists():
            continue
        for reel_dir in sorted(ready_dir.iterdir()):
            if not reel_dir.is_dir() or not reel_dir.name.startswith("reel_"):
                continue
            dest_page = COMPLETE_DIR / page_dir.name
            dest_page.mkdir(parents=True, exist_ok=True)
            dest = dest_page / reel_dir.name
            if dest.exists():
                print(f"  SKIP  {reel_dir.name} — already in complete/{page_dir.name}/")
                continue
            shutil.move(str(reel_dir), str(dest))
            print(f"  ✓  {page_dir.name} / {reel_dir.name}")
            moved += 1
        try:
            ready_dir.rmdir()
        except OSError:
            pass
    if moved == 0:
        print("Nothing to collect — no archived reels found in any pages/*/ready/")
    else:
        print(f"\n{moved} reel folder(s) moved → complete/")


def do_reconcile(apply: bool = False):
    """Align contents.json scene flags to the files actually on disk.

    Upgrade-only: sets image_status / video_status to "done" where the file
    exists but the flag says otherwise. Never downgrades a "done" flag, so a
    temporarily missing file can never re-queue finished work. Disk truth is
    the same check used by _disk_status() and the video phase.

    Dry-run by default — prints every change it WOULD make and writes nothing.
    Pass apply=True to persist.
    """
    contents = load_contents()
    changes = []   # (pid, scene_num, field, old_value)

    for p in contents:
        pid   = p["id"]
        page  = p.get("page")
        if not page:
            continue
        working_dir = PAGES_DIR / page / "working"
        ready_dir   = PAGES_DIR / page / "ready" / pid
        for s in p.get("scenes", []):
            nn = str(s["scene_num"]).zfill(2)
            img_on_disk = (working_dir / f"{pid}-scene-{nn}.png").exists()
            vdo_on_disk = (
                (working_dir / f"{pid}-scene-{nn}-vdo.mp4").exists()
                or (ready_dir / f"scene-{nn}.mp4").exists()
            )
            # Upgrade-only: file present but flag not yet "done"
            if img_on_disk and s.get("image_status") != "done":
                changes.append((pid, s["scene_num"], "image_status", s.get("image_status")))
                if apply:
                    s["image_status"] = "done"
            if vdo_on_disk and s.get("video_status") != "done":
                changes.append((pid, s["scene_num"], "video_status", s.get("video_status")))
                if apply:
                    s["video_status"] = "done"

    if not changes:
        print("Reconcile: nothing to fix — all scene flags already match disk.")
        return

    print(f"{'REEL':<12} {'SCENE':<6} {'FIELD':<14} {'WAS':<10} -> NEW")
    print("-" * 56)
    for pid, scene_num, field, old in changes:
        print(f"{pid:<12} {str(scene_num):<6} {field:<14} {str(old):<10} -> done")
    print("-" * 56)

    img_n = sum(1 for c in changes if c[2] == "image_status")
    vid_n = sum(1 for c in changes if c[2] == "video_status")
    print(f"{len(changes)} change(s): {img_n} image_status, {vid_n} video_status.")

    if apply:
        save_contents(contents)
        print("\nApplied and saved to data/contents.json.")
        print("Run 'py bot.py status' to confirm.")
    else:
        print("\nDRY-RUN — nothing written. Re-run 'py bot.py reconcile apply' to persist.")


def _dir_size(path: Path) -> int:
    """Total size in bytes of a file or directory tree (best-effort)."""
    if path.is_file():
        try:
            return path.stat().st_size
        except OSError:
            return 0
    total = 0
    for f in path.rglob("*"):
        try:
            if f.is_file():
                total += f.stat().st_size
        except OSError:
            pass
    return total


def do_cleanup(apply: bool = False):
    """Reclaim disk by deleting the heavy SOURCE clips of reels that are fully done.

    Only touches a reel folder in complete/<page>/<reel>/ when BOTH are true:
      * an `.uploaded` marker exists (written by the Phase-3 uploader after a
        confirmed Facebook post), AND
      * the edited deliverable `EDITED_*.mp4` is present.
    Then it removes the per-scene `scene-NN.mp4` source clips and the editor's
    `.aiedit_cache/` — the bulk of the space — while KEEPING the edited mp4,
    storyboard.png, thumbnail.png, and the .txt brief.

    Dry-run by default — prints what it WOULD delete. Pass apply=True
    (CLI: 'cleanup apply') to actually delete.
    """
    if not COMPLETE_DIR.exists():
        print("Cleanup: no complete/ folder yet — nothing to do.")
        return

    targets = []  # (reel_dir, [paths to delete], bytes)
    for page_dir in sorted(COMPLETE_DIR.iterdir()):
        if not page_dir.is_dir():
            continue
        for reel_dir in sorted(page_dir.iterdir()):
            if not reel_dir.is_dir() or not reel_dir.name.startswith("reel_"):
                continue
            if not (reel_dir / ".uploaded").exists():
                continue   # not confirmed-uploaded — leave it fully intact
            if not any(reel_dir.glob("EDITED_*.mp4")):
                continue   # no edited deliverable — keep sources as a safety net

            dels = list(reel_dir.glob("scene-*.mp4"))
            cache = reel_dir / ".aiedit_cache"
            if cache.exists():
                dels.append(cache)
            if not dels:
                continue
            size = sum(_dir_size(p) for p in dels)
            targets.append((reel_dir, dels, size))

    if not targets:
        print("Cleanup: nothing to reclaim — no uploaded reels with source clips found.")
        print("  (A reel is eligible only after the uploader writes an '.uploaded' marker.)")
        return

    total_bytes = sum(t[2] for t in targets)
    print(f"{'REEL':<12} {'PAGE':<26} {'FILES':<7} MB")
    print("-" * 56)
    for reel_dir, dels, size in targets:
        n_files = sum(1 for _ in dels)
        print(f"{reel_dir.name:<12} {reel_dir.parent.name:<26} {n_files:<7} {size/1024/1024:.1f}")
    print("-" * 56)
    print(f"{len(targets)} reel(s), {total_bytes/1024/1024:.1f} MB would be reclaimed "
          f"(edited mp4 + thumbnail + brief kept).")

    if not apply:
        print("\nDRY-RUN — nothing deleted. Re-run 'py bot.py cleanup apply' to reclaim.")
        return

    reclaimed = 0
    for reel_dir, dels, size in targets:
        for p in dels:
            try:
                if p.is_dir():
                    shutil.rmtree(p, ignore_errors=True)
                else:
                    p.unlink()
            except OSError as e:
                print(f"  WARNING: could not delete {p.name} in {reel_dir.name}: {e}")
        reclaimed += size
    print(f"\nReclaimed {reclaimed/1024/1024:.1f} MB from {len(targets)} reel(s).")


def do_prune(apply: bool = False):
    """Move finished projects out of the live contents.json into an archive file.

    A project is prunable only when it is BOTH:
      * project_status == "complete", AND
      * its deliverables have been collected to complete/<page>/<reel>/ (folder exists).

    These entries are pure dead weight in contents.json — every scene-flag save
    rewrites the whole file, so trimming it keeps writes fast and shrinks the
    blast radius of any corruption. Pruned entries are appended to
    data/contents.archive.json (never deleted), so nothing is lost.

    Dry-run by default — prints what it WOULD move and writes nothing.
    Pass apply=True (CLI: 'prune apply') to persist.
    """
    contents = load_contents()
    to_prune, keep = [], []
    for p in contents:
        pid  = p["id"]
        page = p.get("page")
        collected = bool(page and (COMPLETE_DIR / page / pid).exists())
        if p.get("project_status") == "complete" and collected:
            to_prune.append(p)
        else:
            keep.append(p)

    if not to_prune:
        print("Prune: nothing to archive — no completed + collected projects in contents.json.")
        print(f"Live contents.json has {len(contents)} project(s).")
        return

    print(f"{'REEL':<12} {'PAGE':<26} STATUS")
    print("-" * 50)
    for p in to_prune:
        print(f"{p['id']:<12} {(p.get('page') or '-'):<26} {p.get('project_status')}")
    print("-" * 50)
    print(f"{len(to_prune)} project(s) would move to data/contents.archive.json; "
          f"{len(keep)} remain live.")

    if not apply:
        print("\nDRY-RUN — nothing written. Re-run 'py bot.py prune apply' to persist.")
        return

    # Append to the archive file (read existing, extend, atomic write).
    existing = []
    if ARCHIVE_FILE.exists():
        try:
            existing = json.loads(ARCHIVE_FILE.read_text(encoding="utf-8"))
            if not isinstance(existing, list):
                existing = []
        except (json.JSONDecodeError, OSError):
            existing = []   # corrupt/old archive — start fresh rather than crash
    existing.extend(to_prune)

    ARCHIVE_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = ARCHIVE_FILE.with_name(ARCHIVE_FILE.name + ".tmp")
    tmp.write_text(json.dumps(existing, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(ARCHIVE_FILE)   # atomic swap — readers never see a half file

    save_contents(keep)   # crash-safe (validated + backed up) — see parse_analysis

    print(f"\nArchived {len(to_prune)} project(s) → data/contents.archive.json "
          f"({len(existing)} total archived).")
    print(f"Live contents.json now has {len(keep)} project(s).")
    print("Run 'py bot.py status' to confirm.")


def _run_editor_batch(page: str, notify) -> bool:
    """Run Ai Auto Editor over complete/<page>/ (all reels, skips already-done ones).
    Returns True if it ran cleanly (or had nothing to do). Never raises."""
    complete_page = COMPLETE_DIR / page
    if not complete_page.exists():
        print(f"  [edit] no complete/{page}/ folder yet — skipping editor")
        return True
    if not EDITOR_MAIN.exists():
        msg = f"Ai Auto Editor not found at {EDITOR_MAIN} — skipping edit step for {page}"
        print(f"  [edit] {msg}")
        notify(f"⚠️ {msg}")
        return False
    print(f"  [edit] Ai Auto Editor --batch complete/{page}/ ...")
    try:
        # cwd = editor dir so its `from common import ...`, config.json and .env resolve.
        result = subprocess.run(
            [sys.executable, str(EDITOR_MAIN), "--batch", str(complete_page)],
            cwd=str(EDITOR_DIR),
            timeout=3 * 3600,   # generous: many reels × FFmpeg renders
            # Force UTF-8 in the child so its ✓/— prints don't crash on a cp874 console.
            env={**os.environ, "PYTHONIOENCODING": "utf-8"},
        )
    except Exception as e:
        print(f"  [edit] ERROR launching editor: {e}")
        notify(f"❌ Edit step failed to launch for {page}: {e}")
        return False
    if result.returncode != 0:
        notify(f"⚠️ Ai Auto Editor exited with code {result.returncode} for {page}")
        return False
    return True


def do_force_complete(project_id: str):
    """Finish a reel NOW with whatever clips exist — no minimum.

    The auto-advance (and the normal pipeline) only push a reel forward when ALL
    its videos are done. This is the manual override for when an external tool
    (Veo/ChatGPT) just won't produce every clip and you decide the finished ones
    are good enough: it runs the full downstream — archive (moves whatever
    -vdo.mp4 clips are on disk) -> collect -> edit — exactly like a complete reel.

    This is the backend action the dashboard's "accept partial" button will call.
    """
    from notify import notify
    contents = load_contents()
    project = next((p for p in contents if p["id"] == project_id), None)
    if not project:
        sys.exit(f"Project '{project_id}' not found in contents.json")
    page = project.get("page")
    if not page:
        sys.exit(f"Project '{project_id}' has no 'page' field")

    # Count finished clips just for the log (no gate — we proceed regardless).
    working_dir = PAGES_DIR / page / "working"
    total = project.get("total_scenes", 0)
    have = sum(
        1 for n in range(1, total + 1)
        if (working_dir / f"{project_id}-scene-{str(n).zfill(2)}-vdo.mp4").exists()
    )
    print(f"Force-completing {project_id} with {have}/{total} clip(s) on disk ...")

    do_archive(project_id)
    do_collect()
    ok = _run_editor_batch(page, notify)

    if ok:
        print(f"\nForce-complete done — {project_id} archived + edited "
              f"({have}/{total} clips). Ready for upload.")
        notify(f"✅ Force-completed {project_id} ({page}) with {have}/{total} clips — ready for upload")
    else:
        print(f"\n{project_id} archived ({have}/{total} clips) but the edit step had "
              f"issues — check the Ai Auto Editor output above.")


def do_pipeline(page: str):
    """End-to-end automation for ONE page (or every page when page == 'all').

    Sequential by design — image and video phases share the Chrome profile, so
    they must never overlap. Per reel: images -> verify -> videos -> verify ->
    archive. Then collect the whole page and run the auto-editor over it.

    Disk truth gates each step (a phase that 'returns' on a logged error without
    raising still leaves files missing on disk, so we detect that and alert
    instead of archiving a half-finished reel). A failure on one reel is alerted
    and skipped; the pipeline continues with the rest.
    """
    from notify import notify
    from preflight import preflight

    # 'all' (or empty) -> loop every page folder, isolating failures per page.
    if not page or page == "all":
        pages = [d.name for d in sorted(PAGES_DIR.iterdir()) if d.is_dir()] \
            if PAGES_DIR.exists() else []
        if not pages:
            print("No page folders found.")
            return
        for pg in pages:
            try:
                do_pipeline(pg)
            except (Exception, SystemExit) as e:
                notify(f"❌ Pipeline crashed on page {pg}: {e!r}")
                print(f"[pipeline] ERROR on {pg}: {e!r} — continuing to next page")
        return

    if not (PAGES_DIR / page).exists():
        sys.exit(f"Page folder not found: pages/{page}/")

    # 1. Pre-flight (kills stray Chrome, disk check). Abort the page if it fails.
    if not preflight():
        notify(f"🛑 Pipeline aborted for {page}: preflight failed (see disk space).")
        return

    notify(f"▶️ Pipeline started: {page}")
    print(f"\n{'='*60}\nPIPELINE: {page}\n{'='*60}")

    # 2. Register any new briefs sitting in this page's briefs/ folder.
    do_queue()

    # Process ONLY reels whose brief .txt is still in this page's briefs/ folder —
    # the same "ground truth queue" that status uses. contents.json keeps every
    # old reel ever queued for this page (their `page` survives a renamepage, and
    # they are never pruned until collected), so filtering by page alone would
    # re-run ancient reels whose briefs are long gone and whose character-sheet
    # paths point at the pre-rename folder. The brief-in-folder check is what
    # restricts the run to the current briefs the user actually dropped in.
    briefs_dir = PAGES_DIR / page / "briefs"
    projects = [
        p for p in load_contents()
        if p.get("page") == page
        and p.get("source_txt")
        and (briefs_dir / p["source_txt"]).exists()
    ]
    if not projects:
        notify(f"ℹ️ Pipeline: no current briefs in pages/{page}/briefs/")
        print(f"  No briefs in pages/{page}/briefs/ — drop .txt files there first.")
        return

    working_dir = PAGES_DIR / page / "working"
    archived_ok = 0

    for p in projects:
        pid   = p["id"]
        total = p.get("total_scenes", 0)
        ready_dir = PAGES_DIR / page / "ready" / pid
        print(f"\n--- {pid} ({total} scenes) ---")

        # Skip reels already fully done + collected.
        if (COMPLETE_DIR / page / pid).exists():
            print(f"  {pid}: already collected — skipping to edit step")
            continue

        # 3. Images (storyboard + scenes + thumbnail). Disk-gated.
        img, _, _ = _disk_status(pid, total, working_dir, ready_dir)
        if total and img >= total:
            print(f"  {pid}: images already on disk ({img}/{total})")
        else:
            from phases.image_phase import run as run_images
            # Catch SystemExit too: ensure_logged_in_chatgpt() calls sys.exit() on a
            # login lapse, which would otherwise abort the whole pipeline silently.
            try:
                asyncio.run(run_images(p))
            except (Exception, SystemExit) as e:
                notify(f"❌ {pid} ({page}): image phase aborted ({e!r}) — skipping reel")
                print(f"  {pid}: image phase aborted ({e!r}) — skipping")
                continue
            img, _, _ = _disk_status(pid, total, working_dir, ready_dir)
            if not total or img < total:
                notify(f"❌ {pid} ({page}): images incomplete ({img}/{total}) — skipping this reel")
                print(f"  {pid}: images incomplete ({img}/{total}) — skipping")
                continue

        # Reload project from disk: the image phase wrote image_status="done" into
        # contents.json but did NOT mutate our in-memory dict. The video phase
        # selects scenes where image_status=="done", so it must see fresh state or
        # it would generate nothing.
        p = next((x for x in load_contents() if x["id"] == pid), p)

        # 4. Videos. Disk-gated.
        _, vid, _ = _disk_status(pid, total, working_dir, ready_dir)
        if total and vid >= total:
            print(f"  {pid}: videos already on disk ({vid}/{total})")
        else:
            from phases.video_phase import run as run_videos
            try:
                asyncio.run(run_videos(p))
            except (Exception, SystemExit) as e:
                notify(f"❌ {pid} ({page}): video phase aborted ({e!r}) — skipping reel")
                print(f"  {pid}: video phase aborted ({e!r}) — skipping")
                continue
            _, vid, _ = _disk_status(pid, total, working_dir, ready_dir)
            if not total or vid < total:
                notify(f"❌ {pid} ({page}): videos incomplete ({vid}/{total}) — skipping this reel")
                print(f"  {pid}: videos incomplete ({vid}/{total}) — skipping")
                continue

        # 5. Archive this finished reel into ready/<pid>/.
        try:
            do_archive(pid)
            archived_ok += 1
        except (Exception, SystemExit) as e:
            notify(f"❌ {pid} ({page}): archive failed ({e!r})")
            print(f"  {pid}: archive failed ({e!r})")
            continue

    # 6. Collect all archived reels of every page into complete/<page>/.
    do_collect()

    # 7. Auto-edit the whole page (skips reels already rendered).
    edit_ok = _run_editor_batch(page, notify)

    edited = sorted(
        d.name for d in (COMPLETE_DIR / page).iterdir()
        if (COMPLETE_DIR / page).exists() and d.is_dir()
        and any(d.glob("EDITED_*.mp4"))
    ) if (COMPLETE_DIR / page).exists() else []

    notify(f"✅ Pipeline done: {page} — {archived_ok} reel(s) archived this run, "
           f"{len(edited)} edited mp4(s) ready"
           + ("" if edit_ok else " (edit step had issues — check logs)"))
    print(f"\n{'='*60}\nPIPELINE DONE: {page} — {archived_ok} archived, "
          f"{len(edited)} edited\n{'='*60}")


def _force_utf8_console():
    """Make stdout/stderr tolerate ✓/— and emoji on legacy consoles (e.g. cp874),
    so a print can never crash the bot. Best-effort; harmless if unsupported."""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


def main():
    _force_utf8_console()
    parser = argparse.ArgumentParser(
        description="FB Reels Automation Bot — Playwright/terminal approach",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  py bot.py status
  py bot.py addpage page-b
  py bot.py images
  py bot.py images reel_0001
  py bot.py videos reel_0001
  py bot.py archive reel_0001
        """,
    )
    parser.add_argument("command", choices=["status", "queue", "images", "videos", "archive", "addpage", "updateprompts", "renamepage", "collect", "reconcile", "prune", "preflight", "cleanup", "pipeline", "force-complete"])
    parser.add_argument("project_id", nargs="?", help="reel_0001, page name, 'all' for pipeline, old page name for renamepage, or 'apply' for reconcile/prune")
    parser.add_argument("new_name", nargs="?", help="new page name (renamepage only)")
    args = parser.parse_args()

    if args.command == "status":
        show_status()
        return

    if args.command == "queue":
        do_queue()
        return

    if args.command == "addpage":
        if not args.project_id:
            sys.exit("Usage: py bot.py addpage <page-name>  e.g. py bot.py addpage page-b")
        do_addpage(args.project_id)
        return

    if args.command == "renamepage":
        if not args.project_id or not args.new_name:
            sys.exit("Usage: py bot.py renamepage <old-name> <new-name>\n"
                     "  e.g. py bot.py renamepage page-Noble-Handiwork 3-page-Noble-Handiwork")
        do_renamepage(args.project_id, args.new_name)
        return

    if args.command == "archive":
        if not args.project_id:
            sys.exit("Usage: py bot.py archive reel_0001")
        do_archive(args.project_id)
        return

    if args.command == "updateprompts":
        if not args.project_id:
            sys.exit("Usage: py bot.py updateprompts reel_0001")
        from parse_analysis import update_project_prompts
        update_project_prompts(args.project_id)
        return

    if args.command == "collect":
        do_collect()
        return

    if args.command == "reconcile":
        do_reconcile(apply=(args.project_id == "apply"))
        return

    if args.command == "prune":
        do_prune(apply=(args.project_id == "apply"))
        return

    if args.command == "preflight":
        from preflight import preflight
        sys.exit(0 if preflight() else 1)

    if args.command == "cleanup":
        do_cleanup(apply=(args.project_id == "apply"))
        return

    if args.command == "pipeline":
        if not args.project_id:
            sys.exit("Usage: py bot.py pipeline <page>   (or 'all' for every page)")
        do_pipeline(args.project_id)
        return

    if args.command == "force-complete":
        if not args.project_id:
            sys.exit("Usage: py bot.py force-complete reel_0001")
        do_force_complete(args.project_id)
        return

    project = pick_project(args.project_id)

    if args.command == "images":
        from phases.image_phase import run
        asyncio.run(run(project))

    elif args.command == "videos":
        from phases.video_phase import run
        asyncio.run(run(project))


if __name__ == "__main__":
    main()
