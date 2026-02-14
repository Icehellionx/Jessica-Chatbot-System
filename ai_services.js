'use strict';

const fs = require('fs');
const path = require('path');
const axiosLib = require('axios');

/**
 * Shared axios instance so you can set defaults in one place (timeout, etc).
 * You can also attach interceptors later if you want request logging.
 */
const axios = axiosLib.create({
  timeout: 30_000,
  // validateStatus: () => true, // uncomment if you want to handle non-2xx manually everywhere
});

/**
 * Provider defaults (OpenAI-compatible providers share the /chat/completions shape).
 * Gemini is handled separately because it uses a different API surface.
 */
const PROVIDER_DEFAULTS = Object.freeze({
  openrouter:  { baseUrl: 'https://openrouter.ai/api/v1',          model: 'mistralai/mistral-7b-instruct:free' },
  grok:        { baseUrl: 'https://api.x.ai/v1',                   model: 'grok-beta' },
  chutes:      { baseUrl: 'https://chutes.ai/api/v1',              model: 'chutes-model' },
  featherless: { baseUrl: 'https://api.featherless.ai/v1',         model: 'meta-llama/Meta-Llama-3-8B-Instruct' },
  local:       { baseUrl: 'http://localhost:1234/v1',              model: 'local-model' },
  openai:      { baseUrl: 'https://api.openai.com/v1',             model: 'gpt-3.5-turbo' },
  embedded:    { baseUrl: '',                                      model: 'model.gguf' },
});

const GEMINI_DEFAULT_MODEL = 'gemini-1.5-flash';
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * Pick a provider in a predictable way.
 * - Prefer config.activeProvider
 * - Else use first apiKeys key (if present)
 * - Else fallback to "openai"
 */
function pickProvider(config) {
  const active = config?.activeProvider;
  if (active) return active;

  const firstKey = Object.keys(config?.apiKeys ?? {})[0];
  if (firstKey) return firstKey;

  return 'openai';
}

function getApiKey(config, provider) {
  return config?.apiKeys?.[provider] ?? null;
}

function getSavedModel(config, provider) {
  return config?.models?.[provider] ?? null;
}

function getSavedBaseUrl(config, provider) {
  return config?.baseUrls?.[provider] ?? null;
}

/**
 * Normalized provider settings consumed by the rest of the module.
 * Note: we always return `baseURL` (capital URL) for consistency with axios config naming.
 */
function getProviderSettings(config, forceProvider = null) {
  let provider = forceProvider || pickProvider(config);
  let apiKey = getApiKey(config, provider);

  // Fallback: If the selected provider requires a key but none is present,
  // and we have an embedded model available, switch to embedded.
  if (!apiKey && provider !== 'local' && provider !== 'embedded') {
    const embeddedModelName = getSavedModel(config, 'embedded') || PROVIDER_DEFAULTS.embedded.model;
    if (findEmbeddedModelPath(embeddedModelName)) {
      provider = 'embedded';
      // apiKey remains null/undefined
    }
  }

  if (provider === 'gemini') {
    return {
      provider,
      apiKey,
      model: getSavedModel(config, provider) ?? GEMINI_DEFAULT_MODEL,
      baseURL: null, // not used for Gemini
      isGemini: true,
    };
  }

  const def = PROVIDER_DEFAULTS[provider] ?? PROVIDER_DEFAULTS.openai;

  return {
    provider,
    apiKey,
    model: getSavedModel(config, provider) ?? def.model,
    baseURL: getSavedBaseUrl(config, provider) ?? def.baseUrl,
    isGemini: false,
  };
}

/** Bearer auth headers for OpenAI-compatible APIs */
function authHeaders(apiKey) {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

/**
 * Gets settings for the "Assistant" / Utility model.
 * Logic:
 * 1. If config.utilityProvider is set, use that.
 * 2. If 'local' provider has a base URL configured (even if not active), prefer that for free inference.
 * 3. Fallback to the active main provider.
 */
function getUtilitySettings(config) {
  // 1. Explicit override
  if (config?.utilityProvider) {
    return getProviderSettings(config, config.utilityProvider);
  }

  // 2. Check for Embedded Model (Highest Priority for "Built-in" feel)
  // If the user hasn't explicitly set a utility provider, and we find a local model file, use it.
  const embeddedModelName = getSavedModel(config, 'embedded') || PROVIDER_DEFAULTS.embedded.model;
  if (findEmbeddedModelPath(embeddedModelName)) {
    return getProviderSettings(config, 'embedded');
  }

  // 3. Auto-detect local (Ollama/LM Studio) for free utility tasks
  const localBase = getSavedBaseUrl(config, 'local');
  if (localBase && config.activeProvider !== 'local') {
    return getProviderSettings(config, 'local');
  }

  // 4. Fallback to main
  return getProviderSettings(config);
}

/**
 * Convert OpenAI-style messages into Gemini `contents` + optional `systemInstruction`.
 * Supports:
 * - string content
 * - array content with {type:'text'} and {type:'image_url', image_url:{url:'data:mime;base64,...'}}
 */
function buildGeminiBody(messages, { maxTokens, temperature } = {}) {
  const systemMsg = messages.find(m => m.role === 'system');
  const chatMsgs = messages.filter(m => m.role !== 'system');

  const systemInstruction = systemMsg
    ? { parts: [{ text: String(systemMsg.content ?? '') }] }
    : undefined;

  const contents = chatMsgs.map(m => {
    const role = m.role === 'user' ? 'user' : 'model';

    // Multi-part content (text + inlineData images)
    if (Array.isArray(m.content)) {
      const parts = [];

      for (const c of m.content) {
        if (c?.type === 'text' && typeof c.text === 'string') {
          parts.push({ text: c.text });
        }

        if (c?.type === 'image_url' && c.image_url?.url) {
          // Only supports data URLs here (matches your original behavior).
          const match = String(c.image_url.url).match(/^data:(.*?);base64,(.*)$/);
          if (match) {
            parts.push({
              inlineData: { mimeType: match[1], data: match[2] },
            });
          }
        }
      }

      return { role, parts };
    }

    // Simple string content
    return { role, parts: [{ text: String(m.content ?? '') }] };
  });

  const body = { contents };

  if (systemInstruction) body.systemInstruction = systemInstruction;

  // Gemini uses `generationConfig` for these
  if (maxTokens != null || temperature != null) {
    body.generationConfig = {};
    if (maxTokens != null) body.generationConfig.maxOutputTokens = maxTokens;
    if (temperature != null) body.generationConfig.temperature = temperature;
  }

  return body;
}

/** OpenAI-compatible request body */
function buildChatCompletionsBody(messages, { model, maxTokens, temperature, stream } = {}) {
  const body = {
    model,
    messages,
    temperature: temperature ?? 0.5,
  };
  if (maxTokens != null) body.max_tokens = maxTokens;
  if (stream) body.stream = true;
  return body;
}

/**
 * Gemini URLs
 * - generateContent (non-stream)
 * - streamGenerateContent (stream)
 */
function geminiUrl(model, apiKey, isStream = false) {
  const method = isStream ? 'streamGenerateContent' : 'generateContent';
  return `${GEMINI_API_BASE}/${encodeURIComponent(model)}:${method}?key=${encodeURIComponent(apiKey)}`;
}

/**
 * Helper to find the model file in common Electron/Dev locations.
 */
function findEmbeddedModelPath(modelName) {
  const candidates = [
    path.join(process.resourcesPath || '', 'models', modelName),      // Prod (Electron resources)
    path.join(__dirname, 'bot', 'models', modelName),                 // Dev (Source)
    path.join(process.cwd(), 'models', modelName),                    // CWD fallback
    modelName                                                         // Absolute path
  ];
  return candidates.find(p => fs.existsSync(p)) || null;
}

/**
 * State for the embedded Llama instance to avoid reloading model on every request.
 */
let embeddedState = null; // { llama, model, context, LlamaChatSession }

async function getEmbeddedLlamaState(modelName) {
  if (embeddedState && embeddedState.modelName === modelName) return embeddedState;

  const modelPath = findEmbeddedModelPath(modelName);
  if (!modelPath) {
    throw new Error(`Embedded model file "${modelName}" not found. Please place it in bot/models/`);
  }

  try {
    // Dynamic import because node-llama-cpp is an ESM module and might not be installed
    const nll = await import('node-llama-cpp');
    const llama = await nll.getLlama();
    
    console.log('[AI] Loading embedded model from:', modelPath);
    const model = await llama.loadModel({ modelPath });
    const context = await model.createContext();
    
    embeddedState = { 
      llama, 
      model, 
      context, 
      LlamaChatSession: nll.LlamaChatSession,
      modelName 
    };
    return embeddedState;
  } catch (e) {
    console.error('[AI] Failed to load node-llama-cpp:', e);
    throw new Error('Failed to load embedded AI engine. Is "node-llama-cpp" installed?');
  }
}

async function generateEmbeddedCompletion(settings, messages, options) {
  const { context, LlamaChatSession } = await getEmbeddedLlamaState(settings.model);
  
  // Create a transient session sharing the context sequence (efficient)
  const session = new LlamaChatSession({ contextSequence: context.getSequence() });

  // Format history for LlamaChatSession
  // It expects: { type: 'user'|'model'|'system', text: string }
  const history = messages.slice(0, -1).map(m => ({
    type: m.role === 'assistant' ? 'model' : m.role,
    text: m.content
  }));
  
  session.setChatHistory(history);

  const lastMsg = messages[messages.length - 1];
  const response = await session.prompt(lastMsg.content, {
    maxTokens: options.max_tokens,
    temperature: options.temperature
  });

  return response;
}

/**
 * Preloads the embedded model if it exists.
 * Useful to call on app startup so the first request isn't slow.
 */
async function preloadEmbeddedModel(config) {
  const modelName = getSavedModel(config, 'embedded') || PROVIDER_DEFAULTS.embedded.model;
  if (findEmbeddedModelPath(modelName)) {
    await getEmbeddedLlamaState(modelName);
  }
}

/**
 * Quick “ping” that avoids token spend but still exercises auth + route.
 */
async function testConnection(config) {
  const settings = getProviderSettings(config);

  if (!settings.provider) {
    return { success: false, message: 'No active provider selected.' };
  }

  if (!settings.apiKey && settings.provider !== 'local' && settings.provider !== 'embedded') {
    return { success: false, message: `No API key found for ${settings.provider}.` };
  }

  try {
    if (settings.provider === 'embedded') {
      try {
        await getEmbeddedLlamaState(settings.model);
        return { success: true, message: 'Embedded model loaded successfully!' };
      } catch (e) {
        return { success: false, message: e.message };
      }
    }

    if (settings.isGemini) {
      const url = geminiUrl(settings.model, settings.apiKey, false);
      // Minimal valid Gemini payload
      await axios.post(url, { contents: [{ parts: [{ text: 'Hello' }] }] });
    } else {
      await axios.post(
        `${settings.baseURL}/chat/completions`,
        buildChatCompletionsBody([{ role: 'user', content: 'Hello' }], {
          model: settings.model,
          maxTokens: 1,
          temperature: 0,
        }),
        { headers: authHeaders(settings.apiKey) }
      );
    }

    return { success: true, message: `Successfully connected to ${settings.provider}!` };
  } catch (error) {
    console.error('Test Provider Error:', error);

    // Specific help for Local/LM Studio connection issues
    if (settings.provider === 'local' && (error.code === 'ECONNREFUSED' || error.message.includes('Network Error'))) {
      return { success: false, message: 'Connection refused. Is LM Studio (or Ollama) running? Ensure the Local Server is ON and listening on port 1234.' };
    }

    const msg = error?.response?.data
      ? safeJsonStringify(error.response.data)
      : (error?.message ?? 'Unknown error');

    return { success: false, message: `Connection failed: ${msg}` };
  }
}

/**
 * Non-stream completion helper.
 * Returns: string|null
 */
async function generateCompletion(config, messages, options = {}) {
  // Use utility settings if requested, otherwise default
  const settings = options.useUtility 
    ? getUtilitySettings(config) 
    : getProviderSettings(config);

  if (!settings.apiKey && settings.provider !== 'local' && settings.provider !== 'embedded') return null;

  const temperature = options.temperature ?? 0.5;
  const maxTokens = options.max_tokens;

  try {
    if (settings.provider === 'embedded') {
      return await generateEmbeddedCompletion(settings, messages, { maxTokens, temperature });
    }

    if (settings.isGemini) {
      const url = geminiUrl(settings.model, settings.apiKey, false);
      const body = buildGeminiBody(messages, { maxTokens, temperature });

      const r = await axios.post(url, body);
      const text =
        r?.data?.candidates?.[0]?.content?.parts?.[0]?.text;

      return typeof text === 'string' ? text : null;
    }

    const body = buildChatCompletionsBody(messages, {
      model: settings.model,
      maxTokens,
      temperature,
      stream: false,
    });

    const r = await axios.post(
      `${settings.baseURL}/chat/completions`,
      body,
      { headers: authHeaders(settings.apiKey) }
    );

    const text = r?.data?.choices?.[0]?.message?.content;
    return typeof text === 'string' ? text : null;
  } catch (e) {
    console.error('AI Completion Failed:', e?.message ?? e);
    return null;
  }
}

/**
 * Generate an embedding vector for the given text.
 * Returns: number[] | null
 */
async function generateEmbedding(config, text) {
  const settings = getProviderSettings(config);
  if (!settings.apiKey && settings.provider !== 'local' && settings.provider !== 'embedded') return null;

  try {
    // Gemini Embedding
    if (settings.isGemini) {
      // Use text-embedding-004 for Gemini
      const embedModel = 'text-embedding-004';
      const url = `${GEMINI_API_BASE}/${embedModel}:embedContent?key=${encodeURIComponent(settings.apiKey)}`;
      const response = await axios.post(url, {
        content: { parts: [{ text }] }
      });
      return response?.data?.embedding?.values || null;
    }

    // Embedded Embedding (if supported by node-llama-cpp, otherwise null)
    if (settings.provider === 'embedded') {
      // node-llama-cpp embedding support is available but requires context. Skipping for simplicity unless requested.
      return null; 
    }

    // OpenAI / Local Embedding
    // Default to text-embedding-3-small for OpenAI, or use config model for local
    let model = settings.model;
    if (settings.provider === 'openai') model = 'text-embedding-3-small';
    
    // Local providers (Ollama/LM Studio) usually default to the loaded model if not specified,
    // but it's safer to pass what we have or a specific embedding model if the user configured one.

    const response = await axios.post(
      `${settings.baseURL}/embeddings`,
      { input: text, model },
      { headers: authHeaders(settings.apiKey) }
    );

    return response?.data?.data?.[0]?.embedding || null;
  } catch (e) {
    console.warn('Embedding generation failed:', e?.message ?? e);
    return null;
  }
}

/**
 * Stream parser for OpenAI-compatible SSE format:
 *   data: {...}\n
 *   data: [DONE]\n
 */
function parseOpenAISSEChunk(chunkStr, onToken) {
  const lines = chunkStr.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data: ')) continue;

    const payload = trimmed.slice(6);
    if (payload === '[DONE]') continue;

    const data = JSON.parse(payload);
    const token = data?.choices?.[0]?.delta?.content;
    if (typeof token === 'string' && token.length) {
      onToken(token);
    }
  }
}

/**
 * OpenAI-compatible SSE streams are line-oriented and can split events across chunks.
 * This parser keeps an internal carry buffer so fragmented JSON still gets parsed.
 */
function createOpenAISSEParser(onToken) {
  let carry = '';

  return function feed(chunkStr) {
    carry += chunkStr;
    const lines = carry.split('\n');
    carry = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data: ')) continue;

      const payload = trimmed.slice(6).trim();
      if (!payload || payload === '[DONE]') continue;

      try {
        parseOpenAISSEChunk(`data: ${payload}\n`, onToken);
      } catch {
        // Keep streaming resilient; malformed lines are ignored.
      }
    }
  };
}

/**
 * Gemini streaming: the response body arrives as chunked JSON objects.
 * Your original code used brace-counting to recover full JSON objects even if split.
 * This keeps that approach, but isolates it and heavily comments it.
 */
function createGeminiJsonObjectExtractor(onJsonObject) {
  let buffer = '';

  return function feed(chunkStr) {
    buffer += chunkStr;

    let braceCount = 0;
    let startIndex = 0;
    let inString = false;
    let escape = false;

    for (let i = 0; i < buffer.length; i++) {
      const ch = buffer[i];

      // Track escaping inside JSON strings
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }

      // Toggle string mode (naive but fine for JSON)
      if (ch === '"') { inString = !inString; continue; }

      if (inString) continue;

      if (ch === '{') {
        if (braceCount === 0) startIndex = i;
        braceCount++;
      } else if (ch === '}') {
        braceCount--;
        if (braceCount === 0) {
          const jsonStr = buffer.slice(startIndex, i + 1);

          try {
            onJsonObject(JSON.parse(jsonStr));
          } catch {
            // If parsing fails, ignore: could be malformed or incomplete.
          }

          // Remove processed portion from buffer and restart scan.
          buffer = buffer.slice(i + 1);
          i = -1;
        }
      }
    }
  };
}

/**
 * Stream completion:
 * - Calls onChunk(token) as tokens arrive
 * - Returns full concatenated text
 */
async function generateStream(config, messages, onChunk, options = {}) {
  const settings = getProviderSettings(config);
  const temperature = options.temperature ?? 0.7;
  const maxTokens = options.max_tokens;
  const signal = options.signal;

  if (!settings.apiKey && settings.provider !== 'local' && settings.provider !== 'embedded') {
    throw new Error('No API key found.');
  }

  if (settings.isGemini) {
    const url = geminiUrl(settings.model, settings.apiKey, true);
    const requestBody = buildGeminiBody(messages, { temperature, maxTokens });

    const response = await axios.post(url, requestBody, { responseType: 'stream', signal });
    const stream = response.data;

    let fullText = '';

    const feed = createGeminiJsonObjectExtractor((data) => {
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (typeof text === 'string' && text.length) {
        fullText += text;
        onChunk(text);
      }
    });

    await new Promise((resolve, reject) => {
      stream.on('data', (chunk) => feed(chunk.toString()));
      stream.on('end', resolve);
      stream.on('error', reject);
    });

    return fullText;
  }

  if (settings.provider === 'embedded') {
    // For now, embedded is non-streaming in this implementation to keep it simple, 
    // but we can wrap it to simulate stream or implement Llama stream later.
    const text = await generateEmbeddedCompletion(settings, messages, { maxTokens, temperature });
    onChunk(text); // Send all at once
    return text;
  }

  // OpenAI-compatible streaming (/chat/completions with stream:true)
  const response = await axios.post(
    `${settings.baseURL}/chat/completions`,
    buildChatCompletionsBody(messages, {
      model: settings.model,
      temperature,
      maxTokens,
      stream: true,
    }),
    {
      headers: authHeaders(settings.apiKey),
      responseType: 'stream',
      signal,
    }
  );

  const stream = response.data;
  let fullText = '';

  await new Promise((resolve, reject) => {
    const feed = createOpenAISSEParser((token) => {
      fullText += token;
      onChunk(token);
    });

    stream.on('data', (chunk) => {
      feed(chunk.toString());
    });
    stream.on('end', resolve);
    stream.on('error', reject);
  });

  return fullText;
}

async function fetchInnerMonologue(config, characterName, messages, personality = '') {
  const systemPrompt = `You are a world-class author. Based on the provided conversation history, write a short, first-person inner monologue EXCLUSIVELY for the character "${characterName}".
${personality ? `\n[CHARACTER PROFILE]\n${personality}\n` : ''}
- You are "${characterName}". Speak in the first person ("I").
- Do NOT write thoughts for any other character.
- The monologue should reveal your private thoughts, feelings, or intentions based on the recent events.
- Write ONLY the monologue text itself.
- Do NOT include any surrounding text, narration, or quotation marks.
- The tone should match your personality and the current situation.`;

  // Use a slice of the most recent messages to keep the context focused and save tokens.
  const recentMessages = messages.slice(-10);

  const finalMessages = [
    { role: 'system', content: systemPrompt },
    ...recentMessages,
  ];

  try {
    const monologue = await generateCompletion(config, finalMessages, { temperature: 0.75 });
    return monologue;
  } catch (e) {
    console.error('Inner Monologue generation failed:', e);
    return 'Failed to generate thoughts.';
  }
}

function parseFirstJsonObject(text) {
  const raw = String(text || '');
  const start = raw.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) {
        const candidate = raw.slice(start, i + 1);
        try {
          return JSON.parse(candidate);
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function parseTagLines(text) {
  if (!text) return null;
  const matches = String(text).match(/\[(BG|SPRITE|SPLASH|MUSIC|HIDE|FX|SFX|CAMERA|TAKE|DROP|ADD_OBJECT):[^\]]+\]/gi);
  return matches && matches.length ? matches.join('\n') : null;
}

function normalizeActionType(rawType) {
  const type = String(rawType || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  const map = {
    background: 'bg',
    bg: 'bg',
    music: 'music',
    sprite: 'sprite',
    hide: 'hide',
    sfx: 'sfx',
    fx: 'fx',
    camera: 'camera',
    take: 'take',
    drop: 'drop',
    add_object: 'add_object',
  };
  return map[type] || '';
}

function toTagPlanFromJson(plan) {
  if (!plan || !Array.isArray(plan.actions)) return null;
  const lines = [];
  for (const action of plan.actions) {
    const type = normalizeActionType(action?.type);
    if (!type) continue;

    if (type === 'bg' && action.name) lines.push(`[BG: ${String(action.name).trim()}]`);
    if (type === 'music' && action.name) lines.push(`[MUSIC: ${String(action.name).trim()}]`);
    if (type === 'sprite') {
      const name = String(action.character || action.name || '').trim();
      const emotion = String(action.emotion || 'default').trim();
      if (name) lines.push(`[SPRITE: ${name}/${emotion}]`);
    }
    if (type === 'hide' && action.character) lines.push(`[HIDE: ${String(action.character).trim()}]`);
    if (type === 'sfx' && action.name) lines.push(`[SFX: ${String(action.name).trim()}]`);
    if (type === 'fx' && action.name) lines.push(`[FX: ${String(action.name).trim()}]`);
    if (type === 'camera') {
      const mode = String(action.mode || action.action || 'zoom_in').trim();
      const target = String(action.target || action.character || '').trim();
      if (target) lines.push(`[CAMERA: ${mode}, ${target}]`);
    }
    if (type === 'take' && action.item) lines.push(`[TAKE: ${String(action.item).trim()}]`);
    if (type === 'drop' && action.item) lines.push(`[DROP: ${String(action.item).trim()}]`);
    if (type === 'add_object' && action.item) lines.push(`[ADD_OBJECT: ${String(action.item).trim()}]`);
  }
  return lines.length ? lines.join('\n') : null;
}

/**
 * "The Stage Director"
 * Uses the utility model to analyze the text and determine the best sprite/emotion/bg/music.
 */
async function analyzeScene(config, text, options = {}) {
  const {
    availableBackgrounds,
    availableMusic,
    availableSfx,
    activeCharacters,
    recentMessages,
    currentBackground,
    currentMusic,
    inventory,
    sceneObjects,
    lastRenderReport,
  } = options;

  const recentTurns = Array.isArray(recentMessages)
    ? recentMessages
      .slice(-4)
      .map((m) => `${m?.role || 'unknown'}: ${String(m?.content || '').slice(0, 400)}`)
      .join('\n')
    : '';

  const systemPrompt = `You are a Visual Novel Director (Cinematographer & Sound Engineer).
Your job is to read the dialogue and output a JSON scene plan.

Context:
- Characters currently on stage: ${activeCharacters && activeCharacters.length ? activeCharacters.join(', ') : 'None'}
- Current background: ${currentBackground || 'none'}
- Current music: ${currentMusic || 'none'}
- Player inventory: ${Array.isArray(inventory) && inventory.length ? inventory.join(', ') : 'empty'}
- Scene objects: ${Array.isArray(sceneObjects) && sceneObjects.length ? sceneObjects.join(', ') : 'none'}
- Previous applied directives: ${lastRenderReport || 'none'}
- Recent turns:
${recentTurns || 'none'}
- Backgrounds (choose from): ${availableBackgrounds ? availableBackgrounds.slice(0, 40).join(', ') : 'any'}
- Music (choose from): ${availableMusic ? availableMusic.slice(0, 40).join(', ') : 'any'}
- SFX (choose from): ${availableSfx ? availableSfx.slice(0, 40).join(', ') : 'any'}

Instructions:
1. Output JSON only, no markdown, no prose.
2. JSON schema:
{"actions":[
  {"type":"bg","name":"backgrounds/foo.png"},
  {"type":"music","name":"music/bar.mp3"},
  {"type":"sprite","character":"Name","emotion":"happy"},
  {"type":"hide","character":"Name"},
  {"type":"sfx","name":"door_slam"},
  {"type":"fx","name":"shake"},
  {"type":"camera","mode":"zoom_in","target":"Name"},
  {"type":"take","item":"key"},
  {"type":"drop","item":"key"}
]}
3. Keep actions minimal and ordered by appearance in the scene.
4. Do not summon characters unless they physically enter or speak.
5. If no changes are needed, return {"actions":[]}.`;

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `Dialogue:\n"${text}"` }
  ];

  try {
    const responseText = await generateCompletion(config, messages, { temperature: 0.1, max_tokens: 220, useUtility: true });
    if (!responseText) return null;

    const parsed = parseFirstJsonObject(responseText);
    const structuredTags = toTagPlanFromJson(parsed);
    if (structuredTags) return structuredTags;

    return parseTagLines(responseText);
  } catch (e) {
    return null;
  }
}

/**
 * Heuristic Controller / Post-Processing
 * Runs after the LLM to clean up text using logic and regex (no heavy ML).
 * 
 * @param {string} text - The full text generated by the LLM.
 * @param {object} context - { activeCharacters, recentHistory }
 * @returns {Promise<string>} - The text (potentially modified with extra tags).
 */
async function runHeuristicCleanup(text, context) {
  if (!text) return text;
  let modifiedText = text;

  // Helper to inject tag into SCENE block if present, or append
  const injectTag = (txt, tag) => {
    if (/\[\/SCENE\]/i.test(txt)) {
      return txt.replace(/\[\/SCENE\]/i, `\n${tag}\n[/SCENE]`);
    }
    return txt + `\n${tag}`;
  };

  // 1. Heuristic: Fix malformed tags (e.g. missing closing bracket)
  // Example: [SPRITE: Jessica/Happy -> [SPRITE: Jessica/Happy]
  // We look for [TAG: Value that ends with a newline or end of string instead of ]
  const tagRegex = /\[(BG|SPRITE|SPLASH|MUSIC|HIDE|FX|SFX|CAMERA|TAKE|DROP|ADD_OBJECT):([^\]\n]+)(?=$|\n)/g;
  modifiedText = modifiedText.replace(tagRegex, '[$1:$2]');

  // 2. Heuristic: Fix extra spaces in sprite tags
  // Example: [SPRITE: Jessica / Happy] -> [SPRITE: Jessica/Happy]
  modifiedText = modifiedText.replace(/\[SPRITE:\s*([^\]\/]+)\s*\/\s*([^\]]+)\]/gi, '[SPRITE: $1/$2]');

  // 3. Heuristic: Detect implied exits (Context-aware)
  if (context && Array.isArray(context.activeCharacters)) {
    const lower = modifiedText.toLowerCase();
    const active = context.activeCharacters;

    // Check for explicit "Name leaves/exits" patterns
    for (const char of active) {
      const name = char.toLowerCase();
      // Patterns: "Danny leaves", "Danny exits", "Danny walks away", "shoves Danny out"
      const patterns = [
        `${name} leaves`,
        `${name} exits`,
        `${name} walks away`,
        `${name} runs away`,
        `shoves ${name} out`,
        `pushes ${name} out`
      ];

      if (patterns.some(p => lower.includes(p))) {
        if (!new RegExp(`\\[HIDE:\\s*${name}\\]`, 'i').test(modifiedText)) {
           modifiedText = injectTag(modifiedText, `[HIDE: ${char}]`);
        }
      }
    }

    // Specific fix for "shoves him out" if Danny is active (common issue with male chars)
    if (active.some(c => c.toLowerCase() === 'danny') && (lower.includes('shoves him out') || lower.includes('pushes him out'))) {
       if (!/\[HIDE:\s*Danny\]/i.test(modifiedText)) {
         modifiedText = injectTag(modifiedText, `[HIDE: Danny]`);
       }
    }
  }
  
  return modifiedText;
}

/**
 * "The Wingman"
 * Generates 3 short reply suggestions for the user.
 */
async function generateReplySuggestions(config, messages) {
  const recent = messages.slice(-5);
  const systemPrompt = `You are a Roleplay Assistant.
Read the conversation and generate 3 distinct, short reply options for the User.
1. Positive/Agreeable
2. Negative/Conflict
3. Creative/Unexpected

Output format: JSON array of strings. Example: ["Ask about her day", "Ignore her", "Offer a drink"]
Keep them under 10 words. Output ONLY the JSON array.`;

  const payload = [
    { role: 'system', content: systemPrompt },
    ...recent
  ];

  try {
    const text = await generateCompletion(config, payload, { temperature: 0.7, max_tokens: 100, useUtility: true });
    const parsed = parseFirstJsonObject(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

/**
 * "The Librarian"
 * Generates a short, punchy title for the current conversation state.
 */
async function generateChapterTitle(config, messages) {
  const recent = messages.slice(-10);
  const systemPrompt = `Summarize the current scene in 3-6 words for a Save File title.
Examples: "Meeting at the Cafe", "The Argument", "Late Night Confession".
Output ONLY the title. No quotes.`;

  const payload = [
    { role: 'system', content: systemPrompt },
    ...recent
  ];

  try {
    const text = await generateCompletion(config, payload, { temperature: 0.3, max_tokens: 20, useUtility: true });
    return text ? text.trim().replace(/["']/g, '') : 'New Chapter';
  } catch (e) {
    return 'New Chapter';
  }
}

/**
 * "The Scribe"
 * Summarizes the chat history using the local model to save costs.
 */
async function summarizeChat(config, textToSummarize, previousSummary = '') {
  const systemPrompt = `You are a Scribe. Summarize the following conversation events concisely to append to a history log.
Previous Context: ${previousSummary || 'None'}`;
  
  const messages = [{ role: 'system', content: systemPrompt }, { role: 'user', content: textToSummarize }];
  return generateCompletion(config, messages, { temperature: 0.3, max_tokens: 300, useUtility: true });
}

/**
 * "The Quest Giver"
 * Determines the current narrative goal for the player.
 */
async function generateQuestObjective(config, messages) {
  const recent = messages.slice(-10);
  const systemPrompt = `You are a Game Master. Analyze the conversation and define the current objective for the player.
Examples: "Find out why she is crying", "Escape the building", "Ask her on a date", "Survive the interrogation".
Output ONLY the objective text. Keep it under 10 words. If no clear objective, output "Chat with the character".`;

  const payload = [
    { role: 'system', content: systemPrompt },
    ...recent
  ];

  try {
    const text = await generateCompletion(config, payload, { temperature: 0.3, max_tokens: 30, useUtility: true });
    return text ? text.trim().replace(/^Objective:\s*/i, '').replace(/["']/g, '') : 'Explore the story';
  } catch (e) {
    return 'Explore the story';
  }
}

/**
 * "The Empath"
 * Analyzes the relationship status/score between User and Character.
 */
async function analyzeAffinity(config, messages, charName) {
  const recent = messages.slice(-10);
  const systemPrompt = `You are a Relationship Tracker.
Analyze the relationship between the User and "${charName}" based on the recent conversation.
Output a JSON object: {"score": number (0-100), "status": string (e.g. "Strangers", "Friends", "Flirty", "Hostile", "Lovers")}.
Base the score on trust, intimacy, and positive interactions.`;

  const payload = [
    { role: 'system', content: systemPrompt },
    ...recent
  ];

  try {
    const text = await generateCompletion(config, payload, { temperature: 0.1, max_tokens: 60, useUtility: true });
    const parsed = parseFirstJsonObject(text);
    return parsed || { score: 50, status: "Neutral" };
  } catch (e) {
    return { score: 50, status: "Neutral" };
  }
}

/**
 * "The Editor"
 * Uses the utility model to clean up the text (remove malformed tags, fix formatting).
 */
async function cleanupResponse(config, text) {
  // Only run if there are potential tag artifacts (brackets)
  if (!text || !/[\[\]]/.test(text)) return text;

  const systemPrompt = `You are a Copy Editor.
Your task is to remove any malformed, incomplete, or leftover system tags from the text.
Examples of artifacts to remove:
- "[BG: ...]"
- "[SPRITE: ...]"
- "[SCENE_STATE: ...]"
- "[/SCENE]"
- Broken tags like "Danny]" or "[ "

Rules:
1. Preserve all dialogue and narration exactly as is.
2. Remove ANY bracketed content that looks like a system command, debug info, or metadata.
3. Output ONLY the cleaned text. Do NOT include introductions like "Here is the cleaned text".`;

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: text }
  ];

  try {
    let cleaned = await generateCompletion(config, messages, { temperature: 0.1, max_tokens: Math.max(200, text.length), useUtility: true });
    
    // Heuristic cleanup of common LLM chatter
    if (cleaned) {
      cleaned = cleaned.replace(/^(Here is|Here's) the (cleaned|corrected) text:?\s*/i, '').replace(/^Cleaned text:?\s*/i, '').replace(/^Output:?\s*/i, '');
    }

    if (!cleaned || cleaned.length < text.length * 0.5) return text; // Safety fallback
    return cleaned.trim();
  } catch (e) {
    return text;
  }
}

/**
 * "The Profiler" (AURA Integrated)
 * Extracts permanent facts about the user and formats them for the Lorebook.
 */
async function extractUserFacts(config, messages) {
  const recent = messages.slice(-4);
  const systemPrompt = `You are a Memory System.
Analyze the dialogue and extract new, permanent facts about the User (e.g. name, job, likes, dislikes, history).
Ignore trivial events or current actions.
Output a JSON array of objects formatted for a Lorebook:
[
  { "entry": "User is a doctor.", "keywords": ["user", "job", "doctor"] },
  { "entry": "User hates spiders.", "keywords": ["user", "phobia", "spiders"] }
]
If no new facts, output [].`;

  const payload = [
    { role: 'system', content: systemPrompt },
    ...recent
  ];

  try {
    const text = await generateCompletion(config, payload, { temperature: 0.1, max_tokens: 150, useUtility: true });
    const parsed = parseFirstJsonObject(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

/**
 * "The Art Director"
 * Expands a short background description into a full Stable Diffusion prompt.
 */
async function expandImagePrompt(config, shortDescription) {
  const normalizedInput = String(shortDescription || '').replace(/[_-]+/g, ' ').trim();
  if (!normalizedInput) return shortDescription;

  const systemPrompt = `You are an AI Art Prompt Engineer.
Expand a short scene description into a detailed background-image prompt for a visual novel.
Rules:
1. Preserve the original setting and key nouns from the input.
2. Do NOT replace the location with a different one.
3. Keep "no characters".
4. Avoid graphic violence/horror wording; keep it scenic and safe.
5. Output a single prompt line only.`;

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: normalizedInput }
  ];

  const text = await generateCompletion(config, messages, { temperature: 0.35, max_tokens: 120, useUtility: true });
  let out = text ? text.trim().replace(/^Output:\s*/i, '').replace(/"/g, '') : normalizedInput;

  // Guard against model drift: if output drops key terms, prepend the original concept.
  const lowerOut = out.toLowerCase();
  const keyTerms = normalizedInput.toLowerCase().split(/\s+/).filter(w => w.length > 3).slice(0, 3);
  if (keyTerms.length && !keyTerms.some(k => lowerOut.includes(k))) {
    out = `${normalizedInput}, ${out}`;
  }
  return out;
}

/**
 * "The Casting Director"
 * Picks the best matching filename from a list based on a requested description.
 * Useful for mapping "Devastated" -> "crying.png" when exact matches fail.
 */
async function findClosestSprite(config, request, availableFiles) {
  const systemPrompt = `You are a File Matcher.
Pick the filename that best matches the requested emotion/description.
Request: "${request}"
Files: ${JSON.stringify(availableFiles)}
Output ONLY the exact filename from the list. If nothing fits well, output "none".`;

  const messages = [{ role: 'system', content: systemPrompt }];
  
  try {
    const text = await generateCompletion(config, messages, { temperature: 0.1, max_tokens: 50, useUtility: true });
    return text ? text.trim().replace(/['"]/g, '') : null;
  } catch (e) { return null; }
}

/**
 * "The Librarian" (Context Optimization)
 * Selects relevant context keys (drawers) to minimize token usage.
 * Input: messages, candidates (array of strings, e.g. ["Lore: War", "Char: Danny"])
 * Output: Array of strings (subset of candidates)
 */
async function determineActiveContext(config, messages, candidates) {
  const recent = messages.slice(-4);
  const systemPrompt = `You are a Context Librarian.
Select the most relevant items from the list below that are needed for the current conversation context.
Candidates: ${JSON.stringify(candidates)}

Output a JSON array of strings containing ONLY the relevant items.
If nothing is relevant, output [].`;

  const payload = [
    { role: 'system', content: systemPrompt },
    ...recent
  ];

  try {
    const text = await generateCompletion(config, payload, { temperature: 0.1, max_tokens: 150, useUtility: true });
    const parsed = parseFirstJsonObject(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

/** Avoid exploding on circulars / big objects in error paths */
function safeJsonStringify(x) {
  try {
    return JSON.stringify(x);
  } catch {
    return String(x);
  }
}

module.exports = {
  getProviderSettings,
  testConnection,
  generateCompletion,
  generateStream,
  generateEmbedding,
  fetchInnerMonologue, // <-- Export the new function
  generateReplySuggestions,
  generateChapterTitle,
  summarizeChat,
  generateQuestObjective,
  analyzeAffinity,
  analyzeScene,
  cleanupResponse,
  extractUserFacts,
  expandImagePrompt,
  findClosestSprite,
  determineActiveContext,
  preloadEmbeddedModel,
  runHeuristicCleanup,
  axios,
  __private: {
    buildGeminiBody,
    buildChatCompletionsBody,
    parseOpenAISSEChunk,
    createOpenAISSEParser,
  },
};
