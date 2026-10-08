@echo off
REM Run the #150 divider harness against a throwaway dev server.
REM
REM VITE_E2E=1 is what exposes window.__caseMaker (src/testing/windowApi.ts), and
REM it has to be set on its OWN LINE: inlining it as `cmd /c "set VITE_E2E=1&&
REM npx vite ..."` inside `start` silently loses it, and the run then dies at the
REM first waitForFunction with the page still on the Welcome screen.
cd /d "C:\Projects\Case Maker\casemaker-app"
set VITE_E2E=1
start "vite5198" /min cmd /c "npx vite --port 5198 --strictPort > qa-150-dev.log 2>&1"
ping -n 18 127.0.0.1 > nul
node qa-150-dividers.mjs
set RC=%ERRORLEVEL%
taskkill /FI "WINDOWTITLE eq vite5198*" /T /F > nul 2>&1
exit /b %RC%
