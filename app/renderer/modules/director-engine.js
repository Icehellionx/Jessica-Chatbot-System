// c:\Users\icehe\Desktop\Jessica\src\director-engine.js
'use strict';

import { useStore } from './store.js';
import { UIManager } from './ui-manager.js';

let latestBgRequestTime = 0;

function isFatalImageGenError(err) {
  const code = String(err?.code || '');
  return code === 'IMAGE_GEN_AUTH_REQUIRED' ||
    code === 'IMAGE_GEN_AUTH_INVALID' ||
    code === 'IMAGE_GEN_UNSUPPORTED_TYPE';
}

function pickFallbackBackgroundForRequest(requestedName) {
  const bgs = window.imageManifest?.backgrounds ? Object.keys(window.imageManifest.backgrounds) : [];
  if (!bgs.length) return null;

  const req = String(requestedName || '').toLowerCase().replace(/[_-]+/g, ' ');
  const tokens = req.split(/\s+/).filter(t => t.length > 2);
  let best = null;
  let bestScore = -1;

  for (const bg of bgs) {
    const base = String(bg).toLowerCase();
    let score = 0;
    if (req && base.includes(req)) score += 10;
    for (const t of tokens) if (base.includes(t)) score += 2;
    if (score > bestScore) {
      bestScore = score;
      best = bg;
    }
  }

  if (bestScore <= 0) return bgs[0];
  return best;
}

export const DirectorEngine = {
  // Handlers that update the Store (Single Source of Truth)
  visualHandlers: {
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
  },

  async handleMissingVisuals(missing) {
    if (!missing || !missing.length) return;
    
    for (const m of missing) {
      if (m.type === 'bg') {
        const requestTime = Date.now();
        latestBgRequestTime = requestTime;

        const notice = UIManager.appendMessage('system', `🎨 Generating background: "${m.value}"...`, undefined);
        if (window.setSpinner) window.setSpinner(true);
        try {
          // 1. Use Sidecar to expand the prompt for better results
          const expandedPrompt = await window.api.expandImagePrompt(m.value);
          console.log(`[Art Director] Expanded "${m.value}" -> "${expandedPrompt}"`);
  
          // 2. Generate Image
          const newPath = await window.api.generateImage(expandedPrompt || m.value, 'bg');

          // Race Condition Check: If a newer request started while we were generating, discard this one.
          if (latestBgRequestTime > requestTime) {
             console.log(`[Art Director] Discarding stale background result for "${m.value}"`);
             if (notice) notice.style.display = 'none';
             continue;
          }

          if (newPath) {
             useStore.getState().setBackground(newPath);
             // Note: saveCurrentChatState should be called by the caller if needed
             if (notice) notice.style.display = 'none'; 
          } else {
             const fallbackBg = pickFallbackBackgroundForRequest(m.value);
             if (fallbackBg) {
               useStore.getState().setBackground(fallbackBg);
               if (notice) notice.textContent = `⚠️ Generation unavailable. Using fallback background: "${fallbackBg}"`;
             } else if (notice) {
               notice.textContent = `⚠️ Failed to generate background: "${m.value}" (no fallback available)`;
             }
          }
        } catch (e) {
          console.error(e);
          const fallbackBg = pickFallbackBackgroundForRequest(m.value);
          if (fallbackBg) {
            useStore.getState().setBackground(fallbackBg);
            if (isFatalImageGenError(e)) {
              if (notice) notice.textContent = `⚠️ ${String(e?.message || 'Image generation unavailable')}. Using fallback background: "${fallbackBg}"`;
            } else {
              if (notice) notice.textContent = `⚠️ Generation failed. Using fallback background: "${fallbackBg}"`;
            }
          } else if (notice) {
            notice.textContent = `⚠️ Failed to generate background: "${m.value}" (${String(e?.message || 'unknown error')})`;
          }
        } finally {
          if (window.setSpinner) window.setSpinner(false);
        }
      }
      else if (m.type === 'sprite_smart_lookup') {
        try {
          const charName = m.charName;
          const allSprites = window.imageManifest?.sprites ? Object.keys(window.imageManifest.sprites) : [];
          
          const charFiles = allSprites.filter(f => window.getCharacterName(f) === charName);
          
          if (charFiles.length > 0) {
              const bestMatch = await window.api.findClosestSprite(m.value, charFiles);
              
              if (bestMatch && bestMatch !== 'none') {
                  console.log(`[Casting Director] Mapped "${m.value}" -> "${bestMatch}"`);
                  window.updateSprite(bestMatch);
                  useStore.getState().setCharacterVisibility(charName, true);
                  const mood = bestMatch.split(/[/\\]/).pop().split('.')[0].replace(new RegExp(`^${charName}[_-]`, 'i'), '');
                  useStore.getState().setCharacterEmotion(charName, mood || 'default');
              } else {
                  const fallback = window.findBestSprite(charName, 'default');
                  if (fallback) {
                    console.warn(`[Casting Director] No close match for "${m.value}". Falling back to default: "${fallback}"`);
                    window.updateSprite(fallback);
                    useStore.getState().setCharacterVisibility(charName, true);
                    useStore.getState().setCharacterEmotion(charName, 'default');
                  } else {
                    console.warn(`[Casting Director] No good match found for "${m.value}" and no default sprite available for "${charName}"`);
                  }
              }
          }
        } catch (e) { console.warn('Smart sprite lookup failed', e); }
      }
    }
  },

  hasVisualDirectives(text) {
    return /\[(BG|SPRITE|SPLASH|MUSIC|HIDE|FX|SFX|CAMERA|TAKE|DROP|ADD_OBJECT):/i.test(String(text || ''));
  },

  getRecentMessagesForDirector(messages, limit = 6) {
    return (messages || [])
      .slice(-limit)
      .map((m) => ({ role: m.role, content: String(m.content || '').slice(0, 500) }));
  },

  mergeDirectives(primaryContent, sidecarTags) {
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
      if (/\[BG:/i.test(line) && !primaryHas.bg) toAppend.push(line);
      else if (/\[MUSIC:/i.test(line) && !primaryHas.music) toAppend.push(line);
      else if (/\[SPLASH:/i.test(line) && !primaryHas.splash) toAppend.push(line);
      else if (/\[SPRITE:/i.test(line) && !primaryHas.sprites) toAppend.push(line);
      else if (/\[(FX|SFX|CAMERA):/i.test(line)) toAppend.push(line);
    }
  
    if (toAppend.length === 0) return primaryContent;
  
    return primaryContent + `\n[SCENE]${toAppend.join(' ')}[/SCENE]`;
  },

  async runDirectorPass(content, report) {
    const config = await window.api.getConfig();
    const directorMode = config.directorMode || 'fallback';

    const shouldRunDirector = (directorMode === 'always') || (directorMode === 'fallback' && !this.hasVisualDirectives(content));

    if (content && shouldRunDirector && directorMode !== 'off') {
        const activeNames = window.getActiveSpriteNames ? window.getActiveSpriteNames() : [];
        const currentState = useStore.getState();
        const tags = await window.api.getStageDirections(content, activeNames, {
            recentMessages: this.getRecentMessagesForDirector(window.messages),
            currentBackground: currentState.currentBackground || '',
            currentMusic: currentState.currentMusic || '',
            inventory: currentState.inventory || [],
            sceneObjects: currentState.sceneObjects || [],
            lastRenderReport: report || '',
        });

        if (tags && this.hasVisualDirectives(tags)) {
            console.log('[Director] Suggested tags:', tags);
            return this.mergeDirectives(content, tags);
        }
    }
    return content;
  }
};
