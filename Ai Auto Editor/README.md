# AI Auto Editor

Auto-cuts AI-generated scene clips down to only the parts that match each scene's
brief, joins them in order, and lays your background music underneath — fully
automatic, no manual marking.

```
input/ (10 clips) + briefs.csv  ─►  Gemini Flash picks the keep-seconds
                                ─►  FFmpeg cuts + normalizes + joins + music
                                ─►  output/final_<timestamp>.mp4
```

**Cost:** Gemini Flash is the only running cost (~one cheap call per clip). All
cutting/joining/music is local FFmpeg = free. Re-runs reuse `cache/` and call no API.

## One-time setup
1. Install [FFmpeg](https://www.gyan.dev/ffmpeg/builds/) (already on this PC) — `ffmpeg` and `ffprobe` must be on PATH.
2. Install Python deps:
   ```
   py -m pip install -r requirements.txt
   ```
3. Get a free Gemini key at https://aistudio.google.com/apikey, then copy
   `.env.example` to `.env` and paste it into `GEMINI_API_KEY`.

## Way A — point at a reel folder (recommended)
Your reel folders already look like this:
```
reel_0110\
  scene-01.mp4 ... scene-10.mp4
  <something>.txt          (contains "Action :" lines per scene)
  storyboard.png, thumbnail.png   (ignored)
```
You do **not** move or rename anything. Just run:
```
py main.py --folder "C:\...\reel_0110" --dry-run    # check the briefs + cuts first
py main.py --folder "C:\...\reel_0110"              # render
```
- Reads whatever `scene-NN.mp4` clips exist — **missing scenes are fine** (e.g. 1–5, 7–10).
  Each clip is matched to its brief by **scene number** (so `scene-07.mp4` always gets the
  7th `Action :` line even if scene 6 has no clip).
- Reads the `.txt` and uses each scene's **`Action :`** line as its brief (looks under a
  `VIDEO PROMPT` heading if present, else from the top).
- Speeds the footage up (default **1.4×**), keeps only the tight action per scene,
  **mutes the clips' own audio** (so AI music never clashes), lays your background music under,
  and burns a small faded **page-name watermark** (from the `*-page-*` folder) centre-bottom.
- Caches detections in `reel_0110\.aiedit_cache\` so each reel is independent and re-runs are free.
- Writes the result as **`EDITED_reel_0110.mp4`** inside that same folder.
- Music: a track inside the reel folder is used if present, otherwise the global `music/`.
- To override a scene's brief, drop a `briefs.csv` (columns `scene,brief`) into the reel folder — it wins over the `.txt`.

## Batch — many reels at once
Point at the **page folder** (the one holding many `reel_XXXX` sub-folders):
```
py main.py --batch "C:\...\complete\1-page-Strange-Frontiers"
```
- Processes every sub-folder that contains `scene-NN` clips.
- **Skips a reel** when it is fully finished (has `EDITED_*.mp4` AND every scene was AI-trimmed),
  OR when it is explicitly marked done — the folder is named `done`, or it contains a file
  named `done` (e.g. `done.mp4`, `done.txt`). A `done` marker is skipped even with `--force`.
- Reels where AI failed on a scene are **redone** automatically on the next run.
- **Just re-run the same command** (no `--force`) to process only what's left.

## Way B — local input/ folder
1. Put clips in `input/` named in scene order (`scene01.mp4`, …).
2. Fill `briefs.csv` (columns `scene,brief`).
3. Put one track in `music/`.
4. `py main.py --dry-run` then `py main.py` → `output/final_<timestamp>.mp4`. Or double-click **`RUN.bat`**.

## Tuning — `config.json`
| Key | Meaning |
|---|---|
| `target_width/height`, `fps` | Output format. All clips are fitted to this. `1080x1920@30` = vertical. |
| `fit` | `pad` (letterbox, no content lost) or `crop` (fill, edges trimmed). |
| `speed_factor` | Speed-up applied to all footage (default `1.4`; use 1.3–1.45). `1.0` = no change. |
| `source_audio_volume_normal` | Volume of a clip's own audio when it is normal action/ambient sound (default `1.0` = kept). |
| `source_audio_volume_music` | Volume for clips Gemini flags as containing background **music** (default `0.0` = silenced, so AI music never clashes with your track). |
| `retry_until_success` | `true` (default): keep retrying a rate-limited scene until it succeeds, so no scene is left un-trimmed. Bounded by `max_retry_minutes`. |
| `max_retry_minutes` | Safety cap (default `20`) so a real Google outage can't hang forever. |
| `max_retries` / `retry_base_delay_sec` / `request_delay_sec` | Used when `retry_until_success` is false; base backoff and spacing between clips. |
| `music_volume` | Background level under the video (0.18 ≈ quiet). |
| `music_fade_out_sec` | Fade music out at the end. |
| `join_crossfade_sec` | `0` = hard cuts. `>0` = short crossfade between segments (smoother joins). |
| `max_seconds_per_scene` | Hard cap on kept time per scene (default `4.0`). Lower = more concise. |
| `watermark_enabled` | Turn the page-name watermark on/off. |
| `watermark_text` | Force a specific watermark. Empty = auto from the `*-page-*` folder name. |
| `watermark_opacity` / `watermark_fontsize_ratio` | Faded white level (0.3) and size (× video height). |
| `watermark_bottom_ratio` | How far up from the bottom the text sits, as a fraction of height (default `0.20` = 20% up). Lower = nearer the bottom. |
| `watermark_fontfile` | Font used. Defaults to the bundled **Lato** (SIL Open Font License — free for commercial use) in `assets/fonts/`; falls back to Arial if missing. |
| `padding_seconds` | Tradeoff dial. Higher = safer against *clipping* the wanted action, but risks *re-including* unwanted action right next to it (e.g. the lift just before the put-down). Start at 0.2; raise if cuts feel tight, lower if neighbouring action leaks in. |
| `analysis_fps` | How finely Gemini samples the video. Higher = tighter cuts, more cost. |
| `confidence_threshold` | Below this, the whole clip is kept (safe fallback). |
| `model` | Gemini model id. |

## Rate limits (important)
The Gemini **free tier is ~20 requests/day** for `gemini-2.5-flash`. One reel = 10 requests,
so the free tier only covers ~2 reels/day, and bursts trigger `429` errors. The tool **keeps retrying a rate-limited scene until it succeeds** (waiting the time the server
asks for, up to `max_retry_minutes`), **spaces out requests**, and **does not cache failures** —
so within a run no scene is left un-trimmed, and anything still unfinished is retried next run. For real volume,
enable **pay-as-you-go billing** on your Google AI Studio project (gemini-2.5-flash is very
cheap per clip); the daily cap and most 429s then disappear.

## How detection behaves
Gemini samples video at a few frames per second, so timecodes for **subtle** motion
are approximate (±~0.5–1s). The tool pads and merges ranges and, if it's unsure,
**keeps the whole clip** rather than risk an empty scene. To override one clip,
edit its `cache/<scene>.json` by hand and re-run (without `--force`).

## Files
- `main.py` — orchestrator (`--dry-run`, `--force`).
- `detect.py` — Gemini Flash → validated keep-ranges, cached to `cache/`.
- `edit.py` — FFmpeg cut → normalize → concat (or crossfade) → music → render.
- `common.py` — config, paths, ffprobe/ffmpeg helpers.
