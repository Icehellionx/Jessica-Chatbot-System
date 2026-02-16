'use strict';

const { app, BrowserWindow, protocol } = require('electron');
const path = require('path');
const fs = require('fs');

let paths = {};

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/* ============================================================================
   MAIN PROCESS BOOTSTRAP
   - Creates folders
   - Registers custom protocol: bot-resource://
   - Creates main window
   - Autosaves on quit
   - Loads IPC handlers
   ========================================================================== */

/* ----------------------------- ELECTRON FLAGS ---------------------------- */
/**
 * These switches are heavy-handed; keep them only if you truly need them.
 * - disable-http-cache can impact performance.
 * - autoplay-policy no-user-gesture-required is convenient but may have side effects.
 */
function ensureRequiredDirs(paths) {
  // App storage
  ensureDir(paths.userDataPath);
  ensureDir(paths.chatsPath);

  // Bot folders
  ensureDir(paths.botFilesPath);
  ensureDir(path.join(paths.botFilesPath, 'characters'));

  // Media folders (served via bot-resource)
  const mediaDirs = ['backgrounds', 'sprites', 'splash', 'music', 'sfx', 'title', 'characters'];
  for (const d of mediaDirs) ensureDir(path.join(paths.botImagesPath, d));
}

/* -------------------------- CUSTOM PROTOCOL ----------------------------- */

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'bot-resource',
    privileges: {
      secure: true,
      standard: true,
      supportFetchAPI: true,
    },
  },
]);

/**
 * Normalize a protocol URL path and prevent escaping the allowed root dir.
 */
function resolveSafeResourcePath(rootDir, requestedPath) {
  // decode + remove leading slash
  let rel = decodeURIComponent(String(requestedPath || '')).replace(/^\/+/, '');

  // Normalize to remove ../ and weird separators
  rel = rel.replace(/\\/g, '/'); // unify
  const normalized = path.normalize(rel);

  // If normalized path tries to escape, reject
  if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
    return null;
  }

  const full = path.join(rootDir, normalized);

  // Enforce root containment
  const rootResolved = path.resolve(rootDir);
  const fullResolved = path.resolve(full);
  if (!fullResolved.startsWith(rootResolved + path.sep) && fullResolved !== rootResolved) {
    return null;
  }

  return fullResolved;
}

function registerBotResourceProtocol(paths) {
  const cache = new Map(); // requestedRel -> resolved absolute

  const tryExtensions = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.mp3', '.wav', '.ogg'];
  const subdirs = ['characters', 'sprites', 'backgrounds', 'splash', 'music', 'sfx', 'title'];

  protocol.registerFileProtocol('bot-resource', (request, callback) => {
    try {
      const url = String(request.url || '');
      const rel = url.replace(/^bot-resource:\/\//, '');

      // fast cache
      if (cache.has(rel)) {
        return callback({ path: cache.get(rel) });
      }

      // 1) direct resolve under root
      let resolved = resolveSafeResourcePath(paths.botImagesPath, rel);

      // If unsafe, abort
      if (!resolved) {
        return callback({ error: -6 }); // FILE_NOT_FOUND
      }

      // 2) If not exists, try subdir fallbacks & extension fallbacks
      if (!fs.existsSync(resolved)) {
        // Try searching in known subdirectories
        for (const sub of subdirs) {
          const candidate = resolveSafeResourcePath(paths.botImagesPath, path.join(sub, rel));
          if (candidate && fs.existsSync(candidate)) {
            resolved = candidate;
            break;
          }
        }

        // Try adding extensions if still missing
        if (!fs.existsSync(resolved)) {
          for (const ext of tryExtensions) {
            if (fs.existsSync(resolved + ext)) {
              resolved = resolved + ext;
              break;
            }
          }
        }
      }

      // Still missing
      if (!fs.existsSync(resolved)) {
        return callback({ error: -6 }); // FILE_NOT_FOUND
      }

      cache.set(rel, resolved);
      return callback({ path: resolved });
    } catch (e) {
      console.error('[Protocol] bot-resource error:', e);
      return callback({ error: -2 }); // FAILED
    }
  });
}

/* ------------------------------ WINDOW ---------------------------------- */

function createWindow() {
  const win = new BrowserWindow({
    width: 1024,
    height: 768,
    backgroundColor: '#222222',
    webPreferences: {
      preload: path.join(__dirname, 'app', 'main', 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  win.loadFile('index.html');

  // win.webContents.openDevTools({ mode: 'detach' });
  return win;
}

/* ------------------------------ AUTOSAVE -------------------------------- */

function autosaveIfNeeded() {
  try {
    if (!fs.existsSync(paths.currentChatPath)) return;

    const raw = fs.readFileSync(paths.currentChatPath, 'utf8');
    if (!raw) return;

    const data = JSON.parse(raw);

    // Only autosave if thereâ€™s at least one user message
    const msgs = data?.messages;
    if (!Array.isArray(msgs) || !msgs.some(m => m?.role === 'user')) return;

    const now = new Date();
    const timestamp = now.toISOString()
      .replace(/T/, '_')
      .replace(/\..+/, '')
      .replace(/:/g, '-');

    const filename = `autosave_${timestamp}.json`;

    // Save the whole object if present; fallback to messages array if older format
    const payload = data?.messages ? data : msgs;
    fs.writeFileSync(path.join(paths.chatsPath, filename), JSON.stringify(payload, null, 2), 'utf8');

    console.log(`[Autosave] Saved to ${filename}`);
  } catch (e) {
    console.error('[Autosave] Failed:', e);
  }
}

/* ------------------------------ APP LIFECYCLE ---------------------------- */

app.whenReady().then(() => {
  app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
  app.commandLine.appendSwitch('disable-http-cache');
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

  const userDataPath = app.getPath('userData');

  paths = {
    userDataPath,
    configPath: path.join(userDataPath, 'config.json'),
    chatsPath: path.join(userDataPath, 'chats'),

    // You currently store both â€œfilesâ€ and â€œimagesâ€ under bot/files.
    // If you later split, set botImagesPath to a different directory.
    botFilesPath: path.join(__dirname, 'bot', 'files'),
    botImagesPath: path.join(__dirname, 'bot', 'files'),

    personaPath: path.join(userDataPath, 'persona.json'),
    summaryPath: path.join(userDataPath, 'summary.json'),
    currentChatPath: path.join(userDataPath, 'current-chat.json'),
    advancedPromptPath: path.join(__dirname, 'bot', 'files', 'advanced_prompt.txt'),
    characterStatePath: path.join(userDataPath, 'character_state.json'),
    lorebookPath: path.join(userDataPath, 'aura_lorebook.json'),
    voiceMapPath: path.join(userDataPath, 'voice_map.json'),
    voiceBucketsPath: path.join(userDataPath, 'voice_buckets.json'),
  };

  ensureRequiredDirs(paths);
  registerBotResourceProtocol(paths);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  require('./app/main/ipcHandlers')(paths);
});

app.on('window-all-closed', () => {
  autosaveIfNeeded();

  // On macOS apps commonly stay open; if you want that behavior:
  // if (process.platform !== 'darwin') app.quit();
  app.quit();
});

/* ------------------------------ IPC HANDLERS ----------------------------- */

