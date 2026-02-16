'use strict';

const axiosLib = require('axios');
const {
  parseOpenAISSEChunk,
  createOpenAISSEParser,
  createGeminiJsonObjectExtractor,
  parseFirstJsonObject,
  parseTagLines,
  toTagPlanFromJson,
} = require('./ipc/ai-parsers');
const { createSceneTools } = require('./ipc/ai-scene-tools');
const { createAssistantTools } = require('./ipc/ai-assistant-tools');
const { createStoryTools } = require('./ipc/ai-story-tools');
const { createInnerMonologueTool } = require('./ipc/ai-inner-monologue');
const {
  PROVIDER_DEFAULTS,
  GEMINI_API_BASE,
  getProviderSettings: resolveProviderSettingsBase,
  authHeaders,
  getUtilitySettings: resolveUtilitySettingsBase,
  buildGeminiBody,
  buildChatCompletionsBody,
  geminiUrl,
} = require('./ipc/ai-provider');
const {
  findEmbeddedModelPath,
  getEmbeddedLlamaState,
  generateEmbeddedCompletion,
} = require('./ipc/ai-embedded');

/**
 * Shared axios instance so you can set defaults in one place (timeout, etc).
 * You can also attach interceptors later if you want request logging.
 */
const axios = axiosLib.create({
  timeout: 30_000,
  // validateStatus: () => true, // uncomment if you want to handle non-2xx manually everywhere
});

function getProviderSettings(config, forceProvider = null) {
  return resolveProviderSettingsBase(config, {
    forceProvider,
    hasEmbeddedModel: (modelName) => Boolean(findEmbeddedModelPath(modelName)),
  });
}

function getUtilitySettings(config) {
  return resolveUtilitySettingsBase(config, {
    hasEmbeddedModel: (modelName) => Boolean(findEmbeddedModelPath(modelName)),
  });
}

/**
 * Preloads the embedded model if it exists.
 * Useful to call on app startup so the first request isn't slow.
 */
async function preloadEmbeddedModel(config) {
  const modelName = config?.models?.embedded || PROVIDER_DEFAULTS.embedded.model;
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

const { fetchInnerMonologue } = createInnerMonologueTool({ generateCompletion });

const { analyzeScene, runHeuristicCleanup } = createSceneTools({
  generateCompletion,
  parseFirstJsonObject,
  parseTagLines,
  toTagPlanFromJson,
});

const {
  generateReplySuggestions,
  generateChapterTitle,
  summarizeChat,
  generateQuestObjective,
  analyzeAffinity,
} = createAssistantTools({
  generateCompletion,
  parseFirstJsonObject,
});

const {
  cleanupResponse,
  extractUserFacts,
  expandImagePrompt,
  findClosestSprite,
  determineActiveContext,
  generateDynamicEvent,
  reviewVisuals,
} = createStoryTools({
  generateCompletion,
  parseFirstJsonObject,
  parseTagLines,
});

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
  reviewVisuals,
  generateDynamicEvent,
  axios,
  __private: {
    buildGeminiBody,
    buildChatCompletionsBody,
    parseOpenAISSEChunk,
    createOpenAISSEParser,
    parseFirstJsonObject,
  },
};
