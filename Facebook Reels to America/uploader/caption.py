"""
uploader/caption.py — turn a brief's caption into the final post-ready caption.

Shared by both `py bot.py handoff` (native-posting bundles) and the API uploader,
so the page-hashtag rule lives in exactly one place. Stdlib only.
"""

import re


def page_hashtag(page_folder: str) -> str:
    """Turn a page FOLDER name into the page's hashtag.
    '3-page-Noble-Handiwork' -> '#NobleHandiwork' (drop the leading 'N-page-'
    prefix, then strip spaces/hyphens so the words join into one tag)."""
    name = re.sub(r"^\d+-page-", "", page_folder)      # 'Noble-Handiwork'
    name = re.sub(r"[^0-9A-Za-z]", "", name)           # 'NobleHandiwork'
    return f"#{name}" if name else ""


def apply_page_hashtag(caption: str, page_folder: str) -> str:
    """Replace the Master Prompt's page-name placeholder hashtag with the real one.
    Handles the Thai '#[ชื่อเพจ]' / any '#[...]' bracketed placeholder, plus the
    English '#YourPageName' / '#PageName' variants."""
    tag = page_hashtag(page_folder)
    if not tag:
        return caption
    out = re.sub(r"#\[[^\]\n]*\]", tag, caption)                        # #[ชื่อเพจ], #[page name]
    out = re.sub(r"#YourPageName\b|#PageName\b", tag, out, flags=re.IGNORECASE)
    return out
