@echo off
cd /d "%~dp0"

if not exist "node_modules\electron\dist\electron.exe" (
    echo Electron not found. Installing dependencies...
    call npm install
)

if exist "node_modules\electron\dist\electron.exe" (
    start "" "node_modules\electron\dist\electron.exe" .
) else (
    call npm start
    pause
)