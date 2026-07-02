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

if "%PORT%"=="" set PORT=3001

echo Starting Fast Grid Transfer on http://localhost:%PORT%/
echo.
echo Encoder: http://localhost:%PORT%/encoder/
echo Decoder: http://localhost:%PORT%/decoder/
echo.
echo Keep this window open while using the tool.
echo.

start "" "http://localhost:%PORT%/"
node server.js

pause
