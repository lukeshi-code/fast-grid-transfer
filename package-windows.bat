@echo off
setlocal
cd /d "%~dp0"

set OUT=fast-grid-transfer.zip
if exist "%OUT%" del "%OUT%"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Compress-Archive -Force -Path 'decoder','encoder','delta','scripts','vendor','index.html','server.js','package.json','README.md','LICENSE','run-fast-grid.bat','start-delta-packager.bat' -DestinationPath '%OUT%'"

if errorlevel 1 (
  echo Failed to create %OUT%.
  pause
  exit /b 1
)

echo Created %CD%\%OUT%
pause
