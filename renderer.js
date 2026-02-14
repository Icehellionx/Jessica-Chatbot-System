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
let latestBgRequestTime = 0;

window.__directorDebug = window.__directorDebug || { enabled: false, events: [] };
window.setDirectorDebug = function setDirectorDebug(enabled) {
  window.__directorDebug.enabled = Boolean(enabled);
  console.log(`[DirectorDebug] ${window.__directorDebug.enabled ? 'enabled' : 'disabled'}`);
};
window.getDirectorDebugEvents = function getDirectorDebugEvents() {
  return [...(window.__directorDebug.events || [])];
};
window.clearDirectorDebugEvents = function clearDirectorDebugEvents() {
  window.__directorDebug.events = [];
};
window.__pushDirectorDebugEvent = function __pushDirectorDebugEvent(type, payload = {}) {
  const evt = { ts: new Date().toISOString(), type, ...payload };
  const store = window.__directorDebug;
  store.events.push(evt);
  if (store.events.length > 300) store.events.shift();
  if (store.enabled) console.log('[DirectorDebug]', evt);
};

const BG_DIAG_PANEL_ID = 'bg-diag-panel';
const BG_DIAG_PRE_ID = 'bg-diag-panel-pre';
let bgDiagTimer = null;

function summarizeBgDiagnostics(events) {
  const recent = events.slice(-120);
  const count = (type) => recent.filter((e) => e.type === type).length;

  const reasons = [];
  if (count('bg-missing-generation-needed') === 0) {
    reasons.push('No missing BG events detected. Director is likely resolving to existing backgrounds.');
  }
  if (count('bg-missing-generation-needed') > 0 && count('bg-generate-start') === 0) {
    reasons.push('Missing BG detected, but generation did not start. Check handleMissingVisuals execution.');
  }
  if (count('bg-generate-start') > 0 && count('bg-generate-success') === 0) {
    if (count('bg-fallback-used') + count('bg-fallback-used-after-error') > 0) {
      reasons.push('Generation is failing upstream; fallback backgrounds are being used.');
    } else if (count('bg-generate-error') + count('bg-generate-empty') > 0) {
      reasons.push('Generation attempts are failing or returning empty results.');
    } else {
      reasons.push('Generation is in-flight or being discarded as stale.');
    }
  }
  if (count('bg-generate-stale') > 0) {
    reasons.push('Older generation requests are being discarded due to newer requests.');
  }

  if (reasons.length === 0) reasons.push('No obvious issue detected in recent events.');
  return reasons;
}

function getBgDiagnosticsSnapshot() {
  const events = window.getDirectorDebugEvents ? window.getDirectorDebugEvents() : [];
  const recent = events.slice(-25);
  const spinner = document.getElementById('vn-spinner');
  const spinnerActive = Boolean(spinner && spinner.classList.contains('active'));
  const currentBgStore = useStore.getState()?.currentBackground || '';
  const currentBgDom = document.getElementById('vn-bg')?.getAttribute('src') || '';
  const generatedInManifest = Object.keys(window.imageManifest?.backgrounds || {}).filter((k) => String(k).startsWith('backgrounds/generated/')).length;

  return {
    now: new Date().toISOString(),
    spinnerActive,
    currentBgStore,
    currentBgDom,
    generatedInManifest,
    directorDebugEnabled: Boolean(window.__directorDebug?.enabled),
    totalDebugEvents: events.length,
    reasons: summarizeBgDiagnostics(events),
    recentEvents: recent,
  };
}

function renderBgDiagnosticsPanel() {
  const pre = document.getElementById(BG_DIAG_PRE_ID);
  if (!pre) return;
  pre.textContent = JSON.stringify(getBgDiagnosticsSnapshot(), null, 2);
}

function ensureBgDiagnosticsPanel() {
  let panel = document.getElementById(BG_DIAG_PANEL_ID);
  if (panel) return panel;

  panel = document.createElement('div');
  panel.id = BG_DIAG_PANEL_ID;
  panel.style.cssText = 'position:fixed; top:10px; left:10px; width:min(760px, calc(100vw - 20px)); max-height:85vh; background:rgba(0,0,0,0.92); color:#d5ffd5; border:1px solid #3b4; border-radius:8px; z-index:30000; display:none; box-shadow:0 10px 25px rgba(0,0,0,0.6); font-family:Consolas, Menlo, monospace;';

  const header = document.createElement('div');
  header.style.cssText = 'display:flex; justify-content:space-between; align-items:center; padding:8px 10px; border-bottom:1px solid #2a3;';
  header.innerHTML = '<strong>Background Diagnostics (F10)</strong>';

  const controls = document.createElement('div');
  controls.style.cssText = 'display:flex; gap:8px;';

  const refreshBtn = document.createElement('button');
  refreshBtn.textContent = 'Refresh';
  refreshBtn.style.cssText = 'cursor:pointer;';
  refreshBtn.onclick = () => renderBgDiagnosticsPanel();

  const clearBtn = document.createElement('button');
  clearBtn.textContent = 'Clear Events';
  clearBtn.style.cssText = 'cursor:pointer;';
  clearBtn.onclick = () => {
    if (window.clearDirectorDebugEvents) window.clearDirectorDebugEvents();
    renderBgDiagnosticsPanel();
  };

  const closeBtn = document.createElement('button');
  closeBtn.textContent = 'Close';
  closeBtn.style.cssText = 'cursor:pointer;';
  closeBtn.onclick = () => toggleBgDiagnosticsPanel(false);

  controls.appendChild(refreshBtn);
  controls.appendChild(clearBtn);
  controls.appendChild(closeBtn);
  header.appendChild(controls);

  const pre = document.createElement('pre');
  pre.id = BG_DIAG_PRE_ID;
  pre.style.cssText = 'margin:0; padding:10px; white-space:pre-wrap; overflow:auto; max-height:calc(85vh - 48px); font-size:12px;';

  panel.appendChild(header);
  panel.appendChild(pre);
  document.body.appendChild(panel);
  return panel;
}

function toggleBgDiagnosticsPanel(forceOpen) {
  const panel = ensureBgDiagnosticsPanel();
  const shouldOpen = forceOpen == null ? panel.style.display === 'none' : Boolean(forceOpen);
  panel.style.display = shouldOpen ? 'block' : 'none';

  if (shouldOpen) {
    if (window.setDirectorDebug) window.setDirectorDebug(true);
    renderBgDiagnosticsPanel();
    if (bgDiagTimer) clearInterval(bgDiagTimer);
    bgDiagTimer = setInterval(renderBgDiagnosticsPanel, 1000);
  } else if (bgDiagTimer) {
    clearInterval(bgDiagTimer);
    bgDiagTimer = null;
  }
}

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
  contentDiv.innerHTML = parseMarkdown(window.stripVisualTags(rawText));
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

function pickFallbackBackgroundForRequest(requestedName) {
  const bgs = window.imageManifest?.backgrounds ? Object.keys(window.imageManifest.backgrounds) : [];
  if (!bgs.length) return null;

  const normReq = normalizeText(String(requestedName || ''));
  const tokens = normReq.split(/\s+/).filter(t => t.length > 2);

  let best = null;
  let bestScore = -1;
  for (const bg of bgs) {
    const base = bg.split(/[/\\]/).pop().split('.')[0];
    const normBg = normalizeText(base);
    let score = 0;

    if (normReq && normBg.includes(normReq)) score += 10;
    for (const t of tokens) if (normBg.includes(t)) score += 2;

    if (score > bestScore) {
      bestScore = score;
      best = bg;
    }
  }

  if (bestScore <= 0) {
    const generic = bgs.find(bg => {
      const n = bg.toLowerCase();
      return n.includes('default') || n.includes('main') || n.includes('common') || n.includes('outside') || n.includes('living');
    });
    return generic || bgs[0];
  }

  return best;
}

const pendingBgGenerations = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isFatalImageGenError(err) {
  const code = String(err?.code || '');
  return code === 'IMAGE_GEN_AUTH_REQUIRED' ||
    code === 'IMAGE_GEN_AUTH_INVALID' ||
    code === 'IMAGE_GEN_UNSUPPORTED_TYPE';
}

async function continueBackgroundGenerationInBackground({ requested, expandedPrompt, requestTime, notice }) {
  const key = `${requestTime}:${requested}`;
  if (pendingBgGenerations.has(key)) return;
  pendingBgGenerations.set(key, true);
  window.__pushDirectorDebugEvent('bg-background-generation-started', { requested, requestTime });
  if (window.setBackgroundGenerationStatus) window.setBackgroundGenerationStatus('retrying', requested);

  try {
    const delaysMs = [1200, 2000, 3000, 4500, 6000, 8000];
    for (let i = 0; i < delaysMs.length; i++) {
      // If a newer BG request exists, stop trying this one.
      if (latestBgRequestTime > requestTime) {
        window.__pushDirectorDebugEvent('bg-background-generation-cancelled-superseded', { requested, requestTime });
        return;
      }

      await sleep(delaysMs[i]);
      window.__pushDirectorDebugEvent('bg-background-generation-attempt', { requested, attempt: i + 1 });
      if (window.setBackgroundGenerationStatus) window.setBackgroundGenerationStatus('retrying', `${requested} #${i + 1}`);

      let newPath = null;
      try {
        newPath = await window.api.generateImage(expandedPrompt || requested, 'bg');
      } catch (e) {
        window.__pushDirectorDebugEvent('bg-background-generation-attempt-error', {
          requested,
          attempt: i + 1,
          code: String(e?.code || ''),
          error: String(e?.message || e),
        });
        if (isFatalImageGenError(e)) {
          window.__pushDirectorDebugEvent('bg-background-generation-fatal', {
            requested,
            code: String(e?.code || ''),
            error: String(e?.message || e),
          });
          if (window.setBackgroundGenerationStatus) window.setBackgroundGenerationStatus('error', String(e?.message || 'image generation not configured'));
          if (notice) notice.textContent = `⚠️ ${String(e?.message || 'Image generation unavailable')}`;
          return;
        }
      }

      if (!newPath) continue;
      if (latestBgRequestTime > requestTime) {
        window.__pushDirectorDebugEvent('bg-background-generation-late-stale', { requested, newPath });
        return;
      }

      useStore.getState().setBackground(newPath);
      await saveCurrentChatState();
      window.__pushDirectorDebugEvent('bg-background-generation-success', { requested, newPath, attempt: i + 1 });
      if (window.setBackgroundGenerationStatus) window.setBackgroundGenerationStatus('ready', 'generated');
      if (notice) {
        notice.textContent = `✅ Background generated: "${newPath}"`;
        setTimeout(() => { if (notice?.parentNode) notice.style.display = 'none'; }, 1800);
      }
      return;
    }

    window.__pushDirectorDebugEvent('bg-background-generation-exhausted', { requested });
    if (window.setBackgroundGenerationStatus) window.setBackgroundGenerationStatus('error', 'generation unavailable');
    if (notice) {
      notice.textContent = `⚠️ Still using fallback for "${requested}" (generation unavailable right now).`;
    }
  } finally {
    pendingBgGenerations.delete(key);
  }
}


/* ------------------------------ ASSET GENERATION ------------------------- */

async function handleMissingVisuals(missing) {
  if (!missing || !missing.length) return;
  window.__pushDirectorDebugEvent('missing-visuals', { missing });
  
  for (const m of missing) {
    if (m.type === 'bg') {
      const requestTime = Date.now();
      latestBgRequestTime = requestTime;
      window.__pushDirectorDebugEvent('bg-generate-start', { requested: m.value, requestTime });
      if (window.setBackgroundGenerationStatus) window.setBackgroundGenerationStatus('generating', m.value);
      const notice = appendMessage('system', `🎨 Generating background: "${m.value}"...`, undefined);
      if (window.setSpinner) window.setSpinner(true);
      try {
        // 1. Use Sidecar to expand the prompt for better results
        const expandedPrompt = await window.api.expandImagePrompt(m.value);
        console.log(`[Art Director] Expanded "${m.value}" -> "${expandedPrompt}"`);
        window.__pushDirectorDebugEvent('bg-prompt-expanded', { requested: m.value, expandedPrompt });

        // 2. Generate Image
        const newPath = await window.api.generateImage(expandedPrompt || m.value, 'bg');

        // If a newer BG request started while this one was generating, discard this result.
        if (latestBgRequestTime > requestTime) {
           console.log(`[Art Director] Discarding stale background result for "${m.value}"`);
           window.__pushDirectorDebugEvent('bg-generate-stale', { requested: m.value, requestTime, newPath });
           if (notice) notice.style.display = 'none';
           continue;
        }

        if (newPath) {
           useStore.getState().setBackground(newPath);
           await saveCurrentChatState();
           window.__pushDirectorDebugEvent('bg-generate-success', { requested: m.value, newPath });
           if (window.setBackgroundGenerationStatus) window.setBackgroundGenerationStatus('ready', 'generated');
           if (notice) notice.style.display = 'none'; // Hide notice on success
        } else {
           window.__pushDirectorDebugEvent('bg-generate-empty', { requested: m.value });
           const fallbackBg = pickFallbackBackgroundForRequest(m.value);
           if (fallbackBg) {
             useStore.getState().setBackground(fallbackBg);
             await saveCurrentChatState();
             window.__pushDirectorDebugEvent('bg-fallback-used', { requested: m.value, fallbackBg });
             if (window.setBackgroundGenerationStatus) window.setBackgroundGenerationStatus('fallback', m.value);
             if (notice) notice.textContent = `⏳ Generating "${m.value}" in background. Temporary fallback: "${fallbackBg}"`;
             // Keep trying in background and replace fallback once generated.
             void continueBackgroundGenerationInBackground({
               requested: m.value,
               expandedPrompt,
               requestTime,
               notice,
             });
           } else if (notice) {
             notice.textContent = `⚠️ Failed to generate background: "${m.value}" (no fallback available)`;
           }
        }
      } catch (e) {
        console.error(e);
        window.__pushDirectorDebugEvent('bg-generate-error', {
          requested: m.value,
          code: String(e?.code || ''),
          error: String(e?.message || e),
        });
        const fallbackBg = pickFallbackBackgroundForRequest(m.value);
        if (fallbackBg) {
          useStore.getState().setBackground(fallbackBg);
          await saveCurrentChatState();
          window.__pushDirectorDebugEvent('bg-fallback-used-after-error', { requested: m.value, fallbackBg });
          if (window.setBackgroundGenerationStatus) window.setBackgroundGenerationStatus('fallback', m.value);
          if (isFatalImageGenError(e)) {
            if (window.setBackgroundGenerationStatus) window.setBackgroundGenerationStatus('error', String(e?.message || 'generation unavailable'));
            if (notice) notice.textContent = `⚠️ ${String(e?.message || 'Image generation unavailable')}. Using fallback: "${fallbackBg}"`;
          } else {
            if (notice) notice.textContent = `⏳ Generation retrying in background. Temporary fallback: "${fallbackBg}"`;
            void continueBackgroundGenerationInBackground({
              requested: m.value,
              expandedPrompt: m.value,
              requestTime,
              notice,
            });
          }
        } else if (notice) {
          if (window.setBackgroundGenerationStatus) window.setBackgroundGenerationStatus('error', 'no fallback');
          notice.textContent = `⚠️ Failed to generate background: "${m.value}" (${String(e?.message || 'unknown error')})`;
        }
      } finally {
        if (window.setSpinner) window.setSpinner(false);
      }
    }
    else if (m.type === 'sprite_smart_lookup') {
      // The script asked for a sprite we don't have (e.g. "Jessica/Devastated").
      // Instead of generating a new one (risky), ask Sidecar to pick the closest existing one (e.g. "Jessica/Crying.png").
      try {
        const charName = m.charName;
        const allSprites = window.imageManifest?.sprites ? Object.keys(window.imageManifest.sprites) : [];
        
        // Filter to only this character's files
        const charFiles = allSprites.filter(f => window.getCharacterName(f) === charName);
        
        if (charFiles.length > 0) {
            const bestMatch = await window.api.findClosestSprite(m.value, charFiles);
            
            if (bestMatch && bestMatch !== 'none') {
                console.log(`[Casting Director] Mapped "${m.value}" -> "${bestMatch}"`);
                window.updateSprite(bestMatch);
                useStore.getState().setCharacterVisibility(charName, true);
                // Extract mood from filename for state
                const mood = bestMatch.split(/[/\\]/).pop().split('.')[0].replace(new RegExp(`^${charName}[_-]`, 'i'), '');
                useStore.getState().setCharacterEmotion(charName, mood || 'default');
                await saveCurrentChatState();
            } else {
                const fallback = window.findBestSprite(charName, 'default');
                if (fallback) {
                  console.warn(`[Casting Director] No close match for "${m.value}". Falling back to default: "${fallback}"`);
                  window.updateSprite(fallback);
                  useStore.getState().setCharacterVisibility(charName, true);
                  useStore.getState().setCharacterEmotion(charName, 'default');
                  await saveCurrentChatState();
                } else {
                  console.warn(`[Casting Director] No good match found for "${m.value}" and no default sprite available for "${charName}"`);
                }
            }
        }
      } catch (e) { console.warn('Smart sprite lookup failed', e); }
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

      window.playMusic('music/main_theme.mp3');

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
  
  const { setBackground, setCharacterEmotion, setCharacterVisibility, setMusic, setSplash, characters } = useStore.getState();

  // Restore messages (this part still needs some manual sync with the store)
  window.messages = Array.isArray(state?.messages) ? state.messages : [];
  useStore.setState({ dialogueHistory: window.messages }); // Sync store

  let bgToLoad = null;
  if (state?.background) {
    bgToLoad = window.validateImage(state.background, 'backgrounds');
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
  // Clear all characters currently in the store to handle case-sensitivity mismatches
  Object.keys(characters).forEach(char => setCharacterVisibility(char, false));
  
  if (Array.isArray(state?.sprites)) {
    console.log('[DEBUG] Restoring Sprites List:', state.sprites);
    for (const filename of state.sprites) {
        const charName = window.getCharacterName(filename);
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
      window.setDialogue(parseMarkdown(window.stripVisualTags(lastMsg.content)), false);
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
    window.hideSplash();
    if (window.setDialogue) window.setDialogue(""); // Clear dialogue box

    // Reset Store State for characters to ensure clean slate
    const { setCharacterVisibility, setCharacterEmotion, characters, setSplash } = useStore.getState();
    // Clear all characters currently in the store to handle case-sensitivity mismatches
    Object.keys(characters).forEach(char => setCharacterVisibility(char, false));
    setSplash(null); // Clear splash state so it doesn't persist in save

    let initialText =
      window.botInfo.initial ||
      "⚠️ Error: Could not load 'bot/files/initial.txt'. Please check that the file exists.";

    initialText = initialText.replace(/{{user}}/g, window.userPersona.name);

    // If no VN tags, do local heuristics
    if (!/\[(BG|SPRITE|SPLASH|MUSIC|HIDE):/i.test(initialText)) {
      const mood = getMood(initialText);
      const activeChars = getSceneContext(initialText);

      for (const charName of activeChars) {
        const sprite = window.findBestSprite(charName, mood);
        if (sprite) {
          window.updateSprite(sprite);
          setCharacterVisibility(charName, true);
          setCharacterEmotion(charName, mood || 'default');
        }
      }

      // Background heuristic: match by filename token
      const norm = normalizeText(initialText);
      const bgs = window.imageManifest?.backgrounds ? Object.keys(window.imageManifest.backgrounds) : [];
      
      // 1. Try to find a background mentioned in the text
      let bestBg = bgs.find(bg => {
        const name = bg.split(/[/\\]/).pop().split('.')[0].toLowerCase();
        return name.length > 2 && norm.includes(name);
      });

      // 2. Fallback: Look for generic names
      if (!bestBg) {
        bestBg = bgs.find(bg => {
          const lower = bg.toLowerCase();
          return lower.includes('default') || lower.includes('main') || lower.includes('base') || lower.includes('common');
        });
      }

      // 3. Fallback: Pick first available, but avoid character-specific backgrounds if that character isn't active
      if (!bestBg && bgs.length > 0) {
        const allCharNames = window.botInfo.characters ? Object.keys(window.botInfo.characters).map(c => c.toLowerCase()) : [];
        const activeCharNamesLower = activeChars.map(c => c.toLowerCase());

        // Find a background that does NOT contain the name of an inactive character
        bestBg = bgs.find(bg => {
          const lowerBg = bg.toLowerCase();
          // Check if this background mentions any character that ISN'T currently active
          const mentionsInactive = allCharNames.some(charName => 
            !activeCharNamesLower.includes(charName) && lowerBg.includes(charName)
          );
          return !mentionsInactive;
        });

        // 4. Absolute last resort: just take the first one
        if (!bestBg) bestBg = bgs[0];
      }
      
      if (bestBg) {
        window.changeBackground(bestBg);
        useStore.getState().setBackground(bestBg); // Sync store
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
        window.playMusic(bestTrack);
        useStore.getState().setMusic(bestTrack); // Sync store
      } else {
        window.playMusic(null);
        useStore.getState().setMusic(null);
      }
    }

    const { missing } = window.processVisualTags(initialText, { store: useStore.getState(), handlers: visualHandlers });
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
    if (window.showErrorModal) window.showErrorModal(e, 'An error occurred while resetting the chat.');
    else {
      const f = window.formatApiError || ((err, d) => err?.message || d);
      alert(f(e, 'An error occurred while resetting the chat.'));
    }
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
      
      const parsed = parseMarkdown(window.stripVisualTags(accumulated));
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
    const { stats, missing, report } = window.processVisualTags(fullResponse, { store: useStore.getState(), handlers: visualHandlers });
    if (missing?.length) handleMissingVisuals(missing); // Async, don't await to keep UI responsive


    // Apply local mood heuristic to keep characters alive,
    // but ONLY for characters that were NOT explicitly updated by tags.
    const activeSprites = window.__activeSprites || new Map();
    const mood = getMood(fullResponse);
    for (const charName of activeSprites.keys()) {
      if (stats.updatedCharNames && stats.updatedCharNames.has(charName)) continue;

      const sprite = window.findBestSprite(charName, mood);
      if (sprite) window.updateSprite(sprite);
    }

    updateThoughtsDropdown();

    // final render (tags stripped)
    contentDiv.innerHTML = parseMarkdown(window.stripVisualTags(fullResponse));
    if (window.setDialogue) window.setDialogue(contentDiv.innerHTML, false);

    if (window.voice) {
      window.voice.speak(fullResponse, options.activeCharacters);
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
    // Ensure chat stays pinned
    chatHistory.scrollTop = chatHistory.scrollHeight;
  }
}

function hasVisualDirectives(text) {
  return /\[(BG|SPRITE|SPLASH|MUSIC|HIDE|FX|SFX|CAMERA|TAKE|DROP|ADD_OBJECT):/i.test(String(text || ''));
}

function getRecentMessagesForDirector(messages, limit = 6) {
  return (messages || [])
    .slice(-limit)
    .map((m) => ({ role: m.role, content: String(m.content || '').slice(0, 500) }));
}

/**
 * Deterministic Merge Layer
 * Merges primary tags with sidecar tags based on priority rules.
 * Rule: Primary wins for explicit conflicts. Sidecar fills gaps.
 */
function mergeDirectives(primaryContent, sidecarTags) {
  if (!sidecarTags) return primaryContent;

  const primaryHas = {
    bg: /\[BG:/i.test(primaryContent),
    music: /\[MUSIC:/i.test(primaryContent),
    splash: /\[SPLASH:/i.test(primaryContent),
    sprites: /\[SPRITE:/i.test(primaryContent)
  };

  const sidecarLines = sidecarTags.split('\n').map(l => l.trim()).filter(l => l);
  const toAppend = [];

  for (const line of sidecarLines) {
    // 1. Background/Music/Splash: Only add if Primary is missing it
    if (/\[BG:/i.test(line) && !primaryHas.bg) toAppend.push(line);
    else if (/\[MUSIC:/i.test(line) && !primaryHas.music) toAppend.push(line);
    else if (/\[SPLASH:/i.test(line) && !primaryHas.splash) toAppend.push(line);
    
    // 2. Sprites: Complex merge
    // If Primary has NO sprites, accept all Sidecar sprites.
    // If Primary HAS sprites, we generally trust it knows who is there. 
    // (Advanced: check if Sidecar adds a character NOT in Primary. For now, safe merge = don't touch if Primary acted).
    else if (/\[SPRITE:/i.test(line) && !primaryHas.sprites) toAppend.push(line);
    
    // 3. FX/SFX/Camera: Always allow Sidecar to enhance (additive)
    else if (/\[(FX|SFX|CAMERA):/i.test(line)) toAppend.push(line);
  }

  if (toAppend.length === 0) return primaryContent;

  return primaryContent + `\n[SCENE]${toAppend.join(' ')}[/SCENE]`;
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

  // --- Sidecar: Context Optimization (The Librarian) ---
  // Gather candidates for context drawers
  let activeContextKeys = [];
  try {
    const lore = await window.api.getLorebook() || [];
    const loreKeys = lore.map(e => `Lore: ${e.entry.slice(0, 20)}...`);
    
    // If we have a lot of lore, ask Sidecar to filter it
    if (loreKeys.length > 5) {
        const relevant = await window.api.determineActiveContext(window.messages, loreKeys);
        if (relevant && relevant.length > 0) {
            console.log('[Librarian] Opening drawers:', relevant);
            // Map back to full entries (simplified logic for demo)
            // In a full implementation, you'd pass IDs or exact keys
            activeContextKeys = relevant;
        }
    }
  } catch (e) { console.warn('[Librarian] Failed:', e); }


  const payload = buildPayload(sceneCharacters);
  setGeneratingState(true);

  try {
    const { content, report, cancelled } = await streamChat(payload, {
      activeCharacters: sceneCharacters,
      inventory: inventory,
      sceneObjects: sceneObjects,
      activeContextKeys: activeContextKeys // Pass the filtered keys to the backend
    });

    if (content) {
      let finalContent = content;

      // --- Sidecar: The Editor ---
      // If the content looks suspicious (contains brackets), ask the sidecar to clean it.
      if (!cancelled && /[\[\]]/.test(finalContent)) {
          try {
             const cleaned = await window.api.cleanupResponse(finalContent);
             if (cleaned && cleaned !== finalContent) {
                 console.log('[Editor] Cleaned artifacts:', finalContent, '->', cleaned);
                 finalContent = cleaned;
             }
          } catch (e) { console.warn('[Editor] Cleanup failed:', e); }
      }

      window.messages.push({ role: 'assistant', content: finalContent, renderReport: report });
    } else if (!cancelled) {
      window.messages.push({ role: 'assistant', content: '', renderReport: report });
    }

    // --- Sidecar: Director Mode Logic ---
    const config = await window.api.getConfig();
    const directorMode = config.directorMode || 'fallback';

    const shouldRunDirector = (directorMode === 'always') || (directorMode === 'fallback' && !hasVisualDirectives(content));

    if (content && shouldRunDirector && !cancelled && directorMode !== 'off') {
        const activeNames = window.getActiveSpriteNames ? window.getActiveSpriteNames() : [];
        const currentState = useStore.getState();
        const tags = await window.api.getStageDirections(content, activeNames, {
            recentMessages: getRecentMessagesForDirector(window.messages),
            currentBackground: currentState.currentBackground || '',
            currentMusic: currentState.currentMusic || '',
            inventory: currentState.inventory || [],
            sceneObjects: currentState.sceneObjects || [],
            lastRenderReport: report || '',
        });

        if (tags && hasVisualDirectives(tags)) {
            console.log('[Director] Suggested tags:', tags);
            
            // MERGE: Combine original content with new tags safely
            const mergedContent = mergeDirectives(content, tags);
            
            // 1. Apply visual changes immediately (using the diff)
            const { missing } = window.processVisualTags(mergedContent, { store: useStore.getState(), handlers: visualHandlers });
            if (missing?.length) handleMissingVisuals(missing);
            
            // 2. Update history with the merged version
            window.messages[window.messages.length - 1].content = mergedContent;
        }
    }

    // --- Sidecar: Game State (Quest & Affinity) ---
    // Run this in background to update UI without blocking
    if (!cancelled && turnCount % 2 === 0) { // Update every 2 turns
        (async () => {
            try {
                // 1. Update Objective
                const objective = await window.api.getQuestObjective(window.messages);
                const objEl = document.getElementById('hud-objective');
                if (objEl) objEl.textContent = `Objective: ${objective}`;

                // 2. Update Affinity (for primary character)
                const activeNames = window.getActiveSpriteNames ? window.getActiveSpriteNames() : [];
                if (activeNames.length > 0) {
                    const affinity = await window.api.getAffinity(window.messages, activeNames[0]);
                    const affEl = document.getElementById('hud-affinity');
                    if (affEl && affinity) affEl.textContent = `Affinity: ${affinity.status} (${affinity.score}%)`;
                }
            } catch (e) { console.warn('Game state update failed', e); }
        })();

        // --- Sidecar: The Profiler (AURA Memory) ---
        // Every 4 turns, check for new facts and add to Lorebook
        if (turnCount % 4 === 0) {
            (async () => {
                try {
                    const newEntries = await window.api.extractUserFacts(window.messages);
                    if (newEntries && newEntries.length > 0) {
                        console.log('[Profiler] Discovered facts:', newEntries);
                        
                        const currentLore = await window.api.getLorebook() || [];
                        let added = false;

                        for (const item of newEntries) {
                            // Simple duplicate check to prevent spamming the lorebook
                            const exists = currentLore.some(e => e.entry === item.entry);
                            if (!exists && item.entry && item.keywords) {
                                currentLore.push({
                                    entry: item.entry,
                                    keywords: item.keywords,
                                    scenario: 'User Memory' // Tag for organization
                                });
                                added = true;
                            }
                        }

                        if (added) {
                            await window.api.saveLorebook(currentLore);
                            if (window.showToast) window.showToast(`🧠 Memory Updated: ${newEntries.length} new fact(s)`);
                        }
                    }
                } catch (e) { console.warn('[Profiler] Failed:', e); }
            })();
        }
    }

    await saveCurrentChatState();
    
    // Re-render to ensure the new message gets its buttons (Delete, Branch, etc.)
    renderChat();

    // Character evolution: Run AFTER the turn is secure to avoid race conditions
    if (turnCount > 0 && turnCount % 5 === 0) {
      window.api.evolveCharacterState(window.messages, sceneCharacters)
        .then(updates => {
            if (updates) console.log('[Character Evolution] State updated:', updates);
        })
        .catch(e => console.warn('Evolution skipped:', e));
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
    if (window.showErrorModal) window.showErrorModal(error, 'Failed to send message.');
    else {
      const f = window.formatApiError || ((err, d) => err?.message || d);
      alert(f(error, 'Failed to send message.'));
    }
  } finally {
    setGeneratingState(false);
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
  const { missing } = window.processVisualTags(msg.content, { store: useStore.getState(), handlers: visualHandlers });
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
  const { missing } = window.processVisualTags(msg.content, { store: useStore.getState(), handlers: visualHandlers });
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
    if (window.showErrorModal) window.showErrorModal(error, 'Failed to regenerate response.');
    else {
      const f = window.formatApiError || ((err, d) => err?.message || d);
      alert(f(error, 'Failed to regenerate response.'));
    }
  } finally {
    window.refocusInput();
  }
}

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

async function init() {
  window.setupVisuals();
  setupStateSubscribers(); // <-- Add this line
  window.setupUI({ initializeChat, renderChat, saveCurrentChatState, regenerateResponse, swapMessageVersion });
  if (window.setupHUD) window.setupHUD(); // Ensure HUD is created
  if (window.setBackgroundGenerationStatus) window.setBackgroundGenerationStatus('idle');
  if (window.setupSettingsUI) window.setupSettingsUI({ initializeChat });

  window.setupVolumeControls();

  // Loading overlay
  const loadingOverlay = document.createElement('div');
  loadingOverlay.id = 'loading-overlay';
  loadingOverlay.innerHTML = '<div>Resetting Story...</div>';
  document.body.appendChild(loadingOverlay);

  window.preloadImages();

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
