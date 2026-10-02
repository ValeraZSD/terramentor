@echo off
rem Starts Terramentor with a console window, so the log is visible. The normal
rem way in is Terramentor.exe (no console); this one exists for when something
rem goes wrong and you want to see why. Both open the same app.
cd /d "%~dp0"
"%~dp0runtime\node.exe" "%~dp0desktop\launcher.js" %*
