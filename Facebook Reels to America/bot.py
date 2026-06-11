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
import re
import shutil
import sys
from pathlib import Path

from parse_analysis import load_contents, save_contents

BASE_DIR    = Path(__file__).parent
PAGES_DIR   = BASE_DIR / "pages"


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
    COMPLETE_DIR = BASE_DIR / "complete"
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


def main():
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
    parser.add_argument("command", choices=["status", "queue", "images", "videos", "archive", "addpage", "updateprompts", "renamepage", "collect", "reconcile"])
    parser.add_argument("project_id", nargs="?", help="reel_0001, page name, old page name for renamepage, or 'apply' for reconcile")
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

    project = pick_project(args.project_id)

    if args.command == "images":
        from phases.image_phase import run
        asyncio.run(run(project))

    elif args.command == "videos":
        from phases.video_phase import run
        asyncio.run(run(project))


if __name__ == "__main__":
    main()
