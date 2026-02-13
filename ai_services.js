'use strict';

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
function getProviderSettings(config) {
  const provider = pickProvider(config);
  const apiKey = getApiKey(config, provider);

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
 * Quick “ping” that avoids token spend but still exercises auth + route.
 */
async function testConnection(config) {
  const settings = getProviderSettings(config);

  if (!settings.provider) {
    return { success: false, message: 'No active provider selected.' };
  }

  if (!settings.apiKey && settings.provider !== 'local') {
    return { success: false, message: `No API key found for ${settings.provider}.` };
  }

  try {
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
  const settings = getProviderSettings(config);
  if (!settings.apiKey && settings.provider !== 'local') return null;

  const temperature = options.temperature ?? 0.5;
  const maxTokens = options.max_tokens;

  try {
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
  if (!settings.apiKey && settings.provider !== 'local') return null;

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

    try {
      const data = JSON.parse(payload);
      const token = data?.choices?.[0]?.delta?.content;
      if (typeof token === 'string' && token.length) {
        onToken(token);
      }
    } catch {
      // Ignore partial/garbled lines; stream chunk boundaries can split JSON.
    }
  }
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

  if (!settings.apiKey && settings.provider !== 'local') {
    throw new Error('No API key found.');
  }

  if (settings.isGemini) {
    const url = geminiUrl(settings.model, settings.apiKey, true);
    const requestBody = buildGeminiBody(messages, { temperature, maxTokens });

    const response = await axios.post(url, requestBody, { responseType: 'stream' });
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
    }
  );

  const stream = response.data;
  let fullText = '';

  await new Promise((resolve, reject) => {
    stream.on('data', (chunk) => {
      const chunkStr = chunk.toString();
      parseOpenAISSEChunk(chunkStr, (token) => {
        fullText += token;
        onChunk(token);
      });
    });
    stream.on('end', resolve);
    stream.on('error', reject);
  });

  return fullText;
}

async function fetchInnerMonologue(config, characterName, messages) {
  const systemPrompt = `You are a world-class author. Based on the provided conversation history, write a short, first-person inner monologue for the character "${characterName}".
- The monologue should reveal their private thoughts, feelings, or intentions based on the recent events in the conversation.
- Write ONLY the monologue text itself.
- Do NOT include any surrounding text, narration, or quotation marks.
- The tone should match the character's personality and the current situation.`;

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
  axios,
};
