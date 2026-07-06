@echo off
setlocal
cd /d "%~dp0"

set ZIP=%TEMP%\Handle.zip
set URL=https://download.sysinternals.com/files/Handle.zip

echo Downloading Sysinternals Handle from Microsoft...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Invoke-WebRequest -Uri '%URL%' -OutFile '%ZIP%'; Expand-Archive -Force -Path '%ZIP%' -DestinationPath '%CD%'"

if errorlevel 1 (
  echo Failed to download or extract Handle.
  echo You can download it manually from:
  echo https://learn.microsoft.com/sysinternals/downloads/handle
  pause
  exit /b 1
)

if exist handle64.exe (
  copy /Y handle64.exe handle.exe >nul
) else if exist handle.exe (
  rem already present
) else (
  echo Handle was extracted, but handle.exe was not found.
  pause
  exit /b 1
)

echo Installed %CD%\handle.exe
echo Restart run-fast-grid.bat after this.
pause
