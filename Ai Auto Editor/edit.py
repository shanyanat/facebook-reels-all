"""FFmpeg stage: cut each keep-range, speed up, normalize, join, watermark, music.

Every segment is re-encoded to one identical target (size/fps/audio) so clips of
different sizes join cleanly. Footage is sped up by speed_factor. Source audio is
ducked (default muted) so AI clip music never clashes with our background track.
A page-name watermark is drawn centre-bottom on the final render.
"""
import os
import shutil
import tempfile

from common import ROOT, OUTPUT_DIR, ffprobe_duration, has_audio, run_ffmpeg


def _normalize_filter(cfg):
    """Build the scale/pad (or scale/crop) filter that fits any clip to target."""
    w = int(cfg["target_width"])
    h = int(cfg["target_height"])
    fps = int(cfg["fps"])
    if cfg.get("fit", "pad") == "crop":
        return (f"scale={w}:{h}:force_original_aspect_ratio=increase,"
                f"crop={w}:{h},setsar=1,fps={fps}")
    return (f"scale={w}:{h}:force_original_aspect_ratio=decrease,"
            f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps={fps}")


def cut_segment(src, start, end, out_path, cfg, source_volume=1.0):
    """Trim src to [start, end], speed it up, normalize, and set its own audio level.

    source_volume is applied to the clip's own audio: 1.0 keeps activity/ambient
    sound, ~0.0 silences a clip whose audio is mostly background music.
    """
    dur = max(0.05, end - start)
    speed = float(cfg.get("speed_factor", 1.0)) or 1.0
    sped_dur = dur / speed
    vf = _normalize_filter(cfg) + f",setpts=PTS/{speed}"
    tail = [
        "-vf", vf,
        "-r", str(int(cfg["fps"])),
        "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-ar", "44100", "-ac", "2", "-b:a", "192k",
    ]
    if has_audio(src):
        # Input seeking (-ss/-t before -i) is fast and frame-accurate when re-encoding.
        args = ["-ss", f"{start:.3f}", "-t", f"{dur:.3f}", "-i", src,
                "-af", f"atempo={speed},volume={source_volume}"] + tail + [out_path]
    else:
        # No source audio -> synthesize matching silence (already at sped length).
        args = [
            "-ss", f"{start:.3f}", "-t", f"{dur:.3f}", "-i", src,
            "-f", "lavfi", "-t", f"{sped_dur:.3f}", "-i", "anullsrc=r=44100:cl=stereo",
            "-map", "0:v", "-map", "1:a",
        ] + tail + ["-shortest", out_path]
    run_ffmpeg(args)


def concat_segments(segment_paths, out_path):
    """Join identically-encoded segments losslessly via the concat demuxer."""
    list_fd, list_path = tempfile.mkstemp(suffix=".txt")
    try:
        with os.fdopen(list_fd, "w", encoding="utf-8") as f:
            for p in segment_paths:
                safe = p.replace("'", "'\\''")
                f.write(f"file '{safe}'\n")
        run_ffmpeg(["-f", "concat", "-safe", "0", "-i", list_path,
                    "-c", "copy", out_path])
    finally:
        os.remove(list_path)


def concat_with_crossfade(segment_paths, out_path, cfg):
    """Join segments with a short xfade/acrossfade between each (smoother joins)."""
    c = float(cfg["join_crossfade_sec"])
    durs = [ffprobe_duration(p) for p in segment_paths]
    inputs = []
    for p in segment_paths:
        inputs += ["-i", p]

    steps = []
    vcur, acur = "[0:v]", "[0:a]"
    cum = durs[0]
    n = len(segment_paths)
    for i in range(1, n):
        offset = cum - c * i
        vout = "[vout]" if i == n - 1 else f"[v{i}]"
        aout = "[aout]" if i == n - 1 else f"[a{i}]"
        steps.append(
            f"{vcur}[{i}:v]xfade=transition=fade:duration={c}:offset={offset:.3f}{vout}")
        steps.append(f"{acur}[{i}:a]acrossfade=d={c}{aout}")
        vcur, acur = vout, aout
        cum += durs[i]

    run_ffmpeg(inputs + [
        "-filter_complex", ";".join(steps),
        "-map", "[vout]", "-map", "[aout]",
        "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-ar", "44100", "-ac", "2", "-b:a", "192k",
        out_path,
    ])


def _resolve_font(cfg):
    """First existing font: the configured (free, bundled) one, else Arial fallback."""
    candidates = [cfg.get("watermark_fontfile", ""), "C:/Windows/Fonts/arial.ttf"]
    for c in candidates:
        if not c:
            continue
        p = c if os.path.isabs(c) else os.path.join(ROOT, c)
        if os.path.exists(p):
            return p
    return None


def _watermark_filter(text, cfg, font_ref):
    """drawtext filter: small, white, faded, centred near the lower third.

    `font_ref` must be a colon-free bare filename in the ffmpeg working directory —
    Windows drawtext cannot parse the colon in an absolute font path, so finalize()
    copies the font into the workdir and we reference it by name with cwd set there.
    """
    op = float(cfg.get("watermark_opacity", 0.3))
    h = int(cfg["target_height"])
    fs = max(10, int(h * float(cfg.get("watermark_fontsize_ratio", 0.03))))
    # Distance of the text from the bottom edge, as a fraction of height (raised up).
    margin = int(h * float(cfg.get("watermark_bottom_ratio", 0.20)))
    # Folder-derived names never contain ':' or '\'; sanitise anyway for safety.
    txt = (text.replace("\\", " ").replace(":", "-")
               .replace("'", "").replace("%", "pct"))
    dt = (f"drawtext=fontfile={font_ref}:text={txt}:"
          f"fontcolor=white@{op}:fontsize={fs}:"
          f"shadowcolor=black@{min(op, 0.25):.2f}:shadowx=1:shadowy=1:"
          f"x=(w-text_w)/2:y=h-text_h-{margin}")
    return f"[0:v]{dt}[v]"


def finalize(joined, music_path, watermark_text, out_path, cfg, workdir):
    """Burn the watermark and lay background music under the (already-levelled) audio.

    Per-clip source volume was set in cut_segment, so we do not touch it here.
    """
    dur = ffprobe_duration(joined)
    wm = bool(cfg.get("watermark_enabled", True)) and bool(watermark_text)

    cwd = None
    if wm:
        # Copy the font into the workdir so we can reference it without a colon
        # (Windows drawtext cannot parse the colon in an absolute font path).
        font_src = _resolve_font(cfg)
        font_ref = "_wm_font.ttf"
        if not font_src:
            print("  ! no watermark font found; skipping watermark")
            wm = False
        else:
            try:
                shutil.copy(font_src, os.path.join(workdir, font_ref))
                cwd = workdir
            except Exception as exc:
                print(f"  ! could not load watermark font ({exc}); skipping watermark")
                wm = False

    parts = []
    if wm:
        parts.append(_watermark_filter(watermark_text, cfg, font_ref))
        vmap, vcodec = "[v]", ["-c:v", "libx264", "-preset", "medium",
                               "-crf", "20", "-pix_fmt", "yuv420p"]
    else:
        vmap, vcodec = "0:v", ["-c:v", "copy"]

    if music_path:
        vol = float(cfg.get("music_volume", 0.18))
        fade = float(cfg.get("music_fade_out_sec", 2))
        fade_start = max(0.0, dur - fade)
        # Optionally strip any silent lead-in so the song starts on its first beat.
        lead = ("silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0,"
                if cfg.get("music_trim_leading_silence", True) else "")
        parts.append(f"[1:a]{lead}volume={vol},afade=t=out:st={fade_start:.3f}:d={fade:.3f}[m]")
        parts.append("[0:a][m]amix=inputs=2:duration=first:normalize=0[a]")
        inputs = ["-i", joined, "-stream_loop", "-1", "-i", music_path]
        amap, acodec = "[a]", ["-c:a", "aac", "-b:a", "192k"]
    else:
        inputs = ["-i", joined]
        amap, acodec = "0:a", ["-c:a", "copy"]

    fc = ["-filter_complex", ";".join(parts)] if parts else []
    run_ffmpeg(inputs + fc + [
        "-map", vmap, "-map", amap,
        "-t", f"{dur:.3f}",
    ] + vcodec + acodec + ["-movflags", "+faststart", out_path], cwd=cwd)


def build_video(detections, music_path, final_path, cfg, watermark_text="", workdir=None):
    """Full edit: cut every segment, join, watermark + music, render.

    `detections` is the ordered list of dicts from detect.detect_clip, each with
    keys: clip_path, scene, segments[[s,e],...].
    """
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    tmp = workdir or tempfile.mkdtemp(prefix="aiedit_")
    os.makedirs(tmp, exist_ok=True)

    normal_vol = float(cfg.get("source_audio_volume_normal", 1.0))
    music_vol = float(cfg.get("source_audio_volume_music", 0.0))

    segment_files = []
    for det in detections:
        src = det["clip_path"]
        src_vol = music_vol if det.get("has_music") else normal_vol
        tag = "  (music ducked)" if det.get("has_music") else ""
        for idx, (start, end) in enumerate(det["segments"]):
            seg_out = os.path.join(tmp, f"{det['scene']}_{idx:02d}.mp4")
            print(f"  cut {det['scene']} [{start:.2f}-{end:.2f}] "
                  f"x{cfg.get('speed_factor', 1.0)}{tag}")
            cut_segment(src, float(start), float(end), seg_out, cfg, source_volume=src_vol)
            segment_files.append(seg_out)

    if not segment_files:
        raise RuntimeError("No segments to render — check the clips and briefs.")

    joined = os.path.join(tmp, "_joined.mp4")
    crossfade = float(cfg.get("join_crossfade_sec", 0) or 0)
    if crossfade > 0 and len(segment_files) > 1:
        print(f"  join {len(segment_files)} segments with {crossfade}s crossfade")
        concat_with_crossfade(segment_files, joined, cfg)
    else:
        print(f"  join {len(segment_files)} segments (hard cuts)")
        concat_segments(segment_files, joined)

    if watermark_text and cfg.get("watermark_enabled", True):
        print(f"  watermark: \"{watermark_text}\"")
    if music_path:
        print(f"  music: {os.path.basename(music_path)} (vol {cfg.get('music_volume')})")
    else:
        print("  no music file found — source audio only")

    finalize(joined, music_path, watermark_text, final_path, cfg, workdir=tmp)
    return final_path
