'use strict';

export function createStateSubscribers(deps) {
  const {
    windowObj,
    documentObj,
    useStore,
    updateThoughtsDropdown,
    renderChat,
  } = deps;

  function setupStateSubscribers() {
    useStore.subscribe((state, prevState) => {
      if (state.currentBackground !== prevState.currentBackground) {
        console.log('Background state changed to:', state.currentBackground);
        if (state.currentBackground) windowObj.changeBackground(state.currentBackground);
      }

      if (state.characters !== prevState.characters) {
        console.log('Character state changed:', state.characters);
        for (const charName in state.characters) {
          const charState = state.characters[charName];
          if (charState !== prevState.characters[charName]) {
            if (charState.isVisible) {
              const spriteFile = windowObj.findBestSprite(charName, charState.emotion);
              if (spriteFile) windowObj.updateSprite(spriteFile);
            } else {
              windowObj.hideSprite(charName);
            }
          }
        }
        updateThoughtsDropdown();
      }

      if (state.currentMusic !== prevState.currentMusic) {
        console.log('Music state changed to:', state.currentMusic);
        windowObj.playMusic(state.currentMusic);
      }

      if (state.currentSplash !== prevState.currentSplash) {
        if (state.currentSplash) windowObj.showSplash(state.currentSplash);
        else windowObj.hideSplash();
      }

      if (state.dialogueHistory !== prevState.dialogueHistory) {
        renderChat();
      }

      if (state.inventory !== prevState.inventory) {
        const inventoryListEl = documentObj.getElementById('inventory-list');
        if (inventoryListEl) {
          if (state.inventory.length === 0) {
            inventoryListEl.textContent = 'Empty';
          } else {
            inventoryListEl.textContent = state.inventory.join(', ');
          }
        }
      }
    });
  }

  return { setupStateSubscribers };
}
