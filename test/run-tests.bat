@echo off
rem SPDX-License-Identifier: GPL-3.0-or-later
rem Copyright (C) 2026 hexadec
rem
rem Run the OpenPanopticon test suite.
rem
rem   test\run-tests.bat [suite] [options]
rem
rem Suites:
rem   all          syntax check, unit, functional and browser tests (default)
rem   quick        unit and functional tests
rem   unit         unit tests only
rem   functional   functional (API) tests only
rem   e2e          browser tests only
rem   coverage     unit and functional tests with a coverage report
rem
rem Options:
rem   --chrome PATH   Chrome or Chromium to drive (otherwise found automatically)
rem   --cesium DIR    serve Cesium from a local copy instead of the CDN
rem   --headful       show the browser while the browser tests run
rem   --required      fail, rather than skip, when no browser is found
rem   -h, --help      show this help

setlocal EnableExtensions
set "SUITE=all"

:args
if "%~1"=="" goto argsdone
if /i "%~1"=="all"        (set "SUITE=all"        & shift & goto args)
if /i "%~1"=="quick"      (set "SUITE=quick"      & shift & goto args)
if /i "%~1"=="unit"       (set "SUITE=unit"       & shift & goto args)
if /i "%~1"=="functional" (set "SUITE=functional" & shift & goto args)
if /i "%~1"=="e2e"        (set "SUITE=e2e"        & shift & goto args)
if /i "%~1"=="coverage"   (set "SUITE=coverage"   & shift & goto args)
if /i "%~1"=="--headful"  (set "HEADFUL=1"        & shift & goto args)
if /i "%~1"=="--required" (set "E2E_REQUIRED=1"   & shift & goto args)
if /i "%~1"=="--chrome" (
  if "%~2"=="" (echo --chrome needs a path 1>&2 & exit /b 2)
  set "CHROME_PATH=%~2"
  shift & shift & goto args
)
if /i "%~1"=="--cesium" (
  if "%~2"=="" (echo --cesium needs a folder 1>&2 & exit /b 2)
  set "CESIUM_DIR=%~2"
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
echo Run the OpenPanopticon test suite.
echo.
echo   test\run-tests.bat [suite] [options]
echo.
echo Suites:
echo   all          syntax check, unit, functional and browser tests (default)
echo   quick        unit and functional tests
echo   unit         unit tests only
echo   functional   functional (API) tests only
echo   e2e          browser tests only
echo   coverage     unit and functional tests with a coverage report
echo.
echo Options:
echo   --chrome PATH   Chrome or Chromium to drive (otherwise found automatically)
echo   --cesium DIR    serve Cesium from a local copy instead of the CDN
echo   --headful       show the browser while the browser tests run
echo   --required      fail, rather than skip, when no browser is found
echo   -h, --help      show this help
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
  echo Node %NODE_MAJOR% is too old; the tests need Node 22 or newer. 1>&2
  popd & exit /b 1
)

rem The browser tests need puppeteer-core, the one dev dependency.
set "NEEDS_BROWSER="
if /i "%SUITE%"=="all" set "NEEDS_BROWSER=1"
if /i "%SUITE%"=="e2e" set "NEEDS_BROWSER=1"
if defined NEEDS_BROWSER if not exist "node_modules\puppeteer-core\" (
  echo Installing test dependencies ^(puppeteer-core^)...
  call npm install --no-audit --no-fund
  if errorlevel 1 (popd & exit /b 1)
)

if /i "%SUITE%"=="all"        call npm run test:all
if /i "%SUITE%"=="quick"      call npm test
if /i "%SUITE%"=="unit"       call npm run test:unit
if /i "%SUITE%"=="functional" call npm run test:functional
if /i "%SUITE%"=="e2e"        call npm run test:e2e
if /i "%SUITE%"=="coverage"   call npm run test:coverage
set "RESULT=%ERRORLEVEL%"

popd
exit /b %RESULT%
