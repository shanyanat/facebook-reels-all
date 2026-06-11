// sidepanel.js — Main controller for FB Reels Multi Analyze extension.
// The sidepanel owns ALL state, file I/O, and tab management.
// background.js is minimal (just wires up the side panel on click).

'use strict';

// ══ PIPELINE CONTROL ═══════════════════════════════════════════════════════

const PIPELINE_API = 'http://127.0.0.1:7788';
let pipelineSelectedIds = new Set();

function pipelineSetResult(elementId, text, isError) {
  const el = document.getElementById(elementId);
  if (!el) return;
  el.textContent = text;
  el.className   = 'pipeline-result ' + (isError ? 'error' : 'ok');
  el.style.display = text ? '' : 'none';
}

async function pipelineCheckServer() {
  const dot   = document.getElementById('serverDot');
  const label = document.getElementById('serverLabel');
  if (!dot) return false;
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 3000);
    const r = await fetch(`${PIPELINE_API}/contents.json`, { signal: controller.signal });
    clearTimeout(t);
    if (r.ok) {
      dot.className      = 'server-dot online';
      label.textContent  = 'Connected — monitor.py running on :7788';
      return true;
    }
  } catch {}
  dot.className     = 'server-dot offline';
  label.textContent = 'monitor.py not running — start it first';
  return false;
}

async function pipelinePost(path, body) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 15000);
  try {
    const r = await fetch(`${PIPELINE_API}${path}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
      signal:  controller.signal,
    });
    clearTimeout(t);
    return await r.json();
  } catch (e) {
    clearTimeout(t);
    throw e;
  }
}

async function pipelineQueueBriefs() {
  const btn = document.getElementById('btnQueue');
  btn.disabled  = true;
  btn.innerHTML = '<span class="spinner"></span> Queuing…';
  pipelineSetResult('queueResult', '', false);
  try {
    const data = await pipelinePost('/api/queue', {});
    pipelineSetResult('queueResult', data.output || (data.ok ? 'Done.' : data.error), !data.ok);
  } catch (e) {
    pipelineSetResult('queueResult', `Error: ${e.message}`, true);
  } finally {
    btn.disabled  = false;
    btn.textContent = '▶ Queue Briefs';
  }
}

async function pipelineAddPage() {
  const name = document.getElementById('inputAddPage').value.trim();
  if (!name) { pipelineSetResult('addPageResult', 'Enter a page name first.', true); return; }
  const btn = document.getElementById('btnAddPage');
  btn.disabled  = true;
  btn.innerHTML = '<span class="spinner"></span>';
  pipelineSetResult('addPageResult', '', false);
  try {
    const data = await pipelinePost('/api/addpage', { name });
    pipelineSetResult('addPageResult', data.output || (data.ok ? 'Done.' : data.error), !data.ok);
    if (data.ok) document.getElementById('inputAddPage').value = '';
  } catch (e) {
    pipelineSetResult('addPageResult', `Error: ${e.message}`, true);
  } finally {
    btn.disabled  = false;
    btn.textContent = '+ Add';
  }
}

async function pipelineRenamePage() {
  const oldName = document.getElementById('inputRenameOld').value.trim();
  const newName = document.getElementById('inputRenameNew').value.trim();
  if (!oldName || !newName) {
    pipelineSetResult('renamePageResult', 'Both current and new page names are required.', true);
    return;
  }
  const btn = document.getElementById('btnRenamePage');
  btn.disabled  = true;
  btn.innerHTML = '<span class="spinner"></span>';
  pipelineSetResult('renamePageResult', '', false);
  try {
    const data = await pipelinePost('/api/renamepage', { old: oldName, new: newName });
    pipelineSetResult('renamePageResult', data.output || (data.ok ? 'Done.' : data.error), !data.ok);
    if (data.ok) {
      document.getElementById('inputRenameOld').value = '';
      document.getElementById('inputRenameNew').value = '';
    }
  } catch (e) {
    pipelineSetResult('renamePageResult', `Error: ${e.message}`, true);
  } finally {
    btn.disabled  = false;
    btn.textContent = 'Rename';
  }
}

async function pipelineLoadProjects() {
  const list = document.getElementById('projectList');
  const btn  = document.getElementById('btnRefreshProjects');
  if (!list) return;
  btn.disabled  = true;
  btn.textContent = '↺ Loading…';
  list.innerHTML  = '<div class="pipeline-empty">Loading…</div>';
  pipelineSelectedIds.clear();
  const updateBtn = document.getElementById('btnUpdatePrompts');
  if (updateBtn) updateBtn.disabled = true;
  pipelineSetResult('updatePromptsResult', '', false);

  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 6000);
    const r = await fetch(`${PIPELINE_API}/contents.json`, { signal: controller.signal });
    clearTimeout(t);
    const projects = await r.json();

    if (!Array.isArray(projects) || projects.length === 0) {
      list.innerHTML = '<div class="pipeline-empty">No projects found in queue</div>';
      return;
    }

    list.innerHTML = '';
    for (const p of projects) {
      const status = p.disk_status || p.project_status || 'pending';
      const item = document.createElement('div');
      item.className    = 'project-item';
      item.dataset.id   = p.id;
      item.innerHTML = `
        <input type="checkbox" value="${escHtml(p.id)}" />
        <div class="project-item-info">
          <div class="project-item-id">${escHtml(p.id)}</div>
          <div class="project-item-meta">${escHtml(p.page || '')} · ${escHtml(p.source_txt || '')}</div>
        </div>
        <span class="project-status-badge ps-${escHtml(status)}">${escHtml(status.replace(/_/g, ' '))}</span>
      `;
      const cb = item.querySelector('input[type="checkbox"]');
      item.addEventListener('click', (e) => {
        if (e.target === cb) return; // let the checkbox handle its own click
        cb.checked = !cb.checked;
        cb.dispatchEvent(new Event('change', { bubbles: true }));
      });
      cb.addEventListener('change', () => {
        if (cb.checked) { item.classList.add('selected');    pipelineSelectedIds.add(p.id); }
        else            { item.classList.remove('selected'); pipelineSelectedIds.delete(p.id); }
        if (updateBtn) updateBtn.disabled = pipelineSelectedIds.size === 0;
      });
      list.appendChild(item);
    }
  } catch (e) {
    list.innerHTML = `<div class="pipeline-empty">Error loading projects: ${escHtml(e.message)}</div>`;
  } finally {
    btn.disabled  = false;
    btn.textContent = '↺ Refresh';
  }
}

async function pipelineUpdatePrompts() {
  if (pipelineSelectedIds.size === 0) return;
  const btn = document.getElementById('btnUpdatePrompts');
  btn.disabled  = true;
  btn.innerHTML = '<span class="spinner"></span> Updating…';
  pipelineSetResult('updatePromptsResult', '', false);
  try {
    const data = await pipelinePost('/api/updateprompts', { ids: [...pipelineSelectedIds] });
    if (data.ok && Array.isArray(data.results)) {
      const lines = data.results.map(r =>
        (r.ok ? '✅' : '❌') + ' ' + r.id + (r.output ? ': ' + r.output : (r.error ? ': ' + r.error : ''))
      );
      const hasError = data.results.some(r => !r.ok);
      pipelineSetResult('updatePromptsResult', lines.join('\n'), hasError);
    } else {
      pipelineSetResult('updatePromptsResult', data.error || 'Unknown error', true);
    }
  } catch (e) {
    pipelineSetResult('updatePromptsResult', `Error: ${e.message}`, true);
  } finally {
    btn.disabled  = pipelineSelectedIds.size === 0;
    btn.textContent = 'Update Selected Prompts';
  }
}

// ══ VALIDATION PATTERNS ════════════════════════════════════════════════════

const VALID_START = 'STORYBOARD PROMPT';
const VALID_START_DETAIL = 'Create a single storyboard image only from this information';
const VALID_END = 'The End of CAPTION & HASHTAGS';

// ══ STATE ══════════════════════════════════════════════════════════════════

const state = {
  // 'multi_page' (default/original): 1 shared video → N page slots, each with its own char sheet.
  // 'multi_clip' (new): 1 shared page folder + char sheet → N video-clip slots, all briefs into that folder.
  mode: 'multi_page',

  masterPromptText: '',
  masterPromptName: '',
  masterPromptVersion: '',

  videoFile: null,
  videoBase64: '',
  videoMime: '',
  videoName: '',
  videoSizeMB: 0,

  // multi_clip: the single shared page folder + its character sheet
  shared: {
    dirHandle: null,
    briefDirHandle: null,
    charFile: null,
    charBase64: '',
    charMime: '',
    charName: '',
    charPreviewUrl: '',
    dirName: '',
    status: 'idle',
  },

  topic: '',
  character: 'with_char_sheet',
  totalScenes: '8',
  aspectRatio: '9:16',
  baseFilename: 'Brief',

  slotCount: 3,
  slots: [],  // multi_page: { dirHandle, briefDirHandle, charFile, charBase64, charMime, charName,
              //   charPreviewUrl, dirName, tabId, chatgptUrl, status, progressMsg }
              // multi_clip: also uses { videoFile, videoBase64, videoMime, videoName, videoSizeMB }

  isRunning: false,
};

// Pending resolvers: slotIndex → { resolve, reject }
const slotResolvers = new Map();

// ══ UTILITIES ══════════════════════════════════════════════════════════════

const sleep = ms => new Promise(r => setTimeout(r, ms));

function fmtTime() {
  return new Date().toTimeString().slice(0, 8);
}

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result); // data URL: "data:mime;base64,..."
    reader.onerror = () => reject(new Error('FileReader error'));
    reader.readAsDataURL(file);
  });
}

async function waitForTabReady(tabId, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(handler);
      reject(new Error(`Tab ${tabId} did not finish loading`));
    }, timeout);

    function handler(tId, changeInfo) {
      if (tId === tabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(handler);
        clearTimeout(deadline);
        resolve();
      }
    }

    // Check if already loaded
    chrome.tabs.get(tabId).then(tab => {
      if (tab.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(handler);
        clearTimeout(deadline);
        resolve();
      } else {
        chrome.tabs.onUpdated.addListener(handler);
      }
    }).catch(err => {
      clearTimeout(deadline);
      reject(err);
    });
  });
}

async function pingTabUntilReady(tabId, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const r = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
      if (r?.alive) return;
    } catch {}
    await sleep(600);
  }
  throw new Error(`Tab ${tabId} content script did not respond to ping`);
}

// ══ PROMPT BUILDER ══════════════════════════════════════════════════════════

function characterLabel() {
  return state.character === 'with_char_sheet'
    ? 'with attached Character Sheet'
    : 'use the character in the clip';
}

// In multi_clip mode each slot supplies its own topic/scenes/ratio; multi_page
// falls back to the global state values (the defaults below).
function buildPrompt({ topic = state.topic,
                       totalScenes = state.totalScenes,
                       aspectRatio = state.aspectRatio } = {}) {
  if (!state.masterPromptText) return '';
  let text = state.masterPromptText;

  // Replace the 4 editable fields.
  // Master Prompt.txt uses padded format: "TOPIC        : value"
  // \s* handles any number of spaces between field name and colon.
  text = text.replace(/^TOPIC\s*:.*$/m, `TOPIC        : ${topic}`);
  text = text.replace(/^CHARACTER\s*:.*$/m, `CHARACTER    : ${characterLabel()}`);
  const scenesValue = totalScenes === 'auto'
    ? 'Determine the optimal number of scenes yourself based on the clip length and content — choose any number that best fits, including fewer than 6 if appropriate'
    : totalScenes;
  text = text.replace(/^TOTAL SCENES\s*:.*$/m, `TOTAL SCENES : ${scenesValue}`);
  text = text.replace(/^ASPECT RATIO\s*:.*$/m, `ASPECT RATIO : ${aspectRatio}`);

  // If none of the fields existed in the template, prepend them
  if (!/^TOPIC\s*:/m.test(state.masterPromptText)) {
    const header = [
      `TOPIC        : ${topic}`,
      `CHARACTER    : ${characterLabel()}`,
      `TOTAL SCENES : ${totalScenes}`,
      `ASPECT RATIO : ${aspectRatio}`,
      '',
    ].join('\n');
    text = header + text;
  }

  return text;
}

// ══ TEXT TRIMMING ════════════════════════════════════════════════════════════

function trimBriefText(text) {
  // Cut everything before "STORYBOARD PROMPT"
  const startIdx = text.indexOf(VALID_START);
  if (startIdx > 0) text = text.slice(startIdx);

  // Cut everything after the closing === line of the end block.
  // Full end block looks like:  =====\n\nThe End of CAPTION & HASHTAGS\n\n=====
  // The regex is non-greedy so it stops at the FIRST === run after the marker.
  const endMatch = text.match(/={5,}[\s\S]*?The End of CAPTION & HASHTAGS[\s\S]*?={5,}/);
  if (endMatch) {
    text = text.slice(0, text.indexOf(endMatch[0]) + endMatch[0].length);
  }

  return text.trim();
}

// ══ VALIDATION ═══════════════════════════════════════════════════════════════

function validateBrief(text) {
  const t = text.trim();
  const startOk = t.includes(VALID_START) && t.includes(VALID_START_DETAIL);
  const endOk   = t.includes(VALID_END);
  return { valid: startOk && endOk, startOk, endOk };
}

// ══ FILE WRITING (File System Access API) ════════════════════════════════════

async function writeBriefFile(job, text) {
  const fh = await job.targetDir.getFileHandle(job.filename, { create: true });
  const writable = await fh.createWritable();
  await writable.write(text);
  await writable.close();
  return job.filename;
}

// Strip path/extension and sanitise a clip filename → a safe brief filename stem.
function clipNameToStem(videoName) {
  const base = (videoName || 'Brief').replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
  const cleaned = base.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
  return cleaned || 'Brief';
}

// ══ SLOT MANAGEMENT ═══════════════════════════════════════════════════════════

function buildDefaultSlots(count) {
  const existing = state.slots.slice(0, count);
  while (existing.length < count) {
    existing.push({
      dirHandle: null,
      briefDirHandle: null,
      charFile: null,
      charBase64: '',
      charMime: '',
      charName: '',
      charPreviewUrl: '',
      dirName: '',
      // multi_clip: per-slot reference video clip + its own prompt settings
      videoFile: null,
      videoBase64: '',
      videoMime: '',
      videoName: '',
      videoSizeMB: 0,
      topic: '',
      totalScenes: '8',
      aspectRatio: '9:16',
      tabId: null,
      chatgptUrl: '',
      status: 'idle',
      progressMsg: '',
    });
  }
  return existing;
}

function isAllConfigured() {
  if (!state.masterPromptText) return { ok: false, msg: 'Load a Master Prompt (.txt)' };

  const withChar = state.character === 'with_char_sheet';

  if (state.mode === 'multi_clip') {
    if (!state.shared.dirHandle) return { ok: false, msg: 'Select a Page Folder' };
    if (withChar && !state.shared.charBase64) return { ok: false, msg: 'No Character Sheet found in the page folder' };
    for (let i = 0; i < state.slots.length; i++) {
      const s = state.slots[i];
      if (!s.videoBase64)      return { ok: false, msg: `Slot ${i + 1}: Select a Reference Clip` };
      if (!s.topic.trim())     return { ok: false, msg: `Slot ${i + 1}: Enter a TOPIC for this clip` };
    }
    return { ok: true, msg: '' };
  }

  // multi_page (original)
  if (!state.topic.trim())     return { ok: false, msg: 'Enter a TOPIC description' };
  if (!state.videoBase64)      return { ok: false, msg: 'Select a Reference Video Clip' };
  for (let i = 0; i < state.slots.length; i++) {
    const s = state.slots[i];
    if (!s.dirHandle) return { ok: false, msg: `Slot ${i + 1}: Select a Page Folder` };
    if (withChar && !s.charBase64) return { ok: false, msg: `Slot ${i + 1}: No Character Sheet found` };
  }
  return { ok: true, msg: '' };
}

// ══ LOG ══════════════════════════════════════════════════════════════════════

function addLog(slotIndex, msg, type = 'info') {
  const logSection   = document.getElementById('logSection');
  const logContainer = document.getElementById('logContainer');
  if (!logSection || !logContainer) return;

  logSection.style.display = '';

  const row = document.createElement('div');
  row.className = `log-row log-${type}`;
  row.innerHTML = `
    <span class="log-slot">[${slotIndex != null ? String(slotIndex + 1).padStart(2, '0') : '--'}]</span>
    <span class="log-msg">${escHtml(msg)}</span>
    <span class="log-time">${fmtTime()}</span>
  `;
  logContainer.appendChild(row);
  logContainer.scrollTop = logContainer.scrollHeight;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ══ SLOT STATUS UI ════════════════════════════════════════════════════════════

function updateSlotStatus(slotIndex, status, msg) {
  if (slotIndex < 0 || slotIndex >= state.slots.length) return;
  state.slots[slotIndex].status     = status;
  state.slots[slotIndex].progressMsg = msg;
  renderSlotCard(slotIndex);

  const type = status === 'done' ? 'ok'
             : status === 'error' ? 'error'
             : status === 'warn' ? 'warn'
             : 'info';
  addLog(slotIndex, msg, type);
}

// ══ SLOT CARD RENDERING ══════════════════════════════════════════════════════

function renderAllSlots() {
  const container = document.getElementById('slotsContainer');
  if (!container) return;
  container.innerHTML = '';
  const grid = document.createElement('div');
  grid.className = 'slots-grid';
  for (let i = 0; i < state.slotCount; i++) {
    grid.appendChild(buildSlotCard(i));
  }
  container.appendChild(grid);
}

function buildSlotCard(index) {
  const slot = state.slots[index];
  const div = document.createElement('div');
  div.id = `slot-${index}`;
  div.className = 'slot-card' + slotCardClass(slot.status);
  div.innerHTML = slotCardInner(index, slot);
  return div;
}

function renderSlotCard(index) {
  const existing = document.getElementById(`slot-${index}`);
  if (!existing) return;
  const slot = state.slots[index];
  existing.className = 'slot-card' + slotCardClass(slot.status);
  existing.innerHTML = slotCardInner(index, slot);
  attachSlotListeners(index);
}

function slotCardClass(status) {
  if (status === 'done')  return ' done';
  if (status === 'error') return ' error';
  if (status === 'warn')  return ' warn';
  if (['waiting','uploading','typing','submitting','generating','extracting'].includes(status)) return ' running';
  if (status === 'configured') return ' configured';
  return '';
}

function slotCardInner(index, slot) {
  const n = index + 1;
  const statusBadge = slotBadgeHtml(slot.status);
  const isRunning   = state.isRunning;

  let bodyHtml = '';

  if (state.mode === 'multi_clip') {
    // multi_clip slot = one reference video clip + its own prompt settings
    const clipHtml = slot.videoBase64
      ? `
        <div class="slot-video-info">
          <span class="slot-video-icon">📹</span>
          <div class="slot-video-details">
            <div class="slot-video-name">${escHtml(slot.videoName)}</div>
            <div class="slot-video-size">${escHtml(fmtSize((slot.videoSizeMB || 0) * 1048576))}</div>
          </div>
          ${!isRunning ? `<button class="slot-change-btn" data-slot="${index}" data-action="select-video">✎</button>` : ''}
        </div>
      `
      : `
        <button class="slot-folder-btn" data-slot="${index}" data-action="select-video"
                ${isRunning ? 'disabled' : ''}>
          📹 Select Video Clip
        </button>
      `;

    const dis = isRunning ? 'disabled' : '';
    const perClipHtml = `
      <div class="slot-perclip">
        <div class="slot-field">
          <label class="slot-field-label">TOPIC</label>
          <input type="text" class="input-text slot-topic-input" data-slot="${index}"
                 placeholder="Topic for this clip…" value="${escHtml(slot.topic || '')}" ${dis} />
        </div>
        <div class="field-row">
          <div class="field half">
            <label class="slot-field-label">SCENES</label>
            <select class="input-select slot-scenes-select" data-slot="${index}" ${dis}>
              ${scenesOptionsHtml(slot.totalScenes)}
            </select>
          </div>
          <div class="field half">
            <label class="slot-field-label">RATIO</label>
            <select class="input-select slot-ratio-select" data-slot="${index}" ${dis}>
              ${ratioOptionsHtml(slot.aspectRatio)}
            </select>
          </div>
        </div>
      </div>
    `;

    bodyHtml = clipHtml + perClipHtml;
  } else if (slot.dirHandle) {
    // multi_page: folder selected — show char sheet info
    const imgHtml = slot.charPreviewUrl
      ? `<img src="${escHtml(slot.charPreviewUrl)}" class="slot-char-img" alt="char" />`
      : `<span style="font-size:20px;flex-shrink:0;">🖼️</span>`;

    const charLabel = slot.charBase64
      ? escHtml(slot.charName)
      : '<span style="color:var(--warn)">No character sheet found</span>';

    bodyHtml = `
      <div class="slot-char-info">
        ${imgHtml}
        <div class="slot-char-details">
          <div class="slot-char-name">${charLabel}</div>
          <div class="slot-char-folder">📁 ${escHtml(slot.dirName)}</div>
        </div>
        ${!isRunning ? `<button class="slot-change-btn" data-slot="${index}" data-action="change">✎</button>` : ''}
      </div>
    `;
  } else {
    bodyHtml = `
      <button class="slot-folder-btn" data-slot="${index}" data-action="select"
              ${isRunning ? 'disabled' : ''}>
        📁 Select Page Folder
      </button>
    `;
  }

  const progressHtml = slot.progressMsg
    ? `<div class="slot-progress-msg">${escHtml(slot.progressMsg)}</div>`
    : '';

  const canReset = !isRunning && ['done', 'warn', 'error'].includes(slot.status);
  const resetBtn = canReset
    ? `<button class="slot-reset-btn" data-slot="${index}" data-action="reset" title="Clear slot — select a new folder">✕</button>`
    : '';

  // Action buttons shown after a slot reaches a terminal state
  const isTerminal = ['done', 'warn', 'error'].includes(slot.status);
  const chatgptBtn = (slot.chatgptUrl && isTerminal)
    ? `<button class="slot-action-btn" data-slot="${index}" data-action="open-chatgpt">↗ Open ChatGPT</button>`
    : '';
  const viewBriefBtn = (['done', 'warn'].includes(slot.status) && (slot.outDirHandle || slot.dirHandle))
    ? `<button class="slot-action-btn" data-slot="${index}" data-action="view-brief">📄 View Brief</button>`
    : '';
  const actionsHtml = (chatgptBtn || viewBriefBtn)
    ? `<div class="slot-actions">${chatgptBtn}${viewBriefBtn}</div>`
    : '';

  return `
    <div class="slot-header">
      <span class="slot-num">${n}</span>
      <span class="slot-title">Slot ${n}</span>
      ${statusBadge}
      ${resetBtn}
    </div>
    <div class="slot-body">
      ${bodyHtml}
      ${progressHtml}
      ${actionsHtml}
    </div>
  `;
}

// Per-clip <option> lists for multi_clip slots — mirror the global selects in
// sidepanel.html, marking the slot's current value as selected.
function optionsHtml(opts, selected) {
  return opts.map(([value, label]) =>
    `<option value="${escHtml(value)}"${value === selected ? ' selected' : ''}>${escHtml(label)}</option>`
  ).join('');
}
function scenesOptionsHtml(selected) {
  return optionsHtml([
    ['auto', '🤖 AI Recommends'],
    ['6', '6'], ['7', '7'], ['8', '8'], ['9', '9'], ['10', '10'],
  ], selected);
}
function ratioOptionsHtml(selected) {
  return optionsHtml([
    ['9:16', '9:16'], ['3:4', '3:4'], ['16:9', '16:9'], ['4:5', '4:5'],
  ], selected);
}

function slotBadgeHtml(status) {
  const map = {
    idle:       ['badge-idle',    'IDLE'],
    configured: ['badge-done',    'READY'],
    waiting:    ['badge-waiting', 'WAITING'],
    uploading:  ['badge-running', 'UPLOADING'],
    typing:     ['badge-running', 'TYPING'],
    submitting: ['badge-running', 'SUBMIT'],
    generating: ['badge-running', 'GENERATING'],
    extracting: ['badge-running', 'EXTRACTING'],
    done:       ['badge-done',    'DONE ✅'],
    warn:       ['badge-warn',    'DONE ⚠️'],
    error:      ['badge-error',   'ERROR ❌'],
  };
  const [cls, label] = map[status] || ['badge-idle', 'IDLE'];
  return `<span class="slot-status-badge ${cls}">${label}</span>`;
}

function resetSlot(slotIndex) {
  const slot = state.slots[slotIndex];
  if (slot.charPreviewUrl) URL.revokeObjectURL(slot.charPreviewUrl);
  slot.dirHandle      = null;
  slot.briefDirHandle = null;
  slot.charFile       = null;
  slot.charBase64     = '';
  slot.charMime       = '';
  slot.charName       = '';
  slot.charPreviewUrl = '';
  slot.dirName        = '';
  slot.videoFile      = null;
  slot.videoBase64    = '';
  slot.videoMime      = '';
  slot.videoName      = '';
  slot.videoSizeMB    = 0;
  slot.topic          = '';
  slot.totalScenes    = '8';
  slot.aspectRatio    = '9:16';
  slot.outFilename    = '';
  slot.outDirHandle   = null;
  slot.tabId          = null;
  slot.chatgptUrl     = '';
  slot.status         = 'idle';
  slot.progressMsg    = '';
  renderSlotCard(slotIndex);
  attachSlotListeners(slotIndex);
  validateAndRefreshUI();
}

function attachSlotListeners(index) {
  const card = document.getElementById(`slot-${index}`);
  if (!card) return;
  card.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const action  = btn.getAttribute('data-action');
      const slotIdx = parseInt(btn.getAttribute('data-slot'), 10);
      if (action === 'select' || action === 'change') {
        handleSelectSlotFolder(slotIdx);
      } else if (action === 'select-video') {
        handleSelectSlotVideo(slotIdx);
      } else if (action === 'reset') {
        resetSlot(slotIdx);
      } else if (action === 'open-chatgpt') {
        const slot = state.slots[slotIdx];
        if (slot.chatgptUrl) chrome.tabs.create({ url: slot.chatgptUrl, active: true });
      } else if (action === 'view-brief') {
        (async () => {
          const slot = state.slots[slotIdx];
          const filename = slot.outFilename || `${state.baseFilename || 'Brief'}-${slotIdx + 1}.txt`;
          const dir = slot.outDirHandle || slot.briefDirHandle || slot.dirHandle;
          try {
            const fh  = await dir.getFileHandle(filename);
            const file = await fh.getFile();
            const text = await file.text();
            showBriefModal(slotIdx + 1, filename, text);
          } catch (e) {
            addLog(slotIdx, `Could not read ${filename}: ${e.message}`, 'error');
          }
        })();
      }
    });
  });

  // Per-clip prompt-setting inputs (multi_clip only). These have no data-action,
  // so the click delegation above ignores them. validateAndRefreshUI() does not
  // re-render slot cards, so typing in the topic field keeps focus.
  const topicInput = card.querySelector('.slot-topic-input');
  if (topicInput) topicInput.addEventListener('input', (e) => {
    state.slots[index].topic = e.target.value;
    validateAndRefreshUI();
  });
  const scenesSel = card.querySelector('.slot-scenes-select');
  if (scenesSel) scenesSel.addEventListener('change', (e) => {
    state.slots[index].totalScenes = e.target.value;
  });
  const ratioSel = card.querySelector('.slot-ratio-select');
  if (ratioSel) ratioSel.addEventListener('change', (e) => {
    state.slots[index].aspectRatio = e.target.value;
  });
}

function attachAllSlotListeners() {
  for (let i = 0; i < state.slotCount; i++) attachSlotListeners(i);
}

// ══ SLOT FOLDER SELECTION ═════════════════════════════════════════════════════

// Scan a directory (root + one level of subfolders) for image files and pick the
// most likely character sheet. Shared by the multi_page slot picker and the
// multi_clip shared-folder picker. Returns { found, allImages }.
async function detectCharSheet(dirHandle) {
  const allImages = [];  // { name, handle, parent: DirectoryHandle }
  try {
    for await (const [name, handle] of dirHandle) {
      if (handle.kind === 'file' && /\.(png|jpg|jpeg|webp|gif)$/i.test(name)) {
        allImages.push({ name, handle, parent: dirHandle });
      } else if (handle.kind === 'directory') {
        try {
          for await (const [subName, subHandle] of handle) {
            if (subHandle.kind === 'file' && /\.(png|jpg|jpeg|webp|gif)$/i.test(subName)) {
              allImages.push({ name: subName, handle: subHandle, parent: handle });
            }
          }
        } catch {}
      }
    }
  } catch (e) {
    console.warn('Error reading directory', e);
  }

  // Prefer "Character Sheet" in name, then anything with "character"
  const found = allImages.find(f => /character\s*sheet/i.test(f.name))
             || allImages.find(f => /character/i.test(f.name));
  return { found, allImages };
}

async function handleSelectSlotFolder(slotIndex) {
  let dirHandle;
  try {
    dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
  } catch (err) {
    if (err.name !== 'AbortError') console.error('showDirectoryPicker error', err);
    return;
  }

  const slot = state.slots[slotIndex];
  slot.dirHandle      = dirHandle;
  slot.briefDirHandle = null;
  slot.dirName        = dirHandle.name;
  slot.charFile       = null;
  slot.charBase64     = '';
  slot.charMime       = '';
  slot.charName       = '';
  if (slot.charPreviewUrl) { URL.revokeObjectURL(slot.charPreviewUrl); slot.charPreviewUrl = ''; }
  slot.status = 'configured';

  renderSlotCard(slotIndex);
  attachSlotListeners(slotIndex);

  // Auto-detect character sheet (scan root + one level of subfolders).
  // This lets the user select the "Folder Page" (parent) so dirName shows the page name.
  const { found, allImages } = await detectCharSheet(dirHandle);

  if (found) {
    slot.briefDirHandle = found.parent;
    await loadCharSheet(slotIndex, found.handle);
  } else if (allImages.length === 0) {
    slot.briefDirHandle = dirHandle;
    addLog(slotIndex, `⚠️ No image files found in "${dirHandle.name}" or its subfolders`, 'warn');
    updateSlotStatus(slotIndex, 'configured', `No image files found`);
  } else {
    // Let user pick from all found images
    await showCharPickerModal(allImages, async (handle, parent) => {
      slot.briefDirHandle = parent;
      await loadCharSheet(slotIndex, handle);
    });
  }

  validateAndRefreshUI();
}

async function loadCharSheet(slotIndex, fileHandle) {
  const slot = state.slots[slotIndex];
  try {
    const file = await fileHandle.getFile();
    slot.charFile = file;
    slot.charName = file.name;
    slot.charMime = file.type || 'image/png';

    slot.charBase64 = await fileToBase64(file);
    slot.charPreviewUrl = URL.createObjectURL(file);
    slot.status = 'configured';

    renderSlotCard(slotIndex);
    attachSlotListeners(slotIndex);
  } catch (e) {
    addLog(slotIndex, `Error reading character sheet: ${e.message}`, 'error');
  }
}

// ══ SLOT VIDEO SELECTION (multi_clip) ═════════════════════════════════════════

function handleSelectSlotVideo(slotIndex) {
  // Detached input — Chrome fires 'change' without attaching to the DOM, so a
  // cancelled picker leaves no orphan element behind.
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'video/*';

  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    if (!file) return;

    const slot = state.slots[slotIndex];
    slot.videoFile   = file;
    slot.videoName   = file.name;
    slot.videoMime   = file.type || 'video/mp4';
    slot.videoSizeMB = file.size / 1048576;
    try {
      slot.videoBase64 = await fileToBase64(file);
    } catch (e) {
      addLog(slotIndex, `Error reading video: ${e.message}`, 'error');
      return;
    }
    slot.status = 'configured';
    renderSlotCard(slotIndex);
    attachSlotListeners(slotIndex);

    // Warn if the combined size of all selected clips is large — every clip is
    // held as base64 in memory and sent over chrome messaging per tab.
    const totalMB = state.slots.reduce((sum, s) => sum + (s.videoSizeMB || 0), 0);
    if (totalMB > 60) {
      addLog(null, `⚠️ Clips total ${totalMB.toFixed(0)} MB across slots — high memory use; consider fewer/smaller clips`, 'warn');
    }

    validateAndRefreshUI();
  }, { once: true });

  input.click();
}

// ══ SHARED PAGE FOLDER (multi_clip) ═══════════════════════════════════════════

async function handleSelectSharedFolder() {
  let dirHandle;
  try {
    dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
  } catch (err) {
    if (err.name !== 'AbortError') console.error('showDirectoryPicker error', err);
    return;
  }

  const sh = state.shared;
  sh.dirHandle      = dirHandle;
  sh.briefDirHandle = null;
  sh.dirName        = dirHandle.name;
  sh.charFile       = null;
  sh.charBase64     = '';
  sh.charMime       = '';
  sh.charName       = '';
  if (sh.charPreviewUrl) { URL.revokeObjectURL(sh.charPreviewUrl); sh.charPreviewUrl = ''; }
  sh.status = 'configured';
  renderSharedFolder();

  const { found, allImages } = await detectCharSheet(dirHandle);

  if (found) {
    sh.briefDirHandle = found.parent;
    await loadSharedCharSheet(found.handle);
  } else if (allImages.length === 0) {
    sh.briefDirHandle = dirHandle;
    addLog(null, `⚠️ No image files found in "${dirHandle.name}" or its subfolders`, 'warn');
    renderSharedFolder();
  } else {
    await showCharPickerModal(allImages, async (handle, parent) => {
      sh.briefDirHandle = parent;
      await loadSharedCharSheet(handle);
    });
  }

  validateAndRefreshUI();
}

async function loadSharedCharSheet(fileHandle) {
  const sh = state.shared;
  try {
    const file = await fileHandle.getFile();
    sh.charFile = file;
    sh.charName = file.name;
    sh.charMime = file.type || 'image/png';
    sh.charBase64 = await fileToBase64(file);
    sh.charPreviewUrl = URL.createObjectURL(file);
    renderSharedFolder();
  } catch (e) {
    addLog(null, `Error reading character sheet: ${e.message}`, 'error');
  }
}

function renderSharedFolder() {
  const body = document.getElementById('sharedFolderBody');
  if (!body) return;
  const sh = state.shared;
  const isRunning = state.isRunning;

  if (sh.dirHandle) {
    const imgHtml = sh.charPreviewUrl
      ? `<img src="${escHtml(sh.charPreviewUrl)}" class="slot-char-img" alt="char" />`
      : `<span style="font-size:20px;flex-shrink:0;">🖼️</span>`;
    const charLabel = sh.charBase64
      ? escHtml(sh.charName)
      : '<span style="color:var(--warn)">No character sheet found</span>';
    body.innerHTML = `
      <div class="slot-char-info">
        ${imgHtml}
        <div class="slot-char-details">
          <div class="slot-char-name">${charLabel}</div>
          <div class="slot-char-folder">📁 ${escHtml(sh.dirName)}</div>
        </div>
        ${!isRunning ? `<button class="slot-change-btn" id="sharedFolderChange">✎</button>` : ''}
      </div>
    `;
  } else {
    body.innerHTML = `
      <button class="btn btn-outline w100" id="sharedFolderSelect" ${isRunning ? 'disabled' : ''}>
        📁 Select Page Folder
      </button>
    `;
  }

  const selBtn = document.getElementById('sharedFolderSelect');
  const chgBtn = document.getElementById('sharedFolderChange');
  if (selBtn) selBtn.addEventListener('click', handleSelectSharedFolder);
  if (chgBtn) chgBtn.addEventListener('click', handleSelectSharedFolder);
}

// ══ CHAR PICKER MODAL ═════════════════════════════════════════════════════════

// onConfirm(selectedHandle, selectedParent) is awaited when the user confirms.
async function showCharPickerModal(imageFiles, onConfirm) {
  return new Promise(async (resolve) => {
    const overlay  = document.getElementById('modalOverlay');
    const list     = document.getElementById('modalFileList');
    const confirm  = document.getElementById('modalConfirm');

    list.innerHTML = '';
    let selectedHandle = null;
    let selectedParent = null;
    let selectedPreviewUrls = [];

    for (const { name, handle, parent } of imageFiles) {
      const file = await handle.getFile();
      const previewUrl = URL.createObjectURL(file);
      selectedPreviewUrls.push(previewUrl);

      const item = document.createElement('div');
      item.className = 'modal-file-item';
      item.innerHTML = `
        <img src="${escHtml(previewUrl)}" class="modal-file-thumb" alt="" />
        <span class="modal-file-name">${escHtml(name)}</span>
      `;
      item.addEventListener('click', () => {
        list.querySelectorAll('.modal-file-item').forEach(el => el.classList.remove('selected'));
        item.classList.add('selected');
        selectedHandle = handle;
        selectedParent = parent;
        confirm.disabled = false;
      });
      list.appendChild(item);
    }

    overlay.style.display = 'flex';

    confirm.onclick = async () => {
      overlay.style.display = 'none';
      selectedPreviewUrls.forEach(u => URL.revokeObjectURL(u));
      if (selectedHandle) {
        await onConfirm(selectedHandle, selectedParent);
      }
      resolve();
    };

    document.getElementById('modalCancel').onclick =
    document.getElementById('modalClose').onclick = () => {
      overlay.style.display = 'none';
      selectedPreviewUrls.forEach(u => URL.revokeObjectURL(u));
      resolve();
    };
  });
}

// ══ MAIN START FLOW ═══════════════════════════════════════════════════════════

// Build a normalized per-slot job for the active mode. Both modes converge on the
// same job shape so runSlot / writeBriefFile stay mode-agnostic.
function buildJobs() {
  const useCharSheet = state.character === 'with_char_sheet';

  if (state.mode === 'multi_clip') {
    // 1 shared page folder + char sheet → N video-clip slots.
    const targetDir = state.shared.briefDirHandle || state.shared.dirHandle;
    const usedStems = new Map(); // stem → how many times seen (for de-dup)
    return state.slots.map((slot) => {
      const stem  = clipNameToStem(slot.videoName);
      const count = usedStems.get(stem) || 0;
      usedStems.set(stem, count + 1);
      const filename = (count === 0 ? stem : `${stem}-${count + 1}`) + '.txt';
      return {
        videoBase64: slot.videoBase64,
        videoMime:   slot.videoMime,
        videoName:   slot.videoName,
        charBase64:  state.shared.charBase64,
        charMime:    state.shared.charMime,
        charName:    state.shared.charName,
        useCharSheet,
        targetDir,
        filename,
      };
    });
  }

  // multi_page (original behaviour — must remain identical):
  // 1 shared video → N page slots, each with its own char sheet & folder.
  return state.slots.map((slot, i) => ({
    videoBase64: state.videoBase64,
    videoMime:   state.videoMime,
    videoName:   state.videoName,
    charBase64:  slot.charBase64,
    charMime:    slot.charMime,
    charName:    slot.charName,
    useCharSheet,
    targetDir:   slot.briefDirHandle || slot.dirHandle,
    filename:    `${state.baseFilename || 'Brief'}-${i + 1}.txt`,
  }));
}

async function startAnalysis() {
  const check = isAllConfigured();
  if (!check.ok) {
    document.getElementById('validationMsg').textContent = check.msg;
    return;
  }

  state.isRunning = true;
  document.getElementById('validationMsg').textContent = '';
  document.getElementById('logSection').style.display = '';
  document.getElementById('logContainer').innerHTML = '';

  const btnStart = document.getElementById('btnStart');
  btnStart.textContent = '⏳ Running…';
  btnStart.classList.add('running');
  btnStart.disabled = true;

  setInputsEnabled(false);

  addLog(null, `Starting ${state.slotCount} slot(s)…`, 'info');

  const jobs = buildJobs();

  // Open all tabs
  const tabIds = [];
  for (let i = 0; i < state.slotCount; i++) {
    const tab = await chrome.tabs.create({ url: 'https://chatgpt.com/', active: false });
    state.slots[i].tabId = tab.id;
    tabIds.push(tab.id);
    renderSlotCard(i);
    if (i < state.slotCount - 1) await sleep(600);
  }

  addLog(null, `Opened ${tabIds.length} ChatGPT tabs`, 'info');

  // Launch all slots in parallel (each handles its own lifecycle).
  // In multi_clip each slot builds its prompt from its own topic/scenes/ratio;
  // multi_page uses the global settings.
  const slotPromises = state.slots.map((slot, i) => {
    const settings = state.mode === 'multi_clip'
      ? { topic: slot.topic, totalScenes: slot.totalScenes, aspectRatio: slot.aspectRatio }
      : undefined;
    return runSlot(i, slot.tabId, jobs[i], buildPrompt(settings)).catch(err => {
      updateSlotStatus(i, 'error', `Error: ${err.message}`);
    });
  });

  await Promise.allSettled(slotPromises);

  state.isRunning = false;
  btnStart.textContent = '▶ Start Analysis';
  btnStart.classList.remove('running');
  btnStart.disabled = false;
  setInputsEnabled(true);
  addLog(null, '✅ All slots finished.', 'ok');
}

async function runSlot(slotIndex, tabId, job, prompt) {
  const slot = state.slots[slotIndex];

  // Stagger with random delay per slot so tabs don't all race ChatGPT at once.
  // Slot 0 starts immediately; slot N waits between N×8s and N×15s (random).
  // Randomness avoids predictable bot patterns and buffers slow connections.
  if (slotIndex > 0) {
    const minMs = slotIndex * 8000;
    const maxMs = slotIndex * 15000;
    const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
    updateSlotStatus(slotIndex, 'waiting', `⏳ Starting in ~${Math.round(delay / 1000)}s…`);
    await sleep(delay);
  }

  updateSlotStatus(slotIndex, 'waiting', '⏳ Waiting for ChatGPT to load…');

  // Wait for the tab to fully load (90 s — background tabs load slower)
  await waitForTabReady(tabId, 90000);
  await sleep(3000); // extra time for ChatGPT's SPA to boot

  // Guard against redirect races: ChatGPT sometimes fires 'complete' for an
  // intermediate auth/redirect URL before landing on the actual page.
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url?.includes('chatgpt.com')) {
    updateSlotStatus(slotIndex, 'waiting', '⏳ Waiting for ChatGPT redirect…');
    await waitForTabReady(tabId, 30000);
    await sleep(2000);
  }

  // Inject the content script
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content-chatgpt.js'],
  });

  // Ping until the script is ready (45 s)
  await pingTabUntilReady(tabId, 45000);

  updateSlotStatus(slotIndex, 'starting', '🚀 Sending data to ChatGPT tab…');

  await chrome.tabs.sendMessage(tabId, {
    type: 'START_SLOT',
    slotIndex,
    videoBase64: job.videoBase64,
    videoMime:   job.videoMime,
    videoName:   job.videoName,
    charBase64:  job.charBase64,
    charMime:    job.charMime,
    charName:    job.charName,
    promptText:  prompt,
    useCharSheet: job.useCharSheet,
  });

  // Wait for result (SLOT_COMPLETE or SLOT_ERROR resolves/rejects this promise)
  const rawText = await waitForSlotResult(slotIndex);

  // Trim to the markers: cut everything before STORYBOARD PROMPT and
  // everything after the closing === line of the end block.
  const text = trimBriefText(rawText);

  // Validate
  const { valid, startOk, endOk } = validateBrief(text);

  // Write file
  let filename;
  try {
    filename = await writeBriefFile(job, text);
  } catch (e) {
    updateSlotStatus(slotIndex, 'error', `Failed to save file: ${e.message}`);
    await closeTab(tabId);
    return;
  }

  // Record where the brief landed so "View Brief" works in either mode.
  slot.outFilename  = filename;
  slot.outDirHandle = job.targetDir;

  // Report outcome
  if (valid) {
    updateSlotStatus(slotIndex, 'done', `✅ Saved: ${filename}`);
  } else {
    const issues = [];
    if (!startOk) issues.push('missing start pattern');
    if (!endOk)   issues.push('missing end pattern');
    updateSlotStatus(slotIndex, 'warn',
      `⚠️ Saved with warning: ${filename} (${issues.join(', ')}) — review manually`);
  }

  await closeTab(tabId);
}

function waitForSlotResult(slotIndex) {
  return new Promise((resolve, reject) => {
    slotResolvers.set(slotIndex, { resolve, reject });

    // Timeout after 35 minutes (content script allows 30 min; this is the outer safety net)
    const timer = setTimeout(() => {
      slotResolvers.delete(slotIndex);
      reject(new Error('Timeout: ChatGPT did not respond within 35 minutes'));
    }, 35 * 60 * 1000);

    // Store timer so it can be cleared on success
    const existing = slotResolvers.get(slotIndex);
    if (existing) existing.timer = timer;
  });
}

async function closeTab(tabId) {
  try {
    await chrome.tabs.remove(tabId);
  } catch {}
}

// ══ INCOMING MESSAGES (from content scripts) ══════════════════════════════════

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  sendResponse({ ok: true });

  if (msg.type === 'SLOT_PROGRESS') {
    const { slotIndex, status, message } = msg;
    updateSlotStatus(slotIndex, status, message);
  }

  else if (msg.type === 'SLOT_COMPLETE') {
    const resolver = slotResolvers.get(msg.slotIndex);
    if (resolver) {
      clearTimeout(resolver.timer);
      slotResolvers.delete(msg.slotIndex);
      resolver.resolve(msg.text);
    }
  }

  else if (msg.type === 'SLOT_ERROR') {
    const resolver = slotResolvers.get(msg.slotIndex);
    if (resolver) {
      clearTimeout(resolver.timer);
      slotResolvers.delete(msg.slotIndex);
      resolver.reject(new Error(msg.error));
    }
  }

  else if (msg.type === 'SLOT_URL') {
    const idx = msg.slotIndex;
    if (idx >= 0 && idx < state.slots.length) {
      state.slots[idx].chatgptUrl = msg.url;
      renderSlotCard(idx);
    }
  }
});

// ══ BRIEF MODAL ══════════════════════════════════════════════════════════════

function showBriefModal(slotNum, filename, text) {
  document.getElementById('briefModalTitle').textContent = `Slot ${slotNum} — ${filename}`;
  document.getElementById('briefModalText').textContent = text;
  document.getElementById('briefModalOverlay').style.display = 'flex';
}

// ══ UI HELPERS ══════════════════════════════════════════════════════════════

function setInputsEnabled(enabled) {
  const ids = [
    'btnLoadPrompt','btnLoadVideo','inputTopic','selectCharacter',
    'selectScenes','selectRatio','inputFilename','btnSlotMinus','btnSlotPlus',
    'modeBtnMultiPage','modeBtnMultiClip',
  ];
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = !enabled;
  });
  document.querySelectorAll(
    '.slot-folder-btn, .slot-change-btn, #sharedFolderSelect, #sharedFolderChange'
  ).forEach(btn => {
    btn.disabled = !enabled;
  });
}

// Switch between multi_page and multi_clip. Show/hide the mode-specific cards,
// re-render slots + shared folder, and recompute per-slot "configured" status so
// no stale badge from the other mode lingers.
function switchMode(mode) {
  if (state.isRunning || mode === state.mode) return;
  state.mode = mode;

  document.getElementById('modeBtnMultiPage').classList.toggle('mode-active', mode === 'multi_page');
  document.getElementById('modeBtnMultiClip').classList.toggle('mode-active', mode === 'multi_clip');

  document.querySelectorAll('.mode-multi_page-only').forEach(el => {
    el.style.display = mode === 'multi_page' ? '' : 'none';
  });
  document.querySelectorAll('.mode-multi_clip-only').forEach(el => {
    el.style.display = mode === 'multi_clip' ? '' : 'none';
  });

  document.getElementById('slotsCardTitle').textContent =
    mode === 'multi_clip' ? 'Reference Clips' : 'Slots (Pages)';

  // Base filename only applies to multi_page (multi_clip names briefs after clips).
  const fnInput = document.getElementById('inputFilename');
  if (fnInput) fnInput.disabled = mode === 'multi_clip';

  // Recompute displayed status based on the new mode's required input.
  for (const slot of state.slots) {
    const hasInput = mode === 'multi_clip' ? !!slot.videoBase64 : !!slot.dirHandle;
    slot.status      = hasInput ? 'configured' : 'idle';
    slot.progressMsg = '';
    slot.outFilename  = '';
    slot.outDirHandle = null;
  }

  renderSharedFolder();
  renderAllSlots();
  attachAllSlotListeners();
  validateAndRefreshUI();
}

function validateAndRefreshUI() {
  const check = isAllConfigured();
  const btnStart = document.getElementById('btnStart');
  if (!state.isRunning) {
    btnStart.disabled = !check.ok;
    const tabWord = state.slotCount === 1 ? '1 tab' : `${state.slotCount} tabs`;
    btnStart.textContent = check.ok
      ? `▶ Start Analysis (${tabWord})`
      : '▶ Start Analysis';
  }
  document.getElementById('validationMsg').textContent = check.ok ? '' : check.msg;
  updateFilenamePreview();
}

function updateFilenamePreview() {
  const preview = document.getElementById('filenamePreview');
  if (!preview) return;

  if (state.mode === 'multi_clip') {
    const names = state.slots.filter(s => s.videoName)
                             .map(s => clipNameToStem(s.videoName) + '.txt');
    preview.textContent = names.length
      ? `Named after each clip — e.g. ${names.slice(0, 3).join(', ')}${names.length > 3 ? ', …' : ''}`
      : 'Each brief is named after its source clip (e.g. my-clip.txt)';
    return;
  }

  const base = (document.getElementById('inputFilename')?.value || 'Brief').trim() || 'Brief';
  const count = Math.min(state.slotCount, 3);
  const examples = Array.from({ length: count }, (_, i) => `${base}-${i + 1}.txt`);
  if (state.slotCount > 3) examples.push('…');
  preview.textContent = `e.g. ${examples.join(', ')}`;
}

// ══ INIT / EVENT WIRING ═══════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
  // ── Tab switcher ────────────────────────────────────────────────────────────
  const tabAnalysis  = document.getElementById('tabAnalysis');
  const tabPipeline  = document.getElementById('tabPipeline');
  const tabBtnA      = document.getElementById('tabBtnAnalysis');
  const tabBtnP      = document.getElementById('tabBtnPipeline');

  function switchTab(target) {
    const isAnalysis = target === 'analysis';
    tabAnalysis.style.display  = isAnalysis ? '' : 'none';
    tabPipeline.style.display  = isAnalysis ? 'none' : '';
    tabBtnA.classList.toggle('tab-active', isAnalysis);
    tabBtnP.classList.toggle('tab-active', !isAnalysis);
    if (!isAnalysis) {
      pipelineCheckServer();
    }
  }

  tabBtnA.addEventListener('click', () => switchTab('analysis'));
  tabBtnP.addEventListener('click', () => switchTab('pipeline'));

  // ── Pipeline button wiring ──────────────────────────────────────────────────
  document.getElementById('btnQueue').addEventListener('click', pipelineQueueBriefs);
  document.getElementById('btnAddPage').addEventListener('click', pipelineAddPage);
  document.getElementById('btnRenamePage').addEventListener('click', pipelineRenamePage);
  document.getElementById('btnRefreshProjects').addEventListener('click', pipelineLoadProjects);
  document.getElementById('btnUpdatePrompts').addEventListener('click', pipelineUpdatePrompts);

  // Allow Enter key in the add-page input
  document.getElementById('inputAddPage').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') pipelineAddPage();
  });

  // ── Mode toggle ──────────────────────────────────────────────────────────────
  document.getElementById('modeBtnMultiPage').addEventListener('click', () => switchMode('multi_page'));
  document.getElementById('modeBtnMultiClip').addEventListener('click', () => switchMode('multi_clip'));

  // Initialise slots
  state.slots = buildDefaultSlots(state.slotCount);
  renderAllSlots();
  attachAllSlotListeners();
  renderSharedFolder();
  validateAndRefreshUI();

  // ── Master Prompt ──────────────────────────────────────────────────────────
  document.getElementById('btnLoadPrompt').addEventListener('click', () => {
    document.getElementById('filePrompt').click();
  });

  document.getElementById('filePrompt').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      state.masterPromptText = text;
      state.masterPromptName = file.name;

      // Extract version from first line (e.g. "# MASTER PROMPT v3.4 — ...")
      const versionMatch = text.match(/v\d+\.\d+/);
      state.masterPromptVersion = versionMatch ? versionMatch[0] : '';

      document.getElementById('promptFileName').textContent = file.name;
      document.getElementById('promptInfo').style.display = 'flex';
      document.getElementById('promptBadge').textContent =
        `${file.name}${state.masterPromptVersion ? ' · ' + state.masterPromptVersion : ''}`;
      document.getElementById('promptVersionBadge').textContent =
        state.masterPromptVersion || '';

      validateAndRefreshUI();
    } catch (err) {
      alert('Error reading master prompt: ' + err.message);
    }
    e.target.value = '';
  });

  // ── Video Clip ─────────────────────────────────────────────────────────────
  document.getElementById('btnLoadVideo').addEventListener('click', () => {
    document.getElementById('fileVideo').click();
  });

  document.getElementById('fileVideo').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const sizeMB = file.size / 1048576;
    state.videoFile = file;
    state.videoMime = file.type || 'video/mp4';
    state.videoName = file.name;
    state.videoSizeMB = sizeMB;

    document.getElementById('videoFileName').textContent = file.name;
    document.getElementById('videoFileSize').textContent = `${fmtSize(file.size)}`;
    document.getElementById('videoInfo').style.display  = 'flex';
    document.getElementById('videoSizeWarn').style.display = sizeMB > 40 ? '' : 'none';

    // Read as base64
    try {
      state.videoBase64 = await fileToBase64(file);
    } catch (err) {
      alert('Error reading video file: ' + err.message);
      return;
    }

    validateAndRefreshUI();
    e.target.value = '';
  });

  // ── Settings fields ────────────────────────────────────────────────────────
  document.getElementById('inputTopic').addEventListener('input', (e) => {
    state.topic = e.target.value;
    validateAndRefreshUI();
  });

  document.getElementById('selectCharacter').addEventListener('change', (e) => {
    state.character = e.target.value;
    validateAndRefreshUI();
  });

  document.getElementById('selectScenes').addEventListener('change', (e) => {
    state.totalScenes = e.target.value;
  });

  document.getElementById('selectRatio').addEventListener('change', (e) => {
    state.aspectRatio = e.target.value;
  });

  // ── Filename ───────────────────────────────────────────────────────────────
  document.getElementById('inputFilename').addEventListener('input', (e) => {
    state.baseFilename = e.target.value.trim() || 'Brief';
    updateFilenamePreview();
  });

  // ── Slot stepper ───────────────────────────────────────────────────────────
  document.getElementById('btnSlotMinus').addEventListener('click', () => {
    if (state.slotCount <= 1) return;
    state.slotCount--;
    state.slots = buildDefaultSlots(state.slotCount);
    document.getElementById('slotCountDisplay').textContent = state.slotCount;
    renderAllSlots();
    attachAllSlotListeners();
    validateAndRefreshUI();
  });

  document.getElementById('btnSlotPlus').addEventListener('click', () => {
    if (state.slotCount >= 20) return;
    state.slotCount++;
    state.slots = buildDefaultSlots(state.slotCount);
    document.getElementById('slotCountDisplay').textContent = state.slotCount;
    renderAllSlots();
    attachAllSlotListeners();
    validateAndRefreshUI();
  });

  // ── Start button ───────────────────────────────────────────────────────────
  document.getElementById('btnStart').addEventListener('click', () => {
    startAnalysis().catch(err => {
      addLog(null, `Fatal error: ${err.message}`, 'error');
      state.isRunning = false;
      const btnStart = document.getElementById('btnStart');
      btnStart.textContent = '▶ Start Analysis';
      btnStart.classList.remove('running');
      btnStart.disabled = false;
      setInputsEnabled(true);
    });
  });

  // ── Clear log ──────────────────────────────────────────────────────────────
  document.getElementById('btnClearLog').addEventListener('click', () => {
    document.getElementById('logContainer').innerHTML = '';
  });

  // ── Brief viewer modal ─────────────────────────────────────────────────────
  document.getElementById('briefModalClose').addEventListener('click', () => {
    document.getElementById('briefModalOverlay').style.display = 'none';
  });
  document.getElementById('briefModalOverlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) e.currentTarget.style.display = 'none';
  });
  document.getElementById('briefModalCopy').addEventListener('click', () => {
    const text = document.getElementById('briefModalText').textContent;
    navigator.clipboard.writeText(text).then(() => {
      const btn = document.getElementById('briefModalCopy');
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
    }).catch(() => {});
  });
});
