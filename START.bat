@echo off
title OpenPanopticon - OSINT Data Fusion ^| ver. 1.0.1
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js was not found on PATH.
  echo   Install Node 18 or newer from https://nodejs.org and run this again.
  echo.
  pause
  exit /b 1
)

if not exist ".env" (
  echo   No .env found - creating one from .env.example
  copy /y ".env.example" ".env" >nul
  echo   Open .env and paste in your Shodan API key, then run this again.
  echo.
  notepad ".env"
  pause
  exit /b 0
)

start "" http://127.0.0.1:8420
node server.js
pause
