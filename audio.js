'use strict';

/* ============================================================================
   MUSIC / BGM ENGINE
   - Manual loop with crossfade (avoids hard loop click)
   - Toolbar UI: mute + volume slider
   - Current track can be stopped by playMusic(null | "none" | "stop")
   ========================================================================== */

let currentMusic = null;      // The currently "active" Audio instance
let musicVolume = 0.5;        // 0..1
let isMuted = false;
let voiceVolume = 1.0;        // 0..1 for TTS
let sfxVolume = 0.7;          // 0..1 for Sound Effects
let isDucked = false;         // Ducking state for TTS

const LOOP_CROSSFADE_MS = 2000;
const FADE_TICK_MS = 50;


/* ----------------------------- UI CONTROLS ------------------------------ */

function setupVolumeControls() {
  const toolbar = document.getElementById('toolbar');
  if (!toolbar) return; // If toolbar isn't mounted yet, call again later.

  // Avoid duplicating controls if called twice
  if (document.getElementById('volume-controls')) return;

  const volumeContainer = document.createElement('div');
  volumeContainer.id = 'volume-controls';
  volumeContainer.style.cssText = `
    display:flex;
    align-items:flex-end;
    margin-right:15px;
    gap: 10px;
    flex-wrap:wrap;
  `;

  // Helper to create a labeled group (Label on top, controls below)
  const createGroup = (labelText, btn, slider) => {
    const group = document.createElement('div');
    group.className = 'toolbar-group';
    group.style.cssText = `
      display:flex;
      flex-direction:column;
      align-items:center;
    `;
    
    const label = document.createElement('span');
    label.className = 'toolbar-label';
    label.textContent = labelText;
    label.style.cssText = 'color:#ccc; font-size:10px; font-family:sans-serif; margin-bottom:2px; text-transform:uppercase; letter-spacing:0.5px; line-height:1;';
    
    const row = document.createElement('div');
    row.style.cssText = 'display:flex; align-items:center;';
    
    row.appendChild(btn);
    row.appendChild(slider);
    
    group.appendChild(label);
    group.appendChild(row);
    return group;
  };

  const muteBtn = document.createElement('button');
  muteBtn.id = 'mute-btn';
  muteBtn.type = 'button';
  muteBtn.textContent = isMuted ? '🔇' : '🔊';
  muteBtn.className = 'tool-btn';
  muteBtn.style.marginRight = '5px';

  const volumeSlider = document.createElement('input');
  volumeSlider.id = 'volume-slider';
  volumeSlider.type = 'range';
  volumeSlider.min = '0';
  volumeSlider.max = '1';
  volumeSlider.step = '0.05';
  volumeSlider.value = String(musicVolume);
  volumeSlider.style.cssText = `
    width:60px;
    cursor:pointer;
    accent-color:#0078d4;
  `;
  volumeSlider.title = 'Music Volume';

  const voiceBtn = document.createElement('button');
  voiceBtn.id = 'voice-btn';
  voiceBtn.type = 'button';
  voiceBtn.textContent = '🗣️';
  voiceBtn.title = 'Play/Stop Voice';
  voiceBtn.className = 'tool-btn';
  voiceBtn.style.marginRight = '5px';

  const voiceSlider = document.createElement('input');
  voiceSlider.id = 'voice-slider';
  voiceSlider.type = 'range';
  voiceSlider.min = '0';
  voiceSlider.max = '1';
  voiceSlider.step = '0.05';
  voiceSlider.value = String(voiceVolume);
  voiceSlider.title = 'Voice Volume';
  voiceSlider.style.cssText = volumeSlider.style.cssText;

  const sfxSlider = document.createElement('input');
  sfxSlider.type = 'range';
  sfxSlider.min = '0';
  sfxSlider.max = '1';
  sfxSlider.step = '0.05';
  sfxSlider.value = String(sfxVolume);
  sfxSlider.title = 'SFX Volume';
  sfxSlider.style.cssText = volumeSlider.style.cssText;

  const sfxBtn = document.createElement('button');
  sfxBtn.type = 'button';
  sfxBtn.textContent = '🎶';
  sfxBtn.className = 'tool-btn';
  sfxBtn.style.marginRight = '5px';
  sfxBtn.title = 'SFX';


  // Assemble groups
  volumeContainer.appendChild(createGroup('Voice', voiceBtn, voiceSlider));
  volumeContainer.appendChild(createGroup('SFX', sfxBtn, sfxSlider));
  volumeContainer.appendChild(createGroup('Music', muteBtn, volumeSlider));

  // If an undo button exists, insert before it for consistent layout
  const undoBtn = document.getElementById('undo-btn');
  if (undoBtn) toolbar.insertBefore(volumeContainer, undoBtn);
  else toolbar.appendChild(volumeContainer);

  voiceBtn.addEventListener('click', () => {
    if (window.voice) window.voice.toggle();
  });

  voiceSlider.addEventListener('input', (e) => {
    voiceVolume = clamp01(parseFloat(e.target.value));
    // Update active audio immediately if possible
    if (window.voice) window.voice.setVolume(voiceVolume);
  });

  sfxSlider.addEventListener('input', (e) => {
    sfxVolume = clamp01(parseFloat(e.target.value));
  });


  muteBtn.addEventListener('click', () => {
    setMuted(!isMuted);
    muteBtn.textContent = isMuted ? '🔇' : '🔊';
  });

  volumeSlider.addEventListener('input', (e) => {
    const v = clamp01(parseFloat(e.target.value));
    setVolume(v);

    // UX: if user drags volume above 0 while muted, unmute automatically
    if (v > 0 && isMuted) {
      setMuted(false);
      muteBtn.textContent = '🔊';
    }
  });
}

function setMuted(muted) {
  isMuted = Boolean(muted);
  if (currentMusic) currentMusic.muted = isMuted;
}

function setVolume(v) {
  musicVolume = clamp01(v);
  if (currentMusic && !currentMusic._isFading) {
    // If not currently fading, apply immediately.
    currentMusic.volume = getEffectiveVolume();
  }
}

function getEffectiveVolume() {
  // Cap music at 20% if ducking is active
  return isDucked ? Math.min(musicVolume, 0.2) : musicVolume;
}

function setDucking(active) {
  if (isDucked === active) return;
  isDucked = active;
  if (currentMusic) {
    fadeTo(currentMusic, getEffectiveVolume(), 500);
  }
}

/* ----------------------------- PUBLIC API ------------------------------ */

/**
 * Play a music file by filename (resolved via bot-resource://).
 * Pass null / "" / "none" / "stop" to stop music.
 */
function playMusic(filename) {
  const stopRequested = isStopCommand(filename);

  // If something is currently playing, stop or crossfade out.
  if (currentMusic) {
    // If we’re asked to play the same file and it’s still active, do nothing.
    if (!stopRequested) {
      const currentName = getAudioFilename(currentMusic);
      if (currentName && normalizeName(currentName) === normalizeName(filename) && !currentMusic.ended) {
        return;
      }
    }

    stopCurrentMusic(); // fades out + pauses old track
  }

  if (stopRequested) return;

  // Start the new track
  const audio = createAudioObject(filename);
  currentMusic = audio;

  audio.play()
    .then(() => {
      if (currentMusic !== audio) {
        // Another track took over while this one was loading
        audio.pause();
        return;
      }
      fadeTo(audio, getEffectiveVolume(), 1000);
    })
    .catch((e) => {
      console.error('Failed to play music:', e);
      if (currentMusic === audio) currentMusic = null;
    });
}

/**
 * Returns the currently playing filename (without bot-resource://), or ''.
 */
function getCurrentMusicFilename() {
  if (!currentMusic || currentMusic.paused) return '';
  return getAudioFilename(currentMusic) || '';
}

/**
 * Play a one-shot sound effect.
 */
function playSfx(filename) {
  if (isStopCommand(filename)) return;

  // We use a simplified path assumption for SFX
  const audio = new Audio(`bot-resource://sfx/${filename}`);
  audio.volume = sfxVolume;

  audio.play().catch(e => {
    console.error(`Failed to play SFX: ${filename}`, e);
  });
}

/* ------------------------------ INTERNALS ------------------------------ */

function stopCurrentMusic() {
  const old = currentMusic;
  currentMusic = null;

  if (!old) return;

  // Prevent any loop triggers from scheduling additional crossfades
  old._loopArmed = false;

  clearFade(old);
  fadeTo(old, 0, 800, () => {
    try { old.pause(); } catch {}
  });
}

function createAudioObject(filename) {
  const audio = new Audio(`bot-resource://${filename}`);

  // We do manual looping for crossfades (do not use native loop)
  audio.loop = false;

  // Current global settings
  audio.muted = isMuted;
  audio.volume = 0;

  // Internal flags (namespaced to avoid colliding with real Audio props)
  audio._isFading = false;
  audio._fadeTimer = null;
  audio._loopArmed = false;     // ensures we only trigger loop once per playback end window
  audio._sourceName = filename; // store for accurate comparisons

  const maybeTriggerLoop = () => {
    // Only loop if this audio is still the current one and not already armed.
    if (currentMusic !== audio) return;
    if (audio._loopArmed) return;

    audio._loopArmed = true;
    triggerLoop(filename);
  };

  // When metadata is loaded we know duration; arm loop when entering the crossfade window.
  audio.addEventListener('timeupdate', () => {
    if (currentMusic !== audio) return;
    if (!audio.duration || !Number.isFinite(audio.duration)) return;

    const secondsLeft = audio.duration - audio.currentTime;
    if (secondsLeft <= (LOOP_CROSSFADE_MS / 1000)) {
      maybeTriggerLoop();
    }
  });

  // Safety fallback: if we somehow reach 'ended' without triggering, do it here.
  audio.addEventListener('ended', () => {
    maybeTriggerLoop();
  });

  // For extremely short clips, crossfading can be pointless or impossible.
  // In that case, you can either (A) allow native looping, or (B) just re-trigger immediately.
  audio.addEventListener('loadedmetadata', () => {
    if (!audio.duration || !Number.isFinite(audio.duration)) return;

    // If clip is shorter than twice the crossfade window, crossfade becomes a mess.
    if (audio.duration < (LOOP_CROSSFADE_MS / 1000) * 2) {
      // Option A: native loop (no crossfade)
      audio.loop = true;
    }
  });

  return audio;
}

/**
 * Crossfade: start a fresh instance of the same file and fade old->new.
 * Important: we update currentMusic immediately so stop commands affect the new track.
 */
function triggerLoop(filename) {
  if (!currentMusic) return;

  const oldMusic = currentMusic;
  const newMusic = createAudioObject(filename);

  currentMusic = newMusic;

  newMusic.play()
    .then(() => {
      if (currentMusic !== newMusic) {
        newMusic.pause();
        return;
      }

      // Crossfade
      fadeTo(newMusic, getEffectiveVolume(), LOOP_CROSSFADE_MS);
      fadeTo(oldMusic, 0, LOOP_CROSSFADE_MS, () => {
        try { oldMusic.pause(); } catch {}
      });
    })
    .catch((e) => {
      console.error('Loop failed:', e);
      // If loop failed, revert state cautiously
      if (currentMusic === newMusic) currentMusic = null;
    });
}

/**
 * Fade an audio element to a target volume.
 * - Clears any previous fade interval on that element
 * - Uses linear steps
 */
function fadeTo(audio, targetVolume, durationMs = 1000, onDone) {
  if (!audio) return;

  clearFade(audio);

  const target = clamp01(targetVolume);
  const start = clamp01(audio.volume);

  // Nothing to do
  if (durationMs <= 0 || nearlyEqual(start, target)) {
    audio.volume = target;
    audio._isFading = false;
    if (typeof onDone === 'function') onDone();
    return;
  }

  const steps = Math.max(1, Math.floor(durationMs / FADE_TICK_MS));
  const delta = (target - start) / steps;
  let i = 0;

  audio._isFading = true;

  audio._fadeTimer = setInterval(() => {
    i++;

    const next = clamp01(audio.volume + delta);
    audio.volume = next;

    if (i >= steps || nearlyEqual(next, target)) {
      clearFade(audio);
      audio.volume = target;
      if (typeof onDone === 'function') onDone();
    }
  }, FADE_TICK_MS);
}

function clearFade(audio) {
  if (!audio) return;
  if (audio._fadeTimer) clearInterval(audio._fadeTimer);
  audio._fadeTimer = null;
  audio._isFading = false;
}

/* ----------------------------- UTILITIES ------------------------------ */

function isStopCommand(filename) {
  if (!filename) return true;
  const f = String(filename).trim().toLowerCase();
  return f === '' || f === 'none' || f === 'stop';
}

function getAudioFilename(audio) {
  // Prefer stored name (most reliable)
  if (audio?._sourceName) return audio._sourceName;

  const src = audio?.src;
  if (!src) return '';

  if (src.includes('bot-resource://')) {
    try {
      return decodeURIComponent(src.split('bot-resource://')[1] || '');
    } catch {
      return src.split('bot-resource://')[1] || '';
    }
  }

  return '';
}

function normalizeName(name) {
  return String(name ?? '').trim().toLowerCase();
}

function clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}

function nearlyEqual(a, b, eps = 0.001) {
  return Math.abs(a - b) <= eps;
}

/* ============================================================================
   VOICE ENGINE (TTS)
   - Parses text into Narrator vs Character segments
   - Queues audio playback
   - Supports Browser TTS fallback + API hooks
   ========================================================================== */

class VoiceEngine {
  constructor() {
    this.queue = [];
    this.isPlaying = false;
    this.currentAudio = null;
    this.lastText = null;
    this.lastContext = [];
  }

  stop() {
    this.queue = [];
    this.isPlaying = false;
    if (this.currentAudio) {
      this.currentAudio.pause();
      this.currentAudio = null;
    }
    // Stop animation for everyone when stopping
    if (window.setCharSpeaking && window.getActiveSpriteNames) {
      window.getActiveSpriteNames().forEach(n => window.setCharSpeaking(n, false));
    }
    setDucking(false);
    window.speechSynthesis.cancel();
    this.updateBtn(false);
  }

  updateBtn(playing) {
    const btn = document.getElementById('voice-btn');
    if (btn) btn.textContent = playing ? '⏹️' : '🗣️';
  }

  setVolume(v) {
    if (this.currentAudio) {
      this.currentAudio.volume = v;
    }
  }

  // Called by renderer when new text arrives.
  // We just buffer it now; user must click to play ("Push to Go").
  speak(text, activeCharacters = []) {
    this.stop();
    this.lastText = text;
    this.lastContext = activeCharacters;
  }

  toggle() {
    if (this.isPlaying) {
      this.stop();
    } else {
      if (this.lastText) {
        this.playText(this.lastText, this.lastContext);
      }
    }
  }

  // Internal: parses text and starts queue
  playText(text, activeCharacters) {
    this.stop();

    // 1. Clean visual tags
    const clean = (window.stripVisualTags ? window.stripVisualTags(text) : text).trim();
    if (!clean) return;

    // 2. Parse: Split by quotes to find dialogue
    // Regex captures delimiters: ["Narrator text ", "\"Dialogue\"", " more narrator"]
    const parts = clean.split(/([“"].*?[”"])/g).filter(p => p.trim());

    let lastNarratorText = "";

    for (const part of parts) {
      const isDialogue = /^["“]/.test(part.trim());
      // Remove quotes and markdown emphasis (* or _) so TTS doesn't read "asterisk"
      const content = part.replace(/["“”]/g, '').replace(/[*_]+/g, '').trim();
      if (!content) continue;

      let voiceId = 'narrator';
      
      if (isDialogue) {
        // 1. Try to detect speaker from the text immediately preceding the quote
        let detectedChar = null;
        
        if (lastNarratorText && activeCharacters.length > 0) {
          const lowerText = lastNarratorText.toLowerCase();
          let bestIndex = -1;

          // Find which active character was mentioned last before the quote
          for (const charName of activeCharacters) {
            const lowerChar = String(charName).toLowerCase();
            const idx = lowerText.lastIndexOf(lowerChar);
            
            if (idx > bestIndex) {
              bestIndex = idx;
              detectedChar = lowerChar;
            }
          }
        }

        if (detectedChar) {
          voiceId = detectedChar;
        } else if (activeCharacters.length === 1) {
          // 2. Fallback: If only 1 character is on stage, it's probably them.
          voiceId = activeCharacters[0].toLowerCase();
        } else {
          // 3. Last Resort: Generic
          // Attempt gender guess based on active characters
          let gender = 'unknown';
          if (window.botInfo?.characters && activeCharacters.length > 0) {
             let maleCount = 0;
             let femaleCount = 0;
             for (const char of activeCharacters) {
                 const realName = Object.keys(window.botInfo.characters).find(k => k.toLowerCase() === char);
                 if (realName) {
                     const p = window.botInfo.characters[realName] || "";
                     if (/\b(she|her|hers|woman|girl|female)\b/i.test(p)) femaleCount++;
                     else if (/\b(he|him|his|man|boy|male)\b/i.test(p)) maleCount++;
                 }
             }
             if (femaleCount > 0 && maleCount === 0) gender = 'female';
             if (maleCount > 0 && femaleCount === 0) gender = 'male';
          }

          if (gender === 'female') voiceId = 'character_generic_female';
          else if (gender === 'male') voiceId = 'character_generic_male';
          else voiceId = 'character_generic_male';
        }
      } else {
        lastNarratorText = content;
      }

      this.queue.push({ text: content, voiceId });
    }

    if (this.queue.length > 0) {
      this.isPlaying = true;
      this.updateBtn(true);
      this.processQueue();
    }
  }

  async processQueue() {
    if (this.queue.length === 0) {
      this.isPlaying = false;
      this.updateBtn(false);
      setDucking(false);
      return;
    }

    this.isPlaying = true;
    setDucking(true);
    const { text, voiceId } = this.queue.shift();

    let audioData = null;
    try {
      // Try Backend AI Generation first
      audioData = await window.api.generateSpeech(text, voiceId);
      
      if (audioData) {
        console.log(`[Voice] Playing AI audio for ${voiceId}`);
        
        if (window.setCharSpeaking) window.setCharSpeaking(voiceId, true);

        // Play AI Audio (Base64)
        await new Promise((resolve) => {
          // Support both full Data URIs (from Piper/New StreamElements) and legacy raw base64
          const src = audioData.startsWith('data:') ? audioData : `data:audio/mp3;base64,${audioData}`;
          this.currentAudio = new Audio(src);
          this.currentAudio.volume = voiceVolume;
          this.currentAudio.onended = () => {
            if (window.setCharSpeaking) window.setCharSpeaking(voiceId, false);
            resolve();
          };
          this.currentAudio.onerror = resolve;
          this.currentAudio.play().catch(resolve);
        });
      }
    } catch (e) {
      console.warn("AI Speech failed, falling back to Browser TTS:", e);
      audioData = null; // Ensure we trigger fallback
    }

    // Fallback: Browser TTS (if AI failed or returned null)
    if (!audioData) {
      console.log(`[Voice] Fallback to Browser TTS for ${voiceId}`);
      
      if (window.setCharSpeaking) window.setCharSpeaking(voiceId, true);

      await new Promise((resolve) => {
        const u = new SpeechSynthesisUtterance(text);
        u.volume = voiceVolume;
        const voices = window.speechSynthesis.getVoices();
        
        // Helper to find better voices (Google, Edge Natural, etc)
        const findVoice = (terms) => voices.find(v => terms.some(t => v.name.toLowerCase().includes(t)));

        // Simple mapping logic for browser voices
        const isMale = ['narrator', 'danny', 'jake', 'character_generic_male'].includes(voiceId) || voiceId.includes('male');
        if (isMale && !voiceId.includes('female')) {
          u.voice = findVoice(['google us english', 'microsoft david', 'male']) || voices[0];
          u.pitch = voiceId === 'narrator' ? 0.9 : 1.0;
          u.rate = voiceId === 'narrator' ? 0.85 : 0.9;
        } else {
          u.voice = findVoice(['google us english', 'microsoft zira', 'female']) || voices[0];
          u.pitch = 1.1;
          u.rate = 0.8;
        }
        
        u.onend = resolve;
        u.onend = () => { if (window.setCharSpeaking) window.setCharSpeaking(voiceId, false); resolve(); };
        u.onerror = resolve;
        window.speechSynthesis.speak(u);
      });
    }

    if (this.isPlaying) this.processQueue();
  }
}

window.voice = new VoiceEngine();
window.getCurrentMusicFilename = getCurrentMusicFilename;
window.playSfx = playSfx; // <-- EXPORT THE NEW FUNCTION

