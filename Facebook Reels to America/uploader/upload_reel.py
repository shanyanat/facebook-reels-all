"""
uploader/upload_reel.py — post ONE finished reel to a Facebook Page as a Reel.

Fresh, self-contained implementation using only the Python standard library
(urllib) — no pip installs, so it runs the same on your PC now and on a VPS later.
It is NOT connected to / derived from the legacy `facebook-reels` project.

Facebook Graph API "video_reels" is a 3-step upload:
  1. start   POST /{page_id}/video_reels?upload_phase=start  -> video_id + upload_url
  2. upload  POST upload_url  (raw mp4 bytes, with offset/file_size headers)
  3. finish  POST /{page_id}/video_reels?upload_phase=finish&video_state=PUBLISHED
             &description=<caption>

Cover image (your thumbnail): best-effort. The Reels finish call doesn't reliably
accept a custom cover on every API version, so we ATTEMPT it after publish and fall
back to Facebook's auto-selected frame if it's rejected. Verify on the first LIVE run.

DRY-RUN BY DEFAULT: with live=False it posts nothing — it only logs what it WOULD do.
"""

import json
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

GRAPH = "https://graph.facebook.com/v21.0"


def _urlopen_or_detail(req, timeout: int):
    """urlopen that surfaces Facebook's actual error body on failure.

    urllib raises HTTPError on 4xx/5xx and str(e) is only 'HTTP Error 400: ...';
    the useful part — {"error":{"message":"...","code":190,...}} — is in e.read().
    We raise a RuntimeError carrying that body so logs are debuggable AND so Phase 4
    can detect token-expiry (code 190 / OAuthException) from the message."""
    try:
        return urllib.request.urlopen(req, timeout=timeout)
    except urllib.error.HTTPError as e:
        try:
            detail = e.read().decode("utf-8", "replace")
        except Exception:
            detail = ""
        raise RuntimeError(f"HTTP {e.code} from Facebook: {detail[:600]}") from e


def _post_form(url: str, fields: dict, timeout: int = 60) -> dict:
    data = urllib.parse.urlencode(fields).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST")
    with _urlopen_or_detail(req, timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def _try_set_cover(video_id: str, token: str, thumbnail_path: Path, log) -> None:
    """Best-effort custom cover. Wrapped so a failure never breaks a successful post."""
    try:
        # multipart/form-data: is_preferred=true makes this image the actual cover
        # (not just an extra thumbnail), then the image as `source`.
        boundary = "----reelcover7788"
        img = thumbnail_path.read_bytes()
        head = (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="is_preferred"\r\n\r\n'
            f"true\r\n"
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="source"; filename="{thumbnail_path.name}"\r\n'
            f"Content-Type: image/png\r\n\r\n"
        ).encode("utf-8")
        tail = f"\r\n--{boundary}--\r\n".encode("utf-8")
        body = head + img + tail
        url = f"{GRAPH}/{video_id}/thumbnails?access_token={urllib.parse.quote(token)}"
        req = urllib.request.Request(url, data=body, method="POST")
        req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
        with _urlopen_or_detail(req, 60) as r:
            log(f"  cover set from {thumbnail_path.name}: {r.read().decode('utf-8')[:120]}")
    except Exception as e:
        log(f"  cover NOT set (FB will auto-pick a frame) — {e}")


def upload_reel(video_path, page_id: str, token: str, caption: str = "",
                thumbnail_path=None, live: bool = False, log=print) -> dict:
    """Post one reel. Returns the API result, or {'dry_run': True} when live=False.
    Raises on a real (live) API failure so the caller can record the error."""
    video_path = Path(video_path)
    size = video_path.stat().st_size
    thumb = Path(thumbnail_path) if thumbnail_path else None
    cap_preview = (caption[:80] + "…") if len(caption) > 80 else caption

    if not live:
        log(f"[dry-run] would post {video_path.name} ({size // 1024} KB) → page {page_id}")
        log(f"[dry-run]   caption: {cap_preview!r}")
        log(f"[dry-run]   cover  : {thumb.name if thumb and thumb.exists() else '(FB auto-selects)'}")
        return {"dry_run": True}

    # 1. start
    init = _post_form(f"{GRAPH}/{page_id}/video_reels",
                      {"upload_phase": "start", "access_token": token})
    video_id = init["video_id"]
    upload_url = init["upload_url"]
    log(f"  start ok — video_id={video_id}")

    # 2. upload the bytes (reels are ~15–25 MB; fine to send in one request)
    body = video_path.read_bytes()
    req = urllib.request.Request(upload_url, data=body, method="POST")
    req.add_header("Authorization", f"OAuth {token}")
    req.add_header("offset", "0")
    req.add_header("file_size", str(size))
    with _urlopen_or_detail(req, 600) as r:
        r.read()
    log(f"  upload ok ({size // 1024} KB)")

    # 3. finish / publish
    res = _post_form(f"{GRAPH}/{page_id}/video_reels", {
        "upload_phase": "finish",
        "video_id": video_id,
        "access_token": token,
        "video_state": "PUBLISHED",
        "description": caption,
    })
    log(f"  published: {res}")

    # cover (best-effort, never fatal)
    if thumb and thumb.exists():
        _try_set_cover(video_id, token, thumb, log)

    res["video_id"] = video_id
    return res
