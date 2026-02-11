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

  const ensureStyleOnce = (id, cssText) => {
    if (document.getElementById(id)) return;
    const style = document.createElement("style");
    style.id = id;
    style.textContent = cssText;
    document.head.appendChild(style);
  };

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
    ensureStyleOnce(
      "vn-visuals-style",
      `
      /* Stage */
      #vn-panel {
        aspect-ratio: 16 / 9 !important;
        height: auto !important;
        align-self: center !important;
        flex: none !important;
        max-height: none !important;
      }

      #vn-bg {
        width: 100%;
        height: 100%;
        object-fit: cover;
        position: absolute;
        top: 0; left: 0;
        z-index: 0;
      }

      .bg-overlay {
        width: 100%;
        height: 100%;
        object-fit: cover;
        position: absolute;
        top: 0; left: 0;
        z-index: 1;
        transition: opacity 1s ease-in-out;
      }

      /* Sprites */
      #sprite-container {
        position: absolute;
        bottom: 0; left: 0;
        width: 100%;
        height: 100%;
        display: flex;
        justify-content: center;
        align-items: flex-end;
        pointer-events: none;
        overflow: visible;
        z-index: 10;
      }

      .character-sprite {
        height: 100%;
        max-width: 60%;
        width: auto;
        object-fit: contain;
        object-position: bottom;

        transition: transform 0.5s ease-in-out, opacity 0.5s ease-in-out;
        will-change: transform, opacity;

        margin: 0 -2%;
        transform: translateY(20px);
        opacity: 0;

        filter: drop-shadow(0 0 15px rgba(0,0,0,0.8));
      }

      .character-sprite.active {
        transform: translateY(0);
        opacity: 1;
      }

      /* Reroll icon in chat */
      .msg-reroll-btn {
        background: none;
        border: none;
        color: #888;
        cursor: pointer;
        font-size: 18px;
        margin-left: 10px;
        padding: 0 5px;
        float: right;
      }
      .msg-reroll-btn:hover { color: #0078d4; }

      /* Splash */
      #splash-container {
        position: absolute;
        top: 0; left: 0;
        width: 100%;
        height: 100%;
        z-index: 20;
        pointer-events: none;
        opacity: 0;
        transition: opacity 1s ease-in-out;
      }
      #splash-container.active {
        opacity: 1;
        pointer-events: auto;
      }
      .splash-image {
        width: 100%;
        height: 100%;
        object-fit: cover;
      }

      /* Loading overlay */
      #loading-overlay {
        position: fixed;
        top: 0; left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0,0,0,0.8);
        z-index: 9999;
        display: flex;
        justify-content: center;
        align-items: center;
        color: white;
        font-size: 24px;
        font-family: sans-serif;
        opacity: 0;
        pointer-events: none;
        user-select: none;
        -webkit-user-select: none;
        transition: opacity 0.3s ease;
      }
      #loading-overlay * { pointer-events: none; }
      #loading-overlay.active { opacity: 1; }

      /* Keep modals above overlays */
      #setup-modal, #persona-modal, #options-modal, #summary-modal, #load-modal {
        z-index: 10001;
      }
      #voice-modal, #confirm-modal, #lorebook-modal {
        z-index: 10002;
      }

      /* Debug Overlay */
      #debug-overlay {
        position: absolute;
        top: 10px; right: 10px;
        width: 350px; max-height: 80%;
        overflow-y: auto;
        background: rgba(0, 0, 0, 0.85);
        color: #0f0;
        font-family: monospace; font-size: 11px;
        padding: 10px; border-radius: 4px;
        border: 1px solid #555;
        z-index: 9999; pointer-events: auto;
        display: none; white-space: pre-wrap;
      }
      #debug-overlay.active { display: block; }
      .debug-entry { margin-bottom: 4px; border-bottom: 1px solid #333; padding-bottom: 2px; }
      .debug-error { color: #f55; }
      .debug-success { color: #5f5; }
      .debug-warn { color: #fa0; }
      `
    );
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

    // Handle standard paths: "characters/..." or "sprites/..."
    if (parts[0] === "characters" || parts[0] === "sprites") {
      // sprites/Jessica/happy.png -> jessica
      if (parts.length >= 3) {
        return String(parts[1]).toLowerCase();
      }
      // sprites/Jessica.png -> jessica
      // sprites/jessica_happy.png -> jessica
      if (parts.length === 2) {
        const base = parts[1];
        return base.split(/[_\-\.]/)[0].toLowerCase();
      }
    }

    // "Jessica/happy.png"
    if (parts.length === 2) return String(parts[0]).toLowerCase();

    // heuristic: "jessica_happy.png" -> "jessica"
    const base = parts[parts.length - 1] || "";
    if (/\.(png|jpg|jpeg|webp|gif)$/i.test(base)) {
      return base.split(/[_\-\.]/)[0].toLowerCase();
    }

    return String(base).toLowerCase();
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
    hideSplash();
    const container = setupSpriteContainer();
    if (!container) return;

    const oldRects = getSpriteRects();

    const valid = filename; // assumes validateImage already used before calling
    const charId = getCharacterName(valid);
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
    if (charId.includes("natasha")) {
      img.style.height = "103%";
      img.style.maxWidth = "none";
    } else {
      img.style.height = "";
      img.style.maxWidth = "";
    }

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
  };

  function stripVisualTags(text) {
    if (!text) return "";
    let out = String(text);

    // Use fresh regexes
    out = out
      .replace(new RegExp(TAG_PATTERNS.bg.source, "gi"), "")
      .replace(new RegExp(TAG_PATTERNS.sprite.source, "gi"), "")
      .replace(new RegExp(TAG_PATTERNS.splash.source, "gi"), "")
      .replace(new RegExp(TAG_PATTERNS.music.source, "gi"), "")
      .replace(new RegExp(TAG_PATTERNS.hide.source, "gi"), "");

    return out.replace(/\n{3,}/g, "\n\n").trim();
  }

  function processVisualTags(text) {
    const input = String(text || "");
    const matches = [];
    const missing = [];
    let spriteUpdated = false;

    const collect = (type) => {
      const re = new RegExp(TAG_PATTERNS[type].source, "gi");
      for (const m of input.matchAll(re)) {
        matches.push({ type, value: (m[1] || "").trim(), index: m.index ?? 0 });
      }
    };

    collect("bg");
    collect("sprite");
    collect("splash");
    collect("music");
    collect("hide");

    matches.sort((a, b) => a.index - b.index);

    // If the message does NOT include a splash tag, auto-hide splash
    if (!matches.some((m) => m.type === "splash")) hideSplash();

    for (const m of matches) {
      let v = m.value;

      if (debugMode) appendDebug(`Processing tag [${m.type}]: "${v}"`);

      // Fix for LLM hallucinating descriptions inside tags (e.g. [SPRITE: "Name" looks happy])
      // If we find a quoted string at the start, use that and ignore the rest.
      const quoteMatch = v.match(/^\s*["']([^"']+)["']/);
      if (quoteMatch) {
        v = quoteMatch[1];
      }

      if (m.type === "bg") {
        if (!v) continue;
        const valid = validateImage(v, "backgrounds");
        if (valid) {
          if (debugMode) appendDebug(`  -> Setting BG: ${valid}`, "success");
          changeBackground(valid);
        } else {
          missing.push({ type: 'bg', value: v });
          if (debugMode) appendDebug(`  -> BG not found: ${v}`, "error");
        }
      }

      if (m.type === "sprite") {
        if (!v) continue;
        let valid = validateImage(v, "sprites");

        // Fallback: if not a direct file match, try treating it as a character name
        // This handles [SPRITE: Natasha] tags used for summoning
        if (!valid) {
          let name = v;
          let mood = "default";

          if (v.includes("/")) {
            const parts = v.split("/");
            mood = parts.pop();
            name = parts.join("/");
          } else if (v.includes("_")) {
            const parts = v.split("_");
            mood = parts.pop();
            name = parts.join("_");
          }

          name = getCharacterName(name);
          mood = cleanTagValue(mood);
          if (mood.toLowerCase() === name) mood = "default";

          const best = findBestSprite(name, mood);
          if (best) {
            valid = best;
            if (debugMode) appendDebug(`  -> Fallback found: ${best}`, "info");
          }
        }

        if (valid) {
          updateSprite(valid);
          spriteUpdated = true;
          if (debugMode) appendDebug(`  -> Sprite updated: ${valid}`, "success");
        }
        else {
          console.warn(`[Visual Novel] Invalid SPRITE tag ignored: ${v}`);
          if (debugMode) appendDebug(`  -> Sprite not found: ${v}`, "error");
        }
      }

      if (m.type === "splash") {
        if (!v) continue;
        const valid = validateImage(v, "splash");
        if (valid) showSplash(valid);
        else {
          console.warn(`[Visual Novel] Invalid SPLASH tag ignored: ${v}`);
          if (debugMode) appendDebug(`  -> Splash not found: ${v}`, "error");
        }
      }

      if (m.type === "music") {
        if (!v) continue;
        if (v.toLowerCase() === "stop") {
          playMusic(null);
          continue;
        }
        const valid = validateImage(v, "music");
        if (valid) playMusic(valid);
        else {
          console.warn(`[Visual Novel] Invalid MUSIC tag ignored: ${v}`);
          if (debugMode) appendDebug(`  -> Music not found: ${v}`, "error");
        }
      }

      if (m.type === "hide") {
        if (!v) continue;
        hideSprite(v);
        if (debugMode) appendDebug(`  -> Hiding: ${v}`);
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

  window.stripVisualTags = stripVisualTags;
  window.processVisualTags = processVisualTags;
  window.setVisualDebugMode = setVisualDebugMode;

  // If other scripts relied on activeSprites directly, this keeps compatibility:
  window.__activeSprites = activeSprites;
})();
