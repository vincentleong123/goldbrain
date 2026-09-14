@echo off
title GoldBrain - XAUUSD Dashboard
cd /d "%~dp0"
echo Starting GoldBrain on http://127.0.0.1:8765  (close this window to stop)
node server.js
pause