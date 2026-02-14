'use strict';
const { shell } = require('electron');


function registerConfigHandlers({
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
}) {
  ipcMain.handle('get-config', () => {
    const t = trace.createTrace('get-config');
    return trace.ok(t, toPublicConfig(loadConfig()));
  });

  ipcMain.handle('save-api-key', (_event, provider, key, model, baseUrl) => {
    const t = trace.createTrace('save-api-key', { provider: String(provider || '') });
    const config = loadConfig();

    config.apiKeys ??= {};
    config.models ??= {};
    config.baseUrls ??= {};

    config.apiKeys[provider] = key;

    if (model) config.models[provider] = model;
    if (baseUrl) config.baseUrls[provider] = baseUrl;

    config.activeProvider = provider;

    return trace.ok(t, saveConfig(config) ? toPublicConfig(loadConfig()) : null);
  });

  ipcMain.handle('delete-api-key', (_event, provider) => {
    const t = trace.createTrace('delete-api-key', { provider: String(provider || '') });
    const config = loadConfig();

    if (config?.apiKeys?.[provider]) {
      delete config.apiKeys[provider];
      if (config.activeProvider === provider) delete config.activeProvider;
      saveConfig(config);
    }

    return trace.ok(t, toPublicConfig(loadConfig()));
  });

  ipcMain.handle('set-active-provider', (_event, provider) => {
    const t = trace.createTrace('set-active-provider', { provider: String(provider || '') });
    const config = loadConfig();
    if (config?.apiKeys?.[provider]) {
      config.activeProvider = provider;
      return trace.ok(t, saveConfig(config));
    }
    return trace.ok(t, false);
  });

  ipcMain.handle('save-persona', (_e, persona) => {
    const t = trace.createTrace('save-persona');
    return trace.ok(t, writeJsonSafe(personaPath, persona));
  });
  ipcMain.handle('get-persona', () => {
    const t = trace.createTrace('get-persona');
    const p = readJsonSafe(personaPath, DEFAULT_PERSONA);
    return trace.ok(t, p?.name ? p : DEFAULT_PERSONA);
  });

  ipcMain.handle('save-summary', (_e, summary) => {
    const t = trace.createTrace('save-summary');
    return trace.ok(t, writeJsonSafe(summaryPath, summary));
  });
  ipcMain.handle('get-summary', () => {
    const t = trace.createTrace('get-summary');
    const s = readJsonSafe(summaryPath, DEFAULT_SUMMARY);
    return trace.ok(t, s?.content != null ? s : DEFAULT_SUMMARY);
  });

  ipcMain.handle('get-lorebook', () => {
    const t = trace.createTrace('get-lorebook');
    const l = readJsonSafe(lorebookPath, []);
    return trace.ok(t, Array.isArray(l) ? l : []);
  });
  ipcMain.handle('save-lorebook', (_e, content) => {
    const t = trace.createTrace('save-lorebook');
    return trace.ok(t, writeJsonSafe(lorebookPath, content));
  });

  ipcMain.handle('get-advanced-prompt', () => {
    const t = trace.createTrace('get-advanced-prompt');
    return trace.ok(t, readTextSafe(advancedPromptPath, ''));
  });
  ipcMain.handle('save-advanced-prompt', (_e, prompt) => {
    const t = trace.createTrace('save-advanced-prompt');
    return trace.ok(t, writeTextSafe(advancedPromptPath, prompt));
  });

  ipcMain.handle('save-temperature', (_e, t) => {
    const tr = trace.createTrace('save-temperature');
    const c = loadConfig();
    c.temperature = Number(t);
    return trace.ok(tr, saveConfig(c));
  });

  ipcMain.handle('save-max-context', (_e, l) => {
    const tr = trace.createTrace('save-max-context');
    const c = loadConfig();
    c.maxContext = Number.parseInt(l, 10);
    return trace.ok(tr, saveConfig(c));
  });

  ipcMain.handle('save-pollinations-key', (_e, key) => {
    const t = trace.createTrace('save-pollinations-key');
    const c = loadConfig();
    const normalized = String(key ?? '').trim();
    if (normalized) c.pollinationsApiKey = normalized;
    else delete c.pollinationsApiKey;
    return trace.ok(t, saveConfig(c));
  });


  ipcMain.handle('open-external-url', async (_e, rawUrl) => {
    const t = trace.createTrace('open-external-url');
    const url = String(rawUrl || '').trim();
    if (!/^https?:\/\//i.test(url)) {
      return trace.fail(t, 'INVALID_URL', 'Only http(s) URLs are allowed.', { url });
    }

    try {
      await shell.openExternal(url);
      return trace.ok(t, true);
    } catch (err) {
      return trace.fail(t, 'OPEN_EXTERNAL_FAILED', 'Failed to open external URL.', { url }, err);
    }
  });
  ipcMain.handle('toggle-dev-tools', (event, open) => {
    const t = trace.createTrace('toggle-dev-tools');
    if (open === undefined || open === null) {
      event.sender.toggleDevTools();
    } else if (open) {
      event.sender.openDevTools({ mode: 'detach' });
    } else {
      event.sender.closeDevTools();
    }
    return trace.ok(t, true);
  });
}

module.exports = { registerConfigHandlers };


