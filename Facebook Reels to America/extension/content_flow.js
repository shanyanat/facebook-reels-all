// content_flow.js — runs on flow.google.com
// Automates: scene video generation (one video per scene)

const sleep = ms => new Promise(r => setTimeout(r, ms));

function log(msg) {
  console.log(`[flow-bot] ${msg}`);
  chrome.runtime.sendMessage({ type: "LOG", text: `[Flow] ${msg}` });
}

async function waitFor(selectorFn, timeout = 30000, interval = 500) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const el = selectorFn();
    if (el) return el;
    await sleep(interval);
  }
  throw new Error(`waitFor timed out: ${selectorFn.toString().substring(0, 80)}`);
}

// ── Selector helpers (update when Flow UI changes) ────────────────────────────

function getNewProjectButton() {
  return Array.from(document.querySelectorAll('button, [role="button"], a'))
    .find(el => {
      const t = el.textContent?.trim();
      return t === 'New project' || t === 'โปรเจ็กต์ใหม่' || t === 'Create' || el.getAttribute('aria-label')?.includes('new');
    });
}

function getStartButton() {
  // "เริ่ม" or "Start" button to begin adding media
  return Array.from(document.querySelectorAll('button, [role="button"]'))
    .find(el => {
      const t = el.textContent?.trim();
      return t === 'เริ่ม' || t === 'Start' || t === 'Get started';
    });
}

function getUploadImageOption() {
  return Array.from(document.querySelectorAll('button, [role="menuitem"], [role="option"]'))
    .find(el => {
      const t = el.textContent?.toLowerCase();
      return t?.includes('อัพโหลดรูป') || t?.includes('upload image') || t?.includes('upload a image');
    });
}

function getFileInput() {
  return document.querySelector('input[type="file"]');
}

function getPromptTextarea() {
  return document.querySelector('textarea')
      || document.querySelector('[contenteditable="true"][role="textbox"]')
      || document.querySelector('[placeholder*="prompt"]')
      || document.querySelector('[placeholder*="Prompt"]');
}

function getGenerateButton() {
  return Array.from(document.querySelectorAll('button, [role="button"]'))
    .find(el => {
      const t = el.textContent?.trim().toLowerCase();
      return t === 'generate' || t === 'สร้าง' || t === 'สร้างวิดีโอ' || t?.includes('generat');
    });
}

function getVideoSettingsButton() {
  // Button to open video settings panel (resolution, model, etc.)
  return Array.from(document.querySelectorAll('button, [role="button"]'))
    .find(el => el.getAttribute('aria-label')?.toLowerCase().includes('setting')
             || el.textContent?.toLowerCase().includes('veo'));
}

function getDownloadButton() {
  return Array.from(document.querySelectorAll('button, a, [role="button"]'))
    .find(el => el.getAttribute('aria-label')?.toLowerCase().includes('download')
             || el.title?.toLowerCase().includes('download')
             || (el.textContent?.toLowerCase().includes('download') && el.closest('[data-message-author-role]') == null));
}

function isVideoReady() {
  // Check if a video element or download button is visible
  const video = document.querySelector('video[src]');
  const dlBtn = getDownloadButton();
  return !!(video || dlBtn);
}

function hasGenerationError() {
  const errTexts = ['error', 'failed', 'ล้มเหลว', 'ผิดพลาด'];
  const alerts = document.querySelectorAll('[role="alert"], .error, [class*="error"]');
  for (const a of alerts) {
    if (errTexts.some(t => a.textContent.toLowerCase().includes(t))) return true;
  }
  return false;
}

// ── Upload file helper ────────────────────────────────────────────────────────

async function uploadFile(dataUrl, filename) {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  const file = new File([blob], filename, { type: blob.type });

  let fileInput = getFileInput();
  if (!fileInput) {
    const uploadOption = getUploadImageOption();
    if (uploadOption) { uploadOption.click(); await sleep(1500); }
    fileInput = await waitFor(getFileInput, 8000);
  }

  const dt = new DataTransfer();
  dt.items.add(file);
  fileInput.files = dt.files;
  fileInput.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(2000);
  log(`Uploaded: ${filename}`);
}

// ── Set video settings (9:16, Veo 3.1 Lite) ──────────────────────────────────

async function configureVideoSettings(aspectRatio) {
  await sleep(1000);

  // Try to find aspect ratio selector
  const ratioBtn = Array.from(document.querySelectorAll('button, [role="option"], [role="radio"], select option'))
    .find(el => el.textContent?.includes(aspectRatio));
  if (ratioBtn) { ratioBtn.click(); await sleep(500); log(`Set ratio: ${aspectRatio}`); }

  // Try to find Veo 3.1 Lite option
  const modelBtn = Array.from(document.querySelectorAll('button, [role="option"], option, [role="menuitem"]'))
    .find(el => el.textContent?.toLowerCase().includes('veo 3') || el.textContent?.toLowerCase().includes('veo3'));
  if (modelBtn) { modelBtn.click(); await sleep(500); log('Set model: Veo 3.1'); }

  // Lower Priority
  const lowerPrio = Array.from(document.querySelectorAll('button, [role="option"]'))
    .find(el => el.textContent?.toLowerCase().includes('lower priority') || el.textContent?.toLowerCase().includes('lower'));
  if (lowerPrio) { lowerPrio.click(); await sleep(500); log('Set: Lower Priority'); }
}

// ── Process one scene ─────────────────────────────────────────────────────────

async function processScene(scene, projectId, aspectRatio) {
  log(`Processing scene ${scene.scene_num}…`);

  // Wait for new project / navigate to flow
  const newProjBtn = await waitFor(getNewProjectButton, 15000);
  newProjBtn.click();
  await sleep(3000);

  // Click Start / เริ่ม
  try {
    const startBtn = await waitFor(getStartButton, 10000);
    startBtn.click();
    await sleep(1500);
  } catch { log('Start button not found — may already be in project'); }

  // Upload scene image
  const stored = await new Promise(r =>
    chrome.storage.local.get(`scene_img_${projectId}_${scene.scene_num}`, r)
  );
  const imgData = stored[`scene_img_${projectId}_${scene.scene_num}`];
  if (!imgData) {
    log(`ERROR: No image data for scene ${scene.scene_num} in storage. Did monitor.py process it?`);
    return false;
  }
  await uploadFile(imgData.dataUrl, `${projectId}-scene-${String(scene.scene_num).padStart(2,'0')}.png`);

  // Paste video prompt
  const textarea = await waitFor(getPromptTextarea, 10000);
  textarea.focus();
  textarea.value = scene.video_prompt;
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(1000);

  // Configure video settings
  const settingsBtn = getVideoSettingsButton();
  if (settingsBtn) { settingsBtn.click(); await sleep(1000); }
  await configureVideoSettings(aspectRatio);

  // Generate
  const genBtn = await waitFor(getGenerateButton, 10000);
  genBtn.click();
  log(`Scene ${scene.scene_num}: generation started. Waiting up to 15 min…`);

  // Poll for completion
  const timeout = 15 * 60 * 1000; // 15 min
  const start = Date.now();
  while (Date.now() - start < timeout) {
    await sleep(30000); // check every 30s
    if (hasGenerationError()) {
      log(`Scene ${scene.scene_num}: generation error detected.`);
      return false;
    }
    if (isVideoReady()) {
      log(`Scene ${scene.scene_num}: video ready!`);
      break;
    }
  }

  if (!isVideoReady()) {
    log(`Scene ${scene.scene_num}: timed out.`);
    return false;
  }

  // Download video
  const dlBtn = await waitFor(getDownloadButton, 10000);
  dlBtn.click();
  log(`Scene ${scene.scene_num}: download triggered.`);
  await sleep(5000); // wait for download to initiate

  return true;
}

// ── Main video phase ──────────────────────────────────────────────────────────

async function runVideoPhase(project, pendingScenes) {
  log(`Starting video phase for ${project.id} — ${pendingScenes.length} scenes`);

  for (let i = 0; i < pendingScenes.length; i++) {
    const scene = pendingScenes[i];

    // Update background state so download_state.scene_index matches
    await new Promise(r => chrome.storage.local.get("download_state", data => {
      const ds = data.download_state || {};
      chrome.storage.local.set({ download_state: { ...ds, scene_index: scene.scene_num, expecting: "video" } }, r);
    }));

    const ok = await processScene(scene, project.id, project.aspect_ratio);
    if (!ok) {
      log(`Scene ${scene.scene_num} failed — skipping, marked error`);
      // Notify background to mark scene error
      chrome.runtime.sendMessage({ type: "SCENE_ERROR", project_id: project.id, scene_num: scene.scene_num });
    }

    if (i < pendingScenes.length - 1) {
      log(`Waiting 60s before next scene…`);
      await sleep(60000);

      // Navigate back to flow home for next project
      window.location.href = "https://flow.google.com/";
      await sleep(4000);
    }
  }

  log(`Video phase complete for ${project.id}`);
  chrome.runtime.sendMessage({ type: "LOG", text: `[Flow] All scenes processed for ${project.id}` });
}

// ── Message listener ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "RUN_VIDEO_PHASE") {
    runVideoPhase(msg.project, msg.pending_scenes)
      .then(() => sendResponse({ ok: true }))
      .catch(e => {
        log(`ERROR: ${e.message}`);
        chrome.runtime.sendMessage({ type: "LOG", text: `[Flow] ERROR: ${e.message}`, isErr: true });
        sendResponse({ ok: false, error: e.message });
      });
    return true;
  }
});
