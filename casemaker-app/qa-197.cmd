@echo off
cd /d "C:\projects\Case Maker\casemaker-app"
start "vite5199" /min cmd /c "npx vite --port 5199 --strictPort > qa-197-dev.log 2>&1"
ping -n 18 127.0.0.1 > nul
node qa-197-sim.mjs
set RC=%ERRORLEVEL%
taskkill /FI "WINDOWTITLE eq vite5199*" /T /F > nul 2>&1
exit /b %RC%
