@echo off
setlocal
cd /d "%~dp0"

echo ==========================================
echo      Jessica Visual Novel Installer
echo ==========================================

REM Check if Node.js is already installed
node -v >nul 2>&1
if %errorlevel% EQU 0 (
    echo Node.js is already installed. Skipping installation.
    goto :install_deps
) else (
    if exist "node.msi" (
        echo Installing Node.js...
        start /wait msiexec /i "node.msi" /passive
        echo Node.js installation finished.
        REM Attempt to add Node to PATH for this session in case it was just installed
        if exist "C:\Program Files\nodejs\" set "PATH=%PATH%;C:\Program Files\nodejs\"
    )
    node -v >nul 2>&1
    if %errorlevel% NEQ 0 (
        echo [ERROR] Node.js installation failed or node.msi not found.
        echo Please install Node.js manually from https://nodejs.org/
        pause
        exit /b
    )
)

:install_deps
echo.
echo [1/3] Installing dependencies...
call npm install
if %errorlevel% NEQ 0 (
    echo.
    echo [ERROR] npm install failed.
    echo Please check your internet connection or try running 'npm install' manually.
    pause
    exit /b
)

echo.
echo [2/3] Checking for Embedded AI Model...
if not exist "bot\models" mkdir "bot\models"

if exist "bot\models\model.gguf" (
    echo Model already exists.
    goto :verify_model
)

echo Downloading Llama-3.2-1B-Instruct (Small, fast local model)...
echo This file is ~800MB. Please wait...

REM Try using curl first (Windows 10/11) for a nice progress bar
where curl >nul 2>&1
if %errorlevel% EQU 0 (
    curl -L "https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_K_M.gguf" -o "bot\models\model.gguf"
) else (
    REM Fallback to PowerShell if curl is missing
    powershell -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri 'https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_K_M.gguf' -OutFile 'bot\models\model.gguf'"
)

:verify_model
if not exist "bot\models\model.gguf" (
    echo.
    echo [ERROR] Model download failed.
    echo Please manually download the file from:
    echo https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_K_M.gguf
    echo And place it in: bot\models\model.gguf
    pause
    exit /b
)

echo.
echo [3/3] Installation Complete!
echo Everything is in place.
echo.
pause

echo Starting application...
if exist "node_modules\electron\dist\electron.exe" (
    start "" "node_modules\electron\dist\electron.exe" .
) else (
    start "" npm start
)