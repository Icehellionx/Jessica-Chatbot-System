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
import { useStore } from './src/store.js';
import { $, parseMarkdown, normalizeText } from './src/utils.js';
import { getMood, getSceneContext, buildPayload } from './src/prompt-engine.js';

const userInput = $('user-input');
const sendBtn = $('send-btn');
const chatHistory = $('chat-history');

/* --------------------------- ERROR HANDLING ------------------------------ */

window.onerror = function(message, source, lineno, colno, error) {
  console.error('[Global Error]', error);
  alert(`An error occurred:\n${message}`);
};
window.onunhandledrejection = function(event) {
  console.error('[Unhandled Rejection]', event.reason);
};

/* --------------------------- GLOBAL STATE -------------------------------- */

window.messages = [];
window.botInfo = { personality: '', scenario: '', initial: '', characters: {} };
window.userPersona = { name: 'Jim', details: '' };
window.chatSummary = { content: '' };
window.imageManifest = {}; // { backgrounds, sprites, splash, music }

let turnCount = 0;

/* --------------------------- FOCUS MANAGEMENT ---------------------------- */

window.refocusInput = () => {
  const input = $('user-input');
  if (!input) return;

  // Blur/focus helps Electron when focus gets “stuck” after modals
  input.blur();
  setTimeout(() => {
    input.disabled = false;
    window.focus();
    input.focus();
  }, 50);
};


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

  // Branching / Swiping UI
  if (window.messages[index] && window.messages[index].swipes && window.messages[index].swipes.length > 1) {
    const msg = window.messages[index];
    const navDiv = document.createElement('div');
    navDiv.className = 'msg-nav';

    const currentIdx = msg.swipeId || 0;
    const total = msg.swipes.length;

    const prevBtn = document.createElement('button');
    prevBtn.className = 'msg-nav-btn';
    prevBtn.textContent = '<';
    prevBtn.disabled = currentIdx === 0;
    prevBtn.onclick = () => swapMessageVersion(index, currentIdx - 1);

    const nextBtn = document.createElement('button');
    nextBtn.className = 'msg-nav-btn';
    nextBtn.textContent = '>';
    nextBtn.disabled = currentIdx === total - 1;
    nextBtn.onclick = () => swapMessageVersion(index, currentIdx + 1);

    const label = document.createElement('span');
    label.textContent = `${currentIdx + 1} / ${total}`;

    const delBranchBtn = document.createElement('button');
    delBranchBtn.className = 'msg-nav-btn';
    delBranchBtn.innerHTML = '🗑️';
    delBranchBtn.title = 'Delete this branch';
    delBranchBtn.style.marginLeft = 'auto'; // Push to right
    delBranchBtn.onclick = () => deleteSwipe(index);

    navDiv.appendChild(prevBtn);
    navDiv.appendChild(label);
    navDiv.appendChild(nextBtn);
    navDiv.appendChild(delBranchBtn);
    msgDiv.appendChild(navDiv);
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


/* ------------------------------ ASSET GENERATION ------------------------- */

async function handleMissingVisuals(missing) {
  if (!missing || !missing.length) return;
  
  for (const m of missing) {
    if (m.type === 'bg') {
      const notice = appendMessage('system', `🎨 Generating background: "${m.value}"...`, undefined);
      try {
        const newPath = await window.api.generateImage(m.value, 'bg');
        if (newPath) {
           changeBackground(newPath);
           if (notice) notice.style.display = 'none'; // Hide notice on success
        } else {
           if (notice) notice.textContent = `⚠️ Failed to generate background: "${m.value}" (Is SD running?)`;
        }
      } catch (e) {
        console.error(e);
      }
    }
  }
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

/* ------------------------------ STATE-DRIVEN UI (NEW) -------------------- */

function updateThoughtsDropdown() {
  const thoughtsCharSelect = document.getElementById('thoughts-char-select');
  if (!thoughtsCharSelect) return;

  const currentSelection = thoughtsCharSelect.value;
  thoughtsCharSelect.innerHTML = '';
  
  // Get visible characters directly from the visuals manager, which is the source of truth
  const visibleCharacters = window.getActiveSpriteNames ? window.getActiveSpriteNames() : [];

  if (visibleCharacters.length === 0) {
    const opt = new Option('No one is here', '');
    opt.disabled = true;
    thoughtsCharSelect.add(opt);
  } else {
    visibleCharacters.forEach(charName => {
      const opt = new Option(charName.charAt(0).toUpperCase() + charName.slice(1), charName);
      thoughtsCharSelect.add(opt);
    });
    // Restore previous selection if still visible
    if (visibleCharacters.includes(currentSelection)) {
      thoughtsCharSelect.value = currentSelection;
    }
  }
}

function setupStateSubscribers() {
  // Vanilla Zustand subscribe passes (state, prevState)
  useStore.subscribe((state, prevState) => {
    
    // 1. Background
    if (state.currentBackground !== prevState.currentBackground) {
      console.log('Background state changed to:', state.currentBackground);
      if (state.currentBackground) window.changeBackground(state.currentBackground);
    }

    // 2. Characters (Deep compare check is expensive, so we rely on reference equality from immutable updates)
    if (state.characters !== prevState.characters) {
      console.log('Character state changed:', state.characters);
      for (const charName in state.characters) {
        const charState = state.characters[charName];
        // Only update if this specific character changed (optimization)
        if (charState !== prevState.characters[charName]) {
            if (charState.isVisible) {
              const spriteFile = window.findBestSprite(charName, charState.emotion);
              if (spriteFile) window.updateSprite(spriteFile);
            } else {
              window.hideSprite(charName);
            }
        }
      }
      updateThoughtsDropdown();
    }

    // 3. Music
    if (state.currentMusic !== prevState.currentMusic) {
      console.log('Music state changed to:', state.currentMusic);
      window.playMusic(state.currentMusic);
    }

    // 4. Splash
    if (state.currentSplash !== prevState.currentSplash) {
      if (state.currentSplash) window.showSplash(state.currentSplash);
      else window.hideSplash();
    }

    // 5. Dialogue History
    if (state.dialogueHistory !== prevState.dialogueHistory) {
      renderChat();
    }

    // 6. Inventory
    if (state.inventory !== prevState.inventory) {
        const inventoryListEl = document.getElementById('inventory-list');
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

/* ------------------------------ VISUAL HANDLERS -------------------------- */
// These handlers update the Store, which then triggers the UI subscribers.
// This ensures the Store is the single source of truth.
const visualHandlers = {
  onBg: (bg) => useStore.getState().setBackground(bg),
  onMusic: (music) => useStore.getState().setMusic(music),
  onSplash: (splash) => useStore.getState().setSplash(splash),
  onSprite: (filename) => {
    const charName = window.getCharacterName(filename);
    if (charName) {
      const mood = filename.split(/[/\\]/).pop().split('.')[0].replace(new RegExp(`^${charName}[_-]`, 'i'), '');
      useStore.getState().setCharacterVisibility(charName, true);
      useStore.getState().setCharacterEmotion(charName, mood || 'default');
    }
  }
};

/* ------------------------------ CHAT STATE IO ---------------------------- */

async function saveCurrentChatState() {
  console.log('Saving current state...');
  console.log('[DEBUG] Active Sprites Map:', window.__activeSprites);
  
  // 1. Messages (Source of Truth: window.messages)
  const messages = window.messages || [];

  // 2. Background (Source of Truth: DOM)
  // CHANGED: Read from Store
  const { currentBackground, characters, currentMusic, currentSplash } = useStore.getState();
  const background = currentBackground || '';
  const splash = currentSplash || '';

  // 3. Sprites (Source of Truth: visuals.js activeSprites map)
  // CHANGED: Reconstruct from Store
  const spriteFilenames = [];
  for (const [name, charState] of Object.entries(characters)) {
    if (charState.isVisible) {
      const file = window.findBestSprite(name, charState.emotion);
      if (file) spriteFilenames.push(file);
    }
  }

  // 4. Music (Source of Truth: audio.js)
  // CHANGED: Read from Store
  const music = currentMusic || '';

  const state = {
    messages,
    background,
    sprites: spriteFilenames,
    splash,
    music,
  };

  console.log('[DEBUG] Saving Snapshot:', state);
  await window.api.saveCurrentChat(state);
}

async function restoreChatState(state) {
  console.log('[DEBUG] Restoring Snapshot:', state);
  // NEW: Instead of manually manipulating the DOM, we just set the state in the store.
  // The subscribers we defined above will handle updating the UI automatically.
  
  const { setBackground, setCharacterEmotion, setCharacterVisibility, setMusic, setSplash } = useStore.getState();

  // Restore messages (this part still needs some manual sync with the store)
  window.messages = Array.isArray(state?.messages) ? state.messages : [];
  useStore.setState({ dialogueHistory: window.messages }); // Sync store

  let bgToLoad = null;
  if (state?.background) {
    bgToLoad = validateImage(state.background, 'backgrounds');
    console.log(`[DEBUG] Background '${state.background}' validated as:`, bgToLoad);
  }
  
  // Fallback if no background saved OR validation failed
  if (!bgToLoad) {
    console.log('[DEBUG] No valid background found in save, attempting fallback...');
    const bgs = window.imageManifest?.backgrounds ? Object.keys(window.imageManifest.backgrounds) : [];
    if (bgs.length > 0) bgToLoad = bgs[0];
  }
  
  console.log('[DEBUG] Final Background to Load:', bgToLoad);
  if (bgToLoad) setBackground(bgToLoad);

  // Set character state from saved sprites
  const allChars = Object.keys(window.botInfo.characters || {});
  allChars.forEach(char => setCharacterVisibility(char, false)); // Hide all first
  
  if (Array.isArray(state?.sprites)) {
    console.log('[DEBUG] Restoring Sprites List:', state.sprites);
    for (const filename of state.sprites) {
        const charName = getCharacterName(filename);
        // Robust mood extraction: remove character name prefix (case-insensitive) from filename
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

  // Force render to ensure UI is in sync
  renderChat();
  updateThoughtsDropdown();

  // Prime voice engine with the last assistant message so the button works immediately
  if (window.voice && window.messages.length > 0) {
    const lastMsg = window.messages[window.messages.length - 1];
    if (lastMsg && lastMsg.role === 'assistant') {
      window.voice.speak(lastMsg.content, getSceneContext(lastMsg.content));
    }
  }

  console.log('Chat state restored by setting store state.');
}


/* ------------------------------ RENDER CHAT ------------------------------ */

function renderChat() {
  chatHistory.innerHTML = '';

  window.messages.forEach((msg, index) => {
    const msgDiv = appendMessage(msg.role, msg.content, index);

    // Add reroll button ONLY on the last assistant message
    if (index === window.messages.length - 1 && msg.role === 'assistant') {
      const actionsDiv = document.createElement('div');
      actionsDiv.style.cssText = 'float:right; display:flex; align-items:center;';

      const redoBtn = document.createElement('button');
      redoBtn.className = 'msg-action-btn';
      redoBtn.innerHTML = '↻';
      redoBtn.title = 'Redo (Replace current)';
      redoBtn.onclick = () => regenerateResponse({ replace: true });

      const branchBtn = document.createElement('button');
      branchBtn.className = 'msg-action-btn';
      branchBtn.innerHTML = '⑂'; // Branch icon
      branchBtn.title = 'Branch (Create new)';
      branchBtn.onclick = () => regenerateResponse({ replace: false });

      actionsDiv.appendChild(redoBtn);
      actionsDiv.appendChild(branchBtn);
      msgDiv.appendChild(actionsDiv);
    }
  });

  // Update the visual dialogue box with the latest message
  const lastMsg = window.messages[window.messages.length - 1];
  if (window.setDialogue) {
    if (lastMsg) {
      window.setDialogue(parseMarkdown(stripVisualTags(lastMsg.content)), false);
    } else {
      window.setDialogue("", false);
    }
  }

  chatHistory.scrollTop = chatHistory.scrollHeight;
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
    if (window.__activeSprites) {
        window.__activeSprites.forEach(img => img.remove());
        window.__activeSprites.clear();
    }
    hideSplash();
    if (window.setDialogue) window.setDialogue(""); // Clear dialogue box

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
      
      if (bestBg) {
        changeBackground(bestBg);
        useStore.getState().setBackground(bestBg); // Sync store
      } else if (bgs.length > 0) {
        // Fallback: If no keyword match, just show the first background so it's not black
        const defaultBg = bgs[0];
        changeBackground(defaultBg);
        useStore.getState().setBackground(defaultBg);
      }
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

      if (bestTrack) {
        playMusic(bestTrack);
        useStore.getState().setMusic(bestTrack); // Sync store
      } else {
        playMusic(null);
        useStore.getState().setMusic(null);
      }
    }

    const { missing } = processVisualTags(initialText, { store: useStore.getState(), handlers: visualHandlers });
    if (missing?.length) await handleMissingVisuals(missing);

    updateThoughtsDropdown();

    if (window.voice) {
      window.voice.speak(initialText, getSceneContext(initialText));
    }

    window.messages.push({ role: 'assistant', content: initialText.trim(), renderReport: null });
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

async function streamChat(payload, options) {
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
      
      const parsed = parseMarkdown(stripVisualTags(accumulated));
      contentDiv.innerHTML = parsed;
      if (window.setDialogue) window.setDialogue(parsed, true);

      chatHistory.scrollTop = chatHistory.scrollHeight;
    });

    const fullResponse = await window.api.sendChat(payload, options);

    // stop receiving chunks before we do final processing
    if (removeListener) {
      removeListener();
      removeListener = null;
    }

    // Execute visual tags first
    const { stats, missing, report } = processVisualTags(fullResponse, { store: useStore.getState(), handlers: visualHandlers });
    if (missing?.length) handleMissingVisuals(missing); // Async, don't await to keep UI responsive


    // If no sprites were explicitly updated (either no tags or invalid tags),
    // apply local mood heuristic to keep characters alive.
    if (!stats.spriteUpdated) {
      const activeSprites = window.__activeSprites || new Map();
      const mood = getMood(fullResponse);
      for (const charName of activeSprites.keys()) {
        const sprite = findBestSprite(charName, mood);
        if (sprite) updateSprite(sprite);
      }
    }

    updateThoughtsDropdown();

    // final render (tags stripped)
    contentDiv.innerHTML = parseMarkdown(stripVisualTags(fullResponse));
    if (window.setDialogue) window.setDialogue(contentDiv.innerHTML, false);

    if (window.voice) {
      window.voice.speak(fullResponse, options.activeCharacters);
    }

    return { content: fullResponse.trim(), report };
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

  // Stop any ongoing speech when user interrupts
  if (window.voice) window.voice.stop();

  // UI: show user message immediately
  appendMessage('user', text, window.messages.length);
  userInput.value = '';

  // State: store it
  window.messages.push({ role: 'user', content: text });

  // Determine active characters for this turn
  const sceneCharacters = getSceneContext(text);
  const { inventory, sceneObjects } = useStore.getState();

  const payload = buildPayload(sceneCharacters);

  try {
    const { content, report } = await streamChat(payload, {
      activeCharacters: sceneCharacters,
      inventory: inventory,
      sceneObjects: sceneObjects,
    });

    window.messages.push({ role: 'assistant', content, renderReport: report });
    await saveCurrentChatState();
    
    // Re-render to ensure the new message gets its buttons (Delete, Branch, etc.)
    renderChat();

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

async function swapMessageVersion(msgIndex, swipeIndex) {
  const msg = window.messages[msgIndex];
  if (!msg || !msg.swipes || !msg.swipes[swipeIndex]) return;

  // Update state
  msg.swipeId = swipeIndex;
  msg.content = msg.swipes[swipeIndex];

  // Re-render
  renderChat();
  
  // Process visuals for the swapped message (so background/sprites update to match)
  const { missing } = processVisualTags(msg.content, { store: useStore.getState(), handlers: visualHandlers });
  if (missing?.length) handleMissingVisuals(missing);
  
  await saveCurrentChatState();
}

async function deleteSwipe(msgIndex) {
  const msg = window.messages[msgIndex];
  if (!msg || !msg.swipes || msg.swipes.length <= 1) return;

  const yes = await window.showConfirmModal('Delete Branch', 'Are you sure you want to delete this version of the message?');
  if (!yes) return;

  const currentIdx = msg.swipeId || 0;
  
  // Remove current swipe
  msg.swipes.splice(currentIdx, 1);
  
  // Adjust index to be safe
  msg.swipeId = Math.max(0, Math.min(currentIdx, msg.swipes.length - 1));
  msg.content = msg.swipes[msg.swipeId];

  renderChat();
  
  // Update visuals for the new current swipe
  const { missing } = processVisualTags(msg.content, { store: useStore.getState(), handlers: visualHandlers });
  if (missing?.length) handleMissingVisuals(missing);

  await saveCurrentChatState();
}

async function regenerateResponse({ replace } = { replace: false }) {
  if (!window.messages.length) return;

  try {
    // Remove last assistant
    const last = window.messages[window.messages.length - 1];
    let previousSwipes = [];
    let targetSwipeIndex = 0;
    
    if (last?.role === 'assistant') {
      // Preserve history of the message we are replacing
      previousSwipes = last.swipes || [last.content];
      targetSwipeIndex = last.swipeId !== undefined ? last.swipeId : (previousSwipes.length - 1);
      window.messages.pop();
    }

    renderChat();

    // Reroll uses last user msg for scene context
    const lastUser = window.messages[window.messages.length - 1];
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
      // Overwrite current swipe
      newSwipes = [...previousSwipes];
      newSwipes[targetSwipeIndex] = rawResponse;
      newSwipeId = targetSwipeIndex;
    } else {
      // Append new swipe (Branch)
      newSwipes = [...previousSwipes, rawResponse];
      newSwipeId = newSwipes.length - 1;
    }

    window.messages.push({
      role: 'assistant',
      content: rawResponse,
      swipes: newSwipes,
      swipeId: newSwipeId,
      renderReport: report
    });
    
    await saveCurrentChatState();
  } catch (error) {
    console.error('Regenerate Error:', error);
    alert(`Failed to regenerate response: ${error?.message || 'Unknown error'}`);
  } finally {
    window.refocusInput();
  }
}

/* ------------------------------ EVENTS ----------------------------------- */

sendBtn.addEventListener('click', handleSend);

userInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    handleSend();
  }
});

/* ------------------------------ INIT ------------------------------------- */

async function init() {
  setupVisuals();
  setupStateSubscribers(); // <-- Add this line
  setupUI({ initializeChat, renderChat, saveCurrentChatState, regenerateResponse, swapMessageVersion });
  if (window.setupSettingsUI) window.setupSettingsUI({ initializeChat });

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
  if (window.setSpriteOverrides && window.botInfo.spriteSizes) {
    window.setSpriteOverrides(window.botInfo.spriteSizes);
  }
  window.userPersona = await window.api.getPersona();
  window.chatSummary = await window.api.getSummary();
  window.imageManifest = await window.api.getImageManifest();

  // Title screen gate
  await showTitleScreenIfExists();

  if (!hasKeys) {
    if (window.openUnifiedSettings) window.openUnifiedSettings('system');
    return;
  }

  // Restore previous session if present
  const saved = await window.api.loadCurrentChat();
  console.log('[DEBUG] Loaded Data from Disk:', saved);

  if (saved?.messages?.length) {
    await restoreChatState(saved);
  } else {
    console.log('[DEBUG] No valid save found, initializing fresh chat.');
    await initializeChat();
  }
}

init();
