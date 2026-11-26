@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if %errorlevel% neq 0 (
  echo.
  echo [ERROR] Node.js ^(v18+^) not found.
  echo [TIP] Please install Node.js LTS from https://nodejs.org/ and run this script again.
  echo       Or run in PowerShell: winget install OpenJS.NodeJS.LTS
  echo.
  pause
  exit /b 1
)

node "%~dp0scripts\cli.mjs" %*
if %errorlevel% neq 0 (
  echo.
  pause
)
endlocal
