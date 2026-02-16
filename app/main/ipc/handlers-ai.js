'use strict';

function cleanMessagesForApi(messages) {
  return messages.map((m) => {
    let content = m.content;
    if (m.role === 'assistant' && m.renderReport) {
      content += `\n[SCENE_STATE: ${m.renderReport}]`;
    }
    return { role: m.role, content };
  });
}

function registerAiHandlers({
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
  userDataPath,
  getManifest,
  ensureManifestCoverage,
  getFiles,
  PROVIDER_CATEGORIES,
  buildVisualPrompt,
  buildStateInjection,
  buildLoreInjection,
  buildEnforcementRules,
  applyContextWindow,
  structuredCloneSafe,
  trace,
}) {
  const activeChatControllers = new Map(); // webContents.id -> AbortController

  ipcMain.handle('cancel-chat', (event) => {
    const t = trace.createTrace('cancel-chat');
    const id = event?.sender?.id;
    const controller = activeChatControllers.get(id);
    if (controller) {
      controller.abort();
      activeChatControllers.delete(id);
      return trace.ok(t, true);
    }
    return trace.ok(t, false);
  });

  ipcMain.handle('get-inner-monologue-FIXED', async (_event, characterName, messages) => {
    const t = trace.createTrace('get-inner-monologue-FIXED', { characterName: String(characterName || '') });
    const name = String(characterName || '').trim();
    if (!name) {
      return trace.fail(t, 'INVALID_CHARACTER', 'A character name is required.');
    }

    const config = loadConfig();
    const normalizedMessages = Array.isArray(messages)
      ? messages.map((m) => ({
          role: m?.role === 'assistant' ? 'assistant' : 'user',
          content: String(m?.content ?? ''),
        }))
      : [];
    const personalityPath = path.join(botFilesPath, 'characters', name, 'personality.txt');
    const personality = fs.existsSync(personalityPath) ? readTextSafe(personalityPath, '').slice(0, 8000) : '';

    try {
      const monologue = await aiService.fetchInnerMonologue(config, name, normalizedMessages, personality);
      return trace.ok(t, String(monologue || '').trim());
    } catch (error) {
      return trace.fail(
        t,
        'INNER_MONOLOGUE_ERROR',
        trace.normalizeErrorMessage(error, 'Failed to generate inner monologue.'),
        { characterName: name },
        error
      );
    }
  });

  ipcMain.handle('test-provider', async () => {
    const t = trace.createTrace('test-provider');
    try {
      const result = await aiService.testConnection(loadConfig());
      return trace.ok(t, result);
    } catch (error) {
      return trace.fail(t, 'PROVIDER_TEST_ERROR', trace.normalizeErrorMessage(error, 'Provider test failed.'), null, error);
    }
  });

  ipcMain.handle('evolve-character-state', async (_event, messages, activeCharacters) => {
    const t = trace.createTrace('evolve-character-state', { activeCount: Array.isArray(activeCharacters) ? activeCharacters.length : 0 });
    if (!Array.isArray(activeCharacters) || activeCharacters.length === 0) {
      return trace.ok(t, null);
    }

    const config = loadConfig();

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
      .map((m) => `${m.role}: ${String(m.content ?? '')}`)
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

      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;

      const updates = JSON.parse(jsonMatch[0]);

      const currentLore = readJsonSafe(lorebookPath, []);
      const loreArray = Array.isArray(currentLore) ? currentLore : [];

      for (const update of Object.values(updates)) {
        if (update?.NewLore?.scenario && update?.NewLore?.keywords) {
          loreArray.push(update.NewLore);
          delete update.NewLore;
        }
      }

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
      return trace.ok(t, merged);
    } catch (e) {
      return trace.fail(t, 'STATE_EVOLUTION_ERROR', trace.normalizeErrorMessage(e, 'Character state evolution failed.'), null, e);
    }
  });

  ipcMain.handle('send-chat', async (event, messages, options = {}) => {
    const t = trace.createTrace('send-chat');
    const senderId = event?.sender?.id;
    const messagesCopy = structuredCloneSafe(messages ?? []);
    const config = loadConfig();
    const settings = aiService.getProviderSettings(config);

    if (!settings.apiKey && settings.provider !== 'local') {
      return trace.fail(t, 'NO_API_KEY', 'No API key found for the active provider.');
    }

    const manifest = getManifest();
    for (const category of PROVIDER_CATEGORIES) {
      ensureManifestCoverage(manifest, category, getFiles(category));
    }

    const recentText = messagesCopy.slice(-3).map((m) => m.content || '').join(' ');
    const visualPrompt = buildVisualPrompt({ botImagesPath, botFilesPath }, manifest, options, recentText);

    const characterState = readJsonSafe(characterStatePath, {});
    const lorebook = readJsonSafe(lorebookPath, []);
    const loreEmbeddingsPath = path.join(userDataPath, 'aura_lorebook_embeddings.json');

    const stateInjection = buildStateInjection(characterState, options?.activeCharacters);
    const loreInjection = await buildLoreInjection(lorebook, messagesCopy, config, loreEmbeddingsPath);
    const advancedPromptContent = readTextSafe(advancedPromptPath, '').trim();

    const enforcementRules = buildEnforcementRules({
      stateInjection,
      loreInjection,
      advancedPromptContent,
    });

    const systemSuffix = visualPrompt + enforcementRules;
    const maxContext = Number(config.maxContext) || 128000;
    const finalMessages = applyContextWindow(cleanMessagesForApi(messagesCopy), { maxContext, systemSuffix });
    const webContents = event.sender;
    const controller = new AbortController();
    activeChatControllers.set(senderId, controller);

    try {
      const temperature = config.temperature !== undefined ? Number(config.temperature) : 0.7;
      const fullText = await aiService.generateStream(
        config,
        finalMessages,
        (chunk) => webContents.send('chat-reply-chunk', chunk),
        { temperature, signal: controller.signal }
      );

      const controlledText = await aiService.runHeuristicCleanup(fullText, {
        activeCharacters: options.activeCharacters,
        messages: messagesCopy,
      });

      return trace.ok(t, controlledText || '');
    } catch (error) {
      const isAbort =
        error?.name === 'AbortError' ||
        error?.code === 'ERR_CANCELED' ||
        /cancell?ed|aborted/i.test(String(error?.message || ''));
      if (isAbort) {
        return trace.fail(t, 'AI_ABORTED', 'Generation cancelled.', null, error);
      }
      return trace.fail(
        t,
        'AI_STREAM_ERROR',
        trace.normalizeErrorMessage(error, 'Failed to generate AI response.'),
        { provider: settings.provider },
        error
      );
    } finally {
      activeChatControllers.delete(senderId);
    }
  });
}

module.exports = { registerAiHandlers };
