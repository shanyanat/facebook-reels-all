"""AI Auto Editor — orchestrator.

Two ways to run:

  A) Point at a reel folder (recommended for your workflow):
     py main.py --folder "....\\reel_0110"
     - reads scene-01.mp4 ... scene-NN.mp4 from that folder
     - reads the .txt in that folder and uses each scene's "Action :" line as its brief
     - caches detections inside the folder (.aiedit_cache) so reels never mix up
     - writes EDITED_<foldername>.mp4 into that same folder

  B) Use the local input/ folder + briefs.csv:
     py main.py

Flags: --dry-run (show cuts only, no render), --force (ignore cache, re-ask Gemini).
"""
import argparse
import csv
import json
import os
import re
import sys
from datetime import datetime

from common import (
    BRIEFS_PATH, OUTPUT_DIR, CACHE_DIR,
    list_clips, list_clips_in, find_music, find_txt, scene_id, scene_number,
    page_name_from_path, load_config,
)
from detect import detect_clip, detect_hook

ACTION_RE = re.compile(r"^\s*Action\s*[:：]\s*(.+?)\s*$", re.IGNORECASE)


def load_briefs_csv(path):
    """Read a scene,brief CSV -> {scene_id: brief}. Missing file -> {}."""
    briefs = {}
    if not path or not os.path.exists(path):
        return briefs
    with open(path, "r", encoding="utf-8-sig", newline="") as f:
        for row in csv.DictReader(f):
            scene = (row.get("scene") or "").strip()
            if scene:
                briefs[scene] = (row.get("brief") or "").strip()
    return briefs


def parse_actions_from_txt(txt_path):
    """Pull the per-scene 'Action :' lines from a reel .txt, in order.

    If a 'VIDEO PROMPT' heading exists, scan from there; otherwise from the top
    (the storyboard/video section, whose Action lines match the clips, comes first).
    """
    with open(txt_path, "r", encoding="utf-8", errors="ignore") as f:
        lines = f.read().splitlines()
    start = 0
    for i, ln in enumerate(lines):
        if re.search(r"VIDEO\s*PROMPT", ln, re.IGNORECASE):
            start = i
            break
    actions = []
    for ln in lines[start:]:
        m = ACTION_RE.match(ln)
        if m:
            actions.append(m.group(1).strip())
    return actions


def briefs_for_folder(folder, clips):
    """Return a brief per clip, mapped by SCENE NUMBER (so missing scenes are fine).

    folder/briefs.csv overrides the .txt. The .txt's Nth 'Action :' line is scene N,
    so clip 'scene-07.mp4' always gets action #7 even if scene-06 has no clip.
    """
    # Manual override: a briefs.csv sitting in the reel folder wins.
    override = load_briefs_csv(os.path.join(folder, "briefs.csv"))
    if override:
        return [override.get(scene_id(c), "") for c in clips], "briefs.csv (manual)"

    txt = find_txt(folder)
    if not txt:
        return [""] * len(clips), "none (no .txt found — scenes kept whole)"

    actions = parse_actions_from_txt(txt)
    briefs = []
    for c in clips:
        n = scene_number(c)
        briefs.append(actions[n - 1] if n and 1 <= n <= len(actions) else "")
    return briefs, f"{os.path.basename(txt)} ({len(actions)} Action lines, mapped by scene number)"


def run(clips, briefs, cfg, cache_dir, music, out_path, dry_run, force, watermark=""):
    """Shared detect + report + render path for both modes."""
    detections = []
    print(f"Analyzing {len(clips)} clip(s) with {cfg['model']} "
          f"(analysis_fps={cfg['analysis_fps']}) ...")
    for clip, brief in zip(clips, briefs):
        print(f"- {scene_id(clip)}")
        det = detect_clip(clip, brief, cfg, force=force, cache_dir=cache_dir)
        det["clip_path"] = clip
        detections.append(det)

    print("\nDetected keep-ranges:")
    total = 0.0
    for det in detections:
        kept = sum(e - s for s, e in det["segments"])
        total += kept
        ranges = ", ".join(f"{s:.2f}-{e:.2f}" for s, e in det["segments"])
        flag = "" if det["source"] == "gemini" else f"  [{det['source']}]"
        brief_preview = (det.get("brief") or "")[:60]
        print(f"  {det['scene']}: {ranges}  (kept {kept:.2f}/{det['duration']:.2f}s, "
              f"conf {det['confidence']:.2f}){flag}")
        print(f"      brief: {brief_preview}")
    speed = float(cfg.get("speed_factor", 1.0)) or 1.0
    print(f"  => kept ~{total:.2f}s of footage; final ~{total / speed:.2f}s "
          f"after {speed}x speed-up (before crossfades)")

    ai = sum(1 for d in detections if d["source"] == "gemini")
    unsure = sum(1 for d in detections if d["source"] == "fallback-whole-clip")
    failed = sum(1 for d in detections if d["source"] == "error-whole-clip")
    print(f"  AI-trimmed: {ai}/{len(detections)} scenes"
          + (f" | AI unsure (kept whole): {unsure}" if unsure else "")
          + (f" | NOT done (rate-limit/error): {failed}" if failed else ""))
    if failed:
        print("  ⚠ Some scenes were NOT processed by AI. Run the SAME command again "
              "to retry just those (failures are never saved).\n")
    else:
        print()

    # ── HOOK: prepend a short AI-picked teaser from the LAST scene ──────────────
    # The most attention-grabbing moment (the result/reveal) plays first, before
    # scene 1, then the reel runs scene 1..N as usual (the last scene plays again
    # in full at the end). Skipped for very short reels or when disabled in config.
    hook_det = None
    hook_min_scenes = int(cfg.get("hook_min_scenes", 2))
    if cfg.get("hook_enabled", True) and len(detections) >= hook_min_scenes:
        last = detections[-1]
        try:
            hook_det = detect_hook(last, cfg, force=force, cache_dir=cache_dir)
            hs, he = hook_det["segments"][0]
            print(f"  Hook: {he - hs:.2f}s from {last['scene']} "
                  f"[{hs:.2f}-{he:.2f}]  ({hook_det['source']}, conf {hook_det['confidence']:.2f})")
        except Exception as exc:
            print(f"  ! hook step failed ({str(exc)[:120]}); rendering without a hook")
            hook_det = None

    if dry_run:
        print(f"Dry run only. Check the briefs and ranges above. To override a clip, "
              f"edit its JSON in {cache_dir} then run without --dry-run.")
        return None

    from edit import build_video  # imported here so --dry-run needs no ffmpeg

    render_list = ([hook_det] + detections) if hook_det else detections
    print("Rendering ...")
    build_video(render_list, music, out_path, cfg, watermark_text=watermark)
    print(f"\nDone -> {out_path}")
    return out_path


SCENE_RE = re.compile(r"(?i)^scene[-_ ]?\d+")


def scene_clips_in(folder):
    """scene-NN clips in a folder (excludes EDITED_ output and non-scene videos)."""
    return [c for c in list_clips_in(folder) if SCENE_RE.match(os.path.basename(c))]


def process_folder(folder, cfg, dry_run, force):
    """Detect + render one reel folder. Returns the output path (or None on dry-run)."""
    clips = scene_clips_in(folder)
    if not clips:
        print(f"  (skip) no scene-NN clips in {folder}")
        return None
    briefs, src = briefs_for_folder(folder, clips)
    print(f"Briefs source: {src}")
    cache_dir = os.path.join(folder, ".aiedit_cache")
    music = find_music(folder)  # a track in the folder wins, else global music/
    name = os.path.basename(folder.rstrip("\\/"))
    out_path = os.path.join(folder, f"EDITED_{name}.mp4")
    watermark = str(cfg.get("watermark_text", "")).strip() or page_name_from_path(folder)
    if watermark:
        print(f"Watermark: \"{watermark}\"")
    return run(clips, briefs, cfg, cache_dir, music, out_path, dry_run, force,
               watermark=watermark)


def find_reel_folders(parent):
    """Immediate sub-folders that contain scene-NN clips, sorted."""
    out = []
    for name in sorted(os.listdir(parent)):
        d = os.path.join(parent, name)
        if os.path.isdir(d) and scene_clips_in(d):
            out.append(d)
    return out


def has_edited_output(folder):
    return any(f.upper().startswith("EDITED_") and f.lower().endswith(".mp4")
               for f in os.listdir(folder))


def reel_fully_detected(folder):
    """True only if EVERY scene clip has a good (non-error) cached AI detection."""
    cache = os.path.join(folder, ".aiedit_cache")
    if not os.path.isdir(cache):
        return False
    for clip in scene_clips_in(folder):
        sid = os.path.splitext(os.path.basename(clip))[0]
        path = os.path.join(cache, sid + ".json")
        if not os.path.exists(path):
            return False
        try:
            if json.load(open(path, encoding="utf-8")).get("source") == "error-whole-clip":
                return False
        except Exception:
            return False
    return True


def reel_is_done(folder):
    """A reel is 'already processed' only if it is rendered AND fully AI-detected."""
    return has_edited_output(folder) and reel_fully_detected(folder)


def reel_marked_done(folder):
    """Explicit human 'leave this alone' marker: the folder is named 'done', or it
    contains any file named 'done' (e.g. done.mp4, done.txt). Always skipped."""
    if os.path.basename(folder.rstrip("\\/")).lower() == "done":
        return True
    return any(os.path.splitext(f)[0].lower() == "done" for f in os.listdir(folder))


def run_input_mode(cfg, dry_run, force):
    """Way B: clips in input/ + briefs.csv -> output/final_<timestamp>.mp4."""
    clips = list_clips()
    if not clips:
        sys.exit("No clips in input/. Add scene01.mp4... or use --folder / --batch.")
    all_briefs = load_briefs_csv(BRIEFS_PATH)
    missing = [scene_id(c) for c in clips if scene_id(c) not in all_briefs]
    if missing:
        print("WARNING: no brief in briefs.csv for: " + ", ".join(missing) + " (kept whole).")
    briefs = [all_briefs.get(scene_id(c), "") for c in clips]
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    out_path = os.path.join(OUTPUT_DIR, f"final_{stamp}.mp4")
    watermark = str(cfg.get("watermark_text", "")).strip()
    if watermark:
        print(f"Watermark: \"{watermark}\"")
    run(clips, briefs, cfg, CACHE_DIR, find_music(), out_path, dry_run, force,
        watermark=watermark)


def main():
    parser = argparse.ArgumentParser(description="Auto-cut AI scenes, join, add music.")
    parser.add_argument("--folder", help="One reel folder (scene-01.mp4... + a .txt brief).")
    parser.add_argument("--batch", help="A parent folder; processes every reel sub-folder in it.")
    parser.add_argument("--dry-run", action="store_true", help="Only print detected cuts.")
    parser.add_argument("--force", action="store_true", help="Ignore cache, call Gemini again.")
    args = parser.parse_args()
    cfg = load_config()

    if args.batch:
        parent = os.path.abspath(args.batch)
        if not os.path.isdir(parent):
            sys.exit(f"Folder not found: {parent}")
        reels = find_reel_folders(parent)
        if not reels:
            sys.exit(f"No reel sub-folders with scene-NN clips found in {parent}")
        print(f"Batch: {len(reels)} reel folder(s) in {os.path.basename(parent)}\n")
        done, skipped = [], []
        for i, folder in enumerate(reels, 1):
            name = os.path.basename(folder)
            # Skip only reels that are fully done (rendered AND every scene AI-detected).
            if not args.force and not args.dry_run and reel_is_done(folder):
                print(f"[{i}/{len(reels)}] {name}: already done (rendered + all scenes "
                      f"AI-trimmed) — skipping\n")
                skipped.append(name)
                continue
            # Explicit 'done' marker (folder named 'done' or a done.* file) -> always skip.
            if reel_marked_done(folder):
                print(f"[{i}/{len(reels)}] {name}: marked 'done' — skipping\n")
                skipped.append(name)
                continue
            print(f"[{i}/{len(reels)}] {name}")
            try:
                process_folder(folder, cfg, args.dry_run, args.force)
                done.append(name)
            except Exception as exc:
                print(f"  !! {name} failed: {str(exc)[:200]}")
            print()
        print(f"Batch complete. Rendered/checked: {len(done)}; skipped: {len(skipped)}.")
        return

    if args.folder:
        folder = os.path.abspath(args.folder)
        if not os.path.isdir(folder):
            sys.exit(f"Folder not found: {folder}")
        process_folder(folder, cfg, args.dry_run, args.force)
        return

    run_input_mode(cfg, args.dry_run, args.force)


if __name__ == "__main__":
    main()
