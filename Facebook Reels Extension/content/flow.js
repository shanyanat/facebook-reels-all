'use strict';

const API = 'http://localhost:7788';
const sleep  = ms => new Promise(r => setTimeout(r, ms));
// jitter(min, range) — sleep at least `min` ms, up to `min + range` ms
const jitter = (min, range) => sleep(min + Math.floor(Math.random() * range));
// log() both prints to console AND forwards to the side panel as a progress update
const log = msg => {
    console.log(`[flow-ext] ${msg}`);
    chrome.runtime.sendMessage({ action: 'progress', text: msg }).catch(() => {});
};

// ── DOM utilities ─────────────────────────────────────────────────────────────

function dispatchPointerClick(el) {
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const opts = { bubbles: true, cancelable: true, clientX: cx, clientY: cy, view: window };
    for (const type of ['pointerover','pointerenter','mouseover','mouseenter',
                        'pointermove','mousemove','pointerdown','mousedown',
                        'pointerup','mouseup','click']) {
        el.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, opts));
    }
}

function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
}

function findVisible(selector, root = document) {
    for (const el of root.querySelectorAll(selector))
        if (isVisible(el)) return el;
    return null;
}

async function waitFor(fn, timeout = 30000, interval = 500) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
        try { const r = fn(); if (r) return r; } catch {}
        await sleep(interval);
    }
    throw new Error(`waitFor timeout (${timeout}ms)`);
}

function cutAtEndMarker(text, section) {
    const re = new RegExp(
        `^[^\\n]*the\\s+end\\s+of\\s+${section.replace(/\s+/g,'\\\\s+')}\\s+prompts?[^\\n]*`,
        'im'
    );
    const m = text.match(re);
    if (m) return text.slice(0, m.index).trimEnd();
    const lines = text.trimEnd().split('\n');
    if (lines.length && /^---.*---$/.test(lines[lines.length - 1].trim()) &&
        lines[lines.length - 1].trim().length > 6) lines.pop();
    return lines.join('\n').trimEnd();
}

async function isStopped(projectId) {
    try {
        const r = await chrome.storage.local.get('reel_gen_state');
        const state = r['reel_gen_state'];
        if (!state) return false;
        const slot = state.slots.find(s => s.projectId === projectId);
        return !slot || slot.stopping === true || slot.status === 'idle';
    } catch { return false; }
}

async function fetchFromServer(relPath) {
    const res = await fetch(`${API}/file/${relPath}`);
    if (!res.ok) throw new Error(`Server file not found: ${relPath} (${res.status})`);
    return res.blob();
}

// ── Flow UI helpers ───────────────────────────────────────────────────────────

async function clickNewProject() {
    const names = ['โปรเจกต์ใหม่', 'โปรเจ็กต์ใหม่', 'New project', 'New Project'];
    const end = Date.now() + 30000;
    while (Date.now() < end) {
        for (const name of names) {
            for (const el of document.querySelectorAll('button, [role="button"], a')) {
                if ((el.textContent || '').trim().includes(name) && isVisible(el)) {
                    el.click();
                    await sleep(2500);
                    log(`New project clicked: "${name}"`);
                    return;
                }
            }
        }
        await sleep(1000);
    }
    throw new Error('New project button not found');
}

async function waitForCompose() {
    const SELS = ['textarea', '[contenteditable="true"]', '[role="textbox"]'];
    for (const sel of SELS) {
        try {
            await waitFor(() => findVisible(sel), 20000, 500);
            await sleep(800);
            log('Compose bar ready ✓');
            return;
        } catch {}
    }
    log('WARNING: Compose bar not detected — continuing anyway');
    await sleep(3000);
}

async function configureVideoSettings(aspectRatio = '9:16') {
    const vh = window.innerHeight;
    log('Configuring settings...');

    // Click the model pill (shortest button in bottom-half containing "x")
    const btns = [...document.querySelectorAll('button, [role="button"]')]
        .filter(el => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && r.top > vh * 0.6;
        })
        .sort((a, b) => a.textContent.length - b.textContent.length);

    for (const btn of btns) {
        if (/\dx/.test(btn.textContent) && btn.textContent.length <= 80) {
            btn.click(); await sleep(800); log('Settings pill clicked'); break;
        }
    }

    // Click วิดีโอ tab
    for (const el of document.querySelectorAll('button, [role="tab"]')) {
        const t = (el.textContent || '').trim();
        if ((t === 'วิดีโอ' || t === 'Video') && isVisible(el)) {
            el.click(); await sleep(600); log('Tab: วิดีโอ'); break;
        }
    }

    await sleep(400);

    // Aspect ratio
    const iconName = aspectRatio === '9:16' ? 'crop_9_16' : 'crop_16_9';
    for (const el of document.querySelectorAll("button, [role='option'], [aria-label]")) {
        const combined = ((el.textContent || '') + ' ' + (el.getAttribute('aria-label') || '')).toLowerCase();
        if (combined.includes(aspectRatio.toLowerCase()) || combined.includes(iconName.toLowerCase())) {
            el.click(); await sleep(300); log(`Aspect ratio: ${aspectRatio}`); break;
        }
    }

    // 1x multiplier
    for (const el of document.querySelectorAll("button, [role='option']")) {
        if ((el.textContent || '').trim() === '1x' && isVisible(el)) {
            el.click(); await sleep(300); log('Set: 1x'); break;
        }
    }

    // Open Veo model dropdown
    for (const btn of document.querySelectorAll('button')) {
        if ((btn.textContent || '').includes('Veo') && isVisible(btn)) {
            btn.click(); await sleep(800); log('Veo dropdown opened'); break;
        }
    }
    await sleep(500); // extra wait for dropdown to render

    // Select Lite option — retry up to 3x in case dropdown is still animating
    let liteFound = false;
    for (let attempt = 0; attempt < 3 && !liteFound; attempt++) {
        if (attempt > 0) await sleep(600);
        for (const el of document.querySelectorAll("[role='option'], [role='menuitem'], li, button")) {
            if ((el.textContent || '').includes('Lite') && isVisible(el)) {
                dispatchPointerClick(el);
                await sleep(400); log('Set: Veo Lite'); liteFound = true; break;
            }
        }
    }
    if (!liteFound) log('WARNING: Veo Lite option not found');

    // Close settings panel
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(500);
    log('Settings configured ✓');
}

async function clickStartFrameSlot() {
    // Exact-text match — same logic as original bot.py _try_first_frame_upload
    const keywords = ['เริ่ม', 'Start', 'เริ่มต้น'];
    for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) await sleep(1000);
        for (const el of document.querySelectorAll('button, [role="button"], div[class], span[class]')) {
            if (!isVisible(el)) continue;
            const txt = (el.textContent || '').trim();
            if (keywords.includes(txt)) {
                el.click();
                log(`Clicked Start frame slot: "${txt}"`);
                return true;
            }
        }
    }
    // Spatial fallback: element to the left of swap_horiz button (mirrors bot.py)
    const swapBtn = [...document.querySelectorAll('button')]
        .find(b => (b.textContent || '').includes('swap_horiz'));
    if (swapBtn) {
        const sr = swapBtn.getBoundingClientRect();
        for (const xOff of [100, 70, 140, 50]) {
            const x = sr.left - xOff;
            if (x < 50) continue;
            const el = document.elementFromPoint(x, sr.top + sr.height / 2);
            if (!el || el === swapBtn || el === document.body) continue;
            el.click();
            log(`Clicked Start frame slot via spatial offset ${xOff}`);
            return true;
        }
    }
    log('WARNING: Start frame slot button not found');
    return false;
}

async function waitForUploadComplete(filename, maxWait = 30000) {
    // Bot.py uses Playwright set_files() which auto-selects the file.
    // The extension's DataTransfer injection uploads the file but does NOT auto-select it.
    // So we must CLICK the file item in the media browser list to select it,
    // which reveals the preview and makes "Add to Prompt" appear.
    const nameNoExt = filename.replace(/\.[^.]+$/, '');
    const end = Date.now() + maxWait;
    // Snapshot of all img srcs before the file item appears (to detect new thumbnails)
    const beforeSrcs = new Set([...document.querySelectorAll('img')].map(i => i.src).filter(Boolean));

    while (Date.now() < end) {
        // Done: Add to Prompt is visible (file was selected successfully)
        for (const el of document.querySelectorAll('button, [role="button"]')) {
            const t = (el.textContent || '').trim();
            if ((t.includes('เพิ่มไปยังพรอมต์') || t.includes('Add to prompt')) && isVisible(el)) {
                log('Upload complete — Add to Prompt visible');
                return;
            }
        }

        // Strategy 1: find element whose OWN text = filename (leaf text node),
        // then walk up to the nearest row-like container and click that.
        let clicked = false;
        for (const el of document.querySelectorAll('span, p, div')) {
            if (!isVisible(el)) continue;
            if (el.querySelectorAll('img, button, input, textarea').length > 0) continue;
            const txt = (el.textContent || '').trim();
            if (txt !== filename && txt !== nameNoExt) continue;
            let target = el;
            for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
                const r = p.getBoundingClientRect();
                const tag = p.tagName.toLowerCase();
                const role = p.getAttribute('role') || '';
                if (tag === 'li' || ['option', 'row', 'listitem', 'gridcell'].includes(role)) {
                    target = p; break;
                }
                if (tag === 'div' && r.height >= 40 && r.height <= 100 && r.width >= 100 && r.width <= 500) {
                    target = p;
                }
            }
            target.scrollIntoView({ block: 'center' });
            await sleep(100);
            try { target.focus(); } catch {}
            dispatchPointerClick(target);
            try { HTMLElement.prototype.click.call(target); } catch {}
            log(`Selected file (text match): "${txt}"`);
            clicked = true;
            await sleep(600);
            break;
        }

        // Strategy 2: a new thumbnail img appeared after injection — click its row container.
        if (!clicked) {
            for (const img of document.querySelectorAll('img')) {
                const src = img.src || '';
                if (!src || beforeSrcs.has(src) || !isVisible(img)) continue;
                const r = img.getBoundingClientRect();
                if (r.width < 20 || r.width > 200 || r.height < 20) continue; // skip icons / full images
                let target = img;
                for (let p = img.parentElement; p && p !== document.body; p = p.parentElement) {
                    const rp = p.getBoundingClientRect();
                    if (rp.height >= 40 && rp.height <= 120 && rp.width >= 80 && rp.width <= 500) target = p;
                    if (rp.width > 500) break;
                }
                target.scrollIntoView({ block: 'center' });
                await sleep(100);
                try { target.focus(); } catch {}
                dispatchPointerClick(target);
                try { HTMLElement.prototype.click.call(target); } catch {}
                log('Selected file (thumbnail match)');
                beforeSrcs.add(src);
                clicked = true;
                await sleep(600);
                break;
            }
        }

        await sleep(500);
    }
    log('WARNING: upload/select not confirmed after 30s — proceeding');
}

function findAddToPromptBtn() {
    const keywords = ['เพิ่มไปยังพรอมต์', 'Add to prompt'];
    for (const el of document.querySelectorAll('button, [role="button"]')) {
        const t = (el.textContent || '').trim();
        if (keywords.some(k => t.includes(k)) && isVisible(el)) return el;
    }
    return null;
}

async function clickAddToPrompt() {
    for (let attempt = 0; attempt < 10; attempt++) {
        if (attempt > 0) await sleep(800);
        const el = findAddToPromptBtn();
        if (!el) continue;

        // Ensure element is in viewport
        el.scrollIntoView({ block: 'center', inline: 'center' });
        await sleep(200);

        // Focus first (some frameworks require focus before click)
        try { el.focus(); } catch {}
        await sleep(100);

        // Fire full pointer+mouse event chain, then native click
        dispatchPointerClick(el);
        try { HTMLElement.prototype.click.call(el); } catch {}

        await sleep(1500);

        // Verify panel closed — "Add to Prompt" button should be gone
        if (!findAddToPromptBtn()) {
            log(`Clicked: เพิ่มไปยังพรอมต์ (confirmed closed, attempt ${attempt + 1})`);
            return true;
        }
        log(`Attempt ${attempt + 1}: panel still open — retrying`);
    }
    log('WARNING: เพิ่มไปยังพรอมต์ — could not close panel after 10 attempts');
    return false;
}

async function uploadSceneImage(blob, filename) {
    log(`Uploading: ${filename}...`);
    const file = new File([blob], filename, { type: 'image/png' });

    // Step 1: Click "เริ่ม/Start" — opens the media browser panel
    log('Step 1: Clicking Start frame slot...');
    await clickStartFrameSlot();
    await jitter(2500, 2500); // 2.5–5s: media browser opening (extra time for slow connections)

    // Step 2: Find "อัปโหลดสื่อ/Upload media" button, then click it while intercepting
    // the file input's .click() call so the native OS dialog never opens.
    // We capture the file input reference and inject our file directly.
    // This mirrors Playwright's expect_file_chooser() used in the original bot.py.
    log('Step 2: Finding อัปโหลดสื่อ and intercepting file input click...');
    const uploadKeywords = ['อัปโหลดสื่อ', 'Upload media', 'Upload'];
    let uploadBtn = null;
    for (let attempt = 0; attempt < 10 && !uploadBtn; attempt++) {
        await sleep(800);
        for (const el of document.querySelectorAll('button, [role="button"], a, li')) {
            const t = (el.textContent || '').trim();
            if (uploadKeywords.some(k => t.includes(k)) && isVisible(el)) {
                uploadBtn = el;
                break;
            }
        }
    }
    if (!uploadBtn) log('WARNING: อัปโหลดสื่อ button not found — falling back to DOM lookup');

    // Override input[type=file].click() to suppress native dialog and capture element
    let capturedInput = null;
    const origInputClick = HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click = function () {
        if (this.type === 'file') { capturedInput = this; return; } // suppress OS dialog
        origInputClick.call(this);
    };
    if (uploadBtn) uploadBtn.click();
    // The file input click fires synchronously inside the button's event handler
    HTMLInputElement.prototype.click = origInputClick; // restore immediately

    // Fallback: if override didn't capture anything, check DOM directly
    if (!capturedInput) capturedInput = document.querySelector("input[type='file']");
    if (!capturedInput) {
        // Some apps add the input asynchronously — wait briefly
        try { await waitFor(() => document.querySelector("input[type='file']"), 5000, 300); }
        catch {}
        capturedInput = document.querySelector("input[type='file']");
    }
    if (!capturedInput) throw new Error('File input not found — cannot upload image');

    // Step 3: Inject file (equivalent to user selecting it through the file dialog)
    log(`Step 3: Injecting file: ${filename}`);
    const dt = new DataTransfer();
    dt.items.add(file);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files').set.call(capturedInput, dt.files);
    capturedInput.dispatchEvent(new Event('change', { bubbles: true }));
    capturedInput.dispatchEvent(new Event('input', { bubbles: true }));

    // Step 4: Wait for the file to appear in the media browser list, then click
    // it to select it — only after selection does "Add to Prompt" become available
    log('Step 4: Waiting for file to appear in media browser and selecting it...');
    await waitForUploadComplete(filename, 60000);

    // Step 5: Click "เพิ่มไปยังพรอมต์/Add to Prompt"
    log('Step 5: Clicking Add to Prompt...');
    const added = await clickAddToPrompt();
    if (!added) throw new Error('Add to Prompt button not found after upload');
    log(`✓ Image attached to prompt: ${filename}`);
}

async function fillVideoPrompt(text) {
    // Google Flow uses Slate.js. ANY browser-level selection change on the editor
    // (execCommand, getSelection().addRange, etc.) fires selectionchange →
    // Slate calls toSlateRange() on container nodes → crashes.
    //
    // The only crash-free path: call editor.insertText() directly via Slate's own
    // API. Content scripts run in an isolated world with no React/Slate access, so
    // we ask background.js to use chrome.scripting.executeScript(world:'MAIN').
    const resp = await chrome.runtime.sendMessage({ action: 'fillSlate', text }).catch(() => null);

    await sleep(300);
    const slateEl = document.querySelector('[data-slate-editor="true"]');
    const actual  = (slateEl?.textContent || '').trim();

    if (actual.length > 0) {
        log(`Prompt filled (${text.length} chars via Slate main-world, bg=${resp?.result})`);
        return;
    }

    if (resp && !resp.ok) {
        log(`Slate main-world failed: ${resp.result || resp.error}`);
    }

    // Fallback for plain textarea / input (non-Slate editors)
    const vh = window.innerHeight;
    for (const sel of ['textarea', 'input[type="text"]']) {
        const els = [...document.querySelectorAll(sel)].filter(el => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && r.top > vh * 0.4;
        });
        if (!els.length) continue;
        const el = els.sort((a, b) =>
            b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0];
        el.click(); await sleep(200); el.focus(); await sleep(200);
        const proto  = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value');
        if (setter?.set) setter.set.call(el, text); else el.value = text;
        el.dispatchEvent(new Event('input',  { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        if ((el.value || '').trim().length > 0) {
            log(`Prompt filled (${text.length} chars via "${sel}")`);
            return;
        }
    }
    log('WARNING: Prompt input not found — compose bar may not be ready');
}

async function clickGenerate() {
    // Primary: click the arrow_forward/สร้าง button via main-world executeScript.
    // btn.click() in MAIN world fires React's real onClick (reads Slate internal state).
    const resp = await chrome.runtime.sendMessage({ action: 'clickGenerateSlate' }).catch(() => null);
    if (resp?.ok) {
        await jitter(1000, 1500); // 1–2.5s: settle after button click
        log(`Generate: ${resp.result}`);
        return;
    }
    log(`Generate main-world failed (${resp?.result || resp?.error}) — trying fallbacks`);

    const vh = window.innerHeight;

    // Fallback A: dispatchPointerClick on arrow_forward / สร้าง button
    for (const btn of [...document.querySelectorAll('button, [role="button"]')].reverse()) {
        if (!isVisible(btn) || btn.disabled) continue;
        const r = btn.getBoundingClientRect();
        if (r.top < vh * 0.3) continue;
        const t = (btn.textContent || '').trim();
        if (['arrow_forward', 'สร้าง', 'ส่ง'].some(k => t.includes(k))) {
            dispatchPointerClick(btn);
            try { HTMLElement.prototype.click.call(btn); } catch {}
            await sleep(1000);
            log(`Generate: fallback button click (${t.substring(0, 20)})`);
            return;
        }
    }

    // Fallback B: rightmost button beside the compose input
    const inputRect = (() => {
        for (const sel of ['[data-slate-editor="true"]', '[role="textbox"]',
                           'textarea', '[contenteditable="true"]']) {
            const els = [...document.querySelectorAll(sel)].filter(el => {
                const r = el.getBoundingClientRect();
                return r.width > 0 && r.height > 0 && r.top > vh * 0.3;
            });
            if (els.length) return els.sort((a, b) =>
                b.getBoundingClientRect().top - a.getBoundingClientRect().top
            )[0].getBoundingClientRect();
        }
        return null;
    })();

    if (inputRect) {
        const rightBtns = [...document.querySelectorAll('button, [role="button"]')]
            .filter(b => {
                if (!isVisible(b) || b.disabled) return false;
                const r = b.getBoundingClientRect();
                return r.left >= inputRect.right - 10 &&
                       Math.abs(r.top - inputRect.top) < 120;
            })
            .sort((a, b) => b.getBoundingClientRect().left - a.getBoundingClientRect().left);
        for (const b of rightBtns) {
            dispatchPointerClick(b);
            try { HTMLElement.prototype.click.call(b); } catch {}
            await sleep(1000);
            log(`Generate: spatial button (${(b.textContent || '').trim().substring(0, 20)})`);
            return;
        }
    }

    throw new Error('Generate button not found — compose bar may not be focused');
}

function countVideoClips() {
    return document.querySelectorAll('video').length;
}

async function waitForVideoReady(clipsBefore, timeout = 150) {
    log(`Waiting for video (before=${clipsBefore}, max ${timeout}s)...`);
    const start = Date.now();

    while (Date.now() - start < timeout * 1000) {
        const elapsed = Math.round((Date.now() - start) / 1000);

        // Rate limit: Google shows "unusual activity" when the API quota is exceeded.
        // This is temporary — reload and retry rather than stopping permanently.
        if (document.body.innerText.toLowerCase().includes('unusual activity') ||
            document.body.innerText.toLowerCase().includes('กิจกรรมที่ผิดปกติ')) {
            log('⚠ Rate limit detected (unusual activity) — will reload and retry');
            return false;
        }

        // Error detection
        for (const el of document.querySelectorAll('[role="alert"], [class*="error" i]')) {
            const t = el.textContent.toLowerCase();
            if (['error', 'failed', 'ล้มเหลว', 'something went wrong'].some(e => t.includes(e))) {
                log(`Generation error at ${elapsed}s`);
                return false;
            }
        }

        // New clip ready?
        const card = getVideoCardEl(clipsBefore);
        if (card) {
            const src = card.v.src || card.v.currentSrc || '';
            if (src && !src.startsWith('blob:') && src.length > 10) {
                log(`✓ Video ready at ${elapsed}s`);
                return true;
            }
        }

        if (elapsed > 0 && elapsed % 30 === 0) log(`  ${elapsed}s: generating...`);
        await sleep(5000);
    }
    log(`WARNING: Timed out after ${timeout}s`);
    return false;
}

// Fetch the generated video and POST it directly to monitor.py's /save_video endpoint.
// This saves to pages/<page>/working/ with no browser download dialog.
// Falls back to the background blob-download if monitor.py is unreachable.
async function downloadVideoToServer(videoUrl, filename) {
    log(`Fetching video: ${filename} ...`);
    const resp = await fetch(videoUrl);
    if (!resp.ok) throw new Error(`Video fetch failed: ${resp.status} ${resp.url}`);

    const buf = await resp.arrayBuffer();
    const sizeKb = Math.round(buf.byteLength / 1024);
    log(`Video fetched: ${sizeKb} KB — encoding for save...`);

    // Chunk base64 encoding to avoid stack overflow on large buffers
    const bytes = new Uint8Array(buf);
    const CHUNK = 8192;
    let binary = '';
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
    }
    const base64 = btoa(binary);

    // Try primary: POST to monitor.py directly → saves to working/, updates status
    try {
        const saveResp = await fetch('http://localhost:7788/save_video', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename, base64 })
        });
        if (saveResp.ok) {
            log(`✓ ${filename} saved directly to working/ (${sizeKb} KB)`);
            return;
        }
        log(`save_video returned ${saveResp.status} — falling back to downloads folder`);
    } catch (e) {
        log(`save_video unreachable (${e.message}) — falling back to downloads folder`);
    }

    // Fallback: send blob to background.js → downloads to Downloads folder
    // monitor.py's DownloadsHandler picks it up and moves it to working/.
    await chrome.runtime.sendMessage({
        action: 'downloadImageBlob',   // reuses the same blob-download handler
        base64,
        mimeType: 'video/mp4',
        filename
    });
    log(`✓ ${filename} queued via background blob download (${sizeKb} KB)`);
}

function getVideoCardEl(clipsBefore = -1) {
    const videos = [...document.querySelectorAll('video')];
    if (videos.length <= clipsBefore) return null;
    const cards = [];
    for (const v of videos) {
        let el = v.parentElement;
        while (el && el !== document.body) {
            const r = el.getBoundingClientRect();
            if (r.width >= 80 && r.width <= 600 && r.height >= 80 && r.top > 40) {
                cards.push({ left: r.left, top: r.top, el, v });
                break;
            }
            el = el.parentElement;
        }
    }
    if (!cards.length) return null;
    const minTop = Math.min(...cards.map(c => c.top));
    return cards.filter(c => c.top <= minTop + 20).sort((a, b) => a.left - b.left)[0];
}

async function getContextMenuVideoUrl(cardEl) {
    const rect = cardEl.getBoundingClientRect();
    const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
    cardEl.dispatchEvent(new MouseEvent('contextmenu',
        { bubbles: true, cancelable: true, clientX: cx, clientY: cy }));
    await sleep(800);

    // Find ดาวน์โหลด / Download menu item
    const dlKeywords = ['ดาวน์โหลด', 'Download', 'download'];
    let dlItem = null;
    for (const el of document.querySelectorAll('[role="menuitem"], li, a, button')) {
        const t = (el.textContent || '').trim();
        if (dlKeywords.includes(t) && isVisible(el)) { dlItem = el; break; }
    }
    if (!dlItem) {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return null;
    }

    // Hover to reveal resolution submenu
    dlItem.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    dlItem.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    await sleep(600);

    // Read URL from quality submenu (1080p preferred, fallback to 720p / 480p)
    let url = null;
    for (const quality of ['1080', '720', '480']) {
        for (const el of document.querySelectorAll('[role="menuitem"], li, a, button')) {
            if (!isVisible(el) || !(el.textContent || '').includes(quality)) continue;
            url = el.href || el.dataset.url ||
                  el.getAttribute('href') || el.getAttribute('data-url');
            if (url) { log(`Context menu: ${quality}p URL found`); break; }
        }
        if (url) break;
    }

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(300);
    return url;
}

async function waitForFileInWorking(page, filename, timeoutMs = 180000) {
    const url = `${API}/file/pages/${page}/working/${filename}`;
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
        try {
            const r = await fetch(url, { method: 'HEAD' });
            if (r.ok) return true;
        } catch {}
        await sleep(3000);
    }
    return false;
}

// ── Main video phase ──────────────────────────────────────────────────────────

// chrome.storage.local helpers — survive page reloads reliably (sessionStorage
// can be wiped by Google Flow's own JS during page init before our content script runs).

async function getSceneFails(pid, nn) {
    const key = `scene_fails_${pid}_${nn}`;
    const r = await chrome.storage.local.get(key);
    return parseInt(r[key] || '0');
}

async function setSceneFails(pid, nn, count) {
    await chrome.storage.local.set({ [`scene_fails_${pid}_${nn}`]: count });
}

async function clearSceneFails(pid, allScenes) {
    const keys = allScenes.map(s => `scene_fails_${pid}_${String(s.scene_num).padStart(2, '0')}`);
    if (keys.length) await chrome.storage.local.remove(keys);
}

async function isRetryAfterReload(pid) {
    const r = await chrome.storage.local.get(`flow_retry_${pid}`);
    return r[`flow_retry_${pid}`] === '1';
}

async function clearRetryFlag(pid) {
    // Remove both the pid-scoped key and the old global key (cleans up stale leftovers).
    await chrome.storage.local.remove([`flow_retry_${pid}`, 'flow_retry']);
}

async function reloadForRetry(pid, reason) {
    log(`${reason} — reloading page for clean retry`);
    // Flag tells the next run (after reload) to skip clickNewProject + settings —
    // the page reloads back into the same project, compose bar already ready.
    await chrome.storage.local.set({ [`flow_retry_${pid}`]: '1' });
    await sleep(2000);
    window.location.reload();
    // Execution stops here. Page reload fires tabReady → background re-sends
    // startVideos with fresh contents.json, so only remaining scenes are processed.
}

async function runVideos(project) {
    const pid   = project.id;
    const page  = project.page;
    const ratio = project.aspect_ratio || '9:16';

    log(`=== VIDEO PHASE START: ${pid} ===`);

    // Decide what to generate from DISK truth, not contents.json flags. monitor.py
    // adds img_on_disk / vdo_on_disk per scene; the flags can lag behind the real
    // files under concurrent saves, which used to make this list wrongly empty and
    // report a false "Complete". Fall back to flags only if an older monitor.py is
    // running (fields absent).
    const hasDiskInfo = project.scenes.some(s => s.img_on_disk !== undefined);
    const needsVideo  = s => hasDiskInfo
        ? (s.img_on_disk && !s.vdo_on_disk)
        : (s.image_status === 'done' && s.video_status !== 'done');
    const isDone      = s => hasDiskInfo ? !!s.vdo_on_disk : s.video_status === 'done';

    const scenes = project.scenes.filter(needsVideo);
    let doneCount = project.scenes.filter(isDone).length;

    // Nothing to generate — report honestly BEFORE the misleading new-project setup.
    if (scenes.length === 0) {
        const missingImage = hasDiskInfo
            ? project.scenes.filter(s => !s.img_on_disk && !s.vdo_on_disk)
            : [];
        if (missingImage.length > 0) {
            log(`No video work: ${missingImage.length} scene(s) have no image on disk — run Images first`);
            chrome.runtime.sendMessage({ action: 'videosNeedsImages', projectId: pid, count: missingImage.length });
        } else {
            log(`All ${project.total_scenes} videos already on disk — nothing to do`);
            chrome.runtime.sendMessage({ action: 'videosComplete', projectId: pid });
        }
        return;
    }

    // Check if this is a retry after our own page reload (flag set by reloadForRetry).
    // In that case the page reloads back into the same project — compose bar is already
    // there, no need to click โปรเจ็กต์ใหม่ again.
    // On a fresh tab start the flag is absent, so we always do full setup.
    const isRetry = await isRetryAfterReload(pid);
    await clearRetryFlag(pid);

    if (isRetry) {
        log('Retry after reload — skipping New Project setup, compose bar already ready');
        await waitForCompose();
        await sleep(500);
    } else {
        await clickNewProject();
        await waitForCompose();
        log('⏳ Waiting 20s — please configure model, ratio, quantity and dismiss any panels...');
        await sleep(20000);
        await sleep(500);
    }

    log(`${doneCount}/${project.total_scenes} already done — processing ${scenes.length} remaining`);

    const SCENE_MAX_FAILS = 5;
    let anySceneSkipped = false;

    for (let i = 0; i < scenes.length; i++) {
        const scene = scenes[i];
        const nn = String(scene.scene_num).padStart(2, '0');
        log(`--- Scene ${nn} | ${doneCount}/${project.total_scenes} done ---`);

        if (await isStopped(pid)) { log(`Stopped before scene ${nn}`); return; }

        const prevFails = await getSceneFails(pid, nn);
        if (prevFails >= SCENE_MAX_FAILS) {
            log(`Scene ${nn}: skipped after ${prevFails} total failures — moving to next scene`);
            anySceneSkipped = true;
            continue;
        }

        let success = false;
        let reloadReason = '';

        for (let attempt = 1; attempt <= 2 && !success && !reloadReason; attempt++) {
            if (attempt > 1) {
                log(`Scene ${nn}: retry ${attempt}/2`);
                await jitter(2500, 2500);
            }

            try {
                const imgPath = `pages/${page}/working/${pid}-scene-${nn}.png`;
                const imgBlob = await fetchFromServer(imgPath);

                await uploadSceneImage(imgBlob, `${pid}-scene-${nn}.png`);
                await jitter(4000, 3500); // 4–7.5s: let compose bar settle after panel closes

                const videoPrompt = cutAtEndMarker(scene.video_prompt.trim(), 'VIDEO')
                    + '\n\n--- The End of VIDEO PROMPTS ---';
                await fillVideoPrompt(videoPrompt);
                await jitter(1500, 1500); // 1.5–3s: wait for Slate re-render

                const clipsBefore = countVideoClips();
                await clickGenerate();

                const ready = await waitForVideoReady(clipsBefore, 150);
                if (!ready) {
                    reloadReason = `Scene ${nn}: generation failed/timed out`;
                    break;
                }

                const videoFilename = `${pid}-scene-${nn}-vdo.mp4`;
                const card = getVideoCardEl(clipsBefore);

                // Primary: context-menu 1080p URL → native browser download
                const menuUrl = card ? await getContextMenuVideoUrl(card.el) : null;
                if (menuUrl) {
                    await chrome.runtime.sendMessage({
                        action: 'downloadVideo', videoUrl: menuUrl, filename: videoFilename
                    });
                    log(`Native download triggered: ${videoFilename}`);
                    log(`Waiting for ${videoFilename} to appear in working/...`);
                    const appeared = await waitForFileInWorking(page, videoFilename, 180000);
                    if (!appeared) {
                        reloadReason = `Scene ${nn}: native download timed out after 3 min`;
                        break;
                    }
                } else {
                    // Fallback: streaming URL → fetch+POST to monitor.py
                    const src = card ? (card.v.src || card.v.currentSrc || '') : '';
                    const streamUrl = (src && !src.startsWith('blob:')) ? src : null;
                    if (!streamUrl) { log(`Scene ${nn}: no video URL found`); continue; }
                    log(`Context menu unavailable — streaming URL fallback for ${videoFilename}`);
                    await downloadVideoToServer(streamUrl, videoFilename);
                }

                doneCount++;
                log(`✓ Scene ${nn} complete — ${doneCount}/${project.total_scenes} videos done`);
                success = true;

                if (i < scenes.length - 1) await jitter(4000, 5000); // 4–9s between scenes

            } catch (e) {
                log(`ERROR scene ${nn} attempt ${attempt}: ${e.message}`);
            }
        }

        if (!success) {
            const newFails = prevFails + 1;
            await setSceneFails(pid, nn, newFails);
            if (newFails >= SCENE_MAX_FAILS) {
                log(`Scene ${nn}: ${newFails}/${SCENE_MAX_FAILS} failures — skipping, moving to next`);
                anySceneSkipped = true;
                continue;
            }
            const reason = reloadReason || `Scene ${nn}: both attempts failed`;
            await reloadForRetry(pid, `${reason} (fail ${newFails}/${SCENE_MAX_FAILS})`);
            return;
        }
    }

    await clearSceneFails(pid, project.scenes);
    log(`=== VIDEO PHASE COMPLETE: ${pid} — ${doneCount}/${project.total_scenes} videos done ===`);
    const completionAction = anySceneSkipped ? 'videosPartialComplete' : 'videosComplete';
    chrome.runtime.sendMessage({ action: completionAction, projectId: pid });
}

// ── Message listener ──────────────────────────────────────────────────────────

let _running = false;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'startVideos' && !_running) {
        _running = true;
        runVideos(msg.project)
            .catch(e => {
                log(`FATAL: ${e.message}`);
                chrome.runtime.sendMessage({ action: 'error', message: e.message }).catch(() => {});
            })
            .finally(() => { _running = false; });
    }
    sendResponse({ ok: true });
    return false;
});

// Register with background when content script loads
(async () => {
    await sleep(1500);
    chrome.runtime.sendMessage({ action: 'tabReady', type: 'flow' }).catch(() => {});
    log('Ready');
})();
