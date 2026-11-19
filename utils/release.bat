@echo off
rem SPDX-License-Identifier: GPL-3.0-or-later
rem Copyright (C) 2026 hexadec
rem
rem Builds a release zip: the minimum needed to run OpenPanopticon, plus the
rem test suite. No demo, no secrets, no runtime cache. Linux/macOS: utils/release.sh
rem
rem   utils\release.bat            version from the newest release commit
rem                                ("v1.3.3" message) or vX.X.X tag
rem   utils\release.bat 1.3.0      explicit version (with or without the v)
rem
rem Output: dist\OpenPanopticon -VX.X.X.zip
setlocal EnableExtensions
rem Run from the project root, one level up from utils\.
cd /d "%~dp0.."

where node >nul 2>nul
if errorlevel 1 (
  echo   Node.js is needed to build the release ^(it rewrites package.json^).
  exit /b 1
)

rem The newest commit in the history marked as a release: its message starts
rem with vX.X.X, or a vX.X.X tag points at it (see release-version.cjs).
set "VERSION=%~1"
if defined VERSION goto :have_version
where git >nul 2>nul
if errorlevel 1 (
  echo   git is needed to read the version ^(or pass one: utils\release.bat 1.3.3^).
  exit /b 1
)
set "FROM="
for /f "tokens=1-4" %%a in ('node "%~dp0release-version.cjs"') do (
  set "VERSION=%%a"
  set "FROM=%%b"
  set "AHEAD=%%c"
  set "KIND=%%d"
)
rem release-version.cjs has already said why on stderr.
if not defined FROM exit /b 1
echo   Version V%VERSION% from %KIND% %FROM%
if not "%AHEAD%"=="0" echo   Note: HEAD is %AHEAD% commit^(s^) past it; those changes are in this zip too.
:have_version
if /i "%VERSION:~0,1%"=="v" set "VERSION=%VERSION:~1%"
echo %VERSION%| findstr /r /x "[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*" >nul
if errorlevel 1 (
  echo   Version must look like X.X.X, got: %VERSION%
  exit /b 1
)

set "NAME=OpenPanopticon -V%VERSION%"
set "DIST=%CD%\dist"
set "STAGE=%DIST%\%NAME%"
set "ZIP=%DIST%\%NAME%.zip"

rem What ships. Everything else stays out.
set "FILES=server.js package.json package-lock.json START.bat start.sh utils\chromebook.sh .env.example README.md LICENSE"

for %%f in (%FILES%) do (
  if not exist "%%f" ( echo   Missing file: %%f & exit /b 1 )
)
if not exist "public\" ( echo   Missing folder: public & exit /b 1 )
if not exist "test\"   ( echo   Missing folder: test & exit /b 1 )

echo   Building %NAME%
if exist "%STAGE%" rmdir /s /q "%STAGE%"
if exist "%ZIP%" del /f /q "%ZIP%"
mkdir "%STAGE%\utils" || exit /b 1

for %%f in (%FILES%) do copy /y "%%f" "%STAGE%\%%f" >nul || exit /b 1

rem robocopy: exit codes below 8 mean success. /XD and /XF leave out
rem secrets, caches and the demo-only and dev-only parts of test\.
robocopy "public" "%STAGE%\public" /E /NFL /NDL /NJH /NJS /NP ^
  /XD node_modules ^
  /XF .env .DS_Store Thumbs.db *.log *.pid >nul
if errorlevel 8 ( echo   Copying public\ failed. & exit /b 1 )

robocopy "test" "%STAGE%\test" /E /NFL /NDL /NJH /NJS /NP ^
  /XD node_modules "%CD%\test\unit\demo" ^
  /XF .env .DS_Store Thumbs.db *.log *.pid ^
      demo.test.mjs demo-serve.test.mjs static-site.cjs shodan_probe.py >nul
if errorlevel 8 ( echo   Copying test\ failed. & exit /b 1 )

rem Drop the demo:* npm scripts from the shipped package.json.
node -e "const fs=require('fs'),p=process.argv[1];const pkg=JSON.parse(fs.readFileSync(p,'utf8'));for(const k of Object.keys(pkg.scripts||{}))if(k.startsWith('demo'))delete pkg.scripts[k];fs.writeFileSync(p,JSON.stringify(pkg,null,2)+'\n');" "%STAGE%\package.json"
if errorlevel 1 ( echo   Rewriting package.json failed. & exit /b 1 )

rem tar.exe ships with Windows 10 1803 and later; -a picks zip from the name.
rem Falls back to PowerShell's Compress-Archive.
pushd "%DIST%"
where tar >nul 2>nul
if not errorlevel 1 (
  tar -a -c -f "%NAME%.zip" "%NAME%"
) else (
  powershell -NoProfile -Command "Compress-Archive -Path '%NAME%' -DestinationPath '%NAME%.zip' -Force"
)
set "ZIPERR=%ERRORLEVEL%"
popd
if not "%ZIPERR%"=="0" ( echo   Creating the zip failed. & exit /b 1 )

rmdir /s /q "%STAGE%"
echo   Done: %ZIP%
endlocal
