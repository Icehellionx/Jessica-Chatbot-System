'use strict';

function createConfigStore({ configPath, readJsonSafe, writeJsonSafe, clone, safeStorage }) {
  function decryptApiKey(value) {
    if (typeof value !== 'string' || value.length === 0) return null;

    if (value.startsWith('enc:')) {
      if (!safeStorage?.isEncryptionAvailable?.()) return null;
      try {
        const encrypted = Buffer.from(value.slice(4), 'base64');
        return safeStorage.decryptString(encrypted);
      } catch {
        return null;
      }
    }

    // Backward compatibility for legacy plaintext keys.
    return value;
  }

  function encryptApiKey(value) {
    const key = String(value ?? '').trim();
    if (!key) return null;

    if (!safeStorage?.isEncryptionAvailable?.()) {
      return key;
    }

    try {
      const encrypted = safeStorage.encryptString(key).toString('base64');
      return `enc:${encrypted}`;
    } catch {
      return key;
    }
  }

  function load() {
    const config = readJsonSafe(configPath, {});
    const keyMap = {};

    if (config?.apiKeysEncrypted && typeof config.apiKeysEncrypted === 'object') {
      for (const [provider, value] of Object.entries(config.apiKeysEncrypted)) {
        const decrypted = decryptApiKey(value);
        if (decrypted) keyMap[provider] = decrypted;
      }
    }

    if (config?.apiKeys && typeof config.apiKeys === 'object') {
      for (const [provider, value] of Object.entries(config.apiKeys)) {
        const decrypted = decryptApiKey(value);
        if (decrypted) keyMap[provider] = decrypted;
      }
    }

    config.apiKeys = keyMap;

    // Dedicated Pollinations image key (stored encrypted when available).
    const pollinationsWrapped = config?.pollinationsApiKeyEncrypted ?? config?.pollinationsApiKey ?? null;
    const pollinationsDecrypted = decryptApiKey(pollinationsWrapped);
    if (pollinationsDecrypted) config.pollinationsApiKey = pollinationsDecrypted;
    else delete config.pollinationsApiKey;

    return config;
  }

  function save(config) {
    const copy = clone(config ?? {});
    const apiKeys = copy?.apiKeys && typeof copy.apiKeys === 'object' ? copy.apiKeys : {};
    const encrypted = {};

    for (const [provider, key] of Object.entries(apiKeys)) {
      const wrapped = encryptApiKey(key);
      if (wrapped) encrypted[provider] = wrapped;
    }

    const pollinationsWrapped = encryptApiKey(copy?.pollinationsApiKey);
    if (pollinationsWrapped) copy.pollinationsApiKeyEncrypted = pollinationsWrapped;
    else delete copy.pollinationsApiKeyEncrypted;

    copy.apiKeysEncrypted = encrypted;
    delete copy.apiKeys;
    delete copy.pollinationsApiKey;

    return writeJsonSafe(configPath, copy);
  }

  function toPublic(config) {
    const copy = clone(config ?? {});
    const keys = copy?.apiKeys && typeof copy.apiKeys === 'object' ? copy.apiKeys : {};
    copy.apiKeys = Object.fromEntries(Object.keys(keys).map((provider) => [provider, '********']));
    copy.hasPollinationsApiKey = Boolean(copy?.pollinationsApiKey);
    delete copy.pollinationsApiKey;
    delete copy.apiKeysEncrypted;
    delete copy.pollinationsApiKeyEncrypted;
    return copy;
  }

  return { load, save, toPublic };
}

module.exports = { createConfigStore };
