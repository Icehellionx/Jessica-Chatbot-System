/* ============================================================================
   prompt-engine.js — AI Context & Prompt Construction
   ========================================================================== */
import { $ } from './utils.js';

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

export function getMood(text) {
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

/* ------------------------------ SCENE CONTEXT ---------------------------- */

export function getSceneContext(userText) {
  // 1) currently visible
  // We access the global activeSprites map exposed by visuals.js
  const activeSprites = window.__activeSprites || new Map();
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
 */
function extractCharacterSummary(charText) {
  if (!charText) return '';
  const match = String(charText).match(/###\s*SUMMARY:([\s\S]*?)(?=###|$)/i);
  const raw = match ? match[1].trim() : String(charText).slice(0, 150).replace(/\n/g, ' ') + '...';
  return raw.length > 200 ? raw.slice(0, 200) + '...' : raw;
}

export function buildSystemPrompt(sceneCharacters) {
  const activeSprites = window.__activeSprites || new Map();
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

  // --- RENDER FEEDBACK (Self-Correction) ---
  const lastAssistant = window.messages.slice().reverse().find(m => m.role === 'assistant');
  if (lastAssistant?.renderReport?.mismatches?.length) {
     systemContent += `\n\n[RENDER FEEDBACK]\nYour last visual tags had issues:\n${lastAssistant.renderReport.mismatches.join('\n')}\n(Please adapt narration to the actual visuals)`;
  }

  return systemContent.trim();
}

export function buildPayload(sceneCharacters) {
  const systemContent = buildSystemPrompt(sceneCharacters);
  return systemContent
    ? [{ role: 'system', content: systemContent }, ...window.messages]
    : window.messages;
}
