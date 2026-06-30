# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Does

Automates the full pipeline for producing AI-generated Facebook Reels: a `.txt` brief (containing ChatGPT/Gemini analysis output) is parsed into a project queue, then a Playwright bot automates Chrome to generate scene images and a thumbnail via ChatGPT, then scene videos via Google Flow. Final files are archived and imported into CapCut for editing.

## Common Commands

All commands run from the project root in Warp Terminal:

```
cd "C:\Claude code\ปรึกษาส่วนตัว\Facebook Reels to America"

py bot.py addpage page-<name>       # create folder structure for a new Facebook page
py bot.py queue                     # scan briefs/ and register new .txt files into the queue
py bot.py status                    # show all projects and their current status
py bot.py images reel_XXXX          # automate ChatGPT: storyboard + scene images + thumbnail
py bot.py videos reel_XXXX          # automate Google Flow to generate scene videos
py bot.py archive reel_XXXX         # move finished files to ready/ for CapCut
py bot.py collect                   # move all ready/reel_*/ folders → complete/<page>/ (run after archiving)
py bot.py updateprompts reel_XXXX   # re-read the .txt brief and refresh prompts in contents.json
py bot.py reconcile                 # DRY-RUN: list scene flags that don't match files on disk
py bot.py reconcile apply           # apply the fixes (run only while monitor.py is idle)
```

Install dependencies (once per machine):
```
pip install playwright watchdog
playwright install chromium
```

## Architecture

### Data flow

```
.txt brief (in pages/<page>/briefs/)
    → py bot.py queue
        → parse_analysis.py: parse_txt() extracts all prompts
          (storyboard, scenes, thumbnail — Facebook caption section is ignored)
        → prompts FROZEN into data/contents.json
    → py bot.py images reel_XXXX
        → phases/image_phase.py: Playwright opens Chrome → ChatGPT
        → Phase A: storyboard PNG saved to pages/<page>/working/
        → Phase B: scene PNGs (1 per scene) saved to pages/<page>/working/
        → Phase C: thumbnail PNG saved to pages/<page>/working/
                   (skipped if no THUMBNAIL PROMPT in brief)
    → py bot.py videos reel_XXXX
        → phases/video_phase.py: Playwright opens Chrome → Google Flow
        → scene MP4s saved to pages/<page>/working/
    → py bot.py archive reel_XXXX
        → brief .txt  moved to pages/<page>/ready/reel_XXXX/
        → storyboard.png moved to pages/<page>/ready/reel_XXXX/
        → thumbnail.png moved to pages/<page>/ready/reel_XXXX/  (if it exists)
        → scene-NN.mp4 clips moved to pages/<page>/ready/reel_XXXX/
        → remaining scene PNGs in working/ deleted
```

### Key files

- **`bot.py`** — CLI entry point. Routes commands to `parse_analysis.py` or `phases/*.py`. Also contains `do_archive()`, `do_queue()`, `do_addpage()`, `do_reconcile()`, and `show_status()`.
- **`parse_analysis.py`** — all `contents.json` logic: `parse_txt()`, `add_project()`, `update_project_prompts()`, `load_contents()`, `save_contents()`.
- **`phases/image_phase.py`** — Playwright automation for ChatGPT. Phase A = storyboard (Thinking: Extended), Phase B = all scene images (Thinking: Standard), Phase C = thumbnail (Thinking: Extended, fresh chat, character sheet attached).
- **`phases/video_phase.py`** — Playwright automation for Google Flow. Uploads each scene image, pastes video prompt, configures Veo 3.1 Lite / 9:16 / Lower Priority, downloads MP4.
- **`data/contents.json`** — single source of truth for all project state. Never edit by hand.
- **`data/contents.json.bak`** — auto-generated rolling backup of the last known-good `contents.json`. Written by `save_contents()` before each save. `load_contents()` falls back to this automatically if `contents.json` is ever corrupt. **Machine-specific — never copy between machines** (same rule as `contents.json`).
- **`data/contents.json.lock`** — temporary lock file created during a save and deleted immediately after. A best-effort guard so two writers don't run at once. Auto-cleared if stale (>30s). Never copy it between machines; if it's ever left behind by a crash, it self-clears on the next save.
- **`monitor.py`** — optional. Watches `briefs/` for new `.txt` files (auto-queues) and serves files on `http://localhost:7788` for the Chrome extension. Uses `ThreadingMixIn` (added 2026-05-28) so concurrent requests from multiple extension slots are handled in parallel — do not remove this or parallel slots will get `Failed to fetch` errors. All `contents.json` writes in this process are serialised by a single re-entrant lock `_data_lock` (added 2026-06-10) — see "monitor.py serialises all writes" below. Its `/contents.json` response also adds per-scene `img_on_disk` / `vdo_on_disk` booleans (via `_annotate_scenes_disk()`) that the extension's video phase selects work from. **On startup it runs `_startup_prune()` (added 2026-06-30)** — a one-shot `do_prune(apply=True)` executed *before* the HTTP server starts (the only moment prune is race-free, since no extension is polling yet). This keeps `contents.json` small so `/contents.json` polls stay fast: that handler re-reads the whole file and disk-stats every project on every 4 s poll, so a bloated file (hundreds of finished reels) is what causes the extension's intermittent "monitor.py not reachable" stalls. Gated by `REELS_AUTO_PRUNE` (default on; set `=0` to skip). See the `do_prune` note below — it now also treats posted `complete/<page>/<reel>.-/` folders as collected, so posted reels stop accumulating in the live file.

### .txt brief format

A brief contains these sections, parsed by `section_pattern` in `parse_txt()`:

| Section header | Used by | Notes |
|---|---|---|
| `STORYBOARD PROMPT` | Phase A | Required |
| `SCENE N IMAGE PROMPT` | Phase B | One per scene |
| `SCENE N VIDEO PROMPT` | video_phase | One per scene |
| `THUMBNAIL PROMPT` | Phase C | Optional — skipped if absent |
| Facebook caption section | — | **Ignored entirely** — not in section_pattern, for manual use only |

Each section ends with a marker like `The End of STORYBOARD PROMPTS` (or singular `PROMPT`) which `_cut_at_end_marker()` strips before sending to AI.

### Critical architectural details

**`save_contents()` is crash-safe and concurrency-safe (hardened 2026-06-05).** It can never write broken JSON to `contents.json`, regardless of cause (power loss, disk error, or two writers at once). It works in layers: (1) writes to a **unique** temp file per process via `tempfile.mkstemp` — so concurrent writers can't garble a shared temp file; (2) `fsync` forces data to disk; (3) re-reads and **validates the temp file is parseable JSON before** the swap; (4) copies the current good file to `contents.json.bak` first; (5) does an atomic `replace()` with retry on Windows `PermissionError`. A best-effort lock (`contents.json.lock`) reduces concurrent writes but failing to get it is non-fatal — the unique temp file already prevents corruption. `load_contents()` auto-recovers from `contents.json.bak` if the main file is corrupt, and raises a clear `RuntimeError` only if **both** are unreadable. All of this lives in `parse_analysis.py` and uses only the Python standard library, so copying that one file to a backup machine protects it fully. **Background:** the original `save_contents()` shared one temp filename across all writers; two simultaneous writes (e.g. `monitor.py`'s `ThreadingMixIn` threads, or a background `monitor.py` plus a foreground `bot.py` command) interleaved into the shared temp file and corrupted `contents.json`. Do not revert to a single shared temp filename.

**`monitor.py` serialises all `contents.json` writes under `_data_lock` (added 2026-06-10).** `save_contents()` (above) prevents *corruption*, but it does not prevent *lost updates*: its file-lock only covers the write, not the surrounding read-modify-write. Because the HTTP server is threaded and the extension runs 2–5 parallel slots, two `/save_image` or `/save_video` requests could load the same snapshot and the last save would silently erase the other's flag change — the PNG/MP4 file (written first by `write_bytes`) survived on disk, but its `image_status` / `video_status` reverted to `pending`. That drift then made the extension's video phase skip the scene and report a false "Complete". The fix is a single module-level **re-entrant** lock `_data_lock = threading.RLock()` that wraps every read-modify-write in `monitor.py`: `update_project`, `update_scene`, the compound "set scene done → check all done → set project status" blocks in `/save_image` and `/save_video`, the same blocks in the `DownloadsHandler` watcher, and `_bot_call` / `_handle_api_delete`. It is re-entrant so a handler holding the lock can still call `update_scene`. Do **not** reintroduce a second separate lock (e.g. the old `_bot_lock`) — use the one `_data_lock` everywhere to avoid deadlock. `parse_analysis.save_contents()` is unchanged and complementary (it still guards corruption and the rare cross-process case). Proven by `tests/test_concurrent_save.py`.

**Completed reels stop in `working/` for manual review by default (changed 2026-06-30).** When the extension finishes all videos for a reel, `monitor.py` sets `project_status="complete"` but **no longer auto-archives**. `_start_auto_advance()` is now opt-in: it only runs the old archive→collect→caption chain when `REELS_AUTO_ADVANCE=1` is set in the environment; otherwise it logs and returns, leaving every file in `pages/<page>/working/` so the user can inspect each image/video and regenerate a distorted scene before approving. Approval is the extension's per-reel **Archive** button (`/api/archive`) followed by the **Collect** button (`/api/collect`); `editor_queue.py` then auto-edits + captions whatever lands in `complete/`. For this gate to be visible, `_disk_status_for()` is **purely disk-driven first** — a complete-but-unarchived reel (clips still in `working/`) reports `videos_done` (so the Archive button shows and it stays selectable for a redo), and only reports `collected` when nothing remains in `working/` or `ready/` *and* `project_status=="complete"`. **Redo path:** delete a bad scene's file(s) in `working/` → reel drops to `videos_in_progress` (selectable) → re-run regenerates only that scene. **Video-only redo:** delete `{pid}-scene-NN-vdo.mp4` (keep the PNG) → routes to the video phase, `flow.js` selects `img_on_disk && !vdo_on_disk`. **Image redo:** delete BOTH `{pid}-scene-NN.png` and its `-vdo.mp4` → the extension's `background.js` `fillIdleSlots()` routes the reel to the IMAGE phase whenever any scene has `img_on_disk === false` (the `anyImageMissing` check, added 2026-06-30) even though its status says videos. `tabReady` normalizes `resumeFrom` to `storyboard_done` for any past-storyboard status so `chatgpt.js` skips Phase A (storyboard not re-made). Note: `chatgpt.js` Phase B regenerates ALL scene images in one batch (not just the deleted one) — but `imagesComplete` then auto-continues to the video phase, and `flow.js` only remakes videos where `img_on_disk && !vdo_on_disk`, i.e. just the scene whose vdo you deleted. So the other scenes' existing videos (the actual deliverables) are untouched and only the redone scene changes in the final reel; the rewritten PNGs are deleted at archive anyway. Deleting only the PNG leaves the reel at `videos_done` (the old clip still counts a scene as imaged) — delete both. Do not reintroduce an early `project_status=="complete"` short-circuit in `_disk_status_for()` — it would relabel the review gate as `collected` and hide the reel before it can be approved.

**Disk truth, not flags, drives video selection — and `reconcile` repairs old drift.** `/contents.json` is enriched per-scene with `img_on_disk` / `vdo_on_disk` (`_annotate_scenes_disk()` in `monitor.py`). The extension's `content/flow.js` selects scenes needing video as `img_on_disk && !vdo_on_disk` (falling back to flags only if those fields are absent, i.e. an older monitor), so a stale flag can never again cause an empty work list or a false "Complete". To fix existing drift in `contents.json`, run `py bot.py reconcile` (dry-run — lists every scene whose flag doesn't match a file on disk) then `py bot.py reconcile apply`. `do_reconcile()` is **upgrade-only** (sets `pending → done` where the file exists; never downgrades) and leaves `project_status` untouched (disk-driven status already handles display). **Run `reconcile apply` only while `monitor.py` is idle** — it is a separate process and the cross-process file-lock is best-effort, so applying it mid-save could collide.

**Prompts are frozen at queue time.** When `py bot.py queue` runs, `parse_txt()` extracts all prompts from the `.txt` file and writes them into `contents.json`. Editing the `.txt` file afterwards has no effect — both `images` and `videos` phases read from `contents.json`, not the file. Use `py bot.py updateprompts reel_XXXX` to sync changes. `updateprompts` refreshes storyboard, thumbnail, and all scene prompts.

**Shared Chrome profile.** Both `image_phase.py` and `video_phase.py` use the same persistent Chrome profile at `C:/temp/chrome-bot` (the `CHROME_PROFILE` constant in each phase). Never run `images` and `videos` simultaneously — they will conflict. Run each in a separate Terminal window sequentially.

**Switching the account the terminal bot uses.** There is no login command — the bot logs into whatever account is saved in the `C:/temp/chrome-bot` profile, and `ensure_logged_in_*()` already pauses up to 5 minutes for a manual login if it detects a logged-out state. To switch the ChatGPT/Google account: either (a) **delete or rename `C:/temp/chrome-bot`** then re-run `py bot.py images` — a fresh logged-out Chrome opens and waits for you to log in with the new email (cleanest; avoids Google's "default account" stickiness); or (b) in the automated Chrome window, log out and log back in with the new email. This applies only to the terminal/Playwright path — the Chrome **extension** instead uses whatever account is signed into the normal Chrome it is loaded in.

**Phase C (thumbnail) continues in the same chat as Phases A and B.** All 10 scene images are already in context, so the thumbnail is generated with full awareness of the visual style. It attaches the character sheet and uses Thinking: Extended. Phase C is skipped automatically if: the brief has no `thumbnail_prompt`, the project is already past the image phase (`videos_in_progress` / `complete`), or `{pid}-thumbnail.png` already exists on disk.

**Phase B no longer exits early.** Previously, if Phase B was already done, `image_phase.py` returned immediately. Now it skips Phase B and continues to Phase C, so re-running `py bot.py images reel_XXXX` on an `images_done` project will generate the thumbnail if it is missing.

**Scene selection is disk-based, not status-based.** The `videos` phase selects scenes to process by checking whether the `-vdo.mp4` file exists on disk (`_vdo_missing()`), not by reading `video_status` in `contents.json`. This means re-running `py bot.py videos reel_XXXX` after a crash automatically resumes from where it stopped.

**End-marker stripping.** All phases call `_cut_at_end_marker()` before sending prompts to AI tools. The regex uses `prompts?` (optional S) so it handles both `The End of THUMBNAIL PROMPT` (singular, used by thumbnail section) and `The End of X PROMPTS` (plural, used by all other sections).

**Thumbnail is never deleted by archive.** `do_archive()` moves `{pid}-thumbnail.png` → `ready/{pid}/thumbnail.png` before the cleanup step that deletes remaining `{pid}-*` files. Scene PNGs are deleted; thumbnail is kept as a deliverable alongside the videos.

**`show_status()` is disk-driven.** It builds the status table by scanning the `pages/` folder on disk. If a project shows `(brief renamed?)`, the `.txt` file recorded in `contents.json["source_txt"]` is missing from both `briefs/` and `ready/` — restore the file with its exact original filename.

**`_vdo_missing()` requires `image_status == "done"` in contents.json.** The terminal `video_phase.py` only queues a scene if both conditions are true: the `-vdo.mp4` file is missing on disk AND `image_status` is `"done"` in contents.json. If `image_status` is not `"done"` while the scene's PNG exists on disk (from a cross-machine copy, or from the lost-update drift fixed in `monitor.py`), the video phase prints "No scenes pending" even though no MP4 files exist. **Fix: run `py bot.py reconcile` then `reconcile apply`** to set `image_status="done"` from the files on disk — much lighter than the old advice of deleting `working/` and regenerating. (The extension's `flow.js` no longer has this problem at all; it selects from `img_on_disk`/`vdo_on_disk`.)

**`py bot.py collect`** moves all `pages/*/ready/reel_*/` folders into `complete/<page>/reel_*/` and deletes the now-empty `ready/` directories. This is intentional — `do_archive()` recreates `ready/` automatically (`mkdir(parents=True, exist_ok=True)`) when archiving future projects.

**Never copy `data/contents.json` or `pages/` between machines.** Each machine's contents.json is built by running the bot locally. Copying it from another machine causes sync mismatches where `image_status` in contents.json doesn't match the actual files on disk. If a sync mismatch occurs: delete the affected project's `working/` folder and re-run all phases from scratch.

### Recovering a corrupt contents.json

If `py bot.py status` (or any command) crashes with a `json.decoder.JSONDecodeError` such as `Extra data: line N column 1`, the `contents.json` is corrupt **and** `contents.json.bak` could not auto-recover it (both unreadable). This is almost always caused by copying `data/contents.json` between machines or copying the folder while the bot was mid-save — never let that happen (see the rule above).

Fix it with the bundled stdlib-only repair tool (works on any machine, no Claude Code needed):

```
py repair_contents.py
```

`repair_contents.py` (in the project root) tries, in order: (1) salvage the first complete JSON array from the corrupt file — this is lossless for the common `Extra data` case, which is one valid array with duplicate text appended; (2) fall back to a valid `contents.json.bak`. It always saves the corrupt file as `data/contents.json.corrupt-<timestamp>` first, so nothing is lost. It only uses the standard library, so copying that one file to a backup machine is enough. After it runs, confirm with `py bot.py status`.

This corruption does **not** recur on a machine that builds its own data locally — `save_contents()` is atomic, fsync'd, validated-before-swap, and backed up. The only way to reintroduce it is to copy data files between machines again.

### Project status values

| Status | Meaning |
|--------|---------|
| `pending` | Queued, no processing started |
| `storyboard_done` | Storyboard image generated |
| `images_done` | All scene images + thumbnail done, ready for video |
| `videos_in_progress` / `videos_partial` | Some videos done |
| `videos_done` / `complete` | All videos done |
| `archived` | Files moved to `ready/`, ready for CapCut |

### Archive output (ready/reel_XXXX/)

| File | Source |
|---|---|
| `<brief>.txt` | brief from `briefs/` |
| `storyboard.png` | Phase A output |
| `thumbnail.png` | Phase C output (only if generated) |
| `scene-01.mp4` … `scene-N.mp4` | video_phase output |
