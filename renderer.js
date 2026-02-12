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

  // Blur/focus helps Electron when focus gets “stuck” after modals
  input.blur();
  setTimeout(() => {
    input.disabled = false;
    window.focus();
    input.focus();
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

  // Prime voice engine with the last assistant message so the button works immediately
  if (window.voice && window.messages.length > 0) {
    const lastMsg = window.messages[window.messages.length - 1];
    if (lastMsg && lastMsg.role === 'assistant') {
      window.voice.speak(lastMsg.content, getSceneContext(lastMsg.content));
    }
  }

  console.log('Chat state restored.');
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
    if (activeSprites.has(nameLower)) {
      // Webbing: Tell AI what the character currently looks like (Mood)
      const img = activeSprites.get(nameLower);
      if (img && img.src) {
        // Extract filename: "bot-resource://sprites/Jessica/happy.png" -> "happy"
        try {
          const filename = decodeURIComponent(img.src.split('bot-resource://')[1] || '');
          const base = filename.split(/[/\\]/).pop().split('.')[0]; // "happy"
          // Remove char name if present (e.g. "jessica_happy" -> "happy")
          const mood = base.toLowerCase().replace(nameLower, '').replace(/^[_\-\s]+/, '') || 'Default';
          systemContent += `\n(Visual State: ${realName} is currently showing expression: "${mood}")`;
        } catch (e) {}
      }
    } else {
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

  // --- SCENE AWARENESS (Webbing) ---
  // Inject current background, music, and time so the AI knows the "Vibe"
  const bgSrc = $('vn-bg')?.src || '';
  let location = 'Unknown';
  if (bgSrc.includes('bot-resource://')) {
    const bgName = decodeURIComponent(bgSrc.split('bot-resource://')[1]);
    location = bgName.split(/[/\\]/).pop().split('.')[0].replace(/[_-]/g, ' ');
  }

  const musicName = window.getCurrentMusicFilename ? window.getCurrentMusicFilename() : '';
  const musicInfo = musicName ? `\nBackground Music: "${musicName.split(/[/\\]/).pop().split('.')[0].replace(/[_-]/g, ' ')}"` : '';

  systemContent += `\n\n[CURRENT SCENE STATE]\nLocation: ${location}${musicInfo}`;

  // Summary
  if (window.chatSummary?.content) {
    systemContent += `\n\n[STORY SUMMARY]\n${window.chatSummary.content}`;
  }

  // --- ASSET MANIFEST (Available assets for tag selection) ---
  const manifest = window.imageManifest || {};
  const assetLines = [];

  if (manifest.backgrounds) {
    const bgNames = Object.keys(manifest.backgrounds).map(k => k.split(/[/\\]/).pop().split('.')[0]).filter(Boolean);
    if (bgNames.length) assetLines.push(`Backgrounds: ${bgNames.join(', ')}`);
  }
  if (manifest.sprites) {
    const spritesByChar = {};
    for (const key of Object.keys(manifest.sprites)) {
      const charName = key.split(/[/\\]/)[0] || key.split('_')[0];
      const fileName = key.split(/[/\\]/).pop().split('.')[0];
      const char = charName.toLowerCase();
      if (!spritesByChar[char]) spritesByChar[char] = [];
      const expression = fileName.toLowerCase().replace(char, '').replace(/^[_\-\s]+/, '') || 'default';
      if (!spritesByChar[char].includes(expression)) spritesByChar[char].push(expression);
    }
    for (const [char, expressions] of Object.entries(spritesByChar)) {
      assetLines.push(`${char} expressions: ${expressions.join(', ')}`);
    }
  }
  if (manifest.music) {
    const musicNames = Object.keys(manifest.music).map(k => k.split(/[/\\]/).pop().split('.')[0]).filter(Boolean);
    if (musicNames.length) assetLines.push(`Music: ${musicNames.join(', ')}`);
  }
  if (assetLines.length) {
    systemContent += `\n\n[AVAILABLE ASSETS]\n${assetLines.join('\n')}\n(Use these exact names in your visual tags for best results)`;
  }

  // --- RENDER FEEDBACK (Self-Correction) ---
  // Check the last assistant message for any visual mismatches
  const lastAssistant = window.messages.slice().reverse().find(m => m.role === 'assistant');
  if (lastAssistant?.renderReport?.mismatches?.length) {
     systemContent += `\n\n[RENDER FEEDBACK]\nYour last visual tags had issues:\n${lastAssistant.renderReport.mismatches.join('\n')}\n(Please adapt narration to the actual visuals)`;
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

    const { missing } = processVisualTags(initialText);
    if (missing?.length) await handleMissingVisuals(missing);

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
    const { stats, missing, report } = processVisualTags(fullResponse);
    if (missing?.length) handleMissingVisuals(missing); // Async, don't await to keep UI responsive

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

    if (window.voice) {
      window.voice.speak(fullResponse, sceneCharacters);
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

  const payload = buildPayload(sceneCharacters);

  try {
    const { content, report } = await streamChat(payload, sceneCharacters);

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
  const { missing } = processVisualTags(msg.content);
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
  const { missing } = processVisualTags(msg.content);
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
    const { content: rawResponse, report } = await streamChat(payload, sceneCharacters);

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
  setupUI({ initializeChat, renderChat, saveCurrentChatState, regenerateResponse, swapMessageVersion });

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
