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
    align-items:center;
    margin-right:15px;
  `;

  const muteBtn = document.createElement('button');
  muteBtn.id = 'mute-btn';
  muteBtn.type = 'button';
  muteBtn.textContent = isMuted ? '🔇' : '🔊';
  muteBtn.style.cssText = `
    background:none;
    border:none;
    color:#ddd;
    font-size:16px;
    cursor:pointer;
    margin-right:8px;
    padding:0;
    line-height:1;
  `;

  const volumeSlider = document.createElement('input');
  volumeSlider.id = 'volume-slider';
  volumeSlider.type = 'range';
  volumeSlider.min = '0';
  volumeSlider.max = '1';
  volumeSlider.step = '0.05';
  volumeSlider.value = String(musicVolume);
  volumeSlider.style.cssText = `
    width:80px;
    cursor:pointer;
    accent-color:#0078d4;
  `;

  volumeContainer.appendChild(muteBtn);
  volumeContainer.appendChild(volumeSlider);

  // If an undo button exists, insert before it for consistent layout
  const undoBtn = document.getElementById('undo-btn');
  if (undoBtn) toolbar.insertBefore(volumeContainer, undoBtn);
  else toolbar.appendChild(volumeContainer);

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
    currentMusic.volume = musicVolume;
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
      fadeTo(audio, musicVolume, 1000);
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
      fadeTo(newMusic, musicVolume, LOOP_CROSSFADE_MS);
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
