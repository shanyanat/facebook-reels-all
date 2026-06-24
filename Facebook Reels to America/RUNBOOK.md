# RUNBOOK — How to use the Reels system (simple guide)

This is the day-to-day guide. Keep it simple: **you generate with the extension,
the computer does the rest, then you post by hand.**

---

## The big picture (what is automatic now)

```
YOU                          THE COMPUTER (automatic)              YOU
───                          ────────────────────────              ───
Drop briefs  →  Generate  →  archive → edit → write caption.txt  →  Post natively
(.txt files)   (extension)   (monitor.py does this by itself)        (Business Suite)
```

Once a reel finishes generating, its folder in `complete/<page>/<reel>/` already has
**everything ready to post**:
- `EDITED_xxxx.mp4`  — the finished video
- `thumbnail.png`    — the cover image
- `caption.txt`      — the caption (with your page hashtag, e.g. #NobleHandiwork)

**You do NOT run archive / edit / handoff commands anymore. That all happens by itself.**

---

## Each session — 2 things to start

1. **Start the engine** (this is what makes everything automatic). In one terminal:
   ```
   py monitor.py
   ```
   Leave it running the whole time. (Restart it after adding a NEW page folder.)

2. **Open the Chrome extension** in your normal Chrome, like before.

That's it. Now generate reels in the extension as usual (3–5 in parallel is fine).

---

## The daily flow

1. **Add briefs:** drop the `.txt` files into `pages/<page>/briefs/`.
   (New briefs get their caption captured automatically.)
2. **Generate:** use the extension (images → videos), several reels at once.
3. **Wait — it finishes itself:** when a reel's videos are all done, the computer
   automatically archives it, edits it, and writes `caption.txt`. You may get a
   Telegram message: "✅ Auto-advanced reel_XXXX — ready to post".
4. **Post natively:** open `complete/<page>/<reel>/`, and in **Meta Business Suite**
   upload the `EDITED_*.mp4`, set `thumbnail.png` as the cover, paste `caption.txt`.
   Schedule them spread across the day. (We post by hand because API posting kills reach.)

---

## The commands — what each one is for (plain words)

| Command | When you use it | What it does |
|---|---|---|
| `py monitor.py` | **Every session** — start it, leave it running | The engine. Makes archive/edit/caption automatic. |
| `py bot.py status` | Anytime you want to see progress | Shows every reel and what stage it's at. |
| `py bot.py force-complete reel_XXXX` | A reel got stuck (e.g. 9 of 10 videos) and you accept it | Pushes that reel through (edit + caption) with whatever clips it has. |
| `py bot.py cleanup` | After you've posted, to free disk space | Deletes the big raw clips of posted reels (keeps the edited video). |
| `py bot.py preflight` | Before a big run, optional | Closes leftover Chrome, checks disk space. |
| `py bot.py updateprompts reel_XXXX` | Only for OLD reels with no caption | Reads the brief again and fills the caption. |
| `py bot.py handoff` | Rare — only after `updateprompts` on old reels | (Re)writes `caption.txt` for finished reels. New reels do this by themselves. |
| `py bot.py pipeline <page>` | Backup / unattended machine, NO extension | Does the WHOLE thing for one page by itself, one reel at a time (slower). |

**Rule:** use **one** generation method at a time — either the **extension** (main, fast,
parallel) **or** `pipeline` (backup, sequential). Don't run both at once.

---

## What happens when something goes wrong (error scenarios)

The key idea: **a problem with one reel does NOT hurt the other reels.**

### 1. One image didn't generate
The extension automatically tries again to recreate the missing image (a few times).
If it succeeds → continues normally. If a scene truly can't be made → that scene is
left out, and the reel may finish "partial" (see #3).

### 2. One video failed (e.g. scene 5 timed out)
The video step retries up to 5 times. If it still fails, the reel ends up **partial**
(e.g. 9 of 10 clips).

### 3. A reel is partial (e.g. 9/10) — IMPORTANT
- The computer will **NOT** auto-finish a partial reel. It **waits** for you.
  (This is on purpose — we don't want a broken video auto-prepared.)
- It just sits in `working/`. The other reels are fine and finish normally.
- **Your choice:**
  - **Try again:** re-run that reel's videos (extension, or `py bot.py videos reel_XXXX`)
    — it resumes and only makes the missing clip.
  - **Accept it:** `py bot.py force-complete reel_XXXX` — finishes it with the 9 clips,
    edits it, writes caption.txt. Now it's ready to post like any other.

### 4. Other reels while one fails
Completely safe. Each reel is independent. The others keep going and finish on their own.

### 5. ChatGPT / Google Flow problem (rate limit, "Verify you are human", logged out, outage)
This is the ONE kind of error that can pause **everything at once**, because all your
tabs share the same account.
- **Cloudflare "Verify you are human":** you get a Telegram alert; click the box in the
  Chrome window; it continues by itself (waits up to 5 minutes).
- **Logged out:** log back in in the Chrome window; it continues.
- **Rate limit / site down:** wait a while and run again. Nothing is lost.

### 6. Editing problem (rare)
If the editor can't run (e.g. its Gemini key is missing), the reel is archived but not
edited. Re-run later — it skips finished reels and only redoes the unfinished one.

### 7. Computer turned off / you closed it mid-run
Nothing is lost. Everything is tracked by the actual files on disk. Just start again —
it continues from where it stopped. Partial reels keep waiting for your decision.

---

## How do I know if something needs me?
1. **Telegram** (if set up) — you get a message on success, on errors, and for Cloudflare.
2. **`py bot.py status`** — run it anytime to see every reel and its stage. Anything stuck
   or partial shows here.

---

## Posting tips (to protect reach)
- **Post natively** (Business Suite), not through the API. API posting tanks reach.
- **Spread posts out** across the day and across pages — don't post many at once.
- **Build a buffer:** generate ahead (e.g. a week of reels) so a bad ChatGPT/Flow day
  never stops your posting.
- **Vary the content** between pages — identical templates across many pages is risky
  for reach.
