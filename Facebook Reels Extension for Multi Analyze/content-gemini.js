// content-gemini.js — Injected into Gemini (gemini.google.com) tabs by the Multi
// Analyze extension. It is the GEMINI sibling of content-chatgpt.js and speaks the
// EXACT same message protocol (PING, START_SLOT → SLOT_PROGRESS / SLOT_COMPLETE /
// SLOT_ERROR / SLOT_URL), so sidepanel.js drives it with no engine-specific code.
//
// The user pre-sets Gemini's model to "3.1 Pro + Extended" and lets Gemini remember
// it — so this script NEVER selects a model. The diagnostic below verifies the model
// pill (trap #1) so we catch a background-tab default before it ruins briefs silently.
//
// ── TWO-PASS BUILD ────────────────────────────────────────────────────────────
// PASS A (now): DIAGNOSTIC = true. On run, the script dumps Gemini's real DOM
//   (composer, send button, upload control, response container, model pill, the
//   conversation URL) to the side-panel log AND the DevTools console, then STOPS
//   without touching anything. The user runs ONE slot once and pastes the dump back;
//   we lock in the exact selectors from it (never from memory).
// PASS B (after selectors are confirmed): set DIAGNOSTIC = false. The real pipeline
//   below then runs — mirroring content-chatgpt.js step-for-step.
//
// The SELECTORS object is the only thing Pass B edits. Everything else is structural.

(function () {
  'use strict';

  if (window.__fbGeminiAnalyzerLoaded) return;
  window.__fbGeminiAnalyzerLoaded = true;

  // ── PASS A/B switch ───────────────────────────────────────────────────────────
  // 'dom'    = dump the page DOM and stop   (done — gave us composer/upload selectors)
  // 'menu'   = click the model pill + Thinking-level submenu and dump it (done)
  // 'upload' = click "Upload & tools" and dump the menu + file inputs (done — gave us
  //            the "Upload files" item; video now uses armFileInputCapture)
  // ''       = live run (PASS B)
  const DIAG = '';

  // First-run instrumentation: log the streaming-state DOM ~7s after sending.
  // Stop button CONFIRMED 2026-06-27 as aria "Stop response", so this is now off.
  const PROBE_GENERATING = false;

  // Diagnostic-upload mode (image first, video paste-only + fail-fast + green-box dump).
  // OFF now — root causes found and fixed: (1) attachedSince false-success on a filename
  // already on the page → now a strict delta; (2) video chip appears only when its slow
  // upload finishes (~30s+) → video now gets a long single-window paste.
  const DEBUG_UPLOAD = false;

  // ── Candidate selectors (best-effort; CONFIRM/REPLACE from the diagnostic dump) ─
  // Gemini's web app is an Angular SPA. These are reasonable starting guesses with
  // robust fallbacks; the diagnostic exists precisely so we don't ship guesses blind.
  const SELECTORS = {
    // CONFIRMED 2026-06-27 (live diagnostic): Quill editor, aria "Enter a prompt for Gemini".
    composer: [
      '.ql-editor[contenteditable="true"]',
      'div[aria-label="Enter a prompt for Gemini"]',
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"]',
      'textarea',
    ],
    // The Send button is absent until text is typed, so it was NOT in the discovery
    // dump. "Send message" is Gemini's standard aria-label; clickSend() has an
    // Enter-key fallback if these miss. (Verify on the first live run.)
    send: [
      'button[aria-label="Send message"]',
      'button[aria-label*="Send" i]',
      '.send-button-container button',
      'button.send-button',
      'button[aria-label*="ส่ง"]',
    ],
    // The hidden file input(s) Gemini uses for uploads.
    fileInput: [
      'input[type="file"]',
    ],
    // CONFIRMED 2026-06-27: the composer's upload entry point is aria "Upload & tools"
    // (opens a menu; uploadFile() then picks the file option and uses the input).
    attach: [
      'button[aria-label="Upload & tools"]',
      'button[aria-label*="upload" i]',
      'button[aria-label*="add files" i]',
      'button[aria-label*="attach" i]',
      'button[aria-label*="แนบ"]',
    ],
    // No response existed at discovery time, so these are unconfirmed — Gemini's
    // standard response classes, with a largest-text-block fallback in
    // extractResponse(). (Verify on the first live run.)
    response: [
      '.model-response-text',
      'message-content',
      'model-response .markdown',
      '.conversation-container .markdown',
      '.markdown',
    ],
  };

  // ── Utilities ───────────────────────────────────────────────────────────────

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function report(slotIndex, status, message) {
    chrome.runtime.sendMessage({ type: 'SLOT_PROGRESS', slotIndex, status, message }).catch(() => {});
  }

  // ── Upload turn (serialized by sidepanel.js) ──────────────────────────────────
  // Ask the side panel for permission to do the heavy model-set + upload, and wait
  // until it's this tab's turn. Safety-timed so it can NEVER deadlock the slot.
  let _uploadGrantResolve = null;
  function acquireUploadLock(slotIndex) {
    return new Promise((resolve) => {
      _uploadGrantResolve = resolve;
      chrome.runtime.sendMessage({ type: 'ACQUIRE_UPLOAD', slotIndex }).catch(() => {});
      // Never deadlock: if no grant arrives in 5 min (well beyond any real queue wait),
      // proceed anyway. This only fires on a genuine coordination failure, not normal
      // queueing, so a legitimately-waiting tab won't jump its turn.
      setTimeout(() => { if (_uploadGrantResolve === resolve) { _uploadGrantResolve = null; resolve(); } }, 300000);
    });
  }
  function releaseUploadLock(slotIndex) {
    chrome.runtime.sendMessage({ type: 'RELEASE_UPLOAD', slotIndex }).catch(() => {});
  }

  function pick(list) {
    for (const sel of list) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function pickAll(list) {
    for (const sel of list) {
      const els = document.querySelectorAll(sel);
      if (els.length) return Array.from(els);
    }
    return [];
  }

  function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0';
  }

  function trunc(s, n = 60) {
    s = (s || '').replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n) + '…' : s;
  }

  // Status overlay in top-right corner.
  function showStatus(msg) {
    let el = document.getElementById('fb-gemini-status');
    if (!el) {
      el = document.createElement('div');
      el.id = 'fb-gemini-status';
      el.style.cssText = `
        position:fixed;top:16px;right:16px;z-index:2147483647;
        background:#11231a;color:#7effb8;padding:10px 16px;
        border-radius:10px;border:1px solid #2a7e5a;
        font-family:monospace;font-size:12px;max-width:340px;
        box-shadow:0 4px 20px rgba(0,0,0,0.7);line-height:1.5;pointer-events:none;
        white-space:pre-wrap;
      `;
      document.body?.appendChild(el);
    }
    el.textContent = `✨ Gemini Analyze\n${msg}`;
  }

  function removeStatus() {
    document.getElementById('fb-gemini-status')?.remove();
  }

  // ── Gemini element getters (resolve from SELECTORS with fallbacks) ────────────

  function getTextarea() { return pick(SELECTORS.composer); }
  function getSendButton() { return pick(SELECTORS.send); }

  function findStopButton() {
    return Array.from(document.querySelectorAll('button')).find(b => {
      const l = (b.getAttribute('aria-label') || '').toLowerCase();
      if (l.includes('stop') &&
          (l.includes('respon') || l.includes('generat') || l.includes('answer') || l.trim() === 'stop')) {
        return true;
      }
      // Icon-based stop button (Material icon name / fonticon / glyph text "stop").
      const icon = b.querySelector('mat-icon, [fonticon], [data-mat-icon-name]');
      const iname = (icon?.getAttribute('fonticon') || icon?.getAttribute('data-mat-icon-name') ||
                     icon?.textContent || '').trim().toLowerCase();
      return iname === 'stop';
    }) || null;
  }

  function isGenerating() {
    // A stop button is shown while Gemini streams — the most reliable signal.
    if (findStopButton()) return true;
    // The transient blinking cursor also marks active streaming. We deliberately do
    // NOT key off generic [role="progressbar"]/[class*="loading"] nodes: Gemini may
    // keep one mounted permanently, which would make isGenerating() stick true and
    // hang the wait for the full 30-min timeout (a false positive is the costly case).
    if (document.querySelector('.blinking-cursor')) return true;
    return false;
  }

  function isSendReady() {
    const btn = getSendButton();
    return btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true';
  }

  function getResponseNodes() {
    return pickAll(SELECTORS.response).filter(isVisible);
  }

  function lastResponseText() {
    const nodes = getResponseNodes();
    if (!nodes.length) return '';
    return (nodes[nodes.length - 1].innerText || nodes[nodes.length - 1].textContent || '');
  }

  // Count blob-URL images — when an image attaches, Gemini renders a blob: preview.
  function countBlobPreviews() {
    return Array.from(document.querySelectorAll('img')).filter(
      i => (i.src || '').startsWith('blob:')
    ).length;
  }

  async function waitFor(fn, timeout = 30000, interval = 400) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const el = fn();
      if (el) return el;
      await sleep(interval);
    }
    throw new Error(`waitFor timed out after ${timeout}ms`);
  }

  async function waitForReady() {
    await waitFor(getTextarea, 45000);
    // Give the rest of the composer (upload control, buttons) time to initialise.
    await sleep(4000);
  }

  // ── DIAGNOSTIC (Pass A) ───────────────────────────────────────────────────────
  // Dumps everything we need to write exact selectors, then ends the slot WITHOUT
  // writing a file (sends SLOT_ERROR, which sidepanel.js does not persist). The
  // "error" badge here just means "diagnostic stop", not a failure — the message says so.

  function findModelPill() {
    // Trap #1: the model pill should read "3.1 Pro" + "Extended". Find any short
    // element whose text mentions the model tiers so we can eyeball stickiness.
    const hits = [];
    const re = /(Pro|Flash|Flash-Lite|Deep Think|Extended|Standard|Thinking)/i;
    for (const el of document.querySelectorAll('button, span, div, [role="button"]')) {
      const t = (el.innerText || '').trim();
      if (t && t.length <= 40 && re.test(t) && isVisible(el)) hits.push(trunc(t, 40));
    }
    return [...new Set(hits)].slice(0, 8);
  }

  function collectDiagnostic() {
    const lines = [];
    const push = (k, v) => lines.push(`${k}: ${v}`);

    push('URL', location.href);
    push('TITLE', trunc(document.title, 80));

    // Model pill (trap #1)
    const pills = findModelPill();
    push('MODEL-PILL-CANDIDATES', pills.length ? pills.join(' | ') : '(none found — CHECK MANUALLY)');

    // Composer candidates
    lines.push('— COMPOSER CANDIDATES —');
    const composerSels = [
      'rich-textarea .ql-editor', '.ql-editor', 'div[contenteditable="true"]',
      'div[role="textbox"]', 'textarea',
    ];
    for (const sel of composerSels) {
      const els = Array.from(document.querySelectorAll(sel)).filter(isVisible);
      if (els.length) {
        const e = els[0];
        push(`  ${sel} (x${els.length})`,
          `tag=${e.tagName.toLowerCase()} class="${trunc(e.className, 50)}" ` +
          `aria="${e.getAttribute('aria-label') || ''}" ph="${e.getAttribute('data-placeholder') || e.getAttribute('placeholder') || ''}"`);
      }
    }

    // File inputs
    const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
    push('FILE-INPUTS', inputs.length
      ? inputs.map(i => `accept="${i.accept || ''}" multiple=${i.multiple}`).join(' || ')
      : '(none in DOM yet — may appear after clicking the + button)');

    // All visible buttons (text + aria + position) — capped.
    lines.push('— VISIBLE BUTTONS (aria | text | x,y) —');
    const btns = Array.from(document.querySelectorAll('button, [role="button"]')).filter(isVisible);
    let count = 0;
    for (const b of btns) {
      if (count++ >= 45) { lines.push(`  …(+${btns.length - 45} more)`); break; }
      const r = b.getBoundingClientRect();
      const aria = b.getAttribute('aria-label') || '';
      const txt = trunc(b.textContent, 30);
      lines.push(`  [${aria || '∅'}] "${txt}" @${Math.round(r.left)},${Math.round(r.top)}`);
    }

    // Response containers (will usually be empty before sending — that's expected)
    lines.push('— RESPONSE CONTAINER CANDIDATES —');
    for (const sel of ['message-content', '.model-response-text', '[class*="model-response"]', '.markdown', 'response-element']) {
      const n = document.querySelectorAll(sel).length;
      if (n) push(`  ${sel}`, `count=${n}`);
    }

    return lines;
  }

  // Render the dump into a big, pre-selected textarea ON THE GEMINI PAGE, so the user
  // just switches to this tab and hits Ctrl+A → Ctrl+C (no DevTools, no fiddly
  // side-panel row selection). The diagnostic tab is left open (SLOT_ERROR does not
  // close it), so this box stays available to copy from.
  function showDiagnosticBox(dump) {
    document.getElementById('fb-gemini-diag-box')?.remove();
    const wrap = document.createElement('div');
    wrap.id = 'fb-gemini-diag-box';
    wrap.style.cssText = `
      position:fixed;inset:5% 5% auto 5%;z-index:2147483647;
      background:#0a1410;border:2px solid #2a7e5a;border-radius:12px;
      box-shadow:0 8px 40px rgba(0,0,0,0.8);padding:14px;font-family:monospace;
    `;
    const head = document.createElement('div');
    head.style.cssText = 'color:#7effb8;font-size:14px;font-weight:700;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;';
    head.innerHTML = '<span>✨ Gemini diagnostic ready — click the box, Ctrl+A, Ctrl+C, paste to Claude</span>';
    const close = document.createElement('button');
    close.textContent = '✕';
    close.style.cssText = 'background:none;border:none;color:#7effb8;font-size:18px;cursor:pointer;';
    close.onclick = () => wrap.remove();
    head.appendChild(close);
    const ta = document.createElement('textarea');
    ta.readOnly = true;
    ta.value = dump;
    ta.style.cssText = `
      width:100%;height:50vh;background:#06100c;color:#cfeede;border:1px solid #1e3a2c;
      border-radius:8px;padding:10px;font-family:monospace;font-size:12px;line-height:1.4;
      white-space:pre;resize:vertical;box-sizing:border-box;
    `;
    ta.addEventListener('focus', () => ta.select());
    wrap.appendChild(head);
    wrap.appendChild(ta);
    document.body?.appendChild(wrap);
    try { ta.focus(); ta.select(); } catch {}
  }

  async function runDiagnostic(slotIndex) {
    const lines = collectDiagnostic();
    const dump = '════ GEMINI DIAGNOSTIC (send all of this to Claude) ════\n' +
                 lines.join('\n') +
                 '\n════ END GEMINI DIAGNOSTIC ════';

    // 1) On-page copyable box (primary — no DevTools needed).
    showDiagnosticBox(dump);
    // 2) DevTools console (secondary copy path).
    try { console.log('[gemini-diag]\n' + dump); } catch {}
    // 3) Side-panel: a short pointer (not the whole 50-line dump).
    report(slotIndex, 'extracting', '🔬 Diagnostic ready — switch to the Gemini tab and copy the green box (Ctrl+A → Ctrl+C).');

    removeStatus();
    // End the slot WITHOUT writing a brief file. SLOT_ERROR is intentional here —
    // the "error" badge just means "diagnostic stop", not a failure.
    chrome.runtime.sendMessage({
      type: 'SLOT_ERROR',
      slotIndex,
      error: 'Diagnostic done ✅ — open the Gemini tab, copy the green box, and send it to Claude. No brief was generated (this was the discovery run).',
    }).catch(() => {});
  }

  // ── MENU DIAGNOSTIC (Pass A-2: model pill + Thinking-level submenu) ────────────
  // Clicks the "Pro" mode pill and dumps the menu (and the Thinking-level submenu) so
  // we can wire the live "set 3.1 Pro + Extended" step to the exact buttons.

  function getModePill() {
    return pick([
      'button[aria-label^="Open mode picker"]',
      'button[aria-label*="mode picker" i]',
    ]);
  }

  function dumpVisibleMenuInto(lines, label) {
    lines.push(`— ${label} —`);
    const items = Array.from(document.querySelectorAll(
      '[role="menuitem"], [role="menuitemradio"], [role="option"], .mat-mdc-menu-item, button'
    )).filter(isVisible);
    let c = 0;
    for (const it of items) {
      if (c++ >= 50) { lines.push('  …(truncated)'); break; }
      const r = it.getBoundingClientRect();
      const role = it.getAttribute('role') || it.tagName.toLowerCase();
      lines.push(`  [${role}] aria="${it.getAttribute('aria-label') || ''}" "${trunc(it.textContent, 40)}" @${Math.round(r.left)},${Math.round(r.top)}`);
    }
  }

  async function runMenuDiagnostic(slotIndex) {
    const lines = [];
    const pill = getModePill();
    lines.push('PILL: ' + (pill ? `found aria="${pill.getAttribute('aria-label')}"` : 'NOT FOUND — CHECK MANUALLY'));

    if (pill) { pill.click(); await sleep(1500); }
    dumpVisibleMenuInto(lines, 'MODEL MENU (after clicking the Pro pill)');

    // Try to open the "Thinking level" submenu so we capture Standard/Extended/Deep Think.
    const thinking = Array.from(document.querySelectorAll(
      '[role="menuitem"], [role="menuitemradio"], .mat-mdc-menu-item, button'
    )).filter(isVisible).find(el => /thinking level/i.test(el.textContent || ''));
    lines.push('THINKING-LEVEL ENTRY: ' + (thinking ? `found "${trunc(thinking.textContent, 40)}"` : 'NOT FOUND'));
    if (thinking) {
      try { thinking.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true })); } catch {}
      await sleep(400);
      try { thinking.click(); } catch {}
      await sleep(1200);
      dumpVisibleMenuInto(lines, 'THINKING-LEVEL SUBMENU (Standard / Extended / Deep Think)');
    }

    const dump = '════ GEMINI MENU DIAGNOSTIC (send all to Claude) ════\n' +
                 lines.join('\n') +
                 '\n════ END GEMINI MENU DIAGNOSTIC ════';
    showDiagnosticBox(dump);
    try { console.log('[gemini-diag-menu]\n' + dump); } catch {}
    report(slotIndex, 'extracting', '🔬 Menu diagnostic ready — copy the green box on the Gemini tab.');

    removeStatus();
    chrome.runtime.sendMessage({
      type: 'SLOT_ERROR',
      slotIndex,
      error: 'Menu diagnostic done ✅ — copy the green box on the Gemini tab and send it to Claude. (Discovery run — no brief generated.)',
    }).catch(() => {});
  }

  // ── UPLOAD DIAGNOSTIC (Pass A-3: the "Upload & tools" menu + file inputs) ──────
  // Clipboard-paste handles images but NOT video, so video needs the real file-input
  // path. This dumps the menu that "Upload & tools" opens and any file input it
  // reveals, so we wire video upload to the exact item.
  async function runUploadDiagnostic(slotIndex) {
    const lines = [];
    const before = Array.from(document.querySelectorAll('input[type="file"]'));
    lines.push('FILE-INPUTS (before click): ' + (before.length
      ? before.map(i => `accept="${i.accept || ''}" multiple=${i.multiple}`).join(' || ') : 'none'));

    const btn = getAttachButton();
    lines.push('UPLOAD BUTTON: ' + (btn ? `found aria="${btn.getAttribute('aria-label')}"` : 'NOT FOUND'));
    if (btn) { btn.click(); await sleep(1600); }

    dumpVisibleMenuInto(lines, 'UPLOAD MENU (after clicking "Upload & tools")');

    const after = Array.from(document.querySelectorAll('input[type="file"]'));
    lines.push('FILE-INPUTS (after click): ' + (after.length
      ? after.map(i => `accept="${i.accept || ''}" multiple=${i.multiple}`).join(' || ') : 'none'));

    const dump = '════ GEMINI UPLOAD DIAGNOSTIC (send all to Claude) ════\n' +
                 lines.join('\n') +
                 '\n════ END GEMINI UPLOAD DIAGNOSTIC ════';
    showDiagnosticBox(dump);
    try { console.log('[gemini-diag-upload]\n' + dump); } catch {}
    report(slotIndex, 'extracting', '🔬 Upload diagnostic ready — copy the green box on the Gemini tab.');

    removeStatus();
    chrome.runtime.sendMessage({
      type: 'SLOT_ERROR',
      slotIndex,
      error: 'Upload diagnostic done ✅ — copy the green box on the Gemini tab and send it to Claude. (Discovery run — no brief generated.)',
    }).catch(() => {});
  }

  // ── Set model: 3.1 Pro + Extended (live, every run) ───────────────────────────
  // The model tier (Pro) is reliably sticky, but the Thinking level defaults to
  // Standard on a fresh/background tab — so we set Extended each run. All menu rows
  // are role="menuitem" with NO aria-label; matched by text (confirmed live 2026-06-27).

  function menuItemByText(re) {
    return Array.from(document.querySelectorAll('[role="menuitem"], [role="menuitemradio"], .mat-mdc-menu-item'))
      .filter(isVisible)
      .find(el => re.test((el.textContent || '').replace(/\s+/g, ' ').trim()));
  }

  function pressEscape() {
    try { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true })); } catch {}
  }

  function dismissOnboarding() {
    // Best-effort: close a one-time "discovery card" if it overlays the composer.
    // NEVER touch the consent "Get started" button (that opens a consent flow).
    const notNow = Array.from(document.querySelectorAll('button'))
      .find(b => /Acknowledge and close the discovery card/i.test(b.getAttribute('aria-label') || ''));
    if (notNow && isVisible(notNow)) { try { notNow.click(); } catch {} }
  }

  async function ensureProExtended(slotIndex) {
    const pill = getModePill();
    if (!pill) { report(slotIndex, 'typing', '⚠️ Model pill not found — using Gemini default'); return; }

    const alreadyPro = /currently Pro/i.test(pill.getAttribute('aria-label') || '');

    pill.click();
    await sleep(1200);

    // Ensure model = 3.1 Pro, but only if it isn't already (clicking it may close the menu).
    if (!alreadyPro) {
      const proItem = menuItemByText(/3\.1\s*Pro/i);
      if (proItem) { proItem.click(); await sleep(1000); pill.click(); await sleep(1200); }
    }

    const thinking = menuItemByText(/thinking level/i);
    if (!thinking) {
      report(slotIndex, 'typing', '⚠️ Thinking-level row not found — leaving level as-is');
      pressEscape();
      return;
    }

    // Already Extended? Close the menu and move on.
    if (/extended/i.test((thinking.textContent || '').replace(/\s+/g, ' '))) {
      report(slotIndex, 'typing', '✓ Thinking level already Extended');
      pressEscape();
      return;
    }

    // Open the submenu and pick Extended.
    try { thinking.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true })); } catch {}
    await sleep(500);
    try { thinking.click(); } catch {}
    await sleep(1000);

    const ext = menuItemByText(/extended/i);
    if (ext) {
      ext.click();
      await sleep(1000);
      report(slotIndex, 'typing', '✓ Set thinking level: Extended');
    } else {
      report(slotIndex, 'typing', '⚠️ Extended option not found — leaving level as-is');
    }

    pressEscape();   // close any lingering menu before typing
    await sleep(400);
  }

  // ── File upload ───────────────────────────────────────────────────────────────

  function base64ToFile(base64, mimeType, filename) {
    const b64 = base64.includes(',') ? base64.split(',')[1] : base64;
    const binary = atob(b64);
    const ab = new ArrayBuffer(binary.length);
    const ia = new Uint8Array(ab);
    for (let i = 0; i < binary.length; i++) ia[i] = binary.charCodeAt(i);
    return new File([ab], filename, { type: mimeType });
  }

  function setFilesOnInput(input, file) {
    input.addEventListener('click', e => e.preventDefault(), { capture: true, once: true });
    const dt = new DataTransfer();
    dt.items.add(file);
    try { input.files = dt.files; } catch {}
    try { Object.defineProperty(input, 'files', { value: dt.files, configurable: true }); } catch {}
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function getAttachButton() { return pick(SELECTORS.attach); }

  // Count likely "file attached" controls in the composer (works for image AND video).
  // Only ever compared as a DELTA vs a baseline (see snapshotUpload/attachedSince), so
  // it is safe to include the broad "Remove <filename>" chip button here.
  function attachmentSignals() {
    let n = 0;
    for (const b of document.querySelectorAll('button')) {
      const l = (b.getAttribute('aria-label') || '').toLowerCase();
      if (l.includes('lightbox') || l.includes('uploaded') ||
          l.startsWith('remove ') ||                                  // chip: "Remove clip.mp4"
          (l.includes('remove') && (l.includes('file') || l.includes('attach')))) n++;
    }
    return n;
  }

  // Capture the <input type=file> Gemini creates when "Upload files" is clicked, set
  // our file on it, and CANCEL the OS dialog. input.click() fires a click whose default
  // action (open the dialog) we preventDefault in a capturing listener; we then set
  // files on that exact input synchronously so Gemini's own change handler ingests it.
  // This is the only path that works for VIDEO (clipboard paste handles images only).
  function armFileInputCapture(file) {
    let done = false;
    const handler = (e) => {
      const t = e.target;
      if (!done && t && t.tagName === 'INPUT' && t.type === 'file') {
        e.preventDefault();
        e.stopImmediatePropagation();
        done = true;
        try {
          const dt = new DataTransfer();
          dt.items.add(file);
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files')?.set;
          if (setter) setter.call(t, dt.files); else t.files = dt.files;
        } catch (err) { console.warn('[gemini] set files failed', err); }
        // Dispatch change after the app's click() returns so its listener is attached.
        setTimeout(() => {
          try {
            t.dispatchEvent(new Event('input', { bubbles: true }));
            t.dispatchEvent(new Event('change', { bubbles: true }));
          } catch {}
        }, 0);
      }
    };
    document.addEventListener('click', handler, { capture: true });
    return {
      wasDone: () => done,
      disarm: () => document.removeEventListener('click', handler, { capture: true }),
    };
  }

  // Synthetic drag-and-drop of a File onto a target. Pure DOM events — no menu, no OS
  // dialog, no requestAnimationFrame/overlay rendering, no user activation — so it works
  // in BACKGROUND tabs where the "Upload & tools" menu does not reliably render.
  function fireDnD(target, file) {
    const dt = new DataTransfer();
    dt.items.add(file);
    try { dt.dropEffect = 'copy'; dt.effectAllowed = 'all'; } catch {}
    for (const type of ['dragenter', 'dragover', 'drop']) {
      let ev;
      try { ev = new DragEvent(type, { bubbles: true, cancelable: true, composed: true, dataTransfer: dt }); }
      catch { ev = new Event(type, { bubbles: true, cancelable: true }); }
      // DragEvent often nulls the init dataTransfer — force it via the getter.
      try { Object.defineProperty(ev, 'dataTransfer', { configurable: true, get: () => dt }); } catch {}
      target.dispatchEvent(ev);
    }
  }

  // Drop the file onto the composer and a few ancestors (the real drop listener may be
  // on a wrapper), then confirm it registered. Returns true if an attachment appeared.
  async function tryDropUpload(file) {
    const base = snapshotUpload(file);
    const ta = getTextarea();
    const targets = [];
    if (ta) {
      targets.push(ta);
      let p = ta;
      for (let i = 0; i < 5 && p.parentElement; i++) { p = p.parentElement; targets.push(p); }
    }
    if (document.body) targets.push(document.body);
    for (const t of targets) { try { fireDnD(t, file); } catch {} }

    // Confirm the drop registered (a NEW chip / filename appears) within ~16s.
    const start = Date.now();
    let registered = false;
    while (Date.now() - start < 16000) {
      await sleep(700);
      if (attachedSince(base, file)) { registered = true; break; }
    }
    if (!registered) return false;
    await sleep(2500);   // let the (usually small) clip finish uploading
    return true;
  }

  // A VISIBLE Send button. On an empty composer (no text, no attachment) Gemini shows
  // NO Send button — it appears the instant a file attaches. During the upload phase
  // (before we type the prompt) that makes "Send appeared" the most reliable, fastest
  // "a file attached" signal — far better than the late-rendering filename text.
  function hasVisibleSend() {
    const b = getSendButton();
    return !!(b && isVisible(b));
  }

  // Baseline of all attachment signals BEFORE we try to upload `file`. Crucial: the
  // filename/stem may already be on the page (e.g. the topic, or earlier text), so we
  // must only treat them as "attached" if they appear AFTER this baseline — otherwise
  // attachedSince() returns a false success instantly and the real upload is skipped.
  function snapshotUpload(file) {
    const body = document.body?.innerText || '';
    const stem = (file.name || '').replace(/\.[^.]+$/, '');
    return {
      blobs:   countBlobPreviews(),
      sig:     attachmentSignals(),
      hadSend: hasVisibleSend(),
      hadName: !!(file.name && body.includes(file.name)),
      hadStem: !!(stem.length > 3 && body.includes(stem)),
    };
  }

  // Has a NEW attachment appeared since the baseline? Every check is a delta vs `base`,
  // so a filename that was already on the page can never produce a false success.
  function attachedSince(base, file) {
    // Fastest + most reliable: the Send button appeared (empty composer has none, and we
    // have not typed yet during upload, so its appearance means a file attached).
    if (!base.hadSend && hasVisibleSend()) return true;
    if (countBlobPreviews() > base.blobs) return true;
    if (attachmentSignals() > base.sig) return true;
    const body = document.body?.innerText || '';
    const stem = (file.name || '').replace(/\.[^.]+$/, '');
    if (!base.hadName && file.name && body.includes(file.name)) return true;
    if (!base.hadStem && stem.length > 3 && body.includes(stem)) return true;
    return false;
  }

  // Clipboard-style paste of a File — a PURE DOM event, so it works in BACKGROUND tabs
  // (this is exactly why images attach across parallel slots). Gemini accepts pasted
  // files generally, so we use it for video too.
  async function pasteFile(file, attempts = 3, windowMs = 20000) {
    const ta = getTextarea();
    if (!ta) return false;
    const base = snapshotUpload(file);
    for (let attempt = 1; attempt <= attempts; attempt++) {
      // From attempt 2 on, if a prior paste landed late, don't paste again (avoid dupes).
      // Attempt 1 ALWAYS pastes — never short-circuit the real upload.
      if (attempt > 1 && attachedSince(base, file)) { await sleep(300); return true; }
      try {
        // NOTE: do NOT press Escape here — Escape in Gemini removes the just-attached
        // file, so an Escape-before-each-paste loop deletes its own attachment. Just
        // focus the composer and paste (the simple form that worked for the image).
        ta.focus();
        await sleep(400);
        const dt = new DataTransfer();
        dt.items.add(file);
        ta.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
      } catch (e) { console.warn('[gemini] paste threw:', e); }
      // BACKGROUND/throttled tabs render the attachment chip SLOWLY — the flaky-retry
      // bug was a too-short window giving up before the (successful) paste registered.
      // Wait generously before deciding this attempt failed.
      const deadline = Date.now() + windowMs;
      while (Date.now() < deadline) {
        await sleep(600);
        if (attachedSince(base, file)) { await sleep(600); return true; }
      }
    }
    return false;
  }

  async function uploadFile(file, slotIndex, kind, opts = {}) {
    showStatus(`Uploading ${file.name}…`);
    const note = (m) => { if (slotIndex != null) report(slotIndex, 'uploading', m); };

    // Attach via background-safe pure-event methods FIRST (these work in hidden/parallel
    // tabs), and only fall back to the menu (which needs a foreground tab to render).
    //
    // 1) PASTE — proven background-safe (this is how the image attaches in every slot).
    // Video uploads finish SLOWLY in a background tab and Gemini only shows the clip chip
    // when the upload completes (~30s+), so video needs ONE long-window attempt: a short
    // window would expire mid-upload, and re-pasting then = a DUPLICATE attachment. The
    // image attaches instantly (blob preview), so it keeps the quick multi-attempt path.
    const isVideo = (file.type || '').startsWith('video/') || kind === 'video';
    const pAttempts = opts.pasteAttempts ?? (isVideo ? 1 : 3);
    // Video returns the instant it attaches, so a long ceiling costs fast tabs nothing —
    // it only gives the SLOWEST parallel tab enough time (4 videos uploading at once
    // compete for bandwidth; the last one can take minutes in a throttled background tab).
    const pWindow   = opts.pasteWindowMs ?? (isVideo ? 180000 : 15000);
    if (await pasteFile(file, pAttempts, pWindow)) {
      note(`✓ ${kind || 'file'} attached (paste)`); return true;
    }

    // For VIDEO: do NOT run the drop/menu fallbacks. They don't work in a background tab,
    // and firing drop events / opening the upload menu while the paste's upload is still
    // finishing can DISRUPT it or add a duplicate (this is what dropped the slow tab's
    // video). The long paste window above is the whole video path.
    if (isVideo || opts.noFallback) { note(`⚠️ ${kind || 'file'} did NOT attach`); return false; }

    // 2) DRAG-AND-DROP — also a pure event; a second background-safe attempt.
    if (await tryDropUpload(file)) { note(`✓ ${kind || 'file'} attached (drop)`); return true; }

    // 3) MENU + captured file input — reliable only in a FOREGROUND tab (the Angular
    //    overlay may not render in a hidden tab). Last resort.
    const base = snapshotUpload(file);
    const cap = armFileInputCapture(file);

    const attachBtn = getAttachButton();
    if (!attachBtn) { cap.disarm(); console.warn('[gemini] Upload button not found'); return false; }
    attachBtn.click();
    await sleep(1000);

    const item = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"], button, li'))
      .find(el => /upload files/i.test((el.getAttribute('aria-label') || '') + ' ' + (el.textContent || '')));
    if (item) { item.click(); await sleep(1000); }
    else console.warn('[gemini] "Upload files" item not found');

    if (!cap.wasDone()) {
      const input = pick(SELECTORS.fileInput);
      if (input) setFilesOnInput(input, file);
    }

    const start = Date.now();
    let attached = false;
    while (Date.now() - start < 60000) {
      await sleep(900);
      if (attachedSince(base, file)) { attached = true; break; }
    }
    cap.disarm();
    await sleep(800);
    note(attached ? `✓ ${kind || 'file'} attached (menu)` : `⚠️ ${kind || 'file'} did NOT attach`);
    if (!attached) console.warn('[gemini] upload of', file.name, 'NOT confirmed (proceeding without it)');
    return attached;
  }

  // ── Type prompt ───────────────────────────────────────────────────────────────
  // The master prompt is tens of KB of multi-line text. Gemini's rich (Quill) editor
  // does NOT reliably accept large text via execCommand/value setters — the reliable
  // path is a synthetic paste event carrying text/plain (Quill handles paste natively).
  // We paste first, then verify the editor actually filled, with execCommand/innerText
  // as fallbacks.

  function editorText(el) {
    return (el?.innerText ?? el?.value ?? el?.textContent ?? '').trim();
  }

  async function typePrompt(text) {
    const el = await waitFor(getTextarea, 10000);
    el.focus();
    await sleep(300);

    // Primary: synthetic paste with a text/plain DataTransfer.
    try {
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      el.dispatchEvent(new ClipboardEvent('paste', {
        bubbles: true, cancelable: true, clipboardData: dt,
      }));
      await sleep(600);
    } catch (e) {
      console.warn('[gemini] synthetic paste threw:', e);
    }

    // Verify it landed (allow for trimming/normalisation — check a healthy fraction).
    if (editorText(el).length >= Math.min(200, Math.floor(text.length * 0.5))) {
      await sleep(300);
      return;
    }

    // Fallback 1: contenteditable insertText.
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

    // NOTE: we deliberately do NOT use navigator.clipboard.writeText here. In
    // multi_clip each slot has a DIFFERENT prompt, and the real system clipboard is
    // shared across all tabs — two parallel slots could clobber each other and paste
    // the wrong clip's prompt (a silent wrong-brief). All paste paths here use the
    // synthetic DataTransfer / execCommand, which are per-element and never touch the
    // shared clipboard.

    // Fallback 2: last resort — set innerText / value directly.
    try {
      if (el.tagName === 'TEXTAREA') {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        setter.call(el, text);
      } else {
        el.innerText = text;
      }
      el.dispatchEvent(new InputEvent('input', { bubbles: true }));
      await sleep(300);
    } catch {}
  }

  // ── Send message ──────────────────────────────────────────────────────────────

  async function clickSend() {
    // Wait up to 2 min for Send to become ENABLED. Gemini keeps Send disabled while an
    // attachment is still uploading, so this also guards against sending a half-uploaded
    // video (important now that we detect "attached" as soon as the Send button appears).
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      if (isSendReady()) break;
      await sleep(400);
    }
    const btn = getSendButton();
    if (btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true') {
      btn.click();
      await sleep(800);
      return;
    }
    // Last resort (Send never became enabled): click it anyway, then press Enter.
    if (btn) { try { btn.click(); } catch {} }
    const ta = getTextarea();
    if (!ta) throw new Error('Send button not found and composer missing');
    ta.focus();
    for (const type of ['keydown', 'keypress', 'keyup']) {
      ta.dispatchEvent(new KeyboardEvent(type, {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true,
      }));
    }
    await sleep(800);
  }

  // ── Wait for DOM content to stop changing ────────────────────────────────────

  async function waitForResponseStable() {
    let prevLen = -1;
    let stableCount = 0;
    const deadline = Date.now() + 90000;

    while (Date.now() < deadline) {
      if (isGenerating()) {
        stableCount = 0;
        prevLen = -1;
        await sleep(2000);
        continue;
      }
      await sleep(1500);
      const len = lastResponseText().length;
      if (len > 200 && len === prevLen) {
        stableCount++;
        if (stableCount >= 3) return;
      } else {
        stableCount = 0;
        prevLen = len;
      }
    }
  }

  // ── Wait for text response ────────────────────────────────────────────────────

  async function waitForTextResponse(maxMs = 1800000) {
    const start = Date.now();

    // Wait for generation to START (up to 60s).
    const startDeadline = Date.now() + 60000;
    while (Date.now() < startDeadline) {
      if (isGenerating()) break;
      await sleep(500);
    }

    // Wait for generation to END.
    while (Date.now() - start < maxMs) {
      await sleep(2000);
      const elapsed = Math.round((Date.now() - start) / 1000);
      showStatus(`Generating… ${elapsed}s`);

      if (elapsed < 15) continue;

      if (!isGenerating()) {
        // Handle the thinking→text gap: pause and re-check.
        await sleep(5000);
        if (isGenerating()) continue;
        if (lastResponseText().length < 200) continue;  // only a short summary so far
        showStatus('Done! Extracting text…');
        return;
      }
    }
    throw new Error(`Gemini did not finish within ${Math.round(maxMs / 1000)}s`);
  }

  // ── Extract response text ─────────────────────────────────────────────────────

  function extractResponse() {
    const nodes = getResponseNodes();
    if (nodes.length) {
      const text = (nodes[nodes.length - 1].innerText || nodes[nodes.length - 1].textContent || '').trim();
      if (text.length > 100) return text;
    }
    // Fallback: largest text block on the page.
    const candidates = Array.from(document.querySelectorAll('div, article'))
      .filter(el => (el.innerText || '').length > 200);
    if (candidates.length) {
      candidates.sort((a, b) => (b.innerText || '').length - (a.innerText || '').length);
      return (candidates[0].innerText || '').trim();
    }
    throw new Error('Could not locate Gemini response in page DOM');
  }

  // ── Generating-state probe (first-run instrumentation) ────────────────────────
  // Fire-and-forget after send: capture the streaming-state DOM so the real stop
  // button is known after ONE live run, copyable from the side panel (no DevTools).
  async function probeGeneratingState(slotIndex) {
    try {
      await sleep(7000);   // let streaming begin
      const btns = Array.from(document.querySelectorAll('button')).filter(isVisible)
        .map(b => `[${b.getAttribute('aria-label') || '∅'}]"${trunc(b.textContent, 16)}"`);
      const inds = ['.blinking-cursor', '[class*="cursor"]', '[class*="loading"]', '[role="progressbar"]', 'progress']
        .filter(s => document.querySelector(s));
      const stop = findStopButton();
      const line = `STREAMING-STATE | stopFound=${!!stop}` +
        (stop ? ` stopAria="${stop.getAttribute('aria-label') || ''}"` : '') +
        ` | indicators: ${inds.join(',') || 'none'} | buttons: ${btns.join(' ')}`;
      try { console.log('[gemini-diag-generating]\n' + line); } catch {}
      report(slotIndex, 'generating', '🔎 ' + trunc(line, 500));
    } catch {}
  }

  // Dump the composer/attachment state when a video upload fails — the discriminating
  // evidence: is the video chip present-but-undetected, or genuinely not attached?
  function dumpComposerArea(slotIndex, videoName) {
    const lines = [];
    const ta = getTextarea();
    const body = document.body?.innerText || '';
    const stem = (videoName || '').replace(/\.[^.]+$/, '');
    lines.push('COMPOSER: ' + (ta ? `found, isConnected=${ta.isConnected}` : 'NOT FOUND'));
    lines.push(`VIDEO FILENAME ("${videoName || ''}") IN PAGE: ${videoName && body.includes(videoName) ? 'YES' : 'no'}`);
    lines.push('VIDEO STEM IN PAGE: ' + (stem.length > 3 && body.includes(stem) ? 'YES' : 'no'));
    lines.push('attachmentSignals count: ' + attachmentSignals());
    lines.push('— VISIBLE BUTTONS (aria | text) — (a video chip would add a remove/preview button here)');
    const btns = Array.from(document.querySelectorAll('button')).filter(isVisible);
    let c = 0;
    for (const b of btns) {
      if (c++ >= 45) { lines.push('  …'); break; }
      lines.push(`  [${b.getAttribute('aria-label') || '∅'}] "${trunc(b.textContent, 22)}"`);
    }
    const dump = '════ GEMINI VIDEO-FAIL DUMP (send all to Claude) ════\n' +
                 lines.join('\n') + '\n════ END ════';
    showDiagnosticBox(dump);
    try { console.log('[gemini-diag-videofail]\n' + dump); } catch {}
    report(slotIndex, 'extracting', '🔬 Video did NOT attach — green box on the Gemini tab has the details.');
  }

  // ── Main slot runner ──────────────────────────────────────────────────────────

  async function runSlot(job) {
    const { slotIndex, videoBase64, videoMime, videoName,
            charBase64, charMime, charName, promptText, useCharSheet } = job;

    try {
      report(slotIndex, 'waiting', '⏳ Waiting for Gemini to load…');
      showStatus('Waiting for Gemini…');

      // DIAGNOSTIC passes: dump and stop — this MUST run BEFORE waitForReady(), because
      // waitForReady() throws if our provisional composer guess misses, which is the
      // exact selector the diagnostic exists to replace. Gating the dump behind a guess
      // would turn a wrong guess into a blank 45s timeout with no dump. So here we wait
      // for the composer best-effort (never throw) + a settle so the SPA finishes
      // painting, then dump regardless of whether the guess matched.
      if (DIAG) {
        report(slotIndex, 'extracting', `🔬 Diagnostic (${DIAG}) — collecting Gemini DOM…`);
        await waitFor(getTextarea, 20000).catch(() => {});
        await sleep(5000);
        if (DIAG === 'menu') await runMenuDiagnostic(slotIndex);
        else if (DIAG === 'upload') await runUploadDiagnostic(slotIndex);
        else await runDiagnostic(slotIndex);
        return;
      }

      await waitForReady();

      // TAKE TURNS: only ONE tab does the heavy model-set + upload at a time, so N
      // parallel videos can't starve a tab (this is the fix for "4 tabs, one freezes
      // and never gets its video"). sidepanel.js coordinates the queue; generation
      // still runs in parallel after the lock is released. ChatGPT does not use this.
      report(slotIndex, 'waiting', '⏳ Waiting for upload turn…');
      await acquireUploadLock(slotIndex);
      try {
        // Set 3.1 Pro + Extended before anything else (the fresh tab defaults to Standard).
        report(slotIndex, 'typing', '⚙️ Setting model (3.1 Pro + Extended)…');
        dismissOnboarding();
        await ensureProExtended(slotIndex);

        if (DEBUG_UPLOAD) {
          // Diagnostic order: IMAGE first (so a video-fail dump shows the image attached
          // = video-specific), then VIDEO paste-only + fail-fast + dump on failure.
          if (useCharSheet && charBase64) {
            report(slotIndex, 'uploading', '🖼️ Uploading character sheet…');
            showStatus('Uploading character sheet…');
            await uploadFile(base64ToFile(charBase64, charMime, charName), slotIndex, 'image');
          }
          report(slotIndex, 'uploading', '📹 Uploading video clip…');
          showStatus('Uploading video clip…');
          const ok = await uploadFile(base64ToFile(videoBase64, videoMime, videoName),
            slotIndex, 'video', { noFallback: true, pasteAttempts: 2, pasteWindowMs: 14000 });
          if (!ok) {
            dumpComposerArea(slotIndex, videoName);
            removeStatus();
            chrome.runtime.sendMessage({
              type: 'SLOT_ERROR', slotIndex,
              error: 'Video did not attach — copy the green box on the Gemini tab and send it to Claude.',
            }).catch(() => {});
            return;   // finally below still releases the upload turn
          }
        } else {
          report(slotIndex, 'uploading', '📹 Uploading video clip…');
          showStatus('Uploading video clip…');
          await uploadFile(base64ToFile(videoBase64, videoMime, videoName), slotIndex, 'video');

          if (useCharSheet && charBase64) {
            report(slotIndex, 'uploading', '🖼️ Uploading character sheet…');
            showStatus('Uploading character sheet…');
            await uploadFile(base64ToFile(charBase64, charMime, charName), slotIndex, 'image');
          }
        }
      } finally {
        releaseUploadLock(slotIndex);   // let the next tab take its turn
      }

      report(slotIndex, 'typing', '✍️ Entering master prompt…');
      showStatus('Typing prompt…');
      await typePrompt(promptText);

      report(slotIndex, 'submitting', '🚀 Submitting to Gemini…');
      showStatus('Submitting…');
      await clickSend();

      // First-run probe of the streaming-state DOM (confirms the real stop button).
      if (PROBE_GENERATING) probeGeneratingState(slotIndex);

      // Fire-and-forget: capture the conversation URL once Gemini creates it.
      (async () => {
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline) {
          const url = window.location.href;
          if (/\/app\/[a-z0-9]/i.test(url)) {
            chrome.runtime.sendMessage({ type: 'SLOT_URL', slotIndex, url }).catch(() => {});
            return;
          }
          await sleep(1000);
        }
      })();

      report(slotIndex, 'generating', '🤖 Gemini is generating…');
      await waitForTextResponse(1800000);   // 30 minutes — briefs are long

      report(slotIndex, 'extracting', '📋 Waiting for response to settle…');
      await waitForResponseStable();

      report(slotIndex, 'extracting', '📋 Extracting response…');
      const text = extractResponse();

      removeStatus();
      chrome.runtime.sendMessage({ type: 'SLOT_COMPLETE', slotIndex, text }).catch(() => {});

    } catch (err) {
      removeStatus();
      chrome.runtime.sendMessage({ type: 'SLOT_ERROR', slotIndex, error: err.message }).catch(() => {});
    }
  }

  // ── Message listener ──────────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'PING') {
      sendResponse({ alive: true });
      return true;
    }
    if (msg.type === 'UPLOAD_GRANTED') {
      if (_uploadGrantResolve) { const r = _uploadGrantResolve; _uploadGrantResolve = null; r(); }
      return false;
    }
    if (msg.type === 'START_SLOT') {
      sendResponse({ received: true });
      runSlot(msg).catch(err => {
        chrome.runtime.sendMessage({
          type: 'SLOT_ERROR', slotIndex: msg.slotIndex, error: err.message,
        }).catch(() => {});
      });
      return true;
    }
  });

})();
