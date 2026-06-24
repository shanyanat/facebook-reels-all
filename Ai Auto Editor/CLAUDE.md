# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**AI Auto Editor** — auto-cuts AI-generated scene clips to only the parts matching each
scene's brief, joins them, and adds ducked background music. Fully automatic.

Pipeline: `input/*.mp4` + `briefs.csv` → **Gemini Flash** picks keep-seconds → **FFmpeg**
cut/normalize/join/music → `output/final_<timestamp>.mp4`.

## Commands

- Install: `py -m pip install -r requirements.txt` (Python launcher is `py`, not `python`)
- **Folder mode (primary workflow):** `py main.py --folder "...\reel_0110"` — reads
  `scene-*.mp4` + the `.txt` (Action lines → briefs) from that folder, caches in
  `<folder>\.aiedit_cache\`, writes `EDITED_<foldername>.mp4` into the folder.
- **Batch:** `py main.py --batch "...\1-page-<Name>"` — processes every `reel_*` sub-folder
  with scene clips. Skips a reel if `reel_is_done` (rendered AND all scenes AI-detected, non-error)
  or `reel_marked_done` (folder named `done`, or a `done.*` file — always skipped, even `--force`).
  Standard usage is **no `--force`**: it reuses good cache, retries failures (not cached), and
  converges to all-AI-trimmed on re-run.
- input/ mode: `py main.py` (clips in `input/`, briefs in `briefs.csv`) or double-click `RUN.bat`.
- Flags: `--dry-run` (cuts only, no render), `--force` (ignore cache, re-ask Gemini).
- Conciseness is capped by `max_seconds_per_scene` (default 4.0), enforced in `_clean_segments`
  AND requested in the prompt. Changing it needs `--force` to re-detect (cache stores final ranges).

FFmpeg 8.1 and ffprobe must be on PATH (they are on this machine). Key in `.env` (`GEMINI_API_KEY`).

## Architecture

- `common.py` — config loader (merges `config.json` over `DEFAULTS`), path constants,
  and the only ffmpeg/ffprobe wrappers (`run_ffmpeg`, `ffprobe_duration`, `has_audio`).
  Both other modules import from here to avoid circular deps.
- `detect.py` — `detect_clip()` uploads a clip to Gemini, gets strict-JSON keep-ranges via
  a Pydantic `response_schema`, then `_clean_segments()` clamps/drops-tiny/pads/merges.
  Result cached to `cache/<scene>.json`; **never re-calls the API if cache exists** unless
  `force=True`. Confidence below threshold or any error → keep whole clip (scene never lost).
- `edit.py` — `build_video()` drives: `cut_segment()` (input-seek trim, speed-up via
  `setpts`/`atempo` by `speed_factor`, scale/pad-or-crop to one target size/fps, silent
  audio if none), then `concat_segments()` (lossless concat demuxer) OR
  `concat_with_crossfade()` (xfade chain) when `join_crossfade_sec>0`, then `finalize()`
  (burns page-name watermark via drawtext, ducks source audio by `source_audio_volume`
  (default 0 = mute), loops+ducks+fades background music with `amix normalize=0`).
- `main.py` — two modes. `--folder` reads `scene-*.mp4` + the reel `.txt` (`parse_actions_from_txt`
  pulls `Action :` lines, positional brief per clip; a `briefs.csv` in the folder overrides),
  per-folder cache, `EDITED_<name>.mp4` output. Default mode uses `input/` + `briefs.csv`.
  Both share `run()`: detect → keep-range report → (unless `--dry-run`) render.

## Key invariants / gotchas

- **Scene order = filename sort.** Clips matched to briefs by stem (`scene01.mp4` → `scene01`).
- All segments are re-encoded to `target_width/height/fps` before joining — required because
  source clips can vary in size/fps; the concat demuxer needs identical streams.
- Gemini samples at a few fps, so timecodes are approximate (±~0.5–1s) for subtle motion.
  `padding_seconds` and `analysis_fps` are the levers; don't tighten padding without raising
  analysis fps. This is documented honestly in README "How detection behaves".
- google-genai SDK is v2.x: `client.files.upload/get/delete`, `types.Part(file_data=...,
  video_metadata=types.VideoMetadata(fps=...))`, `generate_content(config=GenerateContentConfig(...))`.
- **Folder-mode brief mapping is by SCENE NUMBER, not position** (`scene_number()`), so a
  missing scene clip never shifts the others' briefs.
- **Rate limits / caching:** one reel = 10 calls. `detect.py` retries 429/503 honouring the
  server `retryDelay`. Default `retry_until_success=True` loops a scene until it succeeds, bounded
  by `max_retry_minutes` (20) so an outage can't hang forever; set False to use bounded `max_retries`.
  Non-retryable errors (auth/bad-request/blocked) raise immediately. **Never caches `error-whole-clip`**
  (and auto-ignores any such entry on read) so failures self-heal next run.
- **Per-clip audio:** Gemini returns `has_music`; `cut_segment` sets that clip's own audio to
  `source_audio_volume_music` (0 = silence music clips) else `source_audio_volume_normal` (1.0 =
  keep action/ambient). `finalize` no longer ducks globally — it only mixes the bg track.
- **Watermark font:** bundled `assets/fonts/Lato-Regular.ttf` (SIL OFL, commercial-OK) with its
  `Lato-OFL.txt` license; `_resolve_font()` falls back to Arial if absent. Position raised via
  `watermark_bottom_ratio` (0.20 = 20% up from bottom).
- **Windows drawtext font gotcha:** an absolute font path's colon can't be escaped in the
  filtergraph (tried `\:`, quotes, double-backslash — all fail; fontconfig `font=` also fails,
  no config). Fix in `finalize()`: copy the font into the temp workdir and reference it by
  bare filename with `run_ffmpeg(..., cwd=workdir)`.

## Verified offline (no API)

FFmpeg path (cut/normalize across differing sizes, concat, crossfade, music) and
`_clean_segments` logic are smoke-tested. The live Gemini call in `detect.py` requires a
real key + clip and was not run (costs tokens) — it's the user's first real run.

## Language Instruction
Always reply in English. Use simple, beginner-friendly language.
