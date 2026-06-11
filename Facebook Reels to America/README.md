# Facebook Reels to America — Automation Pipeline

Automates the full content creation pipeline: analysis `.txt` file → ChatGPT storyboard + scene images → Google Flow scene videos.

---

## How It Works

```
You (manual)              System (automated)
─────────────             ──────────────────
Find viral video
Analyze with Master
Prompt in ChatGPT/
Gemini
Save output as .txt  →  monitor.py parses .txt → adds project to queue
Drop .txt into            Extension reads queue → automates ChatGPT images
data/analysis/            Extension reads queue → automates Google Flow videos
                          monitor.py organizes files → updates status
                          Videos land in output/[project_id]/
```

---

## Setup

### 1. Install Python dependencies
```
pip install -r requirements.txt
```

### 2. Load the Chrome Extension
1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** → select the `extension/` folder

### 3. Start the monitor
Open a terminal in the project folder and run:
```
python monitor.py
```
Leave this running the whole session. It:
- Watches `data/analysis/` for new `.txt` files
- Watches your Downloads folder for generated files
- Serves `contents.json` to the extension on `http://localhost:7788`

---

## Usage

### Step 1 — Analyze a viral video (manual)
1. Open ChatGPT or Gemini
2. Attach the viral video + your Character Sheet (if any)
3. Paste the **Master Prompt** (fill in the 4 fields at the top)
4. Get the full analysis output (4 sections)
5. Copy the entire output → save as a `.txt` file

### Step 2 — Queue the project
Drop the `.txt` file into `data/analysis/`.

`monitor.py` will:
- Detect the file
- Parse it into `data/contents.json`
- Move the file to `data/analysis/processed/`

### Step 3 — Generate images (ChatGPT)
1. Log into `chatgpt.com` in Chrome
2. Click the extension icon → confirm the project appears with status `pending`
3. (Optional) Upload a Character Sheet: click **Change** next to "Character Sheet"
4. Select the project → click **▶ Start Images (ChatGPT)**

The bot will:
- Open ChatGPT in a new tab
- Set up image mode (9:16, Thinking Extended)
- Generate the storyboard → auto-download → rename to `reel_NNNN-storyboard.png`
- Generate all scene images → auto-download → rename to `reel_NNNN-scene-01.png` … `scene-10.png`
- `monitor.py` moves files to `pending/` and updates status → `images_done`

### Step 4 — Generate videos (Google Flow)
1. Log into `flow.google.com` in Chrome
2. Click the extension icon → project should show status `images_done`
3. Click **▶ Start Videos (Flow)**

The bot will loop through all scenes:
- Open a new Flow project
- Upload the scene image
- Set video settings (9:16, Veo 3.1 Lite, Lower Priority)
- Paste the VIDEO PROMPT → Generate
- Wait for completion → auto-download → rename to `reel_NNNN-vdo-01.mp4`
- `monitor.py` moves to `output/reel_NNNN/` and updates status
- 60-second pause between scenes

### Step 5 — Edit in CapCut
All scene videos are in `output/reel_NNNN/`. Import them into CapCut for final assembly.

---

## File Structure

```
data/analysis/          ← DROP .txt files here
data/analysis/processed/  ← processed .txt files move here
data/contents.json      ← project queue (auto-managed)
input/character_sheets/ ← place character sheet images here
pending/                ← downloaded images staging area
pending/processed/      ← source files after successful processing
output/reel_NNNN/       ← final scene .mp4 videos
extension/              ← Chrome extension source
```

## File Naming

| File | Description |
|------|-------------|
| `reel_0001-storyboard.png` | Storyboard grid image |
| `reel_0001-scene-01.png` … | Individual scene images |
| `reel_0001-vdo-01.mp4` … | Final scene videos ready for CapCut |

---

## Project Status Values

| Status | Meaning |
|--------|---------|
| `pending` | Queued, no images yet |
| `storyboard_done` | Storyboard downloaded |
| `images_done` | All scene images downloaded, ready for video |
| `videos_in_progress` | Videos generating (some done) |
| `complete` | All scene videos in `output/` folder |
| `error` | Something failed — check the extension log |

---

## Troubleshooting

**Extension can't read projects:** Make sure `monitor.py` is running (it serves `http://localhost:7788`).

**ChatGPT buttons not found:** ChatGPT's UI changes often. If the bot gets stuck, open DevTools Console on chatgpt.com, inspect the button you need, and update the selector in `extension/content_chatgpt.js`.

**Google Flow buttons not found:** Same approach — inspect and update selectors in `extension/content_flow.js`.

**Files not renamed correctly:** Check that `monitor.py` is running and the download filenames from the extension match the pattern `reel_NNNN-scene-NN.png` / `reel_NNNN-vdo-NN.mp4`.

**Multiple character sheets in `input/character_sheets/`:** The auto-detection picks the only file if there's one, or one whose name matches the project ID. For others, use the **Change** button in the extension popup to select the correct file.
