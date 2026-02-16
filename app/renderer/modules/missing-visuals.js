'use strict';

export function createMissingVisualsController({
  windowObj,
  useStore,
  normalizeText,
  appendMessage,
  saveCurrentChatState,
}) {
  const pendingBgGenerations = new Map();
  let latestBgRequestTime = 0;

  function pickFallbackBackgroundForRequest(requestedName) {
    const bgs = windowObj.imageManifest?.backgrounds ? Object.keys(windowObj.imageManifest.backgrounds) : [];
    if (!bgs.length) return null;

    const normReq = normalizeText(String(requestedName || ''));
    const tokens = normReq.split(/\s+/).filter((t) => t.length > 2);

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
      const generic = bgs.find((bg) => {
        const n = bg.toLowerCase();
        return n.includes('default') || n.includes('main') || n.includes('common') || n.includes('outside') || n.includes('living');
      });
      return generic || bgs[0];
    }

    return best;
  }

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
    windowObj.__pushDirectorDebugEvent('bg-background-generation-started', { requested, requestTime });
    if (windowObj.setBackgroundGenerationStatus) windowObj.setBackgroundGenerationStatus('retrying', requested);

    try {
      const delaysMs = [1200, 2000, 3000, 4500, 6000, 8000];
      for (let i = 0; i < delaysMs.length; i++) {
        if (latestBgRequestTime > requestTime) {
          windowObj.__pushDirectorDebugEvent('bg-background-generation-cancelled-superseded', { requested, requestTime });
          return;
        }

        await sleep(delaysMs[i]);
        windowObj.__pushDirectorDebugEvent('bg-background-generation-attempt', { requested, attempt: i + 1 });
        if (windowObj.setBackgroundGenerationStatus) windowObj.setBackgroundGenerationStatus('retrying', `${requested} #${i + 1}`);

        let newPath = null;
        try {
          newPath = await windowObj.api.generateImage(expandedPrompt || requested, 'bg');
        } catch (e) {
          windowObj.__pushDirectorDebugEvent('bg-background-generation-attempt-error', {
            requested,
            attempt: i + 1,
            code: String(e?.code || ''),
            error: String(e?.message || e),
          });
          if (isFatalImageGenError(e)) {
            windowObj.__pushDirectorDebugEvent('bg-background-generation-fatal', {
              requested,
              code: String(e?.code || ''),
              error: String(e?.message || e),
            });
            if (windowObj.setBackgroundGenerationStatus) windowObj.setBackgroundGenerationStatus('error', String(e?.message || 'image generation not configured'));
            if (notice) notice.textContent = `⚠️ ${String(e?.message || 'Image generation unavailable')}`;
            return;
          }
        }

        if (!newPath) continue;
        if (latestBgRequestTime > requestTime) {
          windowObj.__pushDirectorDebugEvent('bg-background-generation-late-stale', { requested, newPath });
          return;
        }

        useStore.getState().setBackground(newPath);
        await saveCurrentChatState();
        windowObj.__pushDirectorDebugEvent('bg-background-generation-success', { requested, newPath, attempt: i + 1 });
        if (windowObj.setBackgroundGenerationStatus) windowObj.setBackgroundGenerationStatus('ready', 'generated');
        if (notice) {
          notice.textContent = `✅ Background generated: "${newPath}"`;
          setTimeout(() => { if (notice?.parentNode) notice.style.display = 'none'; }, 1800);
        }
        return;
      }

      windowObj.__pushDirectorDebugEvent('bg-background-generation-exhausted', { requested });
      if (windowObj.setBackgroundGenerationStatus) windowObj.setBackgroundGenerationStatus('error', 'generation unavailable');
      if (notice) {
        notice.textContent = `⚠️ Still using fallback for "${requested}" (generation unavailable right now).`;
      }
    } finally {
      pendingBgGenerations.delete(key);
    }
  }

  async function handleMissingVisuals(missing) {
    if (!missing || !missing.length) return;
    windowObj.__pushDirectorDebugEvent('missing-visuals', { missing });

    for (const m of missing) {
      if (m.type === 'bg') {
        const requestTime = Date.now();
        latestBgRequestTime = requestTime;
        windowObj.__pushDirectorDebugEvent('bg-generate-start', { requested: m.value, requestTime });
        if (windowObj.setBackgroundGenerationStatus) windowObj.setBackgroundGenerationStatus('generating', m.value);
        const notice = appendMessage('system', `🎨 Generating background: "${m.value}"...`, undefined);
        if (windowObj.setSpinner) windowObj.setSpinner(true);
        try {
          const expandedPrompt = await windowObj.api.expandImagePrompt(m.value);
          console.log(`[Art Director] Expanded "${m.value}" -> "${expandedPrompt}"`);
          windowObj.__pushDirectorDebugEvent('bg-prompt-expanded', { requested: m.value, expandedPrompt });

          const newPath = await windowObj.api.generateImage(expandedPrompt || m.value, 'bg');

          if (latestBgRequestTime > requestTime) {
            console.log(`[Art Director] Discarding stale background result for "${m.value}"`);
            windowObj.__pushDirectorDebugEvent('bg-generate-stale', { requested: m.value, requestTime, newPath });
            if (notice) notice.style.display = 'none';
            continue;
          }

          if (newPath) {
            useStore.getState().setBackground(newPath);
            await saveCurrentChatState();
            windowObj.__pushDirectorDebugEvent('bg-generate-success', { requested: m.value, newPath });
            if (windowObj.setBackgroundGenerationStatus) windowObj.setBackgroundGenerationStatus('ready', 'generated');
            if (notice) notice.style.display = 'none';
          } else {
            windowObj.__pushDirectorDebugEvent('bg-generate-empty', { requested: m.value });
            const fallbackBg = pickFallbackBackgroundForRequest(m.value);
            if (fallbackBg) {
              useStore.getState().setBackground(fallbackBg);
              await saveCurrentChatState();
              windowObj.__pushDirectorDebugEvent('bg-fallback-used', { requested: m.value, fallbackBg });
              if (windowObj.setBackgroundGenerationStatus) windowObj.setBackgroundGenerationStatus('fallback', m.value);
              if (notice) notice.textContent = `⏳ Generating "${m.value}" in background. Temporary fallback: "${fallbackBg}"`;
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
          windowObj.__pushDirectorDebugEvent('bg-generate-error', {
            requested: m.value,
            code: String(e?.code || ''),
            error: String(e?.message || e),
          });
          const fallbackBg = pickFallbackBackgroundForRequest(m.value);
          if (fallbackBg) {
            useStore.getState().setBackground(fallbackBg);
            await saveCurrentChatState();
            windowObj.__pushDirectorDebugEvent('bg-fallback-used-after-error', { requested: m.value, fallbackBg });
            if (windowObj.setBackgroundGenerationStatus) windowObj.setBackgroundGenerationStatus('fallback', m.value);
            if (isFatalImageGenError(e)) {
              if (windowObj.setBackgroundGenerationStatus) windowObj.setBackgroundGenerationStatus('error', String(e?.message || 'generation unavailable'));
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
            if (windowObj.setBackgroundGenerationStatus) windowObj.setBackgroundGenerationStatus('error', 'no fallback');
            notice.textContent = `⚠️ Failed to generate background: "${m.value}" (${String(e?.message || 'unknown error')})`;
          }
        } finally {
          if (windowObj.setSpinner) windowObj.setSpinner(false);
        }
      } else if (m.type === 'sprite_smart_lookup') {
        try {
          const charName = m.charName;
          const allSprites = windowObj.imageManifest?.sprites ? Object.keys(windowObj.imageManifest.sprites) : [];
          const charFiles = allSprites.filter((f) => windowObj.getCharacterName(f) === charName);

          if (charFiles.length > 0) {
            const bestMatch = await windowObj.api.findClosestSprite(m.value, charFiles);

            if (bestMatch && bestMatch !== 'none') {
              console.log(`[Casting Director] Mapped "${m.value}" -> "${bestMatch}"`);
              windowObj.updateSprite(bestMatch);
              useStore.getState().setCharacterVisibility(charName, true);
              const mood = bestMatch.split(/[/\\]/).pop().split('.')[0].replace(new RegExp(`^${charName}[_-]`, 'i'), '');
              useStore.getState().setCharacterEmotion(charName, mood || 'default');
              await saveCurrentChatState();
            } else {
              const fallback = windowObj.findBestSprite(charName, 'default');
              if (fallback) {
                console.warn(`[Casting Director] No close match for "${m.value}". Falling back to default: "${fallback}"`);
                windowObj.updateSprite(fallback);
                useStore.getState().setCharacterVisibility(charName, true);
                useStore.getState().setCharacterEmotion(charName, 'default');
                await saveCurrentChatState();
              } else {
                console.warn(`[Casting Director] No good match found for "${m.value}" and no default sprite available for "${charName}"`);
              }
            }
          }
        } catch (e) {
          console.warn('Smart sprite lookup failed', e);
        }
      }
    }
  }

  return { handleMissingVisuals };
}
