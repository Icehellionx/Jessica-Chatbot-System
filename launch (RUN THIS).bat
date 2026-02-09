@echo off
TITLE Local VN Chatbot
echo ------------------------------------------
echo  AI ROLEPLAY SKELETON LAUNCHER
echo ------------------------------------------

:: Keep the window open if there is an error
echo [1/3] Checking Node.js...
node -v
if %errorlevel% neq 0 (
    echo ERROR: Node.js not found. Install it from nodejs.org
    pause
    exit
)

echo [2/3] Checking for engines...
if not exist node_modules (
    echo No engines found. Installing...
    call npm install
)

echo [3/3] Starting App...
call npm start