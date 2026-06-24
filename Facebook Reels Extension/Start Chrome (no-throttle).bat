@echo off
REM ============================================================================
REM  Start Chrome for the Reels extension WITHOUT background/occlusion throttling.
REM
REM  Problem this fixes: when another window COVERS the Chrome window (even though
REM  Chrome is not minimized), Chrome's "native window occlusion" detector marks
REM  the page as hidden and throttles its timers, so the extension's automation
REM  loop stalls. autoDiscardable:false (already in the extension) stops tabs from
REM  being DISCARDED, but it does NOT stop this occlusion/timer throttling — only
REM  these launch flags do.
REM
REM  Flags:
REM    --disable-features=CalculateNativeWinOcclusion  -> ignore "window covered"
REM    --disable-backgrounding-occluded-windows        -> don't throttle covered win
REM    --disable-background-timer-throttling            -> keep timers full speed
REM    --disable-renderer-backgrounding                 -> don't deprioritize bg tabs
REM
REM  IMPORTANT: Chrome reuses an already-running process, so the flags are IGNORED
REM  unless EVERY Chrome window is closed first. This script force-closes Chrome,
REM  waits, then relaunches with your normal profile (logins + extension intact).
REM  Save any work in open Chrome tabs before running.
REM ============================================================================

echo Closing all Chrome windows so the no-throttle flags can take effect...
taskkill /IM chrome.exe /F >nul 2>&1
timeout /t 3 /nobreak >nul

echo Starting Chrome (occlusion + timer throttling disabled)...
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" ^
  --disable-features=CalculateNativeWinOcclusion ^
  --disable-backgrounding-occluded-windows ^
  --disable-background-timer-throttling ^
  --disable-renderer-backgrounding

echo.
echo Done. Chrome is running with throttling disabled.
echo NOW VERIFY: start a generation, cover the Chrome window with another window
echo (do NOT minimize it), and confirm a background slot keeps advancing.
echo If it still stalls, tell me — there may be another throttle to disable.
