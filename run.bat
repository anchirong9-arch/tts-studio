@echo off
rem English-named launcher (same as 실행하기.bat) in case the Korean filename is mangled.
chcp 65001 >nul 2>nul
setlocal
cd /d "%~dp0"
title TTS Studio - local server
color 0B

echo ==========================================================
echo    TTS Studio  -  Korean TTS + subtitles
echo ==========================================================
echo.

if not exist "server.py" goto no_files

set "PYEXE="
where py >nul 2>nul
if errorlevel 1 goto try_python
py -3 -c "import sys" >nul 2>nul
if errorlevel 1 goto try_python
set "PYEXE=py -3"
goto python_ready

:try_python
where python >nul 2>nul
if errorlevel 1 goto no_python
set "PYEXE=python"

:python_ready
%PYEXE% -c "import sys;sys.exit(0 if sys.version_info>=(3,8) else 1)" >nul 2>nul
if errorlevel 1 goto old_python

if exist ".venv\Scripts\python.exe" goto have_venv
echo [1/3] First run: creating virtual environment (1-2 min)...
%PYEXE% -m venv .venv
if errorlevel 1 goto venv_fail
goto check_pkg

:have_venv
echo [1/3] Found existing environment.

:check_pkg
".venv\Scripts\python.exe" -c "import edge_tts" >nul 2>nul
if not errorlevel 1 goto run_server

echo [2/3] Installing required package (edge-tts)...
".venv\Scripts\python.exe" -m pip install --disable-pip-version-check -q -r requirements.txt
if errorlevel 1 goto pip_fail
goto run_server

:run_server
echo [3/3] Starting server. A browser window will open shortly.
echo.
echo    * Closing this window stops the server.
echo    * Address: http://127.0.0.1:8765
echo.
".venv\Scripts\python.exe" server.py
goto end

:no_files
echo [ERROR] server.py not found. Please run this from the unzipped folder.
echo.
pause
goto end

:no_python
echo.
echo [ERROR] Python is not installed.
echo   1) Open https://www.python.org/downloads/windows/
echo   2) Install Python 3.12
echo   3) Check "Add python.exe to PATH" during setup
echo   4) Close this window and run this file again
echo.
pause
goto end

:old_python
echo.
echo [ERROR] Python 3.8 or newer is required.
echo.
pause
goto end

:venv_fail
echo.
echo [ERROR] Could not create .venv. Try unzipping to a simple path like C:\tts-studio
echo.
pause
goto end

:pip_fail
echo.
echo [ERROR] Package install failed. Check your internet connection and try again.
echo.
pause
goto end

:end
echo.
echo Server stopped. You can close this window.
pause >nul
exit /b 0
