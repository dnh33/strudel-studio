@echo off
rem Builds the Strudel Studio native app (VST3 hosting, ASIO/WASAPI audio, MIDI) with JUCE.
rem Installs the free Visual Studio Build Tools the first time if needed.
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\build-native.ps1" %*
set RESULT=%ERRORLEVEL%
echo.
if not "%RESULT%"=="0" (
  echo Build failed. The log is in native\build.log
) else (
  echo Finished. Double-click "Strudel Studio.exe" to start the app.
)
pause
exit /b %RESULT%
