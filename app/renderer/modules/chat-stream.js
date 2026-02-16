'use strict';

export function createChatStreamer({
  windowObj,
  chatHistory,
  createMessageElement,
  parseMarkdown,
  getMood,
  useStore,
  getVisualHandlers,
  handleMissingVisuals,
  updateThoughtsDropdown,
}) {
  function createAssistantStreamBubble() {
    const { msgDiv, contentDiv } = createMessageElement('assistant', '', undefined);
    contentDiv.innerHTML = '<div class="typing-dots"><span></span><span></span><span></span></div>';

    chatHistory.appendChild(msgDiv);
    chatHistory.scrollTop = chatHistory.scrollHeight;

    return { msgDiv, contentDiv };
  }

  async function streamChat(payload, options) {
    const { contentDiv } = createAssistantStreamBubble();

    let accumulated = '';
    let received = false;
    let removeListener = null;

    try {
      removeListener = windowObj.api.onChatReplyChunk((chunk) => {
        if (!received) {
          contentDiv.innerHTML = '';
          received = true;
        }
        accumulated += chunk;

        const parsed = parseMarkdown(windowObj.stripVisualTags(accumulated));
        contentDiv.innerHTML = parsed;
        if (windowObj.setDialogue) windowObj.setDialogue(parsed, true);

        chatHistory.scrollTop = chatHistory.scrollHeight;
      });

      const fullResponse = await windowObj.api.sendChat(payload, options);

      if (removeListener) {
        removeListener();
        removeListener = null;
      }

      const { stats, missing, report } = windowObj.processVisualTags(fullResponse, { store: useStore.getState(), handlers: getVisualHandlers() });
      if (missing?.length) handleMissingVisuals(missing);

      const activeSprites = windowObj.__activeSprites || new Map();
      const mood = getMood(fullResponse);
      for (const charName of activeSprites.keys()) {
        if (stats.updatedCharNames && stats.updatedCharNames.has(charName)) continue;

        const sprite = windowObj.findBestSprite(charName, mood);
        if (sprite) windowObj.updateSprite(sprite);
      }

      updateThoughtsDropdown();

      contentDiv.innerHTML = parseMarkdown(windowObj.stripVisualTags(fullResponse));
      if (windowObj.setDialogue) windowObj.setDialogue(contentDiv.innerHTML, false);

      if (windowObj.voice) {
        windowObj.voice.speak(fullResponse, options.activeCharacters);
      }

      return { content: fullResponse.trim(), report, cancelled: false };
    } catch (error) {
      const isCancelled = error?.code === 'AI_ABORTED';
      if (isCancelled) {
        const partial = String(accumulated || '').trim();
        return { content: partial, report: null, cancelled: true };
      }
      throw error;
    } finally {
      if (removeListener) removeListener();
      chatHistory.scrollTop = chatHistory.scrollHeight;
    }
  }

  return {
    createAssistantStreamBubble,
    streamChat,
  };
}
