'use strict';

const { ipcMain, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const aiService = require('./ai_services');
const axios = require('axios');
const { execFile } = require('child_process');
const os = require('os');

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
1. Output visual tags ONLY at the start or end of the message.
2. [BG: "name"] changes background. If the location is new, invent a descriptive name (e.g. "zoo_entrance", "sunny_beach").
3. [SPRITE: "Char/Name"] updates character.
4. [SPLASH: "name"] overrides all.
5. [MUSIC: "name"] plays background music.
6. Max 4 characters.
7. [HIDE: "Char"] removes character. [HIDE: "All"] removes everyone.
8. Sprites are STICKY. Only tag on change.
9. [FX: "shake"|"flash"] for visual effects.
10. STRICTLY format dialogue as Name: "Speech". Do not use prose.`;

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

  ipcMain.handle('toggle-dev-tools', (event, open) => {
    if (open === undefined || open === null) {
      event.sender.toggleDevTools();
    } else if (open) {
      event.sender.openDevTools({ mode: 'detach' });
    } else {
      event.sender.closeDevTools();
    }
  });

  ipcMain.handle('clear-voice-map', () => {
    try {
      if (fs.existsSync(voiceMapPath)) fs.unlinkSync(voiceMapPath);
      return true;
    } catch (e) {
      return false;
    }
  });

  ipcMain.handle('get-voice-map', () => getVoiceMap(voiceMapPath, botFilesPath));
  
  ipcMain.handle('save-voice-map', (_e, map) => {
    writeJsonSafe(voiceMapPath, map);
    return true;
  });

  ipcMain.handle('scan-voice-buckets', async () => {
    // Reset buckets to ensure clean state
    const buckets = { male: [], female: [] };
    const piperDir = path.resolve(botFilesPath, '../tools/piper');
    const piperBinary = process.platform === 'win32' ? 'piper.exe' : 'piper';
    const piperPath = path.join(piperDir, piperBinary);
    
    // Auto-detect model
    let modelName = 'en_US-libritts_r-medium.onnx';
    if (!fs.existsSync(path.join(piperDir, modelName))) {
      const found = fs.readdirSync(piperDir).find(f => f.endsWith('.onnx'));
      if (found) modelName = found;
    }
    const modelPath = path.join(piperDir, modelName);

    if (!fs.existsSync(piperPath) || !fs.existsSync(modelPath)) return { success: false, message: "Piper not found" };

    // 1. Try Name-Based Bucketing from Config (Fastest)
    let jsonPath = modelPath + '.json';
    if (!fs.existsSync(jsonPath)) jsonPath = modelPath.replace(/\.onnx$/, '.json');
    
    let added = 0;
    let method = "Pitch Scan";

    if (fs.existsSync(jsonPath)) {
      try {
        const config = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        if (config.speaker_id_map) {
          for (const [name, id] of Object.entries(config.speaker_id_map)) {
            const lower = name.toLowerCase();
            // Heuristics based on user provided list + common names
            if (lower.match(/^f\d+$/) || ['belinda', 'alicia', 'anika', 'annie', 'linda', 'shelby', 'steph', 'whisperf', 'salli', 'amy', 'kimberly'].includes(lower)) {
              buckets.female.push(id);
              added++;
            } else if (lower.match(/^m\d+$/) || ['adam', 'alex', 'andy', 'boris', 'david', 'edward', 'gene', 'john', 'mike', 'paul', 'robert', 'travis', 'joey', 'brian', 'matthew'].includes(lower)) {
              buckets.male.push(id);
              added++;
            }
          }
          if (added > 0) method = "Name Map";
        }
      } catch (e) { console.error("Config parse error", e); }
    }

    // 2. Fallback to Pitch Scan if no names found (e.g. raw Libritts)
    if (added === 0) {
      // Scan 50 random IDs
      for (let i = 0; i < 50; i++) {
        const id = Math.floor(Math.random() * 900);
        const pitch = await checkVoiceGender(piperPath, modelPath, piperDir, id, 'X', paths.userDataPath);
        if (pitch > 175) { buckets.female.push(id); added++; }
        else if (pitch > 60 && pitch < 155) { buckets.male.push(id); added++; }
      }
    }

    writeJsonSafe(voiceBucketsPath, buckets);
    return { success: true, message: `Method: ${method}. Added ${added} voices to buckets.` };
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

    let spriteSizes = {};
    try {
      const raw = readTextSafe(path.join(botFilesPath, 'sprite_size.txt'), '{}');
      if (raw.trim()) spriteSizes = JSON.parse(raw);
    } catch (e) {
      console.warn('Failed to parse sprite_size.txt', e);
    }

    return {
      personality: readBot('personality.txt'),
      scenario: readBot('scenario.txt'),
      initial: readBot('initial.txt'),
      characters,
      spriteSizes,
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

  ipcMain.handle('get-inner-monologue', async (_event, characterName, messages) => {
    const config = loadConfig();
    const cleanMessages = cleanMessagesForApi(messages);
    return aiService.fetchInnerMonologue(config, characterName, cleanMessages);
  });

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
        const text = readTextSafe(charPath, '').slice(0, 5000);
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
1. Update the state for: ${activeCharacters.join(', ')}.
2. [DRIFT CORRECTION]: Check if the current state has drifted from the [ORIGINAL CORE PERSONALITY]. If so, correct the Mood/Thoughts to realign with the character's true nature.
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

      // Deduplicate Lorebook
      const uniqueLore = [];
      const seenSigs = new Set();
      for (const entry of loreArray) {
        const sig = JSON.stringify({ k: (entry.keywords || []).sort(), c: (entry.scenario || entry.entry || '').trim() });
        if (!seenSigs.has(sig)) {
          seenSigs.add(sig);
          uniqueLore.push(entry);
        }
      }

      writeJsonSafe(lorebookPath, uniqueLore);

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
   * Image Generation (Pollinations.ai)
   * Uses a free remote API so no local installation is required.
   * Perfect for distributing the app to others.
   */
  ipcMain.handle('generate-image', async (_event, prompt, type) => {
    try {
      // Construct prompt for anime style backgrounds
      const enhancedPrompt = `(masterpiece, best quality), ${prompt}, detailed scenery, visual novel background, style of Makoto Shinkai, anime style, no characters`;
      const encodedPrompt = encodeURIComponent(enhancedPrompt);
      const seed = Math.floor(Math.random() * 1000000);
      
      // Pollinations API (Free, No Key)
      // We request flux model for better quality
      const url = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=1024&height=576&seed=${seed}&nologo=true&model=flux`;

      console.log(`[Image Gen] Fetching from: ${url}`);
      const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 60000 });
      
      if (response.data) {
        // 2. Process & Compress
        const buffer = Buffer.from(response.data);
        const img = nativeImage.createFromBuffer(buffer);
        const jpegBuffer = img.toJPEG(80); // 80% quality saves ~90% disk space

        // 3. Save
        const genDir = path.join(botImagesPath, 'backgrounds', 'generated');
        fs.mkdirSync(genDir, { recursive: true });
        
        const filename = `gen_${Date.now()}_${sanitizeFilename(prompt).slice(0, 20)}.jpg`;
        const absPath = path.join(genDir, filename);
        const relPath = `backgrounds/generated/${filename}`;
        
        fs.writeFileSync(absPath, jpegBuffer);

        // Prune old generated backgrounds (keep last 15)
        try {
          const MAX_GENERATED = 15;
          const files = fs.readdirSync(genDir).filter(f => f.startsWith('gen_'));
          
          if (files.length > MAX_GENERATED) {
            // Sort by filename (timestamp is prefix, so lexicographical = chronological)
            files.sort();
            const toDelete = files.slice(0, files.length - MAX_GENERATED);
            for (const f of toDelete) {
              fs.unlinkSync(path.join(genDir, f));
            }
            console.log(`[Image Gen] Pruned ${toDelete.length} old background(s).`);
          }
        } catch (e) {
          console.warn("[Image Gen] Pruning error:", e);
        }
        
        // 4. Update Cache
        cache.invalidate('files:backgrounds');
        return relPath;
      }
    } catch (e) {
      console.error("Image Gen Error:", e.message);
    }
    return null;
  });

  /**
   * TTS Generation
   * Returns base64 MP3 data or null (to fallback to browser TTS).
   */
  ipcMain.handle('generate-speech', async (_event, text, voiceId, forcedSpeakerId) => {
    let audioData = null;
    let piperError = null;

    // 1. Try Local Piper TTS (Offline, Neural)
    // Checks for: bot/tools/piper/piper.exe (Windows) or piper (Linux/Mac)
    // and a voice model.
    try {
      // Resolve path: bot/files -> bot/tools/piper
      const piperDir = path.resolve(botFilesPath, '../tools/piper');
      const piperBinary = process.platform === 'win32' ? 'piper.exe' : 'piper';
      const piperPath = path.join(piperDir, piperBinary);

      if (fs.existsSync(piperPath)) {
        // 1. Auto-detect model if default name isn't found
        let modelName = 'en_US-libritts_r-medium.onnx';
        if (!fs.existsSync(path.join(piperDir, modelName))) {
          const found = fs.readdirSync(piperDir).find(f => f.endsWith('.onnx'));
          if (found) modelName = found;
        }

        const modelPath = path.join(piperDir, modelName);
        
        // 1b. Check for config file (could be .onnx.json OR just .json)
        let jsonPath = modelPath + '.json';
        if (!fs.existsSync(jsonPath)) jsonPath = modelPath.replace(/\.onnx$/, '.json');

        if (fs.existsSync(modelPath) && fs.existsSync(jsonPath)) {
          // 2. Check if model supports multiple speakers
          let isMultiSpeaker = false;
          try {
            const config = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
            // Check both num_speakers and speaker_id_map to be safe
            isMultiSpeaker = (config.num_speakers > 1) || (config.speaker_id_map && Object.keys(config.speaker_id_map).length > 0);
            console.log(`[Piper] Model: ${modelName}, Multi-Speaker: ${isMultiSpeaker}`);
          } catch (e) {
            console.log("[Piper] Config read error, defaulting to single speaker:", e.message);
          }

          // Use a temp file to avoid stdout binary corruption (static noise)
          const tempFile = path.join(paths.userDataPath, `vn_tts_${Date.now()}.wav`);
          // --length_scale 1.1 slows speech down by ~10%
          const args = ['--model', modelPath, '--output_file', tempFile, '--length_scale', '1.1'];

          if (isMultiSpeaker) {
            let spkId;
            
            if (forcedSpeakerId !== undefined && forcedSpeakerId !== null) {
              spkId = String(forcedSpeakerId);
              console.log(`[Piper] Using forced Speaker ID: ${spkId}`);
            } else {
              // Dynamic Voice Assignment
              let voiceMap = getVoiceMap(voiceMapPath, botFilesPath);
              let buckets = getVoiceBuckets(voiceBucketsPath);
              
              if (voiceMap[voiceId] === undefined) {
                // Assign from buckets if possible, otherwise fallback to hash
                voiceMap[voiceId] = assignVoiceId(voiceId, botFilesPath, voiceMap, buckets);
                writeJsonSafe(voiceMapPath, voiceMap);
              }
              spkId = String(voiceMap[voiceId]);
              console.log(`[Piper] Generating for "${voiceId}" -> Speaker ID: ${spkId}`);
            }

            args.push('--speaker', spkId);
          } else {
            console.log("[Piper] Single speaker model detected. Ignoring voice map.");
          }

          console.log(`[Piper] Executing: ${piperBinary} ${args.join(' ')}`);
          audioData = await new Promise((resolve, reject) => {
            const child = execFile(
              piperPath, 
              args, 
              { 
                cwd: piperDir, // Important: Run inside dir so it finds dlls/config
                windowsHide: true
              }, 
              async (err, stdout, stderr) => {
                if (err) {
                  console.warn("[Piper] Execution Error:", err);
                  if (stderr) console.warn("[Piper] Stderr:", stderr.toString());
                  reject(new Error(`Piper exited with error: ${err.message}. Stderr: ${stderr ? stderr.toString() : ''}`));
                  return;
                }

                try {
                  if (fs.existsSync(tempFile)) {
                    const audioBuffer = await fs.promises.readFile(tempFile);
                    try { await fs.promises.unlink(tempFile); } catch {} // Clean up

                    if (audioBuffer.length >= 4 && audioBuffer.toString('utf8', 0, 4) === 'RIFF') {
                      resolve(`data:audio/wav;base64,${audioBuffer.toString('base64')}`);
                    } else {
                      reject(new Error("Piper output file was not a valid WAV."));
                    }
                  } else {
                    reject(new Error(`Piper produced no output file. Stderr: ${stderr ? stderr.toString() : ''}`));
                  }
                } catch (e) {
                  reject(new Error(`Failed to read Piper output: ${e.message}`));
                }
              }
            );
            
            if (child.stdin) {
              child.stdin.write(text);
              child.stdin.end();
            }
          }).catch(e => {
            piperError = e;
            return null;
          });
        } else {
          console.log(`[Piper] Missing files! Found .onnx: ${fs.existsSync(modelPath)}, Found .json: ${fs.existsSync(jsonPath)}`);
          piperError = new Error("Piper model files (.onnx or .json) missing.");
        }
      } else {
        // console.log(`[Piper] Binary not found at ${piperPath}`);
        piperError = new Error(`Piper binary not found at ${piperPath}`);
      }
    } catch (e) {
      console.log("[Piper] Setup failed:", e.message);
      piperError = e;
    }

    if (audioData) return audioData;

    // StreamElements TTS (Free, High Quality Wavenet)
    // No API key required. Works "inside the program" via public API.
    
    const SE_VOICE_MAP = {
      narrator: 'Matthew', // Deep US Male
      jessica: 'Salli',    // Clear US Female
      danny: 'Joey',       // US Male
      jake: 'Brian',       // British Male (The classic "Streamer" voice, fits a nerd archetype)
      natasha: 'Amy',      // British Female (Sophisticated)
      suzie: 'Kimberly',   // Higher pitch US Female
      character_generic_male: 'Joey',
      character_generic_female: 'Joanna'
    };

    const seVoice = SE_VOICE_MAP[voiceId] || 'Joanna';

    try {
      // Fetch MP3 from StreamElements
      const url = 'https://api.streamelements.com/kappa/v2/speech';
      const response = await axios.get(url, {
        params: {
          voice: seVoice,
          text: text
        },
        headers: { 'User-Agent': 'Mozilla/5.0' },
        responseType: 'arraybuffer'
      });
      
      // Verify content type to avoid playing error HTML as audio
      if (response.headers['content-type']?.includes('audio')) {
        return `data:audio/mp3;base64,${Buffer.from(response.data).toString('base64')}`;
      } else {
        console.warn("[StreamElements] API returned non-audio:", response.headers['content-type']);
      }
    } catch (e) {
      console.warn("StreamElements TTS failed (offline?), falling back to browser:", e.message);
    }

    // If we are here, both methods failed. Throw the Piper error if it existed, as that's likely what the user is debugging.
    if (piperError) throw piperError;
    throw new Error("Audio generation failed (Piper missing/broken and StreamElements unreachable).");
  });

  /**
   * Clean messages for API consumption.
   * Removes internal fields like 'swipes', 'swipeId' that would confuse the LLM.
   */
  function cleanMessagesForApi(messages) {
    return messages.map(m => ({
      role: m.role,
      content: m.content
    }));
  }

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

    const loreEmbeddingsPath = path.join(paths.userDataPath, 'aura_lorebook_embeddings.json');

    const stateInjection = buildStateInjection(characterState, options?.activeCharacters);
    const loreInjection = await buildLoreInjection(lorebook, messagesCopy, config, loreEmbeddingsPath);

    const advancedPromptContent = readTextSafe(advancedPromptPath, '').trim();

    const enforcementRules = buildEnforcementRules({
      stateInjection,
      loreInjection,
      advancedPromptContent,
    });

    const systemSuffix = visualPrompt + enforcementRules;

    // Trim history to context budget
    const maxContext = Number(config.maxContext) || 128000;
    const finalMessages = applyContextWindow(cleanMessagesForApi(messagesCopy), { maxContext, systemSuffix });

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
