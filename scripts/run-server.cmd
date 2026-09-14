@echo off
rem Created automatically by scripts/autostart.ps1
rem Starts the local server hidden (no CMD window) and never starts a second copy.
powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0start-server.ps1"
