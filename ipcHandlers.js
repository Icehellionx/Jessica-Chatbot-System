'use strict';

const { ipcMain, nativeImage, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const aiService = require('./ai_services');
const axios = require('axios');
const { execFile } = require('child_process');
const os = require('os');
const { createConfigStore } = require('./ipc/config-store');
const { createChatStorage } = require('./ipc/chat-storage');
const { sanitizeFilename } = require('./ipc/sanitize');
const contextWindow = require('./ipc/context-window');
const trace = require('./ipc/trace');
const { registerConfigHandlers } = require('./ipc/handlers-config');
const { registerChatHandlers } = require('./ipc/handlers-chat');
const { registerMediaHandlers } = require('./ipc/handlers-media');
const { registerVoiceHandlers } = require('./ipc/handlers-voice');
const { registerAiHandlers } = require('./ipc/handlers-ai');

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

const PROVIDER_CATEGORIES = ['backgrounds', 'sprites', 'splash', 'music', 'sfx'];
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
    try {
      fs.renameSync(tmp, filePath);
    } catch (e) {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        fs.renameSync(tmp, filePath);
      } else {
        throw e;
      }
    }
    return true;
  } catch (e) {
    console.error(`[FileIO] Failed to write JSON to ${filePath}:`, e);
    return false;
  }
}

function writeTextSafe(filePath, text) {
  try {
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, String(text ?? ''), 'utf8');
    try {
      fs.renameSync(tmp, filePath);
    } catch (e) {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        fs.renameSync(tmp, filePath);
      } else {
        throw e;
      }
    }
    return true;
  } catch (e) {
    console.error(`[FileIO] Failed to write text to ${filePath}:`, e);
    return false;
  }
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
  // Destructure with defaults
  const { activeCharacters = [], inventory = [], sceneObjects = [] } = options;

  // Filter lists to prevent token explosion
  const allBackgrounds = listCategoryFiles({ botImagesPath, botFilesPath }, 'backgrounds');
  const backgrounds = filterRelevantAssets(allBackgrounds, recentText);
  const splashes = filterRelevantAssets(listCategoryFiles({ botImagesPath, botFilesPath }, 'splash'), recentText);
  const music = filterRelevantAssets(listCategoryFiles({ botImagesPath, botFilesPath }, 'music'), recentText);

  // --- Sprite Filtering Logic ---
  const allSprites = listCategoryFiles({ botImagesPath, botFilesPath }, 'sprites');
  const activeChars = new Set(activeCharacters.map(c => String(c).toLowerCase()));
  
  const visibleSprites = [];
  const availableGroups = new Set();

  for (const file of allSprites) {
    const parts = file.split('/');
    parts.pop(); // remove filename to look at directory structure
    
    let group = 'Common';
    if (parts.length > 0) {
      const first = parts[0];
      if (SPRITES_SPECIAL_PREFIXES.has(first) && parts.length > 1) group = parts[1];
      else group = parts[parts.length - 1];
    }

    availableGroups.add(group);

    // If group is Common or Active, include it
    if (group === 'Common' || activeChars.has(group.toLowerCase())) {
      visibleSprites.push(file);
    }
  }
  
  // Calculate inactive characters (Available but not shown)
  const inactiveChars = [...availableGroups].filter(g => g !== 'Common' && !activeChars.has(g.toLowerCase())).sort();

  const bgList = createTreeList(backgrounds, 'backgrounds', manifest);
  const spriteList = createTreeList(visibleSprites, 'sprites', manifest);
  const splashList = createTreeList(splashes, 'splash', manifest);
  const musicList = createTreeList(music, 'music', manifest);

  let visualPrompt = `\n[VISUAL NOVEL MODE]`;
  if (bgList) visualPrompt += `\nBackgrounds:\n${bgList}`;
  
  if (spriteList) visualPrompt += `\nSprites (Active):\n${spriteList}`;
  
  if (inactiveChars.length > 0) {
    visualPrompt += `\nCharacters (Inactive - Summon with [SPRITE: Name]):\n${inactiveChars.join(', ')}`;
  }

  if (splashList) visualPrompt += `\nSplash Art:\n${splashList}`;
  if (musicList) visualPrompt += `\nMusic:\n${musicList}`;

  // Add Inventory and Scene Objects to the prompt
  if (sceneObjects.length > 0) {
    visualPrompt += `\n\n[SCENE_OBJECTS]\n- ${sceneObjects.join('\n- ')}`;
  }
  if (inventory.length > 0) {
    visualPrompt += `\n\n[PLAYER_INVENTORY]\n- You are carrying: ${inventory.join(', ')}`;
  }

  visualPrompt += `\n\nINSTRUCTIONS:
1. Start your response with a [SCENE] ... [/SCENE] block.
2. Inside the block, list ALL visual changes for this turn:
   - [BG: "name"] for background.
   - [SPRITE: "Name/Emotion"] for active characters.
   - [HIDE: "Name"] to remove characters.
   - [MUSIC: "name"] for audio.
   - [FX: "name"] for effects.
3. [SPLASH: "name"] overrides all.
4. Max 4 characters on screen.
5. Sprites are STICKY. Only tag on change.
6. After [/SCENE], write the dialogue/narration.
7. STRICTLY format dialogue as Name: "Speech".`;

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

/* ------------------------------ SEMANTIC LORE ---------------------------- */

const loreEmbeddingCache = new Map(); // text -> number[]
let embeddingsLoaded = false;

function loadEmbeddings(filePath) {
  if (embeddingsLoaded) return;
  const data = readJsonSafe(filePath, {});
  for (const [k, v] of Object.entries(data)) {
    loreEmbeddingCache.set(k, v);
  }
  embeddingsLoaded = true;
}

function saveEmbeddings(filePath) {
  const obj = Object.fromEntries(loreEmbeddingCache);
  writeJsonSafe(filePath, obj);
}

function cosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dot += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function buildLoreInjection(lorebook, recentMessages, config, embeddingsPath) {
  if (!Array.isArray(lorebook) || !lorebook.length) return '';

  // Load cache from disk if not already loaded
  if (embeddingsPath) loadEmbeddings(embeddingsPath);

  // 1. Prepare Query
  const recentText = recentMessages
    .slice(-2) // Use last 2 messages for context
    .map(m => String(m?.content ?? '').toLowerCase())
    .join('\n');

  if (!recentText.trim()) return '';

  // 2. Get Query Embedding
  const queryEmbedding = await aiService.generateEmbedding(config, recentText);
  
  // Fallback to simple keyword matching if embeddings fail (e.g. no API support)
  if (!queryEmbedding) {
    return buildLoreInjectionKeywords(lorebook, recentText);
  }

  // 3. Identify & Fetch Missing Embeddings (Parallel)
  const missing = [];
  for (const entry of lorebook) {
    const text = entry?.scenario || entry?.entry;
    if (text && !loreEmbeddingCache.has(text)) {
      missing.push(text);
    }
  }

  if (missing.length > 0) {
    console.log(`[RAG] Generating embeddings for ${missing.length} new lore entries...`);
    await Promise.all(missing.map(async (text) => {
      const emb = await aiService.generateEmbedding(config, text);
      if (emb) loreEmbeddingCache.set(text, emb);
    }));
    if (embeddingsPath) saveEmbeddings(embeddingsPath);
  }

  let lines = [];
  const candidates = [];

  for (const entry of lorebook) {
    const text = entry?.scenario || entry?.entry;
    if (!text) continue;

    // Get Embedding (now guaranteed to be in cache if generation succeeded)
    let embedding = loreEmbeddingCache.get(text);
    if (embedding) {
      const score = cosineSimilarity(queryEmbedding, embedding);
      // Threshold: 0.5 is usually decent for RAG, adjust as needed
      if (score > 0.5) {
        candidates.push({ text, score });
      }
    }
  }

  // Sort by relevance and take top 3
  candidates.sort((a, b) => b.score - a.score);
  lines = candidates.slice(0, 3).map(c => `- ${c.text}`);

  return lines.length ? `\n\n[RELEVANT LORE (Semantic)]\n${lines.join('\n')}` : '';
}

// Legacy keyword fallback
function buildLoreInjectionKeywords(lorebook, recentText) {
  const lines = [];
  for (const entry of lorebook) {
    const keywords = entry?.keywords;
    if (!Array.isArray(keywords) || !keywords.length) continue;
    if (keywords.some(k => recentText.includes(String(k).toLowerCase()))) {
      const text = entry?.scenario || entry?.entry;
      if (text) lines.push(`- ${text}`);
    }
  }
  return lines.length ? `\n\n[RELEVANT LORE]\n${lines.join('\n')}` : '';
}

function buildEnforcementRules({ stateInjection, loreInjection, advancedPromptContent }) {
  return `\n\n[SYSTEM ENFORCEMENT]
1. DO NOT speak for the user.
2. Maintain distinct personalities.
3. Ensure each character's voice remains consistent.
4. Manage the stage. If a character leaves, use [HIDE: Name].
5. To add a new object to the scene, use [ADD_OBJECT: "name"].
6. If the user takes an object, you MUST use [TAKE: "name"].
7. To drop an inventory item, use [DROP: "name"].
8. Dialogue MUST be in script format (Name: "Speech").${stateInjection}${loreInjection}${advancedPromptContent ? `\n\n${advancedPromptContent}` : ''}`;
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

/* ------------------------------ AUDIO ANALYSIS --------------------------- */

function getWavSamples(buffer) {
  // Simple WAV parser for 16-bit mono/stereo
  if (buffer.length < 44) return null;
  
  const channels = buffer.readUInt16LE(22);
  const sampleRate = buffer.readUInt32LE(24);
  const bitsPerSample = buffer.readUInt16LE(34);
  
  if (bitsPerSample !== 16) return null; 

  // Find data chunk
  let offset = 12;
  while (offset < buffer.length - 8) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    if (chunkId === 'data') {
      offset += 8;
      const samples = [];
      // Read up to 2.0 seconds of audio for analysis (skip silence/short clips)
      const maxSamples = sampleRate * 2.0;
      const end = Math.min(offset + chunkSize, offset + maxSamples * 2 * channels);
      
      for (let i = offset; i < end; i += 2 * channels) {
        // Read Int16, normalize to -1..1
        const val = buffer.readInt16LE(i) / 32768.0;
        samples.push(val);
      }
      if (samples.length === 0) return null;
      return { sampleRate, samples };
    }
    offset += 8 + chunkSize;
  }
  return null;
}

function estimatePitch(samples, sampleRate) {
  // 1. Find the loudest 100ms window to avoid silence
  const windowSize = Math.floor(sampleRate * 0.1); 
  if (samples.length < windowSize) return 0;

  let maxRMS = 0;
  let bestOffset = 0;
  const step = Math.floor(windowSize / 2);

  for (let i = 0; i < samples.length - windowSize; i += step) {
    let sumSq = 0;
    for (let j = 0; j < windowSize; j++) {
      const s = samples[i + j];
      sumSq += s * s;
    }
    const rms = Math.sqrt(sumSq / windowSize);
    if (rms > maxRMS) { maxRMS = rms; bestOffset = i; }
  }

  if (maxRMS < 0.02) return 0; // Too quiet
  const slice = samples.slice(bestOffset, bestOffset + windowSize);
  
  const minPeriod = Math.floor(sampleRate / 400); // Max freq 400Hz
  const maxPeriod = Math.floor(sampleRate / 70);  // Min freq 70Hz

  let bestPeriod = 0;
  let maxCorr = -Infinity;

  for (let period = minPeriod; period <= maxPeriod; period++) {
    let sum = 0;
    const n = slice.length - period;
    for (let i = 0; i < n; i++) {
      sum += slice[i] * slice[i + period];
    }
    
    // Normalize by number of terms to avoid bias toward small lags
    const corr = sum / n;

    if (corr > maxCorr) {
      maxCorr = corr;
      bestPeriod = period;
    }
  }
  
  if (bestPeriod === 0) return 0;
  return sampleRate / bestPeriod;
}

async function checkVoiceGender(piperPath, modelPath, cwd, speakerId, targetGender, tempDir) {
  const tempFile = path.join(tempDir, `pitch_test_${Date.now()}_${speakerId}.wav`);
  try {
    await new Promise((resolve, reject) => {
       // Use a longer phrase to ensure we catch the pitch
       const phrase = "This is a longer sentence to ensure we have enough audio data to detect the pitch accurately.";
       const child = execFile(piperPath, ['--model', modelPath, '--speaker', String(speakerId), '--output_file', tempFile], { cwd, windowsHide: true }, (err) => err ? reject(err) : resolve());
       if (child.stdin) { child.stdin.write(phrase); child.stdin.end(); }
    });

    if (!fs.existsSync(tempFile)) return false;

    const buffer = await fs.promises.readFile(tempFile);
    try { await fs.promises.unlink(tempFile); } catch {}
    
    const wav = getWavSamples(buffer);
    if (!wav) return false;
    if (!wav || wav.samples.length === 0) return false;

    const pitch = estimatePitch(wav.samples, wav.sampleRate);
    return pitch; // Return raw pitch for comparison
  } catch (e) {
    return 0;
  }
}

function getVoiceBuckets(voiceBucketsPath) {
  return readJsonSafe(voiceBucketsPath, { male: [], female: [] });
}

/* ------------------------------ VOICE ASSIGNMENT ------------------------- */

function getVoiceMap(voiceMapPath, botFilesPath) {
  // 1. Hardcoded defaults
  let map = {
    narrator: 0,
    jessica: 10,
    danny: 20,
    jake: 30,
    natasha: 40,
    suzie: 50,
    character_generic_male: 5,
    character_generic_female: 0
  };

  // 2. Override with voice.txt (Character Defaults)
  if (botFilesPath) {
    try {
      const charDir = path.join(botFilesPath, 'characters');
      if (fs.existsSync(charDir)) {
        const entries = fs.readdirSync(charDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const voicePath = path.join(charDir, entry.name, 'voice.txt');
            if (fs.existsSync(voicePath)) {
              const content = fs.readFileSync(voicePath, 'utf8').trim();
              const id = parseInt(content, 10);
              if (!isNaN(id)) {
                map[entry.name.toLowerCase()] = id;
              }
            }
          }
        }
      }
    } catch (e) { /* ignore scan errors */ }
  }

  // 3. Override with User Settings (voice_map.json)
  const userMap = readJsonSafe(voiceMapPath, {});
  map = { ...map, ...userMap };

  // Safety: Ensure system keys exist even if userMap overwrote them with undefined
  if (map.character_generic_male === undefined) map.character_generic_male = 5;
  if (map.character_generic_female === undefined) map.character_generic_female = 0;

  return map;
}

function detectGender(charName, botFilesPath) {
  try {
    // Find folder case-insensitively
    const charDir = path.join(botFilesPath, 'characters');
    if (!fs.existsSync(charDir)) return 'unknown';
    
    const entry = fs.readdirSync(charDir).find(f => f.toLowerCase() === charName.toLowerCase());
    if (!entry) return 'unknown';

    const pPath = path.join(charDir, entry, 'personality.txt');
    const text = readTextSafe(pPath, '').toLowerCase();

    if (text.includes('female') || text.includes('woman') || text.includes('she/her') || text.includes('girl')) return 'F';
    if (text.includes('male') || text.includes('man') || text.includes('he/him') || text.includes('boy')) return 'M';
    
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

function assignVoiceId(charName, botFilesPath, existingMap, buckets) {
  // 1. Detect Gender
  const gender = detectGender(charName, botFilesPath);

  // 2. Pick from Buckets if available
  let hash = 0;
  for (let i = 0; i < charName.length; i++) hash = charName.charCodeAt(i) + ((hash << 5) - hash);
  hash = Math.abs(hash);

  if (gender === 'F' && buckets.female.length > 0) {
    return buckets.female[hash % buckets.female.length];
  }
  if (gender === 'M' && buckets.male.length > 0) {
    return buckets.male[hash % buckets.male.length];
  }

  // 3. Fallback to random ID if buckets empty
  // Libritts has ~900 speakers. Pick one deterministically if we have to fallback.
  return hash % 900;
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
    voiceMapPath,
    voiceBucketsPath,
  } = paths;

  const cache = createCache();
  const chatStorage = createChatStorage({
    chatsPath,
    path,
    fs,
    sanitizeFilename,
    readJsonSafe,
    writeJsonSafe,
  });

  /* ---- Config accessors ---- */

  const configStore = createConfigStore({
    configPath,
    readJsonSafe,
    writeJsonSafe,
    clone: structuredCloneSafe,
    safeStorage,
  });

  function loadConfig() {
    return configStore.load();
  }

  function saveConfig(config) {
    return configStore.save(config);
  }

  function toPublicConfig(config) {
    return configStore.toPublic(config);
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

  // --- Sidecar / Utility Handlers ---

  ipcMain.handle('get-stage-directions', async (event, text, activeCharacters, context = {}) => {
    const config = loadConfig();
    const manifest = getManifest();
    
    // Pass available assets to help the small model hallucinate less
    const availableBackgrounds = Object.keys(manifest.backgrounds || {});
    const availableMusic = Object.keys(manifest.music || {});
    const availableSfx = Object.keys(manifest.sfx || {});

    const tags = await aiService.analyzeScene(config, text, {
      availableBackgrounds,
      availableMusic,
      availableSfx,
      activeCharacters,
      recentMessages: context.recentMessages,
      currentBackground: context.currentBackground,
      currentMusic: context.currentMusic,
      inventory: context.inventory,
      sceneObjects: context.sceneObjects,
      lastRenderReport: context.lastRenderReport,
    });
    return tags;
  });

  ipcMain.handle('get-reply-suggestions', async (event, messages) => {
    const config = loadConfig();
    return aiService.generateReplySuggestions(config, messages);
  });

  ipcMain.handle('get-chapter-title', async (event, messages) => {
    const config = loadConfig();
    return aiService.generateChapterTitle(config, messages);
  });

  ipcMain.handle('summarize-chat', async (event, text, prevSummary) => {
    const config = loadConfig();
    return aiService.summarizeChat(config, text, prevSummary);
  });

  ipcMain.handle('get-quest-objective', async (event, messages) => {
    const config = loadConfig();
    return aiService.generateQuestObjective(config, messages);
  });

  ipcMain.handle('get-affinity', async (event, messages, charName) => {
    const config = loadConfig();
    return aiService.analyzeAffinity(config, messages, charName);
  });

  ipcMain.handle('cleanup-response', async (event, text) => {
    const config = loadConfig();
    return aiService.cleanupResponse(config, text);
  });

  ipcMain.handle('extract-user-facts', async (event, messages) => {
    const config = loadConfig();
    return aiService.extractUserFacts(config, messages);
  });

  ipcMain.handle('expand-image-prompt', async (event, text) => {
    const config = loadConfig();
    return aiService.expandImagePrompt(config, text);
  });

  ipcMain.handle('find-closest-sprite', async (event, request, availableFiles) => {
    const config = loadConfig();
    return aiService.findClosestSprite(config, request, availableFiles);
  });

  ipcMain.handle('save-director-mode', async (event, mode) => {
    const cfg = loadConfig();
    cfg.directorMode = mode;
    saveConfig(cfg);
    return true;
  });

  ipcMain.handle('determine-active-context', async (event, messages, candidates) => {
    const config = loadConfig();
    return aiService.determineActiveContext(config, messages, candidates);
  });

  ipcMain.handle('check-file-exists', async (event, relativePath) => {
    const fullPath = resolveMediaAbsolutePath({ botImagesPath: paths.botImagesPath, botFilesPath: paths.botFilesPath }, relativePath);
    return fs.existsSync(fullPath);
  });

  // --- Background Preload ---
  // Fire and forget: Load the local model into RAM now so it's ready later.
  setTimeout(async () => {
    try {
      const config = loadConfig();
      console.log('[System] Checking for Embedded AI Model...');
      await aiService.preloadEmbeddedModel(config);
    } catch (e) {
      console.log('[System] Embedded model not preloaded (this is normal if not installed).');
    }
  }, 1000);

  registerConfigHandlers({
    ipcMain,
    loadConfig,
    saveConfig,
    toPublicConfig,
    readJsonSafe,
    readTextSafe,
    writeJsonSafe,
    personaPath,
    summaryPath,
    lorebookPath,
    advancedPromptPath,
    DEFAULT_PERSONA,
    DEFAULT_SUMMARY,
    trace,
  });

  registerMediaHandlers({
    ipcMain,
    fs,
    path,
    axios,
    nativeImage,
    aiService,
    loadConfig,
    readJsonSafe,
    readTextSafe,
    writeJsonSafe,
    getFiles,
    getManifest,
    ensureManifestCoverage,
    listCategoryFiles,
    resolveMediaAbsolutePath,
    getMimeType,
    cache,
    sanitizeFilename,
    botFilesPath,
    botImagesPath,
    PROVIDER_CATEGORIES,
    trace,
  });

  registerChatHandlers({
    ipcMain,
    chatStorage,
    readJsonSafe,
    writeJsonSafe,
    characterStatePath,
    lorebookPath,
    currentChatPath,
    trace,
  });
  registerVoiceHandlers({
    ipcMain,
    fs,
    path,
    process,
    axios,
    execFile,
    checkVoiceGender,
    getVoiceMap,
    getVoiceBuckets,
    assignVoiceId,
    writeJsonSafe,
    botFilesPath,
    voiceMapPath,
    voiceBucketsPath,
    userDataPath: paths.userDataPath,
    trace,
  });

  registerAiHandlers({
    ipcMain,
    fs,
    path,
    aiService,
    loadConfig,
    readTextSafe,
    readJsonSafe,
    writeJsonSafe,
    botFilesPath,
    botImagesPath,
    characterStatePath,
    lorebookPath,
    advancedPromptPath,
    userDataPath: paths.userDataPath,
    getManifest,
    ensureManifestCoverage,
    getFiles,
    PROVIDER_CATEGORIES,
    buildVisualPrompt,
    buildStateInjection,
    buildLoreInjection,
    buildEnforcementRules,
    applyContextWindow: contextWindow.applyContextWindow,
    structuredCloneSafe,
    trace,
  });
};
