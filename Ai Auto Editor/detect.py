"""Ask Gemini which seconds of a clip match its brief; return validated keep-ranges.

Successful results are cached to <cache_dir>/<scene>.json. Transient failures
(rate limit / server busy) are NOT cached, so they are retried on the next run.
"""
import json
import os
import re
import time

from common import CACHE_DIR, ffprobe_duration

_client = None

# Substrings that mean "try again shortly" rather than "give up".
RETRYABLE = ("429", "RESOURCE_EXHAUSTED", "503", "UNAVAILABLE", "500", "INTERNAL")


def _get_client():
    """Lazily create the Gemini client (so --help etc. work without a key)."""
    global _client
    if _client is not None:
        return _client
    from dotenv import load_dotenv
    from google import genai

    load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not key or key == "your_key_here":
        raise SystemExit(
            "No GEMINI_API_KEY found. Copy .env.example to .env and paste your key "
            "(get one free at https://aistudio.google.com/apikey)."
        )
    _client = genai.Client(api_key=key)
    return _client


PROMPT = """You are a precise, ruthless short-form video editor. The clip is {duration:.2f} seconds long.

This scene is SUPPOSED to show:
"{brief}"

The raw AI footage usually contains far more than we need. Return ONLY the single tightest
moment, in seconds, where the brief action reads most clearly.

Rules:
- BE VERY AGGRESSIVE. Keep about {max_seconds:.0f} seconds or LESS — pick the single best
  window where the key action peaks. Do NOT keep the whole clip; trim hard.
- CUT the slow lead-in, idle/standing frames, hesitation, camera settling, repeated motion,
  and everything AFTER the action is essentially done.
- Prefer ONE tight segment. Only return two segments if the good action is genuinely split by
  a bad middle, and even then keep each piece minimal.
- If a wrong/extra action appears (e.g. lifting before putting down), keep only the part that
  matches the brief.
- Times are in seconds from the start of THIS clip, within 0 to {duration:.2f}.
- "confidence" 0..1 = how sure you are. Only return the whole clip (low confidence) if you
  truly cannot locate the action.
- "has_music": true ONLY if the clip's audio contains background MUSIC (a melody, song, or
  instrumental track). Normal sounds — footsteps, rain, rustling, handling objects, ambience —
  are NOT music; set has_music false for those."""


def _retry_delay(msg, attempt, base):
    """Seconds to wait: honour the server's suggested delay, else exponential backoff."""
    m = re.search(r"retry in ([\d.]+)s", msg) or re.search(r"retryDelay'?:?\s*'?(\d+)s", msg)
    if m:
        return min(float(m.group(1)) + 2.0, 120.0)
    return min(base * (2 ** attempt), 120.0)


def _detect_with_gemini(clip_path, brief, duration, cfg):
    """Upload, call Gemini (with retry on rate limits), return (segs, conf, has_music)."""
    from google.genai import types
    from pydantic import BaseModel

    class Segment(BaseModel):
        start: float
        end: float
        reason: str = ""

    class Detection(BaseModel):
        segments: list[Segment]
        confidence: float
        has_music: bool = False

    client = _get_client()
    base = float(cfg.get("retry_base_delay_sec", 8))
    until_success = bool(cfg.get("retry_until_success", True))
    max_retries = int(cfg.get("max_retries", 5))
    deadline = time.time() + float(cfg.get("max_retry_minutes", 20)) * 60

    uploaded = client.files.upload(file=clip_path)
    waited = 0.0
    while getattr(uploaded.state, "name", str(uploaded.state)) == "PROCESSING":
        time.sleep(2)
        waited += 2
        uploaded = client.files.get(name=uploaded.name)
        if waited > 300:
            raise RuntimeError(f"Gemini took too long to process {clip_path}")
    if getattr(uploaded.state, "name", str(uploaded.state)) == "FAILED":
        raise RuntimeError(f"Gemini failed to process {clip_path}")

    video_part = types.Part(
        file_data=types.FileData(file_uri=uploaded.uri, mime_type=uploaded.mime_type),
        video_metadata=types.VideoMetadata(fps=cfg.get("analysis_fps", 1)),
    )
    prompt = PROMPT.format(duration=duration, brief=brief,
                           max_seconds=float(cfg.get("max_seconds_per_scene", 4.0)))

    response = None
    attempt = 0
    while True:
        try:
            response = client.models.generate_content(
                model=cfg.get("model", "gemini-2.5-flash"),
                contents=[video_part, prompt],
                config=types.GenerateContentConfig(
                    response_mime_type="application/json",
                    response_schema=Detection,
                    temperature=0,
                ),
            )
            break
        except Exception as exc:
            msg = str(exc)
            if not any(k in msg for k in RETRYABLE):
                raise  # a real error (bad request, auth, blocked) — don't loop on it
            # Keep retrying rate-limit/busy errors. By default until success, bounded only
            # by a safety time cap so a real outage can't hang forever.
            if until_success:
                if time.time() >= deadline:
                    raise RuntimeError(
                        f"still rate-limited after {cfg.get('max_retry_minutes', 20)} min; "
                        f"giving up for now: {msg[:120]}")
                cap_note = ""
            else:
                if attempt >= max_retries:
                    raise
                cap_note = f"/{max_retries}"
            delay = _retry_delay(msg, attempt, base)
            print(f"      rate-limited/busy; waiting {delay:.0f}s then retry "
                  f"(attempt {attempt + 1}{cap_note})")
            time.sleep(delay)
            attempt += 1

    try:
        client.files.delete(name=uploaded.name)
    except Exception:
        pass

    parsed = getattr(response, "parsed", None)
    if isinstance(parsed, Detection):
        segs = [(float(s.start), float(s.end)) for s in parsed.segments]
        return segs, float(parsed.confidence), bool(parsed.has_music)

    text = getattr(response, "text", None)
    if not text:
        raise RuntimeError("Gemini returned no usable content (empty/blocked response)")
    data = json.loads(text)
    segs = [(float(s["start"]), float(s["end"])) for s in data.get("segments", [])]
    return segs, float(data.get("confidence", 0.0)), bool(data.get("has_music", False))


def _clean_segments(segs, duration, cfg):
    """Clamp to clip, drop tiny/invalid, pad, merge near segments, clamp again."""
    pad = float(cfg.get("padding_seconds", 0.2))
    gap = float(cfg.get("merge_gap_seconds", 0.3))
    min_len = float(cfg.get("min_segment_seconds", 0.15))

    clamped = []
    for start, end in segs:
        s = max(0.0, min(start, duration))
        e = max(0.0, min(end, duration))
        if e - s >= min_len:
            clamped.append((s, e))
    if not clamped:
        return []

    clamped.sort()
    padded = [(max(0.0, s - pad), min(duration, e + pad)) for s, e in clamped]
    merged = [list(padded[0])]
    for s, e in padded[1:]:
        if s - merged[-1][1] <= gap:
            merged[-1][1] = max(merged[-1][1], e)
        else:
            merged.append([s, e])

    # Hard cap on total kept time per scene (guarantee conciseness even if Gemini overshoots).
    cap = float(cfg.get("max_seconds_per_scene", 0) or 0)
    if cap > 0:
        capped, total = [], 0.0
        for s, e in merged:
            if total >= cap:
                break
            if total + (e - s) > cap:
                e = s + (cap - total)
            capped.append((s, e))
            total += e - s
        merged = capped

    return [(round(s, 3), round(e, 3)) for s, e in merged]


def detect_clip(clip_path, brief, cfg, force=False, cache_dir=None):
    """Return {scene, brief, duration, segments, confidence, has_music, source}.

    Cached unless force=True. Transient API failures are returned but NOT cached,
    so the next run retries them instead of reusing a stale whole-clip fallback.
    """
    cache_dir = cache_dir or CACHE_DIR
    os.makedirs(cache_dir, exist_ok=True)
    scene = os.path.splitext(os.path.basename(clip_path))[0]
    cache_path = os.path.join(cache_dir, scene + ".json")

    if not force and os.path.exists(cache_path):
        with open(cache_path, "r", encoding="utf-8") as f:
            cached = json.load(f)
        # Self-heal: ignore an error fallback left by an older run; re-detect it.
        if cached.get("source") != "error-whole-clip":
            return cached

    duration = ffprobe_duration(clip_path)
    threshold = float(cfg.get("confidence_threshold", 0.45))
    has_music = False
    cache_ok = True

    try:
        raw_segs, conf, has_music = _detect_with_gemini(clip_path, brief, duration, cfg)
        segments = _clean_segments(raw_segs, duration, cfg)
        if not segments or conf < threshold:
            segments = [(0.0, round(duration, 3))]
            source = "fallback-whole-clip"
        else:
            source = "gemini"
    except Exception as exc:
        print(f"  ! detection failed for {scene} ({str(exc)[:120]}); keeping whole clip "
              f"(NOT cached — will retry next run)")
        segments = [(0.0, round(duration, 3))]
        conf = 0.0
        source = "error-whole-clip"
        cache_ok = False  # never bake a transient failure into the cache

    result = {
        "scene": scene,
        "brief": brief,
        "duration": round(duration, 3),
        "segments": [[s, e] for s, e in segments],
        "confidence": round(conf, 3),
        "has_music": has_music,
        "source": source,
    }
    if cache_ok:
        with open(cache_path, "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False, indent=2)

    # Space out API calls to stay under the per-minute rate limit.
    if source != "error-whole-clip":
        time.sleep(float(cfg.get("request_delay_sec", 0)))
    return result
