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

    // Dispatch on the TOPMOST element at that point, not on `el` itself. Playwright's
    // .click() — what the working terminal twin uses — presses a screen coordinate, so the
    // event originates at the innermost child under the cursor and bubbles up through every
    // ancestor. Dispatching straight on a container reaches handlers on that container and
    // ABOVE it only: React resolves a synthetic click by walking the fiber path UPWARD from
    // the event target, so a handler on an inner child never runs. A frame-picker entry is
    // a wrapper around a clickable tile, which is exactly that shape — the click "worked",
    // nothing was selected, and "Add to prompt" stayed greyed for ever.
    // Events still bubble to `el`, so this is strictly more faithful, never less.
    const hit = document.elementFromPoint(cx, cy);
    const target = (hit && (hit === el || el.contains(hit))) ? hit : el;

    const down = {
        bubbles: true, cancelable: true, composed: true, view: window,
        clientX: cx, clientY: cy, screenX: cx, screenY: cy,
        button: 0, buttons: 1, detail: 1,
        pointerId: 1, pointerType: 'mouse', isPrimary: true,
        width: 1, height: 1, pressure: 0.5,
    };
    const up = { ...down, buttons: 0, pressure: 0 };   // no button held any more
    target.dispatchEvent(new PointerEvent('pointerover', down));
    target.dispatchEvent(new PointerEvent('pointerenter', down));
    target.dispatchEvent(new MouseEvent('mouseover', down));
    target.dispatchEvent(new MouseEvent('mouseenter', down));
    target.dispatchEvent(new PointerEvent('pointermove', up));
    target.dispatchEvent(new MouseEvent('mousemove', up));
    target.dispatchEvent(new PointerEvent('pointerdown', down));
    target.dispatchEvent(new MouseEvent('mousedown', down));
    target.dispatchEvent(new PointerEvent('pointerup', up));
    target.dispatchEvent(new MouseEvent('mouseup', up));
    target.dispatchEvent(new MouseEvent('click', up));
}

// Hover only — pointer/mouse move events, and deliberately NO pointerdown/up/click.
// Flow reveals a clip tile's ⋮ button on hover, and that menu is the only correct way to
// download: CLICKING a tile opens Flow's full-screen viewer instead, which is the wrong
// route and leaves the page in a state the rest of the run cannot drive.
function dispatchHover(el) {
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(cx, cy);
    const target = (hit && (hit === el || el.contains(hit))) ? hit : el;
    const opts = {
        bubbles: true, cancelable: true, composed: true, view: window,
        clientX: cx, clientY: cy, screenX: cx, screenY: cy,
        button: 0, buttons: 0, detail: 0,
        pointerId: 1, pointerType: 'mouse', isPrimary: true,
        width: 1, height: 1, pressure: 0,
    };
    target.dispatchEvent(new PointerEvent('pointerover', opts));
    target.dispatchEvent(new PointerEvent('pointerenter', opts));
    target.dispatchEvent(new MouseEvent('mouseover', opts));
    target.dispatchEvent(new MouseEvent('mouseenter', opts));
    target.dispatchEvent(new PointerEvent('pointermove', opts));
    target.dispatchEvent(new MouseEvent('mousemove', opts));
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

// ── The Start frame slot: match its ACCESSIBLE NAME, never raw textContent ─────
// The working terminal twin finds this slot with Playwright's
// get_by_role("button", name="Start", exact=True), which matches the element's
// *accessible name* — and that computation drops aria-hidden icon spans. `el.textContent`
// keeps them, and Google's Material buttons glue the icon ligature onto the label
// ("image" + "Start" → textContent "imageStart"), exactly as documented for
// "videocamVideo" / "addNew project". So `['Start'].includes(textContent.trim())` misses
// the very button Playwright matches: the drop fell back to document.body, the picker was
// never opened, and the scene looped re-uploading the same image. accName() reproduces the
// accessible name; isStartSlot() also accepts the ligature shape, anchored at the END so
// "Start over" can never match.
const SLOT_NAMES = ['Start', 'เริ่ม', 'เริ่มต้น'];

function accNameText(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || '';
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    if (node.getAttribute('aria-hidden') === 'true') return '';
    if (node.tagName === 'SCRIPT' || node.tagName === 'STYLE') return '';
    let s = '';
    for (const child of node.childNodes) s += accNameText(child);
    return s;
}

function accName(el) {
    const aria = (el.getAttribute('aria-label') || '').trim();
    if (aria) return aria;
    return accNameText(el).replace(/\s+/g, ' ').trim();
}

function isStartSlot(el) {
    if (SLOT_NAMES.includes(accName(el))) return true;
    const raw = (el.textContent || '').trim();
    return SLOT_NAMES.some(n => raw.endsWith(n) && raw.length <= n.length + 24);
}

function findStartSlot() {
    for (const el of document.querySelectorAll('button, [role="button"]'))
        if (isVisible(el) && isStartSlot(el)) return el;
    return null;
}

// Dump what the compose row actually holds when a lookup misses, so ONE failing run
// names the real label shape instead of another round of guessing at it.
function dumpComposeButtons(what) {
    const vh = window.innerHeight;
    log(`DIAG: ${what} — visible buttons in the lower viewport:`);
    let n = 0;
    for (const el of document.querySelectorAll('button, [role="button"]')) {
        if (!isVisible(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.top < vh * 0.5) continue;
        if (++n > 14) break;
        log(`  txt="${(el.textContent || '').trim().slice(0, 28)}" acc="${accName(el).slice(0, 24)}"`
          + ` aria="${(el.getAttribute('aria-label') || '').slice(0, 24)}" @${Math.round(r.left)},${Math.round(r.top)}`);
    }
    if (!n) log('  (none)');
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

// Why a button that looks clickable might not be. isEnabled() only knows `disabled` and
// `aria-disabled`; Flow may instead grey a button with a CSS class, and then
// findAddToPromptBtn() hands back a button whose clicks are inert. One dump says which.
function describeButton(el) {
    let cs = {};
    try { cs = getComputedStyle(el); } catch {}
    return `tag=${el.tagName} disabled=${!!el.disabled}`
         + ` aria-disabled=${el.getAttribute('aria-disabled')}`
         + ` class="${String(el.className || '').slice(0, 60)}"`
         + ` pointer-events=${cs.pointerEvents} opacity=${cs.opacity}`;
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
        // Name the disabled button, if there is one: its state says whether Flow is still
        // processing the selected copy or whether nothing was selected at all.
        for (const b of document.querySelectorAll('button, [role="button"]')) {
            const t = (b.textContent || '').trim();
            if (isVisible(b) && ['เพิ่มไปยังพรอมต์', 'Add to prompt'].some(k => t.includes(k))) {
                log(`DIAG: Add-to-prompt button is present but not enabled — ${describeButton(b)}`);
                break;
            }
        }
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
        // Three dead clicks on a button we believe is enabled means "enabled" is wrong,
        // or the click is landing somewhere inert. Say so once, with the evidence.
        if (attempt === 2) log(`DIAG: 3 clicks, panel still open — ${describeButton(el)}`);
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
    return resp.result || '';
}

// Which file this page's Start slot was last confirmed to hold. Kept in chrome.storage so
// it survives reloadForRetry(), which is the whole point: a retry that finds its own image
// already attached must NOT drop it again. Re-dropping every attempt is what filled the
// project with duplicate copies of one scene and made the picker ambiguous.
async function getLastAttached(pid) {
    const key = `flow_attached_${pid}`;
    const r = await chrome.storage.local.get(key);
    return r[key] || '';
}

async function rememberAttached(pid, filename) {
    await chrome.storage.local.set({ [`flow_attached_${pid}`]: filename });
}

async function clearLastAttached(pid) {
    await chrome.storage.local.remove(`flow_attached_${pid}`);
}

// Which scene files have already been uploaded into the CURRENT Flow project. All scenes
// of a reel share one project, and a project survives reloadForRetry(), so a retry must
// not upload the same PNG again: every extra copy shows up in the frame picker under the
// same name, and a copy Flow is still processing keeps "Add to prompt" greyed — so each
// re-upload made the next attempt MORE likely to fail, not less. Cleared when a fresh run
// starts a brand-new project.
async function getDroppedFiles(pid) {
    const key = `flow_dropped_${pid}`;
    const r = await chrome.storage.local.get(key);
    return Array.isArray(r[key]) ? r[key] : [];
}

async function markDropped(pid, filename) {
    const list = await getDroppedFiles(pid);
    if (!list.includes(filename)) list.push(filename);
    await chrome.storage.local.set({ [`flow_dropped_${pid}`]: list });
}

async function unmarkDropped(pid, filename) {
    const list = (await getDroppedFiles(pid)).filter(f => f !== filename);
    await chrome.storage.local.set({ [`flow_dropped_${pid}`]: list });
}

async function clearDroppedFiles(pid) {
    await chrome.storage.local.remove(`flow_dropped_${pid}`);
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
    let sawSlot = false;
    for (let attempt = 0; attempt < 5; attempt++) {
        if (mediaPanelOpen()) {
            // mediaPanelOpen() also answers true for a stray Add-to-prompt / Upload-media
            // button anywhere on the page, so "already open" on the very first check may
            // mean the dialog was never opened at all. Say so — if the picker really is
            // absent, selectPickerFile() finds no entries and reports exactly that.
            if (attempt === 0) log('Frame picker reported already open (no slot click needed)');
            return true;
        }
        const slot = findStartSlot() || findVisible('[aria-label="Image ingredient"]');
        if (slot) {
            sawSlot = true;
            dispatchPointerClick(slot);
            await sleep(2200);
            if (mediaPanelOpen()) { log('Frame picker opened'); return true; }
        }
        await sleep(1200);
    }
    dumpComposeButtons(sawSlot
        ? 'clicked the Start slot but the picker never opened'
        : 'no Start slot / Image ingredient chip found at all');
    return false;
}

// Dismiss the frame picker without choosing anything — used before re-uploading a file the
// picker turned out not to hold.
async function closeFramePicker() {
    for (let attempt = 0; attempt < 3 && mediaPanelOpen(); attempt++) {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await sleep(700);
        if (!mediaPanelOpen()) break;
        for (const el of document.querySelectorAll('button, [role="button"]')) {
            if (!isVisible(el)) continue;
            const name = accName(el);
            if (['Close', 'Cancel', 'ยกเลิก', 'ปิด'].includes(name)) { dispatchPointerClick(el); break; }
        }
        await sleep(700);
    }
    return !mediaPanelOpen();
}

// Select this scene's file by name. The picker tends to preselect the most recent
// upload, but by scene 5 the project holds five images — never rely on that.
const PICKER_ENTRY_SEL = '[role="option"], [role="menuitem"], [role="listitem"], li, button';

// A picker entry is a thumbnail tile, so the name can live in the tile's own text or in an
// attribute (aria-label / title) or on the <img alt>. Searching all of them costs nothing
// and cannot misfire: the match is still the full, unique filename.
function entryCarriesName(el, filename) {
    return (el.textContent || '').includes(filename) ||
           (el.getAttribute('aria-label') || '').includes(filename) ||
           (el.getAttribute('title') || '').includes(filename) ||
           [...el.querySelectorAll('img')].some(i =>
               (i.getAttribute('alt') || '').includes(filename) ||
               (i.getAttribute('title') || '').includes(filename));
}

function findPickerEntries(filename) {
    return [...document.querySelectorAll(PICKER_ENTRY_SEL)]
        .filter(el => isVisible(el) && entryCarriesName(el, filename));
}

// What the page must show before a picker entry counts as SELECTED. Logging the click
// itself as "Selected in picker" is what hid every failure below this step: the click
// landed, nothing was selected, and "Add to prompt" then stayed greyed for ever.
function pickerSelectionSignal(el) {
    if (frameAttached()) return 'frame attached';
    if (findAddToPromptBtn()) return 'Add-to-prompt enabled';
    const marked = el.closest('[aria-selected="true"]') || el.querySelector('[aria-selected="true"]');
    if (el.getAttribute('aria-selected') === 'true' || marked) return 'aria-selected';
    return null;
}

function dumpPickerEntries(filename) {
    log(`DIAG: no selectable entry for "${filename}". Visible picker entries:`);
    let n = 0;
    for (const el of document.querySelectorAll(PICKER_ENTRY_SEL)) {
        if (!isVisible(el)) continue;
        const txt = (el.textContent || '').trim();
        const alt = [...el.querySelectorAll('img')].map(i => i.getAttribute('alt') || '').join('|');
        if (!txt && !alt) continue;
        if (++n > 12) break;
        log(`  txt="${txt.slice(0, 40)}" aria="${(el.getAttribute('aria-label') || '').slice(0, 30)}"`
          + ` alt="${alt.slice(0, 30)}"`);
    }
    if (!n) log('  (none — the picker may not actually be open)');
}

// Select this scene's file by name. The picker tends to preselect the most recent
// upload, but by scene 5 the project holds five images — never rely on that.
async function selectPickerFile(filename) {
    // Wait for the entries to render.
    let entries = [];
    const end = Date.now() + 45000;
    while (Date.now() < end) {
        entries = findPickerEntries(filename);
        if (entries.length) break;
        await sleep(1000);
    }
    if (!entries.length) { dumpPickerEntries(filename); return false; }
    log(`Picker holds ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} named ${filename}`);

    // Try several: a project can hold more than one copy of a scene (earlier retries used
    // to re-upload every time), and a copy Flow is still processing leaves "Add to prompt"
    // permanently greyed — documented in findAddToPromptBtn(). The next copy is usually
    // fine, so a dead entry moves on instead of failing the whole scene.
    for (let i = 0; i < 4; i++) {
        const list = findPickerEntries(filename);
        if (!list.length) break;
        const el = list[i % list.length];
        try { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch {}
        await sleep(300);
        dispatchPointerClick(el);

        for (let w = 0; w < 6; w++) {
            const signal = pickerSelectionSignal(el);
            if (signal) {
                log(`Selected in picker: ${filename} (copy ${(i % list.length) + 1}/${list.length} — ${signal})`);
                return true;
            }
            await sleep(800);
        }
        log(`Picker copy ${(i % list.length) + 1}: click produced no selection signal — trying another`);
    }

    dumpPickerEntries(filename);
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
    // No chip, so fall back to "the slot no longer offers an empty Start". This MUST use
    // the accessible-name matcher: with the old raw-textContent test an icon-ligature label
    // never matched, so an empty slot read as "attached" — a false pass in the other
    // direction, which would have generated a video with no start frame at all.
    return !findStartSlot();
}

async function uploadSceneImage(pid, imgPath, filename) {
    log(`Uploading: ${filename}...`);

    // Step 0: this scene's image may already be sitting in the Start slot — from a retry
    // after reloadForRetry(), or because Flow restored the compose bar. Dropping it again
    // achieves nothing except another copy in the library, and re-dropping on every
    // attempt is precisely what looked like "the same image uploads over and over, and
    // no video is ever made".
    if (frameAttached() && (await getLastAttached(pid)) === filename) {
        log(`✓ Start frame already holds ${filename} — skipping the upload`);
        return;
    }

    // Step 1: drop the file — Flow uploads it into the project's media library — UNLESS
    // this project already has it from an earlier attempt. Re-dropping every attempt is
    // what the user sees as "it keeps uploading the same image", and it actively poisons
    // the next attempt: each copy appears in the picker under the same name, and a copy
    // Flow is still processing leaves "Add to prompt" greyed for ever. If the recorded
    // upload turns out not to be in the picker, step 3 drops it once and retries.
    const alreadyUploaded = (await getDroppedFiles(pid)).includes(filename);
    let slotWasEmpty = false;
    let dropResult = '';
    if (alreadyUploaded) {
        log(`Step 1: ${filename} is already in this Flow project — not uploading it again`);
    } else {
        // Note whether the Start slot is EMPTY first: that decides whether the drop can be
        // trusted to have attached our image by itself (below).
        log('Step 1: Dropping file into Flow...');
        slotWasEmpty = !!findStartSlot();
        dropResult = await dropSceneImage(imgPath, filename);
        await markDropped(pid, filename);
        await waitForUploadFinished();
    }

    // Step 1b: an empty slot that now holds an image was filled by this drop — the only
    // file we dropped — so the picker has nothing left to do, and clicking the slot again
    // would only risk clearing it. Scene 2 onward starts with the previous scene's frame
    // still in the slot, so slotWasEmpty is false there and the picker route runs.
    //
    // The skip demands the POSITIVE signal — the chip itself — never frameAttached(),
    // whose fallback is merely "no empty Start slot visible". A slot mid-upload can show
    // a spinner with the word "Start" already gone and no chip yet, and that negative
    // test would call it attached: the prompt would fill, Generate would fire, and Flow
    // would return a text-only clip with no start frame that still counts as done. If
    // the chip's aria-label ever changes this skip simply stops firing and every scene
    // takes the picker route, which is the understood path.
    if (slotWasEmpty && findVisible('[aria-label="Image ingredient"]')) {
        await rememberAttached(pid, filename);
        log(`✓ Drop attached ${filename} to the Start frame directly (${dropResult})`);
        return;
    }

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
        // Skipping the upload (step 1) is only ever an optimisation — if the file this
        // project was recorded as holding is not selectable after all, forget the record,
        // upload it once, and try the picker again. Without this the skip could loop.
        if (!alreadyUploaded) {
            throw new Error(`SELECTOR: "${filename}" was not listed in the frame picker`);
        }
        log('Recorded upload is not selectable — uploading it once more');
        await unmarkDropped(pid, filename);
        await closeFramePicker();
        await dropSceneImage(imgPath, filename);
        await markDropped(pid, filename);
        await waitForUploadFinished();
        if (!await openFramePicker()) {
            throw new Error('SELECTOR: frame picker did not reopen after re-upload');
        }
        await jitter(1200, 1200);
        if (!await selectPickerFile(filename)) {
            throw new Error(`SELECTOR: "${filename}" was not listed in the frame picker`);
        }
    }

    // Step 4: clicking the entry normally attaches it and closes the picker outright,
    // so "Add to prompt" is often already gone — click it only while it is still there.
    log('Step 4: Attaching to the Start frame...');
    if (!frameAttached() && addToPromptVisible()) await clickAddToPrompt();
    for (let i = 0; i < 8 && !frameAttached(); i++) await sleep(1000);
    if (!frameAttached()) {
        dumpComposeButtons('picker entry was selected but no frame attached');
        throw new Error('SELECTOR: scene image was not attached to the Start frame');
    }
    await rememberAttached(pid, filename);
    log(`✓ Image attached to prompt: ${filename}`);
}

// The compose bar's text input, whatever Flow builds it from this month. waitForCompose()
// already proves one of these exists — and the old fallback list held only textarea/input,
// so a contenteditable or role=textbox compose bar had no working path at all. The terminal
// twin, which works on this UI, tries exactly this list.
const PROMPT_SELECTORS = ['[data-slate-editor="true"]', '[contenteditable="true"]',
                          '[role="textbox"]', 'textarea', 'input[type="text"]'];

function findPromptEditors() {
    const vh = window.innerHeight;
    const seen = new Set();
    const out = [];
    for (const sel of PROMPT_SELECTORS) {
        for (const el of document.querySelectorAll(sel)) {
            if (seen.has(el) || !isVisible(el)) continue;
            if (el.getBoundingClientRect().top < vh * 0.35) continue;   // the compose bar sits low
            seen.add(el);
            out.push(el);
        }
    }
    out.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
    return out;   // lowest first — that is the compose bar
}

// An editor's REAL text. Slate renders its placeholder ("What do you want to create?")
// in a child span INSIDE the editable, so a plain textContent read reports an empty box as
// filled — which is exactly how a silent failure passed verification.
function editorText(el) {
    if (!el) return '';
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return (el.value || '').trim();
    try {
        const clone = el.cloneNode(true);
        clone.querySelectorAll('[data-slate-placeholder], [data-placeholder]')
             .forEach(ph => ph.remove());
        return (clone.textContent || '').trim();
    } catch { return (el.textContent || '').trim(); }
}

// Did OUR prompt land? Never "is there any text": that question is what let an untouched
// compose bar report success. Whitespace may be renormalised by the editor, so both sides
// are collapsed and compared on length AND on a leading slice.
function promptFilled(text) {
    const norm = s => s.replace(/\s+/g, ' ').trim();
    const want = norm(text);
    const need = Math.max(20, Math.floor(want.length * 0.5));
    const head = want.slice(0, 20);
    return findPromptEditors().some(el => {
        const got = norm(editorText(el));
        return got.length >= need && got.includes(head);
    });
}

function dumpPromptEditors() {
    log('DIAG: prompt never landed. Candidate compose inputs:');
    let n = 0;
    for (const el of findPromptEditors()) {
        if (++n > 6) break;
        const r = el.getBoundingClientRect();
        log(`  tag=${el.tagName} role="${el.getAttribute('role') || ''}"`
          + ` editable=${el.getAttribute('contenteditable')}`
          + ` slate=${el.getAttribute('data-slate-editor')}`
          + ` chars=${editorText(el).length} @${Math.round(r.left)},${Math.round(r.top)}`);
    }
    if (!n) log('  (none found in the lower viewport)');
}

async function fillVideoPrompt(text) {
    // Google Flow uses Slate.js. ANY browser-level selection change on the editor
    // (execCommand selectAll, getSelection().addRange, etc.) fires selectionchange →
    // Slate calls toSlateRange() on container nodes → crashes. The crash-free path is to
    // call editor.insertText() through Slate's own API, and content scripts have no access
    // to React/Slate internals, so background.js runs it with world:'MAIN'.
    const resp = await chrome.runtime.sendMessage({ action: 'fillSlate', text }).catch(() => null);
    await sleep(300);

    if (promptFilled(text)) {
        log(`Prompt filled (${text.length} chars via Slate main-world, bg=${resp?.result})`);
        return;
    }
    log(resp && !resp.ok
        ? `Slate main-world failed: ${resp.result || resp.error} — trying the compose input directly`
        : `Slate main-world returned ${resp?.result} but the prompt is NOT in the box — trying the compose input directly`);

    for (const el of findPromptEditors()) {
        try { el.scrollIntoView({ block: 'nearest' }); } catch {}
        dispatchPointerClick(el);
        await sleep(200);
        try { el.focus(); } catch {}
        await sleep(200);

        if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
            const proto  = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype
                                                     : HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, 'value');
            if (setter?.set) setter.set.call(el, text); else el.value = text;
            el.dispatchEvent(new Event('input',  { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
            // Contenteditable (Slate and friends). insertText is the browser's own editing
            // command, so the input events it fires are trusted and editors honour them.
            // focus() alone puts the caret in — deliberately NO selectAll/addRange, which
            // is the documented Slate crash. Last resort, and never fatal on its own.
            try { document.execCommand('insertText', false, text); } catch (e) {
                log(`insertText failed on ${el.tagName}: ${e.message}`);
            }
        }

        await sleep(400);
        if (promptFilled(text)) {
            log(`Prompt filled (${text.length} chars via ${el.tagName}`
              + `${el.getAttribute('contenteditable') === 'true' ? '[contenteditable]' : ''})`);
            return;
        }
    }

    // Never continue to Generate on an empty box: Flow would either refuse (and the run
    // would die later as a confusing "Generate button not found") or generate a text-less
    // clip that still counts as done. SELECTOR: puts this in the systemic bucket, so it
    // retries after a reload and stops loudly instead of burning the scene's fail budget.
    dumpPromptEditors();
    throw new Error('SELECTOR: could not type the video prompt into the compose bar');
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

    // Not found usually means "found but disabled" — Flow greys the arrow until the
    // compose bar has both a frame and a prompt. Name what is actually there.
    const vh = window.innerHeight;
    log('DIAG: Generate not found. Lower-viewport buttons and their state:');
    let n = 0;
    for (const b of document.querySelectorAll('button, [role="button"]')) {
        if (!isVisible(b) || b.getBoundingClientRect().top < vh * 0.3) continue;
        if (++n > 10) break;
        log(`  txt="${(b.textContent || '').trim().slice(0, 24)}" ${describeButton(b)}`);
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

// Newest generated-clip tile (the grid is newest-first), or null. Top row first, then
// left-most within that row — sorting on `left` alone picked a second-row tile whenever
// the grid wrapped.
function newestClipTile() {
    const tiles = [...document.querySelectorAll('img[alt="Generated video thumbnail"]')].filter(isVisible);
    if (!tiles.length) return null;
    const minTop = Math.min(...tiles.map(t => t.getBoundingClientRect().top));
    return tiles
        .filter(t => t.getBoundingClientRect().top <= minTop + 40)
        .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)[0];
}

// Is this button sitting on top of the tile? Scoping by GEOMETRY rather than by climbing
// the DOM does two things a parent walk cannot: the page header's own ⋮ buttons are
// excluded however the tree is shaped, and an overlay rendered through a React portal
// (outside the tile's ancestors entirely) is still found.
function overTile(el, tileRect) {
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    return cx >= tileRect.left - 24 && cx <= tileRect.right + 24 &&
           cy >= tileRect.top  - 24 && cy <= tileRect.bottom + 24;
}

// The ⋮ button Flow reveals on a hovered clip tile.
function findTileMenuButton(tile) {
    const t = tile.getBoundingClientRect();
    for (const b of document.querySelectorAll('button, [role="button"]')) {
        if (!isVisible(b) || !overTile(b, t)) continue;
        const txt  = (b.textContent || '').trim();
        const name = `${accName(b)} ${b.getAttribute('aria-label') || ''}`.toLowerCase();
        if (txt.includes('more_vert') || txt.includes('more_horiz') ||
            txt === '⋮' || txt === '…' ||
            /more option|more action|options|ตัวเลือก|เพิ่มเติม/.test(name) ||
            name.trim() === 'more') {
            return b;
        }
    }
    return null;
}

// A visible menu entry whose text (or accessible name) matches. `excludeRe` keeps the
// paid/undesired resolutions out.
function findMenuItem(re, excludeRe) {
    for (const el of document.querySelectorAll('[role="menuitem"], [role="option"], li, button, a')) {
        if (!isVisible(el)) continue;
        const t = (el.textContent || '').trim();
        if (!t) continue;
        if (excludeRe && excludeRe.test(t)) continue;
        if (re.test(t) || re.test(accName(el))) return el;
    }
    return null;
}

function dumpMenuItems(what) {
    log(`DIAG: ${what} — visible menu entries:`);
    let n = 0;
    for (const el of document.querySelectorAll('[role="menuitem"], [role="option"], li, button, a')) {
        if (!isVisible(el)) continue;
        const t = (el.textContent || '').trim();
        if (!t || t.length > 60) continue;
        if (++n > 14) break;
        log(`  "${t.slice(0, 40)}" acc="${accName(el).slice(0, 24)}"`);
    }
    if (!n) log('  (none)');
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

// Save the newest clip the way the UI is meant to be driven:
//
//   HOVER the newest tile (never click it) → the ⋮ appears on the tile → click ⋮ →
//   "Download" → "720p".
//
// **Never click the clip tile.** A click opens Flow's full-screen viewer; the layout that
// leaves behind is not what the rest of this run can drive, and the old
// downloadClipViaViewer() did exactly that as its first step. Do not reintroduce it.
// 720p is also the only resolution to take automatically: it is what the clip was
// generated at, so it is already rendered and free, while "1080p Upscaled" re-renders it
// and "4K Upscaled" spends 50 credits; 270p is a GIF.
// Returns true once the rename was armed and the download started — the caller then waits
// for the file to land in working/.
async function downloadNewestClip(videoFilename) {
    const tile = newestClipTile();
    if (!tile) { log('No clip thumbnail found to download'); return false; }
    try { tile.scrollIntoView({ block: 'nearest' }); } catch {}
    await sleep(400);

    // 1. Hover the tile until its ⋮ button appears. Hover only — see above.
    let menuBtn = null;
    for (let attempt = 0; attempt < 4 && !menuBtn; attempt++) {
        dispatchHover(tile);
        await sleep(900);
        menuBtn = findTileMenuButton(tile);
    }
    if (!menuBtn) {
        const t = tile.getBoundingClientRect();
        log('DIAG: hovering the clip tile revealed no ⋮ button. Buttons over the tile:');
        let n = 0;
        for (const b of document.querySelectorAll('button, [role="button"]')) {
            if (!isVisible(b) || !overTile(b, t)) continue;
            if (++n > 10) break;
            log(`  txt="${(b.textContent || '').trim().slice(0, 24)}"`
              + ` acc="${accName(b).slice(0, 24)}" aria="${b.getAttribute('aria-label') || ''}"`);
        }
        if (!n) log(`  (none over the tile at ${Math.round(t.left)},${Math.round(t.top)})`);
        return false;
    }

    // 2. Open the tile's own menu.
    dispatchPointerClick(menuBtn);
    await sleep(1200);

    // 3. "Download" — a submenu trigger, so click it and hover it as well; menus differ
    //    on which gesture expands them.
    const dl = findMenuItem(/^(ดาวน์โหลด|Download)$/i) || findMenuItem(/download|ดาวน์โหลด/i);
    if (!dl) {
        dumpMenuItems('no "Download" entry in the clip menu');
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return false;
    }
    dispatchPointerClick(dl);
    await sleep(1000);
    dispatchHover(dl);
    await sleep(800);

    // 4. Arm the rename BEFORE the click that starts the download, then take 720p only.
    //    A missing 720p is a hard stop: nothing else may be clicked, because the
    //    alternatives re-render the clip or cost credits.
    let pick = null;
    for (let attempt = 0; attempt < 3 && !pick; attempt++) {
        if (attempt > 0) { dispatchHover(dl); await sleep(900); }
        pick = findMenuItem(/720/, /4K|GIF|1080|Upscal/i);
    }
    if (!pick) {
        dumpMenuItems('no 720p option under Download');
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return false;
    }

    const armed = chrome.runtime
        .sendMessage({ action: 'expectClipDownload', filename: videoFilename, timeoutMs: 90000 })
        .catch(() => null);
    const label = (pick.textContent || '').trim().slice(0, 40);
    dispatchPointerClick(pick);

    const resp = await armed;
    // Tidy up: close any menu still open, and bail out of the viewer if something did
    // manage to open it, so the next scene starts from the normal layout.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(500);
    if (findVisible('[aria-label="Back button to go to previous page"]')) await leaveClipViewer();

    if (resp && resp.ok) {
        log(`Clip download started (${label}) → ${videoFilename}`);
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

// The retry flag is only meaningful for the few seconds between reloadForRetry() and the
// reload it triggers, so it carries a timestamp and expires. A run the user stops in that
// window (or a crashed tab) used to leave the flag set for ever, and the NEXT fresh run
// then took the isRetry path: no clickNewProject(), so it resumed inside the old project —
// the one already full of duplicate uploads from the failed loop. Legacy values (the
// string '1') have no timestamp and are treated as absent, i.e. as a fresh run.
const RETRY_FLAG_TTL_MS = 5 * 60 * 1000;

async function isRetryAfterReload(pid) {
    const key = `flow_retry_${pid}`;
    const r = await chrome.storage.local.get(key);
    const v = r[key];
    if (typeof v !== 'number') return false;
    return Date.now() - v < RETRY_FLAG_TTL_MS;
}

async function clearRetryFlag(pid) {
    // Remove both the pid-scoped key and the old global key (cleans up stale leftovers).
    await chrome.storage.local.remove([`flow_retry_${pid}`, 'flow_retry']);
}

async function reloadForRetry(pid, reason) {
    log(`${reason} — reloading page for clean retry`);
    // Flag tells the next run (after reload) to skip clickNewProject + settings —
    // the page reloads back into the same project, compose bar already ready.
    await chrome.storage.local.set({ [`flow_retry_${pid}`]: Date.now() });
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
        await clearLastAttached(pid);       // a brand-new project has an empty Start slot
        await clearDroppedFiles(pid);       // ...and an empty media library
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
                await uploadSceneImage(pid, imgPath, `${pid}-scene-${nn}.png`);
                await jitter(4000, 3500); // 4–7.5s: let compose bar settle after panel closes

                const videoPrompt = cutAtEndMarker(scene.video_prompt.trim(), 'VIDEO')
                    + '\n\n--- The End of VIDEO PROMPTS ---';
                await fillVideoPrompt(videoPrompt);
                await jitter(1500, 1500); // 1.5–3s: wait for Slate re-render

                // Attaching the frame re-renders the compose bar, so check again right
                // here rather than trusting the fill. Generating with an empty box is
                // never acceptable: Flow either refuses, or returns a clip that ignored
                // the prompt and still counts as this scene's deliverable.
                if (!promptFilled(videoPrompt)) {
                    dumpPromptEditors();
                    throw new Error('SELECTOR: compose bar lost the video prompt before Generate');
                }

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

                // Primary (current UI): hover the newest tile → its ⋮ → Download → 720p,
                // renamed in flight by background.js so monitor.py files it into working/.
                let started = await downloadNewestClip(videoFilename);

                // Fallback (legacy UI only): the card's right-click menu yields a real URL.
                // Unreachable on the current UI, which has no <video> elements at all.
                if (!started) {
                    const card = getVideoCardEl(clipsBefore);
                    const menuUrl = card ? await getContextMenuVideoUrl(card.el) : null;
                    if (menuUrl) {
                        await chrome.runtime.sendMessage({
                            action: 'downloadVideo', videoUrl: menuUrl, filename: videoFilename
                        });
                        log(`Native download triggered: ${videoFilename}`);
                        started = true;
                    } else {
                        const src = card ? (card.v.src || card.v.currentSrc || '') : '';
                        const streamUrl = (src && !src.startsWith('blob:')) ? src : null;
                        if (streamUrl) {
                            log(`Menu unavailable — streaming URL fallback for ${videoFilename}`);
                            await downloadVideoToServer(streamUrl, videoFilename);
                            started = true;
                        }
                    }
                }

                // No download route worked. This used to `continue`, which sent the scene
                // straight back through upload → prompt → Generate and spent a second
                // generation on a clip that already existed. A UI miss here is systemic,
                // so SELECTOR: stops loudly with the scene intact instead.
                if (!started) {
                    throw new Error('SELECTOR: could not start the clip download '
                                  + '(hover tile → ⋮ → Download → 720p)');
                }

                log(`Waiting for ${videoFilename} to appear in working/...`);
                const appeared = await waitForFileInWorking(page, videoFilename, 180000);
                if (!appeared) {
                    reloadReason = `Scene ${nn}: download timed out after 3 min`;
                    break;
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
    await clearLastAttached(pid);
    await clearDroppedFiles(pid);
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
