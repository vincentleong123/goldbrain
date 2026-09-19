@echo off
rem GoldBrain continuous duel runner (crowd vs fade over backward history).
rem Runs minimized in the background, logs to data\duel-console.log.
cd /d "%~dp0"
if not exist data mkdir data
start "" /min cmd /c "node run-duel.js >> data\duel-console.log 2>&1"