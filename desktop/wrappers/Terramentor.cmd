@echo off
rem Starts Terramentor with a console window, so the log is visible. The normal
rem way in is Terramentor.exe (no console); this one exists for when something
rem goes wrong and you want to see why. Both open the same app.
rem A course file named after it opens in the app; a relative one is read
rem against the folder you started from, which the launcher learns here.
set "TERRAMENTOR_CWD=%CD%"
cd /d "%~dp0"
"%~dp0runtime\node.exe" "%~dp0desktop\launcher.js" %*
