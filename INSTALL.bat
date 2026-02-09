@echo off
setlocal
cd /d "%~dp0"

echo ==========================================
echo      Jessica Visual Novel Installer
echo ==========================================

:: Check if Node.js is already installed
node -v >nul 2>&1
if %errorlevel% EQU 0 (
    echo Node.js is already installed. Skipping installation.
) else (
    if exist "node.msi" (
        echo Installing Node.js...
        start /wait msiexec /i "node.msi" /passive
        echo Node.js installation finished.
        :: Attempt to add Node to PATH for this session in case it was just installed
        if exist "C:\Program Files\nodejs\" set "PATH=%PATH%;C:\Program Files\nodejs\"
    )
)

echo Installing dependencies...
call npm install

echo Starting application...
if exist "node_modules\electron\dist\electron.exe" (
    start "" "node_modules\electron\dist\electron.exe" .
) else (
    start "" npm start
)
exit