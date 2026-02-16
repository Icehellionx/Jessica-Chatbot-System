'use strict';

export function createSidecarController(deps) {
  const {
    windowObj,
    documentObj,
    useStore,
    hasVisualDirectives,
    getRecentMessagesForDirector,
    mergeDirectives,
    appendSystemNotice,
    appendMessage,
    handleMissingVisuals,
    saveCurrentChatState,
    setGeneratingState,
    getTurnCount,
    updateHistorySummary,
    visualHandlers,
  } = deps;

  async function runVisualQualityPass() {
    console.log('[Quality Pass] Running visual review...');
    try {
      const { currentBackground } = useStore.getState();
      const activeCharacters = windowObj.getActiveSpriteNames ? windowObj.getActiveSpriteNames() : [];

      const correctionTags = await windowObj.api.reviewVisuals({
        messages: windowObj.messages,
        currentBackground,
        activeCharacters,
      });

      if (correctionTags && correctionTags.length > 0) {
        console.log('[Quality Pass] Applying corrections:', correctionTags);
        appendSystemNotice(`Applying visual corrections: ${correctionTags}`);
        const { missing } = windowObj.processVisualTags(correctionTags, { store: useStore.getState(), handlers: visualHandlers });
        if (missing?.length) {
          await handleMissingVisuals(missing);
        }
        await saveCurrentChatState();
      } else {
        console.log('[Quality Pass] No corrections needed.');
      }
    } catch (e) {
      console.warn('[Quality Pass] Failed to run visual review:', e);
    }
  }

  async function runSidecarEnhancements(response, sceneCharacters) {
    const { content, report, cancelled } = response;
    if (cancelled) return;

    const config = await windowObj.api.getConfig();
    const directorMode = config.directorMode || 'fallback';
    const shouldRunDirector = (directorMode === 'always') || (directorMode === 'fallback' && !hasVisualDirectives(content));

    if (content && shouldRunDirector && directorMode !== 'off') {
      const activeNames = windowObj.getActiveSpriteNames ? windowObj.getActiveSpriteNames() : [];
      const currentState = useStore.getState();
      const tags = await windowObj.api.getStageDirections(content, activeNames, {
        recentMessages: getRecentMessagesForDirector(windowObj.messages),
        currentBackground: currentState.currentBackground || '',
        currentMusic: currentState.currentMusic || '',
        inventory: currentState.inventory || [],
        sceneObjects: currentState.sceneObjects || [],
        lastRenderReport: report || '',
      });

      if (tags && hasVisualDirectives(tags)) {
        console.log('[Director] Suggested tags:', tags);
        const mergedContent = mergeDirectives(content, tags);
        const { missing } = windowObj.processVisualTags(mergedContent, { store: useStore.getState(), handlers: visualHandlers });
        if (missing?.length) handleMissingVisuals(missing);
        windowObj.messages[windowObj.messages.length - 1].content = mergedContent;
      }
    }

    const turnCount = getTurnCount();

    if (turnCount % 2 === 0) {
      (async () => {
        try {
          const objective = await windowObj.api.getQuestObjective(windowObj.messages);
          const objEl = documentObj.getElementById('hud-objective');
          if (objEl) objEl.textContent = `Objective: ${objective}`;

          const activeNames = windowObj.getActiveSpriteNames ? windowObj.getActiveSpriteNames() : [];
          if (activeNames.length > 0) {
            const affinity = await windowObj.api.getAffinity(windowObj.messages, activeNames[0]);
            const affEl = documentObj.getElementById('hud-affinity');
            if (affEl && affinity) affEl.textContent = `Affinity: ${affinity.status} (${affinity.score}%)`;
          }
        } catch (e) { console.warn('Game state update failed', e); }
      })();
    }

    if (turnCount > 0 && turnCount % 4 === 0) {
      (async () => {
        try {
          const newEntries = await windowObj.api.extractUserFacts(windowObj.messages);
          if (newEntries && newEntries.length > 0) {
            console.log('[Profiler] Discovered facts:', newEntries);
            const currentLore = await windowObj.api.getLorebook() || [];
            let added = false;
            for (const item of newEntries) {
              if (!currentLore.some(e => e.entry === item.entry) && item.entry && item.keywords) {
                currentLore.push({ entry: item.entry, keywords: item.keywords, scenario: 'User Memory' });
                added = true;
              }
            }
            if (added) {
              await windowObj.api.saveLorebook(currentLore);
              if (windowObj.showToast) windowObj.showToast(`Memory Updated: ${newEntries.length} new fact(s)`);
            }
          }
        } catch (e) { console.warn('[Profiler] Failed:', e); }
      })();
    }

    await runVisualQualityPass();

    if (turnCount > 0 && turnCount % 5 === 0) {
      windowObj.api.evolveCharacterState(windowObj.messages, sceneCharacters)
        .then(updates => { if (updates) console.log('[Character Evolution] State updated:', updates); })
        .catch(e => console.warn('Evolution skipped:', e));
    }
    if (turnCount > 0 && turnCount % 10 === 0) {
      updateHistorySummary(turnCount % 50 === 0);
    }
  }

  async function handleStalledConversation() {
    const isStalled = windowObj.messages.length >= 2 &&
      windowObj.messages[windowObj.messages.length - 1].role === 'user' &&
      windowObj.messages[windowObj.messages.length - 2].role === 'user';

    if (!isStalled) return false;

    console.log('[Event Director] Conversation stalled, attempting to generate event.');
    try {
      setGeneratingState(true);
      appendSystemNotice('The air hangs heavy with silence. What happens next?');
      const { currentBackground } = useStore.getState();
      const activeCharacters = windowObj.getActiveSpriteNames ? windowObj.getActiveSpriteNames() : [];

      const eventText = await windowObj.api.generateDynamicEvent({
        messages: windowObj.messages,
        currentBackground,
        activeCharacters,
      });

      if (eventText) {
        appendMessage('system', `* ${eventText}`, undefined);
        const { missing } = windowObj.processVisualTags(eventText, { store: useStore.getState(), handlers: visualHandlers });
        if (missing?.length) await handleMissingVisuals(missing);

        windowObj.messages.push({ role: 'system', content: `[SCENE EVENT] ${eventText}` });
        await saveCurrentChatState();
      }
    } catch (e) {
      console.error('[Event Director] Failed to generate event:', e);
      appendSystemNotice('A moment passes, but nothing happens.');
    } finally {
      setGeneratingState(false);
      windowObj.refocusInput();
    }

    return true;
  }

  return {
    runVisualQualityPass,
    runSidecarEnhancements,
    handleStalledConversation,
  };
}
