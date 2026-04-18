@echo off
REM ============================================================
REM  run-panel-x410.bat
REM  Launches workspace-panel.py on the Linux host and forwards
REM  the GTK window to X410 running on this Windows machine.
REM
REM  The Windows IP is detected automatically on the Linux side
REM  via $SSH_CLIENT, so this works even with a dynamic IP.
REM
REM  Requirements on Windows:
REM    - X410 running (Allow Public Access enabled, or add the
REM      Linux host IP to the allow list)
REM    - OpenSSH client available (built-in on Windows 10/11)
REM    - SSH key auth set up to the Linux host (recommended)
REM
REM  Usage: double-click this file, or run from cmd/PowerShell.
REM ============================================================

REM --- Config ---------------------------------------------------
set LINUX_USER=cslog
set LINUX_HOST=10.1.0.10
set PANEL_PATH=/home/cslog/ai-workflow/workspace-switcher/workspace-panel.py
REM --------------------------------------------------------------

echo Connecting to %LINUX_USER%@%LINUX_HOST% ...
echo Display will be forwarded to this machine via X410 (auto-detected IP).
echo.

ssh -o ServerAliveInterval=30 %LINUX_USER%@%LINUX_HOST% ^
    "export DISPLAY=$(echo $SSH_CLIENT ^| awk '{print $1}'):0.0; export GDK_BACKEND=x11; export NO_AT_BRIDGE=1; setxkbmap -layout br -variant abnt2; echo Using DISPLAY=$DISPLAY; python3 %PANEL_PATH%"

if errorlevel 1 (
    echo.
    echo Panel exited with an error. Press any key to close.
    pause >nul
)
