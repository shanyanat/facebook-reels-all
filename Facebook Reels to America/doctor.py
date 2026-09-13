"""
doctor.py — is THIS machine actually able to run the pipeline? (stdlib only)

`git pull` succeeding does not mean the machine works. The pull moves code; it
deliberately does NOT move data/, pages/, complete/ or the Chrome profile
(.gitignore), and it cannot reload the Chrome extension — Chrome keeps running the
code it loaded until you press Reload at chrome://extensions. So a machine can be
fully up to date on disk and still be running week-old extension code against the
new Google Flow UI. That is the failure this file exists to catch.

Run it on any machine right after `git pull`:

    py bot.py doctor          (or:  py doctor.py)

Every check prints [ OK ] / [WARN] / [FAIL] and, when it is not OK, the exact
command that fixes it. Exit code is 0 when nothing FAILed, 1 otherwise.

  [ OK ]  ready
  [WARN]  works, but you will hit it later (e.g. no pages yet on a fresh clone)
  [FAIL]  the pipeline cannot run until you fix it

This file only READS. It never creates folders, installs packages, starts
monitor.py or kills anything — a diagnostic that changes state is one you cannot
trust the second time you run it. (`preflight.py` is the one that mutates: it
kills stray Chrome and clears old quarantine files before a run.)

Stdlib only and no imports from the rest of the project, on purpose: it has to
run on a machine where the project itself is broken.

ASCII output only — several machines here run a Thai Windows console (cp874)
that cannot encode box-drawing characters or emoji.
"""

import json
import os
import socket
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

BASE_DIR = Path(__file__).parent
REPO_DIR = BASE_DIR.parent                      # "Facebook Reels All"
EXT_DIR = REPO_DIR / "Facebook Reels Extension"
EDITOR_MAIN = REPO_DIR / "Ai Auto Editor" / "main.py"
CHROME_PROFILE = Path("C:/temp/chrome-bot")     # must match phases/*.py
API_PORT = 7788                                 # must match monitor.py

# The host Google Flow moved to (2026-09-11). An extension whose manifest predates
# that move never injects content/flow.js at all on the new site.
FLOW_HOST = "flow.google.com"

_results = []        # (level, title, detail, fix)

# Read every JSON file as utf-8-SIG. A file that has been through Notepad or
# PowerShell's Set-Content picks up a UTF-8 BOM, which plain utf-8 chokes on
# ("Unexpected UTF-8 BOM") — and doctor would then report a perfectly working
# extension as broken. utf-8-sig strips a BOM if present and is identical to
# utf-8 when it isn't.
_ENC = "utf-8-sig"


def _add(level, title, detail="", fix=""):
    _results.append((level, title, detail, fix))


def ok(title, detail=""):
    _add("OK", title, detail)


def warn(title, detail="", fix=""):
    _add("WARN", title, detail, fix)


def fail(title, detail="", fix=""):
    _add("FAIL", title, detail, fix)


def _git(*args, timeout=20):
    """Run a git command in the repo. Returns (rc, stdout) — never raises."""
    try:
        p = subprocess.run(
            ["git", "-C", str(REPO_DIR), *args],
            capture_output=True, text=True, timeout=timeout,
            encoding="utf-8", errors="replace",
        )
        return p.returncode, (p.stdout or "").strip()
    except (OSError, subprocess.SubprocessError) as e:
        return 1, f"{type(e).__name__}: {e}"


# -- 1. Did the pull actually land? -------------------------------------------

def check_git():
    rc, _ = _git("rev-parse", "--git-dir")
    if rc != 0:
        fail("Git repo", f"{REPO_DIR} is not a git checkout",
             'Clone it: git clone <repo-url> "Facebook Reels All"')
        return

    rc, head = _git("rev-parse", "--short", "HEAD")
    rc2, subject = _git("log", "-1", "--format=%s")
    ok("Git repo", f"HEAD {head} - {subject[:60]}" if rc == 0 and rc2 == 0 else "found")

    # How far behind origin? (Needs a fetch to be meaningful; say so rather than
    # fetching, because a doctor must not touch the network state of the repo.)
    rc, behind = _git("rev-list", "--count", "HEAD..origin/master")
    if rc == 0 and behind.isdigit():
        n = int(behind)
        if n:
            fail("Up to date with origin/master",
                 f"{n} commit(s) behind (as of the last fetch)",
                 "git pull      then RELOAD the extension (see the extension check below)")
        else:
            ok("Up to date with origin/master", "no unpulled commits at last fetch")
    else:
        warn("Up to date with origin/master",
             "cannot compare - no origin/master ref on this machine",
             "git fetch origin")

    rc, dirty = _git("status", "--porcelain")
    if rc == 0 and dirty:
        n = len(dirty.splitlines())
        warn("Working tree clean", f"{n} local change(s) not committed",
             "git status      - local edits can make this machine behave unlike the others")
    elif rc == 0:
        ok("Working tree clean")


# -- 2. The Chrome extension: the #1 cause of "works here, fails there" --------

def check_extension():
    mf = EXT_DIR / "manifest.json"
    if not mf.exists():
        fail("Chrome extension present", f"missing: {mf}",
             "git pull   (the extension lives in the same repo as the bot)")
        return

    try:
        data = json.loads(mf.read_text(encoding=_ENC))
    except (json.JSONDecodeError, OSError) as e:
        fail("Chrome extension manifest", f"unreadable: {e}", "git checkout -- <manifest path>")
        return

    version = data.get("version", "?")
    if version == "1.0":
        # "1.0" was the fixed value from the first commit until 2026-09-13. Seeing it
        # means this machine has NOT pulled the versioned manifest yet, so there is
        # nothing useful to compare Chrome against — pull first, THEN reload.
        warn("Chrome extension on disk",
             "manifest version is still the old fixed '1.0' - it never changed, so it "
             "cannot tell you whether Chrome reloaded",
             "git pull first (newer manifests use a YYYY.M.D version), THEN press Reload "
             "at chrome://extensions. Do not go by what Chrome shows until you have pulled.")
    else:
        ok("Chrome extension on disk", f"manifest version {version} (dated YYYY.M.D)")
        _add("NOTE", "Extension reloaded in Chrome?",
             f"Cannot be checked from Python. Open chrome://extensions and read the version "
             f"printed under the 'Reels Parallel Generator' name.",
             f"Chrome must show {version}. If it shows anything older, press Reload on that "
             f"card - a git pull NEVER reloads a loaded extension, Chrome keeps running the "
             f"code it loaded until you do. This is the first thing to check when Flow image "
             f"upload fails on one machine and works on another.")

    # Does this manifest know where Google Flow actually lives?
    matches = []
    for cs in data.get("content_scripts", []):
        if any("flow.js" in j for j in cs.get("js", [])):
            matches = cs.get("matches", [])
    if not matches:
        fail("Extension targets Google Flow", "no content script registered for flow.js",
             "git pull")
    elif not any(FLOW_HOST in m for m in matches):
        fail("Extension targets Google Flow",
             f"manifest still matches only {matches} - Flow moved to {FLOW_HOST}",
             "git pull      then Reload at chrome://extensions")
    else:
        ok("Extension targets Google Flow", f"matches {FLOW_HOST}")


# -- 3. Python dependencies ----------------------------------------------------

def check_python():
    ok("Python", f"{sys.version.split()[0]} ({sys.executable})")

    for mod, why in (("playwright", "terminal images/videos phases"),
                     ("watchdog", "monitor.py brief + download watching")):
        try:
            __import__(mod)
            ok(f"Python package: {mod}", why)
        except ImportError:
            fail(f"Python package: {mod}", f"not installed - needed for {why}",
                 f"pip install {mod}")

    # playwright install chromium is a SEPARATE step from pip install playwright.
    la = os.environ.get("LOCALAPPDATA")
    if not la:
        return
    pw_dir = Path(la) / "ms-playwright"
    if not pw_dir.exists():
        fail("Playwright Chromium browser", "no ms-playwright folder - browser never downloaded",
             "playwright install chromium")
        return
    builds = [d for d in pw_dir.iterdir() if d.is_dir() and d.name.startswith("chromium")]
    if builds:
        ok("Playwright Chromium browser", ", ".join(sorted(b.name for b in builds)[:3]))
    else:
        fail("Playwright Chromium browser", f"no chromium build under {pw_dir}",
             "playwright install chromium")


# -- 4. monitor.py: what the extension fetches every scene image from ----------

def check_monitor():
    with socket.socket() as s:
        s.settimeout(1.5)
        try:
            s.connect(("127.0.0.1", API_PORT))
        except OSError:
            warn("monitor.py running", f"nothing listening on 127.0.0.1:{API_PORT}",
                 "py monitor.py      (needed by the extension - it fetches every scene "
                 "image from this server; without it Flow gets no file at all)")
            return

    try:
        with urllib.request.urlopen(
                f"http://127.0.0.1:{API_PORT}/contents.json", timeout=10) as r:
            projects = json.loads(r.read().decode("utf-8"))
        ok("monitor.py running", f"serving {len(projects)} project(s) on port {API_PORT}")
    except (urllib.error.URLError, json.JSONDecodeError, OSError) as e:
        fail("monitor.py running",
             f"port {API_PORT} is open but /contents.json failed: {type(e).__name__}: {e}",
             "Restart it: Ctrl+C in the monitor tab, then py monitor.py")
        return

    _check_file_serving(projects)


def _check_file_serving(projects):
    """Can the extension actually FETCH a scene image? This is the step that fails
    as "failed to upload" in Flow: content/flow.js builds
    pages/<page>/working/<pid>-scene-NN.png and background.js fetches it from
    /file/. A 404 there means Flow is handed nothing at all. Probing the real URL
    shape is the only way to tell that apart from a Flow-side rejection."""
    probe = None
    for p in projects:
        page, pid = p.get("page"), p.get("id")
        if not page or not pid:
            continue
        for s in p.get("scenes", []):
            if s.get("img_on_disk"):        # monitor says this PNG is on disk
                nn = str(s.get("scene_num", "")).zfill(2)
                probe = (page, f"{pid}-scene-{nn}.png")
                break
        if probe:
            break

    if not probe:
        warn("monitor.py can serve scene images",
             "no scene PNG exists yet on this machine, so there is nothing to probe "
             "(normal before the image phase has run here)",
             "Re-run doctor once a reel has images; pages/ is gitignored, so a pulled "
             "machine has no PNGs until it generates its own.")
        return

    page, filename = probe
    url = f"http://127.0.0.1:{API_PORT}/file/pages/{page}/working/{filename}"

    # GET, not HEAD — monitor.py implements only do_GET/do_POST/do_OPTIONS (see the
    # separate HEAD check below). Headers are enough; the body is never read.
    try:
        with urllib.request.urlopen(url, timeout=10) as r:
            if r.status == 200:
                ok("monitor.py can serve scene images", f"GET {filename} -> 200")
            else:
                fail("monitor.py can serve scene images", f"GET {filename} -> {r.status}",
                     "py bot.py reconcile   then   py bot.py reconcile apply")
    except urllib.error.HTTPError as e:
        fail("monitor.py can serve scene images",
             f"GET {filename} -> {e.code}: the extension would hand Google Flow nothing, "
             f"which Flow reports as a failed upload",
             "Check the file really is in pages/<page>/working/. If it is, the path "
             "monitor.py resolves differs - restart monitor.py from the project folder.")
        return
    except (urllib.error.URLError, OSError) as e:
        fail("monitor.py can serve scene images", f"{type(e).__name__}: {e}",
             "Restart it: Ctrl+C in the monitor tab, then py monitor.py")
        return

    # content/flow.js waitForFileInWorking() polls this same URL with HEAD to confirm a
    # downloaded clip landed. monitor.py has no do_HEAD, so BaseHTTPRequestHandler answers
    # 501 and that check can never succeed: every scene burns its full 180 s timeout and
    # reports "download timed out after 3 min" even though the MP4 saved fine. The run
    # still completes (the retry sees vdo_on_disk and skips the scene), so this costs
    # time, not deliverables. Reported, not fixed — the fix is a do_HEAD in monitor.py.
    try:
        req = urllib.request.Request(url, method="HEAD")
        with urllib.request.urlopen(req, timeout=10) as r:
            head_code = r.status
    except urllib.error.HTTPError as e:
        head_code = e.code
    except (urllib.error.URLError, OSError):
        head_code = None
    if head_code == 200:
        ok("monitor.py answers HEAD", "flow.js download verification works")
    elif head_code is not None:
        warn("monitor.py answers HEAD",
             f"HEAD -> {head_code} (monitor.py implements only GET/POST/OPTIONS). "
             f"flow.js waitForFileInWorking() polls with HEAD, so it can never succeed: "
             f"every scene waits the full 3 min and logs 'download timed out' even when "
             f"the clip saved. Costs time per scene, not deliverables.",
             "Add a do_HEAD to monitor.py's APIHandler that reuses do_GET's headers.")


# -- 5. Per-machine data (gitignored ON PURPOSE - absence is normal) -----------

def check_data():
    cj = BASE_DIR / "data" / "contents.json"
    if not cj.exists():
        warn("data/contents.json", "not present yet - normal on a fresh clone "
                                   "(data/ is gitignored so machines never overwrite each other)",
             "py bot.py queue       - it is created the first time you register a brief")
    else:
        try:
            projects = json.loads(cj.read_text(encoding=_ENC))
            ok("data/contents.json", f"{len(projects)} live project(s)")
        except (json.JSONDecodeError, OSError) as e:
            fail("data/contents.json", f"corrupt: {type(e).__name__}: {e}",
                 "py repair_contents.py")

    pages = BASE_DIR / "pages"
    page_dirs = [d for d in pages.iterdir() if d.is_dir()] if pages.exists() else []
    if not page_dirs:
        warn("pages/ folders", "no page folders yet - normal on a fresh clone (pages/ is gitignored)",
             'py bot.py addpage page-<name>     then drop a .txt brief into its briefs/ folder')
    else:
        n_briefs = sum(len(list((d / "briefs").glob("*.txt")))
                       for d in page_dirs if (d / "briefs").exists())
        ok("pages/ folders", f"{len(page_dirs)} page(s), {n_briefs} brief .txt file(s)")


# -- 6. Things the repo can never carry ---------------------------------------

def check_local_only():
    if CHROME_PROFILE.exists():
        ok("Chrome bot profile", str(CHROME_PROFILE))
    else:
        warn("Chrome bot profile", f"{CHROME_PROFILE} does not exist - the terminal "
                                   "images/videos phases will open a logged-out Chrome",
             "Run py bot.py images once and log in when it pauses (5 min window). "
             "The extension path does not use this profile.")

    if EDITOR_MAIN.exists():
        ok("Ai Auto Editor", str(EDITOR_MAIN.relative_to(REPO_DIR)))
    else:
        fail("Ai Auto Editor", f"missing: {EDITOR_MAIN} - bot.py needs it to render "
                               "EDITED_*.mp4 (editor_queue / pipeline / handoff)",
             "git pull   (it is in the same repo, as 'Ai Auto Editor/')")

    try:
        import shutil as _sh
        free_gb = _sh.disk_usage(str(BASE_DIR)).free / (1024 ** 3)
        if free_gb < 10:
            fail("Free disk space", f"{free_gb:.1f} GB free on this drive",
                 "py bot.py cleanup     (and see 'prune'); renders need room")
        else:
            ok("Free disk space", f"{free_gb:.1f} GB free")
    except OSError:
        pass


# -- Report --------------------------------------------------------------------

def doctor() -> bool:
    """Run every check and print the report. True when nothing FAILed."""
    print("=" * 74)
    print("  doctor - can this machine run the Reels pipeline?")
    print(f"  repo: {REPO_DIR}")
    print("=" * 74)

    for fn in (check_git, check_extension, check_python,
               check_monitor, check_data, check_local_only):
        try:
            fn()
        except Exception as e:                      # a broken check must not hide the rest
            fail(fn.__name__, f"check itself crashed: {type(e).__name__}: {e}")

    n_fail = sum(1 for lvl, *_ in _results if lvl == "FAIL")
    n_warn = sum(1 for lvl, *_ in _results if lvl == "WARN")

    for level, title, detail, fix in _results:
        tag = {"OK": "[ OK ]", "WARN": "[WARN]", "FAIL": "[FAIL]", "NOTE": "[ ?? ]"}[level]
        print(f"\n{tag} {title}")
        if detail:
            print(f"       {detail}")
        if fix:
            print(f"       FIX: {fix}")

    print("\n" + "=" * 74)
    if n_fail:
        print(f"  {n_fail} FAIL, {n_warn} WARN - fix every [FAIL] above before running.")
    elif n_warn:
        print(f"  0 FAIL, {n_warn} WARN - usable; the warnings say what you still need.")
    else:
        print("  All checks passed - this machine is ready.")
    print("=" * 74)
    print("\n  [ ?? ] items cannot be checked from Python - confirm them by hand.")
    print("  Still failing to attach images in Flow after this is clean? The next")
    print("  suspect is the GOOGLE ACCOUNT signed into that Chrome: open")
    print("  https://flow.google.com, check which account it is, and try uploading")
    print("  an image by hand. Flow rejects uploads for accounts without a plan,")
    print("  and each machine's Chrome has its own login.")
    return n_fail == 0


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    sys.exit(0 if doctor() else 1)


if __name__ == "__main__":
    main()
