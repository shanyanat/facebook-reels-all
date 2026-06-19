"""
uploader/post_ready.py — find finished reels and post them to Facebook (dry-run by default).

Scans complete/<page>/<reel>/ for an EDITED_*.mp4 deliverable and, for each one:
  - reads the caption from the local contents.json / contents.archive.json (by reel id),
  - looks up that page's Facebook id + token in uploader/config.json (gitignored),
  - posts it as a Reel via upload_reel() — with thumbnail.png as the cover if present.

Safety:
  * DRY-RUN unless BOTH `--live` is passed AND config.json has "live": true.
  * Skips any reel folder that already has an `.uploaded` marker.
  * Writes `.uploaded` only after a successful LIVE post (which also lets
    `py bot.py cleanup` reclaim that reel's source clips).

PC-first: reads contents.json locally. The future VPS version will instead read a
small per-reel sidecar (written by push_to_vps), since the VPS has no contents.json.

Usage:
    py uploader/post_ready.py                 # dry-run, all pages
    py uploader/post_ready.py --page 3-page-Noble-Handiwork
    py uploader/post_ready.py --live          # real posts (also needs config "live": true)
"""

import argparse
import json
import re
import sys
from pathlib import Path

BASE = Path(__file__).parent.parent          # .../Facebook Reels to America
COMPLETE = BASE / "complete"
DATA = BASE / "data"
CONFIG = Path(__file__).parent / "config.json"

sys.path.insert(0, str(Path(__file__).parent))
from upload_reel import upload_reel


def log(msg):
    line = f"[upload] {msg}"
    try:
        print(line, flush=True)
    except UnicodeEncodeError:                # legacy cp874 console safety
        enc = sys.stdout.encoding or "ascii"
        print(line.encode(enc, "replace").decode(enc), flush=True)


def _load_config() -> dict:
    if not CONFIG.exists():
        return {"live": False, "pages": {}}
    try:
        return json.loads(CONFIG.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as e:
        log(f"WARNING: could not read config.json ({e}) — treating as empty")
        return {"live": False, "pages": {}}


def page_hashtag(page_folder: str) -> str:
    """Turn a page FOLDER name into the page's hashtag.
    '3-page-Noble-Handiwork' -> '#NobleHandiwork' (drop the 'N-page-' prefix,
    then remove spaces/hyphens so the words join into one tag)."""
    name = re.sub(r"^\d+-page-", "", page_folder)      # 'Noble-Handiwork'
    name = re.sub(r"[^0-9A-Za-z]", "", name)           # 'NobleHandiwork'
    return f"#{name}" if name else ""


def apply_page_hashtag(caption: str, page_folder: str) -> str:
    """Replace the Master Prompt's page-name placeholder hashtag with the real one.
    Handles the Thai '#[ชื่อเพจ]' / any '#[...]' bracketed placeholder, plus the
    English '#YourPageName' / '#PageName' variants."""
    tag = page_hashtag(page_folder)
    if not tag:
        return caption
    out = re.sub(r"#\[[^\]\n]*\]", tag, caption)                       # #[ชื่อเพจ], #[page name]
    out = re.sub(r"#YourPageName\b|#PageName\b", tag, out, flags=re.IGNORECASE)
    return out


def _caption_for(reel_id: str) -> str:
    """Find the reel's facebook_caption in the live file or the pruned archive."""
    for fname in ("contents.json", "contents.archive.json"):
        f = DATA / fname
        if not f.exists():
            continue
        try:
            for p in json.loads(f.read_text(encoding="utf-8")):
                if p.get("id") == reel_id:
                    return p.get("facebook_caption", "") or ""
        except (json.JSONDecodeError, OSError):
            pass
    return ""


def main():
    ap = argparse.ArgumentParser(description="Post finished reels to Facebook (dry-run by default)")
    ap.add_argument("--live", action="store_true",
                    help="actually post (also requires \"live\": true in config.json)")
    ap.add_argument("--page", help="only this page folder (e.g. 3-page-Noble-Handiwork)")
    ap.add_argument("--reel", help="only this reel id (e.g. reel_0221) — for a careful single post")
    args = ap.parse_args()

    cfg = _load_config()
    pages_cfg = cfg.get("pages", {})
    live = bool(args.live and cfg.get("live", False))   # both required → real post
    if args.live and not cfg.get("live", False):
        log("NOTE: --live ignored because config.json has \"live\": false (staying dry-run).")
    log(f"Mode: {'LIVE — will post for real' if live else 'DRY-RUN — nothing will be posted'}")

    if not COMPLETE.exists():
        log("No complete/ folder yet — nothing to post.")
        return

    found = posted = skipped = 0
    for page_dir in sorted(COMPLETE.iterdir()):
        if not page_dir.is_dir():
            continue
        page = page_dir.name
        if args.page and page != args.page:
            continue
        for reel_dir in sorted(page_dir.iterdir()):
            if not reel_dir.is_dir() or not reel_dir.name.startswith("reel_"):
                continue
            reel_id = reel_dir.name
            if args.reel and reel_id != args.reel:
                continue                       # single-reel mode: skip the rest
            edited = sorted(reel_dir.glob("EDITED_*.mp4"))
            if not edited:
                continue                       # not finished editing yet
            found += 1

            if (reel_dir / ".uploaded").exists():
                log(f"skip {reel_id} ({page}) — already uploaded")
                skipped += 1
                continue

            caption = apply_page_hashtag(_caption_for(reel_id), page)
            thumb = reel_dir / "thumbnail.png"
            thumb = thumb if thumb.exists() else None
            page_cfg = pages_cfg.get(page)

            log(f"--- {reel_id} ({page}) ---")
            if not caption:
                log("  (no facebook_caption found — run 'py bot.py updateprompts "
                    f"{reel_id}' to populate it)")

            if live:
                if not page_cfg or not page_cfg.get("page_id") or not page_cfg.get("token"):
                    log(f"  ERROR: no page_id/token for '{page}' in config.json — skipping")
                    skipped += 1
                    continue
                try:
                    upload_reel(edited[0], page_cfg["page_id"], page_cfg["token"],
                                caption=caption, thumbnail_path=thumb, live=True, log=log)
                    (reel_dir / ".uploaded").write_text("", encoding="utf-8")
                    log(f"  ✓ posted + marked .uploaded")
                    posted += 1
                except Exception as e:
                    log(f"  ERROR posting {reel_id}: {e}")
                    skipped += 1
            else:
                # dry-run: no token needed — just show intent
                pid = (page_cfg or {}).get("page_id", "(page_id not configured yet)")
                upload_reel(edited[0], pid, (page_cfg or {}).get("token", ""),
                            caption=caption, thumbnail_path=thumb, live=False, log=log)

    log(f"Done. {found} finished reel(s) found, {posted} posted, {skipped} skipped.")


if __name__ == "__main__":
    main()
