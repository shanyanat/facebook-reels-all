# CLAUDE.md — Facebook Reels Extension

## What This Extension Does

A Chrome MV3 extension that automates ChatGPT to generate scene images for Facebook Reels projects. It runs as a side panel, reads project data from `http://localhost:7788` (monitor.py), and attaches image files to ChatGPT's compose area via React fiber injection.

## Architecture

### Key files

- **`background.js`** — Service worker. Routes messages from content scripts. Handles `injectFileUpload`, `fillSlate`, `clickGenerateSlate`.
- **`content/chatgpt.js`** — Isolated-world content script on chatgpt.com. Drives the full image phase (A/B/C). Sends messages to background.js.
- **`content/chatgpt_main.js`** — MAIN world content script (loaded at `document_start`). Overrides `HTMLInputElement.prototype.click` — currently harmless (pendingFile is always null).
- **`content/flow.js`** — Content script on labs.google/fx. Drives Google Flow video generation. Selects which scenes still need a video from **disk truth** (`img_on_disk`/`vdo_on_disk`, served by monitor.py), not from contents.json flags — see "Video phase: disk-based selection" below.
- **`sidepanel.html` / `sidepanel.js`** — UI for managing slots and displaying logs.

### How file injection works (injectFileUpload)

**Why the fetch is in the background service worker, not MAIN world:**

ChatGPT enforces a strict `connect-src` Content Security Policy that blocks any `fetch()` to `http://localhost:7788` originating from page JavaScript. `executeScript` with `world: 'MAIN'` runs as page JavaScript and is fully subject to this CSP — any `fetch()` inside it will throw `Failed to fetch`.

**The correct architecture:**

```
chatgpt.js (content script)
  → sendMessage({ action:'injectFileUpload', path:'pages/.../foo.png', filename:'foo.png' })
background.js (service worker — NOT subject to page CSP)
  → fetch('http://localhost:7788/file/pages/.../foo.png')  ← works
  → ArrayBuffer → base64 string (chunked btoa)
  → executeScript({ world:'MAIN', func: syncDecodeAndInject, args:[base64, filename] })
MAIN world (synchronous, no network calls)
  → atob(base64) → Uint8Array → File
  → nativeSetter → input.files = DataTransfer
  → __reactFiber traversal → memoizedProps.onChange(syntheticEvent)
  → return 'fiber:filename:bytesize'
background.js → sendResponse({ ok:true, result:'fiber:filename:bytesize' })
chatgpt.js → log('Attached: fiber:...') → sleep(3s) → continue
```

**Do NOT move fetch() into executeScript MAIN world** — it will be blocked by CSP every time.

### Message listener exclusion guard

`background.js` has a general `handleMessage` async listener. It must exclude `injectFileUpload`, `fillSlate`, and `clickGenerateSlate` — these have dedicated listeners that call `sendResponse` asynchronously. If the general listener also fires, it calls `sendResponse` first and the real response arrives as `undefined`.

The guard is at the top of the general listener:
```js
if (msg.action === 'fillSlate' || msg.action === 'clickGenerateSlate' || msg.action === 'injectFileUpload') return false;
```

**Never remove `injectFileUpload` from this exclusion guard.**

### Windows path separators

`contents.json` on Windows stores paths with backslashes (`pages\page-name\briefs\Character Sheet.png`). Before constructing a URL, always convert:
```js
var safePath = msg.path.replace(/\\/g, '/');
```

### Concurrent slot safety

When multiple slots run in parallel, background.js may fetch from monitor.py simultaneously. Two protections:

1. **monitor.py uses `ThreadingMixIn`** — handles concurrent HTTP requests in separate threads. If `Failed to fetch` errors appear when running 2+ slots, check that monitor.py still has `ThreadingMixIn` on `_SilentHTTPServer`.

2. **background.js retries 3 times** (800 ms apart) before giving up on a fetch.

### Video phase: disk-based selection (false-"Complete" fix, 2026-06-10)

`runVideos()` in `content/flow.js` must decide which scenes still need a video from the **files actually on disk**, never from `contents.json` flags. monitor.py's `/contents.json` adds per-scene `img_on_disk` / `vdo_on_disk` booleans; selection is:

```js
const hasDiskInfo = project.scenes.some(s => s.img_on_disk !== undefined);
const needsVideo  = s => hasDiskInfo ? (s.img_on_disk && !s.vdo_on_disk)
                                     : (s.image_status === 'done' && s.video_status !== 'done'); // fallback: old monitor
const scenes = project.scenes.filter(needsVideo);
```

**Why:** the `image_status`/`video_status` flags can lag the real files when parallel slots race monitor.py's writer (now fixed there by `_data_lock`, but disk-based selection makes flow.js immune regardless). When the flag wrongly said `pending`, the old flag-based filter dropped the scene, the work list went empty, and the phase sent `videosComplete` → the slot showed a false **"✓ Complete"** and the tab closed without generating anything.

Two more guards from the same fix:
- The empty-list check runs **before** `clickNewProject()` / the 20s setup, so an empty list is reported instantly and honestly. If scenes are missing only because their image is absent (`!img_on_disk`), flow.js sends `videosNeedsImages` (slot shows "⚠ … need images — run Images first") instead of "Complete".
- `background.js`'s `videosComplete` handler re-fetches `/contents.json` and only shows "✓ Complete" if every scene is `vdo_on_disk`; otherwise it shows "⚠ N video(s) still missing". This is a backstop behind flow.js's now-correct decision.

To repair reels already drifted by the old race, run `py bot.py reconcile` (dry-run) then `reconcile apply` in the `Facebook Reels to America` project.

## Bugs Fixed (history)

| Bug | Symptom | Root cause | Fix |
|-----|---------|-----------|-----|
| Two character sheets attached | Both uploads sent the same file | `pendingFile` shared state contamination | Pass base64 as executeScript arg — no shared state |
| `res.result = undefined` | Slot log showed `Injected: undefined` | General handleMessage listener stole `sendResponse` before executeScript completed | Added `injectFileUpload` to exclusion guard |
| `Failed to fetch` (CSP) | No files attached at all | MAIN world fetch blocked by ChatGPT's `connect-src` CSP | Moved fetch to background service worker |
| `Failed to fetch` (concurrent slots) | Second slot fails, first succeeds | monitor.py single-threaded HTTPServer couldn't handle simultaneous requests | Added `ThreadingMixIn` to monitor.py + retry logic in background.js |
| False "✓ Complete" — missing clips never made | Re-running a partial reel opened Flow, paused ~20s, then closed the tab showing "Complete" without generating | Parallel slots raced monitor.py's unlocked read-modify-write → a scene's `image_status` flag was lost (reverted to `pending`) while its PNG stayed on disk → flow.js's flag-based selection dropped it → empty work list → `videosComplete` | monitor.py `_data_lock` (serialise writes); flow.js selects by `img_on_disk`/`vdo_on_disk`; honest empty-list + `background.js` disk backstop; `py bot.py reconcile` repairs old drift |

## Deploying to another machine

Copy the **entire `Facebook Reels Extension/` folder** — all files inside. Then in Chrome: `chrome://extensions` → Load unpacked → select the folder → Reload.

Also copy `monitor.py` from `Facebook Reels to America/` to the target machine (must have `ThreadingMixIn` — see that project's CLAUDE.md).

**Never copy** `data/contents.json` or `pages/` from `Facebook Reels to America/` between machines — that causes sync mismatches where the video phase skips generation silently.

## Dependencies

- **monitor.py** must be running (`py monitor.py` from the `Facebook Reels to America` project root) before the extension can fetch any files.
- The extension reads project state from `http://localhost:7788/contents` and files from `http://localhost:7788/file/<path>`.
