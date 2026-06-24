"""Shared helpers: paths, config loading, and ffprobe wrappers."""
import json
import os
import random
import subprocess

ROOT = os.path.dirname(os.path.abspath(__file__))
INPUT_DIR = os.path.join(ROOT, "input")
MUSIC_DIR = os.path.join(ROOT, "music")
OUTPUT_DIR = os.path.join(ROOT, "output")
CACHE_DIR = os.path.join(ROOT, "cache")
CONFIG_PATH = os.path.join(ROOT, "config.json")
BRIEFS_PATH = os.path.join(ROOT, "briefs.csv")

VIDEO_EXTS = (".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v")
AUDIO_EXTS = (".mp3", ".wav", ".aac", ".m4a", ".ogg", ".flac")

DEFAULTS = {
    "target_width": 1080,
    "target_height": 1920,
    "fps": 30,
    "fit": "pad",
    "speed_factor": 1.4,
    "source_audio_volume_normal": 1.0,
    "source_audio_volume_music": 0.0,
    "retry_until_success": True,
    "max_retry_minutes": 20,
    "max_retries": 5,
    "retry_base_delay_sec": 8,
    "request_delay_sec": 5,
    "music_volume": 0.18,
    "music_fade_out_sec": 2,
    "music_trim_leading_silence": True,
    "join_crossfade_sec": 0,
    "watermark_enabled": True,
    "watermark_opacity": 0.3,
    "watermark_fontsize_ratio": 0.03,
    "watermark_bottom_ratio": 0.20,
    "watermark_fontfile": "assets/fonts/Lato-Regular.ttf",
    "watermark_text": "",
    "max_seconds_per_scene": 4.0,
    "padding_seconds": 0.2,
    "merge_gap_seconds": 0.3,
    "min_segment_seconds": 0.15,
    "analysis_fps": 2,
    "confidence_threshold": 0.45,
    "model": "gemini-2.5-flash",
}


def load_config():
    """Read config.json, filling any missing key from DEFAULTS."""
    cfg = dict(DEFAULTS)
    if os.path.exists(CONFIG_PATH):
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            cfg.update(json.load(f))
    return cfg


def ffprobe_duration(path):
    """Return clip duration in seconds (float)."""
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", path],
        check=True, capture_output=True, text=True,
    ).stdout.strip()
    return float(out)


def has_audio(path):
    """True if the file has at least one audio stream."""
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a",
         "-show_entries", "stream=index", "-of", "csv=p=0", path],
        check=True, capture_output=True, text=True,
    ).stdout.strip()
    return bool(out)


def run_ffmpeg(args, cwd=None):
    """Run an ffmpeg command (args after the 'ffmpeg' token), raising on failure.

    cwd lets the caller reference a font by bare filename (Windows drawtext can't
    handle the colon in an absolute font path).
    """
    cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error"] + args
    proc = subprocess.run(cmd, capture_output=True, text=True, cwd=cwd)
    if proc.returncode != 0:
        raise RuntimeError(
            "ffmpeg failed:\n  " + " ".join(cmd) + "\n" + proc.stderr.strip()
        )


def list_clips():
    """Return input clips sorted by filename (scene order)."""
    if not os.path.isdir(INPUT_DIR):
        return []
    files = [
        os.path.join(INPUT_DIR, f)
        for f in os.listdir(INPUT_DIR)
        if f.lower().endswith(VIDEO_EXTS)
    ]
    return sorted(files, key=lambda p: os.path.basename(p).lower())


def list_clips_in(folder):
    """Return scene clips in a folder, sorted by name. Excludes our own EDITED_ output."""
    if not os.path.isdir(folder):
        return []
    files = [
        os.path.join(folder, f)
        for f in os.listdir(folder)
        if f.lower().endswith(VIDEO_EXTS) and not f.upper().startswith("EDITED_")
    ]
    return sorted(files, key=lambda p: os.path.basename(p).lower())


def find_music(folder=None):
    """Return a RANDOM audio file: prefer one in `folder`, else from the global music/ dir."""
    for d in [folder, MUSIC_DIR]:
        if d and os.path.isdir(d):
            tracks = [os.path.join(d, f) for f in os.listdir(d)
                      if f.lower().endswith(AUDIO_EXTS)]
            if tracks:
                return random.choice(tracks)
    return None


def find_txt(folder):
    """Return the single .txt brief file in a folder (first if several), or None."""
    if not os.path.isdir(folder):
        return None
    txts = sorted(f for f in os.listdir(folder) if f.lower().endswith(".txt"))
    return os.path.join(folder, txts[0]) if txts else None


def scene_id(clip_path):
    """Filename without extension, e.g. 'scene01.mp4' -> 'scene01'."""
    return os.path.splitext(os.path.basename(clip_path))[0]


def scene_number(clip_path):
    """First integer in the filename, e.g. 'scene-07.mp4' -> 7. None if absent."""
    import re
    m = re.search(r"(\d+)", scene_id(clip_path))
    return int(m.group(1)) if m else None


def page_name_from_path(folder):
    """Derive a human page name from a '<n>-page-<Name>' folder anywhere up the path.

    'C:\\...\\1-page-Strange-Frontiers\\reel_0110' -> 'Strange Frontiers'.
    Falls back to cleaning the given folder's own name if no page folder is found.
    """
    import re
    parts = os.path.normpath(folder).split(os.sep)
    for part in reversed(parts):
        m = re.match(r"(?i)^\d*-?page-(.+)$", part)
        if m:
            return m.group(1).replace("-", " ").replace("_", " ").strip()
    base = os.path.basename(os.path.normpath(folder))
    base = re.sub(r"(?i)^\d*-?page-", "", base)
    return base.replace("-", " ").replace("_", " ").strip()
