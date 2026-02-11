'use strict';

/* ============================================================================
   RENDERER (UI + Chat Orchestration)
   Responsibilities:
   - Boot flow (title screen, load config, restore state)
   - Chat UI (render, append, delete, reroll)
   - Build payload (system prompt + injected data)
   - Stream assistant replies and apply VN tags
   - Persist current scene state (bg/sprites/splash/music)
   ========================================================================== */

/* ------------------------------ DOM HELPERS ------------------------------ */

const $ = (id) => document.getElementById(id);

const userInput = $('user-input');
const sendBtn = $('send-btn');
const chatHistory = $('chat-history');

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text ?? '';
  return div.innerHTML;
}

function normalizeText(text) {
  // Accent-insensitive matching for filenames
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/* --------------------------- GLOBAL STATE -------------------------------- */

window.messages = [];
window.botInfo = { personality: '', scenario: '', initial: '', characters: {} };
window.userPersona = { name: 'Jim', details: '' };
window.chatSummary = { content: '' };
window.imageManifest = {}; // { backgrounds, sprites, splash, music }
const activeSprites = window.__activeSprites;

let turnCount = 0;

/* --------------------------- FOCUS MANAGEMENT ---------------------------- */

window.refocusInput = () => {
  const input = $('user-input');
  if (!input) return;

  // Blur/focus helps Electron when focus gets "stuck" after modals.
  // Use two attempts — the first catches fast transitions, the second
  // catches slower Electron focus-chain recovery (e.g. after confirm modals).
  input.blur();
  input.disabled = false;
  setTimeout(() => {
    input.focus();
    // Backup: if the first focus didn't stick (document.activeElement !== input),
    // try once more after Electron's focus chain has fully settled.
    setTimeout(() => {
      if (document.activeElement !== input) input.focus();
    }, 100);
  }, 50);
};

/* ------------------------------ MARKDOWN --------------------------------- */
/**
 * Minimal markdown:
 * - escapes HTML
 * - supports ***bold+italic***, **bold**, *italic* or _italic_
 * - converts newlines to <br>
 *
 * Note: intentionally simple; no links, no images, no raw HTML.
 */
function parseMarkdown(text) {
  if (!text) return '';
  let html = escapeHtml(text);

  // Strong+em: ***text***
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  // Strong: **text**
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Em: *text* or _text_ (avoid matching inside words with simple boundaries)
  html = html.replace(/(^|[\s(])(\*|_)(.+?)\2(?=[\s).,!?:;]|$)/g, '$1<em>$3</em>');

  return html.replace(/\n/g, '<br>');
}

/* ------------------------------ UI MESSAGES ------------------------------ */

function createMessageElement(role, rawText, index) {
  const msgDiv = document.createElement('div');
  msgDiv.className = `message ${role}`;

  const contentDiv = document.createElement('div');
  contentDiv.className = 'message-content';
  contentDiv.innerHTML = parseMarkdown(stripVisualTags(rawText));
  msgDiv.appendChild(contentDiv);

  // Delete button (only when index is provided)
  if (typeof index === 'number') {
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'msg-delete-btn';
    deleteBtn.innerHTML = '×';
    deleteBtn.title = 'Delete this message and all following';

    deleteBtn.onclick = async () => {
      const yes = await window.showConfirmModal(
        'Delete Message',
        'Delete this message and all subsequent messages?'
      );
      if (!yes) return;

      window.messages.splice(index);
      renderChat();
      await saveCurrentChatState();
      window.refocusInput();
    };

    msgDiv.appendChild(deleteBtn);
  }

  return { msgDiv, contentDiv };
}

function appendMessage(role, rawText, index) {
  const { msgDiv } = createMessageElement(role, rawText, index);
  chatHistory.appendChild(msgDiv);
  chatHistory.scrollTop = chatHistory.scrollHeight;
  return msgDiv;
}

function appendSystemNotice(text) {
  appendMessage('system', text, undefined);
}

/* ------------------------------ MOOD HEURISTIC --------------------------- */

const moodKeywords = {
  Happy: ['happy', 'smile', 'laugh', 'joy', 'excited', 'glad', 'grin', 'chuckle', 'giggle', 'warmly'],
  Sad: ['sad', 'cry', 'tear', 'sorrow', 'depressed', 'grief', 'sob', 'upset', 'distant', 'gloomy'],
  Angry: ['angry', 'mad', 'rage', 'fury', 'hate', 'resent', 'annoyed', 'glare', 'tense', 'frown'],
  Scared: ['scared', 'fear', 'afraid', 'terrified', 'horror', 'panic', 'shiver', 'shock', 'gasp'],
  Flirty: ['flirty', 'coy', 'blush', 'love', 'cute', 'hot', 'kiss', 'wink', 'seductive'],
  Anxious: ['anxious', 'nervous', 'worry', 'guarded', 'hesitant', 'shy', 'uneasy'],
  Surprised: ['surprised', 'shocked', 'stunned', 'disbelief', 'wide-eyed'],
};

function getMood(text) {
  const lower = String(text ?? '').toLowerCase();
  let best = 'Default';
  let bestHits = 0;

  for (const [mood, words] of Object.entries(moodKeywords)) {
    let hits = 0;
    for (const w of words) if (lower.includes(w)) hits++;
    if (hits > bestHits) {
      bestHits = hits;
      best = mood;
    }
  }

  return best;
}

/* ------------------------------ TITLE SCREEN ----------------------------- */

function showTitleScreenIfExists() {
  return new Promise((resolve) => {
    const img = new Image();
    img.src = 'bot-resource://title/title_screen.png';

    img.onload = () => {
      const overlay = document.createElement('div');
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

      const text = document.createElement('div');
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

      const style = document.createElement('style');
      style.textContent = `@keyframes titlePulse {0%{opacity:.6}50%{opacity:1}100%{opacity:.6}}`;
      document.head.appendChild(style);

      overlay.appendChild(text);
      document.body.appendChild(overlay);

      playMusic('music/main_theme.mp3');

      overlay.addEventListener('click', () => {
        overlay.style.opacity = '0';
        overlay.style.pointerEvents = 'none';
        setTimeout(() => overlay.remove(), 500);
        resolve();
      });
    };

    img.onerror = () => resolve(); // no title asset; continue
  });
}

/* ------------------------------ CHAT STATE IO ---------------------------- */

async function saveCurrentChatState() {
  const bgSrc = $('vn-bg')?.src ?? '';
  let bgFilename = bgSrc.includes('bot-resource://') ? bgSrc.split('bot-resource://')[1] : '';
  bgFilename = decodeURIComponent(bgFilename);

  const spriteFilenames = [];
  activeSprites.forEach((img) => {
    if (img.src.includes('bot-resource://')) {
      spriteFilenames.push(decodeURIComponent(img.src.split('bot-resource://')[1]));
    }
  });

  const splashContainer = $('splash-container');
  let splashFilename = '';
  if (splashContainer?.classList.contains('active')) {
    const img = splashContainer.querySelector('img');
    if (img?.src?.includes('bot-resource://')) {
      splashFilename = decodeURIComponent(img.src.split('bot-resource://')[1]);
    }
  }

  const musicFilename = getCurrentMusicFilename();

  const state = {
    messages: window.messages,
    background: bgFilename,
    sprites: spriteFilenames,
    splash: splashFilename,
    music: musicFilename,
  };

  await window.api.saveCurrentChat(state);
}

async function restoreChatState(state) {
  window.messages = Array.isArray(state?.messages) ? state.messages : [];

  // Prefer your visuals helpers so any extra logic runs
  if (state?.background) {
    const validBg = validateImage(state.background, 'backgrounds');
    if (validBg) changeBackground(validBg);
  }

  activeSprites.forEach((img) => img.remove());
  activeSprites.clear();

  if (Array.isArray(state?.sprites)) {
    for (const filename of state.sprites) updateSprite(filename);
  }

  if (state?.splash) showSplash(state.splash);
  else hideSplash();

  if (state?.music) playMusic(state.music);
  else playMusic(null);

  renderChat();
  console.log('Chat state restored.');
}

/* ------------------------------ RENDER CHAT ------------------------------ */

function renderChat() {
  chatHistory.innerHTML = '';

  window.messages.forEach((msg, index) => {
    const msgDiv = appendMessage(msg.role, msg.content, index);

    // Add reroll button ONLY on the last assistant message
    if (index === window.messages.length - 1 && msg.role === 'assistant') {
      const rerollBtn = document.createElement('button');
      rerollBtn.className = 'msg-reroll-btn';
      rerollBtn.innerHTML = '↻';
      rerollBtn.title = 'Reroll this message';
      rerollBtn.onclick = () => regenerateResponse();
      msgDiv.appendChild(rerollBtn);
    }
  });

  chatHistory.scrollTop = chatHistory.scrollHeight;
}

/* ------------------------------ SCENE CONTEXT ---------------------------- */

function getSceneContext(userText) {
  // 1) currently visible
  const activeNames = new Set(activeSprites.keys());

  // 2) add characters mentioned in user text
  if (userText && window.botInfo?.characters) {
    const lower = String(userText).toLowerCase();
    for (const name of Object.keys(window.botInfo.characters)) {
      if (lower.includes(name.toLowerCase())) activeNames.add(name.toLowerCase());
    }
  }

  return Array.from(activeNames);
}

/* ------------------------------ PAYLOAD BUILD ---------------------------- */

/**
 * Extract a short summary block from a character text (best-effort).
 * Keeps token usage down when listing “inactive” characters.
 */
function extractCharacterSummary(charText) {
  if (!charText) return '';
  const match = String(charText).match(/###\s*SUMMARY:([\s\S]*?)(?=###|$)/i);
  const raw = match ? match[1].trim() : String(charText).slice(0, 150).replace(/\n/g, ' ') + '...';
  return raw.length > 200 ? raw.slice(0, 200) + '...' : raw;
}

function buildSystemPrompt(sceneCharacters) {
  const base = [window.botInfo.personality, window.botInfo.scenario].filter(Boolean).join('\n\n');
  let systemContent = base;

  // Inject active character personalities
  for (const nameLower of sceneCharacters) {
    const realName = Object.keys(window.botInfo.characters).find(k => k.toLowerCase() === nameLower);
    if (!realName) continue;

    systemContent += `\n\n[Character: ${realName}]\n${window.botInfo.characters[realName]}`;

    // If mentioned but not visible, hint the model
    if (!activeSprites.has(nameLower)) {
      systemContent += `\n(System Note: ${realName} is not currently visible. If they are entering the scene, you MUST output [SPRITE: ${realName}] at the start.)`;
    }
  }

  // Inactive characters list (summaries only)
  const allNames = Object.keys(window.botInfo.characters);
  const inactive = allNames.filter(n => !sceneCharacters.includes(n.toLowerCase()));

  if (inactive.length) {
    systemContent += `\n\n[Other Available Characters]\n(Output [SPRITE: Name] to bring them into the scene)`;
    for (const name of inactive) {
      systemContent += `\n- ${name}: ${extractCharacterSummary(window.botInfo.characters[name])}`;
    }
  }

  // Persona
  systemContent += `\n\n[USER INFO]\nName: ${window.userPersona.name}\nDetails: ${window.userPersona.details}`;

  // Replace placeholder
  systemContent = systemContent.replace(/{{user}}/g, window.userPersona.name);

  // Summary
  if (window.chatSummary?.content) {
    systemContent += `\n\n[STORY SUMMARY]\n${window.chatSummary.content}`;
  }

  return systemContent.trim();
}

function buildPayload(sceneCharacters) {
  const systemContent = buildSystemPrompt(sceneCharacters);
  return systemContent
    ? [{ role: 'system', content: systemContent }, ...window.messages]
    : window.messages;
}

/* ------------------------------ INITIAL CHAT ----------------------------- */

async function initializeChat() {
  const overlay = $('loading-overlay');
  overlay?.classList.add('active');

  userInput.value = '';
  userInput.disabled = false;
  userInput.focus();

  try {
    window.messages = [];
    renderChat();

    // Reset visuals
    activeSprites.forEach(img => img.remove());
    activeSprites.clear();
    hideSplash();

    let initialText =
      window.botInfo.initial ||
      "⚠️ Error: Could not load 'bot/files/initial.txt'. Please check that the file exists.";

    initialText = initialText.replace(/{{user}}/g, window.userPersona.name);

    // If no VN tags, do local heuristics
    if (!/\[(BG|SPRITE|SPLASH|MUSIC|HIDE):/i.test(initialText)) {
      const mood = getMood(initialText);
      const activeChars = getSceneContext(initialText);

      for (const charName of activeChars) {
        const sprite = findBestSprite(charName, mood);
        if (sprite) updateSprite(sprite);
      }

      // Background heuristic: match by filename token
      const norm = normalizeText(initialText);
      const bgs = window.imageManifest?.backgrounds ? Object.keys(window.imageManifest.backgrounds) : [];
      const bestBg = bgs.find(bg => {
        const name = bg.split(/[/\\]/).pop().split('.')[0].toLowerCase();
        return name.length > 2 && norm.includes(name);
      });
      if (bestBg) changeBackground(bestBg);
    }

    // Music heuristic if no explicit tag
    if (!/\[MUSIC:/i.test(initialText)) {
      const tracks = window.imageManifest?.music ? Object.keys(window.imageManifest.music) : [];
      const normInit = normalizeText(initialText);
      const normScenario = normalizeText(window.botInfo.scenario);

      const matchTrack = (normText) => tracks.find(t => {
        const name = t.split(/[/\\]/).pop().split('.')[0].toLowerCase();
        return name.length > 2 && normText.includes(name);
      });

      let bestTrack = matchTrack(normInit) || matchTrack(normScenario) || tracks.find(t => t.toLowerCase().includes('default'));

      if (bestTrack) playMusic(bestTrack);
      else playMusic(null);
    }

    processVisualTags(initialText);

    window.messages.push({ role: 'assistant', content: initialText.trim() });
    turnCount = 0;

    renderChat();
    await saveCurrentChatState();
  } catch (e) {
    console.error('Error initializing chat:', e);
    alert('An error occurred while resetting the chat.');
  } finally {
    overlay?.classList.remove('active');
    userInput.disabled = false;
    window.refocusInput();
  }
}

/* ------------------------------ SUMMARY UPDATES --------------------------- */

async function updateHistorySummary(isFullRewrite) {
  const recentMessages = window.messages
    .slice(-20)
    .map(m => `${m.role === 'user' ? 'User' : 'AI'}: ${m.content}`)
    .join('\n');

  const promptMessages = isFullRewrite
    ? [
        { role: 'system', content: 'You are an expert storyteller. Summarize the entire story so far into a concise narrative, incorporating the previous summary and recent events.' },
        { role: 'user', content: `Previous Summary:\n${window.chatSummary.content}\n\nRecent Events:\n${recentMessages}` },
      ]
    : [
        { role: 'system', content: 'Summarize the following conversation events in 2-3 sentences to append to a history log.' },
        { role: 'user', content: recentMessages },
      ];

  try {
    appendSystemNotice('Updating history...');
    const summaryUpdate = await window.api.sendChat(promptMessages);

    if (isFullRewrite) window.chatSummary.content = summaryUpdate;
    else window.chatSummary.content += (window.chatSummary.content ? '\n\n' : '') + summaryUpdate;

    await window.api.saveSummary(window.chatSummary);
  } catch (e) {
    console.error('Failed to update summary:', e);
  }
}

/* ------------------------------ STREAMING -------------------------------- */

function createAssistantStreamBubble() {
  // This message is not yet in window.messages; index is undefined on purpose.
  const { msgDiv, contentDiv } = createMessageElement('assistant', '', undefined);

  // Typing indicator
  contentDiv.innerHTML = '<div class="typing-dots"><span></span><span></span><span></span></div>';

  chatHistory.appendChild(msgDiv);
  chatHistory.scrollTop = chatHistory.scrollHeight;

  return { msgDiv, contentDiv };
}

async function streamChat(payload, sceneCharacters) {
  const { msgDiv, contentDiv } = createAssistantStreamBubble();

  let accumulated = '';
  let received = false;
  let removeListener = null;

  try {
    removeListener = window.api.onChatReplyChunk((chunk) => {
      if (!received) {
        contentDiv.innerHTML = '';
        received = true;
      }
      accumulated += chunk;
      contentDiv.innerHTML = parseMarkdown(stripVisualTags(accumulated));
      chatHistory.scrollTop = chatHistory.scrollHeight;
    });

    const fullResponse = await window.api.sendChat(payload, { activeCharacters: sceneCharacters });

    // stop receiving chunks before we do final processing
    if (removeListener) {
      removeListener();
      removeListener = null;
    }

    // Execute visual tags first
    const { stats } = processVisualTags(fullResponse);

    // If no sprites were explicitly updated (either no tags or invalid tags),
    // apply local mood heuristic to keep characters alive.
    if (!stats.spriteUpdated) {
      const mood = getMood(fullResponse);
      for (const charName of activeSprites.keys()) {
        const sprite = findBestSprite(charName, mood);
        if (sprite) updateSprite(sprite);
      }
    }

    // final render (tags stripped)
    contentDiv.innerHTML = parseMarkdown(stripVisualTags(fullResponse));

    return fullResponse.trim();
  } finally {
    if (removeListener) removeListener();
    // Ensure chat stays pinned
    chatHistory.scrollTop = chatHistory.scrollHeight;
  }
}

/* ------------------------------ SEND / REROLL ---------------------------- */

async function handleSend() {
  const text = userInput.value.trim();
  if (!text) return;

  // UI: show user message immediately
  appendMessage('user', text, window.messages.length);
  userInput.value = '';

  // State: store it
  window.messages.push({ role: 'user', content: text });

  // Determine active characters for this turn
  const sceneCharacters = getSceneContext(text);

  const payload = buildPayload(sceneCharacters);

  try {
    const rawResponse = await streamChat(payload, sceneCharacters);

    window.messages.push({ role: 'assistant', content: rawResponse });
    await saveCurrentChatState();

    // Character evolution: Run AFTER the turn is secure to avoid race conditions
    if (turnCount > 0 && turnCount % 5 === 0) {
      window.api.evolveCharacterState(window.messages, sceneCharacters).catch(e => console.warn('Evolution skipped:', e));
    }

    // Auto-summary
    turnCount++;
    if (turnCount % 10 === 0) {
      const isFullRewrite = (turnCount % 50 === 0);
      updateHistorySummary(isFullRewrite);
    }
  } catch (error) {
    console.error('Chat Error:', error);

    // Roll back state (remove the user msg)
    window.messages.pop();

    // Remove last UI nodes: assistant bubble + user bubble
    if (chatHistory.lastChild) chatHistory.removeChild(chatHistory.lastChild); // assistant
    if (chatHistory.lastChild) chatHistory.removeChild(chatHistory.lastChild); // user

    // Restore input
    userInput.value = text;
    alert(`Failed to send message: ${error?.message || 'Unknown error'}`);
  }

  window.refocusInput();
}

async function regenerateResponse() {
  if (!window.messages.length) return;

  // Remove last assistant
  const last = window.messages[window.messages.length - 1];
  if (last?.role === 'assistant') window.messages.pop();

  renderChat();

  // Reroll uses last user msg for scene context
  const lastUser = window.messages[window.messages.length - 1];
  const text = lastUser?.role === 'user' ? lastUser.content : '';
  const sceneCharacters = getSceneContext(text);

  const payload = buildPayload(sceneCharacters);

  try {
    const rawResponse = await streamChat(payload, sceneCharacters);
    window.messages.push({ role: 'assistant', content: rawResponse });
    await saveCurrentChatState();
  } catch (error) {
    console.error('Regenerate Error:', error);
    alert(`Failed to regenerate response: ${error?.message || 'Unknown error'}`);
  }

  window.refocusInput();
}

/* ------------------------------ EVENTS ----------------------------------- */

sendBtn.addEventListener('click', handleSend);

userInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    handleSend();
  }
});

/* ------------------------------ RESIZER ---------------------------------- */

const resizer = $('resizer');
const vnPanel = $('vn-panel');

let isResizing = false;
let rafId = null;

resizer.addEventListener('mousedown', (e) => {
  isResizing = true;
  document.body.style.cursor = 'col-resize';
  e.preventDefault();
});

document.addEventListener('mousemove', (e) => {
  if (!isResizing) return;
  if (rafId) return;

  rafId = requestAnimationFrame(() => {
    const containerWidth = document.body.offsetWidth;
    const pct = (e.clientX / containerWidth) * 100;

    if (pct > 10 && pct < 90) {
      vnPanel.style.width = `${pct}%`;
    }

    rafId = null;
  });
});

document.addEventListener('mouseup', () => {
  isResizing = false;
  document.body.style.cursor = 'default';
});

/* ------------------------------ INIT ------------------------------------- */

async function init() {
  setupVisuals();
  setupUI({ initializeChat, renderChat, saveCurrentChatState, regenerateResponse });

  setupVolumeControls();

  // Loading overlay
  const loadingOverlay = document.createElement('div');
  loadingOverlay.id = 'loading-overlay';
  loadingOverlay.innerHTML = '<div>Resetting Story...</div>';
  document.body.appendChild(loadingOverlay);

  preloadImages();

  // Load config + assets/state
  const config = await window.api.getConfig();
  const hasKeys = config?.apiKeys && Object.keys(config.apiKeys).length > 0;

  window.botInfo = await window.api.getBotInfo();
  window.userPersona = await window.api.getPersona();
  window.chatSummary = await window.api.getSummary();
  window.imageManifest = await window.api.getImageManifest();

  // Title screen gate
  await showTitleScreenIfExists();

  if (!hasKeys) {
    $('setup-modal')?.classList.remove('hidden');
    return;
  }

  // Restore previous session if present
  const saved = await window.api.loadCurrentChat();
  if (saved?.messages?.length) {
    await restoreChatState(saved);
  } else {
    await initializeChat();
  }
}

init();
