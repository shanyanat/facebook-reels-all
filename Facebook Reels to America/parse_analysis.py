"""
parse_analysis.py
Parses a Master Prompt analysis .txt file and appends a new project entry
to data/contents.json.

Usage:
    python parse_analysis.py path/to/brief.txt --page page-a [--char path/to/char.png]

Called automatically by monitor.py when a new .txt is dropped into pages/<page>/briefs/.
"""

import json
import os
import re
import shutil
import sys
import tempfile
import time
from pathlib import Path

BASE_DIR = Path(__file__).parent
DATA_DIR = BASE_DIR / "data"
CONTENTS_FILE = DATA_DIR / "contents.json"
BACKUP_FILE = DATA_DIR / "contents.json.bak"
LOCK_FILE = DATA_DIR / "contents.json.lock"
PAGES_DIR = BASE_DIR / "pages"

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp"}


def load_contents():
    # Read the main file. If it is ever corrupt, fall back to the last
    # known-good backup automatically — so even a backup machine with no
    # Claude Code keeps working instead of crashing.
    if CONTENTS_FILE.exists():
        try:
            with open(CONTENTS_FILE, encoding="utf-8") as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError) as main_err:
            if BACKUP_FILE.exists():
                try:
                    with open(BACKUP_FILE, encoding="utf-8") as f:
                        data = json.load(f)
                    print("[recover] contents.json was corrupt — "
                          "loaded from contents.json.bak instead.")
                    return data
                except (json.JSONDecodeError, OSError):
                    pass   # backup is also bad — fall through to a clear error
            raise RuntimeError(
                "Both data/contents.json and data/contents.json.bak are "
                "unreadable. Restore either file from another machine's copy. "
                f"(original error: {main_err})")
    return []


def _acquire_lock(timeout=10.0):
    """Best-effort cross-machine lock so two writers don't run at once.
    Returns True if the lock was taken. Failing to get it is NOT fatal —
    the unique temp file below already makes corruption impossible."""
    start = time.time()
    while True:
        try:
            fd = os.open(str(LOCK_FILE), os.O_CREAT | os.O_EXCL | os.O_RDWR)
            os.close(fd)
            return True
        except FileExistsError:
            # Clear a stale lock left behind by a crashed/copied run.
            try:
                if time.time() - os.path.getmtime(LOCK_FILE) > 30:
                    os.remove(LOCK_FILE)
                    continue
            except OSError:
                pass
            if time.time() - start > timeout:
                return False
            time.sleep(0.05)


def _release_lock():
    try:
        os.remove(LOCK_FILE)
    except OSError:
        pass


def save_contents(data):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    got_lock = _acquire_lock()
    tmp = None
    try:
        # 1. Write to a UNIQUE temp file. Every process/thread gets its own,
        #    so concurrent writers can never garble a shared temp file.
        fd, tmp_name = tempfile.mkstemp(
            dir=str(DATA_DIR), prefix=".contents-", suffix=".json.tmp")
        tmp = Path(tmp_name)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.flush()
            os.fsync(f.fileno())          # force data onto disk (power-loss safe)

        # 2. Verify the temp file really is valid JSON before trusting it,
        #    so we never overwrite a good file with a broken one.
        with open(tmp, encoding="utf-8") as f:
            json.load(f)

        # 3. Keep a rolling backup of the current good file (only if it is
        #    valid) before swapping in the new one.
        if CONTENTS_FILE.exists():
            try:
                with open(CONTENTS_FILE, encoding="utf-8") as f:
                    json.load(f)
                shutil.copyfile(CONTENTS_FILE, BACKUP_FILE)
            except (json.JSONDecodeError, OSError):
                pass                      # current file already bad — keep old .bak

        # 4. Atomic rename: readers always see a complete file, never a half-written one.
        #    On Windows the rename can briefly fail if another process has the
        #    file open at that instant, so retry a few times before giving up.
        for attempt in range(10):
            try:
                tmp.replace(CONTENTS_FILE)
                tmp = None
                break
            except PermissionError:
                if attempt == 9:
                    raise
                time.sleep(0.1)
    finally:
        if tmp is not None and tmp.exists():
            tmp.unlink(missing_ok=True)
        if got_lock:
            _release_lock()


def _collect_reel_nums(contents) -> set:
    """Every reel number known ANYWHERE — live contents.json, the pruned
    archive, and the complete/ folders on disk. The next id must never reuse a
    number that already exists in any of these, or `prune` (which removes the
    highest-numbered completed reels from contents.json) would make the counter
    regress and collide with already-archived reels — silent data loss."""
    nums = set()

    def _add(ids):
        for eid in ids:
            m = re.search(r"reel_(\d+)", eid or "")
            if m:
                nums.add(int(m.group(1)))

    _add(c.get("id", "") for c in contents)

    # Pruned-but-not-forgotten entries.
    archive = DATA_DIR / "contents.archive.json"
    if archive.exists():
        try:
            data = json.loads(archive.read_text(encoding="utf-8"))
            if isinstance(data, list):
                _add(c.get("id", "") for c in data)
        except (json.JSONDecodeError, OSError):
            pass

    # Disk backstop: collected deliverables survive even if both JSON files were lost.
    complete_dir = BASE_DIR / "complete"
    if complete_dir.exists():
        for page_dir in complete_dir.iterdir():
            if page_dir.is_dir():
                _add(rd.name for rd in page_dir.iterdir() if rd.is_dir())

    return nums


def next_project_id(contents):
    nums = _collect_reel_nums(contents)
    nxt = max(nums) + 1 if nums else 1
    return f"reel_{nxt:04d}"


def _page_briefs_dir(page_name: str | None) -> Path | None:
    if not page_name:
        return None
    return PAGES_DIR / page_name / "briefs"


def _infer_page(txt_path: Path) -> str | None:
    """If txt_path lives inside pages/<page>/briefs/, return the page name."""
    try:
        return txt_path.relative_to(PAGES_DIR).parts[0]
    except (ValueError, IndexError):
        return None


def detect_character_sheet(page_name: str | None) -> str | None:
    """Return path (relative to BASE_DIR) of first image in the page's briefs/ folder."""
    briefs = _page_briefs_dir(page_name)
    if not briefs or not briefs.exists():
        return None
    for f in sorted(briefs.iterdir()):
        if f.is_file() and f.suffix.lower() in IMAGE_EXTS:
            return str(f.relative_to(BASE_DIR))
    return None


def detect_aspect_ratio(storyboard_prompt):
    m = re.search(r"--ar\s+([\w:]+)", storyboard_prompt)
    if m:
        return m.group(1)
    return "9:16"


def parse_txt(txt_path):
    """
    Parse analysis output .txt file.
    Returns dict with storyboard_prompt, scenes list [{scene_num, image_prompt, video_prompt}].

    Handles both formats produced by ChatGPT/Gemini:
      - "## STORYBOARD PROMPT" (with ## prefix)
      - "STORYBOARD PROMPT"    (without prefix, line by itself)
      - "--- ชุดที่ 1: STORYBOARD PROMPT ---" (with Thai section label)
    """
    text = Path(txt_path).read_text(encoding="utf-8-sig")

    section_pattern = re.compile(
        r"^[ \t]*(?:##\s*|---[^-]*?:\s*)??"
        r"(STORYBOARD\s+PROMPT|SCENE\s+\d+\s+IMAGE\s+PROMPT|SCENE\s+\d+\s+VIDEO\s+PROMPT|THUMBNAIL\s+PROMPT)"
        r"[ \t]*(?:---)?[ \t]*$",
        re.MULTILINE | re.IGNORECASE,
    )

    headers = list(section_pattern.finditer(text))

    sections = {}
    for i, match in enumerate(headers):
        header = match.group(1).strip().upper()
        header = re.sub(r"\s+", " ", header)
        start = match.end()
        end = headers[i + 1].start() if i + 1 < len(headers) else len(text)
        body = text[start:end].strip()
        sections[header] = body

    storyboard_prompt = sections.get("STORYBOARD PROMPT", "")
    thumbnail_prompt = sections.get("THUMBNAIL PROMPT", "")

    image_prompts = {}
    video_prompts = {}
    for key, body in sections.items():
        m = re.match(r"SCENE\s+(\d+)\s+IMAGE\s+PROMPT", key)
        if m:
            image_prompts[int(m.group(1))] = body
            continue
        m = re.match(r"SCENE\s+(\d+)\s+VIDEO\s+PROMPT", key)
        if m:
            video_prompts[int(m.group(1))] = body

    total_scenes = max(
        max(image_prompts.keys()) if image_prompts else 0,
        max(video_prompts.keys()) if video_prompts else 0,
    )

    scenes = []
    for n in range(1, total_scenes + 1):
        scenes.append({
            "scene_num": n,
            "image_prompt": image_prompts.get(n, ""),
            "video_prompt": video_prompts.get(n, ""),
            "image_status": "pending",
            "video_status": "pending",
        })

    return {
        "storyboard_prompt": storyboard_prompt,
        "thumbnail_prompt": thumbnail_prompt,
        "scenes": scenes,
        "total_scenes": total_scenes,
        "aspect_ratio": detect_aspect_ratio(storyboard_prompt),
    }


def add_project(txt_path, page_name=None, char_sheet_override=None):
    """Parse txt file and add a new project to contents.json. Returns project_id or None."""
    txt_path = Path(txt_path)
    if page_name is None:
        page_name = _infer_page(txt_path)

    filename = txt_path.name
    contents = load_contents()

    # Skip if this (filename, page) combination is already in the queue
    if any(p.get("source_txt") == filename and p.get("page") == page_name
           for p in contents):
        print(f"[parse] Already queued: {filename} (page: {page_name}) — skipping")
        return None

    project_id = next_project_id(contents)
    parsed = parse_txt(txt_path)
    char_sheet = char_sheet_override or detect_character_sheet(page_name)

    project = {
        "id": project_id,
        "page": page_name,
        "source_txt": filename,
        "total_scenes": parsed["total_scenes"],
        "aspect_ratio": parsed["aspect_ratio"],
        "character_sheet": char_sheet,
        "storyboard_prompt": parsed["storyboard_prompt"],
        "thumbnail_prompt": parsed.get("thumbnail_prompt", ""),
        "scenes": parsed["scenes"],
        "project_status": "pending",
    }

    contents.append(project)
    save_contents(contents)
    print(f"[parse] Added {project_id} ({parsed['total_scenes']} scenes) "
          f"from {filename} [page: {page_name}]")
    return project_id


def update_project_prompts(project_id: str) -> bool:
    """Re-parse the source .txt brief and refresh prompts in contents.json.
    Only updates storyboard_prompt and each scene's image_prompt / video_prompt.
    Never touches status, image_status, video_status, or any other field.
    Returns True on success, False if the brief file cannot be found.
    """
    contents = load_contents()
    project = next((p for p in contents if p["id"] == project_id), None)
    if not project:
        print(f"[update] Project '{project_id}' not found in contents.json")
        return False

    page = project.get("page")
    src_txt = project.get("source_txt")
    if not src_txt:
        print(f"[update] No source_txt recorded for {project_id}")
        return False

    # Brief may still be in briefs/ (active) or already moved to ready/ (archived)
    candidates = [
        PAGES_DIR / page / "briefs" / src_txt,
        PAGES_DIR / page / "ready" / project_id / src_txt,
    ]
    txt_path = next((p for p in candidates if p.exists()), None)
    if not txt_path:
        print(f"[update] Brief file '{src_txt}' not found in briefs/ or ready/ for {page}")
        return False

    parsed = parse_txt(txt_path)

    project["storyboard_prompt"] = parsed["storyboard_prompt"]
    project["thumbnail_prompt"] = parsed.get("thumbnail_prompt", "")

    char_sheet = project.get("character_sheet")
    if not char_sheet or not (BASE_DIR / char_sheet).exists():
        new_char = detect_character_sheet(page)
        if new_char:
            project["character_sheet"] = new_char
            print(f"[update] {project_id}: character sheet set to '{new_char}'")

    if not project["scenes"]:
        project["scenes"] = parsed["scenes"]
        project["total_scenes"] = parsed["total_scenes"]
    else:
        scene_map = {s["scene_num"]: s for s in parsed["scenes"]}
        existing_nums = {s["scene_num"] for s in project["scenes"]}
        # Update prompts on existing scenes
        for scene in project["scenes"]:
            n = scene["scene_num"]
            if n in scene_map:
                scene["image_prompt"] = scene_map[n]["image_prompt"]
                scene["video_prompt"] = scene_map[n]["video_prompt"]
        # Append any new scenes that weren't in the project before
        for s in parsed["scenes"]:
            if s["scene_num"] not in existing_nums:
                project["scenes"].append(s)
                print(f"[update] {project_id}: added scene {s['scene_num']}")
        project["scenes"].sort(key=lambda s: s["scene_num"])
        project["total_scenes"] = len(project["scenes"])

    save_contents(contents)
    print(f"[update] {project_id}: prompts refreshed from '{src_txt}' "
          f"({len(project['scenes'])} scenes)")
    return True


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python parse_analysis.py <brief.txt> --page <page-name> [--char <char.png>]")
        sys.exit(1)

    txt = sys.argv[1]
    page = None
    char = None

    if "--page" in sys.argv:
        idx = sys.argv.index("--page")
        if idx + 1 < len(sys.argv):
            page = sys.argv[idx + 1]

    if "--char" in sys.argv:
        idx = sys.argv.index("--char")
        if idx + 1 < len(sys.argv):
            char = sys.argv[idx + 1]

    result = add_project(txt, page_name=page, char_sheet_override=char)
    if result:
        print(f"Project {result} added to data/contents.json")
