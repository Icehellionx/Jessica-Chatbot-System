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
import { useStore } from './modules/store.js';
import { $, parseMarkdown, normalizeText } from './modules/utils.js';
import { getMood, getSceneContext, buildPayload } from './modules/prompt-engine.js';
import { initializeDirectorDebug, createBgDiagnosticsController } from './modules/bg-diagnostics.js';
import { createChatStreamer } from './modules/chat-stream.js';
import { hasVisualDirectives, getRecentMessagesForDirector, mergeDirectives } from './modules/directive-tools.js';
import { createChatSessionController } from './modules/chat-session.js';
import { createMissingVisualsController } from './modules/missing-visuals.js';
import { createChatController } from './modules/chat-controller.js';
import { createAppInitializer } from './modules/app-init.js';
import { createSidecarController } from './modules/sidecar-controller.js';
import { createChatInitializer } from './modules/chat-init.js';
import { createStateSubscribers } from './modules/state-subscribers.js';

const userInput = $('user-input');
const sendBtn = $('send-btn');
const stopBtn = $('stop-btn');
const chatHistory = $('chat-history');

/* --------------------------- ERROR HANDLING ------------------------------ */

window.onerror = function(message, source, lineno, colno, error) {
  console.error('[Global Error]', error);
  if (window.showErrorModal) window.showErrorModal(error, `An error occurred:\n${message}`);
  else {
    const f = window.formatApiError || ((err, d) => err?.message || d);
    alert(f(error, `An error occurred:\n${message}`));
  }
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
let isGenerating = false;
initializeDirectorDebug(window);
const { toggleBgDiagnosticsPanel } = createBgDiagnosticsController({ useStore, windowObj: window, documentObj: document });

function setGeneratingState(value) {
  isGenerating = Boolean(value);
  if (sendBtn) sendBtn.disabled = isGenerating;
  if (stopBtn) {
    stopBtn.style.display = isGenerating ? 'inline-block' : 'none';
    stopBtn.disabled = !isGenerating;
  }
}

/* --------------------------- FOCUS MANAGEMENT ---------------------------- */

window.refocusInput = () => {
  const input = $('user-input');
  if (!input) return;

  // Blur/focus helps Electron when focus gets â€œstuckâ€ after modals
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
  contentDiv.innerHTML = parseMarkdown(window.stripVisualTags(rawText));
  msgDiv.appendChild(contentDiv);

  // Delete button (only when index is provided)
  if (typeof index === 'number') {
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'msg-delete-btn';
    deleteBtn.innerHTML = 'Ã—';
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
    delBranchBtn.innerHTML = 'ðŸ—‘ï¸';
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

const chatStreamer = createChatStreamer({
  windowObj: window,
  chatHistory,
  createMessageElement,
  parseMarkdown,
  getMood,
  useStore,
  getVisualHandlers: () => visualHandlers,
  handleMissingVisuals: (missing) => handleMissingVisuals(missing),
  updateThoughtsDropdown: () => updateThoughtsDropdown(),
});

function appendMessage(role, rawText, index) {
  const { msgDiv } = createMessageElement(role, rawText, index);
  chatHistory.appendChild(msgDiv);
  chatHistory.scrollTop = chatHistory.scrollHeight;
  return msgDiv;
}

function appendSystemNotice(text) {
  appendMessage('system', text, undefined);
}

const missingVisualsController = createMissingVisualsController({
  windowObj: window,
  useStore,
  normalizeText,
  appendMessage,
  saveCurrentChatState: () => saveCurrentChatState(),
});

async function handleMissingVisuals(missing) {
  return missingVisualsController.handleMissingVisuals(missing);
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

const { setupStateSubscribers } = createStateSubscribers({
  windowObj: window,
  documentObj: document,
  useStore,
  updateThoughtsDropdown: () => updateThoughtsDropdown(),
  renderChat: () => renderChat(),
});

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
  },
  onHide: (name) => {
    const store = useStore.getState();
    const lower = name.toLowerCase();
    if (lower === 'all' || lower === 'everyone') {
      Object.keys(store.characters).forEach(c => store.setCharacterVisibility(c, false));
      window.hideSprite('all');
    } else {
      const keys = Object.keys(store.characters);
      const target = keys.find(k => k.toLowerCase() === lower) || keys.find(k => lower.includes(k.toLowerCase()));
      if (target) store.setCharacterVisibility(target, false);
      window.hideSprite(name);
    }
  }
};

/* ------------------------------ CHAT STATE IO ---------------------------- */

const chatSessionController = createChatSessionController({
  windowObj: window,
  useStore,
  chatHistory,
  appendMessage,
  parseMarkdown,
  getSceneContext,
  getMood,
  normalizeText,
  updateThoughtsDropdown: () => updateThoughtsDropdown(),
  onRegenerate: (options) => regenerateResponse(options),
});

const saveCurrentChatState = (...args) => chatSessionController.saveCurrentChatState(...args);
const restoreChatState = (...args) => chatSessionController.restoreChatState(...args);
const renderChat = (...args) => chatSessionController.renderChat(...args);

/* ------------------------------ INITIAL CHAT ----------------------------- */
const chatInitializer = createChatInitializer({
  windowObj: window,
  useStore,
  userInput,
  normalizeText,
  getMood,
  getSceneContext,
  renderChat,
  updateThoughtsDropdown,
  handleMissingVisuals: (missing) => handleMissingVisuals(missing),
  saveCurrentChatState,
  visualHandlers,
  setTurnCount: (value) => { turnCount = value; },
});

const initializeChat = (...args) => chatInitializer.initializeChat(...args);

/* ------------------------------ SUMMARY UPDATES --------------------------- */

async function updateHistorySummary(isFullRewrite) {
  const recentMessages = window.messages
    .slice(-20)
    .map(m => `${m.role === 'user' ? 'User' : 'AI'}: ${m.content}`)
    .join('\n');

  try {
    appendSystemNotice('Updating history...');
    
    // Use the Sidecar (Local LLM) for summarization to save main model tokens
    const summaryUpdate = await window.api.summarizeChat(recentMessages, isFullRewrite ? '' : window.chatSummary.content);

    if (isFullRewrite) window.chatSummary.content = summaryUpdate;
    else window.chatSummary.content += (window.chatSummary.content ? '\n\n' : '') + summaryUpdate;

    await window.api.saveSummary(window.chatSummary);
  } catch (e) {
    console.error('Failed to update summary:', e);
  }
}

/* ------------------------------ STREAMING -------------------------------- */

const streamChat = (payload, options) => chatStreamer.streamChat(payload, options);
const sidecarController = createSidecarController({
  windowObj: window,
  documentObj: document,
  useStore,
  hasVisualDirectives,
  getRecentMessagesForDirector,
  mergeDirectives,
  appendSystemNotice,
  appendMessage,
  handleMissingVisuals: (missing) => handleMissingVisuals(missing),
  saveCurrentChatState,
  setGeneratingState,
  getTurnCount: () => turnCount,
  updateHistorySummary,
  visualHandlers,
});

const runSidecarEnhancements = (...args) => sidecarController.runSidecarEnhancements(...args);
const handleStalledConversation = (...args) => sidecarController.handleStalledConversation(...args);

/* ------------------------------ SEND / REROLL ---------------------------- */
const chatController = createChatController({
  windowObj: window,
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
  handleMissingVisuals: (missing) => handleMissingVisuals(missing),
  visualHandlers,
  onTurnCompleted: () => { turnCount++; },
});

const handleSend = (...args) => chatController.handleSend(...args);
const swapMessageVersion = (...args) => chatController.swapMessageVersion(...args);
const deleteSwipe = (...args) => chatController.deleteSwipe(...args);
const regenerateResponse = (...args) => chatController.regenerateResponse(...args);

/* ------------------------------ EVENTS ----------------------------------- */

sendBtn.addEventListener('click', handleSend);
if (stopBtn) {
  stopBtn.addEventListener('click', async () => {
    if (!isGenerating) return;
    try {
      await window.api.cancelChat();
    } catch (e) {
      console.warn('Cancel failed:', e);
    }
  });
}

userInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    handleSend();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'F10') {
    e.preventDefault();
    toggleBgDiagnosticsPanel();
  }
});

/* ------------------------------ INIT ------------------------------------- */
const appInitializer = createAppInitializer({
  windowObj: window,
  documentObj: document,
  setupStateSubscribers,
  initializeChat,
  renderChat,
  saveCurrentChatState,
  regenerateResponse,
  swapMessageVersion,
  restoreChatState,
});

appInitializer.init();

