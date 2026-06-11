// content-chatgpt.js — Injected into ChatGPT tabs by the Multi Analyze extension.

(function () {
  'use strict';

  if (window.__fbMultiAnalyzerLoaded) return;
  window.__fbMultiAnalyzerLoaded = true;

  // ── Utilities ───────────────────────────────────────────────────────────────

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function report(slotIndex, status, message) {
    chrome.runtime.sendMessage({ type: 'SLOT_PROGRESS', slotIndex, status, message }).catch(() => {});
  }

  // Status overlay in top-right corner (styled like the existing extension)
  function showStatus(msg) {
    let el = document.getElementById('fb-multi-status');
    if (!el) {
      el = document.createElement('div');
      el.id = 'fb-multi-status';
      el.style.cssText = `
        position:fixed;top:16px;right:16px;z-index:2147483647;
        background:#0a1a2e;color:#7eb8ff;padding:10px 16px;
        border-radius:10px;border:1px solid #2a4a7e;
        font-family:monospace;font-size:12px;max-width:340px;
        box-shadow:0 4px 20px rgba(0,0,0,0.7);line-height:1.5;pointer-events:none;
        white-space:pre-wrap;
      `;
      document.body?.appendChild(el);
    }
    el.textContent = `🎬 Multi Analyze\n${msg}`;
  }

  function removeStatus() {
    document.getElementById('fb-multi-status')?.remove();
  }

  // ── ChatGPT Selectors (robust fallbacks, adapted from existing extension) ────

  function getTextarea() {
    return (
      document.querySelector('#prompt-textarea') ||
      document.querySelector('[contenteditable="true"][data-lexical-editor]') ||
      document.querySelector('[contenteditable="true"]') ||
      document.querySelector('textarea')
    );
  }

  function getSendButton() {
    return (
      document.querySelector('button[data-testid="send-button"]') ||
      document.querySelector('button[aria-label="Send prompt"]') ||
      document.querySelector('button[aria-label*="Send"]')
    );
  }

  function isGenerating() {
    if (document.querySelector('[data-testid="stop-button"]')) return true;
    return Array.from(document.querySelectorAll('button')).some(b =>
      (b.getAttribute('aria-label') || '').toLowerCase().includes('stop generating') ||
      (b.getAttribute('aria-label') || '').toLowerCase().includes('stop streaming')
    );
  }

  function isSendReady() {
    const btn = getSendButton();
    return btn && !btn.disabled;
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

  // ── Wait for ChatGPT to be ready ─────────────────────────────────────────────

  async function waitForReady() {
    await waitFor(getTextarea, 45000);
    // Give the rest of the composer (file-input, buttons) time to initialise.
    // Background tabs with 3 siblings can be slow — 4 s is conservative but safe.
    await sleep(4000);
  }

  // ── File upload ───────────────────────────────────────────────────────────────

  function base64ToFile(base64, mimeType, filename) {
    // Strip data URL prefix if present
    const b64 = base64.includes(',') ? base64.split(',')[1] : base64;
    const binary = atob(b64);
    const ab = new ArrayBuffer(binary.length);
    const ia = new Uint8Array(ab);
    for (let i = 0; i < binary.length; i++) ia[i] = binary.charCodeAt(i);
    return new File([ab], filename, { type: mimeType });
  }

  // Count blob-URL images — when ChatGPT attaches an image it renders a blob: preview.
  // This is the most reliable signal that an attachment was accepted.
  function countBlobPreviews() {
    return Array.from(document.querySelectorAll('img')).filter(
      i => (i.src || '').startsWith('blob:')
    ).length;
  }

  // Find the attachment / paperclip / + button in the composer.
  function getAttachButton() {
    // Try exact known aria-labels first (most reliable)
    const exact = [
      'Attach files', 'Add attachment', 'Attachments', 'Attach',
      'Upload file', 'Upload', 'Add file',
    ];
    for (const lbl of exact) {
      const b = document.querySelector(`button[aria-label="${lbl}"]`);
      if (b) return b;
    }
    // Partial-match fallback (avoids broad matches that grab wrong buttons)
    return Array.from(document.querySelectorAll('button')).find(b => {
      const lbl = (b.getAttribute('aria-label') || '').toLowerCase();
      const txt = (b.textContent || '').trim();
      return lbl === '+' || txt === '+' ||
             (lbl.includes('attach') && !lbl.includes('detach')) ||
             (lbl.includes('upload') && lbl.length < 30);
    }) || null;
  }

  // Push files into ChatGPT's file input via DataTransfer and dispatch events.
  function setFilesOnInput(input, file) {
    input.addEventListener('click', e => e.preventDefault(), { capture: true, once: true });
    const dt = new DataTransfer();
    dt.items.add(file);
    try { input.files = dt.files; } catch {}
    Object.defineProperty(input, 'files', { value: dt.files, configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('input',  { bubbles: true }));
  }

  async function uploadFile(file) {
    showStatus(`Uploading ${file.name}…`);
    const isImage = file.type.startsWith('image/');
    const snapshotBlobs = countBlobPreviews();

    // ── For IMAGES: clipboard paste (up to 3 attempts, verified by blob count) ──
    // ChatGPT natively supports Ctrl+V image paste. This avoids fragile
    // file-input logic and works regardless of UI version.
    // Background tabs sometimes don't process synthetic paste events — so we
    // verify a blob preview actually appeared and retry before giving up.
    if (isImage) {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const dt = new DataTransfer();
          dt.items.add(file);
          const ta = getTextarea();
          if (!ta) break;
          ta.focus();
          await sleep(400);
          ta.dispatchEvent(new ClipboardEvent('paste', {
            bubbles: true, cancelable: true, clipboardData: dt,
          }));
          // Wait up to 7 s for a new blob preview to confirm the paste landed
          const pasteDeadline = Date.now() + 7000;
          while (Date.now() < pasteDeadline) {
            await sleep(500);
            if (countBlobPreviews() > snapshotBlobs) break;
          }
          if (countBlobPreviews() > snapshotBlobs) {
            await sleep(500);
            return true; // confirmed — blob preview appeared
          }
          console.warn(`[multi-analyze] Paste attempt ${attempt} — no blob preview, retrying…`);
          await sleep(1200);
        } catch (e) {
          console.warn(`[multi-analyze] Paste attempt ${attempt} threw:`, e);
        }
      }
      // All paste attempts failed — fall through to file-input below
      console.warn('[multi-analyze] All clipboard paste attempts failed, trying file-input…');
    }

    // ── For VIDEO (and image clipboard fallback): file-input + DataTransfer ───
    // Find the hidden file input ChatGPT always keeps in the DOM.
    // Try button-triggered fresh input first, then direct query as fallback.
    let input = null;

    const attachBtn = getAttachButton();
    if (attachBtn) {
      attachBtn.click();
      await sleep(800);
      const menuItem = Array.from(document.querySelectorAll(
        '[role="menuitem"], [role="option"], [role="listitem"], button, li'
      )).find(el => {
        const t = (el.textContent || '').toLowerCase();
        return t.includes('computer') || t.includes('device') ||
               t.includes('local') || t.includes('from file') ||
               (t.includes('upload') && t.length < 40);
      });
      if (menuItem) { menuItem.click(); await sleep(600); }
      input = document.querySelector('input[type="file"]');
    }

    if (!input) input = document.querySelector('input[type="file"]');

    if (!input) {
      console.warn('[multi-analyze] No upload path for', file.name);
      return false;
    }

    setFilesOnInput(input, file);

    // Wait: first upload → wait for send button to enable.
    //       subsequent uploads → send already enabled, use fixed 8 s minimum.
    const wasReady = isSendReady();
    const uploadStart = Date.now();
    while (Date.now() - uploadStart < 90000) {
      await sleep(800);
      if (!wasReady && isSendReady()) break;           // first upload done
      if (wasReady && Date.now() - uploadStart > 8000) break; // min wait
      if (countBlobPreviews() > snapshotBlobs) break;  // preview appeared
    }
    await sleep(800);
    return true;
  }

  // ── Type prompt ───────────────────────────────────────────────────────────────

  async function typePrompt(text) {
    const el = await waitFor(getTextarea, 10000);
    el.focus();
    await sleep(300);

    if (el.tagName === 'TEXTAREA') {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(el, text);
      el.dispatchEvent(new InputEvent('input', { bubbles: true }));
    } else {
      // Contenteditable / Lexical editor
      document.execCommand('selectAll', false, null);
      await sleep(100);
      document.execCommand('delete', false, null);
      await sleep(100);

      let ok = false;
      try { ok = document.execCommand('insertText', false, text); } catch {}

      if (!ok || !(getTextarea()?.textContent?.trim())) {
        // Clipboard fallback
        try {
          await navigator.clipboard.writeText(text);
          await sleep(150);
          el.focus();
          document.execCommand('paste');
        } catch {
          el.innerText = text;
          el.dispatchEvent(new InputEvent('input', { bubbles: true }));
        }
      }
    }
    await sleep(400);
  }

  // ── Send message ──────────────────────────────────────────────────────────────

  async function clickSend() {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (isSendReady()) break;
      await sleep(300);
    }
    const btn = getSendButton();
    if (!btn) throw new Error('Send button not found');
    btn.click();
    await sleep(800);
  }

  // ── Wait for DOM content to stop changing ────────────────────────────────────
  // ChatGPT's React renderer may still be writing to the DOM after the stop button
  // disappears. Polls the last assistant message length every 1.5 s; declares
  // stable once it hasn't changed for 3 consecutive checks (~4.5 s of no change).

  async function waitForResponseStable() {
    let prevLen = -1;
    let stableCount = 0;
    const deadline = Date.now() + 90000; // max 90 s extra wait

    while (Date.now() < deadline) {
      // If ChatGPT resumed generating (thinking → text phase transition),
      // reset counters and wait for it to finish again.
      if (isGenerating()) {
        stableCount = 0;
        prevLen = -1;
        await sleep(2000);
        continue;
      }

      await sleep(1500);
      const msgs = document.querySelectorAll('[data-message-author-role="assistant"]');
      const len = msgs.length > 0
        ? (msgs[msgs.length - 1].innerText || '').length
        : 0;

      // Require >200 chars — a "Thought for Xm Ys" summary is ~30 chars and
      // must not be mistaken for a complete response.
      if (len > 200 && len === prevLen) {
        stableCount++;
        if (stableCount >= 3) return; // stable for 3 consecutive checks (~4.5 s)
      } else {
        stableCount = 0;
        prevLen = len;
      }
    }
    // Timed out waiting for stability — proceed with extraction anyway
  }

  // ── Wait for text response ────────────────────────────────────────────────────

  async function waitForTextResponse(maxMs = 1800000) {
    const start = Date.now();

    // Wait for generation to START (stop button appears) — up to 60s
    const startDeadline = Date.now() + 60000;
    while (Date.now() < startDeadline) {
      if (isGenerating()) break;
      await sleep(500);
    }

    // Wait for generation to END (stop button disappears).
    // Guard: never declare "done" in the first 15 s even if the stop-button
    // selector fails to fire — prevents premature extraction on selector mismatch.
    let elapsed = 0;
    while (Date.now() - start < maxMs) {
      await sleep(2000);
      elapsed = Math.round((Date.now() - start) / 1000);
      showStatus(`Generating… ${elapsed}s`);

      if (elapsed < 15) continue;

      if (!isGenerating()) {
        // Double-check after a pause — handles the gap between ChatGPT's
        // "thinking" phase ending and the text-generation phase starting.
        // If response text is still very short, ChatGPT is just transitioning
        // between phases; keep waiting for real content to appear.
        await sleep(5000);
        if (isGenerating()) continue; // text generation resumed — keep waiting

        const msgs = document.querySelectorAll('[data-message-author-role="assistant"]');
        const len = msgs.length > 0 ? (msgs[msgs.length - 1].innerText || '').length : 0;
        if (len < 200) continue; // only thinking summary visible — not done yet

        showStatus(`Done! Extracting text…`);
        return;
      }
    }
    throw new Error(`ChatGPT did not finish within ${Math.round(maxMs / 1000)}s`);
  }

  // ── Extract response text ─────────────────────────────────────────────────────

  function extractResponse() {
    // Try to get text via clipboard (preserves raw markdown from ChatGPT)
    // Primary: find last assistant message and get its innerText
    const msgs = document.querySelectorAll('[data-message-author-role="assistant"]');
    if (msgs.length > 0) {
      const last = msgs[msgs.length - 1];
      // Try to click copy button first for raw markdown
      const copyBtn = (
        last.querySelector('button[aria-label*="Copy"]') ||
        last.closest('[data-testid*="conversation-turn"]')?.querySelector('button[aria-label*="Copy"]')
      );
      // innerText is good enough — parse_analysis.py uses ##? (optional ##) so stripped headers are fine
      const text = last.innerText || last.textContent || '';
      if (text.trim().length > 100) return text.trim();
    }

    // Fallback: all agent-turn divs
    const agentTurns = document.querySelectorAll('.agent-turn, [class*="agent-turn"]');
    if (agentTurns.length > 0) {
      return (agentTurns[agentTurns.length - 1].innerText || '').trim();
    }

    // Last fallback: any large text block
    const candidates = Array.from(document.querySelectorAll('div[class*="message"], article'))
      .filter(el => (el.innerText || '').length > 200);
    if (candidates.length > 0) {
      return (candidates[candidates.length - 1].innerText || '').trim();
    }

    throw new Error('Could not locate ChatGPT response in page DOM');
  }

  // ── Main slot runner ──────────────────────────────────────────────────────────

  async function runSlot(job) {
    const { slotIndex, videoBase64, videoMime, videoName,
            charBase64, charMime, charName, promptText, useCharSheet } = job;

    try {
      report(slotIndex, 'waiting', '⏳ Waiting for ChatGPT to load…');
      showStatus('Waiting for ChatGPT…');
      await waitForReady();

      report(slotIndex, 'uploading', '📹 Uploading video clip…');
      showStatus('Uploading video clip…');
      const videoFile = base64ToFile(videoBase64, videoMime, videoName);
      await uploadFile(videoFile);

      if (useCharSheet && charBase64) {
        report(slotIndex, 'uploading', '🖼️ Uploading character sheet…');
        showStatus('Uploading character sheet…');
        const charFile = base64ToFile(charBase64, charMime, charName);
        await uploadFile(charFile);
      }

      report(slotIndex, 'typing', '✍️ Entering master prompt…');
      showStatus('Typing prompt…');
      await typePrompt(promptText);

      report(slotIndex, 'submitting', '🚀 Submitting to ChatGPT…');
      showStatus('Submitting…');
      await clickSend();

      // Fire-and-forget: capture conversation URL once ChatGPT creates the conversation
      (async () => {
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline) {
          const url = window.location.href;
          if (url.includes('/c/')) {
            chrome.runtime.sendMessage({ type: 'SLOT_URL', slotIndex, url }).catch(() => {});
            return;
          }
          await sleep(1000);
        }
      })();

      report(slotIndex, 'generating', '🤖 ChatGPT is generating…');
      await waitForTextResponse(1800000); // 30 minutes — briefs are long

      report(slotIndex, 'extracting', '📋 Waiting for response to settle…');
      await waitForResponseStable();

      report(slotIndex, 'extracting', '📋 Extracting response…');
      const text = extractResponse();

      removeStatus();
      chrome.runtime.sendMessage({
        type: 'SLOT_COMPLETE',
        slotIndex,
        text
      }).catch(() => {});

    } catch (err) {
      removeStatus();
      chrome.runtime.sendMessage({
        type: 'SLOT_ERROR',
        slotIndex,
        error: err.message
      }).catch(() => {});
    }
  }

  // ── Message listener ──────────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'PING') {
      sendResponse({ alive: true });
      return true;
    }
    if (msg.type === 'START_SLOT') {
      sendResponse({ received: true });
      runSlot(msg).catch(err => {
        chrome.runtime.sendMessage({
          type: 'SLOT_ERROR',
          slotIndex: msg.slotIndex,
          error: err.message
        }).catch(() => {});
      });
      return true;
    }
  });

})();
