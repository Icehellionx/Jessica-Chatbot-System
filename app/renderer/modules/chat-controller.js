'use strict';

export function createChatController(deps) {
  const {
    windowObj,
    userInput,
    chatHistory,
    useStore,
    appendMessage,
    setGeneratingState,
    streamChat,
    buildPayload,
    getSceneContext,
    saveCurrentChatState,
    renderChat,
    runSidecarEnhancements,
    handleStalledConversation,
    handleMissingVisuals,
    visualHandlers,
    onTurnCompleted,
  } = deps;

  async function handleSend() {
    if (await handleStalledConversation()) {
      return;
    }

    const text = userInput.value.trim();
    if (!text) return;

    if (windowObj.voice) windowObj.voice.stop();

    appendMessage('user', text, windowObj.messages.length);
    userInput.value = '';
    windowObj.messages.push({ role: 'user', content: text });

    const sceneCharacters = getSceneContext(text);
    const { inventory, sceneObjects } = useStore.getState();

    let activeContextKeys = [];
    try {
      const lore = await windowObj.api.getLorebook() || [];
      const loreKeys = lore.map(e => `Lore: ${e.entry.slice(0, 20)}...`);
      if (loreKeys.length > 5) {
        const relevant = await windowObj.api.determineActiveContext(windowObj.messages, loreKeys);
        if (relevant?.length > 0) {
          console.log('[Librarian] Opening drawers:', relevant);
          activeContextKeys = relevant;
        }
      }
    } catch (e) {
      console.warn('[Librarian] Failed:', e);
    }

    const payload = buildPayload(sceneCharacters);
    setGeneratingState(true);

    try {
      const response = await streamChat(payload, {
        activeCharacters: sceneCharacters,
        inventory,
        sceneObjects,
        activeContextKeys,
      });

      if (response.content) {
        let finalContent = response.content;
        if (!response.cancelled && /[\[\]]/.test(finalContent)) {
          try {
            const cleaned = await windowObj.api.cleanupResponse(finalContent);
            if (cleaned && cleaned !== finalContent) {
              console.log('[Editor] Cleaned artifacts:', finalContent, '->', cleaned);
              finalContent = cleaned;
            }
          } catch (e) {
            console.warn('[Editor] Cleanup failed:', e);
          }
        }
        windowObj.messages.push({ role: 'assistant', content: finalContent, renderReport: response.report });
      } else if (!response.cancelled) {
        windowObj.messages.push({ role: 'assistant', content: '', renderReport: response.report });
      }

      await runSidecarEnhancements(response, sceneCharacters);

      await saveCurrentChatState();
      renderChat();
      if (onTurnCompleted) onTurnCompleted();
    } catch (error) {
      console.error('Chat Error:', error);
      windowObj.messages.pop();
      if (chatHistory.lastChild) chatHistory.removeChild(chatHistory.lastChild);
      if (chatHistory.lastChild) chatHistory.removeChild(chatHistory.lastChild);
      userInput.value = text;
      if (windowObj.showErrorModal) windowObj.showErrorModal(error, 'Failed to send message.');
      else alert(windowObj.formatApiError ? windowObj.formatApiError(error, 'Failed to send message.') : 'Failed to send message.');
    } finally {
      setGeneratingState(false);
    }

    windowObj.refocusInput();
  }

  async function swapMessageVersion(msgIndex, swipeIndex) {
    const msg = windowObj.messages[msgIndex];
    if (!msg || !msg.swipes || !msg.swipes[swipeIndex]) return;

    msg.swipeId = swipeIndex;
    msg.content = msg.swipes[swipeIndex];
    renderChat();

    const { missing } = windowObj.processVisualTags(msg.content, { store: useStore.getState(), handlers: visualHandlers });
    if (missing?.length) handleMissingVisuals(missing);

    await saveCurrentChatState();
  }

  async function deleteSwipe(msgIndex) {
    const msg = windowObj.messages[msgIndex];
    if (!msg || !msg.swipes || msg.swipes.length <= 1) return;

    const yes = await windowObj.showConfirmModal('Delete Branch', 'Are you sure you want to delete this version of the message?');
    if (!yes) return;

    const currentIdx = msg.swipeId || 0;
    msg.swipes.splice(currentIdx, 1);
    msg.swipeId = Math.max(0, Math.min(currentIdx, msg.swipes.length - 1));
    msg.content = msg.swipes[msg.swipeId];

    renderChat();

    const { missing } = windowObj.processVisualTags(msg.content, { store: useStore.getState(), handlers: visualHandlers });
    if (missing?.length) handleMissingVisuals(missing);

    await saveCurrentChatState();
  }

  async function regenerateResponse({ replace } = { replace: false }) {
    if (!windowObj.messages.length) return;

    try {
      const last = windowObj.messages[windowObj.messages.length - 1];
      let previousSwipes = [];
      let targetSwipeIndex = 0;

      if (last?.role === 'assistant') {
        previousSwipes = last.swipes || [last.content];
        targetSwipeIndex = last.swipeId !== undefined ? last.swipeId : (previousSwipes.length - 1);
        windowObj.messages.pop();
      }

      renderChat();

      const lastUser = windowObj.messages[windowObj.messages.length - 1];
      const text = lastUser?.role === 'user' ? lastUser.content : '';
      const sceneCharacters = getSceneContext(text);

      const payload = buildPayload(sceneCharacters);
      const { inventory, sceneObjects } = useStore.getState();
      const { content: rawResponse, report } = await streamChat(payload, {
        activeCharacters: sceneCharacters,
        inventory,
        sceneObjects,
      });

      let newSwipes;
      let newSwipeId;

      if (replace) {
        newSwipes = [...previousSwipes];
        newSwipes[targetSwipeIndex] = rawResponse;
        newSwipeId = targetSwipeIndex;
      } else {
        newSwipes = [...previousSwipes, rawResponse];
        newSwipeId = newSwipes.length - 1;
      }

      windowObj.messages.push({
        role: 'assistant',
        content: rawResponse,
        swipes: newSwipes,
        swipeId: newSwipeId,
        renderReport: report,
      });

      await saveCurrentChatState();
    } catch (error) {
      console.error('Regenerate Error:', error);
      if (windowObj.showErrorModal) windowObj.showErrorModal(error, 'Failed to regenerate response.');
      else {
        const f = windowObj.formatApiError || ((err, d) => err?.message || d);
        alert(f(error, 'Failed to regenerate response.'));
      }
    } finally {
      windowObj.refocusInput();
    }
  }

  return {
    handleSend,
    swapMessageVersion,
    deleteSwipe,
    regenerateResponse,
  };
}
