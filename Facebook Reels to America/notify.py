"""
notify.py — Telegram alerts for the Reels pipeline (stdlib only).

Sends short messages to a Telegram chat so you find out about crashes and
completions immediately instead of by checking the terminal in the morning.

Design rules (deliberate):
  * Standard library only (urllib) — no `requests` dependency, so copying this
    one file to any machine just works, same philosophy as parse_analysis.py.
  * NEVER raises. Alerting must not be able to crash the pipeline it watches.
    Every failure path returns False and prints a one-line warning.
  * Config is read from a gitignored file so tokens never enter git.

Setup (once per machine):
  1. In Telegram, talk to @BotFather → /newbot → copy the bot token.
  2. Send your new bot any message, then open
       https://api.telegram.org/bot<TOKEN>/getUpdates
     and copy the "chat":{"id":...} number.
  3. Create notify_config.json next to this file:
       { "bot_token": "123456:ABC...", "chat_id": "987654321", "enabled": true }
     (notify_config.json is gitignored — never commit it.)

Usage from code:
    from notify import notify, notify_error
    notify("reel_0231 complete on 5-page-Rust-Gold")
    try:
        ...
    except Exception as e:
        notify_error("video_phase reel_0231", e)
        raise

Usage from the terminal (handy for testing / scripts / scheduler heartbeat):
    py notify.py "pipeline started on 5-page-Rust-Gold"
"""

import json
import socket
import sys
import traceback
import urllib.parse
import urllib.request
from pathlib import Path

BASE_DIR = Path(__file__).parent
CONFIG_FILE = BASE_DIR / "notify_config.json"

# Telegram caps a single message at 4096 chars; stay well under to be safe.
_MAX_LEN = 3500


def _load_config():
    """Return (bot_token, chat_id) or (None, None) if not configured.
    Never raises — a missing/broken config just disables notifications."""
    try:
        with open(CONFIG_FILE, encoding="utf-8") as f:
            cfg = json.load(f)
    except (OSError, json.JSONDecodeError):
        return None, None
    if not cfg.get("enabled", True):
        return None, None
    token = (cfg.get("bot_token") or "").strip()
    chat_id = str(cfg.get("chat_id") or "").strip()
    if not token or not chat_id:
        return None, None
    return token, chat_id


def notify(msg: str) -> bool:
    """Send a plain-text message to Telegram. Returns True on success.
    No-ops (returns False) if notify_config.json is missing/disabled.
    Never raises."""
    token, chat_id = _load_config()
    if not token:
        return False  # not configured — silent no-op by design

    host = socket.gethostname()
    text = f"[{host}] {msg}"
    if len(text) > _MAX_LEN:
        text = text[:_MAX_LEN] + "\n…(truncated)"

    url = f"https://api.telegram.org/bot{token}/sendMessage"
    data = urllib.parse.urlencode({
        "chat_id": chat_id,
        "text": text,
        "disable_web_page_preview": "true",
    }).encode("utf-8")

    try:
        req = urllib.request.Request(url, data=data)
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.status == 200
    except Exception as e:  # network down, bad token, timeout — never propagate
        print(f"[notify] WARNING: could not send Telegram message: {e}", flush=True)
        return False


def notify_error(context: str, exc: BaseException) -> bool:
    """Send a formatted error alert with the exception type, message, and a
    short traceback tail. `context` should say where it happened, e.g.
    'video_phase reel_0231 (5-page-Rust-Gold)'. Never raises."""
    tb = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))
    tb_tail = tb.strip().splitlines()[-8:]  # last few frames are the useful part
    body = (
        f"❌ ERROR in {context}\n"
        f"{type(exc).__name__}: {exc}\n\n"
        + "\n".join(tb_tail)
    )
    return notify(body)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print('Usage: py notify.py "message to send"')
        sys.exit(1)
    message = " ".join(sys.argv[1:])
    ok = notify(message)
    if ok:
        print("[notify] sent ✓")
    else:
        print("[notify] not sent (not configured, disabled, or network error). "
              "See notify_config.json setup in notify.py.")
