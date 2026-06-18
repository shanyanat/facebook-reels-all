"""
phases/image_phase.py
Playwright automation for ChatGPT image generation.

Phase A: Storyboard  (1 image, Thinking: Extended)
Phase B: Scene images (N images, Thinking: Standard)

Follows ขั้นตอนการทำแบบ Manual.txt — steps 2.b.ii and 2.b.iii exactly.
Launches Chrome automatically with a saved profile (no manual chrome.exe needed).
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

sys.path.insert(0, str(BASE_DIR))
from parse_analysis import load_contents, save_contents, detect_aspect_ratio
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


def log(msg: str):
    print(f"[image-bot] {msg}", flush=True)


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
    # No marker found — still strip a trailing separator line if present
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
    print("[ERROR] Google Chrome not found. Please install Chrome from https://www.google.com/chrome/")
    sys.exit(1)


async def connect_chrome():
    """Launch Chrome with a persistent profile. Logins are saved between runs."""
    pw = await async_playwright().start()
    CHROME_PROFILE.mkdir(parents=True, exist_ok=True)
    chrome_exe = _find_chrome()
    log(f"Launching Chrome (profile: {CHROME_PROFILE})")
    context = await pw.chromium.launch_persistent_context(
        user_data_dir=str(CHROME_PROFILE),
        executable_path=chrome_exe,
        headless=False,
        # Stealth flags — prevent Cloudflare / ChatGPT from detecting Playwright
        args=[
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-blink-features=AutomationControlled",
            "--disable-infobars",
            "--start-maximized",
        ],
        # Strip the --enable-automation flag Playwright normally injects
        ignore_default_args=["--enable-automation"],
    )
    # Remove navigator.webdriver so JS fingerprinting sees a normal browser
    await context.add_init_script(
        "Object.defineProperty(navigator,'webdriver',{get:()=>undefined})"
    )
    log("Chrome launched")
    return pw, context


async def ensure_logged_in_chatgpt(context: BrowserContext) -> Page:
    """Open a fresh ChatGPT chat and verify login. Handles Cloudflare & modals."""
    page = await context.new_page()
    log("Navigating to chatgpt.com ...")
    try:
        await page.goto("https://chatgpt.com/", wait_until="domcontentloaded", timeout=30000)
    except Exception as e:
        log(f"Navigation notice: {e}")

    # ── Wait for Cloudflare "Just a moment..." to clear ──────────────────────
    # Cloudflare shows this title while its JS challenge runs.
    # With stealth flags it should clear in <5 s; allow up to 30 s.
    cf_waited = 0
    while cf_waited < 30:
        title = await page.title()
        if "just a moment" not in title.lower():
            break
        if cf_waited == 0:
            log("Cloudflare check running — waiting for it to pass ...")
        await page.wait_for_timeout(2000)
        cf_waited += 2
    else:
        log("WARNING: Cloudflare check did not clear in 30 s. "
            "Stealth flags may not be working — see Chrome window.")

    await page.wait_for_timeout(2000)

    url = page.url
    title = await page.title()
    log(f"URL  : {url}")
    log(f"Title: {title}")

    # ── Detect logged-out state by page text (URL alone is not enough) ──────
    # The real compose input is a DIV with role=textbox — put it first so
    # Playwright doesn't latch onto the always-hidden fallback <textarea>.
    COMPOSE = (
        'div[role="textbox"], '
        '[contenteditable="true"][data-lexical-editor], '
        '#prompt-textarea'
    )

    try:
        body_text = await page.evaluate("() => document.body?.innerText || ''")
    except Exception:
        body_text = ""

    url_is_login = any(x in url for x in ("login", "auth", "signin", "accounts.google"))
    page_is_loggedout = (
        "log in" in body_text.lower() and
        ("sign up" in body_text.lower() or "create account" in body_text.lower())
    )

    if url_is_login or page_is_loggedout:
        print("\n" + "="*60)
        print("  NOT LOGGED INTO ChatGPT")
        print()
        print("  → Look at the Chrome window that just opened.")
        print("  → Log into ChatGPT there (use your normal account).")
        print("  → The bot will continue automatically after you log in.")
        print("  → You have 5 minutes.")
        print("="*60)
        try:
            await page.wait_for_selector(COMPOSE, state="visible", timeout=300000)
            log("Login detected — continuing ...")
            await page.wait_for_timeout(2000)
        except PwTimeout:
            log("ERROR: Timed out waiting for login (5 min). Re-run after logging in.")
            sys.exit(1)
        return page

    # Already logged in — dismiss any welcome / upgrade modal
    for dismiss_sel in [
        "button[aria-label='Close']",
        "button:has-text('OK')",
        "button:has-text('Got it')",
        "button:has-text('Dismiss')",
        "button:has-text('Close')",
        "button:has-text('Continue')",
        "button:has-text('Maybe later')",
        "button:has-text('No thanks')",
        "button:has-text('Stay on free plan')",
        "[role='dialog'] button",
    ]:
        try:
            btn = page.locator(dismiss_sel).first
            if await btn.count() and await btn.is_visible():
                await btn.click()
                await page.wait_for_timeout(500)
                log(f"Dismissed dialog: {dismiss_sel}")
        except Exception:
            pass
    await page.keyboard.press("Escape")
    await page.wait_for_timeout(400)

    # Wait for compose input
    found = False
    for attempt in range(3):
        try:
            await page.wait_for_selector(COMPOSE, state="visible", timeout=15000)
            found = True
            log("Compose input ready ✓")
            break
        except PwTimeout:
            log(f"Compose input not visible yet (attempt {attempt+1}/3) ...")
            await page.wait_for_timeout(3000)

    if not found:
        try:
            snippet = await page.evaluate(
                "() => (document.body?.innerText || '').slice(0, 800)"
            )
            log(f"=== PAGE TEXT ===\n{snippet}\n=== END ===")
        except Exception:
            pass
        log("ERROR: Compose area did not appear. Check the Chrome window.")

    await _click_new_chat(page)
    log("ChatGPT: logged in ✓")
    return page


# ── ChatGPT UI helpers ────────────────────────────────────────────────────────

async def open_new_chat(context: BrowserContext) -> Page:
    page = await context.new_page()
    await page.goto("https://chatgpt.com/", wait_until="domcontentloaded")
    await page.wait_for_timeout(2500)
    await _click_new_chat(page)
    log("Opened new ChatGPT tab")
    return page


async def _click_new_chat(page: Page):
    """Click the 'New chat' button to ensure we start a fresh conversation, not an existing project."""
    new_chat_selectors = [
        "button[aria-label='New chat']",
        "a[aria-label='New chat']",
        "[data-testid='create-new-chat-button']",
        "button:has-text('New chat')",
        "a:has-text('New chat')",
    ]
    for sel in new_chat_selectors:
        try:
            btn = page.locator(sel).first
            if await btn.count() and await btn.is_visible():
                await btn.click()
                await page.wait_for_timeout(1500)
                log("Clicked 'New chat' to start fresh")
                return
        except Exception:
            pass
    # Fallback: navigate directly to the root which opens a new chat on most accounts
    current_url = page.url
    if "/c/" in current_url or "/g/" in current_url or "project" in current_url.lower():
        await page.goto("https://chatgpt.com/", wait_until="domcontentloaded")
        await page.wait_for_timeout(2000)
        log("Navigated to root to escape existing conversation/project")


async def _dump_buttons(page: Page):
    """Print all visible interactive elements + page text for debugging."""
    # Page text (what the user can visually read)
    try:
        body_text = await page.evaluate(
            "() => (document.body?.innerText || '').slice(0, 600)"
        )
        log(f"=== PAGE TEXT ===\n{body_text}\n=== END PAGE TEXT ===")
    except Exception:
        pass

    # All interactive elements
    try:
        info = await page.evaluate("""() => {
            return [...document.querySelectorAll(
                'button, [role="button"], [role="tab"], [role="menuitem"], li, input, textarea, [contenteditable]'
            )]
                .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
                .map(el => ({
                    tag:    el.tagName,
                    text:   (el.textContent || '').trim().replace(/\\s+/g,' ').slice(0, 45),
                    aria:   el.getAttribute('aria-label') || '',
                    testid: el.getAttribute('data-testid') || '',
                    title:  el.getAttribute('title') || '',
                    role:   el.getAttribute('role') || '',
                    type:   el.getAttribute('type') || '',
                }))
                .filter(b => b.aria || b.testid || b.title || b.text.length > 0);
        }""")
        log(f"=== ELEMENT DUMP ({len(info)} elements) ===")
        for b in info:
            parts = [f"<{b['tag']}>"]
            if b['testid']: parts.append(f"testid={b['testid']}")
            if b['aria']:   parts.append(f"aria={b['aria']}")
            if b['title']:  parts.append(f"title={b['title']}")
            if b['role']:   parts.append(f"role={b['role']}")
            if b['text']:   parts.append(f"text={b['text']}")
            log("  " + " | ".join(parts))
        log("=== END DUMP ===")
    except Exception as e:
        log(f"Dump failed: {e}")


async def activate_image_mode(page: Page):
    """Click the 'Create an image' button in the ChatGPT toolbar."""
    try:
        await page.wait_for_selector(
            'div[role="textbox"], [contenteditable="true"][data-lexical-editor]',
            timeout=20000,
        )
    except Exception as e:
        if "TargetClosedError" in type(e).__name__ or "closed" in str(e).lower():
            raise RuntimeError(
                "Chrome tab was closed while waiting. "
                "Do not close tabs while the bot is running."
            ) from e
        log("WARNING: Compose input still not found — attempting anyway")
    await page.wait_for_timeout(1500)

    # ── Strategy 1: exact accessible-name match ──────────────────────────────
    for name in ["Create an image", "Create image"]:
        try:
            btn = page.get_by_role("button", name=name, exact=True)
            if await btn.count() and await btn.first.is_visible():
                await btn.first.click()
                await page.wait_for_timeout(800)
                log(f"Image mode activated: '{name}'")
                return
        except Exception:
            pass

    # ── Strategy 2: scope to <main> ──────────────────────────────────────────
    for text in ["Create an image", "Create image", "DALL·E"]:
        try:
            btn = page.locator("main").locator(f"button:has-text('{text}')").first
            if await btn.count() and await btn.is_visible():
                await btn.click()
                await page.wait_for_timeout(800)
                log(f"Image mode activated (main): '{text}'")
                return
        except Exception:
            pass

    # ── Strategy 3: aria-label / data-testid ─────────────────────────────────
    for sel in [
        "button[aria-label*='Create an image' i]",
        "button[aria-label*='Create image' i]",
        "button[aria-label*='dall' i]",
        "button[data-testid*='dalle' i]",
        "button[data-testid*='image-gen' i]",
    ]:
        try:
            loc = page.locator(sel).first
            if await loc.count() and await loc.is_visible():
                await loc.click()
                await page.wait_for_timeout(800)
                log(f"Image mode activated via attr: {sel}")
                return
        except Exception:
            pass

    # ── Strategy 4: click "+" → find "Create image" in popup ─────────────────
    # "Create image" / "Deep research" / "Web search" are plain divs with NO
    # role="menuitem" (only file/nav items have that role).  Clicking the inner
    # text span (h≈20 px) doesn't reliably fire the parent click handler, so we
    # use JS TreeWalker: find exact text node → walk UP to the clickable row.
    try:
        plus = page.locator("[data-testid='composer-plus-btn']").first
        if await plus.count() and await plus.is_visible():
            await plus.click()
            await page.wait_for_timeout(1200)

            # Dump while menu is OPEN so the element structure is visible
            log("=== MENU OPEN — elements visible now ===")
            await _dump_buttons(page)

            # 4a: JS TreeWalker — find the EXACT text node "Create image",
            # then walk UP the DOM to the actual clickable row (h 28–80 px).
            # Clicking the inner text span (h≈20 px) doesn't fire the parent
            # click handler; we need the menu row element itself.
            clicked_4a = await page.evaluate("""() => {
                const targets = ['Create image', 'Create an image'];
                const walker = document.createTreeWalker(
                    document.body, NodeFilter.SHOW_TEXT,
                    { acceptNode: n => targets.includes(n.textContent.trim())
                        ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP }
                );
                let textNode;
                while ((textNode = walker.nextNode())) {
                    let el = textNode.parentElement;
                    while (el && el !== document.body) {
                        const r = el.getBoundingClientRect();
                        if (r.height >= 28 && r.height < 80 && r.width > 50) {
                            el.click();
                            return textNode.textContent.trim() +
                                   ' [h=' + Math.round(r.height) + ']';
                        }
                        if (r.height >= 80) break;
                        el = el.parentElement;
                    }
                }
                return null;
            }""")
            if clicked_4a:
                await page.wait_for_timeout(800)
                log(f"Image mode activated via TreeWalker: '{clicked_4a}'")
                return

            # 4b: Playwright role match (menuitem / option / button)
            for menu_name in ["Create image", "Create an image"]:
                for role in ["menuitem", "option", "button"]:
                    try:
                        item = page.get_by_role(role, name=menu_name, exact=True)
                        if await item.count() and await item.first.is_visible():
                            await item.first.click()
                            await page.wait_for_timeout(800)
                            log(f"Image mode activated via role/{role}: '{menu_name}'")
                            return
                    except Exception:
                        pass

            # 4c: Playwright selector scan with height guard
            for item_sel in [
                "[role='menu'] *", "[role='listbox'] *",
                "[role='menuitem']", "[role='option']", "[role='listitem']",
            ]:
                try:
                    items = page.locator(item_sel)
                    k = await items.count()
                    for j in range(k):
                        item = items.nth(j)
                        txt = (await item.text_content() or "").strip().lower()
                        if "image" in txt and "create" in txt and await item.is_visible():
                            box = await item.bounding_box()
                            if box and box["height"] < 70:
                                await item.click()
                                await page.wait_for_timeout(800)
                                log(f"Image mode activated (4c): '{txt[:40]}'")
                                return
                except Exception:
                    continue

            # 4d: JS scan — interactive elements only (NO generic div),
            # with height guard so we never click a container by accident.
            clicked = await page.evaluate("""() => {
                const popupSels = [
                    '[data-radix-popper-content-wrapper]',
                    '[data-radix-dropdown-menu-content]',
                    '[role="menu"]',
                    '[role="listbox"]',
                    '[data-floating-ui-portal]',
                ];
                let containers = [];
                for (const sel of popupSels) {
                    document.querySelectorAll(sel).forEach(el => {
                        const r = el.getBoundingClientRect();
                        if (r.width > 0 && r.height > 0) containers.push(el);
                    });
                }
                const roots = containers.length ? containers : [document.body];

                for (const root of roots) {
                    // Intentionally NO 'div' here: clicking a container div fires
                    // at its visual center, which may land on a different item.
                    const items = root.querySelectorAll(
                        'button, [role="menuitem"], [role="option"], [role="button"], li, a'
                    );
                    for (const el of items) {
                        const r = el.getBoundingClientRect();
                        // height > 70 → container, not a menu row
                        if (r.width === 0 || r.height === 0 || r.height > 70) continue;
                        const txt = (el.textContent || '').trim();
                        const aria = (el.getAttribute('aria-label') || '');
                        const combined = (txt + ' ' + aria).toLowerCase();
                        const testid = el.getAttribute('data-testid') || '';
                        if (txt.length < 80 &&
                            combined.includes('create') &&
                            combined.includes('image') &&
                            !testid.includes('history') &&
                            !combined.includes('conversation options')) {
                            el.click();
                            return txt.slice(0, 60) + ' [h=' + Math.round(r.height) + ']';
                        }
                    }
                }
                return null;
            }""")

            if clicked:
                await page.wait_for_timeout(800)
                log(f"Image mode activated via JS scan: '{clicked}'")
                return

            await page.keyboard.press("Escape")
            await page.wait_for_timeout(300)
    except Exception as e:
        log(f"Strategy 4 error: {e}")

    await _dump_buttons(page)
    log("WARNING: 'Create an image' button not found — proceeding anyway")


async def select_aspect_ratio(page: Page, ratio: str = "9:16"):
    # Give image-mode controls time to appear after activate_image_mode()
    await page.wait_for_timeout(1200)

    # ratio = "9:16" → also match "portrait" (9:16 is portrait)
    alt_labels = {"9:16": ["portrait", "9:16"], "1:1": ["square", "1:1"], "16:9": ["landscape", "16:9"]}
    keywords = alt_labels.get(ratio, [ratio])

    all_selectors = []
    for kw in keywords:
        all_selectors += [
            f"button:has-text('{kw}')",
            f"[role='option']:has-text('{kw}')",
            f"[role='radio']:has-text('{kw}')",
            f"[role='tab']:has-text('{kw}')",
            f"[aria-label*='{kw}' i]",
            f"[title*='{kw}' i]",
        ]

    for selector in all_selectors:
        try:
            loc = page.locator(selector).first
            if await loc.count() and await loc.is_visible():
                await loc.click()
                await page.wait_for_timeout(300)
                log(f"Aspect ratio set: {ratio} (matched '{selector}')")
                return
        except Exception:
            pass

    log(f"WARNING: Aspect ratio '{ratio}' button not found (image mode may not be active)")


async def select_thinking_mode(page: Page, level: str = "extended"):
    # Find thinking toggle — ChatGPT shows the CURRENT level as button text
    # e.g. button says "Extended" or "Standard" (not "Thinking")
    # "auto" removed — it matches the "choose image aspect ratio Auto" button
    THINK_KEYWORDS = ("thinking", "reason", "think", "extended", "standard")
    think_btn = None

    for el_tag in ["button", "[role='button']"]:
        els = page.locator(el_tag)
        n = await els.count()
        for i in range(min(n, 120)):
            b = els.nth(i)
            try:
                lbl    = ((await b.get_attribute("aria-label")) or "").lower()
                txt    = ((await b.text_content()) or "").lower()
                title  = ((await b.get_attribute("title")) or "").lower()
                testid = ((await b.get_attribute("data-testid")) or "").lower()
                combined = f"{lbl} {txt} {title} {testid}"
                if any(kw in combined for kw in THINK_KEYWORDS):
                    if await b.is_visible():
                        think_btn = b
                        log(f"Thinking button found: '{combined[:60]}'")
                        break
            except Exception:
                continue
        if think_btn:
            break

    if not think_btn:
        log(f"WARNING: Thinking button not found — skipping (may not be available in image mode)")
        return

    await think_btn.click()
    await page.wait_for_timeout(500)

    # Find the level option in the opened menu
    LEVEL_KEYWORDS = {
        "extended": ["extended", "longer", "more"],
        "standard": ["standard", "normal", "default", "medium"],
        "none": ["none", "off", "disabled"],
    }
    search_words = LEVEL_KEYWORDS.get(level.lower(), [level.lower()])

    for item_sel in ["[role='menuitem']", "[role='option']", "[role='radio']", "button", "li"]:
        items = page.locator(item_sel)
        k = await items.count()
        for i in range(min(k, 20)):
            item = items.nth(i)
            try:
                txt = ((await item.text_content()) or "").lower()
                if any(w in txt for w in search_words):
                    if await item.is_visible():
                        await item.click()
                        await page.wait_for_timeout(300)
                        log(f"Thinking mode set: {level}")
                        return
            except Exception:
                continue

    log(f"WARNING: Thinking option '{level}' not found — closing menu")
    await page.keyboard.press("Escape")


async def fill_chat_input(page: Page, text: str):
    """Insert text into ChatGPT's Lexical editor. Uses execCommand (proven approach)."""
    # Wait for compose input — the real input is a DIV with role=textbox
    COMPOSE = (
        'div[role="textbox"], '
        '[contenteditable="true"][data-lexical-editor], '
        '#prompt-textarea'
    )
    try:
        await page.wait_for_selector(COMPOSE, state="visible", timeout=30000)
    except PwTimeout:
        log("ERROR: fill_chat_input — compose input never appeared.")
        raise RuntimeError("ChatGPT compose input not found — cannot type prompt.")

    result = await page.evaluate("""(text) => {
        const el = document.querySelector('div[role="textbox"]')
                || document.querySelector('[contenteditable="true"][data-lexical-editor]')
                || document.querySelector('#prompt-textarea')
                || document.querySelector('[contenteditable="true"]');
        if (!el) return 'not_found';
        el.focus();
        document.execCommand('selectAll', false, null);
        document.execCommand('delete', false, null);
        const ok = document.execCommand('insertText', false, text);
        if (!ok) {
            el.innerText = text;
            el.dispatchEvent(new InputEvent('input', { bubbles: true }));
            return 'innerText_fallback';
        }
        return 'ok';
    }""", text)

    # Verify text was entered
    content = await page.evaluate("""() => {
        const el = document.querySelector('div[role="textbox"]')
                || document.querySelector('[contenteditable="true"][data-lexical-editor]')
                || document.querySelector('#prompt-textarea')
                || document.querySelector('[contenteditable="true"]');
        return el ? (el.textContent || el.value || '').trim() : '';
    }""")

    if len(content) < 5:
        log(f"execCommand returned '{result}' — using keyboard type fallback")
        ta = page.locator(
            "div[role='textbox'], "
            "[contenteditable='true'][data-lexical-editor], "
            "#prompt-textarea"
        ).first
        if not await ta.count():
            raise RuntimeError("ChatGPT compose input not found for keyboard fallback.")
        await ta.click(timeout=10000)
        await page.keyboard.press("Control+a")
        await page.keyboard.press("Delete")
        chunk = 500
        for i in range(0, len(text), chunk):
            await page.keyboard.type(text[i:i+chunk], delay=0)
        log(f"Typed {len(text)} chars via keyboard")
    else:
        log(f"Text inserted ({len(content)} chars) — preview: '{content[:60]}'")


async def upload_file(page: Page, file_path: Path):
    """Upload a file to ChatGPT.

    Primary path is the "+" → "Add photos & files" menu wrapped in
    expect_file_chooser(): Playwright intercepts the chooser before the OS dialog
    renders, so nothing is ever left on screen. We deliberately do NOT use the
    Ctrl+U shortcut anymore — when expect_file_chooser missed its event, Ctrl+U
    left a real native Open dialog stuck open that page.keyboard can't close
    (Escape goes to the page, not the OS modal), forcing a manual cancel and
    breaking unattended runs.
    """
    size_kb = file_path.stat().st_size // 1024
    log(f"Uploading: {file_path.name} ({size_kb} KB)...")

    fc = None

    # ── Strategy 1: "+" → "Add photos & files" (Playwright-captured chooser) ──
    try:
        plus = page.locator("[data-testid='composer-plus-btn']").first
        if await plus.count() and await plus.is_visible():
            async with page.expect_file_chooser(timeout=10000) as fc_info:
                await plus.click()
                await page.wait_for_timeout(600)
                add_item = page.locator("[role='menuitem']").filter(
                    has_text="Add photos"
                ).first
                if await add_item.count() and await add_item.is_visible():
                    await add_item.click()
                else:
                    await page.keyboard.press("Escape")
                    raise Exception("'Add photos & files' not found in menu")
            fc = await fc_info.value
            log("File chooser opened via + menu")
    except Exception as e:
        log(f"+ menu upload failed ({e}) — trying hidden input fallback...")
        await page.keyboard.press("Escape")
        await page.wait_for_timeout(400)

    # ── Strategy 2: direct set_input_files on the hidden input (fallback) ─────
    if fc is None:
        fi = page.locator(
            "input[data-testid='upload-photos-input'], input[type='file']"
        ).first
        if await fi.count():
            await fi.set_input_files(str(file_path))
            log(f"File set via hidden input (fallback): {file_path.name}")
        else:
            log(f"ERROR: No upload mechanism found — skipping {file_path.name}")
            return
    else:
        await fc.set_files(str(file_path))
        log(f"File selected in chooser: {file_path.name}")

    # Give React time to process the file-selection event, then wait for
    # the send button to be enabled (= upload to OpenAI servers is done).
    await page.wait_for_timeout(3000)
    try:
        await page.wait_for_function(
            """() => {
                const b = document.querySelector('button[data-testid="send-button"]')
                       || document.querySelector('button[aria-label="Send prompt"]');
                return b && !b.disabled;
            }""",
            timeout=120000,
        )
        log(f"Upload complete: {file_path.name} ✓")
    except PwTimeout:
        log(f"WARNING: Send button still disabled after 2 min — proceeding anyway")


async def click_send(page: Page):
    """Wait for send button to be enabled and click it."""
    send = page.locator(
        "button[data-testid='send-button'], "
        "button[aria-label='Send prompt'], "
        "button[aria-label*='Send']"
    ).first

    deadline = time.time() + 20
    while time.time() < deadline:
        if await send.count() and not await send.is_disabled():
            break
        await page.wait_for_timeout(500)

    await send.click()
    log("Send clicked")
    await page.wait_for_timeout(600)


# ── Generation + image detection ──────────────────────────────────────────────

async def wait_for_generation(page: Page, max_wait: int = 600):
    """Wait for ChatGPT generation to complete (stop button appears then disappears)."""
    log(f"Waiting for generation (max {max_wait}s)...")

    # Wait for stop button to appear (generation started)
    try:
        await page.wait_for_selector('[data-testid="stop-button"]', timeout=15000)
        log("Generation started")
    except PwTimeout:
        log("Stop button did not appear — generation may already be done or was instant")

    # Wait for stop button to disappear (generation finished)
    try:
        await page.wait_for_selector(
            '[data-testid="stop-button"]',
            state="hidden",
            timeout=max_wait * 1000,
        )
        log("Generation complete")
    except PwTimeout:
        log(f"WARNING: Generation still running after {max_wait}s — proceeding anyway")

    await page.wait_for_timeout(1000)


async def count_generated_images(page: Page) -> int:
    """Count UNIQUE generated images by file ID (id=file_ underscore = generated, not uploaded).
    Deduplicates: thumbnail + main view of the same image share one file ID → counted once.
    """
    return await page.evaluate("""() => {
        const ids = new Set();
        for (const img of document.querySelectorAll('img[src*="id=file_"]')) {
            const m = img.src.match(/id=(file_[^&\\s"]+)/);
            if (m) ids.add(m[1]);
        }
        return ids.size;
    }""")


async def poll_for_images(page: Page, expected: int, baseline: int, timeout: int = 120) -> int:
    """Poll until (baseline + expected) generated images are in the DOM."""
    log(f"Polling for {expected} new image(s) (baseline={baseline})...")
    start = time.time()
    last_log = start
    while time.time() - start < timeout:
        try:
            total = await count_generated_images(page)
        except Exception:
            await asyncio.sleep(3)
            continue
        new = total - baseline
        elapsed = int(time.time() - start)
        if time.time() - last_log >= 20:
            log(f"  {elapsed}s: {total} total ({new} new / {expected} expected)")
            last_log = time.time()
        if new >= expected:
            log(f"✓ {new} new images found")
            return new
        await asyncio.sleep(3)
    try:
        final = await count_generated_images(page) - baseline
    except Exception:
        final = 0
    log(f"Timeout reached — found {final} new images")
    return final


async def get_generated_image_urls(page: Page) -> list:
    """Return list of generated image URLs (file_ pattern). Safe against navigation."""
    # Wait for page to be stable after generation
    try:
        await page.wait_for_load_state("domcontentloaded", timeout=10000)
    except Exception:
        pass
    await page.wait_for_timeout(1000)

    try:
        urls = await page.evaluate("""() => {
            const seen = new Set();
            const result = [];
            for (const img of document.querySelectorAll('img[src*="id=file_"]')) {
                const m = img.src.match(/id=(file_[^&\\s"]+)/);
                if (m && !seen.has(m[1])) {
                    seen.add(m[1]);
                    result.push(img.src);
                }
            }
            return result;
        }""")
    except Exception as e:
        log(f"WARNING: get_generated_image_urls evaluate failed ({e}) — retrying after 3s")
        await page.wait_for_timeout(3000)
        try:
            urls = await page.evaluate("""() => {
                const seen = new Set();
                const result = [];
                for (const img of document.querySelectorAll('img[src*="id=file_"]')) {
                    const m = img.src.match(/id=(file_[^&\\s"]+)/);
                    if (m && !seen.has(m[1])) { seen.add(m[1]); result.push(img.src); }
                }
                return result;
            }""")
        except Exception as e2:
            log(f"ERROR: Could not read image URLs: {e2}")
            return []

    if not urls:
        # Fallback: any large non-UI image
        try:
            urls = await page.evaluate("""() => {
                return [...document.querySelectorAll("img[src^='https']")]
                    .filter(i =>
                        (i.naturalWidth || i.width) > 200
                        && !i.src.includes('avatar')
                        && !i.src.includes('logo')
                        && !i.src.includes('icon')
                    )
                    .map(i => i.src);
            }""")
        except Exception:
            urls = []
    return urls


async def download_image_bytes(page: Page, url: str) -> bytes:
    """Fetch image bytes from ChatGPT URL using browser's auth cookies."""
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


# ── Main ──────────────────────────────────────────────────────────────────────

async def run(project: dict):
    page_name = project.get("page") or "unknown"
    working_dir = BASE_DIR / "pages" / page_name / "working"
    working_dir.mkdir(parents=True, exist_ok=True)

    pid = project["id"]
    total = project["total_scenes"]
    ratio = project.get("aspect_ratio", "9:16")
    char_rel = project.get("character_sheet")
    char_path = (BASE_DIR / char_rel) if char_rel else None

    if char_path and not char_path.exists():
        log(f"WARNING: Character sheet not found at {char_path} — proceeding without it")
        char_path = None

    pw, context = await connect_chrome()

    try:
        page = await ensure_logged_in_chatgpt(context)
        storyboard_path = working_dir / f"{pid}-storyboard.png"

        # ══ PHASE A: STORYBOARD ═══════════════════════════════════════════════
        status = project.get("project_status", "pending")

        # Safety: if status says "done" but the file is gone (user deleted it),
        # fall back to "pending" so Phase A re-generates it.
        IMAGES_DONE_STATUSES = ("storyboard_done", "images_done", "videos_in_progress", "complete")

        if status in IMAGES_DONE_STATUSES:
            if not storyboard_path.exists():
                log(f"Storyboard file missing on disk — re-running Phase A")
                _update_project(pid, project_status="pending")
                status = "pending"

        if status in IMAGES_DONE_STATUSES:
            # Storyboard already generated and file confirmed on disk — skip
            log(f"\n{'='*50}")
            log(f"PHASE A — Skipped (status={status}, file exists)")
            log(f"{'='*50}")
        else:
            log(f"\n{'='*50}")
            log(f"PHASE A — Storyboard  [{pid}]")
            log(f"{'='*50}")

            await activate_image_mode(page)
            await page.wait_for_timeout(300)
            await select_aspect_ratio(page, ratio)
            await select_thinking_mode(page, "extended")

            storyboard_text = _cut_at_end_marker(project["storyboard_prompt"].strip(), "STORYBOARD")
            storyboard_text += "\n\n--- The End of STORYBOARD PROMPTS ---"
            log("Typing storyboard prompt...")
            await fill_chat_input(page, storyboard_text)
            await page.wait_for_timeout(300)

            if char_path:
                await upload_file(page, char_path)
                await page.wait_for_timeout(300)

            await click_send(page)

            # The sent message renders the uploaded char sheet as an img[src*="id=file_"]
            # element — record the count NOW so we don't confuse it with the generated image.
            await page.wait_for_timeout(5000)
            baseline_a = await count_generated_images(page)
            log(f"Phase A baseline after message render: {baseline_a} (char sheet in DOM)")

            await wait_for_generation(page, max_wait=480)
            await poll_for_images(page, expected=1, baseline=baseline_a, timeout=300)

            all_urls_a = await get_generated_image_urls(page)
            new_urls_a = all_urls_a[baseline_a:]
            log(f"Found {len(new_urls_a)} new image(s) after Phase A (above baseline {baseline_a})")

            if not new_urls_a:
                log("ERROR: No storyboard image found. Check the ChatGPT tab.")
                return

            storyboard_url = new_urls_a[-1]
            log(f"Downloading storyboard ({storyboard_url[60:100]}...)...")
            img_bytes = await download_image_bytes(page, storyboard_url)
            storyboard_path.write_bytes(img_bytes)
            log(f"✓ Storyboard saved → {storyboard_path.name} ({len(img_bytes)//1024} KB)")
            if storyboard_path.stat().st_size == 0:
                log("ERROR: Storyboard file is empty — aborting. Check ChatGPT tab.")
                return
            _update_project(pid, project_status="storyboard_done")

        # ══ PHASE B: SCENE IMAGES ═════════════════════════════════════════════
        log(f"\n{'='*50}")
        log(f"PHASE B — Scene Images  [{total} scenes]")
        log(f"{'='*50}")

        _b_done = status in ("images_done", "videos_in_progress", "complete")

        if _b_done:
            log(f"PHASE B — Skipped (status={status}, scenes already done)")
            log(f"{'='*50}")
        else:
            # Gate: storyboard must exist and be non-zero before Phase B can start
            if not storyboard_path.exists() or storyboard_path.stat().st_size == 0:
                log("ERROR: Storyboard not ready on disk — cannot start Phase B.")
                log("       Reset status to 'pending' and re-run to regenerate the storyboard.")
                return
            log(f"Storyboard confirmed ({storyboard_path.stat().st_size // 1024} KB) — starting Phase B")

            # Continue in the same chat — ChatGPT keeps storyboard context
            await activate_image_mode(page)
            await page.wait_for_timeout(300)
            await select_aspect_ratio(page, ratio)
            await select_thinking_mode(page, "standard")

            # Build combined scene prompt — strip at "The End of IMAGE PROMPTS" in each prompt
            def _clean(text: str) -> str:
                return _cut_at_end_marker(text.strip(), "IMAGE")

            scene_blocks = "\n\n---\n\n".join(
                f"## SCENE {s['scene_num']} IMAGE PROMPT\n\n{_clean(s['image_prompt'])}"
                for s in project["scenes"]
            )
            combined_prompt = scene_blocks + (
                "\n\nCreate all image สร้างเป็นภาพแยกกัน ซีนละ 1 ภาพ"
                "\n\n--- The End of IMAGE PROMPTS ---"
            )
            log(f"Typing {total} scene prompts ({len(combined_prompt)} chars)...")
            await fill_chat_input(page, combined_prompt)
            await page.wait_for_timeout(300)

            # Upload storyboard as reference
            if storyboard_path.exists():
                log("Uploading storyboard reference image...")
                await upload_file(page, storyboard_path)
                await page.wait_for_timeout(300)

            # Upload character sheet again
            if char_path:
                log("Uploading character sheet reference...")
                await upload_file(page, char_path)
                await page.wait_for_timeout(300)

            await click_send(page)

            # Wait for Phase B message to render — storyboard + char sheet attachments appear
            # in the conversation as img[src*="id=file_"] elements, same as generated images.
            # Record baseline NOW so their URLs are excluded from the scene-image slice.
            await page.wait_for_timeout(5000)
            baseline_b = await count_generated_images(page)
            log(f"Phase B baseline after message render: {baseline_b} (Phase A + Phase B refs in DOM)")

            # Scene generation: Standard thinking, N images
            max_b = 600 + total * 360          # 10 min base + 6 min/scene (70 min for 10 scenes)
            await wait_for_generation(page, max_wait=max_b)
            # Scroll to bottom so lazy-rendered gallery thumbnails load into the DOM
            await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
            await page.wait_for_timeout(3000)
            await poll_for_images(page, expected=total, baseline=baseline_b, timeout=3600)

            # Download all new scene images
            all_urls_b = await get_generated_image_urls(page)
            new_urls = all_urls_b[baseline_b:]
            log(f"Found {len(new_urls)} new image URL(s) for scenes (above baseline {baseline_b})")

            saved = 0
            for i, url in enumerate(new_urls[:total], start=1):
                nn = str(i).zfill(2)
                log(f"Downloading scene {nn}/{total}...")
                try:
                    img_bytes = await download_image_bytes(page, url)
                    dest = working_dir / f"{pid}-scene-{nn}.png"
                    dest.write_bytes(img_bytes)
                    _update_scene(pid, i, image_status="done")
                    log(f"  ✓ scene-{nn}.png ({len(img_bytes)//1024} KB)")
                    saved += 1
                except Exception as e:
                    log(f"  ERROR downloading scene {nn}: {e}")

            if saved < total:
                log(f"WARNING: Only {saved}/{total} scenes downloaded — check ChatGPT tab")

            _update_project(pid, project_status="images_done")

            log(f"\n{'='*50}")
            log(f"✓ SCENES COMPLETE  [{pid}]")
            log(f"  Storyboard : pages/{page_name}/working/{pid}-storyboard.png")
            log(f"  Scenes     : {saved}/{total} saved to pages/{page_name}/working/")
            log(f"{'='*50}")

        # ══ PHASE C: THUMBNAIL ════════════════════════════════════════════════
        thumbnail_prompt_text = project.get("thumbnail_prompt", "").strip()
        thumbnail_path = working_dir / f"{pid}-thumbnail.png"

        log(f"\n{'='*50}")
        if not thumbnail_prompt_text:
            log(f"PHASE C — Skipped (no thumbnail prompt in brief)")
            log(f"{'='*50}")
        elif status in ("videos_in_progress", "complete"):
            log(f"PHASE C — Skipped (status={status}, past image phase)")
            log(f"{'='*50}")
        elif thumbnail_path.exists() and thumbnail_path.stat().st_size > 0:
            log(f"PHASE C — Thumbnail already exists  [{pid}]")
            log(f"{'='*50}")
        else:
            log(f"PHASE C — Thumbnail  [{pid}]")
            log(f"{'='*50}")

            # Continue in the same chat — all 10 scene images are already in context
            thumb_ratio = detect_aspect_ratio(thumbnail_prompt_text) or ratio
            await activate_image_mode(page)
            await page.wait_for_timeout(300)
            await select_aspect_ratio(page, thumb_ratio)
            await select_thinking_mode(page, "extended")

            clean_thumb = _cut_at_end_marker(thumbnail_prompt_text, "THUMBNAIL")
            log("Typing thumbnail prompt...")
            await fill_chat_input(page, clean_thumb)
            await page.wait_for_timeout(300)

            if char_path:
                log("Uploading character sheet for thumbnail...")
                await upload_file(page, char_path)
                await page.wait_for_timeout(300)

            await click_send(page)

            await page.wait_for_timeout(5000)
            baseline_c = await count_generated_images(page)
            log(f"Phase C baseline: {baseline_c}")

            await wait_for_generation(page, max_wait=480)
            await poll_for_images(page, expected=1, baseline=baseline_c, timeout=300)

            all_urls_c = await get_generated_image_urls(page)
            new_urls_c = all_urls_c[baseline_c:]
            log(f"Found {len(new_urls_c)} new image(s) after Phase C")

            if not new_urls_c:
                log("ERROR: No thumbnail image found. Check the ChatGPT tab.")
            else:
                thumb_url = new_urls_c[-1]
                log(f"Downloading thumbnail ({thumb_url[60:100]}...)...")
                thumb_bytes = await download_image_bytes(page, thumb_url)
                thumbnail_path.write_bytes(thumb_bytes)
                log(f"✓ Thumbnail saved → {thumbnail_path.name} ({len(thumb_bytes)//1024} KB)")
                if thumbnail_path.stat().st_size == 0:
                    log("WARNING: Thumbnail file is empty — check ChatGPT tab.")

        log(f"\n{'='*50}")
        log(f"✓ IMAGE PHASE COMPLETE  [{pid}]")
        log(f"\n  Next step  : py bot.py videos {pid}")
        log(f"{'='*50}")
        notify(f"🖼️ Images complete: {pid} ({page_name})")

    except Exception as e:
        notify_error(f"image_phase {pid} ({page_name})", e)
        raise
    finally:
        await context.close()
        await pw.stop()
