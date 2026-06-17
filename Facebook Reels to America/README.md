# Facebook Reels to America — Automation Pipeline

Turns a `.txt` brief (ChatGPT/Gemini analysis output) into a finished set of AI Reels
files: brief → ChatGPT storyboard + scene images + thumbnail → Google Flow scene
videos → archived for CapCut.

`data/contents.json` is the single source of truth for all project state.

> **Full details live in `CLAUDE.md`** (this folder) and in the Chrome extension's
> own `CLAUDE.md` (the sibling `Facebook Reels Extension/` folder). This README is the
> quick-start; CLAUDE.md is authoritative if the two ever disagree.

---

## How it works

```
You (manual)                 System (automated)
─────────────                ──────────────────
Find a viral video
Analyze it with the
Master Prompt in
ChatGPT / Gemini
Save output as a .txt    →   py bot.py queue  (or monitor.py auto-queues)
Drop .txt into                 → parses prompts, FROZEN into data/contents.json
pages/<page>/briefs/         py bot.py images  → ChatGPT: storyboard + scenes + thumbnail
                             py bot.py videos  → Google Flow: one MP4 per scene
                             py bot.py archive → moves deliverables to ready/<reel>/
                             py bot.py collect → ready/ → complete/<page>/  (for CapCut)
```

There are **two ways** to drive the image/video steps — use one or the other, never both
on the same project at once:

- **Terminal (Playwright):** `py bot.py images` / `py bot.py videos`. Uses a saved Chrome
  profile at `C:/temp/chrome-bot`.
- **Chrome extension:** load the sibling **`Facebook Reels Extension/`** folder as an
  unpacked extension; its side panel drives ChatGPT/Flow and saves files via `monitor.py`.

---

## Setup

### 1. Install dependencies (once per machine)
```
pip install -r requirements.txt
playwright install chromium
```

### 2. (Extension path only) Load the Chrome extension
1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode** (top-right)
3. Click **Load unpacked** → select the sibling **`Facebook Reels Extension/`** folder
   (NOT this project folder — this project has no `extension/` of its own)

### 3. Start the monitor (required for the extension; optional for terminal)
```
py monitor.py
```
Leave it running the whole session. It:
- Watches every `pages/<page>/briefs/` for new `.txt` files (auto-queues them)
- Watches your Downloads folder for generated files
- Serves `contents.json` and files to the extension on `http://localhost:7788`

Restart `monitor.py` after adding a new page folder so it watches the new `briefs/`.

---

## Commands

All commands run from this project root:
```
py bot.py addpage <page-name>     # create pages/<page>/{briefs,ready}/
py bot.py queue                   # scan briefs/ and register new .txt files
py bot.py status                  # show all projects + status (disk-driven)
py bot.py images reel_XXXX        # ChatGPT: storyboard + scene images + thumbnail
py bot.py videos reel_XXXX        # Google Flow: scene videos
py bot.py archive reel_XXXX       # move finished files to ready/<reel>/
py bot.py collect                 # ready/*/ → complete/<page>/  (run after archiving)
py bot.py updateprompts reel_XXXX # re-read the .txt and refresh prompts in contents.json
py bot.py reconcile               # DRY-RUN: list scene flags that don't match disk
py bot.py reconcile apply         # apply the fixes (run only while monitor.py is idle)
```

Prompts are **frozen at queue time** — editing the `.txt` afterwards has no effect.
Run `updateprompts` to sync changes.

---

## File structure

```
pages/<page>/briefs/        ← DROP .txt briefs here (+ character sheet image)
pages/<page>/working/       ← in-progress images/videos (auto-managed)
pages/<page>/ready/<reel>/  ← archived deliverables for a finished reel
complete/<page>/<reel>/     ← collected reels, ready for CapCut
data/contents.json          ← project queue / single source of truth (auto-managed)
data/contents.json.bak      ← rolling backup (auto)
phases/                     ← Playwright automation (image_phase.py, video_phase.py)
bot.py / monitor.py / parse_analysis.py
```

The Chrome extension is **not** in this folder — it lives in the sibling
`Facebook Reels Extension/`.

---

## File naming

| File (in `working/`)              | Description                          |
|-----------------------------------|--------------------------------------|
| `reel_0001-storyboard.png`        | Storyboard image                     |
| `reel_0001-scene-01.png` …        | Scene images (one per scene)         |
| `reel_0001-thumbnail.png`         | Thumbnail (optional)                 |
| `reel_0001-scene-01-vdo.mp4` …    | Scene videos                         |

After `archive`, files land in `ready/reel_0001/` renamed to `storyboard.png`,
`thumbnail.png`, and `scene-01.mp4 … scene-N.mp4`.

---

## Project status values

| Status | Meaning |
|--------|---------|
| `pending` | Queued, no processing started |
| `storyboard_done` | Storyboard image generated |
| `images_done` | All scene images + thumbnail done, ready for video |
| `videos_in_progress` / `videos_partial` | Some videos done |
| `videos_done` / `complete` | All videos done |
| `archived` | Files moved to `ready/`, ready for CapCut |

---

## Troubleshooting

**Extension can't read projects:** make sure `monitor.py` is running (it serves
`http://localhost:7788`).

**ChatGPT / Google Flow buttons not found:** their UIs change often. For the terminal
path, update selectors in `phases/image_phase.py` / `phases/video_phase.py`. For the
extension, update `content/chatgpt.js` / `content/flow.js` in the sibling
`Facebook Reels Extension/` folder.

**Video phase says "No scenes pending" but no MP4s exist:** a flag drifted from disk.
Run `py bot.py reconcile` then `reconcile apply` (while `monitor.py` is idle).

**`contents.json` corrupt (`JSONDecodeError`):** run `py repair_contents.py`, then
`py bot.py status` to confirm. This only happens if data files were copied between
machines — never do that (`data/` and `pages/` are machine-local).

**Multiple character sheets in a page's `briefs/`:** auto-detection picks the first
image file; the extension popup's **Change** button can override it.
