"""
phases/video_phase.py
Playwright automation for Google Flow video generation.

For each pending scene (image_status=done, video_status=pending):
  - Navigate to flow.google.com → New project
  - Upload scene image → paste video prompt → configure settings
  - Generate → wait → download the clip (720p Original size)
  - Save to pending/{project_id}-scene-NN.mp4

Usage:
  py bot.py videos
  py bot.py videos reel_0001
"""

import asyncio
import base64
import os
import re
import sys
import time
from pathlib import Path

from playwright.async_api import async_playwright, Page, BrowserContext
from playwright.async_api import TimeoutError as PwTimeout

BASE_DIR = Path(__file__).parent.parent
CHROME_PROFILE = Path("C:/temp/chrome-bot")
FLOW_URL = "https://flow.google.com/"

sys.path.insert(0, str(BASE_DIR))
from parse_analysis import load_contents, save_contents
from notify import notify, notify_error


# ── Status helpers ────────────────────────────────────────────────────────────

def _update_project(project_id: str, **kwargs):
    data = load_contents()
    for p in data:
        if p["id"] == project_id:
            p.update(kwargs)
            break
    save_contents(data)


def _update_scene(project_id: str, scene_num: int, **kwargs):
    data = load_contents()
    for p in data:
        if p["id"] == project_id:
            for s in p["scenes"]:
                if s["scene_num"] == scene_num:
                    s.update(kwargs)
                    break
            break
    save_contents(data)


def _check_all_videos_done(project_id: str) -> bool:
    data = load_contents()
    for p in data:
        if p["id"] == project_id:
            return all(s["video_status"] == "done" for s in p["scenes"])
    return False


def log(msg: str):
    print(f"[video-bot] {msg}", flush=True)


def _cut_at_end_marker(text: str, section: str) -> str:
    """Strip everything from 'The End of <section> PROMPTS' marker onwards."""
    m = re.search(
        r"^[^\n]*the\s+end\s+of\s+" + re.escape(section) + r"\s+prompts?[^\n]*",
        text, re.IGNORECASE | re.MULTILINE,
    )
    if m:
        before = text[: m.start()].rstrip("\n")
        lines = before.split("\n")
        while lines and re.match(r"^[-=\s]+$", lines[-1]) and len(lines[-1].strip()) >= 3:
            lines.pop()
        return "\n".join(lines).rstrip()
    lines = text.rstrip("\n").split("\n")
    if lines and lines[-1].strip().startswith("---") and lines[-1].strip().endswith("---") and len(lines[-1].strip()) > 6:
        lines.pop()
    return "\n".join(lines).rstrip()


# ── Chrome launch ─────────────────────────────────────────────────────────────

def _find_chrome() -> str:
    username = os.environ.get("USERNAME", "user")
    candidates = [
        Path("C:/Program Files/Google/Chrome/Application/chrome.exe"),
        Path("C:/Program Files (x86)/Google/Chrome/Application/chrome.exe"),
        Path(f"C:/Users/{username}/AppData/Local/Google/Chrome/Application/chrome.exe"),
    ]
    for p in candidates:
        if p.exists():
            return str(p)
    print("[ERROR] Google Chrome not found. Please install Chrome.")
    sys.exit(1)


async def connect_chrome():
    """Launch Chrome with persistent profile and stealth flags."""
    pw = await async_playwright().start()
    CHROME_PROFILE.mkdir(parents=True, exist_ok=True)
    chrome_exe = _find_chrome()
    log(f"Launching Chrome (profile: {CHROME_PROFILE})")
    context = await pw.chromium.launch_persistent_context(
        user_data_dir=str(CHROME_PROFILE),
        executable_path=chrome_exe,
        headless=False,
        args=[
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-blink-features=AutomationControlled",
            "--disable-infobars",
            "--start-maximized",
        ],
        ignore_default_args=["--enable-automation"],
        accept_downloads=True,   # the clip viewer's Download media route needs this
    )
    await context.add_init_script(
        "Object.defineProperty(navigator,'webdriver',{get:()=>undefined})"
    )
    log("Chrome launched")
    return pw, context


async def ensure_logged_in_flow(context: BrowserContext) -> Page:
    """Open Google Flow and verify login. Exits with instructions if not logged in."""
    page = await context.new_page()
    await page.goto(FLOW_URL, wait_until="domcontentloaded")
    await page.wait_for_timeout(4000)

    url = page.url
    if any(x in url for x in ("accounts.google", "signin", "login")):
        print("\n" + "=" * 55)
        print("  NOT LOGGED INTO Google Flow / Google Account")
        print("  Please log in manually in the Chrome window.")
        print(f"  After logging in, re-run: py bot.py videos")
        print("=" * 55)
        await asyncio.sleep(2)
        sys.exit(0)

    log("Google Flow: logged in ✓")
    return page


# ── Flow UI helpers ───────────────────────────────────────────────────────────

async def click_new_project(page: Page):
    """Click the '+ โปรเจกต์ใหม่' button on the Flow home page.

    The Flow home grid can take a while to render, so instead of one shot we poll
    for up to ~45s and reload once midway. This makes the step reliable rather
    than failing intermittently when the page is slow (the old one-try version
    aborted the whole reel if the button was not yet on screen)."""
    candidates = [
        "button:has-text('โปรเจกต์ใหม่')",
        "button:has-text('โปรเจ็กต์ใหม่')",
        "button:has-text('New project')",
        "button:has-text('New Project')",
        "[role='button']:has-text('โปรเจกต์ใหม่')",
        "[role='button']:has-text('New project')",
        "a:has-text('New project')",
    ]

    async def _try_click() -> bool:
        for sel in candidates:
            try:
                loc = page.locator(sel).first
                if await loc.count() and await loc.is_visible():
                    await loc.click()
                    await page.wait_for_timeout(2500)
                    log("Clicked: New project / โปรเจกต์ใหม่")
                    return True
            except Exception:
                pass
        # Broad text search fallback
        try:
            btns = page.locator("button, [role='button'], a")
            n = await btns.count()
            for i in range(n):
                b = btns.nth(i)
                txt = (await b.text_content() or "").strip()
                if "โปรเจ" in txt or txt in ("New project", "New Project"):
                    await b.click()
                    await page.wait_for_timeout(2500)
                    log(f"Clicked: '{txt}'")
                    return True
        except Exception:
            pass
        return False

    deadline = time.time() + 45
    reloaded = False
    attempt = 0
    while time.time() < deadline:
        attempt += 1
        if await _try_click():
            return
        # Halfway through, reload once in case the home page got stuck mid-load.
        if not reloaded and time.time() > deadline - 25:
            log("New project button still missing — reloading Flow home once ...")
            try:
                await page.goto(FLOW_URL, wait_until="domcontentloaded")
            except Exception:
                pass
            reloaded = True
            await page.wait_for_timeout(3000)
            continue
        log(f"New project button not visible yet — waiting (attempt {attempt}) ...")
        await page.wait_for_timeout(3000)

    raise RuntimeError("'New project' button not found on Google Flow home after 45s")


async def wait_for_compose_bar(page: Page, timeout: int = 15000):
    """Wait for compose bar, then dump all visible interactive elements for debugging."""
    # Try a wider net of selectors
    for sel in [
        "textarea",
        "[contenteditable='true']",
        "input[type='text']",
        "[role='textbox']",
        "[placeholder*='สร้าง' i]",
        "[placeholder*='create' i]",
        "[placeholder*='คุณ']",
    ]:
        try:
            await page.locator(sel).first.wait_for(state="visible", timeout=3000)
            log("Compose bar ready ✓")
            await page.wait_for_timeout(800)
            break
        except PwTimeout:
            continue
    else:
        log("WARNING: compose bar text input not detected — waiting 3s for page to settle")
        await page.wait_for_timeout(3000)

    # Debug: log every visible interactive element so we can see what's on the page
    info = await page.evaluate("""() => {
        const result = [];
        const seen = new Set();
        for (const el of document.querySelectorAll(
            'button, [role="button"], [role="tab"], a[href], input, textarea, [contenteditable]'
        )) {
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            const txt = (el.textContent || '').trim().substring(0, 60);
            const lbl = el.getAttribute('aria-label') || '';
            const key = txt + '|' + lbl + '|' + Math.round(r.left) + '|' + Math.round(r.top);
            if (seen.has(key)) continue;
            seen.add(key);
            result.push({
                tag: el.tagName,
                role: el.getAttribute('role') || '',
                text: txt,
                aria: lbl,
                x: Math.round(r.left),
                y: Math.round(r.top),
                w: Math.round(r.width),
                h: Math.round(r.height),
            });
        }
        return result;
    }""")
    log("=== PAGE ELEMENTS AFTER NEW PROJECT ===")
    for item in info:
        log(f"  [{item['tag']}/{item['role']}] ({item['x']},{item['y']}) "
            f"text='{item['text']}' aria='{item['aria']}'")
    log("=== END ELEMENTS ===")


async def _find_compose_input_rect(page: Page) -> dict | None:
    """Return bounding rect of the compose bar text input via JS."""
    return await page.evaluate("""() => {
        const el = document.querySelector(
            'textarea, [contenteditable="true"], input[type="text"]'
        );
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return {left: r.left, right: r.right, top: r.top, bottom: r.bottom};
    }""")


async def click_plus_button(page: Page):
    """Click add_2สร้าง (the upload/+ button in the compose bar — image mode only)."""
    # Primary: button with Material icon text 'add_2' (only visible in image mode)
    for sel in ["button:has-text('add_2')", "button:has-text('add_2สร้าง')"]:
        loc = page.locator(sel).first
        if await loc.count() and await loc.is_visible():
            await loc.click()
            await page.wait_for_timeout(800)
            log("Clicked: add_2สร้าง (upload button)")
            return

    # JS fallback: find button in compose bar area (x=20-55% of screen width, bottom 30%)
    result = await page.evaluate("""() => {
        const vh = window.innerHeight;
        const vw = window.innerWidth;

        const btns = [...document.querySelectorAll('button, [role="button"]')]
            .filter(el => {
                const r = el.getBoundingClientRect();
                return r.width > 0 && r.height > 0 && r.top > vh * 0.7;
            });

        // Look for 'add' in text content (Material icon 'add_2' or similar)
        for (const b of btns) {
            const txt = (b.textContent || '').trim().toLowerCase();
            const lbl = (b.getAttribute('aria-label') || '').toLowerCase();
            if (txt.startsWith('add') || lbl.includes('add') || lbl.includes('upload') || lbl.includes('อัป')) {
                b.click();
                const r = b.getBoundingClientRect();
                return 'js-text:' + (b.textContent || '').trim().substring(0, 20) + ' at (' + Math.round(r.left) + ',' + Math.round(r.top) + ')';
            }
        }

        // Spatial: leftmost button in compose bar horizontal band (x: 15-50% of screen)
        const composeBtns = btns
            .filter(b => {
                const r = b.getBoundingClientRect();
                return r.left > vw * 0.15 && r.left < vw * 0.55;
            })
            .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);

        if (composeBtns.length > 0) {
            composeBtns[0].click();
            const r = composeBtns[0].getBoundingClientRect();
            return 'js-spatial:' + composeBtns[0].tagName + ' at (' + Math.round(r.left) + ',' + Math.round(r.top) + ')';
        }

        return null;
    }""")

    if result:
        await page.wait_for_timeout(800)
        log(f"Clicked: + [{result}]")
        return

    raise RuntimeError("add_2สร้าง button not found — page may already be in video mode")


async def click_upload_image(page: Page):
    """Click 'อัปโหลดรูปภาพ' in the media picker popup."""
    candidates = [
        "[role='menuitem']:has-text('อัปโหลดรูปภาพ')",
        "[role='option']:has-text('อัปโหลดรูปภาพ')",
        "button:has-text('อัปโหลดรูปภาพ')",
        "[role='menuitem']:has-text('อัพโหลดรูปภาพ')",
        "button:has-text('อัพโหลดรูปภาพ')",
        "[role='menuitem']:has-text('Upload image')",
        "button:has-text('Upload image')",
    ]
    for sel in candidates:
        loc = page.locator(sel).first
        if await loc.count() and await loc.is_visible():
            await loc.click()
            await page.wait_for_timeout(500)
            log("Clicked: อัปโหลดรูปภาพ / Upload image")
            return

    # Broad search
    items = page.locator("[role='menuitem'], [role='option'], button, li")
    n = await items.count()
    for i in range(n):
        item = items.nth(i)
        txt = (await item.text_content() or "").lower()
        if ("อัปโหลด" in txt or "อัพโหลด" in txt or "upload" in txt) and await item.is_visible():
            await item.click()
            await page.wait_for_timeout(500)
            log(f"Clicked upload option: '{txt.strip()}'")
            return

    raise RuntimeError("'อัปโหลดรูปภาพ' / Upload image option not found")


async def _legacy_media_browser_upload(page: Page, image_path: Path) -> bool:
    """Older Flow UI: the Start slot opened a media browser with its own อัปโหลดสื่อ button."""
    clicked = await page.evaluate("""() => {
        for (const el of document.querySelectorAll('button, [role="button"], div[class], span[class]')) {
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            const txt = (el.textContent || '').trim();
            if (txt === 'เริ่ม' || txt === 'Start' || txt === 'เริ่มต้น') { el.click(); return txt; }
        }
        return null;
    }""")
    if not clicked:
        return False
    await page.wait_for_timeout(1500)

    for sel in [
        "button:has-text('อัปโหลดสื่อ')",
        "a:has-text('อัปโหลดสื่อ')",
        "[role='button']:has-text('อัปโหลดสื่อ')",
        "button:has-text('Upload media')",
    ]:
        loc = page.locator(sel).first
        if await loc.count() and await loc.is_visible():
            try:
                async with page.expect_file_chooser(timeout=8000) as fc_info:
                    await loc.click()
                fc = await fc_info.value
                await fc.set_files(str(image_path))
                await page.wait_for_timeout(3000)
                log(f"Uploaded via อัปโหลดสื่อ: {image_path.name}")
                return True
            except PwTimeout:
                log(f"File chooser timed out for '{sel}'")

    fi = page.locator("input[type='file']").last
    if await fi.count():
        await fi.set_input_files(str(image_path))
        await page.wait_for_timeout(3000)
        log(f"Uploaded via hidden file input: {image_path.name}")
        return True
    return False


async def _wait_for_upload_finished(page: Page, max_wait_ms: int = 120000) -> bool:
    """Flow paints "<n>%" on the tile while an upload runs. Wait for that to clear, so
    the frame picker lists a finished file rather than a partial one."""
    await page.wait_for_timeout(2000)
    deadline = time.time() + max_wait_ms / 1000
    while time.time() < deadline:
        body = await page.evaluate("() => document.body.innerText") or ""
        if not re.search(r"\b\d{1,3}%", body):
            return True
        await page.wait_for_timeout(1500)
    log("WARNING: upload progress never cleared — continuing anyway")
    return False


async def _open_frame_picker(page: Page) -> bool:
    """Click the Start frame slot to open the "Select a frame image" picker.

    Two slot states to handle: empty, where it reads "Start"; and — from scene 2 onward,
    since all scenes share one project — still holding the previous scene's thumbnail,
    where the word "Start" is gone and the slot is the "Image ingredient" chip. Clicking
    that chip either reopens the picker or clears the slot back to "Start"; the loop
    copes with both. The slot does nothing at all until the project has media, which is
    why this runs after the upload rather than before it.
    """
    for attempt in range(5):
        if await page.locator("button:has-text('Add to prompt')").count():
            return True
        for loc in (page.get_by_role("button", name="Start", exact=True).first,
                    page.locator("[aria-label='Image ingredient']").first):
            if await loc.count() and await loc.is_visible():
                await loc.click()
                await page.wait_for_timeout(2500)
                if await page.locator("button:has-text('Add to prompt')").count():
                    log("Frame picker opened")
                    return True
                break
        await page.wait_for_timeout(1200)
    return False


async def _frame_attached(page: Page) -> bool:
    """True once an image sits in the Start slot: the picker is closed and the slot holds
    a thumbnail — the "Image ingredient" chip — instead of the word "Start".

    This deliberately does not check the filename. The chip's name is not reliably part of
    the page's rendered text, so matching it reported "not attached" for an image that was
    plainly attached. That the slot holds THIS scene's image is guaranteed upstream, by
    selecting the picker entry by name and treating a miss as fatal."""
    return await page.evaluate("""() => {
        const vis = el => { const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
        if (/Select a frame image|เลือกภาพเฟรม/i.test(document.body.innerText || '')) return false;
        if ([...document.querySelectorAll('[aria-label="Image ingredient"]')].some(vis)) return true;
        return ![...document.querySelectorAll('button, [role="button"]')]
            .some(el => vis(el) && ['Start', 'เริ่ม', 'เริ่มต้น'].includes((el.textContent || '').trim()));
    }""")


async def _try_first_frame_upload(page: Page, image_path: Path) -> bool:
    """
    Video-mode upload on the current Flow UI:
      1. "Add media menu" (+) -> "Upload" -> file chooser; the image lands in the
         project's media library
      2. Click the Start frame slot -> the "Select a frame image" picker opens
      3. Click the entry matching the filename, then "Add to prompt"
    Falls back to the old Start-slot media browser when the new menu is absent.
    """
    log("Uploading scene image into the project library...")

    uploaded = False
    add_menu = page.locator("[aria-label='Add media menu']").first
    if await add_menu.count() and await add_menu.is_visible():
        try:
            async with page.expect_file_chooser(timeout=15000) as fc_info:
                await add_menu.click()
                await page.wait_for_timeout(800)
                await page.get_by_role("menuitem", name=re.compile("Upload")).first.click()
            fc = await fc_info.value
            await fc.set_files(str(image_path))
            log(f"Uploaded via Add media menu: {image_path.name}")
            uploaded = True
        except Exception as e:
            log(f"Add media menu upload failed ({type(e).__name__}) — trying the old media browser")
            await page.keyboard.press("Escape")
            await page.wait_for_timeout(500)

    if not uploaded:
        uploaded = await _legacy_media_browser_upload(page, image_path)
    if not uploaded:
        log("Image upload failed — no upload route worked")
        return False

    await _wait_for_upload_finished(page)

    if not await _open_frame_picker(page):
        log("WARNING: frame picker did not open after upload")
        return False

    # Select this scene's file BY NAME. This is the step that guarantees the scene gets
    # its own image: the picker preselects the most recent upload, which stops being the
    # right one once the project holds several scenes. A miss is fatal rather than a
    # silent fall-through to whatever happens to be selected.
    picked = page.locator(f"[role='option']:has-text('{image_path.name}')").first
    if not await picked.count():
        log(f"'{image_path.name}' was not listed in the frame picker")
        return False
    await picked.click()
    await page.wait_for_timeout(1500)
    log(f"Selected in picker: {image_path.name}")

    # Clicking the entry normally attaches it and closes the picker outright, so
    # "Add to prompt" is often already gone. Click it only while it is still there.
    for attempt in range(4):
        if await _frame_attached(page):
            log("Scene image attached to the Start frame ✓")
            return True
        for sel in [
            "button:has-text('เพิ่มไปยังพรอมต์')",
            "[role='button']:has-text('เพิ่มไปยังพรอมต์')",
            "button:has-text('Add to prompt')",
        ]:
            loc = page.locator(sel).first
            if await loc.count() and await loc.is_visible():
                await loc.click()
                log("Clicked: Add to prompt")
                break
        await page.wait_for_timeout(1200 + attempt * 500)

    if await _frame_attached(page):
        log("Scene image attached to the Start frame ✓")
        return True
    log("WARNING: scene image was not attached to the Start frame")
    return False


async def upload_scene_image(page: Page, image_path: Path):
    """Upload scene PNG. Video mode: เริ่ม slot → อัปโหลดสื่อ → เพิ่มไปยังพรอมต์."""
    log(f"Uploading scene image: {image_path.name}...")

    # Detect mode: add_2สร้าง button exists = image mode; absent = video mode
    is_image_mode = await page.locator("button:has-text('add_2')").count() > 0

    if is_image_mode:
        log("Image mode — using compose bar upload")
        try:
            async with page.expect_file_chooser(timeout=10000) as fc_info:
                await click_plus_button(page)
                await page.wait_for_timeout(600)
                await click_upload_image(page)
            fc = await fc_info.value
            await fc.set_files(str(image_path))
            await page.wait_for_timeout(3000)
            log(f"Image uploaded via compose bar: {image_path.name}")
            return
        except (PwTimeout, RuntimeError) as e:
            log(f"Compose bar upload failed — trying Start frame slot")
            await page.keyboard.press("Escape")
            await page.wait_for_timeout(400)
    else:
        log("Video mode — using Start frame slot (skipping Agent button)")

    if await _try_first_frame_upload(page, image_path):
        return

    raise RuntimeError(f"All upload methods failed for {image_path.name}")


async def fill_video_prompt(page: Page, prompt: str):
    """Type the video prompt into Flow's text field (textarea or div[role=textbox])."""
    for selector in [
        "textarea",
        "[contenteditable='true']",
        "[role='textbox']",
        "[placeholder*='prompt' i]",
        "[placeholder*='Describe' i]",
        "[placeholder*='สร้าง' i]",
        "input[type='text']",
    ]:
        loc = page.locator(selector).first
        if await loc.count() and await loc.is_visible():
            await loc.click()
            await page.wait_for_timeout(200)
            try:
                await loc.fill(prompt)
            except Exception:
                # fill() doesn't work on non-input elements — use keyboard
                await loc.evaluate("el => { el.textContent = ''; }")
                await page.keyboard.type(prompt)
            log(f"Typed video prompt ({len(prompt)} chars)")
            return

    # execCommand fallback
    await page.evaluate("""(text) => {
        const el = document.querySelector('[role="textbox"]')
                || document.querySelector('textarea')
                || document.querySelector('[contenteditable="true"]');
        if (!el) return;
        el.focus();
        document.execCommand('selectAll');
        document.execCommand('insertText', false, text);
    }""", prompt)
    log(f"Typed prompt via execCommand ({len(prompt)} chars)")


async def _settings_panel_open(page: Page) -> bool:
    return await page.evaluate("""() => {
        const vis = el => { const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
        return [...document.querySelectorAll('[role="radio"], [role="tab"], button')]
            .some(el => vis(el) && /(^|[a-z_])(Image|Video|วิดีโอ)$/.test((el.textContent || '').trim()));
    }""")


async def _click_by_text(page: Page, pattern: str,
                         selector: str = 'button, [role="radio"], [role="tab"], [role="option"]'):
    """Click the first visible control whose trimmed text matches `pattern`."""
    return await page.evaluate(
        """([pattern, selector]) => {
            const vis = el => { const r = el.getBoundingClientRect();
                return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
            const re = new RegExp(pattern);
            for (const el of document.querySelectorAll(selector)) {
                if (el.getAttribute('aria-label') === 'Settings trigger') continue;
                const t = (el.textContent || '').trim();
                if (re.test(t) && vis(el)) { el.click(); return t; }
            }
            return null;
        }""", [pattern, selector])


async def configure_video_settings(page: Page, aspect_ratio: str = "9:16"):
    """Settings pill -> Video -> Frames -> 9:16 -> x1 -> Veo 3.1 Lite [Lower Priority] -> 8s.

    Every label in Flow's settings panel is an icon ligature glued to its text
    ("videocamVideo", "crop_9_169:16", "x1"), so each match here is a substring or suffix
    test, never an equality test. Thai labels are kept for the older Flow UI.
    """
    log("Opening settings panel...")

    # Flow remembers whether the panel was left open. Clicking the pill then CLOSES it
    # and the next click lands on the page behind, so only click when it is shut.
    if await _settings_panel_open(page):
        log("Settings panel already open")
    else:
        opened = False
        trigger = page.locator("[aria-label='Settings trigger']").first
        if await trigger.count() and await trigger.is_visible():
            await trigger.click()
            await page.wait_for_timeout(900)
            opened = await _settings_panel_open(page)
        if not opened:
            # Older UI: the shortest bottom-bar pill carrying a multiplier or model name.
            pill = await page.evaluate("""() => {
                const vh = window.innerHeight;
                const pills = [...document.querySelectorAll('button, [role="button"]')]
                  .filter(el => { const r = el.getBoundingClientRect();
                      return r.width > 0 && r.height > 0 && r.top > vh * 0.6; })
                  .sort((a, b) => a.textContent.length - b.textContent.length);
                for (const b of pills) {
                    const t = b.textContent || '';
                    if (t.length <= 80 && (/\\dx|x\\d/.test(t) || /Nano Banana|Omni|Veo|Imagen/.test(t))) {
                        b.click();
                        return t.trim().substring(0, 60);
                    }
                }
                return null;
            }""")
            await page.wait_for_timeout(900)
            opened = await _settings_panel_open(page)
            if pill:
                log(f"Settings pill clicked: '{pill}'")
        if not opened:
            log("WARNING: settings panel did not open")

    mode = await _click_by_text(page, r"(^|[a-z_])(Video|วิดีโอ)$")
    log(f"Mode: {mode}" if mode else "WARNING: Video mode not found")
    await page.wait_for_timeout(700)

    # Frames, not Ingredients — this is what puts the Start/End frame slots in the
    # compose bar, and the scene image goes into Start. Absent on the older UI.
    if await _click_by_text(page, r"(^|[a-z_])(Frames|เฟรม)$"):
        log("Source: Frames")
        await page.wait_for_timeout(700)

    # Aspect ratio — "crop_9_169:16". Skip the pill, whose own text carries the icon too.
    icon_name = "crop_9_16" if aspect_ratio == "9:16" else "crop_16_9"
    ratio = await page.evaluate(
        """([ratio, icon]) => {
            const vis = el => { const r = el.getBoundingClientRect();
                return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
            for (const el of document.querySelectorAll("button, [role='radio'], [role='option']")) {
                if (el.getAttribute('aria-label') === 'Settings trigger') continue;
                const c = ((el.textContent || '') + ' ' + (el.getAttribute('aria-label') || '')).toLowerCase();
                if ((c.includes(ratio.toLowerCase()) || c.includes(icon)) && vis(el)) {
                    el.click();
                    return (el.textContent || '').trim();
                }
            }
            return null;
        }""", [aspect_ratio, icon_name])
    log(f"Aspect ratio: {aspect_ratio}" if ratio else f"WARNING: aspect ratio {aspect_ratio} not found")
    await page.wait_for_timeout(300)

    # One output per prompt — "x1" now, "1x" on the older UI.
    outputs = await _click_by_text(page, r"^(x1|1x)$")
    log("Set: 1 output" if outputs else "WARNING: 1-output control not found")
    await page.wait_for_timeout(300)

    # Model family. The trigger shows the CURRENT model, so its own text can contain
    # "Lite"/"Lower Priority" — open the menu, then pick from menu items only.
    model_btn = page.locator("[aria-label='Select model family']").first
    if await model_btn.count() and await model_btn.is_visible():
        await model_btn.click()
    else:
        await _click_by_text(page, r"Veo|Omni", "button")
    await page.wait_for_timeout(1200)

    model = None
    for attempt in range(3):
        if attempt:
            await page.wait_for_timeout(700)
        model = (await _click_by_text(page, r"Lower Priority", '[role="menuitem"], [role="option"], li')
                 or await _click_by_text(page, r"Lite", '[role="menuitem"], [role="option"], li'))
        if model:
            break
    log(f"Model: {model}" if model else "WARNING: Veo Lite option not found")
    await page.wait_for_timeout(400)

    # 8s duration — already the default; only click when it is not selected.
    duration = await page.evaluate("""() => {
        const vis = el => { const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
        for (const el of document.querySelectorAll('button, [role="radio"], [role="option"]')) {
            if ((el.textContent || '').trim() !== '8s' || !vis(el)) continue;
            if (el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-selected') === 'true')
                return 'already 8s';
            el.click();
            return 'set 8s';
        }
        return null;
    }""")
    if duration:
        log(f"Duration: {duration}")

    # Close settings panel
    await page.keyboard.press("Escape")
    await page.wait_for_timeout(500)
    log("Settings configured ✓")


async def click_generate(page: Page):
    """Generate video: press Enter in the compose bar, or click the → arrow button."""
    # Primary: find the BOTTOM-HALF text input and press Enter.
    # document.querySelector() finds the first match (often the top search/title bar),
    # so we must filter to only inputs in the bottom half of the screen.
    entered = await page.evaluate("""() => {
        const vh = window.innerHeight;
        const inputs = [...document.querySelectorAll(
            '[role="textbox"], textarea, [contenteditable="true"]'
        )].filter(el => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && r.top > vh * 0.5;
        });
        if (!inputs.length) return false;
        // Use the bottommost match (compose bar is the lowest text input on the page)
        inputs.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
        inputs[0].focus();
        return true;
    }""")

    if entered:
        await page.wait_for_timeout(200)
        await page.keyboard.press("Enter")
        await page.wait_for_timeout(1000)
        log("Clicked: Generate (Enter key in compose bar)")
        return

    # Fallback A: click the arrow_forward button in the compose bar (bottom half only)
    for sel in ["button:has-text('arrow_forward')", "button:has-text('สร้าง')"]:
        locs = page.locator(sel)
        n = await locs.count()
        for i in range(n - 1, -1, -1):  # iterate in reverse to get bottommost first
            loc = locs.nth(i)
            box = await loc.bounding_box()
            if box and box["y"] > 500 and await loc.is_visible() and not await loc.is_disabled():
                await loc.click()
                await page.wait_for_timeout(1000)
                log(f"Clicked: Generate via {sel} (y={box['y']:.0f})")
                return

    # Fallback B: spatial — rightmost button in the compose bar row
    result = await page.evaluate("""() => {
        const vh = window.innerHeight;
        const inputs = [...document.querySelectorAll(
            '[role="textbox"], textarea, [contenteditable="true"]'
        )].filter(el => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && r.top > vh * 0.5;
        });
        if (!inputs.length) return null;
        inputs.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
        const inputRect = inputs[0].getBoundingClientRect();

        const candidates = [...document.querySelectorAll('button, [role="button"]')]
            .filter(b => {
                const r = b.getBoundingClientRect();
                return r.width > 0 && r.height > 0
                    && r.left >= inputRect.right - 10
                    && Math.abs(r.top - inputRect.top) < 120;
            })
            .sort((a, b) => b.getBoundingClientRect().left - a.getBoundingClientRect().left);

        for (const b of candidates) {
            if (!b.disabled) {
                b.click();
                return 'spatial:' + (b.textContent || '').trim().substring(0, 20);
            }
        }
        return null;
    }""")

    if result:
        await page.wait_for_timeout(1000)
        log(f"Clicked: Generate [{result}]")
        return

    raise RuntimeError("Generate button not found — compose bar may not be focused")


async def wait_for_video_ready(
    page: Page, scene_num: int, clips_before: int = 0, timeout: int = 900
) -> bool:
    """Poll until a NEW video card (count > clips_before) appears AND its leftmost
    card has a real src.  This prevents detecting old clips from previous scenes."""
    log(f"Waiting for video generation "
        f"(scene {scene_num:02d}, clips_before={clips_before}, up to {timeout}s)...")
    start = time.time()
    while time.time() - start < timeout:
        elapsed = int(time.time() - start)

        # Detect error state
        has_error = await page.evaluate("""() => {
            const errTexts = ['error', 'failed', 'ล้มเหลว', 'ผิดพลาด', 'something went wrong'];
            const nodes = document.querySelectorAll(
                '[role="alert"], [class*="error" i], [class*="Error"]'
            );
            for (const n of nodes) {
                const t = n.textContent.toLowerCase();
                if (errTexts.some(e => t.includes(e))) return true;
            }
            return false;
        }""")
        if has_error:
            log(f"ERROR: Generation failed at {elapsed}s")
            return False

        # A new finished clip has appeared in the grid.
        if await _count_clips(page) > clips_before:
            # Let the tile settle before the download step reaches for it.
            await asyncio.sleep(4)
            if await _count_clips(page) > clips_before:
                log(f"✓ Video ready at {elapsed}s")
                return True

        if elapsed > 0 and elapsed % 30 == 0:
            log(f"  {elapsed}s: still generating...")

        await asyncio.sleep(15)

    log(f"WARNING: Timed out after {timeout}s — will refresh page and retry")
    return False


async def _count_clips(page: Page) -> int:
    """Number of finished generated clips in the project grid.

    The current Flow UI renders each clip as a thumbnail (`img[alt="Generated video
    thumbnail"]`) and only creates a `<video>` element once you open the clip, so
    counting `<video>` returned 0 forever and every generation looked like a timeout.
    The older UI did keep `<video>` in the grid — hence the max of the two.
    """
    return await page.evaluate("""() => Math.max(
        document.querySelectorAll('img[alt="Generated video thumbnail"]').length,
        document.querySelectorAll('video').length)""")


async def _newest_video_tile(page: Page) -> dict | None:
    """Centre point of the newest generated-clip tile (the grid is newest-first)."""
    return await page.evaluate("""() => {
        const vis = el => { const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
        const tiles = [...document.querySelectorAll('img[alt="Generated video thumbnail"]')].filter(vis);
        if (!tiles.length) return null;
        tiles.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
        const r = tiles[0].getBoundingClientRect();
        return { count: tiles.length, x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }""")


async def _download_via_viewer(page: Page, dest_path: Path) -> bool:
    """Current Flow UI: click the clip tile → "Download media" → "720p Original size".

    720p is the resolution the clip was generated at, so it is the only option that is
    both already rendered and free: "1080p Upscaled" re-renders it and "4K Upscaled"
    spends 50 credits, so neither is ever picked automatically. The 270p option is a GIF.
    """
    tile = await _newest_video_tile(page)
    if not tile:
        return False
    await page.mouse.click(tile["x"], tile["y"])
    await page.wait_for_timeout(4000)

    dl = page.locator("[aria-label='Download media']").first
    if not (await dl.count() and await dl.is_visible()):
        log("Download media button not found in the clip viewer")
        return False
    await dl.click()
    await page.wait_for_timeout(2000)

    try:
        async with page.expect_download(timeout=120000) as dl_info:
            picked = await page.evaluate("""() => {
                const vis = el => { const r = el.getBoundingClientRect();
                    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
                for (const want of [/Original size/i, /720p/i, /1080p/i]) {
                    for (const el of document.querySelectorAll('[role="menuitem"], [role="option"], li, button')) {
                        if (!vis(el)) continue;
                        if (el.getAttribute('aria-label') === 'Download media') continue;
                        const t = (el.textContent || '').trim();
                        if (!t || /4K|GIF/i.test(t)) continue;   // never spend credits
                        if (want.test(t)) { el.click(); return t.slice(0, 40); }
                    }
                }
                return null;
            }""")
        if not picked:
            log("No safe download resolution offered")
            return False
        download = await dl_info.value
        dest_path.parent.mkdir(parents=True, exist_ok=True)
        await download.save_as(str(dest_path))
        log(f"Downloaded via clip viewer ({picked}): {dest_path.name}")
        return True
    except Exception as e:
        log(f"Clip-viewer download failed ({type(e).__name__})")
        return False
    finally:
        # Return to the grid so the next scene starts from the same place.
        back = page.locator("[aria-label='Back button to go to previous page']").first
        if await back.count() and await back.is_visible():
            await back.click()
        else:
            await page.keyboard.press("Escape")
        await page.wait_for_timeout(1500)


async def _has_completed_video(page: Page) -> bool:
    """Return True if a generated video clip exists in the project grid."""
    return await page.evaluate("""() => {
        // Check for video elements with a real src (generated clip)
        for (const v of document.querySelectorAll('video')) {
            if (v.src && v.src.length > 10) return true;
            if (v.currentSrc && v.currentSrc.length > 10) return true;
        }
        // Fallback: small play_circle element (individual card, not container)
        for (const el of document.querySelectorAll('a, [role="button"], div[class]')) {
            const r = el.getBoundingClientRect();
            if (r.width < 80 || r.width > 400 || r.height < 80 || r.top < 50) continue;
            const txt = (el.textContent || '').trim();
            if (txt.includes('play_circle') &&
                !txt.includes('warning') &&
                !txt.includes('ล้มเหลว')) {
                return true;
            }
        }
        return false;
    }""")


async def _find_video_card(page: Page) -> dict | None:
    """Find the LEFTMOST (newest) video card — newest clip is always top-left."""
    return await page.evaluate("""() => {
        // Walk up from each <video> to its card-sized ancestor, collect all cards
        const cards = [];
        for (const v of document.querySelectorAll('video')) {
            let el = v.parentElement;
            while (el && el !== document.body) {
                const r = el.getBoundingClientRect();
                if (r.width >= 80 && r.width <= 600 && r.height >= 80 && r.top > 40) {
                    cards.push({ left: r.left, top: r.top, r });
                    break;
                }
                el = el.parentElement;
            }
        }

        if (cards.length) {
            // Find topmost row (smallest top), then pick leftmost in that row
            const minTop = Math.min(...cards.map(c => c.top));
            const topRow = cards.filter(c => c.top <= minTop + 20);
            topRow.sort((a, b) => a.left - b.left);
            const best = topRow[0].r;
            return {
                x: Math.round(best.left + best.width / 2),
                y: Math.round(best.top  + best.height / 2),
                left: Math.round(best.left),
                top:  Math.round(best.top),
                w:    Math.round(best.width),
                h:    Math.round(best.height),
            };
        }

        // Fallback: smallest element containing play_circle
        let best = null;
        let bestArea = Infinity;
        for (const el of document.querySelectorAll('a, [role="button"], div[class]')) {
            const r = el.getBoundingClientRect();
            if (r.width < 80 || r.width > 400 || r.height < 80 || r.top < 50) continue;
            const txt = (el.textContent || '').trim();
            if (txt.includes('play_circle') &&
                !txt.includes('warning') && !txt.includes('ล้มเหลว')) {
                const area = r.width * r.height;
                if (area < bestArea) {
                    bestArea = area;
                    best = {
                        x: Math.round(r.left + r.width / 2),
                        y: Math.round(r.top  + r.height / 2),
                        left: Math.round(r.left),
                        top:  Math.round(r.top),
                        w:    Math.round(r.width),
                        h:    Math.round(r.height),
                    };
                }
            }
        }
        return best;
    }""")


async def _find_dl_menu_item(page: Page):
    """Return the ดาวน์โหลด / Download menu item locator if visible, else None."""
    for sel in [
        "[role='menuitem']:has-text('ดาวน์โหลด')",
        "button:has-text('ดาวน์โหลด')",
        "li:has-text('ดาวน์โหลด')",
        "[role='menuitem']:has-text('Download')",
        "button:has-text('Download')",
        "li:has-text('Download')",
    ]:
        loc = page.locator(sel).first
        if await loc.count() and await loc.is_visible():
            return loc
    return None


async def _newest_video_url(page: Page) -> str | None:
    """Return the real (non-blob) src URL of the top-left video card, or None."""
    return await page.evaluate("""() => {
        const cards = [];
        for (const v of document.querySelectorAll('video')) {
            let el = v.parentElement;
            while (el && el !== document.body) {
                const r = el.getBoundingClientRect();
                if (r.width >= 80 && r.width <= 600 && r.height >= 80 && r.top > 40) {
                    cards.push({ left: r.left, top: r.top, v });
                    break;
                }
                el = el.parentElement;
            }
        }
        if (!cards.length) return null;
        const minTop = Math.min(...cards.map(c => c.top));
        const topRow = cards.filter(c => c.top <= minTop + 20);
        topRow.sort((a, b) => a.left - b.left);
        const v = topRow[0].v;
        const src = v.src || v.currentSrc || '';
        if (src && !src.startsWith('blob:') && src.length > 10) return src;
        for (const s of v.querySelectorAll('source')) {
            const ssrc = s.src || '';
            if (ssrc && !ssrc.startsWith('blob:') && ssrc.length > 10) return ssrc;
        }
        return null;
    }""")


async def _fetch_video_bytes(page: Page, url: str) -> bytes:
    """Fetch video bytes from a Flow URL using the browser's auth cookies."""
    b64 = await page.evaluate("""async (url) => {
        const r = await fetch(url, { credentials: 'include' });
        if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + url);
        const buf = await r.arrayBuffer();
        const bytes = new Uint8Array(buf);
        const CHUNK = 8192;
        let s = '';
        for (let i = 0; i < bytes.length; i += CHUNK) {
            s += String.fromCharCode(...bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
        }
        return btoa(s);
    }""", url)
    return base64.b64decode(b64)


async def download_video(page: Page, dest_path: Path) -> bool:
    """Save the newest clip. Returns True on success.

    Current Flow UI first (clip tile → Download media → 720p Original size); the old
    right-click-the-card path stays as the fallback, retried 3× then an in-page fetch.
    """
    dest_path.parent.mkdir(parents=True, exist_ok=True)

    # The current grid has no <video> elements at all, so the legacy path below can
    # never find a card there.
    if await _download_via_viewer(page, dest_path):
        return True

    for dl_attempt in range(3):
        if dl_attempt > 0:
            log(f"Download retry {dl_attempt + 1}/3...")

        # Prefer 1080p on the first try. If it fails — Flow's "resolution increase
        # failed" makes the 1080p download never start, so expect_download just
        # times out — fall back to 720p on later tries instead of hammering 1080p
        # again. 720p is already rendered, so it downloads immediately. This turns
        # a ~30-minute stall into ~1 extra minute.
        res_order = ["1080p", "720p"] if dl_attempt == 0 else ["720p", "1080p"]

        card_box = await _find_video_card(page)
        if not card_box:
            log("ERROR: Cannot locate any video card on the page")
            break

        log(f"Found video card at ({card_box['left']},{card_box['top']}) "
            f"size={card_box['w']}x{card_box['h']}")

        # Hover first so the card is interactive, then RIGHT-CLICK for the download menu
        await page.mouse.move(card_box["x"], card_box["y"])
        await page.wait_for_timeout(700)
        await page.mouse.click(card_box["x"], card_box["y"], button='right')
        await page.wait_for_timeout(1000)
        log("Right-clicked video card")

        dl_loc = await _find_dl_menu_item(page)

        if not dl_loc:
            # Debug: log every visible menu-like element after right-click
            menu_debug = await page.evaluate("""() => {
                const seen = new Set();
                const out = [];
                for (const el of document.querySelectorAll(
                    '[role="menuitem"],[role="menu"] *,[class*="menu" i] *,'
                    + '[class*="popup" i] *,[class*="context" i] *,li'
                )) {
                    const r = el.getBoundingClientRect();
                    if (r.width === 0 || r.height === 0) continue;
                    const txt = (el.textContent || '').trim().substring(0, 50);
                    const k = txt + '|' + Math.round(r.left) + '|' + Math.round(r.top);
                    if (seen.has(k) || !txt) continue;
                    seen.add(k);
                    out.push({tag: el.tagName, role: el.getAttribute('role') || '',
                              text: txt, x: Math.round(r.left), y: Math.round(r.top)});
                }
                return out;
            }""")
            log("=== MENU AFTER RIGHT-CLICK ===")
            for item in menu_debug:
                log(f"  [{item['tag']}/{item['role']}] ({item['x']},{item['y']}) '{item['text']}'")
            log("=== END ===")

            # Escape and try three-dot fallback
            await page.keyboard.press("Escape")
            await page.wait_for_timeout(500)

            await page.mouse.move(card_box["x"], card_box["y"])
            await page.wait_for_timeout(700)

            cl, cr = card_box["left"], card_box["left"] + card_box["w"]
            ct, cb = card_box["top"],  card_box["top"]  + card_box["h"]
            three_dot = await page.evaluate("""([cl, cr, ct, cb]) => {
                for (const b of document.querySelectorAll('button, [role="button"]')) {
                    const r = b.getBoundingClientRect();
                    if (r.width === 0 || r.height === 0) continue;
                    const bx = r.left + r.width / 2;
                    const by = r.top  + r.height / 2;
                    if (bx < cl - 60 || bx > cr + 60) continue;
                    if (by < ct || by > cb + 60) continue;
                    const txt = (b.textContent || '').trim();
                    if (txt === 'more_vert' || txt.startsWith('more_vert') || txt === '...' || txt === '⋮') {
                        b.click();
                        return txt.substring(0, 20) + ' at (' + Math.round(r.left) + ',' + Math.round(r.top) + ')';
                    }
                }
                return null;
            }""", [cl, cr, ct, cb])

            if three_dot:
                await page.wait_for_timeout(1000)
                log(f"Three-dot fallback: {three_dot}")
                dl_loc = await _find_dl_menu_item(page)

        if not dl_loc:
            all_els = await page.evaluate("""() => {
                const out = [];
                for (const el of document.querySelectorAll('[role="menuitem"],[role="option"],li,button')) {
                    const r = el.getBoundingClientRect();
                    if (r.width === 0 || r.height === 0) continue;
                    const txt = (el.textContent || '').trim();
                    if (txt) out.push({tag: el.tagName,
                        text: txt.substring(0, 40), x: Math.round(r.left), y: Math.round(r.top)});
                }
                return out;
            }""")
            log("=== ALL VISIBLE MENU ELEMENTS ===")
            for e in all_els:
                log(f"  [{e['tag']}] ({e['x']},{e['y']}) '{e['text']}'")
            log("=================================")
            log(f"ดาวน์โหลด not found (attempt {dl_attempt + 1}) — will retry")
            await page.keyboard.press("Escape")
            await page.wait_for_timeout(1000)
            continue

        # Hover ดาวน์โหลด to reveal the resolution submenu
        await dl_loc.hover()
        await page.wait_for_timeout(700)

        try:
            async with page.expect_download(timeout=90000) as dl_info:
                # Locate resolution option INSIDE the block so it is fresh, not stale
                res_loc = None
                res_label = None
                for res in res_order:
                    loc = page.locator(
                        f"[role='menuitem']:has-text('{res}'), "
                        f"button:has-text('{res}'), a:has-text('{res}')"
                    ).first
                    if await loc.count() and await loc.is_visible():
                        res_loc = loc
                        res_label = res
                        log(f"Resolution option found: {res}")
                        break
                if res_loc:
                    await res_loc.click()
                    log(f"Clicked resolution: {res_label}")
                else:
                    # Submenu may have closed — re-hover to reopen it, then try again
                    await dl_loc.hover()
                    await page.wait_for_timeout(500)
                    for res in res_order:
                        loc = page.locator(
                            f"[role='menuitem']:has-text('{res}'), "
                            f"button:has-text('{res}'), a:has-text('{res}')"
                        ).first
                        if await loc.count() and await loc.is_visible():
                            await loc.click()
                            log(f"Clicked resolution after re-hover: {res}")
                            res_loc = loc
                            break
                    if not res_loc:
                        await dl_loc.click()
                        log("Clicked: ดาวน์โหลด (no resolution submenu after re-hover)")

            dl = await dl_info.value
            await dl.save_as(str(dest_path))
            size_kb = dest_path.stat().st_size // 1024
            if size_kb == 0:
                log(f"Downloaded file is empty (attempt {dl_attempt + 1}) — retrying")
                dest_path.unlink(missing_ok=True)
                continue
            log(f"✓ Downloaded: {dest_path.name} ({size_kb} KB)")
            return True

        except PwTimeout:
            log(f"Download timed out after 180s (attempt {dl_attempt + 1})")
            await page.keyboard.press("Escape")
            await page.wait_for_timeout(500)
        except Exception as e:
            log(f"Download failed: {e} (attempt {dl_attempt + 1})")
            await page.keyboard.press("Escape")
            await page.wait_for_timeout(500)

    # ── Fetch fallback ─────────────────────────────────────────────────────────
    log("All menu download attempts failed — trying in-page fetch fallback...")
    video_url = await _newest_video_url(page)
    if video_url:
        log(f"Fetching video from: {video_url[:80]}...")
        try:
            video_bytes = await _fetch_video_bytes(page, video_url)
            if video_bytes and len(video_bytes) > 10240:
                dest_path.write_bytes(video_bytes)
                size_kb = len(video_bytes) // 1024
                log(f"✓ Downloaded via fetch fallback: {dest_path.name} ({size_kb} KB)")
                return True
            else:
                log(f"Fetch fallback returned {len(video_bytes) if video_bytes else 0} bytes — too small, ignoring")
        except Exception as e:
            log(f"Fetch fallback failed: {e}")
    else:
        log("No video URL available for fetch fallback")

    log("ERROR: All download methods failed")
    return False


# ── Process one scene ─────────────────────────────────────────────────────────

async def process_scene(
    page: Page,
    context: BrowserContext,
    project: dict,
    scene: dict,
    working_dir: Path,
    skip_generate: bool = False,
) -> str:
    """Upload → generate → wait → download, within the CURRENT project page.
    Returns 'success', 'generate_failed', 'download_failed', or 'error'."""
    pid = project["id"]
    sn = scene["scene_num"]
    nn = str(sn).zfill(2)

    scene_img = working_dir / f"{pid}-scene-{nn}.png"
    if not scene_img.exists():
        log(f"ERROR: Scene image not found: {scene_img}")
        return "error"

    dest = working_dir / f"{pid}-scene-{nn}-vdo.mp4"
    log(f"\n--- Scene {nn} / {project['total_scenes']} ---")

    try:
        if skip_generate:
            log(f"Scene {nn}: skipping generation — retrying download of existing clip")
            has_video = await _has_completed_video(page)
            if not has_video:
                log(f"Scene {nn}: no video card found on page — need to regenerate")
                _update_scene(pid, sn, video_status="error")
                return "generate_failed"
        else:
            await upload_scene_image(page, scene_img)
            clean_vprompt = _cut_at_end_marker(scene["video_prompt"].strip(), "VIDEO")
            await fill_video_prompt(page, clean_vprompt + "\n\n--- The End of VIDEO PROMPTS ---")
            await page.wait_for_timeout(500)

            clips_before = await _count_clips(page)
            log(f"Clips in project before generate: {clips_before}")
            await click_generate(page)

            ready = await wait_for_video_ready(page, sn, clips_before=clips_before, timeout=180)
            if not ready:
                log(f"Scene {nn}: generation failed or timed out")
                _update_scene(pid, sn, video_status="error")
                return "generate_failed"

        success = await download_video(page, dest)
        if not success:
            _update_scene(pid, sn, video_status="error")
            return "download_failed"

        _update_scene(pid, sn, video_status="done")
        log(f"✓ Scene {nn} complete -> {dest.name}")
        return "success"

    except Exception as e:
        log(f"ERROR processing scene {nn}: {e}")
        _update_scene(pid, sn, video_status="error")
        return "error"


# ── Main ──────────────────────────────────────────────────────────────────────

MAX_RETRIES = 5


async def run(project: dict):
    pid = project["id"]
    page_name = project.get("page") or "unknown"
    working_dir = BASE_DIR / "pages" / page_name / "working"
    working_dir.mkdir(parents=True, exist_ok=True)

    # Primary: include any scene whose -vdo.mp4 file is missing from disk.
    # This correctly catches scenes where video_status="done" but the file
    # was never saved (e.g., from an old buggy run with wrong filenames).
    ready_dir = BASE_DIR / "pages" / page_name / "ready" / pid

    def _vdo_missing(s) -> bool:
        nn = str(s["scene_num"]).zfill(2)
        in_working = (working_dir / f"{pid}-scene-{nn}-vdo.mp4").exists()
        in_ready   = (ready_dir   / f"scene-{nn}.mp4").exists()
        return not (in_working or in_ready)

    pending = [
        s for s in project["scenes"]
        if s["image_status"] == "done" and _vdo_missing(s)
    ]

    if not pending:
        log(f"No scenes pending video generation for {pid}")
        log(f"  (All -vdo.mp4 files already exist in pages/{page_name}/working/)")
        return

    log(f"\n{'='*50}")
    log(f"VIDEO PHASE  [{pid}]  —  {len(pending)} scene(s) to process")
    log(f"{'='*50}")

    pw, context = await connect_chrome()
    page = await ensure_logged_in_flow(context)
    _update_project(pid, project_status="videos_in_progress")

    try:
        # Open ONE project for all scenes — settings only configured once
        await page.goto(FLOW_URL, wait_until="domcontentloaded")
        await page.wait_for_timeout(2500)
        await click_new_project(page)
        await wait_for_compose_bar(page, timeout=20000)

        # Configure automatically first; the manual window below is now a chance to
        # correct it, not the only way it gets set.
        try:
            await configure_video_settings(page, project.get("aspect_ratio", "9:16"))
        except Exception as e:
            log(f"Auto-configure failed ({type(e).__name__}: {e}) — set it by hand below")

        log("=" * 50)
        log("[CHECK] Settings should now read:")
        log("  Video → Frames → 9:16 → x1 → Veo 3.1 Lite [Lower Priority] → 8s")
        log("[WAITING 20s] Fix them by hand if not; bot resumes automatically...")
        log("=" * 50)
        for countdown in range(20, 0, -10):
            log(f"  ...{countdown}s remaining")
            await asyncio.sleep(10)
        log("Resuming — all scenes will be generated in this project.")

        done_count = 0
        for i, scene in enumerate(pending):
            sn = str(scene["scene_num"]).zfill(2)

            skip_gen = False
            result = "error"
            for attempt in range(1, MAX_RETRIES + 1):
                result = await process_scene(
                    page, context, project, scene, working_dir,
                    skip_generate=skip_gen,
                )
                if result == "success":
                    break
                if attempt < MAX_RETRIES:
                    if result == "download_failed":
                        skip_gen = True
                        log(f"Scene {sn}: download failed (attempt {attempt}) — "
                            f"retrying download only ({attempt+1}/{MAX_RETRIES})...")
                    else:
                        skip_gen = False
                        log(f"Scene {sn}: attempt {attempt} failed — "
                            f"refreshing page and retrying ({attempt+1}/{MAX_RETRIES})...")
                    await page.reload(wait_until="domcontentloaded")
                    await page.wait_for_timeout(4000)
                    log("Page refreshed — continuing in same project")

            if result == "success":
                done_count += 1

            # Brief pause so the page settles before the next scene's upload
            if i < len(pending) - 1:
                log("Pausing 5s before next scene...")
                await asyncio.sleep(5)

        # Final project status
        if _check_all_videos_done(pid):
            _update_project(pid, project_status="complete")
            log(f"\n{'='*50}")
            log(f"PROJECT COMPLETE  [{pid}]")
            log(f"   Videos saved to: pages/{page_name}/working/")
            log(f"{'='*50}")
            notify(f"🎬 Videos complete: {pid} ({page_name}) — all {len(pending)} scene(s)")
        else:
            error_count = len(pending) - done_count
            _update_project(pid, project_status="videos_partial")
            log(f"\n{'='*50}")
            log(f"VIDEO PHASE DONE  [{pid}]")
            log(f"  Successful : {done_count}/{len(pending)}")
            if error_count:
                log(f"  Errors     : {error_count}  (re-run to retry)")
            log(f"{'='*50}")
            notify(f"⚠️ Videos partial: {pid} ({page_name}) — "
                   f"{done_count}/{len(pending)} ok, {error_count} failed (re-run to retry)")

    except Exception as e:
        notify_error(f"video_phase {pid} ({page_name})", e)
        raise
    finally:
        await context.close()
        await pw.stop()
