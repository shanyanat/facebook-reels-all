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

// Flow's newer UI is built on components that handle pointerdown/pointerup and ignore
// anything that doesn't look like a real mouse: they check `button`, `buttons` and
// `isPrimary`. A bare `el.click()`, or a PointerEvent missing those fields, does nothing
// at all — that is why the frame picker never opened while the image uploaded fine, and
// the run then looped re-uploading the same scene. Every synthetic click in this file
// goes through here, so the full, correctly-shaped sequence is what they all send.
function dispatchPointerClick(el) {
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const down = {
        bubbles: true, cancelable: true, composed: true, view: window,
        clientX: cx, clientY: cy, screenX: cx, screenY: cy,
        button: 0, buttons: 1, detail: 1,
        pointerId: 1, pointerType: 'mouse', isPrimary: true,
        width: 1, height: 1, pressure: 0.5,
    };
    const up = { ...down, buttons: 0, pressure: 0 };   // no button held any more
    el.dispatchEvent(new PointerEvent('pointerover', down));
    el.dispatchEvent(new PointerEvent('pointerenter', down));
    el.dispatchEvent(new MouseEvent('mouseover', down));
    el.dispatchEvent(new MouseEvent('mouseenter', down));
    el.dispatchEvent(new PointerEvent('pointermove', up));
    el.dispatchEvent(new MouseEvent('mousemove', up));
    el.dispatchEvent(new PointerEvent('pointerdown', down));
    el.dispatchEvent(new MouseEvent('mousedown', down));
    el.dispatchEvent(new PointerEvent('pointerup', up));
    el.dispatchEvent(new MouseEvent('mouseup', up));
    el.dispatchEvent(new MouseEvent('click', up));
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

// ── Flow UI helpers ───────────────────────────────────────────────────────────

async function clickNewProject() {
    const names = ['โปรเจกต์ใหม่', 'โปรเจ็กต์ใหม่', 'New project', 'New Project'];
    const end = Date.now() + 30000;
    while (Date.now() < end) {
        for (const name of names) {
            for (const el of document.querySelectorAll('button, [role="button"], a')) {
                if ((el.textContent || '').trim().includes(name) && isVisible(el)) {
                    dispatchPointerClick(el);
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

// Every label in the settings panel is an icon-ligature glued to its text —
// "videocamVideo", "crop_freeFrames", "crop_9_169:16" — so all matching here is
// suffix/substring, never equality. Thai labels stay for the older Flow UI.
function settingsPanelOpen() {
    return [...document.querySelectorAll('[role="radio"], [role="tab"], button')]
        .some(el => isVisible(el) && /(^|[a-z_])(Image|Video|วิดีโอ)$/.test((el.textContent || '').trim()));
}

// Click the first visible control whose trimmed text matches `re`; returns that text.
function clickByText(re, selector = 'button, [role="radio"], [role="tab"], [role="option"]') {
    for (const el of document.querySelectorAll(selector)) {
        if (el.getAttribute('aria-label') === 'Settings trigger') continue;   // never re-click the pill
        const t = (el.textContent || '').trim();
        if (re.test(t) && isVisible(el)) {
            dispatchPointerClick(el);
            return t;
        }
    }
    return null;
}

async function openSettingsPanel() {
    // Flow remembers whether the panel was left open. Clicking the pill then CLOSES it
    // and the following click lands on the page behind, so only click when it is shut.
    if (settingsPanelOpen()) { log('Settings panel already open'); return true; }

    const trigger = findVisible('[aria-label="Settings trigger"]');
    if (trigger) {
        dispatchPointerClick(trigger);
        await sleep(900);
        if (settingsPanelOpen()) { log('Settings panel opened'); return true; }
    }

    // Older Flow UI: the shortest bottom-bar pill carrying a multiplier or model name.
    const vh = window.innerHeight;
    const pills = [...document.querySelectorAll('button, [role="button"]')]
        .filter(el => isVisible(el) && el.getBoundingClientRect().top > vh * 0.6)
        .sort((a, b) => a.textContent.length - b.textContent.length);
    for (const btn of pills) {
        const t = btn.textContent || '';
        if (t.length <= 80 && (/\dx|x\d/.test(t) || /Nano Banana|Omni|Veo|Imagen/.test(t))) {
            btn.click(); await sleep(900);
            if (settingsPanelOpen()) { log('Settings panel opened (fallback pill)'); return true; }
        }
    }
    log('WARNING: settings panel did not open');
    return false;
}

async function configureVideoSettings(aspectRatio = '9:16') {
    log('Configuring settings...');
    if (!await openSettingsPanel()) throw new Error('SELECTOR: settings panel would not open');

    log(clickByText(/(^|[a-z_])(Video|วิดีโอ)$/) ? 'Mode: Video' : 'WARNING: Video mode not found');
    await sleep(700);

    // Frames, not Ingredients — this is what puts the Start/End frame slots in the
    // compose bar, and the scene image goes into Start. Absent on the older UI.
    if (clickByText(/(^|[a-z_])(Frames|เฟรม)$/)) { log('Source: Frames'); await sleep(700); }

    // Aspect ratio — "crop_9_169:16". Skip the pill, whose own text also carries the icon.
    const iconName = aspectRatio === '9:16' ? 'crop_9_16' : 'crop_16_9';
    for (const el of document.querySelectorAll("button, [role='radio'], [role='option']")) {
        if (el.getAttribute('aria-label') === 'Settings trigger') continue;
        const combined = ((el.textContent || '') + ' ' + (el.getAttribute('aria-label') || '')).toLowerCase();
        if ((combined.includes(aspectRatio.toLowerCase()) || combined.includes(iconName)) && isVisible(el)) {
            dispatchPointerClick(el); await sleep(300); log(`Aspect ratio: ${aspectRatio}`); break;
        }
    }

    // One output per prompt — "x1" now, "1x" on the older UI.
    log(clickByText(/^(x1|1x)$/) ? 'Set: 1 output' : 'WARNING: 1-output control not found');
    await sleep(300);

    // Model family. The trigger button shows the CURRENT model, so its own text can
    // contain "Lite"/"Lower Priority" — pick from the menu only, never the trigger.
    const modelBtn = findVisible('[aria-label="Select model family"]')
        || [...document.querySelectorAll('button')].find(b => isVisible(b) && /Veo|Omni/.test(b.textContent || ''));
    if (modelBtn) {
        dispatchPointerClick(modelBtn);
        await sleep(1200);
    } else {
        log('WARNING: model family button not found');
    }

    const pickModel = re => {
        for (const el of document.querySelectorAll('[role="menuitem"], [role="option"], li')) {
            const t = (el.textContent || '').trim();
            if (re.test(t) && isVisible(el)) {
                dispatchPointerClick(el);
                return t;
            }
        }
        return null;
    };
    let modelSet = null;
    for (let attempt = 0; attempt < 3 && !modelSet; attempt++) {
        if (attempt > 0) await sleep(700);
        modelSet = pickModel(/Lower Priority/) || pickModel(/Lite/);
    }
    log(modelSet ? `Model: ${modelSet}` : 'WARNING: Veo Lite option not found');
    await sleep(400);

    // Close settings panel
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(500);
    log('Settings configured ✓');
}

// ── Agent / "Omni" onboarding panel (some accounts only) ──────────────────────
// On certain Google accounts (e.g. ULTRA) Flow opens an "Omni" assistant side panel
// by default and the compose bar starts WITHOUT "Agent" mode — both must be handled
// or the bot can never reach the generate step. Other accounts never show this, so
// everything here is gated on the panel actually being present (a true no-op there).

function agentPanelIsOpen() {
    const body = document.body.innerText || '';
    if (body.toLowerCase().includes('keyboard shortcuts')) return true;
    // "Omni" on its own is no longer a tell: it is also the name of Flow's default video
    // model ("Omni 1.1 Flash"), which sits in the compose bar on every project. Require
    // the panel's own ✕ as well, or this fires on every run and Escapes 4× for nothing.
    return body.includes('Omni') && !!findAgentPanelCloseButton();
}

function findAgentPanelCloseButton() {
    // The assistant panel sits on the right; its ✕ is a Material "close" icon button
    // in the top-right. Scope to that region so we never hit an unrelated close button.
    const w = window.innerWidth, h = window.innerHeight;
    for (const b of document.querySelectorAll('button, [role="button"]')) {
        if (!isVisible(b)) continue;
        const r = b.getBoundingClientRect();
        if (!(r.left > w * 0.6 && r.top < h * 0.25)) continue;
        const txt  = (b.textContent || '').trim().toLowerCase();
        const aria = (b.getAttribute('aria-label') || '').toLowerCase();
        if (txt === 'close' || txt === '✕' || txt === '×' ||
            aria.includes('close') || aria.includes('ปิด') || aria.includes('dismiss')) {
            return b;
        }
    }
    return null;
}

async function dismissAgentPanel() {
    // No-op unless the Omni panel is actually showing (primary/backup accounts).
    if (!agentPanelIsOpen()) return;
    log('Agent/Omni side panel detected — closing it and enabling Agent mode');

    // Step 1: close the panel — try the ✕ button, fall back to Escape.
    for (let attempt = 0; attempt < 4 && agentPanelIsOpen(); attempt++) {
        const x = findAgentPanelCloseButton();
        if (x) { x.click(); }
        else { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); }
        await sleep(800);
    }

    if (agentPanelIsOpen()) {
        log('WARNING: could not close Agent/Omni panel automatically — visible buttons follow:');
        for (const b of document.querySelectorAll('button, [role="button"]')) {
            if (!isVisible(b)) continue;
            const r = b.getBoundingClientRect();
            log(`  btn "${(b.textContent || '').trim().slice(0, 24)}" aria="${b.getAttribute('aria-label') || ''}" @${Math.round(r.left)},${Math.round(r.top)}`);
        }
        return;
    }
    log('Agent/Omni panel closed');

    // Step 2: click the "Agent" pill (exact text). Only reached after a panel was
    // closed, so it can never toggle Agent mode off on accounts that look right already.
    for (let attempt = 0; attempt < 4; attempt++) {
        const agentBtn = [...document.querySelectorAll('button, [role="button"]')]
            .find(el => (el.textContent || '').trim() === 'Agent' && isVisible(el));
        if (agentBtn) { agentBtn.click(); log('Clicked "Agent"'); await sleep(800); return; }
        await sleep(800);
    }
    log('NOTE: "Agent" button not found after closing panel — may already be active');
}

function isEnabled(el) {
    return !!el && !el.disabled && el.getAttribute('aria-disabled') !== 'true';
}

// The Flow media picker is "open" when it offers a way to attach media. On the current
// UI that is the "Select a frame image" dialog (and its Add-to-prompt button); on the
// older one it was the "อัปโหลดสื่อ / Upload media" browser. Either signal counts, so
// this stays a reliable open/closed test on both layouts.
function mediaPanelOpen() {
    if (/Select a frame image|เลือกภาพเฟรม/i.test(document.body.innerText || '')) return true;
    for (const el of document.querySelectorAll('button, [role="button"], a, li')) {
        const t = (el.textContent || '').trim();
        if ((t.includes('อัปโหลดสื่อ') || t.includes('Upload media') ||
             t.includes('เพิ่มไปยังพรอมต์') || t.includes('Add to prompt')) && isVisible(el)) return true;
    }
    return false;
}

function findAddToPromptBtn() {
    // Return "Add to Prompt" ONLY when it is ENABLED. Flow greys it out (disabled)
    // while the selected media is still uploading; clicking the greyed button does
    // nothing — that was the real cause of the "could not close panel" loop, where the
    // bot had selected the still-uploading (47%) copy.
    const keywords = ['เพิ่มไปยังพรอมต์', 'Add to prompt'];
    for (const el of document.querySelectorAll('button, [role="button"]')) {
        const t = (el.textContent || '').trim();
        if (keywords.some(k => t.includes(k)) && isVisible(el) && isEnabled(el)) return el;
    }
    return null;
}

// Same button regardless of enabled/disabled — used only to tell whether the media
// panel is still open (the button disappears once the image is added to the prompt).
function addToPromptVisible() {
    const keywords = ['เพิ่มไปยังพรอมต์', 'Add to prompt'];
    for (const el of document.querySelectorAll('button, [role="button"]')) {
        const t = (el.textContent || '').trim();
        if (keywords.some(k => t.includes(k)) && isVisible(el)) return true;
    }
    return false;
}

async function clickAddToPrompt() {
    // Step 1: wait (up to ~60s) for the button to become ENABLED — i.e. the selected
    // media finished uploading. This is what stops the bot clicking the greyed button.
    let el = null;
    for (let i = 0; i < 60 && !el; i++) {
        el = findAddToPromptBtn();
        if (!el) await sleep(1000);
    }
    if (!el) {
        log('WARNING: Add to Prompt never became enabled — upload not ready in time');
        return false;
    }

    // Step 2: click it, then verify the panel actually closed (button gone).
    for (let attempt = 0; attempt < 10; attempt++) {
        if (attempt > 0) { await sleep(800); el = findAddToPromptBtn() || el; }
        el.scrollIntoView({ block: 'center', inline: 'center' });
        await sleep(200);
        try { el.focus(); } catch {}
        await sleep(100);
        dispatchPointerClick(el);
        await sleep(1500);

        if (!addToPromptVisible()) {
            log(`Clicked: เพิ่มไปยังพรอมต์ (confirmed closed, attempt ${attempt + 1})`);
            return true;
        }
        log(`Attempt ${attempt + 1}: panel still open — retrying`);
    }
    log('WARNING: เพิ่มไปยังพรอมต์ — could not close panel after 10 attempts');
    return false;
}

// Drop the scene image onto the compose bar's Start slot, so Flow ingests it into the
// project's media library. This replaces the old "open the media browser → click Upload
// media → intercept the file input" dance: that browser no longer exists, and Flow now
// creates its file input only for the duration of its own click handler.
//
// The drop itself must happen in the page's MAIN world. A DragEvent + DataTransfer built
// here, in the content script's isolated world, does not reach Flow's drop handler — the
// upload silently does nothing, and the old code then fell through to a "+" search that
// clicked the Agent button and derailed the run. background.js does the work; the same
// wall and the same remedy as injectFileUpload on ChatGPT.
async function dropSceneImage(imgPath, filename) {
    const resp = await chrome.runtime
        .sendMessage({ action: 'dropFlowFrame', path: imgPath, filename })
        .catch(e => ({ ok: false, error: e.message }));
    if (!resp || !resp.ok) {
        throw new Error(`SELECTOR: could not drop ${filename} into Flow `
                      + `(${resp && (resp.error || resp.result) || 'no response'})`);
    }
    log(`Dropped ${filename} into Flow — ${resp.result}`);
}

// Flow shows "<n>%" on the tile while a dropped file uploads. Let that clear before
// opening the picker, so the picker lists a finished file rather than a partial one.
async function waitForUploadFinished(maxWait = 120000) {
    const end = Date.now() + maxWait;
    await sleep(2000);
    while (Date.now() < end) {
        if (!/\b\d{1,3}%/.test(document.body.innerText || '')) return true;
        await sleep(1500);
    }
    log('WARNING: upload progress never cleared — continuing anyway');
    return false;
}

// Click the compose bar's Start slot to open the "Select a frame image" picker. The slot
// does nothing while the project has no media, which is why this runs after the drop.
// Two slot states: empty, where it reads "Start"; and — from scene 2 onward, since all
// scenes share one project — still holding the previous scene's thumbnail, where the
// word "Start" is gone and the slot is the "Image ingredient" chip. Clicking that chip
// either reopens the picker or clears the slot back to "Start"; the loop copes with both.
async function openFramePicker() {
    for (let attempt = 0; attempt < 5; attempt++) {
        if (mediaPanelOpen()) return true;
        const slot = [...document.querySelectorAll('button, [role="button"]')]
            .find(el => isVisible(el) && ['Start', 'เริ่ม', 'เริ่มต้น'].includes((el.textContent || '').trim()))
            || findVisible('[aria-label="Image ingredient"]');
        if (slot) {
            dispatchPointerClick(slot);
            await sleep(2200);
            if (mediaPanelOpen()) { log('Frame picker opened'); return true; }
        }
        await sleep(1200);
    }
    return false;
}

// Select this scene's file by name. The picker tends to preselect the most recent
// upload, but by scene 5 the project holds five images — never rely on that.
async function selectPickerFile(filename) {
    const end = Date.now() + 60000;
    while (Date.now() < end) {
        for (const el of document.querySelectorAll('[role="option"], [role="menuitem"], li, button')) {
            if (!isVisible(el) || !(el.textContent || '').includes(filename)) continue;
            dispatchPointerClick(el);
            await sleep(800);
            log(`Selected in picker: ${filename}`);
            return true;
        }
        await sleep(1000);
    }
    return false;
}

// True once an image sits in the Start slot: the picker is closed and the slot holds a
// thumbnail — the "Image ingredient" chip — instead of the word "Start".
//
// This deliberately does NOT check the filename. The chip's name is not reliably part of
// the page's rendered text, so matching it reported "not attached" for an image that was
// plainly attached, and the scene looped re-uploading. That the slot holds THIS scene's
// image is guaranteed upstream instead, by selectPickerFile() clicking the picker entry
// by name and the caller treating a miss as fatal.
function frameAttached() {
    if (/Select a frame image|เลือกภาพเฟรม/i.test(document.body.innerText || '')) return false;
    if (findVisible('[aria-label="Image ingredient"]')) return true;
    return ![...document.querySelectorAll('button, [role="button"]')]
        .some(el => isVisible(el) && ['Start', 'เริ่ม', 'เริ่มต้น'].includes((el.textContent || '').trim()));
}

async function uploadSceneImage(imgPath, filename) {
    log(`Uploading: ${filename}...`);

    // Step 1: drop the file — Flow uploads it into the project's media library.
    log('Step 1: Dropping file into Flow...');
    await dropSceneImage(imgPath, filename);
    await waitForUploadFinished();

    // Step 2: open the frame picker by clicking the Start slot. There is deliberately no
    // fallback here: in Frames mode Flow has no "+" media button at all, so the old
    // compose-row search could only ever hit some other control — it was landing on
    // Agent. A miss must stop the scene loudly instead.
    log('Step 2: Opening frame picker...');
    if (!await openFramePicker()) {
        throw new Error('SELECTOR: frame picker did not open (Start slot not found)');
    }
    await jitter(1200, 1200); // settle after the picker opens

    // Step 3: select the picker entry BY NAME. This is the step that guarantees the scene
    // gets its own image: the picker preselects the most recent upload, which stops being
    // the right one as soon as the project holds several scenes. A miss is fatal.
    log('Step 3: Selecting the uploaded file...');
    if (!await selectPickerFile(filename)) {
        throw new Error(`SELECTOR: "${filename}" was not listed in the frame picker`);
    }

    // Step 4: clicking the entry normally attaches it and closes the picker outright,
    // so "Add to prompt" is often already gone — click it only while it is still there.
    log('Step 4: Attaching to the Start frame...');
    if (!frameAttached() && addToPromptVisible()) await clickAddToPrompt();
    for (let i = 0; i < 8 && !frameAttached(); i++) await sleep(1000);
    if (!frameAttached()) throw new Error('SELECTOR: scene image was not attached to the Start frame');
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

// The Generate/send button carries the "arrow_forward" Material icon (its visually-
// hidden label is "สร้าง"). We target arrow_forward SPECIFICALLY — matching "สร้าง"
// alone wrongly hit the separate "add_2 สร้าง" Create button, which is what caused the
// stray clicks. Exclude any "add" button to be safe.
function findGenerateButton() {
    const vh = window.innerHeight;
    const cands = [...document.querySelectorAll('button, [role="button"]')].filter(b => {
        if (!isVisible(b) || !isEnabled(b)) return false;
        if (b.getBoundingClientRect().top < vh * 0.3) return false;
        const txt = b.textContent || '';
        if (txt.includes('add')) return false;   // exclude the "add_2 สร้าง" Create button
        return txt.includes('arrow_forward') || txt.includes('ส่ง') ||
               (b.getAttribute('aria-label') || '').toLowerCase().includes('send');
    });
    cands.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
    return cands[0] || null;
}

async function clickGenerate() {
    // Primary: main-world React onClick on the arrow_forward button (fires Slate state).
    // After it clicks, waitForVideoReady() is what detects success/failure — same as the
    // original, working design. No verify-cascade, no Enter: one precise click only.
    const resp = await chrome.runtime.sendMessage({ action: 'clickGenerateSlate' }).catch(() => null);
    if (resp?.ok) {
        await jitter(1000, 1500); // 1–2.5s: settle after button click
        log(`Generate: ${resp.result}`);
        return;
    }
    log(`Generate main-world: ${resp?.result || resp?.error} — content-script fallback`);

    // Fallback: click the arrow_forward button directly (precise; excludes "add_2 สร้าง").
    const btn = findGenerateButton();
    if (btn) {
        try { btn.scrollIntoView({ block: 'center' }); } catch {}
        await sleep(150);
        dispatchPointerClick(btn);
        await jitter(1000, 1500);
        log('Generate: content-script arrow_forward click');
        return;
    }

    throw new Error('SELECTOR: Generate (arrow_forward) button not found');
}

// The current Flow UI renders each finished clip as a thumbnail and plays it into a
// <canvas> — there is no <video> element anywhere in the page, shadow roots included.
// Counting <video> therefore returned 0 forever and every generation looked like a
// timeout. The older UI did keep <video> in the grid, hence the max of the two.
function countVideoClips() {
    return Math.max(
        document.querySelectorAll('img[alt="Generated video thumbnail"]').length,
        document.querySelectorAll('video').length);
}

// Newest generated-clip tile (the grid is newest-first), or null.
function newestClipTile() {
    const tiles = [...document.querySelectorAll('img[alt="Generated video thumbnail"]')].filter(isVisible);
    if (!tiles.length) return null;
    tiles.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
    return tiles[0];
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
            log('⚠ Rate limit detected (unusual activity) — transient, will back off and retry');
            return 'ratelimit';
        }

        // Error detection
        for (const el of document.querySelectorAll('[role="alert"], [class*="error" i]')) {
            const t = el.textContent.toLowerCase();
            if (['error', 'failed', 'ล้มเหลว', 'something went wrong'].some(e => t.includes(e))) {
                log(`Generation error at ${elapsed}s`);
                return false;
            }
        }

        // New clip ready? Disk-of-the-DOM: a finished clip adds a thumbnail tile.
        if (countVideoClips() > clipsBefore) {
            await sleep(4000);                       // let the tile settle
            if (countVideoClips() > clipsBefore) {
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

async function leaveClipViewer() {
    const back = findVisible('[aria-label="Back button to go to previous page"]');
    if (back) {
        dispatchPointerClick(back);
    } else {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    }
    await sleep(1500);
}

// Current Flow UI: open the newest clip and drive "Download media" → "720p Original
// size", with background.js renaming the resulting download to this scene's filename so
// monitor.py's DownloadsHandler files it into working/. 720p is the resolution the clip
// was generated at, so it is the only option that is both already rendered and free:
// "1080p Upscaled" re-renders it and "4K Upscaled" spends 50 credits; 270p is a GIF.
// Returns true once the rename was applied — the caller then waits for the file.
async function downloadClipViaViewer(videoFilename) {
    const tile = newestClipTile();
    if (!tile) return false;
    dispatchPointerClick(tile);
    await sleep(4000);

    const dl = findVisible('[aria-label="Download media"]');
    if (!dl) {
        log('Download media button not found in the clip viewer');
        await leaveClipViewer();
        return false;
    }

    // Arm the rename BEFORE the click — the reply lands once the download starts.
    const armed = chrome.runtime
        .sendMessage({ action: 'expectClipDownload', filename: videoFilename, timeoutMs: 90000 })
        .catch(() => null);

    dispatchPointerClick(dl);
    await sleep(2000);

    let picked = null;
    outer:
    for (const want of [/Original size/i, /720p/i, /1080p/i]) {
        for (const el of document.querySelectorAll('[role="menuitem"], [role="option"], li, button')) {
            if (!isVisible(el)) continue;
            if (el.getAttribute('aria-label') === 'Download media') continue;
            const t = (el.textContent || '').trim();
            if (!t || /4K|GIF/i.test(t)) continue;       // never spend credits
            if (want.test(t)) {
                dispatchPointerClick(el);
                picked = t.slice(0, 40);
                break outer;
            }
        }
    }
    if (!picked) log('No safe download resolution offered');

    const resp = await armed;
    await leaveClipViewer();
    if (resp && resp.ok) {
        log(`Clip download started (${picked}) → ${videoFilename}`);
        return true;
    }
    log(`Clip download not captured${resp && resp.error ? ` (${resp.error})` : ''}`);
    return false;
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

// Rate-limit ("unusual activity") retries — tracked PER PROJECT and kept separate
// from scene_fails so a transient Google throttle can never drain a scene's fail
// budget and silently drop it. Reset on any successful save, on a fresh run, and
// at phase end.
async function getRateLimitRetries(pid) {
    const r = await chrome.storage.local.get(`rl_retries_${pid}`);
    return parseInt(r[`rl_retries_${pid}`] || '0');
}

async function setRateLimitRetries(pid, count) {
    await chrome.storage.local.set({ [`rl_retries_${pid}`]: count });
}

async function clearRateLimitRetries(pid) {
    await chrome.storage.local.remove(`rl_retries_${pid}`);
}

// Selector / UI-not-found errors — tracked PER PROJECT, like rate-limits and kept
// OUT of scene_fails. A missing button is a systemic Flow-UI problem, not a bad scene,
// so it must never spend a scene's fail budget (one UI change must not skip all scenes).
async function getSelectorErrors(pid) {
    const r = await chrome.storage.local.get(`sel_errors_${pid}`);
    return parseInt(r[`sel_errors_${pid}`] || '0');
}

async function setSelectorErrors(pid, count) {
    await chrome.storage.local.set({ [`sel_errors_${pid}`]: count });
}

async function clearSelectorErrors(pid) {
    await chrome.storage.local.remove(`sel_errors_${pid}`);
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
        // Fresh user-initiated run — start with a clean slate. Clearing scene_fails here
        // is what un-sticks scenes previously skipped at SCENE_MAX_FAILS (e.g. scenes that
        // hit 5 fails during the Flow UI breakage); already-done scenes are skipped anyway
        // via disk truth (needsVideo), so this never re-does finished videos.
        await clearRateLimitRetries(pid);   // clean throttle budget
        await clearSelectorErrors(pid);     // clean selector budget
        await clearSceneFails(pid, project.scenes);
        await clickNewProject();
        await waitForCompose();
        // Set Video / Frames / ratio / x1 / Veo Lite automatically. The 20s window below
        // is now a chance to correct that, rather than the only way it ever gets set.
        try { await configureVideoSettings(ratio); }
        catch (e) { log(`Auto-configure failed (${e.message}) — set it by hand in the next 20s`); }
        log('⏳ Waiting 20s — check model, ratio and quantity; dismiss any panels...');
        await sleep(20000);
        await sleep(500);
    }

    // Close the "Omni" panel and enable Agent mode if this account shows them.
    // No-op on accounts that don't (primary/backup) — runs in both paths above.
    await dismissAgentPanel();

    log(`${doneCount}/${project.total_scenes} already done — processing ${scenes.length} remaining`);

    const SCENE_MAX_FAILS = 5;
    // Rate-limit retries do NOT count toward SCENE_MAX_FAILS — a transient throttle
    // must never drop a scene. Back off and retry the SAME scene; only stop (honestly,
    // never a false "complete") if the throttle persists past the cap.
    const RATE_LIMIT_MAX_RETRIES = 5;
    const RATE_LIMIT_BACKOFF_MS  = 60000;   // 60s between throttle retries
    const SELECTOR_ERROR_MAX = 5;           // per-project; UI change stalls loudly, never burns scene budget
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
        let rateLimited = false;     // transient throttle — handled separately, no fail penalty
        let selectorError = false;   // UI element not found — systemic, no scene-fail penalty

        for (let attempt = 1; attempt <= 2 && !success && !reloadReason && !rateLimited && !selectorError; attempt++) {
            if (attempt > 1) {
                log(`Scene ${nn}: retry ${attempt}/2`);
                await jitter(2500, 2500);
            }

            try {
                const imgPath = `pages/${page}/working/${pid}-scene-${nn}.png`;
                await uploadSceneImage(imgPath, `${pid}-scene-${nn}.png`);
                await jitter(4000, 3500); // 4–7.5s: let compose bar settle after panel closes

                const videoPrompt = cutAtEndMarker(scene.video_prompt.trim(), 'VIDEO')
                    + '\n\n--- The End of VIDEO PROMPTS ---';
                await fillVideoPrompt(videoPrompt);
                await jitter(1500, 1500); // 1.5–3s: wait for Slate re-render

                const clipsBefore = countVideoClips();
                await clickGenerate();

                const ready = await waitForVideoReady(clipsBefore, 210);
                if (ready === 'ratelimit') {
                    // Transient Google throttle — handled below WITHOUT a fail penalty.
                    rateLimited = true;
                    break;
                }
                if (!ready) {
                    reloadReason = `Scene ${nn}: generation failed/timed out`;
                    break;
                }

                const videoFilename = `${pid}-scene-${nn}-vdo.mp4`;
                const card = getVideoCardEl(clipsBefore);

                // Primary (current UI): clip viewer → Download media, renamed in flight
                // by background.js so monitor.py files it into working/.
                let started = await downloadClipViaViewer(videoFilename);

                // Fallback (legacy UI): the card's right-click menu yields a real URL.
                if (!started) {
                    const menuUrl = card ? await getContextMenuVideoUrl(card.el) : null;
                    if (menuUrl) {
                        await chrome.runtime.sendMessage({
                            action: 'downloadVideo', videoUrl: menuUrl, filename: videoFilename
                        });
                        log(`Native download triggered: ${videoFilename}`);
                        started = true;
                    }
                }

                if (started) {
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
                await clearRateLimitRetries(pid);   // a save proves we're not throttled — reset budget
                await clearSelectorErrors(pid);     // UI worked — reset selector budget

                if (i < scenes.length - 1) await jitter(4000, 5000); // 4–9s between scenes

            } catch (e) {
                log(`ERROR scene ${nn} attempt ${attempt}: ${e.message}`);
                // A SELECTOR: error means a Flow UI element wasn't found — systemic, not a
                // bad scene. Break out so it's handled WITHOUT spending the scene's budget.
                if (e.message && e.message.startsWith('SELECTOR:')) { selectorError = true; break; }
            }
        }

        // Rate limit takes priority over the failure path: never penalise a scene for
        // a transient throttle. Back off, then retry the SAME scene after a reload.
        // Only stop — honestly, never a false "complete" — if it persists past the cap.
        if (rateLimited) {
            const rl = (await getRateLimitRetries(pid)) + 1;
            if (rl > RATE_LIMIT_MAX_RETRIES) {
                await clearRateLimitRetries(pid);
                log(`Rate limited ${rl - 1}× in a row — stopping for now. No scenes dropped; re-run later to finish.`);
                chrome.runtime.sendMessage({ action: 'videosRateLimited', projectId: pid });
                return;
            }
            await setRateLimitRetries(pid, rl);
            log(`⚠ Rate limited — backing off ${Math.round(RATE_LIMIT_BACKOFF_MS / 1000)}s then retrying scene ${nn} (try ${rl}/${RATE_LIMIT_MAX_RETRIES}, no penalty)`);
            await sleep(RATE_LIMIT_BACKOFF_MS);
            await reloadForRetry(pid, `Scene ${nn}: rate-limit back-off retry`);
            return;
        }

        // A selector/UI element wasn't found — SYSTEMIC (Flow UI), not a bad scene. Like
        // rate-limits, it must NOT spend the scene's fail budget, or one UI change would
        // silently skip all 10 scenes. Retry the same scene after a reload; if it persists
        // past the cap, STOP the whole phase loudly with scenes intact, so a flow.js
        // selector fix + re-run resumes cleanly.
        if (selectorError) {
            const se = (await getSelectorErrors(pid)) + 1;
            if (se > SELECTOR_ERROR_MAX) {
                await clearSelectorErrors(pid);
                log(`❌ Flow UI elements not found ${se - 1}× in a row (Start / "+" / Upload / `
                  + `Add-to-Prompt). STOPPING — Google Flow's UI likely changed. No scenes were `
                  + `marked failed; update flow.js selectors and re-run to resume.`);
                chrome.runtime.sendMessage({ action: 'videosError', projectId: pid, message: 'Flow UI changed — selectors not found' });
                return;
            }
            await setSelectorErrors(pid, se);
            log(`⚠ UI element not found — retrying scene ${nn} after reload (selector try ${se}/${SELECTOR_ERROR_MAX}, NO scene penalty)`);
            await reloadForRetry(pid, `Scene ${nn}: selector not found`);
            return;
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
    await clearRateLimitRetries(pid);
    await clearSelectorErrors(pid);
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
