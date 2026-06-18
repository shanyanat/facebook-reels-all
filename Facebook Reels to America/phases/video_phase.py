"""
phases/video_phase.py
Playwright automation for Google Flow video generation.

For each pending scene (image_status=done, video_status=pending):
  - Navigate to labs.google/fx/th/tools/flow → New project
  - Upload scene image → paste video prompt → configure settings
  - Generate → wait → download 1080p video
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
FLOW_URL = "https://labs.google/fx/th/tools/flow"

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
    """Click the '+ โปรเจกต์ใหม่' button on the Flow home page."""
    candidates = [
        "button:has-text('โปรเจกต์ใหม่')",
        "button:has-text('โปรเจ็กต์ใหม่')",
        "button:has-text('New project')",
        "button:has-text('New Project')",
        "[role='button']:has-text('โปรเจกต์ใหม่')",
        "[role='button']:has-text('New project')",
        "a:has-text('New project')",
    ]
    for sel in candidates:
        loc = page.locator(sel).first
        if await loc.count() and await loc.is_visible():
            await loc.click()
            await page.wait_for_timeout(2500)
            log("Clicked: New project / โปรเจกต์ใหม่")
            return

    # Broad text search fallback
    btns = page.locator("button, [role='button'], a")
    n = await btns.count()
    for i in range(n):
        b = btns.nth(i)
        txt = (await b.text_content() or "").strip()
        if "โปรเจ" in txt or txt in ("New project", "New Project"):
            await b.click()
            await page.wait_for_timeout(2500)
            log(f"Clicked: '{txt}'")
            return

    raise RuntimeError("'New project' button not found on Google Flow home")


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


async def _try_first_frame_upload(page: Page, image_path: Path) -> bool:
    """
    Full video-mode upload flow:
      1. Click เริ่ม (Start frame slot) → media browser opens
      2. Upload image via อัปโหลดสื่อ button or hidden file input
      3. Click เพิ่มไปยังพรอมต์ to attach the image to the frame
    """
    log("Trying Start frame slot upload...")

    # Step 1: Click เริ่ม to open the media browser
    clicked = await page.evaluate("""() => {
        // Exact-text match for เริ่ม/Start (avoid timestamps or project cards)
        for (const el of document.querySelectorAll(
            'button, [role="button"], div[class], span[class]'
        )) {
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            if (r.top < 400 || r.top > 700) continue;
            const txt = (el.textContent || '').trim();
            if (txt === 'เริ่ม' || txt === 'Start' || txt === 'เริ่มต้น') {
                el.click();
                return txt + ' at (' + Math.round(r.left) + ',' + Math.round(r.top) + ')';
            }
        }
        // Spatial fallback: left of swap_horiz button
        const swapBtn = [...document.querySelectorAll('button')]
            .find(b => (b.textContent||'').includes('swap_horiz'));
        if (!swapBtn) return null;
        const sr = swapBtn.getBoundingClientRect();
        for (const xOff of [100, 70, 140, 50]) {
            const x = sr.left - xOff;
            const y = sr.top + sr.height / 2;
            if (x < 50) continue;
            const el = document.elementFromPoint(x, y);
            if (!el || el === swapBtn || el === document.body) continue;
            if (el.getBoundingClientRect().left < 50) continue;
            el.click();
            return 'spatial xOff=' + xOff + ' at (' + Math.round(x) + ',' + Math.round(y) + ')';
        }
        return null;
    }""")

    if not clicked:
        log("เริ่ม (Start frame slot) not found")
        return False

    log(f"Clicked Start frame: {clicked}")
    await page.wait_for_timeout(1500)  # wait for media browser panel to open

    # Step 2: Upload image — try อัปโหลดสื่อ button (opens file chooser) first
    upload_done = False
    for sel in [
        "button:has-text('อัปโหลดสื่อ')",
        "a:has-text('อัปโหลดสื่อ')",
        "[role='button']:has-text('อัปโหลดสื่อ')",
        "button:has-text('Upload media')",
        "button:has-text('Upload')",
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
                upload_done = True
                break
            except PwTimeout:
                log(f"File chooser timed out for '{sel}'")

    if not upload_done:
        # Fallback: hidden <input type="file"> inside the media browser panel
        fi = page.locator("input[type='file']").last
        if await fi.count():
            await fi.set_input_files(str(image_path))
            await page.wait_for_timeout(3000)
            log(f"Uploaded via hidden file input: {image_path.name}")
            upload_done = True

    if not upload_done:
        log("Image upload failed — no upload button or file input found")
        await page.keyboard.press("Escape")
        return False

    # Step 3: Click เพิ่มไปยังพรอมต์ to attach the uploaded image to the frame
    log("Waiting for เพิ่มไปยังพรอมต์ button...")
    for attempt in range(4):
        await page.wait_for_timeout(1000 + attempt * 500)
        for sel in [
            "button:has-text('เพิ่มไปยังพรอมต์')",
            "[role='button']:has-text('เพิ่มไปยังพรอมต์')",
            "button:has-text('Add to prompt')",
        ]:
            loc = page.locator(sel).first
            if await loc.count() and await loc.is_visible():
                await loc.click()
                await page.wait_for_timeout(1000)
                log("Clicked: เพิ่มไปยังพรอมต์ ✓")
                return True

    log("WARNING: เพิ่มไปยังพรอมต์ not found after upload")
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


async def configure_video_settings(page: Page, aspect_ratio: str = "9:16"):
    """Click the model settings pill → วิดีโอ tab → 9:16 / 1x / Veo Lite / 8s."""
    log("Opening settings panel (clicking model pill)...")
    await page.wait_for_timeout(500)

    # Step 1: Click the pill — find the SHORTEST button in the compose bar that contains
    # a multiplier (e.g. "2x", "1x"). The pill text is short like "🍌 Nano Banana 2crop_16_9x2"
    # but parent containers are longer. We pick shortest to avoid clicking a container.
    pill_text = await page.evaluate("""() => {
        const vh = window.innerHeight;
        let best = null;
        let bestLen = Infinity;
        for (const el of document.querySelectorAll('button, [role="button"]')) {
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            if (r.top < vh * 0.6) continue;
            const txt = (el.textContent || '').trim();
            if (/\\d+x/.test(txt) && txt.length < bestLen && txt.length <= 80) {
                best = el;
                bestLen = txt.length;
            }
        }
        if (best) {
            best.click();
            return (best.textContent || '').trim().substring(0, 60);
        }
        // Fallback: any element containing 'Nano Banana' or 'Imagen'
        for (const el of document.querySelectorAll('button, [role="button"]')) {
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            if (r.top < vh * 0.6) continue;
            const txt = (el.textContent || '').trim();
            if (txt.includes('Nano Banana') || txt.includes('Imagen') || txt.includes('Lumiere')) {
                el.click();
                return txt.substring(0, 60);
            }
        }
        return null;
    }""")

    if pill_text:
        await page.wait_for_timeout(800)
        log(f"Settings pill clicked: '{pill_text}'")
    else:
        log("WARNING: Settings pill not found")

    # Step 2: Click วิดีโอ tab
    for sel in ["button:has-text('วิดีโอ')", "[role='tab']:has-text('วิดีโอ')", "button:has-text('Video')"]:
        loc = page.locator(sel).first
        if await loc.count() and await loc.is_visible():
            await loc.click()
            await page.wait_for_timeout(600)
            log("Selected: วิดีโอ mode ✓")
            break

    await page.wait_for_timeout(400)

    # Step 3: Aspect ratio — use JS click to bypass overlay
    ratio_set = False
    icon_name = "crop_9_16" if aspect_ratio == "9:16" else "crop_16_9"
    for sel in [
        f"button:has-text('{aspect_ratio}')",
        f"button:has-text('{icon_name}')",
        f"[aria-label*='{aspect_ratio}']",
        f"[role='option']:has-text('{aspect_ratio}')",
    ]:
        loc = page.locator(sel).first
        if await loc.count() and await loc.is_visible():
            await loc.evaluate("el => el.click()")
            await page.wait_for_timeout(300)
            log(f"Set aspect ratio: {aspect_ratio}")
            ratio_set = True
            break
    if not ratio_set:
        log(f"WARNING: Aspect ratio {aspect_ratio} button not found")

    # Step 4: 1x multiplier — use JS click to bypass overlay
    for sel in ["button:has-text('1x')", "[role='option']:has-text('1x')"]:
        loc = page.locator(sel).first
        if await loc.count() and await loc.is_visible():
            await loc.evaluate("el => el.click()")
            await page.wait_for_timeout(300)
            log("Set: 1x")
            break

    # Step 5: Veo 3.1 - Lite [Lower Priority]
    # The Veo button shows current model + dropdown arrow. Click it to open the list,
    # then select the Lite option.
    for veo_sel in ["button:has-text('Veo 3.1')", "button:has-text('Veo 3')", "button:has-text('Veo')"]:
        veo_loc = page.locator(veo_sel).first
        if await veo_loc.count() and await veo_loc.is_visible():
            await veo_loc.click()
            await page.wait_for_timeout(600)
            log("Opened Veo model dropdown")
            break

    lite_set = False
    for lite_sel in [
        "[role='option']:has-text('Lite')",
        "[role='option']:has-text('Lower Priority')",
        "li:has-text('Lite')",
        "button:has-text('Lite')",
        "[role='listbox'] *:has-text('Lite')",
    ]:
        lite_loc = page.locator(lite_sel).first
        if await lite_loc.count() and await lite_loc.is_visible():
            await lite_loc.click()
            await page.wait_for_timeout(300)
            log("Set model: Veo 3.1 - Lite [Lower Priority] ✓")
            lite_set = True
            break
    if not lite_set:
        log("WARNING: 'Lite' model option not found — keeping current model")

    # Step 6: 8s duration — skip if already active (it's the default)
    for sel in ["button:has-text('8s')", "[role='option']:has-text('8s')"]:
        loc = page.locator(sel).first
        if await loc.count() and await loc.is_visible():
            state = await loc.get_attribute("data-state")
            aria_sel = await loc.get_attribute("aria-selected")
            if state == "active" or aria_sel == "true":
                log("Duration 8s: already active ✓")
            else:
                await loc.evaluate("el => el.click()")
                await page.wait_for_timeout(300)
                log("Set duration: 8s")
            break

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

        # New clip ready: count increased AND leftmost card's video has a real src
        ready = await page.evaluate("""([n]) => {
            const videos = [...document.querySelectorAll('video')];
            if (videos.length <= n) return false;

            // Walk up from each video to its card container, collect all cards
            const cards = [];
            for (const v of videos) {
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
            if (!cards.length) return false;

            // Find topmost row then pick leftmost (newest clip = top-left)
            const minTop = Math.min(...cards.map(c => c.top));
            const topRow = cards.filter(c => c.top <= minTop + 20);
            topRow.sort((a, b) => a.left - b.left);
            const newest = topRow[0].v;

            if (newest.src && !newest.src.startsWith('blob:') && newest.src.length > 10)
                return true;
            if (newest.currentSrc && !newest.currentSrc.startsWith('blob:')
                    && newest.currentSrc.length > 10)
                return true;
            return false;
        }""", [clips_before])

        if ready:
            log(f"✓ Video ready at {elapsed}s")
            return True

        if elapsed > 0 and elapsed % 30 == 0:
            log(f"  {elapsed}s: still generating...")

        await asyncio.sleep(15)

    log(f"WARNING: Timed out after {timeout}s — will refresh page and retry")
    return False


async def _count_clips(page: Page) -> int:
    """Return the current number of video elements on the page."""
    return await page.evaluate("() => document.querySelectorAll('video').length")


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
    """Right-click video card → ดาวน์โหลด → 1080p/720p. Returns True on success.
    Retries the menu download up to 3 times, then falls back to in-page fetch."""
    dest_path.parent.mkdir(parents=True, exist_ok=True)

    for dl_attempt in range(3):
        if dl_attempt > 0:
            log(f"Download retry {dl_attempt + 1}/3...")

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
            async with page.expect_download(timeout=180000) as dl_info:
                # Locate resolution option INSIDE the block so it is fresh, not stale
                res_loc = None
                res_label = None
                for res in ["1080p", "720p"]:
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
                    for res in ["1080p", "720p"]:
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

        log("=" * 50)
        log("[ACTION REQUIRED] Configure settings NOW:")
        log("  Video → Frame → 9:16 → 1x → Veo Lite → 8s")
        log("[WAITING 20s] Bot resumes automatically...")
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
