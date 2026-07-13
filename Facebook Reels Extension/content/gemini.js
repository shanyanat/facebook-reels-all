'use strict';

// ── content/gemini.js — scene images + thumbnail on Gemini ─────────────────────
//
// The "hybrid" image engine: ChatGPT makes the storyboard (Phase A, chatgpt.js),
// then this script makes the 10 scene images + the thumbnail on Gemini, which is
// far cheaper in ChatGPT image quota (12 images per reel → 1).
//
// Gemini cannot be asked for 10 images in one message. Each scene is its own turn,
// in ONE chat, with reference images attached: character sheet + storyboard +
// the PREVIOUS scene's image (N-1). That N-1 chain is what keeps the look consistent.
//
// The DOM mechanics (composer, model pill, paste-upload, stop button) are ported
// from the proven `Facebook Reels Extension for Multi Analyze/content-gemini.js`
// (selectors locked live 2026-06-27). What is NEW here is everything to do with
// *generated* images — that script only ever extracted text. See "Capture" below.

(function () {

const API = 'http://localhost:7788';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = msg => {
    console.log(`[gemini-ext] ${msg}`);
    chrome.runtime.sendMessage({ action: 'progress', text: msg }).catch(() => {});
};
const report = log;

// Set to 'image' and re-run one scene to dump the response-image DOM to the side
// panel when Gemini's markup changes and capture stops working. '' = live run.
const DIAG = '';

const MAX_ATTEMPTS_PER_SCENE = 3;   // real failures (empty reply, bad capture)
const MAX_RATE_LIMIT_BACKOFFS = 5;  // throttles — do NOT consume a real attempt
const RATE_LIMIT_BACKOFF_MS   = 60000;
const MIN_GENERATED_PX        = 256; // an output image is never a tiny icon/avatar

// ── DOM utilities ─────────────────────────────────────────────────────────────

function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0';
}

function pick(list) {
    for (const sel of list) {
        const el = document.querySelector(sel);
        if (el) return el;
    }
    return null;
}

async function waitFor(fn, timeout = 30000, interval = 400) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
        try { const r = fn(); if (r) return r; } catch {}
        await sleep(interval);
    }
    throw new Error(`waitFor timeout (${timeout}ms)`);
}

// ── Gemini selectors (confirmed live 2026-06-27, ported from Multi Analyze) ────

const SELECTORS = {
    composer: [
        '.ql-editor[contenteditable="true"]',
        'div[aria-label="Enter a prompt for Gemini"]',
        'div[contenteditable="true"][role="textbox"]',
        'div[contenteditable="true"]',
        'textarea',
    ],
    send: [
        'button[aria-label="Send message"]',
        'button[aria-label*="Send" i]',
        '.send-button-container button',
        'button.send-button',
    ],
    response: [
        '.model-response-text',
        'message-content',
        '[class*="model-response"]',
        'model-response .markdown',
        '.markdown',
    ],
};

const getComposer = () => pick(SELECTORS.composer);
const getSendButton = () => pick(SELECTORS.send);

function isSendReady() {
    const b = getSendButton();
    return !!(b && !b.disabled && b.getAttribute('aria-disabled') !== 'true');
}

// The conversation. Everything the model said and everything we already sent lives in
// here; the composer and its attachment chips live OUTSIDE it. That split is what lets
// attachment detection ignore the chat.
const CHAT_SCOPE = 'user-query, model-response, message-content, .conversation-container, ' +
                   '[class*="conversation-container"], .chat-history, [class*="chat-history"]';

const inChat = el => !!el.closest(CHAT_SCOPE);

// ── Busy / done detection ─────────────────────────────────────────────────────

function findStopButton() {
    return Array.from(document.querySelectorAll('button')).find(b => {
        const l = (b.getAttribute('aria-label') || '').toLowerCase();
        if (l.includes('stop') &&
            (l.includes('respon') || l.includes('generat') || l.includes('answer') || l.trim() === 'stop')) {
            return true;
        }
        const icon = b.querySelector('mat-icon, [fonticon], [data-mat-icon-name]');
        const iname = (icon?.getAttribute('fonticon') || icon?.getAttribute('data-mat-icon-name') ||
                       icon?.textContent || '').trim().toLowerCase();
        return iname === 'stop';
    }) || null;
}

// Do NOT key off [role="progressbar"] / [class*="loading"] — Gemini keeps those
// mounted permanently, so isGenerating() would stick true and hang the wait.
function isGenerating() {
    if (findStopButton()) return true;
    if (document.querySelector('.blinking-cursor')) return true;
    return false;
}

const RATE_LIMIT_RE = /(unusual activity|too many requests|rate.?limit|try again later|quota|limit reached|you've reached your limit|slow down)/i;

function seesRateLimit() {
    const nodes = Array.from(document.querySelectorAll(SELECTORS.response.join(',')));
    const last = nodes[nodes.length - 1];
    const text = (last?.innerText || '') + ' ' + (document.body?.innerText || '').slice(-2000);
    return RATE_LIMIT_RE.test(text);
}

// ── Capture: which <img> is a GENERATED image ─────────────────────────────────
//
// Getting this wrong is the ONE way this engine can silently corrupt a reel, so it is
// defended four ways rather than by one clever selector:
//
//   1. Exclude the USER TURN. This is the subtle one. The reference images we attach
//      are in the composer before send — but the moment we send, Gemini re-renders them
//      INSIDE the user's message bubble, where they look like brand-new <img>s that
//      appeared after our baseline. Excluding the user turn is what stops the N-1
//      reference from being saved as scene N. (chatgpt.js learned the same lesson.)
//   2. Require a real size. Attachment chips, avatars and icons are small; a generated
//      image never is.
//   3. Baseline the src set AFTER attaching and BEFORE send, and take only the delta.
//   4. saveGeminiImage() in background.js drops any image whose bytes match a reference.
//
// Deliberately does NOT require an ancestor response container: ChatGPT renders image
// output outside its role container, Gemini may too, and requiring one would match
// nothing. Excluding what we know is wrong is the fail-safe direction.

const USER_TURN = 'user-query, .user-query, [class*="user-query"], [class*="user-message"]';

function generatedImgs() {
    const out = [];
    const seen = new Set();
    for (const img of document.querySelectorAll('img')) {
        if (!img.src || seen.has(img.src)) continue;
        if (img.closest(USER_TURN)) continue;                      // our attached references
        const w = img.naturalWidth || 0;
        const h = img.naturalHeight || 0;
        if (w < MIN_GENERATED_PX || h < MIN_GENERATED_PX) continue; // chip / avatar / icon
        seen.add(img.src);
        out.push(img.src);
    }
    return out;
}

// Wait for a NEW generated image to appear and finish loading. Text-length gates
// (what the Multi Analyze script uses) are useless here — an image reply has almost
// no text, so those would spin for the full timeout.
async function waitForGeneratedImage(baseline, timeout = 420, noProgressWindow = 150) {
    const start = Date.now();
    let lastCount = 0, lastProgressAt = Date.now(), stable = 0;
    let sawGenerating = false, idlePolls = 0;

    while (Date.now() - start < timeout * 1000) {
        const generating = isGenerating();
        if (generating) { sawGenerating = true; idlePolls = 0; }

        const fresh = generatedImgs().filter(u => !baseline.has(u));

        if (fresh.length > lastCount) {
            lastCount = fresh.length;
            lastProgressAt = Date.now();
            stable = 0;
        }

        if (!generating && fresh.length > 0) {
            // Generation finished and the count held steady — 3 stable polls so we
            // never grab a half-rendered image.
            stable++;
            if (stable >= 3) return fresh;
        }

        // Generation ended (or never started) and produced nothing. Don't sit out the
        // full no-progress window — nothing more is coming. The 20s of consecutive
        // idle polls covers Gemini's thinking→text gap, where the stop button briefly
        // disappears mid-turn.
        if (!generating && fresh.length === 0 && (sawGenerating || Date.now() - start > 45000)) {
            if (++idlePolls >= 10) {
                log('Generation ended with no image');
                return [];
            }
        }

        if (Date.now() - lastProgressAt > noProgressWindow * 1000) {
            log(`No new image for ${noProgressWindow}s — giving up on this turn`);
            return fresh;
        }
        await sleep(2000);
    }
    log(`Timeout after ${timeout}s waiting for an image`);
    return generatedImgs().filter(u => !baseline.has(u));
}

// Dump the response-image DOM so a selector break is diagnosable from the side panel
// instead of guessing. Called when generation clearly ended but capture found nothing.
function dumpImageDom() {
    const lines = ['--- GEMINI IMAGE DOM DUMP ---'];
    const containers = Array.from(document.querySelectorAll(SELECTORS.response.join(',')));
    lines.push(`response containers: ${containers.length}`);
    const last = containers[containers.length - 1];
    const scope = last || document.body;
    const imgs = Array.from(scope.querySelectorAll('img'));
    lines.push(`imgs in last container: ${imgs.length}`);
    imgs.slice(0, 12).forEach((img, i) => {
        const src = img.src || '';
        const scheme = src.split(':')[0];
        lines.push(`  [${i}] ${scheme}: ${img.naturalWidth}x${img.naturalHeight} alt="${(img.alt || '').slice(0, 40)}" src=${src.slice(0, 100)}`);
    });
    const allImgs = Array.from(document.querySelectorAll('img'))
        .filter(i => (i.naturalWidth || 0) >= MIN_GENERATED_PX);
    lines.push(`large imgs anywhere on page: ${allImgs.length}`);
    allImgs.slice(0, 12).forEach((img, i) => {
        lines.push(`  (page)[${i}] ${(img.src || '').slice(0, 110)} ${img.naturalWidth}x${img.naturalHeight}`);
    });
    const btns = Array.from(document.querySelectorAll('button'))
        .filter(isVisible)
        .map(b => (b.getAttribute('aria-label') || b.textContent || '').trim().slice(0, 40))
        .filter(t => /download|save|more|image/i.test(t));
    lines.push(`image-ish buttons: ${btns.join(' | ')}`);
    lines.forEach(l => log(l));
}

// ── Model: 3.1 Pro + Extended thinking ────────────────────────────────────────
//
// BOTH must end up selected. Two menu layouts exist in the wild and the bot must
// handle either, because guessing wrong silently leaves thinking on Standard:
//
//   (a) FLAT   — "3.1 Pro" and "Extended thinking" are both direct items in the
//                mode-picker menu. (What this account shows.)
//   (b) NESTED — "Extended" lives in a submenu under a "Thinking level" row.
//                (What the Multi Analyze extension was built against.)
//
// The old port only knew (b): it looked for a "Thinking level" row, didn't find one,
// warned, and gave up — leaving Pro set and thinking on Standard. It now tries the
// flat item first, falls back to the submenu, and VERIFIES both at the end instead of
// assuming the clicks landed.

function getModePill() {
    return pick(['button[aria-label^="Open mode picker"]', 'button[aria-label*="mode picker" i]']);
}

const MENU_ITEM = '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], ' +
                  '[role="option"], .mat-mdc-menu-item';

function menuItems() {
    return Array.from(document.querySelectorAll(MENU_ITEM)).filter(isVisible);
}

const itemText = el => (el.textContent || '').replace(/\s+/g, ' ').trim();

// Menu rows carry no aria-label, so selection state comes from aria-checked/selected.
function isChecked(el) {
    const a = el.getAttribute('aria-checked') ?? el.getAttribute('aria-selected');
    return a === 'true';
}

function findItem(re, notRe) {
    return menuItems().find(el => {
        const t = itemText(el);
        return re.test(t) && !(notRe && notRe.test(t));
    }) || null;
}

// Open the mode picker and wait for its items to render. Returns false if the pill
// isn't there. (The Angular overlay only renders in a FOREGROUND tab — this is why
// gemini.js holds the UI turn while calling ensureProExtended.)
async function openModeMenu() {
    if (menuItems().length) return true;   // already open
    const pill = getModePill();
    if (!pill) return false;
    pill.click();
    const end = Date.now() + 5000;
    while (Date.now() < end) {
        if (menuItems().length) { await sleep(300); return true; }
        await sleep(200);
    }
    return false;
}

function dumpMenu(tag) {
    const items = menuItems();
    log(`  [menu:${tag}] ${items.length} item(s)`);
    items.slice(0, 20).forEach((el, i) =>
        log(`    ${i}. ${isChecked(el) ? '[x]' : '[ ]'} ${itemText(el).slice(0, 64)}`));
}

function pressEscape() {
    try {
        document.body.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true
        }));
    } catch {}
}

function dismissOnboarding() {
    // Close the one-time discovery card if it overlays the composer.
    // NEVER touch the consent "Get started" button — that opens a consent flow.
    const card = Array.from(document.querySelectorAll('button'))
        .find(b => /Acknowledge and close the discovery card/i.test(b.getAttribute('aria-label') || ''));
    if (card && isVisible(card)) { try { card.click(); } catch {} }
}

// A "Thinking level" ROW also contains the word "Extended" when Extended is its current
// value — so matching /extended/ alone can hit the row instead of the option. Always
// exclude the row when hunting for the real option.
const THINKING_ROW = /thinking level/i;
const EXTENDED_OPT = /extended/i;

async function ensureProExtended() {
    if (!await openModeMenu()) {
        log('WARNING: model pill not found — using Gemini default');
        return;
    }
    dumpMenu('mode-picker');

    // ── 1. Model = 3.1 Pro ────────────────────────────────────────────────────
    const pro = findItem(/3\.1\s*pro/i);
    if (!pro) {
        log('WARNING: "3.1 Pro" not found in the mode menu');
    } else if (isChecked(pro)) {
        log('✓ 3.1 Pro already selected');
    } else {
        pro.click();
        await sleep(1200);           // clicking a model row usually closes the menu
        log('✓ Selected: 3.1 Pro');
    }

    // ── 2. Extended thinking ──────────────────────────────────────────────────
    // Re-open: the model click may have closed the menu.
    if (!await openModeMenu()) {
        log('WARNING: could not re-open the mode menu for Extended thinking');
        return;
    }
    await sleep(400);

    // Layout (a): "Extended thinking" is a direct item in this menu.
    let ext = findItem(EXTENDED_OPT, THINKING_ROW);

    // Layout (b): it's inside a "Thinking level" submenu.
    if (!ext) {
        const row = findItem(THINKING_ROW);
        if (row) {
            // A Material submenu opens on hover OR click — fire both.
            try { row.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true })); } catch {}
            await sleep(500);
            try { row.click(); } catch {}
            await sleep(1000);
            dumpMenu('thinking-submenu');
            ext = findItem(EXTENDED_OPT, THINKING_ROW);
        }
    }

    if (!ext) {
        log('WARNING: "Extended thinking" not found in either layout — dumping the menu so ' +
            'the selector can be re-locked:');
        dumpMenu('extended-missing');
        pressEscape();
        await sleep(300);
        return;
    }

    if (isChecked(ext)) {
        log('✓ Extended thinking already on');
    } else {
        ext.click();
        await sleep(1200);
        log('✓ Selected: Extended thinking');
    }

    pressEscape();
    await sleep(500);

    // ── 3. VERIFY — do not assume the clicks landed ───────────────────────────
    await verifyModeSelection();
}

// Re-open the menu and confirm BOTH are actually selected. A silent miss here means
// every image in the reel is generated on the wrong model/thinking level, which is
// invisible in the output — so it is worth the extra second to check and say so.
async function verifyModeSelection() {
    if (!await openModeMenu()) return;
    await sleep(400);

    const pro = findItem(/3\.1\s*pro/i);
    let ext = findItem(EXTENDED_OPT, THINKING_ROW);
    const row = findItem(THINKING_ROW);

    const proOn = pro ? isChecked(pro) : false;
    // Flat layout: read the option's checked state. Nested layout: the row's own text
    // shows the current value (e.g. "Thinking level  Extended").
    const extOn = ext ? isChecked(ext)
                      : (row ? EXTENDED_OPT.test(itemText(row)) : false);

    log(`Model check → 3.1 Pro: ${proOn ? 'ON' : 'NOT SET'} | Extended thinking: ${extOn ? 'ON' : 'NOT SET'}`);
    if (!proOn || !extOn) {
        log('WARNING: model/thinking not fully set — images will use Gemini defaults');
        dumpMenu('verify-failed');
    }

    pressEscape();
    await sleep(400);
}

// ── Upload (attach a reference image) ─────────────────────────────────────────
// Clipboard-style paste of a File is a PURE DOM event, so it works in BACKGROUND
// tabs — this is the only upload method that survives parallel slots.

// Count attachment chips/previews sitting in the composer — i.e. anything OUTSIDE the
// conversation. Never count globally: the Multi Analyze version counts blob: <img>s
// across the whole page, which is only safe because it sends exactly one message. Here
// the chat fills up with images, and a generated image must never read as an attachment.
function attachmentCount() {
    let n = 0;
    for (const b of document.querySelectorAll('button')) {
        if (inChat(b)) continue;
        const l = (b.getAttribute('aria-label') || '').toLowerCase();
        if (l.includes('lightbox') || l.includes('uploaded') || l.startsWith('remove ') ||
            (l.includes('remove') && (l.includes('file') || l.includes('attach')))) n++;
    }
    for (const img of document.querySelectorAll('img[src^="blob:"]')) {
        if (inChat(img)) continue;
        n++;
    }
    return n;
}

async function pasteFile(file, attempts = 3, windowMs = 30000) {
    const ta = getComposer();
    if (!ta) return false;
    const base = attachmentCount();

    for (let attempt = 1; attempt <= attempts; attempt++) {
        // If a previous paste landed late, do NOT paste again — that double-attaches.
        if (attempt > 1 && attachmentCount() > base) { await sleep(400); return true; }

        try {
            ta.focus();
            await sleep(400);
            const dt = new DataTransfer();
            dt.items.add(file);
            // Do NOT press Escape before pasting — Escape removes the just-attached file.
            ta.dispatchEvent(new ClipboardEvent('paste', {
                bubbles: true, cancelable: true, clipboardData: dt
            }));
        } catch (e) {
            console.warn('[gemini-ext] paste threw:', e);
        }

        // A background/throttled tab renders the chip slowly — wait generously before
        // calling an attempt failed. Too short a window was the old "flaky retry" bug:
        // it gave up mid-upload and the retry then double-attached.
        const deadline = Date.now() + windowMs;
        while (Date.now() < deadline) {
            await sleep(600);
            if (attachmentCount() > base) { await sleep(600); return true; }
        }
        log(`  paste of ${file.name} not confirmed (attempt ${attempt}/${attempts})`);
    }
    return attachmentCount() > base;
}

// Remove every attachment chip from the composer. Needed before retrying a turn: an
// aborted turn can leave references attached, and pasting again on top of them would
// send the same reference twice.
async function clearAttachments() {
    for (let i = 0; i < 12; i++) {
        if (attachmentCount() === 0) return true;
        const btn = Array.from(document.querySelectorAll('button')).find(b => {
            if (inChat(b)) return false;
            const l = (b.getAttribute('aria-label') || '').toLowerCase();
            return l.startsWith('remove ') ||
                   (l.includes('remove') && (l.includes('file') || l.includes('attach')));
        });
        if (!btn) break;
        try { btn.click(); } catch {}
        await sleep(500);
    }
    return attachmentCount() === 0;
}

// Empty the composer text. Never use Escape for this — Escape deletes the attachment.
async function clearComposer() {
    const el = getComposer();
    if (!el) return;
    try {
        el.focus();
        await sleep(150);
        document.execCommand('selectAll', false, null);
        await sleep(60);
        document.execCommand('delete', false, null);
    } catch {}
    await sleep(200);
}

// ── Composer input ────────────────────────────────────────────────────────────

const editorText = el => (el?.innerText ?? el?.value ?? el?.textContent ?? '').trim();

async function typePrompt(text) {
    const el = await waitFor(getComposer, 10000);
    el.focus();
    await sleep(300);

    // Paste-first: Quill drops large text from value setters.
    // NEVER use navigator.clipboard — it is shared across tabs and parallel slots
    // would paste each other's prompt (a silent wrong-scene image).
    try {
        const dt = new DataTransfer();
        dt.setData('text/plain', text);
        el.dispatchEvent(new ClipboardEvent('paste', {
            bubbles: true, cancelable: true, clipboardData: dt
        }));
        await sleep(600);
    } catch (e) {
        console.warn('[gemini-ext] synthetic paste threw:', e);
    }
    if (editorText(el).length >= Math.min(200, Math.floor(text.length * 0.5))) {
        await sleep(300);
        return;
    }

    try {
        el.focus();
        document.execCommand('selectAll', false, null);
        await sleep(80);
        document.execCommand('delete', false, null);
        await sleep(80);
        document.execCommand('insertText', false, text);
        await sleep(400);
    } catch {}
    if (editorText(el).length >= Math.min(200, Math.floor(text.length * 0.5))) return;

    try {
        el.innerText = text;
        el.dispatchEvent(new InputEvent('input', { bubbles: true }));
        await sleep(300);
    } catch {}
}

async function clickSend() {
    // Gemini keeps Send DISABLED while an attachment is still uploading, so waiting for
    // it to become enabled is what proves every reference finished uploading. A big
    // character sheet in a throttled background tab can take a while — wait generously.
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
        if (isSendReady()) { getSendButton().click(); await sleep(800); return; }
        await sleep(400);
    }

    // Send button exists but never enabled ⇒ an upload is stuck. Do NOT force-click:
    // that sends a half-uploaded reference, and the scene comes back wrong while
    // looking perfectly successful on disk. Fail the turn so the caller retries it.
    if (getSendButton()) {
        throw new Error('Send never became enabled after 180s — an attachment is still uploading');
    }

    // No send button at all — fall back to Enter (the composer may be a bare editor).
    const ta = getComposer();
    if (!ta) throw new Error('Send button not found and composer missing');
    ta.focus();
    for (const type of ['keydown', 'keypress', 'keyup']) {
        ta.dispatchEvent(new KeyboardEvent(type, {
            key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true
        }));
    }
    await sleep(800);
}

// ── monitor.py helpers (identical contract to chatgpt.js) ─────────────────────

async function fetchRef(relPath) {
    const safe = relPath.replace(/\\/g, '/');
    const res = await fetch(`${API}/file/${encodeURI(safe)}`);
    if (!res.ok) throw new Error(`${res.status}`);
    const buf = await res.arrayBuffer();
    return new Uint8Array(buf);
}

function bytesToFile(bytes, filename) {
    return new File([bytes], filename, { type: 'image/png' });
}

// Cheap fingerprint of a reference image, so a captured image that is really just an
// echo of an attached reference can be rejected client-side. monitor.py's own 409
// guard only knows the storyboard + character sheet — it does NOT know the N-1 scene
// image we attach here, which is exactly the one that would corrupt a reel silently.
function fingerprint(bytes) {
    let h = 0;
    for (let i = 0; i < bytes.length; i += 97) h = (h * 31 + bytes[i]) >>> 0;
    return `${bytes.length}:${h}`;
}

async function charSheetBytes(project) {
    const raw = project.character_sheet;
    if (!raw) return null;
    try { return await fetchRef(raw); }
    catch {
        // The stored path goes stale after a page rename (true for several live reels).
        const base = raw.replace(/\\/g, '/').split('/').pop();
        try { return await fetchRef(`pages/${project.page}/briefs/${base}`); }
        catch { log(`WARNING: character sheet not found (${base})`); return null; }
    }
}

async function getDiskMissingScenes(pid) {
    try {
        const res = await fetch(`${API}/contents.json`, { cache: 'no-store' });
        if (!res.ok) throw new Error(`contents.json ${res.status}`);
        const projects = await res.json();
        const proj = projects.find(p => p.id === pid);
        if (!proj || !Array.isArray(proj.scenes)) return [];
        const hasDisk = proj.scenes.some(s => s.img_on_disk !== undefined);
        const missing = [];
        for (const s of proj.scenes) {
            const present = hasDisk ? !!s.img_on_disk : (s.image_status === 'done');
            if (!present) missing.push(s.scene_num);
        }
        return missing.sort((a, b) => a - b);
    } catch (e) {
        log(`WARNING: could not read disk status: ${e.message}`);
        return [];
    }
}

async function fileOnDisk(page, name) {
    try {
        const res = await fetch(`${API}/file/pages/${page}/working/${name}`, { cache: 'no-store' });
        return res.ok;
    } catch { return false; }
}

const isOnDisk    = (page, pid, nn) => fileOnDisk(page, `${pid}-scene-${nn}.png`);
const thumbOnDisk = (page, pid)     => fileOnDisk(page, `${pid}-thumbnail.png`);

async function isStopped(projectId) {
    try {
        const r = await chrome.storage.local.get('reel_gen_state');
        const state = r['reel_gen_state'];
        if (!state) return false;
        const slot = state.slots.find(s => s.projectId === projectId);
        return !slot || slot.stopping === true || slot.status === 'idle';
    } catch { return false; }
}

// Hand the image to background.js, which re-encodes it to a REAL PNG and POSTs it to
// monitor.py /save_image.
//
// An https: URL is fetched THERE (the service worker holds the googleusercontent host
// permission, so no page CORS applies). A blob:/data: URL cannot be — a blob URL is
// scoped to this page's origin and is invisible to the service worker — so we read
// those bytes here and send them along instead.
async function saveImage(url, filename, refPrints) {
    const payload = { action: 'saveGeminiImage', filename, refPrints: [...refPrints] };

    if (/^(blob|data):/.test(url)) {
        const r = await fetch(url);
        if (!r.ok) throw new Error(`read image failed: ${r.status}`);
        const bytes = new Uint8Array(await r.arrayBuffer());
        const CHUNK = 8192;
        let s = '';
        for (let i = 0; i < bytes.length; i += CHUNK)
            s += String.fromCharCode(...bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
        payload.base64 = btoa(s);
    } else {
        payload.url = url;
    }

    const res = await chrome.runtime.sendMessage(payload);
    if (!res?.ok) throw new Error(res?.error || 'saveGeminiImage failed');
    log(`Saved: ${filename} (~${Math.round((res.size || 0) / 1024)} KB) → working/`);
}

function cutAtEndMarker(text, section) {
    const re = new RegExp(
        `^[^\\n]*the\\s+end\\s+of\\s+${section.replace(/\s+/g, '\\s+')}\\s+prompts?[^\\n]*`,
        'im'
    );
    const m = text.match(re);
    if (m) return text.slice(0, m.index).trimEnd();
    const lines = text.trimEnd().split('\n');
    if (lines.length && /^---.*---$/.test(lines[lines.length - 1].trim()) &&
        lines[lines.length - 1].trim().length > 6) lines.pop();
    return lines.join('\n').trimEnd();
}

// ── UI turn (granted by background.js) ────────────────────────────────────────
// Gemini's model picker is an Angular overlay that does NOT render in a background
// tab, so the tab must be foregrounded while ensureProExtended() runs. background.js
// grants one tab at a time. Pastes are background-safe and run outside the turn.

let _uiGrantResolve = null;

function acquireUiTurn() {
    return new Promise(resolve => {
        _uiGrantResolve = resolve;
        chrome.runtime.sendMessage({ action: 'acquireUi' }).catch(() => {});
        // Never deadlock: proceed anyway after 5 min. Only fires on a real
        // coordination failure, not on normal queueing.
        setTimeout(() => {
            if (_uiGrantResolve === resolve) { _uiGrantResolve = null; resolve(); }
        }, 300000);
    });
}

function releaseUiTurn() {
    chrome.runtime.sendMessage({ action: 'releaseUi' }).catch(() => {});
}

async function waitForReady() {
    await waitFor(getComposer, 45000);
    await sleep(4000);   // let the rest of the Angular composer mount
}

// ── One generation turn: attach refs → prompt → send → capture → save ─────────

async function generateOne(refs, promptText, filename) {
    // 0. Clean slate. A previous turn that was aborted mid-attach can leave chips and
    //    text behind; pasting on top of those would send duplicate references.
    await clearAttachments();
    await clearComposer();

    // 1. Attach every reference for this turn, and CONFIRM each one landed.
    const refPrints = new Set();
    for (const ref of refs) {
        refPrints.add(fingerprint(ref.bytes));
        const ok = await pasteFile(bytesToFile(ref.bytes, ref.name));
        if (!ok) {
            // Do NOT send a turn with a missing reference. Without the character sheet
            // or the N-1 image, Gemini happily draws a scene with the wrong character or
            // a broken look — and it would be saved as a perfectly valid scene-NN.png.
            // Abort the turn instead; the caller retries it.
            log(`Reference ${ref.name} did NOT attach — abandoning this turn (will retry)`);
            await clearAttachments();
            await clearComposer();
            return { ok: false };
        }
        log(`  attached ${ref.name}`);
    }

    // 2. Prompt.
    await typePrompt(promptText);

    // 3. Baseline AFTER attaching, immediately BEFORE send. This is what makes it
    //    structurally impossible for the delta to contain a reference we attached.
    const baseline = new Set(generatedImgs());

    // clickSend() waits for Send to become ENABLED. Gemini keeps it disabled while an
    // attachment is still uploading, so this is also the guard that we never send a
    // half-uploaded reference.
    await clickSend();
    await sleep(3000);

    if (seesRateLimit()) return { rateLimited: true };

    const fresh = await waitForGeneratedImage(baseline);
    if (seesRateLimit() && !fresh.length) return { rateLimited: true };

    if (!fresh.length) {
        log('No image captured for this turn');
        dumpImageDom();
        return { ok: false };
    }

    // Exactly one image was requested, so the newest one IS the answer.
    await saveImage(fresh[fresh.length - 1], filename, refPrints);
    return { ok: true };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function runGeminiImages(project) {
    const pid   = project.id;
    const page  = project.page;
    const total = project.total_scenes;

    log(`=== GEMINI IMAGE PHASE: ${pid} page=${page} scenes=${total} ===`);
    report('Gemini: waiting for the composer...');
    await waitForReady();

    if (DIAG === 'image') { dumpImageDom(); return; }

    // Model set-up needs the tab in the foreground (Angular overlay). Take a turn.
    report('Gemini: waiting for UI turn...');
    await acquireUiTurn();
    try {
        report('Gemini: setting model (3.1 Pro + Extended)...');
        dismissOnboarding();
        await ensureProExtended();
    } finally {
        releaseUiTurn();
    }

    // References that stay constant for the whole reel.
    const charBytes = await charSheetBytes(project);
    let storyBytes = null;
    try {
        storyBytes = await fetchRef(`pages/${page}/working/${pid}-storyboard.png`);
    } catch {
        log('WARNING: storyboard not on server — scenes will be generated without it');
    }

    const constRefs = [];
    if (charBytes)  constRefs.push({ bytes: charBytes,  name: 'character-sheet.png' });
    if (storyBytes) constRefs.push({ bytes: storyBytes, name: `${pid}-storyboard.png` });

    // The N-1 chain. Starts empty; each successful scene becomes the next one's ref.
    // If a scene fails, the chain holds the last scene that DID succeed, so the look
    // still carries forward instead of resetting.
    let prevBytes = null, prevName = '';

    let backoffs = 0;

    for (let n = 1; n <= total; n++) {
        if (await isStopped(pid)) { log('Stopped by user'); return; }

        const nn = String(n).padStart(2, '0');

        // Resume: a scene already on disk is never redone (this is what makes a
        // re-run after a crash / partial reel cheap, and what a manual redo relies on).
        if (await isOnDisk(page, pid, nn)) {
            log(`scene ${nn}: already on disk — skipping`);
            try { prevBytes = await fetchRef(`pages/${page}/working/${pid}-scene-${nn}.png`);
                  prevName = `${pid}-scene-${nn}.png`; } catch {}
            continue;
        }

        const scene = project.scenes.find(s => s.scene_num === n);
        const body = cutAtEndMarker((scene?.image_prompt || '').trim(), 'IMAGE');
        if (!body) { log(`scene ${nn}: no prompt — skipping`); continue; }

        // The prompt goes in VERBATIM — it already carries `--ar 9:16`.
        const promptText =
            `Generate exactly ONE image for this single scene.\n\n` +
            `## SCENE ${n} IMAGE PROMPT\n\n${body}`;

        let attempts = 0;
        while (attempts < MAX_ATTEMPTS_PER_SCENE) {
            if (await isStopped(pid)) { log('Stopped by user'); return; }

            const refs = [...constRefs];
            if (prevBytes) refs.push({ bytes: prevBytes, name: prevName });

            report(`Scene ${nn}/${total} (attempt ${attempts + 1}/${MAX_ATTEMPTS_PER_SCENE})...`);
            let r;
            try {
                r = await generateOne(refs, promptText, `${pid}-scene-${nn}.png`);
            } catch (e) {
                log(`scene ${nn}: ${e.message}`);
                r = { ok: false };
            }

            // A throttle is NOT a failure — it must never consume an attempt, or a few
            // throttles silently drop the scene (the "stuck at 3/10" bug from flow.js).
            if (r.rateLimited) {
                backoffs++;
                if (backoffs > MAX_RATE_LIMIT_BACKOFFS) {
                    log(`Rate limited ${backoffs} times — stopping honestly`);
                    report('⚠ Gemini rate limited — re-run later to finish');
                    chrome.runtime.sendMessage({ action: 'imagesRateLimited', projectId: pid })
                        .catch(() => {});
                    return;
                }
                log(`Rate limited — backing off ${RATE_LIMIT_BACKOFF_MS / 1000}s (${backoffs}/${MAX_RATE_LIMIT_BACKOFFS})`);
                report(`⏳ Rate limited — waiting ${RATE_LIMIT_BACKOFF_MS / 1000}s...`);
                await sleep(RATE_LIMIT_BACKOFF_MS);
                continue;   // same scene, same attempt budget
            }

            attempts++;
            if (r.ok && await isOnDisk(page, pid, nn)) {
                log(`✓ scene-${nn}.png`);
                try {
                    prevBytes = await fetchRef(`pages/${page}/working/${pid}-scene-${nn}.png`);
                    prevName  = `${pid}-scene-${nn}.png`;
                } catch {}
                break;
            }
            log(`scene ${nn}: attempt ${attempts} did not produce a usable image`);
        }

        if (!await isOnDisk(page, pid, nn)) {
            // Do not abort the reel — later scenes still generate, and the N-1 chain
            // falls back to the last scene that worked.
            log(`WARNING: scene ${nn} failed after ${MAX_ATTEMPTS_PER_SCENE} attempts — moving on`);
        }
    }

    // ── Thumbnail (character sheet only, matching ChatGPT's Phase C) ───────────
    // Skipped when it already exists, exactly like Phase C: a re-run to fix ONE bad
    // scene must not overwrite a good thumbnail (and burn a generation doing it).
    const thumbPrompt = (project.thumbnail_prompt || '').trim();
    if (thumbPrompt && await thumbOnDisk(page, pid)) {
        log('Thumbnail already on disk — skipping');
    } else if (thumbPrompt && !(await isStopped(pid))) {
        report('Thumbnail...');
        const refs = charBytes ? [{ bytes: charBytes, name: 'character-sheet.png' }] : [];
        try {
            const r = await generateOne(refs, cutAtEndMarker(thumbPrompt, 'THUMBNAIL'),
                                        `${pid}-thumbnail.png`);
            if (r.ok) log('✓ thumbnail.png');
            else log('WARNING: no thumbnail generated');
        } catch (e) {
            log(`WARNING: thumbnail failed: ${e.message}`);
        }
    }

    const missing = await getDiskMissingScenes(pid);
    if (missing.length) {
        log(`WARNING: finished with ${missing.length} scene(s) missing: ${missing.join(', ')}`);
        report(`⚠ ${missing.length} image(s) could not be generated (scenes ${missing.join(', ')})`);
    } else {
        log('All scene images confirmed on disk ✓');
    }

    log(`=== GEMINI IMAGE PHASE COMPLETE: ${pid} ===`);
    report('Images complete ✓');
    // Same message the ChatGPT path sends — background.js then opens Flow. The whole
    // video pipeline downstream is untouched.
    chrome.runtime.sendMessage({ action: 'imagesComplete', projectId: pid }).catch(() => {});
}

// ── Message listener ──────────────────────────────────────────────────────────

let _running = false;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'uiGranted') {
        if (_uiGrantResolve) { const r = _uiGrantResolve; _uiGrantResolve = null; r(); }
        sendResponse({ ok: true });
        return false;
    }
    if (msg.action === 'startGeminiImages' && !_running) {
        _running = true;
        runGeminiImages(msg.project)
            .catch(e => {
                log(`FATAL: ${e.message}`);
                chrome.runtime.sendMessage({ action: 'error', message: e.message }).catch(() => {});
            })
            .finally(() => { _running = false; releaseUiTurn(); });
    }
    sendResponse({ ok: true });
    return false;
});

(async () => {
    await sleep(1500);
    chrome.runtime.sendMessage({ action: 'tabReady', type: 'gemini' }).catch(() => {});
    log('Ready');
})();

})();
