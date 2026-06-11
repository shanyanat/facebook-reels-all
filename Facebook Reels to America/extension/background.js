// background.js — service worker
// Handles: project data loading, download interception/renaming, phase orchestration

// Open side panel when extension icon is clicked
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

const CONTENTS_PATH_KEY = "contents_path";
let contentsPath = null;

// ── State (in-memory + storage) ───────────────────────────────────────────────
// current_project: project object being processed
// current_phase: "images" | "videos"
// download_state: { phase, project_id, scene_index, expecting }
//   expecting: "storyboard" | "scene_image" | "video"

async function getState() {
  return new Promise(resolve => chrome.storage.local.get(["bot_state", "current_project"], r => resolve(r)));
}

async function setState(patch) {
  return new Promise(resolve => chrome.storage.local.set(patch, resolve));
}

// ── Read contents.json via fetch from local file ─────────────────────────────
// Chrome extensions cannot directly read local files; instead monitor.py serves
// contents.json via a tiny local HTTP server on port 7788, OR we use
// chrome.storage.local as the sync point (populated by monitor.py via a
// file-watch → write to a known path that the extension reads via fetch).
//
// Simplest approach: extension reads from http://localhost:7788/contents.json
// monitor.py starts a lightweight HTTP server on that port.

const API_BASE = "http://localhost:7788";

async function fetchProjects() {
  try {
    const r = await fetch(`${API_BASE}/contents.json`, { cache: "no-store" });
    return await r.json();
  } catch (e) {
    console.warn("Could not fetch projects:", e);
    return null;
  }
}

async function patchProject(projectId, patch) {
  try {
    await fetch(`${API_BASE}/patch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: projectId, ...patch }),
    });
  } catch (e) {
    console.warn("patchProject failed:", e);
  }
}

// ── Download interception ─────────────────────────────────────────────────────
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  chrome.storage.local.get("download_state", ({ download_state: ds }) => {
    if (!ds) { suggest({}); return; }

    const url = item.url || item.finalUrl || "";
    const ref = item.referrer || "";
    const isChatGPT = url.includes("chatgpt.com") || url.includes("oaiusercontent.com")
                   || url.includes("openai.com") || ref.includes("chatgpt.com");
    const isFlow = url.includes("flow.google.com") || ref.includes("flow.google.com");

    if (!isChatGPT && !isFlow) { suggest({}); return; }

    const pid = ds.project_id;
    let filename = null;

    if (ds.expecting === "storyboard" && isChatGPT) {
      filename = `${pid}-storyboard.png`;
      // Move expectation forward
      chrome.storage.local.set({ download_state: { ...ds, expecting: "scene_image", scene_index: 1 } });

    } else if (ds.expecting === "scene_image" && isChatGPT) {
      const n = String(ds.scene_index).padStart(2, "0");
      filename = `${pid}-scene-${n}.png`;
      const next = ds.scene_index + 1;
      if (next <= ds.total_scenes) {
        chrome.storage.local.set({ download_state: { ...ds, scene_index: next } });
      } else {
        chrome.storage.local.set({ download_state: { ...ds, expecting: "done_images" } });
      }

    } else if (ds.expecting === "video" && isFlow) {
      const n = String(ds.scene_index).padStart(2, "0");
      filename = `${pid}-vdo-${n}.mp4`;
      // scene_index advances after video phase handler confirms
    }

    if (filename) {
      suggest({ filename, conflictAction: "uniquify" });
      logToPopup(`Download renamed → ${filename}`);
    } else {
      suggest({});
    }
  });
});

// ── Messaging from popup ──────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "GET_PROJECTS") {
    fetchProjects().then(projects => sendResponse({ projects: projects || [] }));
    return true;
  }

  if (msg.type === "DOWNLOAD_URL") {
    chrome.downloads.download({ url: msg.url, filename: msg.filename, saveAs: false },
      id => sendResponse({ downloadId: id }));
    return true;
  }

  if (msg.type === "START_IMAGES") {
    startImagesPhase(msg.project).then(r => sendResponse(r));
    return true;
  }

  if (msg.type === "START_VIDEOS") {
    startVideosPhase(msg.project).then(r => sendResponse(r));
    return true;
  }

  if (msg.type === "STOP_ALL") {
    stopAll(msg.projectId).then(r => sendResponse(r));
    return true;
  }
});

// ── Image phase orchestration ─────────────────────────────────────────────────
async function startImagesPhase(project) {
  const ds = {
    phase: "images",
    project_id: project.id,
    total_scenes: project.total_scenes,
    expecting: "storyboard",
    scene_index: 1,
  };
  await setState({ download_state: ds, current_project: project });

  // Open ChatGPT in a new tab and inject the automation script
  const tab = await new Promise(resolve =>
    chrome.tabs.create({ url: "https://chatgpt.com/" }, tab => resolve(tab))
  );

  // Wait for page load then send the project data to content script
  await sleep(3000);
  await chrome.tabs.sendMessage(tab.id, {
    type: "RUN_IMAGE_PHASE",
    project,
  });

  return { msg: `Image phase started in tab ${tab.id}` };
}

// ── Video phase orchestration ─────────────────────────────────────────────────
async function startVideosPhase(project) {
  // Find first scene with image_done but video pending
  const pendingScenes = project.scenes.filter(s => s.image_status === "done" && s.video_status === "pending");

  if (pendingScenes.length === 0) {
    return { msg: "No scenes ready for video generation." };
  }

  const ds = {
    phase: "videos",
    project_id: project.id,
    total_scenes: project.total_scenes,
    expecting: "video",
    scene_index: pendingScenes[0].scene_num,
  };
  await setState({ download_state: ds, current_project: project });

  const tab = await new Promise(resolve =>
    chrome.tabs.create({ url: "https://flow.google.com/" }, tab => resolve(tab))
  );

  await sleep(4000);
  await chrome.tabs.sendMessage(tab.id, {
    type: "RUN_VIDEO_PHASE",
    project,
    pending_scenes: pendingScenes,
  });

  return { msg: `Video phase started for ${pendingScenes.length} scene(s) in tab ${tab.id}` };
}

// ── Stop all running automations ─────────────────────────────────────────────
async function stopAll(projectId) {
  // Clear automation state
  await chrome.storage.local.remove(["download_state", "current_project"]);

  // Send STOP to every chatgpt.com and flow.google.com tab
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    const url = tab.url || "";
    if (url.includes("chatgpt.com") || url.includes("flow.google.com")) {
      chrome.tabs.sendMessage(tab.id, { type: "STOP" }).catch(() => {});
    }
  }

  // Reset project status back to pending so Start Images is re-enabled
  if (projectId) {
    await patchProject(projectId, { project_status: "pending" });
  }

  logToPopup("⏹ All automations stopped. Project reset to pending.");
  return { msg: "Stopped." };
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function logToPopup(text, isErr = false) {
  chrome.runtime.sendMessage({ type: "LOG", text, isErr }).catch(() => {});
}
