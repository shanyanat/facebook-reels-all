# CLAUDE.md — FB Reels Multi Analyze Extension

This file gives Claude Code full context to continue working on this project immediately.

---

## What This Extension Does

A Chrome MV3 side-panel extension that automates generating Facebook Reels content briefs.

**Two modes** (toggle at the top of the Analysis tab; selected via `state.mode`):

- **`multi_page`** (default, original): **1 shared video clip → N page slots**. Each slot is a page folder (auto-detects `Character Sheet.png` inside). One brief per page, written as `Brief-N.txt` into each slot's folder.
- **`multi_clip`** (added): **1 shared page folder + Character Sheet → N video-clip slots**. Each slot is a reference clip with **its own TOPIC, TOTAL SCENES, and ASPECT RATIO** (only CHARACTER stays global, since there's one shared sheet). All briefs land in the single shared folder, named after each clip (`<clip-stem>.txt`, with `-2`/`-3` de-dup within a run). The prompt is built per slot (`buildPrompt({topic, totalScenes, aspectRatio})`) so different clips never collide on the same topic.

Both modes converge on a normalized per-slot **job** (`buildJobs()` in `sidepanel.js`) — `{ videoBase64, videoMime, videoName, charBase64, charMime, charName, useCharSheet, targetDir, filename }` — so `runSlot`, `writeBriefFile`, and `content-chatgpt.js` are mode-agnostic. The content script was **not** changed for multi_clip.

**Flow (multi_page):**
1. User loads a Master Prompt `.txt` file and a reference video clip in the side panel
2. User sets TOPIC, CHARACTER mode, TOTAL SCENES, ASPECT RATIO, base filename
3. User configures N slots — each slot = one page folder (auto-detects `Character Sheet.png` inside)
4. User clicks **Start Analysis (N tabs)**
5. Extension opens N ChatGPT tabs, staggered by a random 8–15s per slot
6. Each tab receives the video + character sheet + filled-in master prompt
7. ChatGPT generates the full brief; extension extracts, trims, validates, and writes `Brief-N.txt` into each slot's folder
8. Tabs are closed automatically when done

**Flow (multi_clip)** is identical except: one folder + Character Sheet is chosen once (shared), each slot holds a different clip **and its own TOPIC/SCENES/RATIO**, and briefs are written into that one folder named after each clip.

---

## File Structure

```
Facebook Reels Extension for Multi Analyze/
├── manifest.json          — MV3 manifest (permissions: sidePanel, tabs, scripting, storage)
├── background.js          — Minimal service worker: wires up side panel on click/install
├── sidepanel.html         — Side panel UI shell
├── sidepanel.css          — Dark theme CSS (design tokens in :root)
├── sidepanel.js           — All state, UI, tab management, file writing
├── content-chatgpt.js     — Content script injected into each ChatGPT tab
├── create_icons.py        — Run once: generates icons/icon{16,32,48,128}.png (pure stdlib)
├── CLAUDE.md              — This file
└── icons/
    ├── icon16.png
    ├── icon32.png
    ├── icon48.png
    └── icon128.png
```

---

## Architecture

### Communication
```
sidepanel.js  ──chrome.tabs.sendMessage──►  content-chatgpt.js
                                                    │
              ◄──chrome.runtime.sendMessage─────────┘
sidepanel.js listens via chrome.runtime.onMessage
```

- **No background relay** — sidepanel talks directly to content scripts via `chrome.tabs.sendMessage`
- `background.js` is intentionally minimal (just side panel wiring); it holds NO state
- MV3 service workers are terminated after ~5–9s of inactivity — never store anything in background memory

### State (sidepanel.js `state` object)
```javascript
{
  masterPromptText, masterPromptName, masterPromptVersion,
  videoFile, videoBase64, videoMime, videoName, videoSizeMB,
  topic, character, totalScenes, aspectRatio, baseFilename,
  slotCount,   // 1–20
  slots: [{    // one per slot
    dirHandle, charFile, charBase64, charMime, charName,
    charPreviewUrl, dirName, tabId, status, progressMsg
  }],
  isRunning,
}
```

### Message Types
| Direction | Type | Payload |
|---|---|---|
| sidepanel → content | `START_SLOT` | slotIndex, videoBase64, videoMime, videoName, charBase64, charMime, charName, promptText, useCharSheet |
| content → sidepanel | `SLOT_PROGRESS` | slotIndex, status, message |
| content → sidepanel | `SLOT_COMPLETE` | slotIndex, text |
| content → sidepanel | `SLOT_ERROR` | slotIndex, error |
| sidepanel → content | `PING` | — |
| content → sidepanel | `{ alive: true }` | (PING response) |

---

## Key Design Decisions & Bug Fixes (history)

### 1. Video sent directly in START_SLOT (not cached in background)
**Why:** Early version tried caching video in background service worker via `STORE_VIDEO`/`GET_VIDEO`. This failed because MV3 service workers restart in <9s of idleness — cache was gone before content scripts retrieved it. Reverted to sending `videoBase64` directly in the `START_SLOT` message.

### 2. Staggered tab starts (random 8–15s per slot)
```javascript
const minMs = slotIndex * 8000;
const maxMs = slotIndex * 15000;
const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
```
**Why:** All tabs racing ChatGPT simultaneously triggered rate limits and Chrome IPC congestion. Slot 0 starts immediately; subsequent slots wait a random duration that grows with slot index. Randomness avoids predictable bot patterns.

### 3. waitForReady() — textarea + 4s sleep only
```javascript
async function waitForReady() {
  await waitFor(getTextarea, 45000);
  await sleep(4000);
}
```
**Why:** Earlier version also waited for `getAttachButton()` to appear. ChatGPT's attach button doesn't match the selectors, so all tabs timed out after 45s. Removed that wait entirely.

### 4. Image upload via clipboard paste (with 3-attempt retry + verification)
```javascript
for (let attempt = 1; attempt <= 3; attempt++) {
  // dispatch ClipboardEvent('paste') on textarea
  // wait up to 7s for countBlobPreviews() to increase
  if (countBlobPreviews() > snapshotBlobs) return true; // confirmed
  // retry on failure
}
// fall through to file-input DataTransfer if all attempts fail
```
**Why:** Background tabs sometimes suppress synthetic paste events. Old code always returned `true` without verifying. Now verifies blob preview count increased; retries 3 times; falls through to file-input as last resort.

### 5. Generation timeout: 1800000ms (30 min), sidepanel outer: 35 min
**Why:** ChatGPT takes 6–10+ minutes to generate a full brief. Original 300s (5 min) cut off 3 of 4 tabs every run.

### 6. waitForTextResponse — extended thinking mode guard
```javascript
if (!isGenerating()) {
  await sleep(5000);
  if (isGenerating()) continue;          // text generation resumed after thinking
  const len = lastAssistantMsg.innerText.length;
  if (len < 200) continue;              // only "Thought for Xm Ys" visible — not done
  return;
}
```
**Why:** ChatGPT reasoning models (o1/o3) have two phases: thinking (stop button visible) → gap → text generation. The gap caused premature "done" detection, extracting only "Thought for 2m 36s". Now requires >200 chars of response content before declaring done.

### 7. waitForResponseStable — prevents extracting partial text
Polls `innerText` length every 1.5s; requires 3 consecutive stable readings at >200 chars. Also re-enters waiting if `isGenerating()` fires again (thinking→text transition). Max wait: 90s before proceeding anyway.

### 8. trimBriefText() — strips ChatGPT wrapper text
```javascript
function trimBriefText(text) {
  // Cut everything before "STORYBOARD PROMPT"
  // Cut everything after the closing ===...=== following "The End of CAPTION & HASHTAGS"
}
```
**Why:** ChatGPT sometimes wraps the brief with intro/outro sentences. Trims to exactly the brief content.

### 9. Slot reset (✕ button)
Completed slots (done/warn/error) show a red ✕ button in the header. Clicking it clears the slot to idle so a new folder can be selected without restarting the whole setup. Hidden while a run is in progress.

---

## Validation

```javascript
const VALID_START        = 'STORYBOARD PROMPT';
const VALID_START_DETAIL = 'Create a single storyboard image only from this information';
const VALID_END          = 'The End of CAPTION & HASHTAGS';
```

- `validateBrief(text)` returns `{ valid, startOk, endOk }`
- If valid: `✅ Saved: Brief-N.txt`
- If invalid: file is saved anyway with `⚠️ Saved with warning: … — review manually`
- If error: slot shows `❌ Error: …`, no file written

---

## Prompt Building

`buildPrompt()` in `sidepanel.js` replaces four fields in the master prompt text using regex:
```javascript
text = text.replace(/^TOPIC\s*:.*$/m,        `TOPIC        : ${state.topic}`);
text = text.replace(/^CHARACTER\s*:.*$/m,    `CHARACTER    : ${characterLabel()}`);
text = text.replace(/^TOTAL SCENES\s*:.*$/m, `TOTAL SCENES : ${state.totalScenes}`);
text = text.replace(/^ASPECT RATIO\s*:.*$/m, `ASPECT RATIO : ${state.aspectRatio}`);
```
The `\s*` handles the padded format used in the real Master Prompt.txt (`TOPIC        : value`).

---

## CSS Design Tokens

```css
--bg: #0a0e1a;  --card: #111827;  --card2: #0f1729;
--border: #1e2d4a;  --border2: #243556;
--accent: #4f8ef7;  --accent2: #7c3aed;
--success: #10b981;  --error: #ef4444;  --warn: #f59e0b;
--text: #e2e8f0;  --text2: #94a3b8;  --muted: #475569;
--radius: 10px;  --radius-sm: 6px;
```

---

## Slot Status Values

| Status | Meaning |
|---|---|
| `idle` | No folder selected |
| `configured` | Folder + char sheet loaded, ready to run |
| `waiting` | Stagger delay or waiting for tab to load |
| `uploading` | Uploading video or character sheet |
| `typing` | Entering master prompt |
| `submitting` | Clicking send |
| `generating` | ChatGPT is generating |
| `extracting` | Waiting for DOM stability / extracting text |
| `done` | Brief saved successfully |
| `warn` | Brief saved but failed validation — review manually |
| `error` | Failed — no file written |

---

## How to Install / Reload

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select: `C:\Claude code\ปรึกษาส่วนตัว\Facebook Reels Extension for Multi Analyze`
5. Click the extension icon in the toolbar → side panel opens on the right

After any code change: go to `chrome://extensions` → click the **refresh icon** on the extension card.

---

## Known Limitations / Remaining Risks

- **Image paste in background tabs** — synthetic `ClipboardEvent` is unreliable in background tabs; mitigated with 3-attempt retry + file-input fallback, but not 100% guaranteed.
- **ChatGPT DOM changes** — selectors for textarea, send button, stop button may break if ChatGPT updates their UI. Key selectors: `#prompt-textarea`, `button[data-testid="send-button"]`, `[data-testid="stop-button"]`, `[data-message-author-role="assistant"]`.
- **ChatGPT rate limiting** — running many tabs simultaneously on one account may trigger throttling. Recommended max: 4–6 simultaneous tabs.
- **Simultaneous extensions** — safe to run alongside other Chrome extensions as long as they don't inject into the same ChatGPT tabs at the same time.

---

## Related Projects

This extension is part of the larger **Facebook Reels to America** pipeline at:
`C:\Claude code\ปรึกษาส่วนตัว\Facebook Reels to America`

The pipeline: `.txt brief` → `py bot.py queue` → `py bot.py images` → `py bot.py videos` → `py bot.py archive` → CapCut editing → Facebook upload.

This extension generates the `.txt briefs` that feed into `py bot.py queue`.
