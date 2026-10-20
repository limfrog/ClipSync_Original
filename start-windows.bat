@echo off
cd /d "%~dp0"
echo ==============================================
echo   ClipSync - Windows Desktop Tray Launcher
echo ==============================================

where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
  echo [Error] Node.js is not installed or not in PATH.
  echo Please install Node.js (v18+) from https://nodejs.org
  pause
  exit /b 1
)

cd desktop
if not exist "node_modules" (
  echo [Info] Installing dependencies for first-time setup...
  call npm install
)

echo [Info] Starting ClipSync Desktop App...
call npm start
