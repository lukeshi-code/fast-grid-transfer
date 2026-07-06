@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found.
  echo Install Node.js from https://nodejs.org/ and run this file again.
  pause
  exit /b 1
)

if "%PORT%"=="" set PORT=3030

echo Starting Delta Packager on http://localhost:%PORT%/delta/
echo.
echo This window must stay open while building delta packages.
echo.
echo If another Fast Grid server is already running, this uses port %PORT% to avoid it.
echo.

start "" "http://localhost:%PORT%/delta/"
node server.js

pause
