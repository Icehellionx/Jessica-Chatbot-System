'use strict';

export function createChatSessionController({
  windowObj,
  useStore,
  chatHistory,
  appendMessage,
  parseMarkdown,
  getSceneContext,
  getMood,
  normalizeText,
  updateThoughtsDropdown,
  onRegenerate,
}) {
  async function saveCurrentChatState() {
    console.log('Saving current state...');
    console.log('[DEBUG] Active Sprites Map:', windowObj.__activeSprites);

    const messages = windowObj.messages || [];
    const { currentBackground, characters, currentMusic, currentSplash } = useStore.getState();
    const background = currentBackground || '';
    const splash = currentSplash || '';

    const spriteFilenames = [];
    for (const [name, charState] of Object.entries(characters)) {
      if (charState.isVisible) {
        const file = windowObj.findBestSprite(name, charState.emotion);
        if (file) spriteFilenames.push(file);
      }
    }

    const music = currentMusic || '';
    const state = { messages, background, sprites: spriteFilenames, splash, music };

    console.log('[DEBUG] Saving Snapshot:', state);
    await windowObj.api.saveCurrentChat(state);
  }

  async function restoreChatState(state) {
    console.log('[DEBUG] Restoring Snapshot:', state);

    const { setBackground, setCharacterEmotion, setCharacterVisibility, setMusic, setSplash, characters } = useStore.getState();

    windowObj.messages = Array.isArray(state?.messages) ? state.messages : [];
    useStore.setState({ dialogueHistory: windowObj.messages });

    let bgToLoad = null;
    if (state?.background) {
      bgToLoad = windowObj.validateImage(state.background, 'backgrounds');
      console.log(`[DEBUG] Background '${state.background}' validated as:`, bgToLoad);
    }

    if (!bgToLoad) {
      console.log('[DEBUG] No valid background found in save, attempting fallback...');
      const bgs = windowObj.imageManifest?.backgrounds ? Object.keys(windowObj.imageManifest.backgrounds) : [];
      if (bgs.length > 0) bgToLoad = bgs[0];
    }

    console.log('[DEBUG] Final Background to Load:', bgToLoad);
    if (bgToLoad) setBackground(bgToLoad);

    Object.keys(characters).forEach((char) => setCharacterVisibility(char, false));

    if (Array.isArray(state?.sprites)) {
      console.log('[DEBUG] Restoring Sprites List:', state.sprites);
      for (const filename of state.sprites) {
        const charName = windowObj.getCharacterName(filename);
        const mood = filename.split('/').pop().split('.')[0].replace(new RegExp(`^${charName}[_-]`, 'i'), '');
        if (charName) {
          setCharacterVisibility(charName, true);
          setCharacterEmotion(charName, mood || 'default');
        }
      }
    }

    if (state?.splash) setSplash(state.splash);
    else setSplash(null);

    if (state?.music) setMusic(state.music);
    else setMusic(null);

    renderChat();
    updateThoughtsDropdown();

    if (windowObj.voice && windowObj.messages.length > 0) {
      const lastMsg = windowObj.messages[windowObj.messages.length - 1];
      if (lastMsg && lastMsg.role === 'assistant') {
        windowObj.voice.speak(lastMsg.content, getSceneContext(lastMsg.content));
      }
    }

    console.log('Chat state restored by setting store state.');
  }

  function renderChat() {
    chatHistory.innerHTML = '';

    windowObj.messages.forEach((msg, index) => {
      const msgDiv = appendMessage(msg.role, msg.content, index);

      if (index === windowObj.messages.length - 1 && msg.role === 'assistant') {
        const actionsDiv = document.createElement('div');
        actionsDiv.style.cssText = 'float:right; display:flex; align-items:center;';

        const redoBtn = document.createElement('button');
        redoBtn.className = 'msg-action-btn';
        redoBtn.innerHTML = '↻';
        redoBtn.title = 'Redo (Replace current)';
        redoBtn.onclick = () => onRegenerate({ replace: true });

        const branchBtn = document.createElement('button');
        branchBtn.className = 'msg-action-btn';
        branchBtn.innerHTML = '⑂';
        branchBtn.title = 'Branch (Create new)';
        branchBtn.onclick = () => onRegenerate({ replace: false });

        actionsDiv.appendChild(redoBtn);
        actionsDiv.appendChild(branchBtn);
        msgDiv.appendChild(actionsDiv);
      }
    });

    const lastMsg = windowObj.messages[windowObj.messages.length - 1];
    if (windowObj.setDialogue) {
      if (lastMsg) {
        windowObj.setDialogue(parseMarkdown(windowObj.stripVisualTags(lastMsg.content)), false);
      } else {
        windowObj.setDialogue('', false);
      }
    }

    chatHistory.scrollTop = chatHistory.scrollHeight;
  }

  return {
    saveCurrentChatState,
    restoreChatState,
    renderChat,
  };
}
