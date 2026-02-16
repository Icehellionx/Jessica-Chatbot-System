'use strict';

const PROVIDER_DEFAULTS = Object.freeze({
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', model: 'mistralai/mistral-7b-instruct:free' },
  grok: { baseUrl: 'https://api.x.ai/v1', model: 'grok-beta' },
  chutes: { baseUrl: 'https://chutes.ai/api/v1', model: 'chutes-model' },
  featherless: { baseUrl: 'https://api.featherless.ai/v1', model: 'meta-llama/Meta-Llama-3-8B-Instruct' },
  local: { baseUrl: 'http://localhost:1234/v1', model: 'local-model' },
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-3.5-turbo' },
  embedded: { baseUrl: '', model: 'model.gguf' },
});

const GEMINI_DEFAULT_MODEL = 'gemini-1.5-flash';
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

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

function getProviderSettings(config, { forceProvider = null, hasEmbeddedModel = () => false } = {}) {
  let provider = forceProvider || pickProvider(config);
  let apiKey = getApiKey(config, provider);

  if (!apiKey && provider !== 'local' && provider !== 'embedded') {
    const embeddedModelName = getSavedModel(config, 'embedded') || PROVIDER_DEFAULTS.embedded.model;
    if (hasEmbeddedModel(embeddedModelName)) {
      provider = 'embedded';
    }
  }

  if (provider === 'gemini') {
    return {
      provider,
      apiKey,
      model: getSavedModel(config, provider) ?? GEMINI_DEFAULT_MODEL,
      baseURL: null,
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

function authHeaders(apiKey) {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

function getUtilitySettings(config, { hasEmbeddedModel = () => false } = {}) {
  if (config?.utilityProvider) {
    return getProviderSettings(config, { forceProvider: config.utilityProvider, hasEmbeddedModel });
  }

  const embeddedModelName = getSavedModel(config, 'embedded') || PROVIDER_DEFAULTS.embedded.model;
  if (hasEmbeddedModel(embeddedModelName)) {
    return getProviderSettings(config, { forceProvider: 'embedded', hasEmbeddedModel });
  }

  const localBase = getSavedBaseUrl(config, 'local');
  if (localBase && config.activeProvider !== 'local') {
    return getProviderSettings(config, { forceProvider: 'local', hasEmbeddedModel });
  }

  return getProviderSettings(config, { hasEmbeddedModel });
}

function buildGeminiBody(messages, { maxTokens, temperature } = {}) {
  const systemMsg = messages.find((m) => m.role === 'system');
  const chatMsgs = messages.filter((m) => m.role !== 'system');

  const systemInstruction = systemMsg
    ? { parts: [{ text: String(systemMsg.content ?? '') }] }
    : undefined;

  const contents = chatMsgs.map((m) => {
    const role = m.role === 'user' ? 'user' : 'model';

    if (Array.isArray(m.content)) {
      const parts = [];

      for (const c of m.content) {
        if (c?.type === 'text' && typeof c.text === 'string') {
          parts.push({ text: c.text });
        }

        if (c?.type === 'image_url' && c.image_url?.url) {
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

    return { role, parts: [{ text: String(m.content ?? '') }] };
  });

  const body = { contents };
  if (systemInstruction) body.systemInstruction = systemInstruction;

  if (maxTokens != null || temperature != null) {
    body.generationConfig = {};
    if (maxTokens != null) body.generationConfig.maxOutputTokens = maxTokens;
    if (temperature != null) body.generationConfig.temperature = temperature;
  }

  return body;
}

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

function geminiUrl(model, apiKey, isStream = false) {
  const method = isStream ? 'streamGenerateContent' : 'generateContent';
  return `${GEMINI_API_BASE}/${encodeURIComponent(model)}:${method}?key=${encodeURIComponent(apiKey)}`;
}

module.exports = {
  PROVIDER_DEFAULTS,
  GEMINI_DEFAULT_MODEL,
  GEMINI_API_BASE,
  pickProvider,
  getApiKey,
  getSavedModel,
  getSavedBaseUrl,
  getProviderSettings,
  authHeaders,
  getUtilitySettings,
  buildGeminiBody,
  buildChatCompletionsBody,
  geminiUrl,
};
