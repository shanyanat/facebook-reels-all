'use strict';

const API = 'http://localhost:7788';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = msg => {
    console.log(`[chatgpt-ext] ${msg}`);
    chrome.runtime.sendMessage({ action: 'progress', text: msg }).catch(() => {});
};

const report = log; // alias — all progress goes to both console and sidepanel

// ── DOM utilities ─────────────────────────────────────────────────────────────

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

// ── ChatGPT UI helpers ────────────────────────────────────────────────────────

const COMPOSE = 'div[role="textbox"], [contenteditable="true"][data-lexical-editor], #prompt-textarea';

async function ensureNewChat() {
    for (const sel of ["button[aria-label='New chat']", "[data-testid='create-new-chat-button']"]) {
        const btn = findVisible(sel);
        if (btn) { btn.click(); await sleep(1500); return; }
    }
    if (/\/(c|g)\//.test(location.href)) {
        history.pushState({}, '', 'https://chatgpt.com/');
        await sleep(2000);
    }
}

async function activateImageMode() {
    await waitFor(() => findVisible(COMPOSE), 20000);
    await sleep(1200);

    // Strategy 1: exact text button
    for (const name of ['Create an image', 'Create image']) {
        for (const btn of document.querySelectorAll('button')) {
            if (btn.textContent.trim() === name && isVisible(btn)) {
                btn.click(); await sleep(800); log(`Image mode: "${name}"`); return;
            }
        }
    }

    // Strategy 2: aria-label
    const ariaBtn = findVisible(
        "button[aria-label*='Create an image' i], button[aria-label*='Create image' i]"
    );
    if (ariaBtn) { ariaBtn.click(); await sleep(800); log('Image mode: aria-label'); return; }

    // Strategy 3: "+" menu → TreeWalker
    const plusBtn = findVisible("[data-testid='composer-plus-btn']");
    if (plusBtn) {
        plusBtn.click();
        await sleep(1200);
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
            acceptNode: n => ['Create image', 'Create an image'].includes(n.textContent.trim())
                ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP
        });
        let textNode;
        while ((textNode = walker.nextNode())) {
            let el = textNode.parentElement;
            while (el && el !== document.body) {
                const r = el.getBoundingClientRect();
                if (r.height >= 28 && r.height < 80 && r.width > 50) {
                    el.click(); await sleep(800); log('Image mode: + menu TreeWalker'); return;
                }
                if (r.height >= 80) break;
                el = el.parentElement;
            }
        }
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await sleep(300);
    }

    log('WARNING: activateImageMode — button not found, continuing anyway');
}

async function selectAspectRatio(ratio = '9:16') {
    await sleep(1200);
    const altMap = { '9:16': ['portrait','9:16'], '1:1': ['square','1:1'], '16:9': ['landscape','16:9'] };
    const keywords = altMap[ratio] || [ratio];
    for (const kw of keywords) {
        for (const el of document.querySelectorAll("button, [role='option'], [role='radio'], [role='tab']")) {
            const combined = ((el.textContent || '') + ' ' + (el.getAttribute('aria-label') || '')).toLowerCase();
            if (combined.includes(kw.toLowerCase()) && isVisible(el)) {
                el.click(); await sleep(300); log(`Aspect ratio: ${ratio}`); return;
            }
        }
    }
    log(`WARNING: aspect ratio ${ratio} button not found`);
}

async function selectThinkingMode(level = 'extended') {
    const KEYWORDS = ['thinking', 'reason', 'think', 'extended', 'standard'];
    let thinkBtn = null;
    for (const el of document.querySelectorAll('button, [role="button"]')) {
        const combined = [
            el.getAttribute('aria-label'), el.textContent,
            el.getAttribute('title'), el.getAttribute('data-testid')
        ].filter(Boolean).join(' ').toLowerCase();
        if (KEYWORDS.some(k => combined.includes(k)) && isVisible(el)) {
            thinkBtn = el; break;
        }
    }
    if (!thinkBtn) { log('WARNING: Thinking button not found'); return; }

    thinkBtn.click();
    await sleep(500);

    const levelWords = {
        extended: ['extended', 'longer', 'more'],
        standard: ['standard', 'normal', 'default', 'medium'],
        none:     ['none', 'off', 'disabled']
    }[level.toLowerCase()] || [level.toLowerCase()];

    for (const el of document.querySelectorAll('[role="menuitem"],[role="option"],[role="radio"],button,li')) {
        const t = (el.textContent || '').toLowerCase();
        if (levelWords.some(w => t.includes(w)) && isVisible(el)) {
            el.click(); await sleep(300); log(`Thinking mode: ${level}`); return;
        }
    }
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
}

async function fillChatInput(text) {
    await waitFor(() => findVisible(COMPOSE), 30000);
    const el = document.querySelector(COMPOSE);
    if (!el) throw new Error('Compose input not found');

    el.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);
    document.execCommand('insertText', false, text);

    // Verify — fallback to chunked typing if empty
    const content = (el.textContent || el.value || '').trim();
    if (content.length < 5) {
        el.click();
        const chunk = 500;
        for (let i = 0; i < text.length; i += chunk) {
            document.execCommand('insertText', false, text.slice(i, i + chunk));
            await sleep(30);
        }
    }
    log(`Filled input (${text.length} chars)`);
}

function _sendBtnEnabled() {
    const btn = document.querySelector('button[data-testid="send-button"], button[aria-label*="Send"]');
    return btn && !btn.disabled;
}

function countAttachmentsNow() {
    // Only count blob: image thumbnails inside the compose form — not in chat history.
    // Generated chat images are outside the <form>; attachment previews are inside it.
    const form = document.querySelector('form');
    const root = form || document;
    return root.querySelectorAll('img[src^="blob:"]').length;
}

async function uploadFileToChatGPT(serverPath, filename) {
    log(`Uploading ${filename}...`);
    const baseline = countAttachmentsNow();
    log(`Attachment baseline: ${baseline}`);

    try {
        const res = await chrome.runtime.sendMessage({
            action: 'injectFileUpload',
            path: serverPath,
            filename
        });
        if (res?.ok) {
            log(`Attached: ${res.result}`);
            await sleep(3000);
            return;
        }
        log(`injectFileUpload failed: ${res?.result || res?.error}`);
    } catch (e) {
        log(`injectFileUpload error: ${e.message}`);
    }

    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
        if (countAttachmentsNow() > baseline) { log(`Upload confirmed (delayed): ${filename}`); return; }
        await sleep(1000);
    }
    log(`Upload timed out (unconfirmed): ${filename}`);
}

async function clickSend() {
    const SEND = 'button[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label*="Send"]';
    const deadline = Date.now() + 20000;
    let btn;
    while (Date.now() < deadline) {
        btn = findVisible(SEND);
        if (btn && !btn.disabled) break;
        await sleep(500);
    }
    if (!btn) throw new Error('Send button not found or disabled');
    btn.click();
    log('Send clicked');
    await sleep(600);
}

async function waitForGeneration(maxWait = 600) {
    log(`Waiting for generation (max ${maxWait}s)...`);
    try {
        await waitFor(() => findVisible('[data-testid="stop-button"]'), 15000, 500);
        log('Generation started');
    } catch {
        log('Stop button did not appear — may already be done');
    }
    const start = Date.now();
    while (Date.now() - start < maxWait * 1000) {
        if (!findVisible('[data-testid="stop-button"]')) {
            log('Generation complete');
            await sleep(1000);
            return;
        }
        await sleep(3000);
    }
    log(`WARNING: Still generating after ${maxWait}s — continuing`);
}

function countGeneratedImages() {
    const ids = new Set();
    for (const img of document.querySelectorAll('img[src*="id=file_"]')) {
        const m = img.src.match(/id=(file_[^&\s"]+)/);
        if (m) ids.add(m[1]);
    }
    return ids.size;
}

async function pollForImages(expected, baseline, timeout = 120, noProgressWindow = 180) {
    log(`Polling for ${expected} images (baseline=${baseline})...`);
    const start = Date.now();
    let best = 0;
    let lastProgressAt = Date.now();
    while (Date.now() - start < timeout * 1000) {
        const newCount = countGeneratedImages() - baseline;
        if (newCount > best) { best = newCount; lastProgressAt = Date.now(); }
        if (newCount >= expected) { log(`✓ ${newCount} new images`); return newCount; }
        // Early stop: ChatGPT often produces fewer images than asked. If no new image
        // has appeared for noProgressWindow seconds, it has stopped producing — return
        // what we have instead of waiting out the full (up to 60 min) timeout, which
        // looks exactly like a frozen tab.
        if (Date.now() - lastProgressAt > noProgressWindow * 1000) {
            log(`No new image for ${noProgressWindow}s — stopping early with ${best}/${expected}`);
            return best;
        }
        await sleep(3000);
    }
    const final = countGeneratedImages() - baseline;
    log(`Timeout: ${final} new images`);
    return final;
}

function getGeneratedImageUrls() {
    const seen = new Set(), result = [];
    for (const img of document.querySelectorAll('img[src*="id=file_"]')) {
        const m = img.src.match(/id=(file_[^&\s"]+)/);
        if (m && !seen.has(m[1])) { seen.add(m[1]); result.push(img.src); }
    }
    return result;
}

async function downloadImageViaBg(url, filename) {
    // 1. Fetch in content-script context (same-site chatgpt.com request so
    //    SameSite=Strict session cookies are included — identical to bot.py's
    //    page.evaluate fetch). chrome.downloads is cross-site → cookies rejected.
    const r = await fetch(url, { credentials: 'include' });
    if (!r.ok) throw new Error(`Fetch failed: ${r.status} ${url.slice(0, 80)}`);
    const buf = await r.arrayBuffer();
    const bytes = new Uint8Array(buf);

    // 2. Chunked btoa — bot.py's exact method (avoids spread-operator stack overflow).
    const CHUNK = 8192;
    let s = '';
    for (let i = 0; i < bytes.length; i += CHUNK)
        s += String.fromCharCode(...bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
    const base64 = btoa(s);

    // 3. POST to monitor.py /save_image — writes directly to pages/<page>/working/
    //    and updates contents.json. No Downloads folder, no chrome.downloads.
    //    Mirrors bot.py writing image bytes straight to working/ on disk.
    const res = await fetch(`${API}/save_image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename, base64 })
    });
    if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`save_image failed: ${res.status} ${txt}`);
    }
    log(`Saved: ${filename} (~${Math.round(bytes.length / 1024)} KB) → working/`);
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

function detectAspectRatio(text) {
    const m = text.match(/--ar\s+([\w:]+)/);
    return m ? m[1] : null;
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

// Wait for monitor.py to write the storyboard to working/ before Phase B.
// Returns the server path string (for uploadFileToChatGPT) or null on timeout.
async function waitForStoryboardOnServer(pid, page, maxWait = 60000) {
    const path = `pages/${page}/working/${pid}-storyboard.png`;
    const end = Date.now() + maxWait;
    while (Date.now() < end) {
        try {
            const res = await fetch(`${API}/file/${path}`);
            if (res.ok) { log('Storyboard available on server ✓'); return path; }
        } catch {}
        await sleep(2000);
    }
    log('WARNING: Storyboard not available on server after 60s — Phase B reference skipped');
    return null;
}

// Ask monitor.py which scenes have NO image on disk yet (disk truth, the same
// img_on_disk the video phase selects from). Returns a sorted array of scene_num.
// On any error returns [] (don't retry) so a transient failure can't loop forever
// or re-request scenes that are actually present.
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
        log(`WARNING: could not read disk status for retry: ${e.message}`);
        return [];
    }
}

// ── Main phases ───────────────────────────────────────────────────────────────

async function runImages(project, resumeFrom) {
    const pid   = project.id;
    const page  = project.page;
    const ratio = project.aspect_ratio || '9:16';
    const char  = project.character_sheet;

    log(`=== IMAGE PHASE START: ${pid} page=${page} scenes=${project.total_scenes} resumeFrom=${resumeFrom || 'pending'} ===`);
    report('Starting — navigating to new chat...');
    await ensureNewChat();
    await sleep(2000);

    if (await isStopped(pid)) { log('Stopped before Phase A'); return; }

    // ── PHASE A: Storyboard ──────────────────────────────────────────────────
    if (resumeFrom === 'storyboard_done') {
        log('--- Phase A: Skipped (storyboard already done) ---');
        report('Phase A: Skipped — resuming from Phase B...');
    } else {
        log('--- Phase A: Storyboard ---');
        report('Phase A: Storyboard...');

        await activateImageMode();
        await selectAspectRatio(ratio);
        await selectThinkingMode('extended');

        const storyboardPrompt = cutAtEndMarker(project.storyboard_prompt.trim(), 'STORYBOARD')
            + '\n\n--- The End of STORYBOARD PROMPTS ---';
        await fillChatInput(storyboardPrompt);

        if (char) {
            report('Phase A: Uploading character sheet...');
            try {
                await uploadFileToChatGPT(char, char.split('/').pop());
            } catch (e) { log(`WARNING: char sheet upload failed: ${e.message}`); }
        }

        await clickSend();
        await sleep(5000);
        const baselineA = countGeneratedImages();
        log(`Phase A baseline: ${baselineA}`);

        await waitForGeneration(480);
        await pollForImages(1, baselineA, 300);

        const urlsA = getGeneratedImageUrls().slice(baselineA);
        if (!urlsA.length) throw new Error('Phase A: No storyboard image generated');

        report('Phase A: Downloading storyboard...');
        await downloadImageViaBg(urlsA[urlsA.length - 1], `${pid}-storyboard.png`);
        log('✓ Storyboard downloaded → Downloads/');
    }

    if (await isStopped(pid)) { log('Stopped before Phase B'); return; }

    // ── PHASE B: All scene images ────────────────────────────────────────────
    log(`--- Phase B: ${project.total_scenes} scenes ---`);
    report(`Phase B: ${project.total_scenes} scene images...`);

    await activateImageMode();
    await selectAspectRatio(ratio);
    await selectThinkingMode('standard');

    const sceneBlocks = project.scenes
        .map(s => `## SCENE ${s.scene_num} IMAGE PROMPT\n\n${cutAtEndMarker(s.image_prompt.trim(), 'IMAGE')}`)
        .join('\n\n---\n\n');
    await fillChatInput(
        sceneBlocks + '\n\nCreate all image สร้างเป็นภาพแยกกัน ซีนละ 1 ภาพ\n\n--- The End of IMAGE PROMPTS ---'
    );

    // Upload storyboard reference (wait for monitor.py to write it to working/)
    report('Phase B: Waiting for storyboard reference...');
    const storyboardPath = await waitForStoryboardOnServer(pid, page);
    if (storyboardPath) {
        await uploadFileToChatGPT(storyboardPath, `${pid}-storyboard.png`);
    }

    if (char) {
        try {
            await uploadFileToChatGPT(char, char.split('/').pop());
        } catch (e) { log(`WARNING: char sheet upload (Phase B) failed: ${e.message}`); }
    }

    await clickSend();
    await sleep(5000);
    const baselineB = countGeneratedImages();
    log(`Phase B baseline: ${baselineB}`);

    const maxB = 600 + project.total_scenes * 360;
    await waitForGeneration(maxB);
    window.scrollTo(0, document.body.scrollHeight);
    await sleep(3000);
    await pollForImages(project.total_scenes, baselineB, 3600);

    const newUrlsB = getGeneratedImageUrls().slice(baselineB);
    log(`Phase B: ${newUrlsB.length} images received`);

    for (let i = 0; i < Math.min(newUrlsB.length, project.total_scenes); i++) {
        const nn = String(i + 1).padStart(2, '0');
        report(`Phase B: Downloading scene ${nn}/${project.total_scenes}...`);
        try {
            await downloadImageViaBg(newUrlsB[i], `${pid}-scene-${nn}.png`);
            log(`✓ scene-${nn}.png`);
        } catch (e) { log(`ERROR downloading scene ${nn}: ${e.message}`); }
    }

    // ── Phase B continuation: re-request scenes ChatGPT under-delivered ────────
    // ChatGPT rarely returns all N images in one reply, so the poll above often
    // stops early with fewer than total_scenes. Instead of moving to video with a
    // short reel, re-ask — in the SAME chat (context preserved) — for the scenes
    // still missing on disk. We request exactly ONE scene per message: that makes
    // the image→scene mapping certain by construction (the image returned for a
    // single-scene request IS that scene), so it always saves as the correct
    // reel_XXXX-scene-NN.png regardless of order or skips. A multi-image batch
    // mapped by position is NOT safe — ChatGPT can skip/reorder within a batch and
    // img_on_disk only proves a file exists, not that it holds the right scene.
    const MAX_ATTEMPTS_PER_SCENE = 3;
    const attempts = {};
    let missing = await getDiskMissingScenes(pid);
    while (missing.length > 0) {
        if (await isStopped(pid)) { log('Stopped during Phase B retry'); return; }
        // Next still-missing scene that has retries left; if none, give up the rest.
        const n = missing.find(s => (attempts[s] || 0) < MAX_ATTEMPTS_PER_SCENE);
        if (n === undefined) {
            log(`Phase B: ${missing.length} scene(s) exhausted retries: ${missing.join(', ')}`);
            break;
        }
        attempts[n] = (attempts[n] || 0) + 1;
        const nn = String(n).padStart(2, '0');
        log(`Phase B retry: scene ${nn} (attempt ${attempts[n]}/${MAX_ATTEMPTS_PER_SCENE}); ${missing.length} missing`);
        report(`Phase B: re-requesting scene ${nn} (${missing.length} still missing)...`);

        await activateImageMode();
        await selectAspectRatio(ratio);
        await selectThinkingMode('standard');

        const s = project.scenes.find(x => x.scene_num === n);
        const body = s ? cutAtEndMarker((s.image_prompt || '').trim(), 'IMAGE') : '';
        await fillChatInput(
            `สร้างภาพสำหรับซีนนี้ 1 ภาพ (Generate exactly ONE image for this single scene):\n\n` +
            `## SCENE ${n} IMAGE PROMPT\n\n${body}\n\n--- The End of IMAGE PROMPTS ---`
        );

        const baselineR = countGeneratedImages();
        await clickSend();
        await sleep(5000);
        await waitForGeneration(600);
        window.scrollTo(0, document.body.scrollHeight);
        await sleep(2000);
        await pollForImages(1, baselineR, 600);

        // Exactly one scene was requested, so the newest new image IS scene n.
        const got = getGeneratedImageUrls().slice(baselineR);
        if (got.length) {
            try {
                await downloadImageViaBg(got[got.length - 1], `${pid}-scene-${nn}.png`);
                log(`✓ scene-${nn}.png (retry attempt ${attempts[n]})`);
            } catch (e) { log(`ERROR downloading scene ${nn} (retry): ${e.message}`); }
        } else {
            log(`Phase B retry: scene ${nn} produced no image (attempt ${attempts[n]})`);
        }

        missing = await getDiskMissingScenes(pid);
    }
    if (missing.length > 0) {
        log(`WARNING: Phase B finished with ${missing.length} scene(s) still missing: ${missing.join(', ')}`);
        report(`⚠ ${missing.length} image(s) could not be generated (scenes ${missing.join(', ')})`);
    } else {
        log('Phase B: all scene images confirmed on disk ✓');
    }

    if (await isStopped(pid)) { log('Stopped before Phase C'); return; }

    // ── PHASE C: Thumbnail ───────────────────────────────────────────────────
    const thumbPrompt = (project.thumbnail_prompt || '').trim();
    if (thumbPrompt) {
        log('--- Phase C: Thumbnail ---');
        report('Phase C: Thumbnail...');

        const thumbRatio = detectAspectRatio(thumbPrompt) || ratio;
        await activateImageMode();
        await selectAspectRatio(thumbRatio);
        await selectThinkingMode('extended');
        await fillChatInput(cutAtEndMarker(thumbPrompt, 'THUMBNAIL'));

        if (char) {
            try {
                await uploadFileToChatGPT(char, char.split('/').pop());
            } catch (e) { log(`WARNING: char sheet upload (Phase C) failed: ${e.message}`); }
        }

        await clickSend();
        await sleep(5000);
        const baselineC = countGeneratedImages();
        await waitForGeneration(480);
        await pollForImages(1, baselineC, 300);

        const thumbUrls = getGeneratedImageUrls().slice(baselineC);
        if (thumbUrls.length) {
            await downloadImageViaBg(thumbUrls[thumbUrls.length - 1], `${pid}-thumbnail.png`);
            log('✓ Thumbnail downloaded');
        } else {
            log('WARNING: No thumbnail image generated');
        }
    }

    log(`=== IMAGE PHASE COMPLETE: ${pid} ===`);
    report('Images complete ✓');
    chrome.runtime.sendMessage({ action: 'imagesComplete', projectId: pid });
}

// ── Message listener ──────────────────────────────────────────────────────────

let _running = false;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'startImages' && !_running) {
        _running = true;
        runImages(msg.project, msg.resumeFrom)
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
    chrome.runtime.sendMessage({ action: 'tabReady', type: 'chatgpt' }).catch(() => {});
    log('Ready');
})();
