@echo off
rem Double-clickable wrapper for install.ps1 (DeepSeek Excell by dezuhan).
rem -AutoStart is always passed: when the installer finishes, the local server is
rem registered to start by itself at every boot/logon through a hidden .vbs
rem launcher, so no CMD window ever pops up. Pass -NoAutoStart to skip that.
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" -AutoStart %*
echo.
pause
