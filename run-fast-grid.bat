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

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$port=%PORT%; $conns=Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue; foreach($conn in $conns){ $proc=Get-CimInstance Win32_Process -Filter \"ProcessId=$($conn.OwningProcess)\"; if($proc.CommandLine -match 'node(\\.exe)?\\s+server\\.js'){ Write-Host \"Stopping old Fast Grid server on port $port\"; Stop-Process -Id $conn.OwningProcess -Force } }"

echo Starting Fast Grid Transfer on http://localhost:%PORT%/
echo.
echo Encoder: http://localhost:%PORT%/encoder/
echo Decoder: http://localhost:%PORT%/decoder/
echo Delta Packager: http://localhost:%PORT%/delta/
echo.
echo Keep this window open while using the tool.
echo.

start "" "http://localhost:%PORT%/"
node server.js

pause
