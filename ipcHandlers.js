'use strict';

const { ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const aiService = require('./ai_services');

/* ============================================================================
   IPC MAIN HANDLERS (Electron)
   Responsibilities:
   - Persist config/persona/summary/lore/state/chats
   - Scan images + build manifest
   - Orchestrate send-chat (prompt + context mgmt + streaming)
   ========================================================================== */

/* ------------------------------ CONSTANTS -------------------------------- */

const CACHE_TTL_MS = 60_000;

const MEDIA_EXT_RE = /\.(png|jpg|jpeg|webp|gif|mp3|wav|ogg)$/i;

const PROVIDER_CATEGORIES = ['backgrounds', 'sprites', 'splash', 'music'];
const SPRITES_SPECIAL_PREFIXES = new Set(['sprites', 'characters', 'backgrounds', 'splash', 'music']);

const DEFAULT_PERSONA = { name: 'Jim', details: '' };
const DEFAULT_SUMMARY = { content: '' };

/* ------------------------------ FILE UTILS -------------------------------- */

function readTextSafe(filePath, fallback = '') {
  try {
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : fallback;
  } catch {
    return fallback;
  }
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Safer write:
 * - write to temp file
 * - rename into place
 * Reduces chance of file corruption on crash.
 */
function writeJsonSafe(filePath, data) {
  try {
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, filePath);
    return true;
  } catch {
    return false;
  }
}

function writeTextSafe(filePath, text) {
  try {
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, String(text ?? ''), 'utf8');
    fs.renameSync(tmp, filePath);
    return true;
  } catch {
    return false;
  }
}

function sanitizeFilename(name) {
  return String(name ?? '')
    .replace(/[^a-z0-9]/gi, '_')
    .toLowerCase()
    .slice(0, 80) || 'chat';
}

/* ------------------------------ MEDIA UTILS ------------------------------ */

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.png': 'image/png',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
  };
  return map[ext] || 'application/octet-stream';
}

/**
 * Walk a directory recursively and return "prefix/relative/path.ext" entries.
 */
function scanDirectoryRecursively(rootDir, prefix = '') {
  const results = [];
  if (!fs.existsSync(rootDir)) return results;

  try {
    const items = fs.readdirSync(rootDir, { withFileTypes: true });

    for (const item of items) {
      const full = path.join(rootDir, item.name);
      const rel = `${prefix}${item.name}`;

      if (item.isDirectory()) {
        results.push(...scanDirectoryRecursively(full, `${rel}/`));
      } else if (MEDIA_EXT_RE.test(item.name)) {
        results.push(rel);
      }
    }
  } catch (e) {
    console.error(`Error scanning ${rootDir}:`, e);
  }

  return results;
}

/**
 * Files may come from:
 * - botImagesPath/<category>/...
 * - for sprites category: also botFilesPath/characters/<char>/... (character sprites)
 *
 * Returns entries like:
 * - backgrounds/foo.png
 * - sprites/charA/happy.png
 * - characters/charB/sprite.png
 */
function listCategoryFiles({ botImagesPath, botFilesPath }, category) {
  if (category === 'sprites') {
    const a = scanDirectoryRecursively(path.join(botImagesPath, 'sprites'), 'sprites/');
    const b = scanDirectoryRecursively(path.join(botFilesPath, 'characters'), 'characters/');
    return [...a, ...b];
  }

  return scanDirectoryRecursively(path.join(botImagesPath, category), `${category}/`);
}

/**
 * Given a manifest object and category file list, ensure every file has a label entry.
 * (UI expects manifest[category][file] exists for listing.)
 */
function ensureManifestCoverage(manifest, category, files) {
  if (!manifest[category]) manifest[category] = {};
  for (const f of files) {
    if (!manifest[category][f]) manifest[category][f] = f;
  }
}

function createTreeList(files, category, manifest) {
  if (!Array.isArray(files) || files.length === 0) return null;

  const tree = {};

  for (const file of files) {
    const parts = file.split('/');
    const filename = parts.pop();
    const nameWithoutExt = path.parse(filename).name;

    // Heuristic grouping:
    // - If it's under "<knownPrefix>/<group>/file" → group = <group>
    // - else group = last folder or Common
    let group = 'Common';
    if (parts.length > 0) {
      const first = parts[0];
      if (SPRITES_SPECIAL_PREFIXES.has(first) && parts.length > 1) group = parts[1];
      else group = parts[parts.length - 1];
    }

    // Remove duplicated group prefix in filename, e.g. "jessica_happy" inside group "jessica"
    let cleanName = nameWithoutExt;
    if (group !== 'Common' && cleanName.toLowerCase().startsWith(group.toLowerCase())) {
      const potential = cleanName.slice(group.length).replace(/^[_\-\s]+/, '');
      if (potential) cleanName = potential;
    }

    if (!tree[group]) tree[group] = [];

    const desc = manifest?.[category]?.[file] ?? '';
    let entry = cleanName;

    // Append description only if it adds information vs the name
    if (desc) {
      const d = String(desc).trim();
      const dn = d.toLowerCase();
      const nn = cleanName.toLowerCase();
      if (dn && dn !== nn && !dn.includes(nn)) {
        entry += ` : ${d}`;
      }
    }

    tree[group].push(entry);
  }

  const lines = [];
  for (const group of Object.keys(tree).sort()) {
    const items = tree[group].sort().join(', ');
    lines.push(group === 'Common' ? items : `${group}: ${items}`);
  }

  return lines.join('\n');
}

/**
 * Convert a manifest entry path (like "backgrounds/foo.png" or "characters/jessica/a.png")
 * into an absolute on-disk path.
 */
function resolveMediaAbsolutePath({ botImagesPath, botFilesPath }, relativePath) {
  const parts = String(relativePath).split(/[\/\\]/);
  const rootKey = parts[0];

  // backgrounds/splash/music/sprites live under botImagesPath
  if (rootKey === 'backgrounds' || rootKey === 'splash' || rootKey === 'music' || rootKey === 'sprites') {
    return path.join(botImagesPath, relativePath);
  }

  // characters live under botFilesPath
  if (rootKey === 'characters') {
    return path.join(botFilesPath, relativePath);
  }

  // fallback (safer than assuming botFilesPath)
  return path.join(botImagesPath, relativePath);
}

/* ------------------------------ TOKEN EST -------------------------------- */

/**
 * Rough token estimate:
 * - Strings: length/4 heuristic (your original)
 * - Array content: sum of text parts + small overhead for images
 */
function estimateTokensFromMessageContent(content) {
  if (content == null) return 0;

  if (typeof content === 'string') return Math.ceil(content.length / 4);

  if (Array.isArray(content)) {
    let chars = 0;
    for (const c of content) {
      if (c?.type === 'text' && typeof c.text === 'string') chars += c.text.length;
      if (c?.type === 'image_url') chars += 200; // tiny overhead placeholder
    }
    return Math.ceil(chars / 4);
  }

  // Unknown object shape
  return Math.ceil(String(content).length / 4);
}

function estimateTokensForMessages(messages) {
  return messages.reduce((sum, m) => sum + estimateTokensFromMessageContent(m?.content), 0);
}

/* ------------------------------ CACHE ------------------------------------ */

function createCache() {
  // Separate timestamps per key to avoid “manifest refresh invalidates file lists”
  return {
    ttlMs: CACHE_TTL_MS,
    entries: new Map(), // key -> { ts, value }
    get(key) {
      const hit = this.entries.get(key);
      if (!hit) return null;
      if (Date.now() - hit.ts > this.ttlMs) return null;
      return hit.value;
    },
    set(key, value) {
      this.entries.set(key, { ts: Date.now(), value });
      return value;
    },
    invalidate(key) {
      if (key) this.entries.delete(key);
      else this.entries.clear();
    },
  };
}

/* ------------------------------ PROMPT BUILD ----------------------------- */

function filterRelevantAssets(files, recentText) {
  if (!files || files.length === 0) return [];
  // If list is small, just return it all
  if (files.length <= 30) return files;

  const text = (recentText || '').toLowerCase();
  // 1. Priority: Files mentioned in recent text
  const relevant = files.filter(f => text.includes(path.parse(f).name.toLowerCase()));
  
  // 2. Fill remaining slots with other files up to a limit (e.g. 20)
  const others = files.filter(f => !relevant.includes(f));
  return [...relevant, ...others.slice(0, 20)];
}

function buildVisualPrompt({ botImagesPath, botFilesPath }, manifest, options, recentText) {
  // Filter lists to prevent token explosion
  const allBackgrounds = listCategoryFiles({ botImagesPath, botFilesPath }, 'backgrounds');
  const backgrounds = filterRelevantAssets(allBackgrounds, recentText);
  const splashes = filterRelevantAssets(listCategoryFiles({ botImagesPath, botFilesPath }, 'splash'), recentText);
  const music = filterRelevantAssets(listCategoryFiles({ botImagesPath, botFilesPath }, 'music'), recentText);

  let sprites = listCategoryFiles({ botImagesPath, botFilesPath }, 'sprites');

  // Optional filter: only sprites for active characters
  if (Array.isArray(options?.activeCharacters) && options.activeCharacters.length) {
    const activeSet = new Set(options.activeCharacters.map(c => String(c).toLowerCase()));
    sprites = sprites.filter(file => {
      const parts = file.split(/[/\\]/);
      // sprites/<char>/... OR characters/<char>/...
      return parts.length > 2 ? activeSet.has(String(parts[1]).toLowerCase()) : true;
    });
  }

  const bgList = createTreeList(backgrounds, 'backgrounds', manifest);
  const spriteList = createTreeList(sprites, 'sprites', manifest);
  const splashList = createTreeList(splashes, 'splash', manifest);
  const musicList = createTreeList(music, 'music', manifest);

  if (!bgList && !spriteList && !splashList && !musicList) return '';

  let visualPrompt = `\n[VISUAL NOVEL MODE]`;
  if (bgList) visualPrompt += `\nBackgrounds:\n${bgList}`;
  if (spriteList) visualPrompt += `\nSprites:\n${spriteList}`;
  if (splashList) visualPrompt += `\nSplash Art:\n${splashList}`;
  if (musicList) visualPrompt += `\nMusic:\n${musicList}`;

  visualPrompt += `\n\nINSTRUCTIONS:
1. Output visual tags ONLY at the start or end of the message.
2. [BG: "name"] changes background.
3. [SPRITE: "Char/Name"] updates character.
4. [SPLASH: "name"] overrides all.
5. [MUSIC: "name"] plays background music.
6. Max 4 characters.
7. [HIDE: "Char"] removes character. [HIDE: "All"] removes everyone.
8. Sprites are STICKY. Only tag on change.`;

  return visualPrompt;
}

function buildStateInjection(characterState, activeCharacters) {
  if (!characterState || typeof characterState !== 'object') return '';
  if (!Array.isArray(activeCharacters) || !activeCharacters.length) return '';

  const keys = Object.keys(characterState);
  if (!keys.length) return '';

  let out = `\n\n[CURRENT CHARACTER STATES (DYNAMIC)]`;

  for (const char of activeCharacters) {
    const key = keys.find(k => k.toLowerCase() === String(char).toLowerCase());
    if (key && characterState[key]) {
      out += `\n${key}: ${JSON.stringify(characterState[key])}`;
    }
  }

  return out === `\n\n[CURRENT CHARACTER STATES (DYNAMIC)]` ? '' : out;
}

function buildLoreInjection(lorebook, recentMessages) {
  if (!Array.isArray(lorebook) || !lorebook.length) return '';

  const recentText = recentMessages
    .slice(-3)
    .map(m => String(m?.content ?? '').toLowerCase())
    .join(' ');

  let lines = [];

  for (const entry of lorebook) {
    const keywords = entry?.keywords;
    if (!Array.isArray(keywords) || !keywords.length) continue;

    const hit = keywords.some(k => recentText.includes(String(k).toLowerCase()));
    if (!hit) continue;

    const text = entry?.scenario || entry?.entry;
    if (text) lines.push(`- ${text}`);
  }

  return lines.length ? `\n\n[RELEVANT LORE]\n${lines.join('\n')}` : '';
}

function buildEnforcementRules({ stateInjection, loreInjection, advancedPromptContent }) {
  return `\n\n[SYSTEM ENFORCEMENT]
1. DO NOT speak for the user.
2. Maintain distinct personalities.
3. Ensure each character's voice remains consistent.
4. Manage the stage. If a character leaves, use [HIDE: Name].${stateInjection}${loreInjection}${advancedPromptContent ? `\n\n${advancedPromptContent}` : ''}`;
}

/**
 * Keeps as much recent history as possible under maxContext.
 * - Preserves (optional) first system message
 * - Appends suffix to system content (visual/enforcement)
 */
function applyContextWindow(messages, { maxContext, systemSuffix }) {
  const copy = structuredCloneSafe(messages);

  const sysIndex = copy.findIndex(m => m.role === 'system');
  const sysMsg = sysIndex > -1 ? copy[sysIndex] : null;

  const baseSysTokens = sysMsg ? estimateTokensFromMessageContent(sysMsg.content) : 0;
  const suffixTokens = Math.ceil(systemSuffix.length / 4);

  // Safety reserve so you don't hit hard model limits
  const reserve = 1000;
  const available = Math.max(0, (maxContext ?? 128000) - baseSysTokens - suffixTokens - reserve);

  const history = copy.filter((_, i) => i !== sysIndex);
  const kept = [];

  let used = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const msgTokens = estimateTokensFromMessageContent(history[i]?.content);
    if (used + msgTokens <= available) {
      kept.unshift(history[i]);
      used += msgTokens;
    } else {
      break;
    }
  }

  const out = [];
  if (sysMsg) out.push(sysMsg);
  out.push(...kept);

  // Ensure a system message exists and gets the suffix.
  const outSysIndex = out.findIndex(m => m.role === 'system');
  if (outSysIndex > -1) {
    out[outSysIndex].content = String(out[outSysIndex].content ?? '') + systemSuffix;
  } else {
    out.unshift({ role: 'system', content: systemSuffix });
  }

  return out;
}

function structuredCloneSafe(x) {
  try {
    return structuredClone(x);
  } catch {
    return JSON.parse(JSON.stringify(x));
  }
}

/* ------------------------------ MAIN EXPORT ------------------------------ */

module.exports = function registerIpcHandlers(paths) {
  const {
    configPath,
    chatsPath,
    botFilesPath,
    botImagesPath,
    personaPath,
    summaryPath,
    currentChatPath,
    advancedPromptPath,
    characterStatePath,
    lorebookPath,
  } = paths;

  const cache = createCache();

  /* ---- Config accessors ---- */

  function loadConfig() {
    return readJsonSafe(configPath, {});
  }

  function saveConfig(config) {
    return writeJsonSafe(configPath, config);
  }

  /* ---- Cached getters ---- */

  function getManifest(force = false) {
    const key = 'manifest';
    if (!force) {
      const hit = cache.get(key);
      if (hit) return hit;
    }

    const manifestPath = path.join(botFilesPath, 'images.json');
    const manifest = readJsonSafe(manifestPath, {});
    for (const k of PROVIDER_CATEGORIES) {
      if (!manifest[k]) manifest[k] = {};
    }

    return cache.set(key, manifest);
  }

  function getFiles(category, force = false) {
    const key = `files:${category}`;
    if (!force) {
      const hit = cache.get(key);
      if (hit) return hit;
    }

    const files = listCategoryFiles({ botImagesPath, botFilesPath }, category);
    return cache.set(key, files);
  }

  /* ------------------------------ IPC: BASIC ----------------------------- */

  ipcMain.handle('get-config', () => loadConfig());

  ipcMain.handle('save-api-key', (_event, provider, key, model, baseUrl) => {
    const config = loadConfig();

    config.apiKeys ??= {};
    config.models ??= {};
    config.baseUrls ??= {};

    config.apiKeys[provider] = key;

    // Only overwrite if provided (avoid deleting existing values accidentally)
    if (model) config.models[provider] = model;
    if (baseUrl) config.baseUrls[provider] = baseUrl;

    config.activeProvider = provider;

    return saveConfig(config) ? config : null;
  });

  ipcMain.handle('delete-api-key', (_event, provider) => {
    const config = loadConfig();

    if (config?.apiKeys?.[provider]) {
      delete config.apiKeys[provider];
      if (config.activeProvider === provider) delete config.activeProvider;
      saveConfig(config);
    }

    return config;
  });

  ipcMain.handle('set-active-provider', (_event, provider) => {
    const config = loadConfig();

    if (config?.apiKeys?.[provider]) {
      config.activeProvider = provider;
      return saveConfig(config);
    }
    return false;
  });

  ipcMain.handle('save-persona', (_e, persona) => writeJsonSafe(personaPath, persona));
  ipcMain.handle('get-persona', () => {
    const p = readJsonSafe(personaPath, DEFAULT_PERSONA);
    return p?.name ? p : DEFAULT_PERSONA;
  });

  ipcMain.handle('save-summary', (_e, summary) => writeJsonSafe(summaryPath, summary));
  ipcMain.handle('get-summary', () => {
    const s = readJsonSafe(summaryPath, DEFAULT_SUMMARY);
    return s?.content != null ? s : DEFAULT_SUMMARY;
  });

  ipcMain.handle('get-lorebook', () => {
    const l = readJsonSafe(lorebookPath, []);
    return Array.isArray(l) ? l : [];
  });
  ipcMain.handle('save-lorebook', (_e, content) => writeJsonSafe(lorebookPath, content));

  ipcMain.handle('get-advanced-prompt', () => readTextSafe(advancedPromptPath, ''));
  ipcMain.handle('save-advanced-prompt', (_e, prompt) => writeTextSafe(advancedPromptPath, prompt));

  ipcMain.handle('save-temperature', (_e, t) => {
    const c = loadConfig();
    c.temperature = Number(t);
    return saveConfig(c);
  });

  ipcMain.handle('save-max-context', (_e, l) => {
    const c = loadConfig();
    c.maxContext = Number.parseInt(l, 10);
    return saveConfig(c);
  });

  /* ------------------------------ IPC: FILES ----------------------------- */

  ipcMain.handle('get-images', () => ({
    backgrounds: getFiles('backgrounds'),
    sprites: getFiles('sprites'),
    splash: getFiles('splash'),
    music: getFiles('music'),
  }));

  ipcMain.handle('get-image-manifest', () => {
    const manifest = getManifest();

    // Ensure all disk files exist in manifest so UI can reference them
    for (const category of PROVIDER_CATEGORIES) {
      const files = getFiles(category);
      ensureManifestCoverage(manifest, category, files);
    }

    return manifest;
  });

  ipcMain.handle('get-bot-info', () => {
    const readBot = (rel) => readTextSafe(path.join(botFilesPath, rel), '').trim();

    const charDir = path.join(botFilesPath, 'characters');
    const characters = {};

    if (fs.existsSync(charDir)) {
      for (const entry of fs.readdirSync(charDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;

        const p = readBot(`characters/${entry.name}/personality.txt`);
        if (p) characters[entry.name] = p;
      }
    }

    return {
      personality: readBot('personality.txt'),
      scenario: readBot('scenario.txt'),
      initial: readBot('initial.txt'),
      characters,
    };
  });

  /* ------------------------------ IPC: CHATS ----------------------------- */

  ipcMain.handle('save-chat', (_event, name, messages) => {
    const safeName = sanitizeFilename(name);
    const payload = {
      messages,
      characterState: readJsonSafe(characterStatePath, {}),
      lorebook: readJsonSafe(lorebookPath, []),
      timestamp: Date.now(),
    };
    return writeJsonSafe(path.join(chatsPath, `${safeName}.json`), payload);
  });

  ipcMain.handle('get-chats', () => {
    try {
      return fs.readdirSync(chatsPath)
        .filter(f => f.endsWith('.json'))
        .map(f => f.replace('.json', ''));
    } catch {
      return [];
    }
  });

  ipcMain.handle('load-chat', (_event, name) => {
    const data = readJsonSafe(path.join(chatsPath, `${name}.json`), null);

    // New format
    if (data && data.messages) {
      if (data.characterState) writeJsonSafe(characterStatePath, data.characterState);
      if (data.lorebook) writeJsonSafe(lorebookPath, data.lorebook);
      return data.messages;
    }

    // Legacy format: raw array of messages
    return Array.isArray(data) ? data : [];
  });

  ipcMain.handle('save-current-chat', (_e, d) => writeJsonSafe(currentChatPath, d));
  ipcMain.handle('load-current-chat', () => readJsonSafe(currentChatPath, {}));

  /* ------------------------------ IPC: AI ------------------------------- */

  ipcMain.handle('test-provider', async () => aiService.testConnection(loadConfig()));

  /**
   * Character state evolution:
   * - Feeds recent messages + current state + original personalities
   * - Expects JSON only; merges into state file
   * - Extracts NewLore objects into lorebook array
   */
  ipcMain.handle('evolve-character-state', async (_event, messages, activeCharacters) => {
    if (!Array.isArray(activeCharacters) || activeCharacters.length === 0) return null;

    const config = loadConfig();

    // Include a small slice of original personality for grounding
    let originalPersonalities = '';
    for (const name of activeCharacters) {
      const charPath = path.join(botFilesPath, 'characters', name, 'personality.txt');
      if (fs.existsSync(charPath)) {
        const text = readTextSafe(charPath, '').slice(0, 1000);
        originalPersonalities += `\n[${name}'s ORIGINAL CORE PERSONALITY]\n${text}...`;
      }
    }

    const currentState = readJsonSafe(characterStatePath, {});
    const recentHistory = (messages ?? [])
      .slice(-5)
      .map(m => `${m.role}: ${String(m.content ?? '')}`)
      .join('\n');

    const systemPrompt =
      'You are a narrative engine. Update the internal psychological state of the characters based on the recent conversation. Output JSON only.';

    const userPrompt =
`[CONTEXT]
${originalPersonalities}
[CURRENT STATE]
${JSON.stringify(currentState, null, 2)}
[RECENT INTERACTION]
${recentHistory}
[INSTRUCTIONS]
Analyze the recent interaction.
Update the state for: ${activeCharacters.join(', ')}.
Fields to update:
- Mood: Current emotional baseline.
- Trust: Level of trust in the user.
- Thoughts: Internal monologue or current goal.
- NewLore: If a NEW significant fact about the world or characters is established that should be remembered long-term, output an object { "keywords": ["key1", "key2"], "scenario": "Fact description" }. Otherwise null.
Output a JSON object keyed by character name containing these fields.`;

    try {
      const responseText = await aiService.generateCompletion(config, [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ]);

      if (!responseText) return null;

      // Extract the first JSON object block (defensive)
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;

      const updates = JSON.parse(jsonMatch[0]);

      // Pull NewLore out into lorebook
      const currentLore = readJsonSafe(lorebookPath, []);
      const loreArray = Array.isArray(currentLore) ? currentLore : [];

      for (const update of Object.values(updates)) {
        if (update?.NewLore?.scenario && update?.NewLore?.keywords) {
          loreArray.push(update.NewLore);
          delete update.NewLore;
        }
      }

      writeJsonSafe(lorebookPath, loreArray);

      const merged = { ...currentState, ...updates };
      writeJsonSafe(characterStatePath, merged);
      return merged;
    } catch (e) {
      console.error('Evolution failed:', e);
      return null;
    }
  });

  /**
   * Scan images and auto-label them via vision.
   * Updates botFilesPath/images.json manifest.
   */
  ipcMain.handle('scan-images', async () => {
    const config = loadConfig();
    const settings = aiService.getProviderSettings(config);

    if (!settings.apiKey && settings.provider !== 'local') {
      return { success: false, message: 'No API key found.' };
    }

    const manifestPath = path.join(botFilesPath, 'images.json');
    const manifest = readJsonSafe(manifestPath, {});
    for (const k of PROVIDER_CATEGORIES) if (!manifest[k]) manifest[k] = {};

    let updated = false;

    const BATCH_SIZE = 3;

    async function processCategory(category) {
      const files = listCategoryFiles({ botImagesPath, botFilesPath }, category);
      const toProcess = files.filter(f => !manifest[category][f]);

      for (let i = 0; i < toProcess.length; i += BATCH_SIZE) {
        const batch = toProcess.slice(i, i + BATCH_SIZE);

        await Promise.all(batch.map(async (rel) => {
          console.log(`[Image Scan] Analyzing: ${rel}`);

          try {
            const abs = resolveMediaAbsolutePath({ botImagesPath, botFilesPath }, rel);
            const buffer = await fs.promises.readFile(abs);
            const mimeType = getMimeType(abs);

            if (mimeType.startsWith('audio/')) {
              manifest[category][rel] = 'Audio file';
              updated = true;
              return;
            }

            // Vision prompt: short VN-friendly label
            const result = await aiService.generateCompletion(
              config,
              [{
                role: 'user',
                content: [
                  { type: 'text', text: 'Describe this image in 5 words or less for a visual novel script.' },
                  { type: 'image_url', image_url: { url: `data:${mimeType};base64,${buffer.toString('base64')}` } },
                ],
              }],
              { max_tokens: 50 }
            );

            if (result) {
              manifest[category][rel] = result.trim();
              updated = true;
            }
          } catch (e) {
            console.error(`[Image Scan] Error ${rel}:`, e?.message ?? e);
          }
        }));
      }
    }

    for (const category of PROVIDER_CATEGORIES) {
      await processCategory(category);
    }

    if (updated) {
      writeJsonSafe(manifestPath, manifest);
      cache.invalidate(); // files + manifest might change
      return { success: true, message: 'Manifest updated.' };
    }

    return { success: true, message: 'No new images found.' };
  });

  /**
   * Main chat send:
   * - Builds VN visual prompt
   * - Injects enforcement + state + lore + advanced prompt
   * - Trims to max context
   * - Streams chunks back to renderer via IPC
   */
  ipcMain.handle('send-chat', async (event, messages, options = {}) => {
    const messagesCopy = structuredCloneSafe(messages ?? []);
    const config = loadConfig();
    const settings = aiService.getProviderSettings(config);

    if (!settings.apiKey && settings.provider !== 'local') {
      return 'Error: No API key found.';
    }

    const manifest = getManifest();

    // Ensure manifest covers disk files so prompt listing doesn’t miss entries
    for (const category of PROVIDER_CATEGORIES) {
      ensureManifestCoverage(manifest, category, getFiles(category));
    }

    // Extract recent text for relevance filtering
    const recentText = messagesCopy.slice(-3).map(m => m.content || '').join(' ');

    // Pass recentText to filter assets
    const visualPrompt = buildVisualPrompt({ botImagesPath, botFilesPath }, manifest, options, recentText);

    const characterState = readJsonSafe(characterStatePath, {});
    const lorebook = readJsonSafe(lorebookPath, []);

    const stateInjection = buildStateInjection(characterState, options?.activeCharacters);
    const loreInjection = buildLoreInjection(lorebook, messagesCopy);

    const advancedPromptContent = readTextSafe(advancedPromptPath, '').trim();

    const enforcementRules = buildEnforcementRules({
      stateInjection,
      loreInjection,
      advancedPromptContent,
    });

    const systemSuffix = visualPrompt + enforcementRules;

    // Trim history to context budget
    const maxContext = Number(config.maxContext) || 128000;
    const finalMessages = applyContextWindow(messagesCopy, { maxContext, systemSuffix });

    const webContents = event.sender;

    try {
      const temperature =
        config.temperature !== undefined ? Number(config.temperature) : 0.7;

      const fullText = await aiService.generateStream(
        config,
        finalMessages,
        (chunk) => webContents.send('chat-reply-chunk', chunk),
        { temperature }
      );

      return fullText || 'Error: No response from AI.';
    } catch (error) {
      console.error('API Error:', error?.message ?? error);
      return `Error: ${error?.message ?? error}`;
    }
  });
};
