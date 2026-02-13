/* ============================================================================
   visuals.js — Visual Novel Stage Manager
   - Background transitions
   - Multi-sprite staging
   - Splash overlay
   - Tag parsing + execution
   - Fuzzy manifest resolution

   Public API expected by renderer.js:
   setupVisuals()
   preloadImages()
   validateImage(filename, type)
   findBestSprite(characterName, mood)
   getCharacterName(filename)
   changeBackground(filename)
   updateSprite(filename)
   hideSprite(nameOrFilename)
   showSplash(filename)
   hideSplash()
   showThoughtBubble(charName, text)
   setDialogue(htmlContent)
   stripVisualTags(text)
   processVisualTags(text)
   setVisualDebugMode(enabled)

   Globals used by renderer.js:
   window.imageManifest
   window.getActiveSpriteNames
   ========================================================================== */

(() => {
  // ---------------------------
  // State
  // ---------------------------

  window.imageManifest = window.imageManifest || { backgrounds: {}, sprites: {}, splash: {}, music: {} };

  // Character-specific sprite scaling/positioning tweaks
  let spriteOverrides = {};

  function setSpriteOverrides(overrides) {
    if (!overrides) return;
    spriteOverrides = { ...spriteOverrides, ...overrides };
  }

  let debugMode = false;
  const debugLog = [];

  /** Map<charIdLower, HTMLImageElement> */
  const activeSprites = new Map();
  window.getActiveSpriteNames = () => Array.from(activeSprites.keys());

  // Cached lowercase keys for faster validateImage
  const manifestKeyCache = {
    backgrounds: null,
    sprites: null,
    splash: null,
    music: null,
  };

  const CACHE_TTL_MS = 10_000;
  let cacheStamp = 0;

  const refreshManifestKeyCacheIfNeeded = () => {
    const now = Date.now();
    if (now - cacheStamp < CACHE_TTL_MS) return;

    cacheStamp = now;
    (["backgrounds", "sprites", "splash", "music"]).forEach((type) => {
      const obj = window.imageManifest?.[type] || {};
      const keys = Object.keys(obj);
      manifestKeyCache[type] = keys.map((k) => ({
        key: k,
        lower: k.toLowerCase(),
        lowerNoExt: stripExt(k.toLowerCase()),
      }));
    });
  };

  // ---------------------------
  // DOM Helpers
  // ---------------------------

  const $ = (id) => document.getElementById(id);

  const normSlashes = (s) => String(s || "").replace(/\\/g, "/");

  const stripExt = (lowerPath) => {
    const i = lowerPath.lastIndexOf(".");
    return i > -1 ? lowerPath.slice(0, i) : lowerPath;
  };

  const cleanTagValue = (raw) => {
    let s = decodeURIComponent(String(raw || ""));
    s = s.replace(/^['"\\/]+|['"\\/]+$/g, "").trim();
    return normSlashes(s);
  };

  // ---------------------------
  // Debug Overlay
  // ---------------------------

  function setVisualDebugMode(enabled) {
    debugMode = enabled;
    if (enabled && debugLog.length === 0) {
      appendDebug("Visual Debug Mode Enabled", "success");
    } else {
      renderDebugLog();
    }
  }

  function appendDebug(msg, type = "info") {
    if (!debugMode) return;
    const entry = { time: new Date().toLocaleTimeString(), msg, type };
    debugLog.unshift(entry);
    if (debugLog.length > 50) debugLog.pop();
    renderDebugLog();
  }

  function renderDebugLog() {
    let overlay = $("debug-overlay");
    if (!overlay) {
      const panel = $("vn-panel");
      if (!panel) return;
      overlay = document.createElement("div");
      overlay.id = "debug-overlay";
      panel.appendChild(overlay);
    }
    
    if (debugMode) overlay.classList.add("active");
    else overlay.classList.remove("active");

    overlay.innerHTML = debugLog.map(e => 
      `<div class="debug-entry debug-${e.type}">[${e.time}] ${e.msg}</div>`
    ).join("");
  }

  // ---------------------------
  // CSS Injection (idempotent)
  // ---------------------------

  function setupVisuals() {
    // CSS is now loaded via styles.css
  }

  // ---------------------------
  // Preload
  // ---------------------------

  async function preloadImages() {
    const images = await window.api.getImages();
    const preloadList = (list) => {
      if (!Array.isArray(list)) return;
      list.forEach((file) => {
        const img = new Image();
        img.decoding = "async";
        img.src = `bot-resource://${file}`;
      });
    };

    // Backgrounds are cheap and frequently used
    preloadList(images.backgrounds);

    // Sprites are loaded on-demand to avoid memory spikes
    // preloadList(images.sprites);
  }

  // ---------------------------
  // Manifest Resolution
  // ---------------------------

  /**
   * Finds a valid manifest key from fuzzy input.
   * @param {string} filename  - tag value like "happy" or "Jessica/happy"
   * @param {"backgrounds"|"sprites"|"splash"|"music"} type
   * @returns {string|null} manifest key (relative path)
   */
  function validateImage(filename, type) {
    if (!window.imageManifest?.[type]) return null;

    refreshManifestKeyCacheIfNeeded();

    const clean = cleanTagValue(filename);
    if (!clean) return null;

    if (debugMode) appendDebug(`Validating [${type}]: "${clean}"`);

    // Fast exact match
    if (window.imageManifest[type][clean]) return clean;

    const lowerClean = clean.toLowerCase();
    const cleanNoExt = stripExt(lowerClean);

    const cached = manifestKeyCache[type] || [];
    let best = null;
    let bestScore = 0;

    for (const item of cached) {
      let score = 0;

      if (item.lower === lowerClean) score = 100;
      else if (item.lowerNoExt === lowerClean) score = 90;
      else if (item.lowerNoExt === cleanNoExt) score = 88;
      else if (item.lowerNoExt.endsWith(cleanNoExt)) {
        const prefixIndex = item.lowerNoExt.length - cleanNoExt.length;
        const charBefore = item.lowerNoExt[prefixIndex - 1];
        if (prefixIndex === 0 || charBefore === "/" || charBefore === "_" || charBefore === "-") {
          score = 80;
        }
      }

      // Group/item matching like "Jessica/happy"
      if (score === 0 && lowerClean.includes("/")) {
        const parts = lowerClean.split("/");
        if (parts.length === 2) {
          const [group, itemName] = parts;
          if (item.lower.includes(`/${group}/`) || item.lower.startsWith(`${group}/`)) {
            const keyFilename = item.lower.split("/").pop();
            const keyNoExt = stripExt(keyFilename);
            if (keyNoExt.includes(itemName)) score = 70;
          }
        }
      }

      if (score > bestScore) {
        bestScore = score;
        best = item.key;
      } else if (score === bestScore && score > 0 && best) {
        // Tie-breaker: prefer shorter paths
        if (item.key.length < best.length) best = item.key;
      }
    }

    if (debugMode) {
      if (best) appendDebug(`  -> Match: "${best}" (score: ${bestScore})`, "success");
      else appendDebug(`  -> No match found for "${clean}"`, "warn");
    }
    return best;
  }

  // ---------------------------
  // Character + Sprite selection
  // ---------------------------

    function getCharacterName(filename) {
    const clean = normSlashes(filename);
    const parts = clean.split("/").filter(Boolean);
    let charId = null;

    // Handle standard paths: "characters/..." or "sprites/..."
    if (parts[0] === "characters" || parts[0] === "sprites") {
      // sprites/Jessica/happy.png -> jessica
      if (parts.length >= 3) {
        charId = String(parts[1]).toLowerCase();
      }
      // sprites/Jessica.png -> jessica
      // sprites/jessica_happy.png -> jessica
      else if (parts.length === 2) {
        const base = parts[1];
        charId = base.split(/[_\-\.]/)[0].toLowerCase();
      }
    }

    // "Jessica/happy.png"
    else if (parts.length === 2) {
      charId = String(parts[0]).toLowerCase();
    }

    // heuristic: "jessica_happy.png" -> "jessica"
    else {
      const base = parts[parts.length - 1] || "";
      if (/\.(png|jpg|jpeg|webp|gif)$/i.test(base)) {
        charId = base.split(/[_\-\.]/)[0].toLowerCase();
      }
    }
    
    if (!charId) {
        const base = parts[parts.length - 1] || "";
        charId = base.toLowerCase();
    }

    console.log(`getCharacterName: filename=${filename}, charId=${charId}`);
    return charId;
  }

  function findBestSprite(characterName, mood) {
    refreshManifestKeyCacheIfNeeded();

    const charId = String(characterName || "").toLowerCase();
    const moodLower = String(mood || "").toLowerCase();
    if (!charId) return null;

    if (debugMode) appendDebug(`Finding sprite for "${charId}" (mood: "${moodLower}")`);

    const spriteManifest = window.imageManifest?.sprites || {};
    const files = Object.keys(spriteManifest).filter((file) => getCharacterName(file) === charId);
    if (files.length === 0) return null;

    let best = null;
    let bestScore = -1;

    for (const file of files) {
      const desc = String(spriteManifest[file] || "").toLowerCase();
      let score = 0;

      if (desc.includes(`(${moodLower})`)) score = 100;
      else if (moodLower && new RegExp(`\\b${escapeRegex(moodLower)}\\b`).test(desc)) score = 80;
      else if (moodLower && desc.includes(moodLower)) score = 50;
      else if (desc.includes("default")) score = 10;

      if (score > bestScore) {
        bestScore = score;
        best = file;
      }
    }

    if (debugMode && best) appendDebug(`  -> Best sprite: "${best}" (score: ${bestScore})`, "success");
    return best || files[0];
  }

  function escapeRegex(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // ---------------------------
  // Stage DOM
  // ---------------------------

  function setupSpriteContainer() {
    let container = $("sprite-container");
    if (container) return container;

    const oldSprite = $("vn-sprite");
    const panel = $("vn-panel");
    if (!panel) return null;

    container = document.createElement("div");
    container.id = "sprite-container";
    panel.appendChild(container);

    // If legacy sprite placeholder exists, hide it
    if (oldSprite) oldSprite.style.display = "none";

    return container;
  }

  // ---------------------------
  // Background + Splash
  // ---------------------------

  function changeBackground(filename) {
    console.log('[DEBUG] changeBackground called with:', filename);
    hideSplash();
    const bg = $("vn-bg");
    if (!bg) return;

    const newSrc = `bot-resource://${filename}`;
    if (bg.src === newSrc) return;

    const overlay = document.createElement("img");
    overlay.className = "bg-overlay";
    overlay.src = bg.src || "";
    bg.parentNode?.insertBefore(overlay, bg.nextSibling);

    bg.src = newSrc;

    requestAnimationFrame(() => (overlay.style.opacity = "0"));
    setTimeout(() => overlay.remove(), 1000);
  }

  function showSplash(filename) {
    let container = $("splash-container");
    if (!container) {
      const panel = $("vn-panel");
      if (!panel) return;

      container = document.createElement("div");
      container.id = "splash-container";

      const img = document.createElement("img");
      img.className = "splash-image";
      container.appendChild(img);

      panel.appendChild(container);
    }

    const img = container.querySelector("img");
    if (img) img.src = `bot-resource://${filename}`;

    void container.offsetWidth; // reflow
    container.classList.add("active");
  }

  function hideSplash() {
    const container = $("splash-container");
    if (container) container.classList.remove("active");
  }

  // ---------------------------
  // Sprite Layout + FLIP
  // ---------------------------

  function getSpriteRects() {
    const rects = new Map();
    activeSprites.forEach((img, id) => rects.set(id, img.getBoundingClientRect()));
    return rects;
  }

  function animateLayoutChanges(oldRects) {
    activeSprites.forEach((img, id) => {
      const oldRect = oldRects.get(id);
      if (!oldRect) return;

      const newRect = img.getBoundingClientRect();
      const dx = oldRect.left - newRect.left;

      if (dx === 0) return;

      // Invert
      img.style.transition = "none";
      img.style.transform = `translateX(${dx}px) translateY(0)`;
      void img.offsetWidth;

      // Play
      img.style.transition = "";
      img.style.transform = "";
    });
  }

  function adjustSpriteOverlap() {
    const container = $("sprite-container");
    if (!container) return;

    const sprites = Array.from(container.getElementsByClassName("character-sprite"));
    const activeCount = sprites.filter((s) => s.classList.contains("active")).length;

    let margin = -2;
    if (activeCount > 2) margin = -2 - (activeCount - 2) * 2;

    sprites.forEach((s) => {
      s.style.marginLeft = `${margin}%`;
      s.style.marginRight = `${margin}%`;
    });
  }

  function updateSprite(filename) {
    console.log('[DEBUG] updateSprite called with:', filename);
    hideSplash();
    const container = setupSpriteContainer();
    if (!container) return;

    const oldRects = getSpriteRects();

    const valid = filename; // assumes validateImage already used before calling
    const charId = getCharacterName(valid);
    console.log(`updateSprite: charId=${charId}`);
    let img = activeSprites.get(charId);

    if (!img) {
      img = document.createElement("img");
      img.className = "character-sprite";
      img.decoding = "async";
      img.src = `bot-resource://${valid}`;
      container.appendChild(img);
      activeSprites.set(charId, img);

      void img.offsetWidth;
      img.classList.add("active");
    } else {
      const nextSrc = `bot-resource://${valid}`;
      if (img.src !== nextSrc) img.src = nextSrc;
      img.classList.add("active");
    }

    // Character-specific height tweak
    const override = spriteOverrides[charId] || {};
    img.style.height = override.height || "";
    img.style.maxWidth = override.maxWidth || "";

    adjustSpriteOverlap();
    animateLayoutChanges(oldRects);
  }

  function hideSprite(nameOrFilename) {
    hideSplash();

    const raw = String(nameOrFilename || "");
    const lower = raw.toLowerCase();

    // Clear-all
    if (lower === "all" || lower === "everyone") {
      activeSprites.forEach((img) => {
        img.classList.remove("active");
        setTimeout(() => img.remove(), 500);
        img.src = "";
      });
      activeSprites.clear();
      return;
    }

    const oldRects = getSpriteRects();

    // Direct key match first
    let charId = getCharacterName(raw);
    let img = activeSprites.get(charId);

    // Fuzzy: if user gives "Jessica Smith"
    if (!img) {
      for (const [key, val] of activeSprites.entries()) {
        if (lower.includes(key) || (key.includes(lower) && lower.length >= 3)) {
          charId = key;
          img = val;
          break;
        }
      }
    }

    if (!img) return;

    img.classList.remove("active");
    activeSprites.delete(charId);

    // IMPORTANT: animate remaining sprites now that layout changes
    adjustSpriteOverlap();
    requestAnimationFrame(() => animateLayoutChanges(oldRects));

    setTimeout(() => {
      img.remove();
      img.src = "";
    }, 500);
  }

  function setCharSpeaking(charName, isSpeaking) {
    const name = String(charName || "").toLowerCase();
    // Find sprite by fuzzy match
    for (const [key, img] of activeSprites.entries()) {
      if (key.includes(name) || name.includes(key)) {
        if (isSpeaking) {
          img.classList.add("speaking");
        } else {
          img.classList.remove("speaking");
        }
      }
    }
  }

  function showThoughtBubble(charName, text) {
    // 1. Remove existing bubbles
    const existing = document.querySelectorAll('.thought-bubble');
    existing.forEach(el => el.remove());

    if (!text) return;

    // 2. Find the sprite
    const charId = String(charName).toLowerCase();
    let spriteImg = activeSprites.get(charId);
    
    // Fallback fuzzy search if direct key fails
    if (!spriteImg) {
        for (const [key, img] of activeSprites.entries()) {
            if (key.includes(charId) || charId.includes(key)) {
                spriteImg = img;
                break;
            }
        }
    }

    if (!spriteImg) {
        console.warn(`[Visuals] Could not find sprite for thought bubble: ${charName}`);
        return;
    }

    // 3. Create Bubble
    const bubble = document.createElement('div');
    bubble.className = 'thought-bubble';
    bubble.textContent = text;

    const panel = $('vn-panel');
    if (!panel) return;
    panel.appendChild(bubble);

    // 4. Position it relative to the sprite
    // We use the sprite's position on screen to place the bubble near their "head"
    const spriteRect = spriteImg.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();

    // Calculate relative position (approximate head height at 15% from top of sprite)
    let left = (spriteRect.left - panelRect.left) + (spriteRect.width * 0.8); 
    let top = (spriteRect.top - panelRect.top) + (spriteRect.height * 0.15);

    bubble.style.left = `${left}px`;
    bubble.style.top = `${top}px`;

    // 5. Animate & Auto-dismiss
    requestAnimationFrame(() => bubble.classList.add('active'));
    
    // Dismiss on click-away (clicking outside the bubble)
    const dismiss = (e) => {
        if (bubble.contains(e.target)) return; // Allow interaction inside bubble (e.g. text select)

        bubble.classList.remove('active');
        setTimeout(() => bubble.remove(), 500);
        document.removeEventListener('click', dismiss);
    };

    // Delay adding listener to prevent immediate dismissal from the triggering click
    setTimeout(() => {
        document.addEventListener('click', dismiss);
    }, 100);
  }

  function setDialogue(htmlContent, isTyping = false) {
    let box = $("vn-dialogue-box");
    if (!box) {
      const panel = $("vn-panel");
      if (!panel) return;
      box = document.createElement("div");
      box.id = "vn-dialogue-box";
      panel.appendChild(box);
    }

    if (!htmlContent) {
      box.classList.remove("active");
      box.classList.remove("typing");
    } else {
      box.innerHTML = htmlContent;
      box.classList.add("active");
      if (isTyping) box.classList.add("typing");
      else box.classList.remove("typing");
      
      box.scrollTop = box.scrollHeight;
    }
  }

  // ---------------------------
  // FX
  // ---------------------------

  function triggerEffect(name) {
    const panel = $("vn-panel");
    if (!panel) return;
    const effect = String(name).toLowerCase().trim();

    if (effect === "shake") {
      panel.classList.remove("fx-shake");
      void panel.offsetWidth; // trigger reflow
      panel.classList.add("fx-shake");
      if (debugMode) appendDebug("FX: Shake triggered", "info");
    } else if (effect === "flash") {
      const overlay = document.createElement("div");
      overlay.className = "fx-flash-overlay";
      panel.appendChild(overlay);
      setTimeout(() => overlay.remove(), 600);
      if (debugMode) appendDebug("FX: Flash triggered", "info");
    }
  }

  // ---------------------------
  // Tag Parsing
  // ---------------------------

  // NOTE: do NOT reuse global /g regex objects across calls with matchAll() without resetting lastIndex.
  // We keep the patterns as sources and compile fresh each call.
  const TAG_PATTERNS = {
    bg: /\[BG:\s*([^\]]+)\]/gi,
    sprite: /\[SPRITE:\s*([^\]]+)\]/gi,
    splash: /\[SPLASH:\s*([^\]]+)\]/gi,
    music: /\[MUSIC:\s*([^\]]+)\]/gi,
    hide: /\[HIDE:\s*([^\]]+)\]/gi,
    fx: /\[FX:\s*([^\]]+)\]/gi,
    sfx: /\[SFX:\s*([^\]]+)\]/gi,
    camera: /\[CAMERA:\s*([^,]+),\s*([^\]]+)\]/gi,
    // Inventory Tags
    take: /\[TAKE:\s*([^\]]+)\]/gi,
    drop: /\[DROP:\s*([^\]]+)\]/gi,
    add_object: /\[ADD_OBJECT:\s*([^\]]+)\]/gi,
  };

  function stripVisualTags(text) {
    if (!text) return "";
    let out = String(text);

    // Use fresh regexes, now that TAG_PATTERNS is more complex
    out = Object.values(TAG_PATTERNS).reduce(
        (acc, regex) => acc.replace(new RegExp(regex.source, "gi"), ""),
        out
    );

    return out.replace(/\n{3,}/g, "\n\n").trim();
  }

  function processVisualTags(text, options = {}) {
    const input = String(text || "");
    const { store, handlers } = options;
    const matches = [];
    const missing = [];
    let spriteUpdated = false;

    const collect = (type) => {
      if (type === 'camera') {
        const re = new RegExp(TAG_PATTERNS.camera.source, "gi");
        for (const m of input.matchAll(re)) {
          matches.push({ type, value: (m[1] || "").trim(), target: (m[2] || "").trim(), index: m.index ?? 0 });
        }
        return;
      }
      const re = new RegExp(TAG_PATTERNS[type].source, "gi");
      for (const m of input.matchAll(re)) {
        matches.push({ type, value: (m[1] || "").trim(), index: m.index ?? 0 });
      }
    };

    Object.keys(TAG_PATTERNS).forEach(collect);

    matches.sort((a, b) => a.index - b.index);
    activeSprites.forEach(img => img.classList.remove('camera-zoom-in'));
    if (!matches.some((m) => m.type === "splash")) hideSplash();

    for (const m of matches) {
      let v = m.value;
      if (debugMode) appendDebug(`Processing tag [${m.type}]: "${v}"`);
      
      const quoteMatch = v.match(/^\s*["']([^"']+)["']/);
      if (quoteMatch) v = quoteMatch[1];
      
      const cleanedValue = cleanTagValue(v);

      switch (m.type) {
        case "bg": {
            const valid = validateImage(cleanedValue, "backgrounds");
            if (valid && handlers?.onBg) handlers.onBg(valid);
            else if (valid) changeBackground(valid);
            else missing.push({ type: 'bg', value: cleanedValue });
            break;
        }
        case "sprite": {
            let valid = validateImage(cleanedValue, "sprites");
            if (!valid) {
                const best = findBestSprite(getCharacterName(cleanedValue), "default");
                if (best) valid = best;
            }
            if (valid) {
                if (handlers?.onSprite) handlers.onSprite(valid);
                else updateSprite(valid);
                spriteUpdated = true;
            }
            break;
        }
        case "splash": {
            const valid = validateImage(cleanedValue, "splash");
            if (valid) {
                if (handlers?.onSplash) handlers.onSplash(valid);
                else showSplash(valid);
            } else {
                // If invalid or empty, treat as clearing splash
                if (handlers?.onSplash) handlers.onSplash(null);
                else hideSplash();
            }
            break;
        }
        case "music": {
            if (cleanedValue.toLowerCase() === "stop") {
                if (handlers?.onMusic) handlers.onMusic(null); else playMusic(null);
            } else {
                const valid = validateImage(cleanedValue, "music");
                if (valid && handlers?.onMusic) handlers.onMusic(valid); else if (valid) playMusic(valid);
            }
            break;
        }
        case "hide":
            hideSprite(cleanedValue);
            break;
        case "fx":
            triggerEffect(cleanedValue);
            break;
        case "sfx":
            if (window.playSfx) window.playSfx(cleanedValue);
            break;
        case "camera": {
            const action = cleanedValue.toLowerCase();
            const targetName = m.target.toLowerCase();
            if (action === 'zoom_in') {
                const spriteImg = activeSprites.get(targetName);
                if (spriteImg) spriteImg.classList.add('camera-zoom-in');
            }
            break;
        }
        // Inventory actions
        case "take":
            if (store && store.takeObject) store.takeObject(cleanedValue);
            break;
        case "drop": // This will remove from inventory and add to scene
            if (store && store.addObjectToScene) {
                // This requires a new action to remove from inventory. For now, let's assume drop just adds it to the scene.
                store.addObjectToScene(cleanedValue);
            }
            break;
        case "add_object":
            if (store && store.addObjectToScene) store.addObjectToScene(cleanedValue);
            break;
      }
    }

    return { text: stripVisualTags(input), stats: { spriteUpdated }, missing };
  }

  // ---------------------------
  // Expose API (keep existing names)
  // ---------------------------

  window.setupVisuals = setupVisuals;
  window.preloadImages = preloadImages;

  window.validateImage = validateImage;
  window.findBestSprite = findBestSprite;
  window.getCharacterName = getCharacterName;

  window.changeBackground = changeBackground;

  window.updateSprite = updateSprite;
  window.hideSprite = hideSprite;

  window.showSplash = showSplash;
  window.hideSplash = hideSplash;
  window.showThoughtBubble = showThoughtBubble;
  window.setDialogue = setDialogue;

  window.triggerEffect = triggerEffect;
  window.setCharSpeaking = setCharSpeaking;
  window.stripVisualTags = stripVisualTags;
  window.processVisualTags = processVisualTags;
  window.setVisualDebugMode = setVisualDebugMode;
  window.setSpriteOverrides = setSpriteOverrides;

  // If other scripts relied on activeSprites directly, this keeps compatibility:
  window.__activeSprites = activeSprites;
})();
