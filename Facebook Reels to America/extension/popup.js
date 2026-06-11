// popup.js — manages UI, project selection, and messaging to background/content scripts

let projects = [];
let selectedId = null;

// ── Logging ──────────────────────────────────────────────────────────────────
function addLog(msg, isErr = false) {
  const log = document.getElementById("log");
  const div = document.createElement("div");
  div.className = "log-entry" + (isErr ? " log-err" : "");
  const ts = new Date().toLocaleTimeString("en-GB", { hour12: false });
  div.textContent = `[${ts}] ${msg}`;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

// ── Project list ─────────────────────────────────────────────────────────────
function badgeClass(status) {
  return "badge badge-" + (status || "pending").replace(/_/g, "_");
}

function renderProjects() {
  const list = document.getElementById("project-list");
  list.innerHTML = "";

  const hdr = document.getElementById("header-status");
  hdr.textContent = `${projects.length} project(s) in queue`;

  projects.forEach(p => {
    const row = document.createElement("div");
    row.className = "project-row" + (p.id === selectedId ? " selected" : "");
    row.dataset.id = p.id;

    const done = p.scenes.filter(s => s.video_status === "done").length;
    const total = p.total_scenes;

    row.innerHTML = `
      <div class="proj-id">
        ${p.id}
        <span class="${badgeClass(p.project_status)}">${p.project_status}</span>
      </div>
      <div class="proj-meta">
        ${total} scenes · ${p.aspect_ratio} · source: ${p.source_txt}
        · videos: ${done}/${total}
        ${p.character_sheet ? "· char: ✓" : "· char: —"}
      </div>`;
    row.addEventListener("click", () => selectProject(p.id));
    list.appendChild(row);
  });

  updateButtons();
}

function selectProject(id) {
  selectedId = id;
  renderProjects();
  const p = projects.find(x => x.id === id);
  if (p) {
    const charName = document.getElementById("char-name");
    charName.textContent = p.character_sheet ? p.character_sheet.split(/[\\/]/).pop() : "none";
  }
}

function updateButtons() {
  const p = projects.find(x => x.id === selectedId);
  const btnImg = document.getElementById("btn-images");
  const btnVid = document.getElementById("btn-videos");

  if (!p) {
    btnImg.disabled = true;
    btnVid.disabled = true;
    return;
  }

  const imgReady = ["pending"].includes(p.project_status);
  const vidReady = ["images_done", "videos_in_progress"].includes(p.project_status);

  btnImg.disabled = !imgReady;
  btnVid.disabled = !vidReady;
}

// ── Load projects from background ────────────────────────────────────────────
function loadProjects() {
  chrome.runtime.sendMessage({ type: "GET_PROJECTS" }, resp => {
    if (resp && resp.projects) {
      projects = resp.projects;
      // Auto-select first non-complete project
      if (!selectedId) {
        const first = projects.find(p => p.project_status !== "complete");
        if (first) selectedId = first.id;
      }
      renderProjects();
    } else {
      addLog("No project data — is monitor.py running and contents.json populated?", true);
    }
  });
}

// ── Button handlers ───────────────────────────────────────────────────────────
document.getElementById("btn-reload").addEventListener("click", () => {
  addLog("Reloading project list…");
  loadProjects();
});

document.getElementById("btn-stop").addEventListener("click", () => {
  addLog("⏹ Stopping all automations…");
  chrome.runtime.sendMessage({ type: "STOP_ALL", projectId: selectedId }, resp => {
    addLog(resp?.msg || "Stopped.");
    loadProjects();
  });
});

document.getElementById("btn-images").addEventListener("click", () => {
  if (!selectedId) return;
  const p = projects.find(x => x.id === selectedId);
  if (!p) return;

  addLog(`Starting image generation for ${selectedId}…`);
  chrome.runtime.sendMessage({ type: "START_IMAGES", project: p }, resp => {
    addLog(resp?.msg || "Image phase started.");
    loadProjects();
  });
});

document.getElementById("btn-videos").addEventListener("click", () => {
  if (!selectedId) return;
  const p = projects.find(x => x.id === selectedId);
  if (!p) return;

  addLog(`Starting video generation for ${selectedId}…`);
  chrome.runtime.sendMessage({ type: "START_VIDEOS", project: p }, resp => {
    addLog(resp?.msg || "Video phase started.");
    loadProjects();
  });
});

// ── Character sheet override ──────────────────────────────────────────────────
document.getElementById("char-input").addEventListener("change", function () {
  if (!this.files || !this.files[0] || !selectedId) return;
  const file = this.files[0];
  // Store character sheet file data in storage for background.js to access
  const reader = new FileReader();
  reader.onload = e => {
    chrome.storage.local.set({ [`char_${selectedId}`]: { name: file.name, dataUrl: e.target.result } });
    document.getElementById("char-name").textContent = file.name;
    addLog(`Character sheet set: ${file.name}`);
  };
  reader.readAsDataURL(file);
});

// ── Background → popup messages (status updates) ─────────────────────────────
chrome.runtime.onMessage.addListener(msg => {
  if (msg.type === "LOG") addLog(msg.text, msg.isErr);
  if (msg.type === "STATUS_CHANGE") loadProjects();
});

// ── Init ─────────────────────────────────────────────────────────────────────
loadProjects();
