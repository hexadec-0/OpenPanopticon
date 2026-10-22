@echo off
rem SPDX-License-Identifier: GPL-3.0-or-later
rem Copyright (C) 2026 hexadec
rem
rem Build and run the static New York demo locally.
rem
rem   demo\run-demo.bat [command] [options]
rem
rem Commands:
rem   serve      rebuild the site from the snapshot in docs\ and serve it (default)
rem   capture    capture a fresh snapshot (needs .env and internet), build, serve
rem   maps       re-fetch only the map tiles into docs\, keeping the layer data,
rem              then build and serve
rem   quick      build from the test suite's fake data into a temp folder and
rem              serve that: seconds, no keys, no tiles (the globe stays dark)
rem   build      rebuild docs\ from the snapshot, don't serve
rem
rem Options:
rem   --port N   port to serve on (default 8080)
rem   --root     serve at / instead of /OpenPanopticon/ (the GitHub Pages path)
rem   --no-open  don't open a browser
rem   -h, --help show this help

setlocal EnableExtensions
set "CMD=serve"
set "PORT=8080"
set "BASE=/OpenPanopticon/"
set "OPEN=--open"

:args
if "%~1"=="" goto argsdone
if /i "%~1"=="serve"     (set "CMD=serve"   & shift & goto args)
if /i "%~1"=="capture"   (set "CMD=capture" & shift & goto args)
if /i "%~1"=="maps"      (set "CMD=maps"    & shift & goto args)
if /i "%~1"=="quick"     (set "CMD=quick"   & shift & goto args)
if /i "%~1"=="build"     (set "CMD=build"   & shift & goto args)
if /i "%~1"=="--root"    (set "BASE=/"      & shift & goto args)
if /i "%~1"=="--no-open" (set "OPEN="       & shift & goto args)
if /i "%~1"=="--port" (
  if "%~2"=="" (echo --port needs a number 1>&2 & exit /b 2)
  set "PORT=%~2"
  shift & shift & goto args
)
if /i "%~1"=="-h"     goto usage
if /i "%~1"=="--help" goto usage
echo Unknown argument: %~1 1>&2
call :showusage 1>&2
exit /b 2

:usage
call :showusage
exit /b 0

:showusage
echo Build and run the static New York demo locally.
echo.
echo   demo\run-demo.bat [command] [options]
echo.
echo Commands:
echo   serve      rebuild the site from the snapshot in docs\ and serve it (default)
echo   capture    capture a fresh snapshot (needs .env and internet), build, serve
echo   maps       re-fetch only the map tiles into docs\, keeping the layer data,
echo              then build and serve
echo   quick      build from the test suite's fake data into a temp folder and
echo              serve that: seconds, no keys, no tiles (the globe stays dark)
echo   build      rebuild docs\ from the snapshot, don't serve
echo.
echo Options:
echo   --port N   port to serve on (default 8080)
echo   --root     serve at / instead of /OpenPanopticon/ (the GitHub Pages path)
echo   --no-open  don't open a browser
echo   -h, --help show this help
goto :eof

:argsdone
rem Run from the project root, wherever the script was called from.
pushd "%~dp0.." || exit /b 1

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node 22 or newer. 1>&2
  popd & exit /b 1
)
for /f %%V in ('node -p "process.versions.node.split('.')[0]"') do set "NODE_MAJOR=%%V"
if %NODE_MAJOR% LSS 22 (
  echo Node %NODE_MAJOR% is too old; the demo tools need Node 22 or newer. 1>&2
  popd & exit /b 1
)

set "SITE=docs"
if /i "%CMD%"=="capture" goto capture
if /i "%CMD%"=="quick" goto quick
if /i "%CMD%"=="maps" goto maps

if not exist "docs\data\manifest.json" (
  echo No snapshot in docs\ yet. 1>&2
  echo   demo\run-demo.bat capture   captures one ^(needs .env and internet^) 1>&2
  echo   demo\run-demo.bat quick     tries the demo on fake data instead 1>&2
  popd & exit /b 1
)
call node demo\build.mjs || (popd & exit /b 1)
goto built

:capture
call node demo\capture.mjs || (popd & exit /b 1)
call node demo\build.mjs || (popd & exit /b 1)
goto built

:maps
call node demo\capture.mjs --maps-only || (popd & exit /b 1)
call node demo\build.mjs || (popd & exit /b 1)
goto built

:quick
set "SITE=%TEMP%\openpanopticon-demo-quick"
if exist "%SITE%" rmdir /s /q "%SITE%"
call node demo\capture.mjs --fixtures --out "%SITE%" || (popd & exit /b 1)
call node demo\build.mjs --out "%SITE%" || (popd & exit /b 1)

:built
if /i "%CMD%"=="build" (popd & exit /b 0)
node demo\serve.mjs --dir "%SITE%" --port %PORT% --base "%BASE%" %OPEN%
set "RESULT=%ERRORLEVEL%"
popd
exit /b %RESULT%
