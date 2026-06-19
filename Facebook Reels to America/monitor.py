"""
monitor.py
Watches two locations continuously:
  1. pages/<page>/briefs/  — new .txt files → parse and add to queue
  2. Downloads folder       — project files → move to pending/ and update status

Also runs a tiny HTTP server on port 7788 so the Chrome extension can read
contents.json and receive status patches.

Run:
    python monitor.py
Leave running in the background the whole session.
Note: restart monitor.py after adding a new page folder so it picks up the new briefs/ watcher.
"""

import base64 as _b64
import contextlib
import io
import json
import os
import re
import shutil
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn
from pathlib import Path

from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer

from parse_analysis import add_project, load_contents, save_contents, update_project_prompts
from bot import do_queue, do_addpage, do_renamepage, do_archive, do_collect, _run_editor_batch
from notify import notify, notify_error

BASE_DIR = Path(__file__).parent
DATA_DIR = BASE_DIR / "data"
PAGES_DIR = BASE_DIR / "pages"
CONTENTS_FILE = DATA_DIR / "contents.json"
DOWNLOADS_DIR = Path.home() / "Downloads"

API_PORT = 7788

# Single re-entrant lock guarding EVERY contents.json read-modify-write in this
# process. The server is threaded (ThreadingMixIn) and the extension runs several
# slots in parallel, so two requests could otherwise load the same snapshot and
# the last save would erase the other's flag update (a lost update — the file on
# disk survives but image_status/video_status silently reverts to "pending").
# RLock so a handler holding the lock can still call update_scene/update_project,
# and so bot-function calls (which also mutate contents.json) serialise too.
_data_lock = threading.RLock()

# Reels currently being auto-advanced (archive→edit), so a duplicate completion
# event can't start the heavy downstream twice for the same reel.
_advancing = set()

# Serialises the heavy edit step across auto-advance threads. With several parallel
# extension slots, multiple reels can finish at once; without this they would spawn
# several FFmpeg/Gemini editors simultaneously and thrash the CPU. Reels still
# archive promptly — only the editing queues, one at a time.
_editor_lock = threading.Lock()


def log(msg):
    print(f"[monitor] {msg}", flush=True)


def _auto_advance(project_id: str, page: str):
    """Primary-path automation: the extension finished a reel (all videos saved),
    so push it through the same downstream the terminal pipeline uses —
    archive → collect → edit — with NO further manual steps.

    Runs in a background thread (started from the completion handlers) so the heavy
    FFmpeg/Gemini edit never blocks the HTTP server the extension's parallel slots
    rely on. The contents.json + file moves (archive/collect) are done under
    _data_lock so they don't race other slots' saves; the editor runs OUTSIDE the
    lock. A 9/10 (partial) reel never reaches 'complete', so it never lands here —
    that case waits for a human (py bot.py force-complete / the dashboard button)."""
    with _data_lock:
        if project_id in _advancing:
            return
        _advancing.add(project_id)
    try:
        log(f"Auto-advance {project_id}: archive + collect ...")
        with _data_lock:
            do_archive(project_id)
            do_collect()
        log(f"Auto-advance {project_id}: editing (background, queued) ...")
        with _editor_lock:   # one editor at a time — avoid CPU thrash on parallel finishes
            ok = _run_editor_batch(page, notify)
        if ok:
            notify(f"✅ Auto-advanced {project_id} ({page}): archived + edited — ready for upload")
        else:
            notify(f"⚠️ {project_id} ({page}): archived but edit step had issues — check monitor logs")
    except Exception as e:
        log(f"Auto-advance {project_id} ERROR: {e}")
        notify_error(f"auto-advance {project_id} ({page})", e)
    finally:
        with _data_lock:
            _advancing.discard(project_id)


def _start_auto_advance(project_id: str, page: str):
    """Fire _auto_advance on a daemon thread so the HTTP response returns immediately.
    Kill-switch: set REELS_AUTO_ADVANCE=0 to disable (reels then wait for a manual
    `py bot.py archive`/`force-complete`)."""
    if os.environ.get("REELS_AUTO_ADVANCE", "1") == "0":
        log(f"Auto-advance disabled (REELS_AUTO_ADVANCE=0) — {project_id} left for manual archive")
        return
    threading.Thread(target=_auto_advance, args=(project_id, page), daemon=True).start()


# ── Helpers ─────────────────────────────────────────────────────────────────

def _working_dir(project_id: str) -> Path:
    """Return pages/<page>/working/ for the given project, creating it if needed."""
    for p in load_contents():
        if p["id"] == project_id and p.get("page"):
            d = PAGES_DIR / p["page"] / "working"
            d.mkdir(parents=True, exist_ok=True)
            return d
    fallback = PAGES_DIR / "_unknown" / "working"
    fallback.mkdir(parents=True, exist_ok=True)
    return fallback

def update_project(project_id, **kwargs):
    with _data_lock:
        contents = load_contents()
        for p in contents:
            if p["id"] == project_id:
                p.update(kwargs)
                break
        save_contents(contents)


def get_project(project_id):
    for p in load_contents():
        if p["id"] == project_id:
            return p
    return None


def update_scene(project_id, scene_num, **kwargs):
    with _data_lock:
        contents = load_contents()
        for p in contents:
            if p["id"] == project_id:
                for s in p["scenes"]:
                    if s["scene_num"] == scene_num:
                        s.update(kwargs)
                        break
                break
        save_contents(contents)


def check_all_images_done(project):
    return all(s["image_status"] == "done" for s in project["scenes"])


def check_all_videos_done(project):
    return all(s["video_status"] == "done" for s in project["scenes"])


def _disk_status_for(project: dict) -> str:
    """Compute status from actual files on disk — mirrors bot.py _disk_status().
    The extension popup calls this so it shows the same status as py bot.py status."""
    pid   = project.get("id", "")
    total = project.get("total_scenes", 0)
    page  = project.get("page", "")
    if not pid or not total or not page:
        return project.get("project_status", "pending")

    working_dir = PAGES_DIR / page / "working"
    ready_dir   = PAGES_DIR / page / "ready" / pid

    # If already archived via bot.py (project_status=complete + ready/ exists)
    if project.get("project_status") == "complete" and ready_dir.exists():
        return "archived"
    # Files were moved to complete/ by collect — nothing left in working/ or ready/
    if project.get("project_status") == "complete":
        return "collected"

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

    if done_vid_r == total:
        return "archived"
    if done_vid == total:
        return "videos_done"
    if done_vid > 0:
        return "videos_in_progress"
    if done_img == total:
        return "images_done"
    if (working_dir / f"{pid}-storyboard.png").exists():
        return "storyboard_done"
    return "pending"


def _annotate_scenes_disk(project: dict) -> None:
    """Add per-scene img_on_disk / vdo_on_disk booleans from the files actually
    on disk. Purely additive (existing consumers ignore unknown fields). Lets the
    video phase select work from disk truth instead of contents.json flags, which
    can lag behind under concurrent saves."""
    pid  = project.get("id", "")
    page = project.get("page", "")
    if not pid or not page:
        return
    working_dir = PAGES_DIR / page / "working"
    ready_dir   = PAGES_DIR / page / "ready" / pid
    for s in project.get("scenes", []):
        nn = str(s.get("scene_num", "")).zfill(2)
        s["img_on_disk"] = (working_dir / f"{pid}-scene-{nn}.png").exists()
        s["vdo_on_disk"] = (
            (working_dir / f"{pid}-scene-{nn}-vdo.mp4").exists()
            or (ready_dir / f"scene-{nn}.mp4").exists()
        )


# ── HTTP Server for extension ─────────────────────────────────────────────────

class APIHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass  # suppress default HTTP logging

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def do_OPTIONS(self):
        self.send_response(200)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if self.path == "/contents.json":
            try:
                projects = json.loads(CONTENTS_FILE.read_bytes())
                for p in projects:
                    p["disk_status"] = _disk_status_for(p)
                    _annotate_scenes_disk(p)
                    page = p.get("page", "")
                    src  = p.get("source_txt", "")
                    p["brief_exists"] = bool(
                        page and src and (PAGES_DIR / page / "briefs" / src).exists()
                    )
                body = json.dumps(projects).encode("utf-8")
            except Exception:
                body = CONTENTS_FILE.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self._cors()
            self.end_headers()
            self.wfile.write(body)

        elif self.path.startswith("/file/"):
            from urllib.parse import unquote
            import mimetypes
            rel = unquote(self.path[6:])  # strip "/file/"
            file_path = BASE_DIR / rel
            if file_path.exists() and file_path.is_file():
                mime, _ = mimetypes.guess_type(str(file_path))
                size = file_path.stat().st_size
                self.send_response(200)
                self.send_header("Content-Type", mime or "application/octet-stream")
                self.send_header("Content-Length", str(size))
                self._cors()
                self.end_headers()
                # Stream in 64 KB chunks — headers reach browser on first flush,
                # not after the entire file is read into memory
                with open(file_path, "rb") as fh:
                    while True:
                        chunk = fh.read(65536)
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                self.wfile.flush()
            else:
                self.send_response(404)
                self._cors()
                self.end_headers()
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        if self.path == "/patch":
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length))
            project_id = body.pop("id", None)
            if project_id:
                update_project(project_id, **body)
                log(f"[API] Patched {project_id}: {body}")
            self.send_response(200)
            self._cors()
            self.end_headers()
            self.wfile.write(b'{"ok":true}')

        elif self.path == "/save_image":
            # Extension POSTs image bytes here so they land in working/ directly,
            # exactly like bot.py does — no Downloads folder, no file-watcher chain.
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length))
            filename = body.get("filename", "")
            b64data  = body.get("base64", "")

            if not filename or not b64data:
                self.send_response(400)
                self._cors()
                self.end_headers()
                self.wfile.write(b'{"error":"missing filename or base64"}')
                return

            img_bytes = _b64.b64decode(b64data)

            # Reuse the same regex / logic as the Downloads watcher (class attrs, no instance needed)
            m = DownloadsHandler.STORYBOARD_RE.match(filename)
            if m:
                pid  = m.group(1)
                dest = _working_dir(pid) / filename
                dest.write_bytes(img_bytes)
                update_project(pid, project_status="storyboard_done")
                log(f"[API] {filename} → working/ | {pid}: storyboard_done ({len(img_bytes)//1024} KB)")
                self.send_response(200); self._cors(); self.end_headers()
                self.wfile.write(b'{"ok":true}')
                return

            m = DownloadsHandler.SCENE_IMG_RE.match(filename)
            if m:
                pid, scene_num = m.group(1), int(m.group(2))
                dest = _working_dir(pid) / filename
                dest.write_bytes(img_bytes)
                with _data_lock:
                    update_scene(pid, scene_num, image_status="done")
                    project = get_project(pid)
                    if project and check_all_images_done(project):
                        update_project(pid, project_status="images_done")
                        log(f"[API] {filename} → working/ | {pid} → images_done")
                    else:
                        log(f"[API] {filename} → working/ | {pid} scene {scene_num:02d} done ({len(img_bytes)//1024} KB)")
                self.send_response(200); self._cors(); self.end_headers()
                self.wfile.write(b'{"ok":true}')
                return

            m = DownloadsHandler.THUMBNAIL_RE.match(filename)
            if m:
                pid  = m.group(1)
                dest = _working_dir(pid) / filename
                dest.write_bytes(img_bytes)
                log(f"[API] {filename} → working/ | {pid}: thumbnail saved ({len(img_bytes)//1024} KB)")
                self.send_response(200); self._cors(); self.end_headers()
                self.wfile.write(b'{"ok":true}')
                return

            self.send_response(400)
            self._cors()
            self.end_headers()
            self.wfile.write(b'{"error":"unrecognized filename pattern"}')

        elif self.path == "/api/queue":
            self._handle_api_queue()

        elif self.path == "/api/addpage":
            self._handle_api_addpage()

        elif self.path == "/api/renamepage":
            self._handle_api_renamepage()

        elif self.path == "/api/updateprompts":
            self._handle_api_updateprompts()

        elif self.path == "/api/archive":
            self._handle_api_archive()

        elif self.path == "/api/collect":
            self._handle_api_collect()

        elif self.path == "/api/delete":
            self._handle_api_delete()

        elif self.path == "/save_video":
            # Extension fetched the video in-page (has session cookies), base64-encoded it,
            # and POSTed here so we save directly to working/ — no Downloads folder, no dialog.
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length))
            filename = body.get("filename", "")
            b64data  = body.get("base64", "")

            if not filename or not b64data:
                self.send_response(400); self._cors(); self.end_headers()
                self.wfile.write(b'{"error":"missing filename or base64"}')
                return

            video_bytes = _b64.b64decode(b64data)

            m = DownloadsHandler.VIDEO_RE.match(filename)
            if m:
                pid, scene_num = m.group(1), int(m.group(2))
                dest = _working_dir(pid) / filename
                dest.write_bytes(video_bytes)
                completed_page = None
                with _data_lock:
                    update_scene(pid, scene_num, video_status="done")
                    project = get_project(pid)
                    if project and check_all_videos_done(project):
                        update_project(pid, project_status="complete")
                        log(f"[API] {filename} → working/ | {pid} COMPLETE ({len(video_bytes)//1024} KB)")
                        completed_page = project.get("page", "?")
                    else:
                        update_project(pid, project_status="videos_in_progress")
                        log(f"[API] {filename} → working/ | scene {scene_num:02d} done ({len(video_bytes)//1024} KB)")
                # Notify AFTER releasing the lock so a slow Telegram call can't
                # stall other parallel slots' contents.json writes.
                if completed_page is not None:
                    notify(f"🎬 Videos complete: {pid} ({completed_page}) — auto-advancing")
                    _start_auto_advance(pid, completed_page)
                self.send_response(200); self._cors(); self.end_headers()
                self.wfile.write(b'{"ok":true}')
                return

            self.send_response(400); self._cors(); self.end_headers()
            self.wfile.write(b'{"error":"unrecognized filename pattern"}')

        else:
            self.send_response(404)
            self.end_headers()


    # ── Pipeline API helpers ─────────────────────────────────────────────────

    def _bot_call(self, fn, *args):
        """Run a bot function under the lock, capture stdout, return (ok, output)."""
        out = io.StringIO()
        try:
            with _data_lock:
                with contextlib.redirect_stdout(out):
                    result = fn(*args)
            return True, out.getvalue().strip(), result
        except SystemExit as e:
            return False, str(e.code), None
        except Exception as e:
            return False, str(e), None

    def _json_response(self, payload: dict):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _read_json_body(self):
        length = int(self.headers.get("Content-Length", 0))
        return json.loads(self.rfile.read(length)) if length else {}

    def _handle_api_queue(self):
        ok, output, _ = self._bot_call(do_queue)
        log(f"[API] queue → ok={ok}")
        self._json_response({"ok": ok, "output": output} if ok else {"ok": False, "error": output})

    def _handle_api_addpage(self):
        body = self._read_json_body()
        name = body.get("name", "").strip()
        if not name:
            self._json_response({"ok": False, "error": "Page name is required"})
            return
        ok, output, _ = self._bot_call(do_addpage, name)
        log(f"[API] addpage '{name}' → ok={ok}")
        self._json_response({"ok": ok, "output": output} if ok else {"ok": False, "error": output})

    def _handle_api_renamepage(self):
        body = self._read_json_body()
        old = body.get("old", "").strip()
        new = body.get("new", "").strip()
        if not old or not new:
            self._json_response({"ok": False, "error": "Both old and new page names are required"})
            return
        ok, output, _ = self._bot_call(do_renamepage, old, new)
        log(f"[API] renamepage '{old}' → '{new}' ok={ok}")
        self._json_response({"ok": ok, "output": output} if ok else {"ok": False, "error": output})

    def _handle_api_archive(self):
        body = self._read_json_body()
        pid = body.get("id", "").strip()
        if not pid:
            self._json_response({"ok": False, "error": "Project ID is required"})
            return
        ok, output, _ = self._bot_call(do_archive, pid)
        log(f"[API] archive '{pid}' → ok={ok}")
        self._json_response({"ok": ok, "output": output} if ok
                            else {"ok": False, "error": output})

    def _handle_api_collect(self):
        ok, output, _ = self._bot_call(do_collect)
        log(f"[API] collect → ok={ok}")
        self._json_response({"ok": ok, "output": output} if ok
                            else {"ok": False, "error": output})

    def _handle_api_delete(self):
        body = self._read_json_body()
        ids = set(body.get("ids", []))
        if not ids:
            self._json_response({"ok": False, "error": "No project IDs provided"})
            return
        try:
            with _data_lock:
                contents = load_contents()
                before = len(contents)
                contents = [p for p in contents if p["id"] not in ids]
                deleted = before - len(contents)
                save_contents(contents)
            log(f"[API] delete {list(ids)} → {deleted} removed")
            self._json_response({"ok": True, "output": f"Deleted {deleted} project(s)"})
        except Exception as e:
            log(f"[API] delete error: {e}")
            self._json_response({"ok": False, "error": str(e)})

    def _handle_api_updateprompts(self):
        body = self._read_json_body()
        ids = body.get("ids", [])
        if not ids:
            self._json_response({"ok": False, "error": "No project IDs provided"})
            return
        results = []
        for pid in ids:
            ok, output, success = self._bot_call(update_project_prompts, pid)
            if ok and success is False:
                results.append({"id": pid, "ok": False, "output": output})
            else:
                results.append({"id": pid, "ok": ok, "output": output if ok else "", "error": "" if ok else output})
        log(f"[API] updateprompts {ids} → {[r['ok'] for r in results]}")
        self._json_response({"ok": True, "results": results})


class _SilentHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True
    """Suppress benign disconnect errors that spam the terminal."""
    def handle_error(self, request, client_address):
        import sys
        if sys.exc_info()[0] in (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
            return
        super().handle_error(request, client_address)

def run_server():
    server = _SilentHTTPServer(("127.0.0.1", API_PORT), APIHandler)
    log(f"API server started on http://127.0.0.1:{API_PORT}")
    server.serve_forever()


# ── File event handlers ──────────────────────────────────────────────────────

class BriefHandler(FileSystemEventHandler):
    """Watches pages/<page>/briefs/ for new .txt brief files."""

    def __init__(self, page_name: str):
        self.page_name = page_name

    def on_created(self, event):
        if event.is_directory:
            return
        path = Path(event.src_path)
        if path.suffix.lower() == ".txt":
            time.sleep(0.5)  # wait for file to finish writing
            self._handle(path)

    def _handle(self, path):
        log(f"New brief: {path.name} (page: {self.page_name})")
        try:
            project_id = add_project(str(path), page_name=self.page_name)
            if project_id:
                log(f"Queued project {project_id} from {path.name} [page: {self.page_name}]")
            # Brief stays in briefs/ — archive command moves it when done
        except Exception as e:
            log(f"ERROR parsing {path.name}: {e}")
            notify_error(f"brief parse {path.name} ({self.page_name})", e)


class DownloadsHandler(FileSystemEventHandler):
    """Watches Downloads folder for project output files."""

    STORYBOARD_RE  = re.compile(r"^(reel_\d{4})-storyboard\.png$",    re.IGNORECASE)
    SCENE_IMG_RE   = re.compile(r"^(reel_\d{4})-scene-(\d{2})\.png$",  re.IGNORECASE)
    THUMBNAIL_RE   = re.compile(r"^(reel_\d{4})-thumbnail\.png$",       re.IGNORECASE)
    VIDEO_RE       = re.compile(r"^(reel_\d{4})-scene-(\d{2})-vdo\.mp4$", re.IGNORECASE)

    def on_created(self, event):
        if event.is_directory:
            return
        path = Path(event.src_path)
        time.sleep(1.0)
        self._handle(path)

    def on_moved(self, event):
        # Chrome saves downloads as <name>.crdownload then renames to <name>
        # That rename fires on_moved, not on_created — we must handle both
        if event.is_directory:
            return
        dest = Path(event.dest_path)
        if dest.suffix.lower() in (".crdownload", ".part", ".tmp"):
            return
        time.sleep(0.5)
        self._handle(dest)

    def _handle(self, path):
        name = path.name

        m = self.STORYBOARD_RE.match(name)
        if m:
            self._handle_storyboard(path, m.group(1))
            return

        m = self.SCENE_IMG_RE.match(name)
        if m:
            self._handle_scene_image(path, m.group(1), int(m.group(2)))
            return

        m = self.THUMBNAIL_RE.match(name)
        if m:
            self._handle_thumbnail(path, m.group(1))
            return

        m = self.VIDEO_RE.match(name)
        if m:
            self._handle_video(path, m.group(1), int(m.group(2)))
            return

    def _handle_storyboard(self, path, project_id):
        dest = _working_dir(project_id) / path.name
        shutil.move(str(path), str(dest))
        update_project(project_id, project_status="storyboard_done")
        log(f"{path.name} → working/ | {project_id}: storyboard_done")

    def _handle_thumbnail(self, path, project_id):
        dest = _working_dir(project_id) / path.name
        shutil.move(str(path), str(dest))
        log(f"{path.name} → working/ | {project_id}: thumbnail saved")

    def _handle_scene_image(self, path, project_id, scene_num):
        dest = _working_dir(project_id) / path.name
        shutil.move(str(path), str(dest))
        with _data_lock:
            update_scene(project_id, scene_num, image_status="done")
            log(f"{path.name} → working/ | {project_id} scene {scene_num:02d} image done")
            project = get_project(project_id)
            if project and check_all_images_done(project):
                update_project(project_id, project_status="images_done")
                log(f"{project_id} → images_done")

    def _handle_video(self, path, project_id, scene_num):
        dest = _working_dir(project_id) / path.name
        shutil.move(str(path), str(dest))
        completed_page = None
        with _data_lock:
            update_scene(project_id, scene_num, video_status="done")
            log(f"{path.name} → working/ | scene {scene_num:02d} video done")
            project = get_project(project_id)
            if project and check_all_videos_done(project):
                update_project(project_id, project_status="complete")
                log(f"{project_id} COMPLETE — run: py bot.py archive {project_id}")
                completed_page = project.get("page", "?")
            else:
                update_project(project_id, project_status="videos_in_progress")
        # Notify outside the lock — keep contents.json writes fast under load.
        if completed_page is not None:
            notify(f"🎬 Videos complete: {project_id} ({completed_page}) — auto-advancing")
            _start_auto_advance(project_id, completed_page)


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    # Tolerate ✓/—/emoji in prints on legacy consoles (cp874) so a log line — or
    # do_collect/do_archive output from an auto-advance thread — can never crash.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

    for d in [PAGES_DIR]:
        d.mkdir(parents=True, exist_ok=True)

    # Start HTTP server in background thread
    server_thread = threading.Thread(target=run_server, daemon=True)
    server_thread.start()

    observer = Observer()

    # Watch each page's briefs/ folder for new .txt brief files
    page_dirs = sorted(d for d in PAGES_DIR.iterdir() if d.is_dir())
    if not page_dirs:
        log("WARNING: No page folders found in pages/ — create pages/page-a/ to start")
    for page_dir in page_dirs:
        briefs = page_dir / "briefs"
        briefs.mkdir(parents=True, exist_ok=True)
        observer.schedule(BriefHandler(page_dir.name), str(briefs), recursive=False)
        log(f"  Watching pages/{page_dir.name}/briefs/")

    observer.schedule(DownloadsHandler(), str(DOWNLOADS_DIR), recursive=False)
    observer.start()

    log(f"Watching:")
    log(f"  Downloads      : {DOWNLOADS_DIR}")
    log(f"  API            : http://127.0.0.1:{API_PORT}")
    log("Tip: restart monitor.py after adding a new page folder.")
    log("Press Ctrl+C to stop.")

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        observer.stop()
    observer.join()


if __name__ == "__main__":
    main()
