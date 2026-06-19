# Facebook Token Guide — for the Reels uploader

Goal: get a **Page ID** and a **long-lived Page access token** for each Facebook
Page you want to auto-post to, then paste them into `uploader/config.json`.

You do this **once per page** (tokens last ~60 days — see the last section on renewing).

> Tip: this is the fiddliest part of the whole project, but it's a one-time setup.
> Take it slowly, step by step. Everything is free.

---

## Step 0 — You need a Facebook **Page** (not just a profile)
- A Page is a public page (e.g. "Noble Handiwork"), different from your personal profile.
- If you don't have one: facebook.com → Menu → **Pages** → **Create new Page**.
- You must be an **admin** of the Page.

---

## Step 1 — Create a Meta developer app (once for everything)
1. Go to **https://developers.facebook.com/apps** and log in.
2. Click **Create App**.
3. If asked the type, choose **Business** (or "Other" → "Business").
4. Give it any name (e.g. "Reels Uploader") and create it.
   - You do **not** need to submit it for review or make it live for your own pages.

---

## Step 2 — Get a User token with the right permissions
1. Go to **https://developers.facebook.com/tools/explorer** (Graph API Explorer).
2. Top-right: select your app in the **Application** dropdown.
3. Click **Generate Access Token** (or "Get Token" → "Get User Access Token").
4. When it asks for permissions, tick these four:
   - `pages_show_list`
   - `pages_read_engagement`
   - `pages_manage_posts`
   - `publish_video`
5. Approve the popup. You now have a **short-lived User token** in the box.

---

## Step 3 — Find your Page ID and Page token
1. Still in Graph API Explorer, in the request box type:  `me/accounts`  and click **Submit**.
2. You'll see a list of your Pages. For each page you'll see:
   - `"name"` — the page's name
   - `"id"` — this is your **Page ID** (a long number) ✅
   - `"access_token"` — this is the **Page token** ✅
3. Copy the **id** and **access_token** for the page you want.

> The Page token you get this way is usually already long-lived if you do Step 4 first.
> To be safe, do Step 4 to guarantee a long-lived one.

---

## Step 4 — Make the token long-lived (~60 days)
Short tokens die in ~1 hour. Convert to a 60-day token:

1. Get your **App ID** and **App Secret**: developers.facebook.com → your app →
   **Settings → Basic**.
2. Open this URL in your browser (replace the 3 capitalised parts with your values,
   using the **short User token** from Step 2):
   ```
   https://graph.facebook.com/v21.0/oauth/access_token?grant_type=fb_exchange_token&client_id=APP_ID&client_secret=APP_SECRET&fb_exchange_token=SHORT_USER_TOKEN
   ```
3. It returns a **long-lived User token**.
4. Go back to Graph API Explorer, paste that long-lived User token in the token box,
   run `me/accounts` again, and copy the page's `access_token` — it's now long-lived.

---

## Step 5 — Put it in the config
1. In `uploader/`, copy `config.example.json` to **`config.json`**
   (this file is git-ignored, so your tokens never get committed).
2. Fill it in — the key must be the **exact page folder name** (e.g. `3-page-Noble-Handiwork`):
   ```json
   {
     "live": false,
     "pages": {
       "3-page-Noble-Handiwork": {
         "page_id": "1234567890",
         "token": "EAAB...your-long-lived-page-token..."
       }
     }
   }
   ```
3. Add one block per page. Keep `"live": false` for now — that keeps everything in
   safe dry-run mode.

---

## Step 6 — Test (safe)
From the project root:
```
py uploader/post_ready.py --page 3-page-Noble-Handiwork
```
This is still **dry-run** (because `"live": false`). It should now show your real
`page_id` instead of "not configured yet". Nothing is posted.

When you're ready to post for real, you flip **two** safety switches:
- set `"live": true` in `config.json`, **and**
- run with `--live`:
  ```
  py uploader/post_ready.py --page 3-page-Noble-Handiwork --live
  ```
(We'll do that first real post together, on one page.)

---

## Renewing tokens (every ~60 days)
Long-lived tokens expire in about 60 days. When posting starts failing with an
auth/`OAuthException` error (Phase 4 will alert you on Telegram), just repeat
Steps 2–5 to get a fresh token and update `config.json`.

---

## Common problems
| Problem | Fix |
|---|---|
| "(#200) permissions" error | You missed a permission in Step 2 — regenerate the token with all four ticked. |
| Token works then dies in an hour | You used the short token — do Step 4 to make it long-lived. |
| Wrong page posts | The key in `config.json` must match the **page folder name** exactly. |
| "(#10) ... publish_video" | The app needs `publish_video`; re-tick it in Step 2. |
