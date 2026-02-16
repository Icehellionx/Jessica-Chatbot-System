'use strict';

export function createChatInitializer(deps) {
  const {
    windowObj,
    useStore,
    userInput,
    normalizeText,
    getMood,
    getSceneContext,
    renderChat,
    updateThoughtsDropdown,
    handleMissingVisuals,
    saveCurrentChatState,
    visualHandlers,
    setTurnCount,
  } = deps;

  async function initializeChat() {
    const overlay = windowObj.document.getElementById('loading-overlay');
    overlay?.classList.add('active');

    userInput.value = '';
    userInput.disabled = false;
    userInput.focus();

    try {
      windowObj.messages = [];
      renderChat();

      if (windowObj.__activeSprites) {
        windowObj.__activeSprites.forEach(img => img.remove());
        windowObj.__activeSprites.clear();
      }
      windowObj.hideSplash();
      if (windowObj.setDialogue) windowObj.setDialogue('');

      const { setCharacterVisibility, setCharacterEmotion, characters, setSplash } = useStore.getState();
      Object.keys(characters).forEach(char => setCharacterVisibility(char, false));
      setSplash(null);

      let initialText =
        windowObj.botInfo.initial ||
        "Error: Could not load 'bot/files/initial.txt'. Please check that the file exists.";

      initialText = initialText.replace(/{{user}}/g, windowObj.userPersona.name);

      if (!/\[(BG|SPRITE|SPLASH|MUSIC|HIDE):/i.test(initialText)) {
        const mood = getMood(initialText);
        const activeChars = getSceneContext(initialText);

        for (const charName of activeChars) {
          const sprite = windowObj.findBestSprite(charName, mood);
          if (sprite) {
            windowObj.updateSprite(sprite);
            setCharacterVisibility(charName, true);
            setCharacterEmotion(charName, mood || 'default');
          }
        }

        const norm = normalizeText(initialText);
        const bgs = windowObj.imageManifest?.backgrounds ? Object.keys(windowObj.imageManifest.backgrounds) : [];

        let bestBg = bgs.find(bg => {
          const name = bg.split(/[/\\]/).pop().split('.')[0].toLowerCase();
          return name.length > 2 && norm.includes(name);
        });

        if (!bestBg) {
          bestBg = bgs.find(bg => {
            const lower = bg.toLowerCase();
            return lower.includes('default') || lower.includes('main') || lower.includes('base') || lower.includes('common');
          });
        }

        if (!bestBg && bgs.length > 0) {
          const allCharNames = windowObj.botInfo.characters ? Object.keys(windowObj.botInfo.characters).map(c => c.toLowerCase()) : [];
          const activeCharNamesLower = activeChars.map(c => c.toLowerCase());

          bestBg = bgs.find(bg => {
            const lowerBg = bg.toLowerCase();
            const mentionsInactive = allCharNames.some(charName =>
              !activeCharNamesLower.includes(charName) && lowerBg.includes(charName)
            );
            return !mentionsInactive;
          });

          if (!bestBg) bestBg = bgs[0];
        }

        if (bestBg) {
          windowObj.changeBackground(bestBg);
          useStore.getState().setBackground(bestBg);
        }
      }

      if (!/\[MUSIC:/i.test(initialText)) {
        const tracks = windowObj.imageManifest?.music ? Object.keys(windowObj.imageManifest.music) : [];
        const normInit = normalizeText(initialText);
        const normScenario = normalizeText(windowObj.botInfo.scenario);

        const matchTrack = (normText) => tracks.find(t => {
          const name = t.split(/[/\\]/).pop().split('.')[0].toLowerCase();
          return name.length > 2 && normText.includes(name);
        });

        const bestTrack = matchTrack(normInit) || matchTrack(normScenario) || tracks.find(t => t.toLowerCase().includes('default'));

        if (bestTrack) {
          windowObj.playMusic(bestTrack);
          useStore.getState().setMusic(bestTrack);
        } else {
          windowObj.playMusic(null);
          useStore.getState().setMusic(null);
        }
      }

      const { missing } = windowObj.processVisualTags(initialText, { store: useStore.getState(), handlers: visualHandlers });
      if (missing?.length) await handleMissingVisuals(missing);

      updateThoughtsDropdown();

      if (windowObj.voice) {
        windowObj.voice.speak(initialText, getSceneContext(initialText));
      }

      windowObj.messages.push({ role: 'assistant', content: initialText.trim(), renderReport: null });
      setTurnCount(0);

      renderChat();
      await saveCurrentChatState();
    } catch (e) {
      console.error('Error initializing chat:', e);
      if (windowObj.showErrorModal) windowObj.showErrorModal(e, 'An error occurred while resetting the chat.');
      else {
        const f = windowObj.formatApiError || ((err, d) => err?.message || d);
        alert(f(e, 'An error occurred while resetting the chat.'));
      }
    } finally {
      overlay?.classList.remove('active');
      userInput.disabled = false;
      windowObj.refocusInput();
    }
  }

  return { initializeChat };
}
