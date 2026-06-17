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

### Video phase: rate-limit resilience (2026-06-16)

`runVideos()` in `content/flow.js` treats Google's "unusual activity" throttle as **transient**, separate from real failures. `waitForVideoReady()` returns the string `'ratelimit'` (not `false`) when it sees that text. Rate limits use their own per-project counter `rl_retries_<pid>` — **never** the scene-fail budget (`scene_fails_*`): the scene backs off `RATE_LIMIT_BACKOFF_MS` (60s) and retries the SAME scene up to `RATE_LIMIT_MAX_RETRIES` (5), then stops honestly via a new `videosRateLimited` message (slot shows "⚠ Rate limited — re-run later to finish"). The budget resets on any successful save, on a fresh run, and at phase end. The generation timeout was raised 150→210s so a slow Veo render isn't mis-counted as a failure.

**Why:** a transient throttle used to count toward the 5-fail skip, so after a few throttles the scene was silently dropped — leaving reels stuck at e.g. 3/10 while the slot looked finished. Rate limits must never drop a scene or produce a false complete.

### Background tabs must not be frozen by Memory Saver (2026-06-16)

`background.js` calls `chrome.tabs.update(tab.id, { autoDiscardable: false })` immediately after **every** `chrome.tabs.create` (both the `fillIdleSlots` tab and the `imagesComplete → flow` tab). Chrome's **Memory Saver** freezes/discards inactive background tabs, which stalls their `setTimeout`-driven automation loop — so when running multiple slots, only the visible tab kept progressing and the hidden ones "froze and stopped." `autoDiscardable` is not a `tabs.create` option, so it must be set via `tabs.update` after creation.

Note: this prevents the hard freeze/discard, **not** timer throttling (hidden tabs still run slower, but they complete). Browser-side equivalent the user can also set: `chrome://settings/performance` → Memory Saver off, or add `chatgpt.com` + `flow.google.com` to "always keep active".

### Image poll: stop early when ChatGPT under-delivers (2026-06-16)

`pollForImages()` in `content/chatgpt.js` takes a `noProgressWindow` (default 180s): if no **new** image has appeared for that long, it returns what it has instead of waiting out the full timeout (Phase B's was 3600s). ChatGPT frequently produces fewer images than the 10 asked for in one message; the old long timeout made the tab look **frozen for up to an hour** at `Polling for N images (baseline=X)`. Clicking the tab does not help — nothing more is coming. Side effect: the phase proceeds with however many images arrived; any missing scenes need an Images re-run.

### Flow "Omni" / Agent onboarding panel (some accounts only, 2026-06-17)

Some Google accounts (e.g. an **ULTRA** account) open Flow with a right-side **"Omni" assistant panel** and a compose bar that starts **without "Agent" mode**; both must be handled or the bot keeps attaching media and never reaches generate. `dismissAgentPanel()` in `content/flow.js` (called in `runVideos()` right after the `isRetry`/else setup block, so it covers fresh runs and reload-retries) is **GATED on `agentPanelIsOpen()`** — which detects stable in-panel text (`Omni` / `keyboard shortcuts`). If the panel isn't present it returns immediately, so it is a **complete no-op** on accounts that already look right (the user's primary/backup).

When the panel is present it: (1) closes it via the top-right ✕ (`findAgentPanelCloseButton()` — a visible button in the top-right region with close/✕/×/ปิด/dismiss text or aria), falling back to an Escape keydown; then (2) clicks the exact-text `Agent` button. The Agent click only fires **after** a panel was closed, so it can never toggle Agent mode *off* on an already-correct account. If the ✕ can't be found it logs a dump of visible buttons (text + aria + position) to the side panel so `findAgentPanelCloseButton()` can be refined from a live test.

### Desktop notification when a reel finishes (2026-06-17)

`background.js` shows a Chrome desktop notification when a reel is **fully** done.
`notifyReelFinished()` is called from the `videosComplete` handler **only when the
disk backstop confirms every scene has a video** (`allOnDisk === true`) — so a partial
finish, a rate-limit stop, or a "needs images" result never fires it. This lets the
user leave slots running in background tabs and be told the moment one truly completes.

Requirements/details:
- `manifest.json` must keep the **`"notifications"`** permission.
- The notification icon is `icons/icon128.png` (via `chrome.runtime.getURL`).
- The call is best-effort, wrapped in try/catch — a notification failure can never
  break the pipeline. Only the "reel finished" event notifies (by design); other
  outcomes still show their status in the side panel but do not pop a notification.

### Phase B continuation: get all N images, not whatever ChatGPT delivered (2026-06-17)

ChatGPT almost never returns all `total_scenes` images in a single reply, so the
`pollForImages(total_scenes, …)` in Phase B usually stops early (its 180s
`noProgressWindow`) with fewer images, the run sent `imagesComplete`, and the slot
moved to the video phase with a short reel (e.g. 6/10). `content/chatgpt.js` now adds
a **continuation loop** after the first Phase B download:

1. `getDiskMissingScenes(pid)` asks monitor.py's `/contents.json` which scenes have no
   `img_on_disk` yet (falls back to `image_status` for an old monitor; `[]` on error so
   a transient failure never loops or re-requests present scenes).
2. While scenes are missing (up to `MAX_RETRY_ROUNDS = 4`), it re-asks **in the same chat**
   for ONLY the missing scenes' prompts, in ascending order, then maps each new image to
   its **actual missing scene number** and saves it as `reel_XXXX-scene-NN.png` — the exact
   filename/format monitor.py's `SCENE_IMG_RE` expects. After each round it re-checks disk
   truth, and breaks early if a whole round produced nothing (ChatGPT stuck).

`imagesComplete` still fires at the end even if a few scenes never came (after 4 rounds),
so the pipeline never hangs — but it now tries hard to reach all N first. Do **not** lower
the `noProgressWindow` instead; that early-stop is the freeze fix (see the 1-hour-frozen-tab
row below) — the continuation loop is what recovers the missing images.

### Sidebar count reflects disk, not flags (2026-06-17)

`sidepanel.js` showed the `X/Y` count from contents.json's `image_status` / `video_status`
flags, which a manual file delete does **not** clear — so after deleting a reel's images/
videos the count stayed stale even though the status label (which uses `disk_status`)
updated. New `countDone(scenes, kind)` helper counts from **disk truth**
(`img_on_disk` / `vdo_on_disk`, served by monitor.py), falling back to the flags only for
an old monitor. Used in both the project list and the status/delete table.

## Bugs Fixed (history)

| Bug | Symptom | Root cause | Fix |
|-----|---------|-----------|-----|
| Reel ends with fewer than 10 images | ChatGPT delivered e.g. 6/10, the run "completed" and the video phase made a short reel | ChatGPT caps images per reply; Phase B's `pollForImages` early-stop accepted the partial set and sent `imagesComplete` | Phase B continuation loop: re-ask in-chat for only the disk-missing scenes (≤4 rounds), map each to its correct `scene-NN.png`, verify against disk |
| Sidebar count stale after deleting files | Deleted a reel's images/videos but the `X/Y` count didn't drop | Count read `image_status`/`video_status` flags, which a file delete doesn't clear | `countDone()` counts from disk truth `img_on_disk`/`vdo_on_disk` (flag fallback for old monitor) |
| Two character sheets attached | Both uploads sent the same file | `pendingFile` shared state contamination | Pass base64 as executeScript arg — no shared state |
| `res.result = undefined` | Slot log showed `Injected: undefined` | General handleMessage listener stole `sendResponse` before executeScript completed | Added `injectFileUpload` to exclusion guard |
| `Failed to fetch` (CSP) | No files attached at all | MAIN world fetch blocked by ChatGPT's `connect-src` CSP | Moved fetch to background service worker |
| `Failed to fetch` (concurrent slots) | Second slot fails, first succeeds | monitor.py single-threaded HTTPServer couldn't handle simultaneous requests | Added `ThreadingMixIn` to monitor.py + retry logic in background.js |
| False "✓ Complete" — missing clips never made | Re-running a partial reel opened Flow, paused ~20s, then closed the tab showing "Complete" without generating | Parallel slots raced monitor.py's unlocked read-modify-write → a scene's `image_status` flag was lost (reverted to `pending`) while its PNG stayed on disk → flow.js's flag-based selection dropped it → empty work list → `videosComplete` | monitor.py `_data_lock` (serialise writes); flow.js selects by `img_on_disk`/`vdo_on_disk`; honest empty-list + `background.js` disk backstop; `py bot.py reconcile` repairs old drift |
| Reels stuck at e.g. 3/10, slot looks done | Some scene videos never generated; running again opened Flow then "finished" without making them | Google "unusual activity" throttle counted toward the 5-fail skip → scenes silently dropped | Rate limits use a separate `rl_retries_<pid>` budget, back off + retry same scene, then stop honestly via `videosRateLimited`; gen timeout 150→210s (commit 5a3513b) |
| Parallel slots freeze mid-run | With 3+ slots, only the visible tab kept running; hidden ones froze and stopped | Chrome Memory Saver froze/discarded inactive background tabs | `background.js` sets `autoDiscardable:false` after each `tabs.create` (commit 5df3f7a) |
| One image tab frozen ~1 hour | Stuck at `Polling for N images (baseline=X)`; clicking the tab didn't help | ChatGPT made fewer than 10 images in one message; `pollForImages` waited out the full 3600s timeout | `pollForImages` `noProgressWindow` (180s) early-stop (commit fd83438) |
| Flow needs manual ✕ + "Agent" clicks (some accounts) | On an ULTRA account, every new project opened an "Omni" panel + non-Agent compose; without the two clicks the bot kept attaching media | Google per-account UI rollout the bot didn't handle | `dismissAgentPanel()` in flow.js, gated on the panel being present so it's a no-op elsewhere (commit 19688c5) |

## Deploying to another machine

**Preferred: Git.** The whole workspace (`Facebook Reels All`) is one repo (remote `origin/master`, github.com/shanyanat/facebook-reels-all). To ship a code change: on the source machine `git add` the changed file(s) → `git commit` → `git push`; on the target machine `git pull`. Then in Chrome on the target: `chrome://extensions` → **Reload** the extension so it picks up the new code (a content-script/JS edit needs this reload to take effect). `data/`, `pages/`, `complete/`, and `chrome-bot/` are **gitignored**, so a pull never overwrites a machine's local data/logins.

**Fallback (no Git): copy the folder.** Copy the **entire `Facebook Reels Extension/` folder**, then in Chrome: `chrome://extensions` → Load unpacked → select the folder → Reload. Also copy `monitor.py` from `Facebook Reels to America/` (must have `ThreadingMixIn`).

**Never copy** `data/contents.json` or `pages/` from `Facebook Reels to America/` between machines — that causes sync mismatches where the video phase skips generation silently. (Git already prevents this via `.gitignore`.)

## Dependencies

- **monitor.py** must be running (`py monitor.py` from the `Facebook Reels to America` project root) before the extension can fetch any files.
- The extension reads project state from `http://localhost:7788/contents` and files from `http://localhost:7788/file/<path>`.
