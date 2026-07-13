# CLAUDE.md — Facebook Reels Extension

## What This Extension Does

A Chrome MV3 extension that automates ChatGPT (and optionally Gemini) to generate scene images for Facebook Reels projects. It runs as a side panel, reads project data from `http://localhost:7788` (monitor.py), and attaches image files to ChatGPT's compose area via React fiber injection.

## Image engine: ChatGPT or ChatGPT + Gemini (added 2026-07-13)

An **Images** toggle at the top of the side panel picks who draws the images:

| Engine | Storyboard | 10 scene images + thumbnail | ChatGPT images per reel |
|---|---|---|---|
| `chatgpt` (default) | ChatGPT | ChatGPT | **12** |
| `hybrid` | ChatGPT | **Gemini** (3.1 Pro + Extended) | **1** |

**Why:** 12 images per reel burns the ChatGPT image quota in a few reels and generation then stops for the rest of the window. Gemini's quality is slightly below ChatGPT's but acceptable, and it does not touch the ChatGPT quota. Gemini makes *poor storyboards*, so the storyboard stays on ChatGPT — that is the whole reason this is a hybrid and not a straight swap.

The engine is stored on the existing state object as `reel_gen_state.imageEngine` and defaults to `'chatgpt'`, so state saved before this feature existed keeps the original behaviour. It cannot be changed mid-run (the buttons disable while running).

### Hybrid flow

```
fillIdleSlots (background.js)
  hybrid + no storyboard PNG on disk → phase 'storyboard'     → chatgpt.com
  hybrid + storyboard PNG on disk    → phase 'images-gemini'  → gemini.google.com/app

chatgpt.js  Phase A (storyboard) → 'storyboardComplete'  ─┐
                                                          ├→ background hops the SAME slot
gemini.js   scenes 1..N + thumbnail → 'imagesComplete'   ─┘   to a Gemini tab, then to Flow
flow.js     videos (UNCHANGED)
```

`slot.phase` routing is decided from **disk truth** (`hasStoryboard()` fetches the PNG from monitor.py), not from `project_status`. This matters for the image-redo path: a reel sitting at `videos_in_progress` whose scene PNG the user deleted already has its storyboard, so it goes straight to Gemini and never re-runs Phase A. Conversely, a reel routed to `'storyboard'` gets `resumeFrom: 'pending'` forced, because it only got that phase when the PNG is genuinely absent — a stale `storyboard_done` status must not skip Phase A there.

**Gemini writes the exact same filenames** (`reel_XXXX-scene-NN.png`, `reel_XXXX-thumbnail.png`) to the same `/save_image` endpoint, so `flow.js`, `monitor.py`, `bot.py` and the editor are **completely unchanged** by this feature. That is the design's whole point.

### `content/gemini.js` — what is ported and what is new

DOM mechanics are ported from the proven `Facebook Reels Extension for Multi Analyze/content-gemini.js` (selectors locked live 2026-06-27): composer `.ql-editor[contenteditable="true"]`, model pill `button[aria-label^="Open mode picker"]`, menu rows matched **by text**, upload by synthetic `ClipboardEvent` paste, busy = stop button aria "Stop response". **Do not** key off `[role="progressbar"]` — Gemini keeps one mounted permanently and `isGenerating()` would stick true forever.

#### Setup order: image mode FIRST, then the model (2026-07-13)

Inside the UI turn, `gemini.js` does `activateImageMode()` **before** `ensureProExtended()` — the "+" next to the composer (aria `Upload & tools`) → **Create image**. Same idea as `chatgpt.js`'s `activateImageMode()`: putting Gemini in image-generation mode before choosing the model gives better images.

Both the "+" menu and the mode picker are **Angular overlays that do not render in a background tab**, which is exactly why both run inside the UI turn (the tab is foregrounded for those few seconds).

Two traps, both silent if got wrong:

- **"Upload files" lives in the same "+" menu.** The lookup excludes it (`findItem(CREATE_IMAGE, /upload/i)`), or the bot would open a file dialog instead of enabling image mode.
- **"Create image" is a TOGGLE.** Clicking it when it is already on switches image mode back **off**. `activateImageMode()` is therefore idempotent: it checks `imageModeActive()` (the chip near the composer, looked for *outside* the conversation so an old message mentioning images can't be mistaken for it) and returns immediately when already on.

`generateOne()` re-checks `imageModeActive()` at the start of every turn and re-enables it (taking a UI turn) only if Gemini dropped it after a send — otherwise scenes 2..N would silently fall back to normal chat. When the mode sticks, this is a no-op and costs nothing.

#### `ensureProExtended()` must handle TWO menu layouts (fixed 2026-07-13)

Both **3.1 Pro** *and* **Extended thinking** have to end up selected. There are two layouts in the wild, and assuming the wrong one fails **silently** — Pro gets set, thinking quietly stays on Standard, and every image in the reel is generated at the wrong level with nothing in the output to show it:

- **FLAT** — `3.1 Pro` and `Extended thinking` are both direct items in the mode-picker menu. (What this account shows.)
- **NESTED** — `Extended` sits in a submenu under a `Thinking level` row. (What Multi Analyze was built against.)

The ported code only knew NESTED: it looked for a "Thinking level" row, didn't find one, logged a warning, and gave up. `ensureProExtended()` now tries the flat item first, falls back to the submenu, and **verifies both are checked afterwards** (`verifyModeSelection()`) rather than assuming the clicks landed. It logs `Model check → 3.1 Pro: ON | Extended thinking: ON` every run — if either says `NOT SET`, it dumps the menu so the selector can be re-locked.

Two traps encoded in the code:

- **Selection state comes from `aria-checked`/`aria-selected`, not from text.** The item is literally *named* "Extended thinking", so any `textContent.includes('extended')` check is always true and would wrongly conclude "already on".
- **A `Thinking level` ROW also contains the word "Extended"** once Extended is its current value. So `findItem(/extended/i)` alone can match the row instead of the option — every lookup excludes the row (`findItem(EXTENDED_OPT, THINKING_ROW)`). Never click an already-checked Extended: on a toggle that switches it back **off**.

What is **new** (that script only ever extracted *text*):

- **One scene per message, in ONE chat.** Gemini cannot be asked for 10 images at once. Each scene attaches the **character sheet + storyboard + the previous scene's image (N-1)**; the N-1 chain is what holds the look together. If a scene fails, the chain keeps the last scene that *did* work rather than resetting.
- **Image-based generation wait.** The Multi Analyze script's `waitForTextResponse` / `waitForResponseStable` gate on `text.length > 200`. An image reply has almost no text, so those would spin for the full 30-minute timeout. `waitForGeneratedImage()` instead waits for a new large `<img>`, stable across 3 polls, and bails early once generation has clearly ended with nothing.
- **Attachment detection is scoped OUTSIDE the conversation** (`inChat()` / `CHAT_SCOPE`). The Multi Analyze version counts `blob:` images across the whole page, which is only safe because it sends exactly one message. Here the chat fills with images, and a generated image must never read as an "attachment".

### The one way this engine can silently corrupt a reel — and the four guards

**The trap:** the reference images sit in the composer before send, but the moment you send, Gemini **re-renders them inside the user's turn bubble**, where they look like brand-new `<img>`s that appeared after the baseline. If one of those is captured, monitor.py will happily write **scene N with scene N-1's pixels** and `img_on_disk` will report success. monitor.py's own 409 `_reference_digests` guard cannot catch this: it knows the storyboard and character sheet, but **not** the N-1 scene image this engine attaches.

Four independent guards, all required:

1. `generatedImgs()` **excludes the user turn** (`USER_TURN` selector). This is the load-bearing one.
2. It requires `naturalWidth/Height >= 256` — chips, avatars and icons are small.
3. The src baseline is taken **after attaching references and immediately before `clickSend()`**, so the delta structurally cannot contain them.
4. `saveGeminiImage` in `background.js` **drops any image whose bytes match a reference** we just attached (a client-side twin of the server's 409 guard, extended to cover N-1).

`generatedImgs()` deliberately does **not** require an ancestor response container. ChatGPT renders image output *outside* its role container (see the bug table below) and Gemini may too — requiring one would match nothing. Excluding what is known-wrong is the fail-safe direction.

### `saveGeminiImage` (background.js) — two sources, one exit

- `https://…googleusercontent.com/…` → fetched **in the service worker**, which holds the host permission, so no page CORS applies. This needs `https://*.googleusercontent.com/*` in `host_permissions` — it is **not** covered by the existing `https://*.google.com/*`.
- `blob:` / `data:` → a blob URL is scoped to the **page's** origin and is invisible to the service worker, so `gemini.js` reads those bytes itself and sends base64.

Both are then **re-encoded to a real PNG** (`createImageBitmap` → `OffscreenCanvas` → `convertToBlob`). This is not optional: `/save_image` validates the *filename* and never looks at the body, so a WebP served under a `.png` name would sail through and only blow up later when Flow tries to use it as a first frame.

**Never route Gemini images through `chrome.downloads`** — monitor.py's `DownloadsHandler` watches `~/Downloads` for these exact filenames and would double-write state.

### Gemini throttling gets its own budget

A throttle is **not** a failure. It backs off 60 s and retries the **same scene without consuming an attempt** (max 5 backoffs), then stops honestly with `imagesRateLimited`. This is the same lesson as flow.js's `rl_retries_*`: when a transient Google throttle counted against a fail budget, a few throttles silently dropped scenes and reels sat at 3/10 while the slot looked finished. Re-running the reel in hybrid mode resumes exactly where it stopped, because a scene already on disk is skipped.

### UI-turn lock

Gemini's mode picker is an Angular overlay that **does not render in a background tab**. So `gemini.js` asks background.js for a UI turn (`acquireUi` → `uiGranted` → `releaseUi`), which foregrounds that one tab while it sets 3.1 Pro + Extended (~5 s), then releases. One tab at a time, so tabs never fight for focus; a closed tab frees its turn instantly via `chrome.tabs.onRemoved`. Pastes and generation are background-safe and stay parallel. Do **not** shorten the 10-minute backstop timer — a slow tab is not a dead tab, and releasing it mid-menu re-creates the contention this exists to remove.

### When Gemini's DOM changes

Set `DIAG = 'image'` at the top of `content/gemini.js`, run one reel, and read the side-panel log: `dumpImageDom()` prints every candidate `<img>` (src scheme, dimensions, alt) plus image-ish button labels. It also fires **automatically** whenever a turn ends with no image captured, so the first sign of a selector break is a usable dump rather than a silent failure.

## Architecture

### Key files

- **`background.js`** — Service worker. Routes messages from content scripts. Handles `injectFileUpload`, `fillSlate`, `clickGenerateSlate`, `saveGeminiImage`, and the UI-turn lock.
- **`content/chatgpt.js`** — Isolated-world content script on chatgpt.com. Drives the full image phase (A/B/C). In hybrid mode `stopAfterStoryboard` makes it stop after Phase A and emit `storyboardComplete`. Sends messages to background.js.
- **`content/chatgpt_main.js`** — MAIN world content script (loaded at `document_start`). Overrides `HTMLInputElement.prototype.click` — currently harmless (pendingFile is always null).
- **`content/gemini.js`** — Content script on gemini.google.com. Hybrid engine only: scene images + thumbnail, one scene per message. See the engine section above.
- **`content/flow.js`** — Content script on labs.google/fx. Drives Google Flow video generation. Selects which scenes still need a video from **disk truth** (`img_on_disk`/`vdo_on_disk`, served by monitor.py), not from contents.json flags — see "Video phase: disk-based selection" below.
- **`sidepanel.html` / `sidepanel.js`** — UI for managing slots, the image-engine toggle, and displaying logs.

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

### Attachments: attach FIRST, type SECOND — never a blind sleep (2026-07-13)

**The rule: on both sites, the file is attached and its upload CONFIRMED COMPLETE before the prompt text is typed, and the message is never sent until then.**

The ordering is not cosmetic — it is what makes the completion check possible:

- **ChatGPT** keeps the send button **disabled while an attachment is uploading, but enabled as soon as there is text**. So with an empty composer, "send became enabled" is a genuine upload-complete signal. Type the prompt first and that signal is gone forever. `uploadFileToChatGPT()` therefore waits for (1) the attachment thumbnail to appear (`countAttachmentsNow() > baseline`), then (2) send to be enabled on 3 consecutive polls — and only then returns `true`. It retries the injection up to 3× and **checks `countAttachmentsNow() > baseline` before re-injecting**, because injecting twice is the old "two character sheets attached" bug.
- **Gemini** does the same thing for free: it disables Send while an attachment uploads, which is what `clickSend()`'s wait-for-enabled has always relied on. It now **throws instead of force-clicking** when Send never enables — force-clicking sends a half-uploaded reference, and the scene comes back wrong while looking perfectly successful on disk.

**Why this matters more than it looks.** The old `uploadFileToChatGPT()` returned as soon as `injectFileUpload` reported success and then slept 3 s. But React's `onChange` firing only means the upload **started** — a 2 MB character sheet routinely takes longer than 3 s. `clickSend()` then fired while it was still uploading, so ChatGPT received a **text-only** message. Sometimes it noticed and asked for the sheet (visible, annoying). The dangerous case is when it doesn't: it draws the storyboard with the **wrong character**, all 10 scene images inherit it, Flow renders 10 videos, and the editor produces a finished reel. Nothing anywhere flags it. It was intermittent — a race, not a broken selector — which is exactly why it survived so long.

Consequences that are now enforced:

- **Phase A hard-fails if the character sheet does not attach.** It throws rather than generate a storyboard that would poison the whole reel. This is the one hard stop in the image path, and it is deliberate: it costs a re-run, versus a silently wasted reel of Gemini + Flow generations.
- Phases B and C only **warn** — A/B/C share ONE chat, so the sheet from Phase A is already in context there; the re-attach is belt-and-braces.
- **`gemini.js` never sends a turn with a missing reference.** If any of (character sheet / storyboard / scene N-1) fails to paste, it clears the composer and abandons the turn, and the scene's retry loop tries again. Sending without the N-1 image would produce a valid-looking `scene-NN.png` with the wrong character or a broken look.
- **Every Gemini turn starts from a clean slate** (`clearAttachments()` + `clearComposer()`). An aborted turn can leave chips and text behind, and pasting on top of them double-attaches. Note `clearComposer()` must never use **Escape** — in Gemini, Escape deletes the attachment.

Covered by `upload_test.js`-style checks during development: a 12 s upload now returns at ~14 s (old code returned at ~3 s), a flaky injection retries at most 3×, and a file that never attaches returns `false` instead of proceeding.

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
2. While scenes are missing, it re-asks **in the same chat** for **exactly ONE scene per
   message** and saves the returned image as that scene's `reel_XXXX-scene-NN.png` (the
   exact filename/format monitor.py's `SCENE_IMG_RE` expects). One-at-a-time is deliberate:
   it makes the image→scene mapping **certain by construction**. A multi-image batch mapped
   by position is NOT safe — ChatGPT can skip/reorder within a batch, and `img_on_disk` only
   proves a file exists, not that it holds the right scene (e.g. asking for 7,8,9,10 and
   getting 7,8,10 would save scene 10's image as `scene-09.png`). Each scene gets up to
   `MAX_ATTEMPTS_PER_SCENE = 3` tries; a scene that exhausts them is skipped so the loop
   always terminates.

`imagesComplete` still fires at the end even if a few scenes never came, so the pipeline
never hangs — but it now tries hard to reach all N first. Do **not** lower the
`noProgressWindow` instead; that early-stop is the freeze fix (see the 1-hour-frozen-tab
row below) — the continuation loop is what recovers the missing images.

> The **first** Phase B pass still maps its batch by position (`newUrlsB[i]`→scene `i+1`),
> which is safe only for the typical in-order truncated prefix. The certain path is the
> one-at-a-time retry above; hardening the first pass the same way is a possible later step.

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
| Reel ends with fewer than 10 images | ChatGPT delivered e.g. 6/10, the run "completed" and the video phase made a short reel | ChatGPT caps images per reply; Phase B's `pollForImages` early-stop accepted the partial set and sent `imagesComplete` | Phase B continuation loop: re-ask in-chat for each disk-missing scene **one at a time** (≤3 tries each) so each image maps certainly to its `scene-NN.png`, re-verifying against disk |
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
| Character sheet not attached → whole reel drawn with the WRONG character | Intermittent. Sometimes ChatGPT replies "กรุณาแนบ Character Sheet image ในแชตนี้ก่อน"; worse, sometimes it silently draws a storyboard with a different character and all 10 scenes + videos inherit it | `uploadFileToChatGPT` returned as soon as React's `onChange` fired, then slept 3 s — but that only means the upload **started**. A 2 MB sheet takes longer, so `clickSend()` sent a text-only message. Its verify loop only ran on the *failure* branch | Attach BEFORE typing (empty composer ⇒ send stays disabled until the upload completes ⇒ a real completion signal); wait for thumbnail + send-enabled; retry ≤3× with a no-double-attach guard; **Phase A throws** if the sheet never attaches |
| **(Gemini engine, designed-against not observed)** scene N saved with scene N-1's pixels | A reel would look right per-file (`img_on_disk` true, correct filename) but two scenes are the same image | The N-1 reference is attached in the composer, then **re-rendered inside the user's turn** on send — so it appears as a brand-new `<img>` after the capture baseline. monitor.py's 409 guard knows the storyboard + char sheet but NOT the N-1 scene image | Four guards in `content/gemini.js` + `saveGeminiImage`: exclude the user turn, require ≥256px, baseline after attach / before send, and reject bytes matching an attached reference |

## Deploying to another machine

**Preferred: Git.** The whole workspace (`Facebook Reels All`) is one repo (remote `origin/master`, github.com/shanyanat/facebook-reels-all). To ship a code change: on the source machine `git add` the changed file(s) → `git commit` → `git push`; on the target machine `git pull`. Then in Chrome on the target: `chrome://extensions` → **Reload** the extension so it picks up the new code (a content-script/JS edit needs this reload to take effect). `data/`, `pages/`, `complete/`, and `chrome-bot/` are **gitignored**, so a pull never overwrites a machine's local data/logins.

**Fallback (no Git): copy the folder.** Copy the **entire `Facebook Reels Extension/` folder**, then in Chrome: `chrome://extensions` → Load unpacked → select the folder → Reload. Also copy `monitor.py` from `Facebook Reels to America/` (must have `ThreadingMixIn`).

**Never copy** `data/contents.json` or `pages/` from `Facebook Reels to America/` between machines — that causes sync mismatches where the video phase skips generation silently. (Git already prevents this via `.gitignore`.)

## Dependencies

- **monitor.py** must be running (`py monitor.py` from the `Facebook Reels to America` project root) before the extension can fetch any files.
- The extension reads project state from `http://localhost:7788/contents` and files from `http://localhost:7788/file/<path>`.
