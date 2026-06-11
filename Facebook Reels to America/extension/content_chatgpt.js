// content_chatgpt.js — runs on chatgpt.com

let stopFlag = false;
const sleep = ms => new Promise((res, rej) => {
  const id = setTimeout(res, ms);
  const poll = setInterval(() => {
    if (stopFlag) { clearTimeout(id); clearInterval(poll); rej(new Error("Stopped by user")); }
  }, 80);
  setTimeout(() => clearInterval(poll), ms + 100);
});

const API = "http://localhost:7788";

// Saved storyboard image URL (from Phase A) — used directly in Phase B upload
let storyboardImageUrl = null;

function log(msg) {
  console.log(`[chatgpt-bot] ${msg}`);
  chrome.runtime.sendMessage({ type: "LOG", text: `[ChatGPT] ${msg}` }).catch(() => {});
}

function showStatus(msg) {
  let el = document.getElementById("fb-bot-status");
  if (!el) {
    el = document.createElement("div");
    el.id = "fb-bot-status";
    el.style.cssText = `
      position:fixed;top:16px;right:16px;z-index:2147483647;
      background:#0f2a0f;color:#4ade80;padding:12px 18px;
      border-radius:10px;border:1px solid #16a34a;
      font-family:monospace;font-size:12px;max-width:340px;
      box-shadow:0 4px 16px rgba(0,0,0,0.6);line-height:1.5;pointer-events:none;
    `;
    document.body.appendChild(el);
  }
  el.innerHTML = `🤖 ${msg}`;
}
function removeStatus() { document.getElementById("fb-bot-status")?.remove(); }

// ── Fetch with timeout (prevent hanging fetches) ───────────────────────────────
async function fetchWithTimeout(url, opts = {}, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    clearTimeout(id);
    return r;
  } catch (e) {
    clearTimeout(id);
    throw e;
  }
}

// Resize + JPEG-compress a large image File so uploads are fast.
// A 30 MB character-sheet PNG → ~1–2 MB JPEG at 2048 px max — plenty for AI reference.
async function compressImageFile(file, maxDim = 2048, quality = 0.88) {
  return new Promise(resolve => {
    const img = new Image();
    const blobUrl = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(blobUrl);
      const scale = Math.min(1, maxDim / Math.max(img.width || maxDim, img.height || maxDim));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      canvas.getContext("2d").drawImage(img, 0, 0, w, h);
      canvas.toBlob(blob => {
        const outName = file.name.replace(/\.[^.]+$/, ".jpg");
        resolve(new File([blob], outName, { type: "image/jpeg" }));
      }, "image/jpeg", quality);
    };
    img.onerror = () => { URL.revokeObjectURL(blobUrl); resolve(file); };
    img.src = blobUrl;
  });
}

// ── Selectors ─────────────────────────────────────────────────────────────────

function getTextarea() {
  return document.querySelector("#prompt-textarea")
      || document.querySelector('[contenteditable="true"][data-lexical-editor]')
      || document.querySelector('[contenteditable="true"]')
      || document.querySelector("textarea");
}

function getSendButton() {
  return document.querySelector('button[data-testid="send-button"]')
      || document.querySelector('button[aria-label="Send prompt"]')
      || document.querySelector('button[aria-label*="Send"]');
}

function isSendReady() {
  const btn = getSendButton();
  return btn && !btn.disabled;
}

// isGenerating: ONLY check for the stop button — send button state is unreliable
// (ChatGPT keeps send disabled when textarea is empty, even when idle)
function isGenerating() {
  if (document.querySelector('[data-testid="stop-button"]')) return true;
  return Array.from(document.querySelectorAll("button")).some(b =>
    (b.getAttribute("aria-label") || "").toLowerCase().includes("stop generating")
  );
}

// ── Image detection ───────────────────────────────────────────────────────────
// ChatGPT URL patterns (confirmed from live debug):
//   Generated images: .../estuary/content?id=file_XXXXXXXX  (underscore, long hex)
//   Uploaded files:   .../estuary/content?id=file-XXXXXXXX  (hyphen, short alphanumeric)
// We ONLY want generated images — uploaded previews must not be counted as new images.

function findAllGeneratedImageURLs() {
  const urls = new Set();

  // Primary: ChatGPT generated images (file_ underscore pattern)
  document.querySelectorAll('img[src*="id=file_"]').forEach(img => {
    if (img.src) urls.add(img.src);
  });

  // Fallback: if no estuary generated URLs found, try any large non-avatar image
  if (urls.size === 0) {
    document.querySelectorAll("img[src^='https']").forEach(img => {
      const w = img.naturalWidth || img.width;
      if (img.src && w > 200 && !img.src.includes("avatar") &&
          !img.src.includes("logo") && !img.src.includes("icon")) {
        urls.add(img.src);
      }
    });
  }

  return Array.from(urls);
}

function countAIImages() {
  // Count only generated images (file_ pattern) — uploaded previews use file- and must NOT be counted
  const n = document.querySelectorAll('img[src*="id=file_"]').length;
  if (n > 0) return n;
  // Fallback
  return Array.from(document.querySelectorAll("img[src^='https']"))
    .filter(i => (i.naturalWidth || i.width) > 200 &&
                 !i.src.includes("avatar") && !i.src.includes("logo")).length;
}

function debugDOM() {
  const allImgs = document.querySelectorAll("img");
  const generated = document.querySelectorAll('img[src*="id=file_"]');
  const uploaded  = document.querySelectorAll('img[src*="id=file-"]');
  log(`DEBUG DOM: ${allImgs.length} total imgs | ${generated.length} generated (file_) | ${uploaded.length} uploaded (file-)`);
  Array.from(allImgs).filter(i => (i.naturalWidth || i.width) > 50)
    .slice(0, 8).forEach((img, i) =>
      log(`  img[${i}] ${img.naturalWidth||img.width}x${img.naturalHeight||img.height}: ${(img.src||"").slice(0, 100)}`)
    );
}

async function waitFor(fn, timeout = 20000, interval = 500) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const el = fn(); if (el) return el;
    await sleep(interval);
  }
  throw new Error("Element not found after " + timeout + "ms");
}

// ── Image mode / settings ─────────────────────────────────────────────────────

async function activateImageMode() {
  const allBtns = () => Array.from(document.querySelectorAll(
    "button, [role='menuitem'], [role='option']"
  ));

  let btn = allBtns().find(el => {
    const lbl  = (el.getAttribute("aria-label") || "").toLowerCase();
    const text = (el.textContent || "").trim().toLowerCase();
    const test = (el.getAttribute("data-testid") || "").toLowerCase();
    return lbl.includes("dall") || lbl === "create image" || lbl.includes("image gen")
        || text === "create image" || text === "dall·e" || text === "dall-e"
        || test.includes("image") || test.includes("dall");
  });
  if (btn) { btn.click(); await sleep(300); log("Image mode: direct button"); return; }

  const toolsBtn = allBtns().find(el => {
    const lbl = (el.getAttribute("aria-label") || "").toLowerCase();
    return lbl === "+" || lbl.includes("tool") || lbl.includes("more");
  });
  if (toolsBtn) {
    toolsBtn.click(); await sleep(300);
    const after = allBtns().find(el => {
      const t = (el.textContent || "").trim().toLowerCase();
      return t === "create image" || t.includes("dall") || t.includes("image");
    });
    if (after) { after.click(); await sleep(300); log("Image mode: tools menu"); return; }
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  }
  log("Image mode button not found — prompt should trigger it automatically");
}

async function selectAspectRatio(ratio = "9:16") {
  await sleep(200);
  const btn = Array.from(document.querySelectorAll(
    "button, [role='option'], [role='radio'], [role='menuitem']"
  )).find(el =>
    el.textContent?.trim() === ratio ||
    el.getAttribute("value") === ratio ||
    el.getAttribute("aria-label")?.includes(ratio)
  );
  if (btn) { btn.click(); await sleep(200); log(`Ratio set: ${ratio}`); }
  else      log(`Ratio button ${ratio} not found`);
}

async function selectThinkingMode(level = "extended") {
  const thinkBtn = Array.from(document.querySelectorAll("button, [role='button']")).find(el => {
    const lbl = (el.getAttribute("aria-label") || "").toLowerCase();
    const txt = (el.textContent || "").toLowerCase();
    return lbl.includes("thinking") || txt.includes("thinking") || lbl.includes("reason");
  });
  if (!thinkBtn) { log(`Thinking button not found`); return; }
  thinkBtn.click(); await sleep(300);
  const opt = Array.from(document.querySelectorAll(
    "[role='menuitem'], [role='option'], button"
  )).find(el => (el.textContent || "").toLowerCase().includes(level));
  if (opt) { opt.click(); await sleep(200); log(`Thinking: ${level}`); }
  else      log(`Thinking option "${level}" not found`);
}

// ── Type text ─────────────────────────────────────────────────────────────────

async function typeIntoChat(text) {
  const el = await waitFor(getTextarea, 15000);
  el.focus(); await sleep(200);

  if (el.tagName === "TEXTAREA") {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    setter.call(el, text);
    el.dispatchEvent(new InputEvent("input", { bubbles: true }));
  } else {
    document.execCommand("selectAll", false, null); await sleep(100);
    document.execCommand("delete",    false, null); await sleep(100);
    let ok = false;
    try { ok = document.execCommand("insertText", false, text); } catch {}
    if (!ok || !el.textContent?.trim()) {
      try {
        await navigator.clipboard.writeText(text);
        await sleep(100); el.focus();
        document.execCommand("paste");
      } catch {
        el.innerText = text;
        el.dispatchEvent(new InputEvent("input", { bubbles: true }));
      }
    }
  }

  await sleep(200);
  const preview = (getTextarea()?.textContent || "").slice(0, 80);
  log(`Typed ${text.length} chars. Preview: "${preview}…"`);
}

// ── File upload ───────────────────────────────────────────────────────────────

async function fetchAsFile(relPath) {
  const encoded = relPath.split("/").map(encodeURIComponent).join("/");
  const resp = await fetchWithTimeout(`${API}/file/${encoded}`, {}, 60000);
  if (!resp.ok) throw new Error(`Cannot serve ${relPath} (HTTP ${resp.status})`);
  const blob = await resp.blob();
  let file = new File([blob], relPath.split(/[\\/]/).pop(), { type: blob.type || "image/png" });
  // Compress large images before uploading (speeds up ChatGPT upload significantly)
  const sizeMB = file.size / 1048576;
  if (sizeMB > 1 && /\.(png|jpg|jpeg|webp|bmp|tiff?)$/i.test(file.name)) {
    const before = sizeMB.toFixed(1);
    file = await compressImageFile(file);
    log(`Compressed ${file.name}: ${before} MB → ${(file.size / 1048576).toFixed(1)} MB`);
  }
  return file;
}

async function fetchURLAsFile(url, filename) {
  const resp = await fetchWithTimeout(url, {}, 30000);
  if (!resp.ok) throw new Error(`Cannot fetch ${url} (HTTP ${resp.status})`);
  const blob = await resp.blob();
  return new File([blob], filename, { type: blob.type || "image/png" });
}

// uploadFile accepts a File object (already fetched) OR a relative path string
async function uploadFile(relPathOrFile) {
  let file;
  if (typeof relPathOrFile === "string") {
    const fname = relPathOrFile.split(/[\\/]/).pop();
    showStatus(`Fetching ${fname}…`);
    log(`→ Fetching ${fname} from localhost`);
    file = await fetchAsFile(relPathOrFile);
  } else {
    file = relPathOrFile; // File object passed directly
  }

  showStatus(`Uploading ${file.name} to ChatGPT…`);
  log(`→ Uploading ${file.name} (${Math.round(file.size / 1024)}KB)…`);

  let input = document.querySelector('input[type="file"]');
  if (!input) {
    const attachBtn = Array.from(document.querySelectorAll("button")).find(b => {
      const lbl = (b.getAttribute("aria-label") || "").toLowerCase();
      return lbl.includes("attach") || lbl.includes("upload") || lbl === "+";
    });
    if (attachBtn) {
      attachBtn.click(); await sleep(400);
      const uploadItem = Array.from(document.querySelectorAll(
        '[role="menuitem"], [role="option"], button'
      )).find(el => {
        const t = (el.textContent || "").toLowerCase();
        return t.includes("upload") || t.includes("computer") || t.includes("device");
      });
      if (uploadItem) { uploadItem.click(); await sleep(300); }
      input = document.querySelector('input[type="file"]');
    }
  }

  if (!input) { log(`WARNING: no file input found for ${file.name}`); return false; }

  input.addEventListener("click", e => e.preventDefault(), { capture: true, once: true });

  const dt = new DataTransfer();
  dt.items.add(file);
  try { input.files = dt.files; } catch {}
  Object.defineProperty(input, "files", { value: dt.files, configurable: true });
  input.dispatchEvent(new Event("change", { bubbles: true }));
  input.dispatchEvent(new Event("input",  { bubbles: true }));

  // Wait for ChatGPT's server-side upload to complete (send button re-enables)
  const uploadStart = Date.now();
  while (Date.now() - uploadStart < 120000) {
    await sleep(1000);
    if (isSendReady()) break;
  }
  log(`Upload done: ${file.name} (${Math.round((Date.now() - uploadStart) / 1000)}s)`);
  return true;
}

// ── Send ──────────────────────────────────────────────────────────────────────

async function clickSend() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (isSendReady()) break;
    await sleep(300);
  }
  const btn = getSendButton();
  if (!btn) { log("WARNING: send button not found"); return; }
  btn.click();
  log("Send clicked.");
  await sleep(500);
}

// ── Wait for generation ───────────────────────────────────────────────────────

async function waitForImages(expectedNew = 1, timeout = 900000) {
  const baseline = countAIImages();
  log(`Waiting for ${expectedNew} new image(s). Baseline: ${baseline}`);
  // Hard timeout: 5 min for first image + 2 min per additional, max 20 min
  const hardMs = Math.min(300000 + (expectedNew - 1) * 120000, 1200000);
  const start = Date.now();
  await sleep(2000);

  while (Date.now() - start < timeout) {
    await sleep(2000);
    const elapsed  = Math.round((Date.now() - start) / 1000);
    const nowCount = countAIImages();
    const newCount = nowCount - baseline;
    const generating = isGenerating();

    showStatus(`Generating… ${elapsed}s | ${newCount}/${expectedNew} images`);

    if (elapsed % 15 < 2) {
      log(`${elapsed}s | imgs: ${nowCount} | new: ${newCount} | generating: ${generating}`);
    }

    if (!generating && newCount >= expectedNew) {
      await sleep(500); log(`✓ ${newCount} image(s) ready`); return newCount;
    }

    // Stop button gone = generation done (even if selector missed the images)
    if (!generating && elapsed >= 30) {
      log(`Generation complete at ${elapsed}s — running DOM debug then downloading`);
      debugDOM();
      return Math.max(newCount, 1);
    }

    // Hard timeout safety net
    if (elapsed * 1000 >= hardMs) {
      log(`Hard timeout ${Math.round(hardMs / 1000)}s — forcing download attempt`);
      debugDOM();
      return Math.max(newCount, 1);
    }
  }
  return 0;
}

// ── Download ──────────────────────────────────────────────────────────────────

async function downloadByURL(url, filename) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: "DOWNLOAD_URL", url, filename }, resp => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else { log(`Download queued: ${filename}`); resolve(resp); }
    });
  });
}

async function downloadStoryboard(projectId) {
  debugDOM();
  const urls = findAllGeneratedImageURLs();
  log(`Found ${urls.length} candidate image URLs for storyboard`);

  if (urls.length > 0) {
    const url = urls[urls.length - 1];
    storyboardImageUrl = url;
    log(`Storyboard URL saved: ${url.slice(0, 80)}`);
    await downloadByURL(url, `${projectId}-storyboard.png`);
    return true;
  }

  // Fallback: click download button
  const dlBtn = Array.from(document.querySelectorAll("button, a"))
    .find(el => (el.getAttribute("aria-label") || "").toLowerCase().includes("download") ||
                (el.title || "").toLowerCase().includes("download"));
  if (dlBtn) {
    dlBtn.click();
    log("Fallback: clicked download button (image URL not found via selectors)");
    return true;
  }

  log("WARNING: no image or download button found — check ChatGPT tab");
  return false;
}

async function downloadSceneImages(projectId, totalScenes, baselineCount = 0) {
  await sleep(500);
  debugDOM();
  const allUrls = findAllGeneratedImageURLs();
  log(`Found ${allUrls.length} total image URLs (baseline: ${baselineCount}, expecting: ${totalScenes})`);

  const newUrls = allUrls.slice(baselineCount);
  log(`New URLs for scenes: ${newUrls.length}`);

  if (newUrls.length > 0) {
    const count = Math.min(newUrls.length, totalScenes);
    for (let i = 0; i < count; i++) {
      const n    = String(i + 1).padStart(2, "0");
      const name = `${projectId}-scene-${n}.png`;
      await downloadByURL(newUrls[i], name);
      await sleep(300);
    }
    log(`Queued ${count} scene image downloads`);
    return count;
  }

  // Fallback: "Download N images in this series" button
  const seriesBtn = Array.from(document.querySelectorAll("button, a"))
    .find(el => /(series|download)/i.test(el.textContent + (el.getAttribute("aria-label") || "")));
  if (seriesBtn) {
    log(`Fallback: clicking "${(seriesBtn.textContent || "").trim().slice(0, 60)}"`);
    seriesBtn.click();
    log("NOTE: series download clicked — background.js will rename via onDeterminingFilename");
    return 0;
  }

  log("WARNING: no images found and no download button — check ChatGPT tab");
  return 0;
}

// ── Wait for storyboard in pending/ ──────────────────────────────────────────

async function waitForStoryboardInPending(projectId, timeout = 90000) {
  const path = `pending/${projectId}-storyboard.png`;
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const r = await fetchWithTimeout(`${API}/file/${encoded}`, {}, 5000);
      if (r.ok) return path;
    } catch {}
    await sleep(2000);
  }
  return null;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function runImagePhase(project) {
  storyboardImageUrl = null;
  log(`Starting image phase: ${project.id}`);
  showStatus("Starting…");
  await sleep(500);

  const hasChar = !!project.character_sheet;

  // ══ PHASE A: Storyboard ═══════════════════════════════════════════════════
  log("=== PHASE A: Storyboard ===");
  showStatus("Phase A: Setting up…");

  await activateImageMode();  await sleep(200);
  await selectAspectRatio("9:16");
  await selectThinkingMode("extended");

  showStatus("Phase A: Typing storyboard prompt…");
  log("→ Typing storyboard prompt");
  await typeIntoChat(project.storyboard_prompt);
  await sleep(200);

  if (hasChar) {
    log(`→ Uploading character sheet: ${project.character_sheet}`);
    await uploadFile(project.character_sheet);
    await sleep(200);
  }

  showStatus("Phase A: Sending…");
  log("→ Sending storyboard request");
  await clickSend();

  showStatus("Phase A: Generating storyboard (up to 3 min)…");
  log("→ Waiting for storyboard generation");
  await waitForImages(1);

  showStatus("Phase A: Downloading storyboard…");
  log("→ Downloading storyboard image");
  await downloadStoryboard(project.id);
  log(`Storyboard download triggered. storyboardImageUrl=${storyboardImageUrl ? "saved" : "null"}`);

  // Parallel: wait for file in pending/ AND we already have the URL in memory
  showStatus("Phase A: Waiting for storyboard file (max 30s)…");
  const storyboardPath = await waitForStoryboardInPending(project.id, 30000);
  if (storyboardPath) {
    log(`✓ Storyboard confirmed at ${storyboardPath}`);
  } else {
    log(`Storyboard not in pending/ within 30s — will use in-memory URL for Phase B`);
  }

  // ══ PHASE B: Scene Images ════════════════════════════════════════════════
  log("=== PHASE B: Scene Images ===");
  showStatus("Phase B: Setting up…");
  await sleep(500);

  await activateImageMode();  await sleep(200);
  await selectAspectRatio("9:16");
  await selectThinkingMode("standard");

  const allImagePrompts = project.scenes
    .map(s => `## SCENE ${s.scene_num} IMAGE PROMPT\n\n${s.image_prompt}`)
    .join("\n\n---\n\n");
  const combinedPrompt = allImagePrompts +
    "\n\nCreate all images as separate images, one image per scene.";

  showStatus("Phase B: Typing scene prompts…");
  log(`→ Typing ${project.total_scenes} scene prompts`);
  await typeIntoChat(combinedPrompt);
  await sleep(200);

  // Upload storyboard: prefer pending/ path (fast localhost fetch) over estuary URL (slow)
  if (storyboardPath) {
    log("→ Uploading storyboard from pending/ (fast localhost)");
    await uploadFile(storyboardPath);
    await sleep(200);
  } else if (storyboardImageUrl) {
    try {
      showStatus("Phase B: Uploading storyboard reference…");
      log("→ Fetching storyboard from ChatGPT URL (pending/ not available)");
      const storyFile = await fetchURLAsFile(storyboardImageUrl, `${project.id}-storyboard.png`);
      await uploadFile(storyFile);
      await sleep(200);
    } catch (e) {
      log(`Storyboard upload failed (${e.message}) — Phase B continues without storyboard attachment`);
    }
  } else {
    log("NOTE: No storyboard available for Phase B — ChatGPT retains it in conversation context");
  }

  if (hasChar) {
    log("→ Uploading character sheet for Phase B");
    await uploadFile(project.character_sheet);
    await sleep(200);
  }

  showStatus(`Phase B: Sending ${project.total_scenes} scene image request…`);
  log(`→ Sending request for ${project.total_scenes} scene images`);
  const baselineBeforeScenes = countAIImages();
  await clickSend();

  showStatus(`Phase B: Generating ${project.total_scenes} scene images…`);
  log(`→ Waiting for ${project.total_scenes} scene images`);
  await waitForImages(project.total_scenes, 900000);

  showStatus("Phase B: Downloading scene images…");
  log("→ Downloading all scene images");
  const downloaded = await downloadSceneImages(project.id, project.total_scenes, baselineBeforeScenes);

  // Wait for monitor.py to detect and move all scene images, then update status
  showStatus(`Waiting for monitor.py to process ${downloaded} images…`);
  log(`→ Waiting ~10s for monitor.py to process downloads and update project status`);
  await sleep(10000);

  // Force-patch project status in case monitor.py missed any files
  try {
    await fetchWithTimeout(`${API}/patch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: project.id, project_status: "images_done" }),
    }, 5000);
    log("✓ Project status set to images_done");
  } catch (e) {
    log(`Status patch failed: ${e.message}`);
  }

  // ══ Done ═════════════════════════════════════════════════════════════════
  removeStatus();
  log(`✓ Image phase complete: ${project.id} (${downloaded} scene images queued)`);
  log(`✓ Done — click ▶ Start Videos in the side panel`);
  // Tell popup to reload project list so video button becomes active
  chrome.runtime.sendMessage({ type: "STATUS_CHANGE" }).catch(() => {});
  chrome.runtime.sendMessage({
    type: "LOG",
    text: `[ChatGPT] ✓ Done — click ▶ Start Videos`
  }).catch(() => {});
}

// ── Message listener ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "RUN_IMAGE_PHASE") {
    stopFlag = false;
    runImagePhase(msg.project)
      .then(() => sendResponse({ ok: true }))
      .catch(e => {
        const stopped = e.message === "Stopped by user";
        // log() already sends to popup — only use sendMessage for isErr styling
        if (stopped) {
          log("⏹ Stopped.");
        } else {
          chrome.runtime.sendMessage({
            type: "LOG", text: `[ChatGPT] ERROR: ${e.message}`, isErr: true
          }).catch(() => {});
        }
        removeStatus();
        sendResponse({ ok: false, error: e.message });
      });
    return true;
  }

  if (msg.type === "STOP") {
    stopFlag = true;
    removeStatus();
    log("⏹ Stop signal received — halting.");
    sendResponse({ ok: true });
    return true;
  }
});
