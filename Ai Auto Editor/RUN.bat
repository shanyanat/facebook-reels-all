@echo off
REM Double-click to run the editor. Drag in your clips first (see README).
cd /d "%~dp0"
py main.py %*
echo.
pause
