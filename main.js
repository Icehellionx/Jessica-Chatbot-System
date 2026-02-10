const { app, BrowserWindow, protocol } = require('electron');
const path = require('path');
const fs = require('fs');

// Fix for "Unable to move the cache" errors on Windows
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
app.commandLine.appendSwitch('disable-http-cache');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const userDataPath = app.getPath('userData');
const configPath = path.join(userDataPath, 'config.json');
const chatsPath = path.join(userDataPath, 'chats');
const botFilesPath = path.join(__dirname, 'bot', 'files');
const botImagesPath = path.join(__dirname, 'bot', 'files');
const personaPath = path.join(userDataPath, 'persona.json');
const summaryPath = path.join(userDataPath, 'summary.json');
const currentChatPath = path.join(userDataPath, 'current-chat.json');
const advancedPromptPath = path.join(botFilesPath, 'advanced_prompt.txt');
const characterStatePath = path.join(userDataPath, 'character_state.json');
const lorebookPath = path.join(userDataPath, 'aura_lorebook.json');

// Ensure bot files directory exists
if (!fs.existsSync(botFilesPath)) {
    fs.mkdirSync(botFilesPath, { recursive: true });
}

if (!fs.existsSync(path.join(botImagesPath, 'backgrounds'))) {
    fs.mkdirSync(path.join(botImagesPath, 'backgrounds'), { recursive: true });
}
if (!fs.existsSync(path.join(botImagesPath, 'sprites'))) {
    fs.mkdirSync(path.join(botImagesPath, 'sprites'), { recursive: true });
}
if (!fs.existsSync(path.join(botFilesPath, 'characters'))) {
    fs.mkdirSync(path.join(botFilesPath, 'characters'), { recursive: true });
}
if (!fs.existsSync(path.join(botImagesPath, 'splash'))) {
    fs.mkdirSync(path.join(botImagesPath, 'splash'), { recursive: true });
}
if (!fs.existsSync(path.join(botFilesPath, 'music'))) {
    fs.mkdirSync(path.join(botFilesPath, 'music'), { recursive: true });
}
if (!fs.existsSync(path.join(botImagesPath, 'title'))) {
    fs.mkdirSync(path.join(botImagesPath, 'title'), { recursive: true });
}

if (!fs.existsSync(chatsPath)) {
    fs.mkdirSync(chatsPath);
}

// Register the custom protocol as privileged so it works like a standard URL
protocol.registerSchemesAsPrivileged([
    { scheme: 'bot-resource', privileges: { secure: true, standard: true, supportFetchAPI: true, bypassCSP: true } }
]);

function createWindow() {
    const win = new BrowserWindow({
        width: 1024,
        height: 768,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true
        }
    });

    win.loadFile('index.html');
    // win.webContents.openDevTools(); // Uncomment for debugging
}

app.whenReady().then(() => {
    const pathCache = new Map();

    // Register protocol to serve images from bot/pictures
    protocol.registerFileProtocol('bot-resource', (request, callback) => {
        let url = request.url.replace('bot-resource://', '');
        
        // Remove leading slash if present (e.g. bot-resource:///path)
        if (url.startsWith('/')) {
            url = url.slice(1);
        }

        const decodedUrl = decodeURIComponent(url);
        if (pathCache.has(decodedUrl)) {
            return callback(pathCache.get(decodedUrl));
        }

        let fullPath = path.join(botImagesPath, decodedUrl);

        // Smart Fallback: If exact file doesn't exist, try adding extensions
        if (!fs.existsSync(fullPath)) {
            
            // 1. Try searching in subdirectories (for short paths like "Jessica/happy.png")
            const subdirs = ['characters', 'sprites', 'backgrounds', 'splash', 'music', 'title'];
            for (const subdir of subdirs) {
                const subPath = path.join(botImagesPath, subdir, decodedUrl);
                if (fs.existsSync(subPath)) {
                    fullPath = subPath;
                    break;
                }
            }

            const extensions = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.mp3', '.wav', '.ogg'];
            for (const ext of extensions) {
                if (fs.existsSync(fullPath + ext)) {
                    fullPath = fullPath + ext;
                    break;
                }
            }
        }

        try {
            pathCache.set(decodedUrl, fullPath);
            return callback(fullPath);
        } catch (error) {
            console.error('Failed to register protocol', error);
        }
    });

    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    // Autosave current chat before quitting
    try {
        if (fs.existsSync(currentChatPath)) {
            const data = JSON.parse(fs.readFileSync(currentChatPath, 'utf8'));
            // Only autosave if there is actual conversation history (at least one user message)
            if (data.messages && Array.isArray(data.messages) && data.messages.some(m => m.role === 'user')) {
                const now = new Date();
                const timestamp = now.toISOString().replace(/T/, '_').replace(/\..+/, '').replace(/:/g, '-');
                const filename = `autosave_${timestamp}.json`;
                fs.writeFileSync(path.join(chatsPath, filename), JSON.stringify(data.messages, null, 2));
                console.log(`[Autosave] Chat history saved to ${filename}`);
            }
        }
    } catch (e) {
        console.error("[Autosave] Failed to save chat history:", e);
    }
    app.quit();
});

// --- Load IPC Handlers ---
const paths = {
    userDataPath,
    configPath,
    chatsPath,
    botFilesPath,
    botImagesPath,
    personaPath,
    summaryPath,
    currentChatPath,
    advancedPromptPath,
    characterStatePath,
    lorebookPath
};
require('./ipcHandlers')(paths);