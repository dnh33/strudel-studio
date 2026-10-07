@echo off
title Strudel Studio
cd /d "%~dp0"
if not exist "app\index.html" (
  echo The prebuilt app folder is missing. Run "npm install" and then "npm run build" first.
  pause
  exit /b 1
)
echo Starting Strudel Studio...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\serve.ps1" -Port 5190
if errorlevel 1 (
  echo.
  echo The built-in server could not start. Alternatives:
  echo   - with Node.js installed:  npm install  then  npm run preview
  echo   - with Python installed:   python -m http.server 5190 --directory app
  pause
)
