@echo off
rem SPDX-License-Identifier: GPL-3.0-or-later
rem Copyright (C) 2026 hexadec
rem
rem OPENPANOPTICON launcher for Windows. Linux, macOS, Chromebook: start.sh
setlocal
title OpenPanopticon - OSINT Data Fusion
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js was not found on PATH.
  echo   Install Node 22 or newer from https://nodejs.org and run this again.
  echo.
  pause
  exit /b 1
)

for /f %%v in ('node -p "process.versions.node.split('.')[0]"') do set "NODE_MAJOR=%%v"
if %NODE_MAJOR% LSS 22 (
  echo.
  echo   Node is too old. OpenPanopticon needs Node 22 or newer.
  echo   Install a current version from https://nodejs.org and run this again.
  echo.
  pause
  exit /b 1
)

if not exist ".env" (
  echo   No .env found - creating one from .env.example
  copy /y ".env.example" ".env" >nul
  echo.
  echo   Add your Shodan API key to .env to enable the Shodan layer.
  echo   Every other source works without a key, so it starts either way.
  echo.
  choice /c YN /n /m "  Open .env in Notepad now? [Y/N] "
  if not errorlevel 2 notepad ".env"
)

rem The server opens the browser itself once it is listening, on the PORT
rem and HOST from .env.
set "OPENPANOPTICON_OPEN_BROWSER=1"
node server.js
pause
