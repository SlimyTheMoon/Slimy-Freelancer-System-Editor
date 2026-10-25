@echo off
setlocal
title Freelancer System Editor
cd /d "%~dp0"
rem Uses Node.js from PATH if installed, otherwise the bundled runtime\node.exe
where node >nul 2>nul
if %errorlevel%==0 (
  node server.js %*
) else if exist "%~dp0runtime\node.exe" (
  "%~dp0runtime\node.exe" server.js %*
) else (
  echo Node.js was not found. Install Node.js 18+ from https://nodejs.org or put node.exe in the runtime folder.
  pause
  exit /b 1
)
if errorlevel 1 pause
