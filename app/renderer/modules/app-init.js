'use strict';

export function createAppInitializer(deps) {
  const {
    windowObj,
    documentObj,
    setupStateSubscribers,
    initializeChat,
    renderChat,
    saveCurrentChatState,
    regenerateResponse,
    swapMessageVersion,
    restoreChatState,
  } = deps;

  function showTitleScreenIfExists() {
    return new Promise((resolve) => {
      const img = new Image();
      img.src = 'bot-resource://title/title_screen.png';

      img.onload = () => {
        const overlay = documentObj.createElement('div');
        overlay.id = 'title-screen';
        overlay.style.cssText = `
          position: fixed; inset: 0;
          background-image: url('bot-resource://title/title_screen.png');
          background-size: cover;
          background-position: center;
          z-index: 20000;
          cursor: pointer;
          display: flex;
          justify-content: flex-end;
          align-items: flex-end;
          transition: opacity 0.5s ease;
        `;

        const text = documentObj.createElement('div');
        text.textContent = 'Click to Start';
        text.style.cssText = `
          color: white;
          font-family: sans-serif;
          font-size: 24px;
          margin: 40px;
          text-shadow: 2px 2px 4px rgba(0,0,0,0.8);
          font-weight: bold;
          animation: titlePulse 2s infinite;
        `;

        const style = documentObj.createElement('style');
        style.textContent = '@keyframes titlePulse {0%{opacity:.6}50%{opacity:1}100%{opacity:.6}}';
        documentObj.head.appendChild(style);

        overlay.appendChild(text);
        documentObj.body.appendChild(overlay);

        windowObj.playMusic('music/main_theme.mp3');

        overlay.addEventListener('click', () => {
          overlay.style.opacity = '0';
          overlay.style.pointerEvents = 'none';
          setTimeout(() => overlay.remove(), 500);
          resolve();
        });
      };

      img.onerror = () => resolve();
    });
  }

  async function init() {
    windowObj.setupVisuals();
    setupStateSubscribers();
    windowObj.setupUI({ initializeChat, renderChat, saveCurrentChatState, regenerateResponse, swapMessageVersion });
    if (windowObj.setupHUD) windowObj.setupHUD();
    if (windowObj.setBackgroundGenerationStatus) windowObj.setBackgroundGenerationStatus('idle');
    if (windowObj.setupSettingsUI) windowObj.setupSettingsUI({ initializeChat });

    windowObj.setupVolumeControls();

    const loadingOverlay = documentObj.createElement('div');
    loadingOverlay.id = 'loading-overlay';
    loadingOverlay.innerHTML = '<div>Resetting Story...</div>';
    documentObj.body.appendChild(loadingOverlay);

    windowObj.preloadImages();

    const config = await windowObj.api.getConfig();
    const hasKeys = config?.apiKeys && Object.keys(config.apiKeys).length > 0;

    windowObj.botInfo = await windowObj.api.getBotInfo();
    if (windowObj.setSpriteOverrides && windowObj.botInfo.spriteSizes) {
      windowObj.setSpriteOverrides(windowObj.botInfo.spriteSizes);
    }
    windowObj.userPersona = await windowObj.api.getPersona();
    windowObj.chatSummary = await windowObj.api.getSummary();
    windowObj.imageManifest = await windowObj.api.getImageManifest();

    await showTitleScreenIfExists();

    if (!hasKeys) {
      if (windowObj.openUnifiedSettings) windowObj.openUnifiedSettings('system');
      return;
    }

    const saved = await windowObj.api.loadCurrentChat();
    console.log('[DEBUG] Loaded Data from Disk:', saved);

    if (saved?.messages?.length) {
      await restoreChatState(saved);
    } else {
      console.log('[DEBUG] No valid save found, initializing fresh chat.');
      await initializeChat();
    }
  }

  return {
    init,
    showTitleScreenIfExists,
  };
}
