/* ============================================================================
   AURA LORE BOOK SYSTEM v18 (LT-Aware Unabridged)
   Author: Icehellionx
   //#region HEADER
   ==========================================================================
   This script provides a powerful, multi-layered lorebook system. It includes:
   1. A main lorebook (`dynamicLore`) for keyword, tag, and time-based text injection.
   2. An integrated emotion detection system (AURA) to gate entries by user emotion.
   3. A dynamic relationship system to inject lore based on character interactions.

   --- AUTHOR CHEAT-SHEET (for `dynamicLore` entries) ---

   Core Properties:
     - keywords: User words/phrases. Supports "word*", and 'char.entityName' expansion.
     - tag: Internal label for this entry (e.g., "base_open"). Not matched against text.
     - triggers: List of tags to emit when this entry fires.
     - personality / scenario: The text to inject.

   Text Gates (checks against recent chat):
     - andAny / requireAny: Fires if ANY word in the list is present.
     - andAll / requireAll: Fires if ALL words in the list are present.
     - notAny / requireNone / block: Blocks if ANY word in the list is present.
     - notAll: Blocks only if ALL words in the list are present.

   Emotion Gates (requires AURA models):
     - andAnyEmotion: Fires if ANY listed emotion is active.
     - andAllEmotion: Fires if ALL listed emotions are active.
     - notAnyEmotion: Blocks if ANY listed emotion is active.
     - notAllEmotion: Blocks if ALL listed emotions are active.

   Tag Gates (checks against other triggered entries):
     - andAnyTags, andAllTags, notAnyTags, notAllTags

   Special Gates & Modifiers:
     - 'prev.': Prefix a text gate (e.g., 'prev.keywords') to check the PREVIOUS message only.
     - 'char.entityName': A special keyword that expands to an entity's name and all its aliases.
     - minMessages / maxMessages: Gates for message count.
     - nameBlock: ["name"]: Blocks if the active character's name is in the list.
     - probability: 0.0 to 1.0 (or "0%" to "100%") chance for an entry to fire.
     - group: "group_name": Makes entries in the same group mutually exclusive.

   Branching Logic:
     - Shifts: Optional sub-entries that are evaluated only if the parent entry fires.

   --- DYNAMIC RELATIONSHIPS ---
   Defined in `ENTITY_DB` and `RELATIONSHIP_DB`. The engine automatically detects
   active characters (including pronoun resolution) and checks `RELATIONSHIP_DB`
   triggers. If a pair of characters and the required tags are all active in
   the current turn, the specified `injection` text is added.
   ========================================================================== */


/* ============================================================================
   [SECTION] GLOBAL KNOBS
   SAFE TO EDIT: Yes
   ========================================================================== */
//#region GLOBAL_KNOBS
let DEBUG = 0;     // 1 -> emit [DBG] lines inline in personality
let APPLY_LIMIT = 1;     // cap applied entries per turn; higher priorities win

/* ============================================================================
   [SECTION] DYNAMIC RELATIONSHIP
   SAFE TO EDIT: Yes
   ========================================================================== */
//#region DYNAMIC_RELATIONSHIP
// 1. ENTITY DEFINITIONS (Who exists in the story?)
// Keys should be lower case for matching.
const ENTITY_DB = {
};

// 2. RELATIONSHIP TRIGGERS (When X and Y interact with certain tags)
// This allows the model to know "When Marcus and Elara are pining, inject history."
const RELATIONSHIP_DB = [
];

// 3. PRONOUN MAP (Helps resolve who is being talked about)
const PRONOUN_MAP = {
  "he": "M", "him": "M", "his": "M",
  "she": "F", "her": "F", "hers": "F",
  "it": "N", "they": "N"
};



/* ============================================================================
   [SECTION] AUTHOR ENTRIES
   SAFE TO EDIT: Yes
   ========================================================================== */
//#region AUTHOR_ENTRIES_LOREBOOK

// Initialize the DYNAMIC_LORE array
const DYNAMIC_LORE = [
];

// Helper function to register entries
// This makes it easy to add, edit, or comment out individual entries
function addEntry(entry) {
  DYNAMIC_LORE.push(entry);
  return entry; // for chaining if needed
}

// ============================================================================
// [SECTION] EMOTION OVERRIDES (FULL MATRIX LOGIC)
// ============================================================================

// ----------------------------------------------------------------------------
// 1. JOY
// Logic: High energy. Negatives (Jealsousy/Conflict) must be converted to Playfulness.
// ----------------------------------------------------------------------------
addEntry({
  tag: "pulse_joy_tree",
  andAnyEmotion: ["joy"],
  priority: 5,
  
});

//#endregion AUTHOR_ENTRIES_LOREBOOK
/* ============================================================================
   [SECTION] OUTPUT GUARDS
   SAFE TO EDIT: Yes (keep behavior)
   ========================================================================== */
//#region OUTPUT_GUARDS
context.character = context.character || {};
context.character.personality = (typeof context.character.personality === "string")
  ? context.character.personality : "";
context.character.scenario = (typeof context.character.scenario === "string")
  ? context.character.scenario : "";
context.character.example_dialogs = (typeof context.character.example_dialogs === "string")
  ? context.character.example_dialogs : "";

/* ============================================================================
   [SECTION] INPUT NORMALIZATION
   SAFE TO EDIT: Yes (tune WINDOW_DEPTH; keep normalization rules)
   ========================================================================== */
//#region INPUT_NORMALIZATION
// --- How many recent messages to scan together (tune as needed) ---
const WINDOW_DEPTH = ((n) => {
  n = parseInt(n, 10);
  if (isNaN(n)) n = 5;
  if (n < 1) n = 1;
  if (n > 20) n = 20; // safety cap
  return n;
})(typeof globalThis.WINDOW_DEPTH === 'number' ? globalThis.WINDOW_DEPTH : 5);

// --- Utilities ---
function _toString(x) { return (x == null ? "" : String(x)); }
function _normalizeText(s) {
  s = _toString(s).toLowerCase();
  s = s.replace(/[^a-z0-9_\s-]/g, " "); // keep letters/digits/underscore/hyphen/space
  s = s.replace(/[-_]+/g, " ");         // treat hyphen/underscore as spaces
  s = s.replace(/\s+/g, " ").trim();    // collapse spaces
  return s;
}

// --- Build multi-message window ---
const _lmArr = (context && context.chat && context.chat.last_messages && typeof context.chat.last_messages.length === "number")
  ? context.chat.last_messages : null;

let _joinedWindow = "";
let _rawLastSingle = "";
let _rawPrevSingle = "";

if (_lmArr && _lmArr.length > 0) {
  const startIdx = Math.max(0, _lmArr.length - WINDOW_DEPTH);
  const segs = [];
  for (const item of _lmArr.slice(startIdx)) {
    const msg = (item && typeof item.message === "string") ? item.message : _toString(item);
    segs.push(_toString(msg));
  }
  _joinedWindow = segs.join(" ");
  const lastItem = _lmArr[_lmArr.length - 1];
  _rawLastSingle = _toString((lastItem && typeof lastItem.message === "string") ? lastItem.message : lastItem);
  if (_lmArr.length > 1) {
    const prevItem = _lmArr[_lmArr.length - 2];
    _rawPrevSingle = _toString((prevItem && typeof prevItem.message === "string") ? prevItem.message : prevItem);
  }
} else {
  const _lastMsgA = (context && context.chat && typeof context.chat.lastMessage === "string") ? context.chat.lastMessage : "";
  const _lastMsgB = (context && context.chat && typeof context.chat.last_message === "string") ? context.chat.last_message : "";
  _rawLastSingle = _toString(_lastMsgA || _lastMsgB);
  _joinedWindow = _rawLastSingle;
}

// --- Public struct + haystacks ---
const CHAT_WINDOW = {
  depth: WINDOW_DEPTH,
  count_available: (_lmArr && _lmArr.length) ? _lmArr.length : (_rawLastSingle ? 1 : 0),
  text_joined: _joinedWindow,
  text_last_only: _rawLastSingle,
  text_prev_only: _rawPrevSingle,
  text_joined_norm: _normalizeText(_joinedWindow),
  text_last_only_norm: _normalizeText(_rawLastSingle),
  text_prev_only_norm: _normalizeText(_rawPrevSingle)
};
const _currentHaystack = " " + CHAT_WINDOW.text_joined_norm + " ";
const _previousHaystack = " " + CHAT_WINDOW.text_prev_only_norm + " ";

// --- Message count ---
let messageCount = 0;
if (_lmArr && typeof _lmArr.length === "number") {
  messageCount = _lmArr.length;
} else if (context && context.chat && typeof context.chat.message_count === "number") {
  messageCount = context.chat.message_count;
} else if (typeof context_chat_message_count === "number") {
  messageCount = context_chat_message_count;
}

// --- Active character name ---
const activeName = _normalizeText(
  (context && context.character && typeof context.character.name === "string")
    ? context.character.name
    : ""
);

/* ============================================================================
   [SECTION] AURA EMOTION PROCESSING
   DO NOT EDIT: Behavior-sensitive
   ========================================================================== */
(function () {
  "use strict";

  /* ============================================================================
     [SECTION] UTILITIES
     SAFE TO EDIT: Yes
     ========================================================================== */
  //#region UTILITIES

  // --- Regex Cache (Major Optimization) ---
  const _regexCache = new Map();
  function getCachedRegex(pattern, flags) {
    const key = pattern + "||" + (flags || "");
    if (_regexCache.has(key)) return _regexCache.get(key);
    try {
      const re = new RegExp(pattern, flags);
      _regexCache.set(key, re);
      return re;
    } catch (e) {
      return null;
    }
  }

  function dbg(msg) {
    if (typeof DEBUG !== "undefined" && DEBUG) {
      console.log(`[AURA-LORE] ${String(msg)}`);
    }
  }

  // --- Array & Number Helpers ---
  function toArray(x) {
    if (Array.isArray(x)) return x;
    return x == null ? [] : [x];
  }

  function clamp01(v) {
    const n = +v;
    return !isFinite(n) ? 0 : (n < 0 ? 0 : (n > 1 ? 1 : n));
  }

  function parseProbability(v) {
    if (v == null) return 1;
    if (typeof v === "number") return clamp01(v);
    const s = String(v).trim();
    if (s.endsWith("%")) {
      const n = parseFloat(s);
      return isFinite(n) ? clamp01(n / 100) : 1;
    }
    const n = parseFloat(s);
    return isFinite(n) ? clamp01(n) : 1;
  }

  // --- Entry Property Getters ---
  function getPriority(e) {
    if (!e || !isFinite(e.priority)) return 3;
    const p = +e.priority;
    return p < 1 ? 1 : (p > 5 ? 5 : p);
  }
  function getMin(e) { return (e && isFinite(e.minMessages)) ? +e.minMessages : -Infinity; }
  function getMax(e) { return (e && isFinite(e.maxMessages)) ? +e.maxMessages : Infinity; }
  function getKeywords(e) { return (e && Array.isArray(e.keywords)) ? e.keywords : []; }
  function getTriggers(e) { return (e && Array.isArray(e.triggers)) ? e.triggers : []; }

  function getBlocklist(e) {
    if (!e) return [];
    if (Array.isArray(e.block)) return e.block;
    if (Array.isArray(e.Block)) return e.Block;
    return [];
  }

  function getNameBlock(e) { return (e && Array.isArray(e.nameBlock)) ? e.nameBlock : []; }

  function _isNameBlocked(e) {
    if (!activeName) return false;
    const nb = getNameBlock(e);
    if (nb.length === 0) return false;

    for (let i = 0; i < nb.length; i++) {
      const n = _normalizeText(nb[i]);
      if (!n) continue;
      // Precise check: exact match, substring, or start of string
      if (n === activeName || activeName.includes(n)) return true;
    }
    return false;
  }

  // --- Entity Expansion ---
  function expandKeywordsInArray(keywords, entityDb, regex, dbgFunc) {
    const expanded = new Set();
    for (let i = 0; i < keywords.length; i++) {
      const keyword = keywords[i];
      const match = String(keyword).match(regex);
      if (match) {
        const entityName = match[1].toLowerCase();
        const entity = entityDb[entityName];
        if (entity) {
          expanded.add(entityName);
          if (Array.isArray(entity.aliases)) {
            for (const alias of entity.aliases) expanded.add(alias);
          }
          if (dbgFunc) dbgFunc(`Expanded '${keyword}' -> ${entityName}`);
        }
      } else {
        expanded.add(keyword);
      }
    }
    return Array.from(expanded);
  }

  function expandEntityKeywords(loreBook, entityDb, dbgFunc) {
    const entityKeywordRegex = /^char\.([a-z0-9_]+)$/i;
    for (const entry of loreBook) {
      if (entry.keywords && entry.keywords.length) {
        entry.keywords = expandKeywordsInArray(entry.keywords, entityDb, entityKeywordRegex, dbgFunc);
      }
      if (entry.Shifts && entry.Shifts.length) {
        for (const shift of entry.Shifts) {
          if (shift.keywords && shift.keywords.length) {
            shift.keywords = expandKeywordsInArray(shift.keywords, entityDb, entityKeywordRegex, dbgFunc);
          }
        }
      }
    }
  }

  // --- Term Matching ---
  function escapeRegex(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function _hasTerm(haystack, term) {
    const rawTerm = (term == null ? "" : String(term)).trim();
    if (!rawTerm) return false;

    // Optimization: Check cache before building regex
    const isWildcard = rawTerm.endsWith("*");
    const cleanTerm = isWildcard ? _normalizeText(rawTerm.slice(0, -1)) : _normalizeText(rawTerm);

    if (!cleanTerm) return false;

    // Build pattern key
    const patternKey = isWildcard ? `w:${cleanTerm}` : `s:${cleanTerm}`;

    let re = _regexCache.get(patternKey);
    if (!re) {
      const escaped = escapeRegex(cleanTerm);
      // Wildcard: "term" followed by optional letters until boundary
      // Standard: "term" exactly at boundary
      const pat = isWildcard
        ? "(?:^|\\s)" + escaped + "[a-z]*?(?=\\s|$)"
        : "(?:^|\\s)" + escaped + "(?=\\s|$)";
      re = new RegExp(pat); // No 'g' flag needed for .test()
      _regexCache.set(patternKey, re);
    }

    return re.test(haystack);
  }

  // --- Gate Checking ---
  function collectWordGates(e) {
    // Optimized to avoid unnecessary array concat if not needed
    const getGateSet = (prefix) => {
      const pReq = prefix ? `${prefix}requires` : "requires";
      const r = (e && e[pReq]) || {};

      const getList = (k1, k2, k3, k4) => {
        const arr = [];
        if (e && e[k1]) arr.push(...toArray(e[k1]));
        if (e && e[k2]) arr.push(...toArray(e[k2]));
        if (k3 && r[k3]) arr.push(...toArray(r[k3]));
        if (k4 && e && e[k4]) arr.push(...toArray(e[k4])); // for blocklist
        return arr;
      };

      const p = prefix || "";
      return {
        any: getList(`${p}requireAny`, `${p}andAny`, 'any'),
        all: getList(`${p}requireAll`, `${p}andAll`, 'all'),
        none: getList(`${p}requireNone`, `${p}notAny`, 'none', prefix ? `${p}block` : 'block'),
        nall: e && e[`${p}notAll`] ? toArray(e[`${p}notAll`]) : []
      };
    };

    return {
      current: getGateSet(""),
      previous: getGateSet("prev.")
    };
  }

  function _checkWordGates(e) {
    const g = collectWordGates(e);

    // Fail-fast logic
    const checkScope = (scope, text) => {
      if (scope.any.length > 0 && !scope.any.some(w => _hasTerm(text, w))) return false;
      if (scope.all.length > 0 && !scope.all.every(w => _hasTerm(text, w))) return false;
      if (scope.none.length > 0 && scope.none.some(w => _hasTerm(text, w))) return false;
      if (scope.nall.length > 0 && scope.nall.every(w => _hasTerm(text, w))) return false;
      return true;
    };

    if (!checkScope(g.current, _currentHaystack)) return false;
    if (!checkScope(g.previous, _previousHaystack)) return false;

    return true;
  }

  function _checkTagGates(e, activeTagsSet) {
    if (!e) return true;

    // Check NOT gates first (fail fast)
    if (e.notAnyTags) {
      const noneT = toArray(e.notAnyTags);
      if (noneT.some(t => activeTagsSet[String(t)] === 1)) return false;
    }
    if (e.notAllTags) {
      const nallT = toArray(e.notAllTags);
      if (nallT.length > 0 && nallT.every(t => activeTagsSet[String(t)] === 1)) return false;
    }

    // Check AND gates
    if (e.andAnyTags) {
      const anyT = toArray(e.andAnyTags);
      if (anyT.length > 0 && !anyT.some(t => activeTagsSet[String(t)] === 1)) return false;
    }
    if (e.andAllTags) {
      const allT = toArray(e.andAllTags);
      if (allT.length > 0 && !allT.every(t => activeTagsSet[String(t)] === 1)) return false;
    }

    return true;
  }

  // Unified logic generator for Emotion/Intent/Eros gates
  function _createGateChecker(keys, normalizeFunc) {
    return (e, activeSet) => {
      if (!e) return true;
      const [anyK, allK, noneK, nallK] = keys;

      // Collect requirements
      const any = [];
      if (e[anyK[0]]) any.push(...toArray(e[anyK[0]]));
      if (e[anyK[1]]) any.push(...toArray(e[anyK[1]]));
      if (e[anyK[2]]) any.push(...toArray(e[anyK[2]]));

      const all = [];
      if (e[allK[0]]) all.push(...toArray(e[allK[0]]));
      if (e[allK[1]]) all.push(...toArray(e[allK[1]]));

      const none = [];
      if (e[noneK[0]]) none.push(...toArray(e[noneK[0]]));
      if (e[noneK[1]]) none.push(...toArray(e[noneK[1]]));
      if (e[noneK[2]]) none.push(...toArray(e[noneK[2]]));

      const nall = [];
      if (e[nallK[0]]) nall.push(...toArray(e[nallK[0]]));
      if (e[nallK[1]]) nall.push(...toArray(e[nallK[1]]));

      if (!any.length && !all.length && !none.length && !nall.length) return true;

      const has = (item) => activeSet[normalizeFunc(item)] === true;

      if (none.length && none.some(has)) return false;
      if (nall.length && nall.every(has)) return false;
      if (any.length && !any.some(has)) return false;
      if (all.length && !all.every(has)) return false;

      return true;
    };
  }

  const _checkEmotionGates = _createGateChecker(
    [
      ['requireAnyEmotion', 'andAnyEmotion', 'requireEmotion'],
      ['requireAllEmotion', 'andAllEmotion'],
      ['blockAnyEmotion', 'notAnyEmotion', 'blockEmotion'],
      ['blockAllEmotion', 'notAllEmotion']
    ],
    (s) => String(s).toLowerCase()
  );

  const _checkIntentGates = _createGateChecker(
    [
      ['requireAnyIntent', 'andAnyIntent', 'requireIntent'],
      ['requireAllIntent', 'andAllIntent'],
      ['blockAnyIntent', 'notAnyIntent', 'blockIntent'],
      ['blockAllIntent', 'notAllIntent']
    ],
    (s) => {
      const v = String(s).toLowerCase();
      return v.startsWith('intent.') ? v.slice(7) : v;
    }
  );

  const _checkErosGates = _createGateChecker(
    [
      ['requireAnyEros', 'andAnyEros', 'requireEros'],
      ['requireAllEros', 'andAllEros'],
      ['blockAnyEros', 'notAnyEros', 'blockEros'],
      ['blockAllEros', 'notAllEros']
    ],
    (s) => {
      const v = String(s).toLowerCase();
      return v.startsWith('eros.') ? v.slice(5) : v;
    }
  );

  function _isAlwaysOn(e) {
    if (!e) return false;
    // Fast property check
    if (e.keywords && e.keywords.length) return false;
    if (e['prev.keywords'] && e['prev.keywords'].length) return false;
    if (e.tag) return false;
    if (e.minMessages != null) return false;
    if (e.maxMessages != null) return false;
    return true;
  }

  function _isEntryActive(e, activeTagsSet, activeEmotions, activeIntents, activeEros) {
    if (!e) return false;

    // Check message count first (fastest integer check)
    const min = getMin(e);
    const max = getMax(e);
    if (messageCount < min || messageCount > max) return false;

    // Check probability next (fast float check)
    if (e.probability != null && Math.random() > parseProbability(e.probability)) return false;

    // Check blocklists
    if (_isNameBlocked(e)) return false;

    // Check gates (Logical short-circuits)
    if (!_checkTagGates(e, activeTagsSet || {})) return false;
    if (!_checkEmotionGates(e, activeEmotions || {})) return false;
    if (!_checkIntentGates(e, activeIntents || {})) return false;
    if (!_checkErosGates(e, activeEros || {})) return false;

    // Finally check expensive regex word gates
    if (!_checkWordGates(e)) return false;

    return true;
  }

  function resolveActiveEntities(currentText, lastMessages) {
    const memory = { M: null, F: null, N: null };
    const activeEntities = new Set();

    // Cache the lower-case text once
    const lowerCurrent = currentText.toLowerCase();

    // Helper: Optimized scanning
    const scanTextForNames = (text, isCurrent) => {
      if (!text) return;
      const lower = isCurrent ? lowerCurrent : text.toLowerCase();

      for (const name in ENTITY_DB) {
        if (!Object.prototype.hasOwnProperty.call(ENTITY_DB, name)) continue;

        // Use cached regex for entity names
        const re = getCachedRegex(`\\b${escapeRegex(name)}\\b`, '');
        if (re && re.test(lower)) {
          const meta = ENTITY_DB[name];
          if (meta) {
            memory[meta.gender] = name;
            memory.N = name;
            if (isCurrent) activeEntities.add(name);
          }
        }
      }
    };

    // Scan History
    if (lastMessages && Array.isArray(lastMessages)) {
      for (let i = 0; i < lastMessages.length; i++) {
        const item = lastMessages[i];
        scanTextForNames((typeof item === 'string' ? item : item?.message) || "", false);
      }
    }

    // Scan Current
    scanTextForNames(currentText, true);

    // Resolve Pronouns
    const words = lowerCurrent.split(/[^a-z]+/);
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (PRONOUN_MAP[w]) {
        const gender = PRONOUN_MAP[w];
        const target = memory[gender] || memory.N;
        if (target) {
          activeEntities.add(target);
          if (typeof DEBUG !== "undefined" && DEBUG) {
            console.log(`[AURA] Coreference: '${w}' -> ${target}`);
          }
        }
      }
    }

    return Array.from(activeEntities);
  }

  function getDynamicRelationshipLore(activeTagsSet) {
    if (!RELATIONSHIP_DB || !RELATIONSHIP_DB.length) return [];

    // Lazy load messages only if we have relationships to check
    const lm = _lmArr || [];
    const lastMessages = lm.map(m => (typeof m === 'string' ? m : m?.message || ""));

    const activeEntities = resolveActiveEntities(CHAT_WINDOW.text_last_only, lastMessages);
    if (activeEntities.length < 2) return [];

    const injections = [];
    for (let i = 0; i < RELATIONSHIP_DB.length; i++) {
      const trigger = RELATIONSHIP_DB[i];

      // 1. Check Pair
      let hasPair = true;
      for (let p = 0; p < trigger.pair.length; p++) {
        if (!activeEntities.includes(trigger.pair[p])) { hasPair = false; break; }
      }
      if (!hasPair) continue;

      // 2. Check Tags
      const rTags = toArray(trigger.requireTags);
      if (rTags.length > 0) {
        let hasTags = true;
        for (let t = 0; t < rTags.length; t++) {
          if (!hasTag(activeTagsSet, rTags[t])) { hasTags = false; break; }
        }
        if (!hasTags) continue;
      }

      injections.push({
        injection: trigger.injection,
        group: trigger.group || null
      });
    }
    return injections;
  }

  function compileAuthorLore(authorLore, entityDb) {
    // Optimized concatenation
    let src = Array.isArray(authorLore) ? authorLore : [];
    if (entityDb) {
      const entityLore = [];
      for (const name in entityDb) {
        if (entityDb[name]?.lore) entityLore.push(...entityDb[name].lore);
      }
      if (entityLore.length) src = src.concat(entityLore);
    }

    // Normalize in place
    return src.map(normalizeEntry);
  }

  function normalizeEntry(e) {
    if (!e) return {};
    // Shallow copy + standard props
    const out = Object.assign({}, e);

    out.keywords = Array.isArray(e.keywords) ? e.keywords.slice(0) : [];

    if (Array.isArray(e.Shifts)) {
      out.Shifts = e.Shifts.map(s => {
        const sh = Object.assign({}, s || {});
        sh.keywords = Array.isArray(s.keywords) ? s.keywords.slice(0) : [];
        return sh;
      });
    } else {
      delete out.Shifts;
    }
    return out;
  }
  //#endregion
  /* ============================================================================
     [SECTION] COMPILATION
     DO NOT EDIT: Behavior-sensitive
     ========================================================================== */
  //#region COMPILATION
  const _ENGINE_LORE = compileAuthorLore(typeof DYNAMIC_LORE !== "undefined" ? DYNAMIC_LORE : [], typeof ENTITY_DB !== "undefined" ? ENTITY_DB : {});

  // Expand `char.entity` keywords into their full alias lists.
  expandEntityKeywords(_ENGINE_LORE, ENTITY_DB, dbg);


  /* ============================================================================
     [SECTION] SELECTION PIPELINE
     DO NOT EDIT: Behavior-sensitive
     ========================================================================== */
  // CONCEPTUAL: In a modular world, we'd get classifications from our modules first.
  // These would be imported from PULSE.js, EROS.js, INTENT.js etc.

  // PATCH: WHITEBOARD READER
  // This logic reads the Scenario string to find tags written by PULSE, EROS, and INTENT
  // and populates the active objects so AURA can gate appropriately.
  const PULSE_TAGS_DEF = ["ANGER", "JOY", "SADNESS", "FEAR", "ROMANCE", "NEUTRAL", "CONFUSION", "POSITIVE", "NEGATIVE"];
  const EROS_TAGS_DEF = ["PLATONIC", "TENSION", "ROMANCE", "PHYSICAL", "PASSION", "EXPLICIT", "CONFLICT", "AFTERCARE"];
  const INTENT_TAGS_DEF = ["QUESTION", "DISCLOSURE", "COMMAND", "PROMISE", "CONFLICT", "SMALLTALK", "META", "NARRATIVE"];

  // PATCH: Case-Insensitive Tag Reader with LT_ support
  // Allows underscores so we catch [LT_JOY]
  const foundTags = (context.character.scenario.match(/\[\s*([a-z_]+)\s*\]/gi) || [])
    .map(t => t.replace(/[\[\]]/g, "").trim().toUpperCase());

  const activeEmotions = {};
  const activeEros = {};
  const activeIntents = {};

  foundTags.forEach(t => {
    // Check for Long Term prefix
    const isLT = t.startsWith("LT_");
    const baseTag = isLT ? t.substring(3) : t; // Strip "LT_" to find the root emotion

    // PULSE (Emotions)
    if (PULSE_TAGS_DEF.includes(baseTag)) {
      activeEmotions[baseTag.toLowerCase()] = true; // Enable 'joy'
      if (isLT) activeEmotions[t.toLowerCase()] = true; // Enable 'lt_joy'
    }

    // EROS (Relationships)
    if (EROS_TAGS_DEF.includes(baseTag)) {
      activeEros[baseTag.toLowerCase()] = true; // Enable 'romance'
      if (isLT) activeEros[t.toLowerCase()] = true; // Enable 'lt_romance'
    }

    // INTENT (Standard)
    if (INTENT_TAGS_DEF.includes(t)) activeIntents[t.toLowerCase()] = true;
  });

  // Fallback to global context if present (for backward compatibility)
  if (context.emotions) Object.assign(activeEmotions, context.emotions);
  if (context.intents) Object.assign(activeIntents, context.intents);
  if (context.eros) Object.assign(activeEros, context.eros);

  //#region SELECTION_PIPELINE
  // --- State -------------------------------------------------------------------
  // Buckets for priority 1-5. 
  // bucket[0] is unused, buckets[1]..buckets[5] store indices.
  const buckets = [[], [], [], [], [], []];
  const picked = new Uint8Array(_ENGINE_LORE.length); // Optimization: TypedArray for binary flags
  const inclusionGroups = new Set(); // Optimization: Set is faster for string lookups
  const trigSet = new Set();

  // --- 1) Direct Pass: Keyword & Environment Triggered Entries -----------------
  // Scans for keywords in text OR active environment states (Emotions, Intents, Eros)
  for (let i = 0; i < _ENGINE_LORE.length; i++) {
    const e = _ENGINE_LORE[i];

    // Quick check: Is this entry purely triggered by other tags?
    // If it has a 'tag' property but NO keywords and NO env gates, it must wait for Pass 2.
    // (Optimization: pre-calculate this or infer from data, but here we check logically)

    // Check Environment Gates (Does this entry react to AURA/EROS/INTENT tags?)
    const hasEnvGate = (
      (e.requireAnyEmotion || e.andAnyEmotion || e.requireAllEmotion || e.andAllEmotion) ||
      (e.requireAnyIntent || e.andAnyIntent || e.requireAllIntent || e.andAllIntent) ||
      (e.requireAnyEros || e.andAnyEros || e.requireAllEros || e.andAllEros)
    );

    // Check Keywords (Current or Previous)
    // We use the helper function logic inline or via short-circuit to avoid function overhead if possible
    let hasKeywordHit = false;
    if (e.keywords && e.keywords.length > 0) {
      if (e.keywords.some(kw => _hasTerm(_currentHaystack, kw))) hasKeywordHit = true;
    }
    if (!hasKeywordHit && e['prev.keywords'] && e['prev.keywords'].length > 0) {
      if (toArray(e['prev.keywords']).some(kw => _hasTerm(_previousHaystack, kw))) hasKeywordHit = true;
    }

    // HIT CONDITION: AlwaysOn OR EnvGate OR KeywordHit
    // Note: If an entry has a 'tag', it usually waits for Pass 2, UNLESS it also has a keyword/env trigger.
    const isHit = _isAlwaysOn(e) || hasEnvGate || hasKeywordHit;

    if (!isHit) continue;

    // Validate Constraints (Gates)
    if (!_isEntryActive(e, undefined, activeEmotions, activeIntents, activeEros)) {
      dbg(`filtered entry[${i}]`);
      continue;
    }

    // Add to bucket
    buckets[getPriority(e)].push(i);
    picked[i] = 1;

    // Register Output Triggers (to fire other entries in Pass 2)
    if (e.triggers) {
      const t = e.triggers; // Optimized access
      for (let k = 0; k < t.length; k++) trigSet.add(t[k]);
    }

    dbg(`hit entry[${i}] p=${getPriority(e)}`);
  }

  // --- 2) Trigger Pass: Tag-Chained Entries ------------------------------------
  // Scans for entries triggered by tags emitted in Pass 1
  if (trigSet.size > 0) {
    for (let i = 0; i < _ENGINE_LORE.length; i++) {
      if (picked[i]) continue; // Already picked in Pass 1

      const e = _ENGINE_LORE[i];
      if (!e.tag || !trigSet.has(e.tag)) continue; // Not triggered

      // Validate Constraints (passing the triggers as the active tag set)
      // Note: We convert Set back to the expected map-like object or modify _checkTagGates?
      // Optimization: adapted _checkTagGates to accept a Set? 
      // Current architecture expects `activeTagsSet` to be object-like map.
      // Let's create a temporary map adapter for compatibility without rewriting _checkTagGates entirely yet.
      // Or better: Just change the input to `_isEntryActive`.
      // For safety in this specific refactor step, we'll build the map adapter fast.
      const trigMap = {};
      trigSet.forEach(t => trigMap[String(t)] = 1);

      if (!_isEntryActive(e, trigMap, activeEmotions, activeIntents, activeEros)) {
        dbg(`filtered triggered entry[${i}]`);
        continue;
      }

      buckets[getPriority(e)].push(i);
      picked[i] = 1;

      // Accumulate new triggers (allows multi-stage chaining if we ran another pass, but here strictly 2 passes)
      if (e.triggers) {
        const t = e.triggers;
        for (let k = 0; k < t.length; k++) trigSet.add(t[k]);
      }

      dbg(`triggered entry[${i}] p=${getPriority(e)}`);
    }
  }

  // --- 3) Priority Selection & Inclusion Groups --------------------------------
  const selected = [];
  let pickedCount = 0;
  const applyLimit = (typeof APPLY_LIMIT === "number" && APPLY_LIMIT >= 1) ? APPLY_LIMIT : 99999;

  // Iterate Priority 5 -> 1
  for (let p = 5; p >= 1; p--) {
    if (pickedCount >= applyLimit) break;

    const bucket = buckets[p];
    if (bucket.length === 0) continue;

    for (let k = 0; k < bucket.length; k++) {
      if (pickedCount >= applyLimit) break;

      const idx = bucket[k];
      const entry = _ENGINE_LORE[idx];

      // Inclusion Group Logic (Mutual Exclusion)
      const group = entry.group || (entry.id ? String(entry.id).split('_')[0] : null);
      if (group) {
        if (inclusionGroups.has(group)) {
          dbg(`Skipping entry in group '${group}' (already selected).`);
          continue;
        }
        inclusionGroups.add(group);
      }

      selected.push(idx);
      pickedCount++;
    }
  }

  if (pickedCount >= applyLimit) dbg("APPLY_LIMIT reached");
  /* ============================================================================
       [SECTION] APPLY + SHIFTS + POST-SHIFT
       DO NOT EDIT: Behavior-sensitive
       ========================================================================== */
  //#region APPLY_AND_SHIFTS
  let personalityBuffer = "";
  let scenarioBuffer = "";
  let exampleDialogsBuffer = "";

  // Track new tags specifically from Shifts
  const postShiftTrigSet = new Set();

  // --- 1. Apply Selected Entries & Check Shifts ---
  for (let i = 0; i < selected.length; i++) {
    const idx = selected[i];
    const e = _ENGINE_LORE[idx];

    // Append Main Entry Text
    if (e.personality) personalityBuffer += `\n\n${e.personality}`;
    if (e.scenario) scenarioBuffer += `\n\n${e.scenario}`;
    if (e.example_dialogs) exampleDialogsBuffer += `\n${e.example_dialogs}`;

    // Process Shifts (Sub-entries that fire if parent fires + extra conditions)
    if (e.Shifts && e.Shifts.length > 0) {
      for (let s = 0; s < e.Shifts.length; s++) {
        const sh = e.Shifts[s];

        // 1. Activation Check (Keywords)
        // Optimization: Inline logic to avoid function overhead
        let activated = _isAlwaysOn(sh);
        if (!activated && sh.keywords && sh.keywords.length > 0) {
          if (sh.keywords.some(kw => _hasTerm(_currentHaystack, kw))) activated = true;
        }
        if (!activated && sh['prev.keywords'] && sh['prev.keywords'].length > 0) {
          if (toArray(sh['prev.keywords']).some(kw => _hasTerm(_previousHaystack, kw))) activated = true;
        }

        if (!activated) continue;

        // 2. Register Output Tags (Accumulate for Post-Shift)
        if (sh.triggers) {
          const t = sh.triggers;
          for (let k = 0; k < t.length; k++) postShiftTrigSet.add(t[k]);
        }

        // 3. Gate Check 
        // We pass the current 'trigSet' (Pass 1+2 tags) for checking shift gates.
        // Adapter: Convert Set to Map for compatibility
        const trigMap = {};
        trigSet.forEach(v => trigMap[v] = 1);

        if (!_isEntryActive(sh, trigMap, activeEmotions, activeIntents, activeEros)) {
          dbg("shift filtered");
          continue;
        }

        // 4. Append Shift Text
        if (sh.personality) personalityBuffer += `\n\n${sh.personality}`;
        if (sh.scenario) scenarioBuffer += `\n\n${sh.scenario}`;
        if (sh.example_dialogs) exampleDialogsBuffer += `\n${sh.example_dialogs}`;
      }
    }
  }

  // --- 2. Post-Shift Triggers --------------------------------------------------
  // Create a union of all tags active so far (Pass 1 + Pass 2 + Shifts) for final resolution
  const unionTags = new Set(trigSet);
  postShiftTrigSet.forEach(tag => unionTags.add(tag));

  // Convert to Map for _isEntryActive compatibility
  const unionTagsMap = {};
  unionTags.forEach(tag => unionTagsMap[tag] = 1);

  // Only run if we actually generated new tags in the Shift phase
  if (postShiftTrigSet.size > 0) {
    for (let i = 0; i < _ENGINE_LORE.length; i++) {
      if (picked[i]) continue; // Skip if already selected in Pass 1 or 2

      const e = _ENGINE_LORE[i];
      // Only check entries that are triggered by a tag explicitly emitted from a Shift
      if (!e.tag || !postShiftTrigSet.has(e.tag)) continue;

      // Check Constraints against the full union of tags
      if (!_isEntryActive(e, unionTagsMap, activeEmotions, activeIntents, activeEros)) {
        dbg(`post-filter entry[${i}]`);
        continue;
      }

      // Append Post-Shift Text
      if (e.personality) personalityBuffer += `\n\n${e.personality}`;
      if (e.scenario) scenarioBuffer += `\n\n${e.scenario}`;
      if (e.example_dialogs) exampleDialogsBuffer += `\n${e.example_dialogs}`;

      dbg(`post-shift triggered entry[${i}] p=${getPriority(e)}`);
    }
  }

  // --- 3. Dynamic Relationship Injections --------------------------------------
  // We pass the Union Tags (Map) so relationships can gate on tags like "TENSION" or "JOY"
  const relationshipInjections = getDynamicRelationshipLore(unionTagsMap);

  if (relationshipInjections.length > 0) {
    for (let i = 0; i < relationshipInjections.length; i++) {
      const injectionObj = relationshipInjections[i];
      const group = injectionObj.group;

      // Mutual Exclusion for Relationship Injections
      if (group) {
        if (inclusionGroups.has(group)) {
          dbg(`Skipping relationship injection in group '${group}' due to exclusion.`);
          continue;
        }
        inclusionGroups.add(group);
      }

      personalityBuffer += `\n\n${injectionObj.injection}`;
    }
  }

  /* ============================================================================
     [SECTION] FLUSH
     DO NOT EDIT: Behavior-sensitive
     ========================================================================== */
  //#region FLUSH_LOGIC

  // 1. Flush Personality
  if (personalityBuffer) {
    const sep = context.character.personality.length > 0 ? "\n\n" : "";
    context.character.personality += sep + personalityBuffer.trim();
  }

  /**
   * Helper: Processes a tagged block (e.g., [RESPONSE_MATRIX]...[/RESPONSE_MATRIX])
   * Logic:
   * 1. Wraps unwrapped rows (e.g., "A1 | Text") into the block if the block doesn't exist.
   * 2. Merges new rows from scenarioBuffer into existing scenario rows.
   * 3. Sorts all rows by ID (Letter -> Number).
   */
  function processScenarioBlock(tagName, idPrefixPattern) {
    const tagOpen = `[${tagName}]`;
    const tagClose = `[/${tagName}]`;
    const blockRegex = new RegExp(`\\[${tagName}\\]([\\s\\S]*?)\\[\\/${tagName}\\]`, 'i');

    // 1. Wrap unwrapped rows if no block exists in current scenario
    if (!blockRegex.test(context.character.scenario)) {
      const unwrappedRegex = new RegExp(`^(${idPrefixPattern}\\d+)\\s*\\|(.*)$`, 'gm');
      if (unwrappedRegex.test(context.character.scenario)) {
        const rows = [];
        let m;
        while ((m = unwrappedRegex.exec(context.character.scenario)) !== null) {
          rows.push(m[0].trim());
        }
        if (rows.length > 0) {
          // Remove unwrapped lines
          context.character.scenario = context.character.scenario.replace(new RegExp(`^(${idPrefixPattern}\\d+)\\s*\\|(.*)$\\n?`, 'gm'), '');
          // Append wrapped block
          context.character.scenario += `\n${tagOpen}\n${rows.join('\n')}\n${tagClose}`;
        }
      }
    }

    // 2. Merge & Sort
    const existingMatch = context.character.scenario.match(blockRegex);
    if (existingMatch || (scenarioBuffer && scenarioBuffer.includes(tagOpen))) {
      const rowMap = {};
      const rowRegex = /^([A-Z]+\d+)\s*\|(.*)$/gm;

      // Extract from Existing Scenario
      if (existingMatch) {
        let m;
        while ((m = rowRegex.exec(existingMatch[1])) !== null) {
          rowMap[m[1]] = m[0].trim();
        }
      }

      // Extract from New Buffer (if present)
      if (scenarioBuffer && scenarioBuffer.includes(tagOpen)) {
        const bufferBlockRegex = new RegExp(`\\[${tagName}\\]([\\s\\S]*?)\\[\\/${tagName}\\]`, 'gi');
        let blockMatch;
        while ((blockMatch = bufferBlockRegex.exec(scenarioBuffer)) !== null) {
          // Reset lastIndex for the inner loop
          let rowMatch;
          const innerRowRegex = /^([A-Z]+\d+)\s*\|(.*)$/gm;
          while ((rowMatch = innerRowRegex.exec(blockMatch[1])) !== null) {
            rowMap[rowMatch[1]] = rowMatch[0].trim(); // Overwrite/Add
          }
        }
      }

      // Sort IDs (Letter, then Number)
      const sortedIDs = Object.keys(rowMap).sort((a, b) => {
        const matchA = a.match(/^([A-Z]+)(\d+)$/);
        const matchB = b.match(/^([A-Z]+)(\d+)$/);
        if (!matchA || !matchB) return a.localeCompare(b);
        if (matchA[1] !== matchB[1]) return matchA[1].localeCompare(matchB[1]);
        return parseInt(matchA[2]) - parseInt(matchB[2]);
      });

      if (sortedIDs.length > 0) {
        let content = sortedIDs.map(id => rowMap[id]).join('\n');

        // Preserve Header if it exists in the original block
        if (existingMatch) {
          const headerMatch = existingMatch[1].match(/^(?!([A-Z]+\d+\s*\|)).*\|.*$/m);
          if (headerMatch && headerMatch[0].trim()) {
            content = headerMatch[0].trim() + '\n' + content;
          }
        }

        const newBlock = `${tagOpen}\n${content}\n${tagClose}`;

        if (existingMatch) {
          context.character.scenario = context.character.scenario.replace(blockRegex, newBlock);
        } else {
          context.character.scenario += `\n\n${newBlock}`;
        }
      }
    }
  }

  // --- Process Structured Blocks ---
  processScenarioBlock("RESPONSE_MATRIX", "[A-Z]");
  processScenarioBlock("INTENT", "I");
  processScenarioBlock("EROS", "E");

  // --- Handle Generic/Untagged Scenario Text ---
  // If scenarioBuffer contains text that isn't in the blocks above, append it now.
  let remainingBuffer = scenarioBuffer;
  ["RESPONSE_MATRIX", "INTENT", "EROS"].forEach(tag => {
    const regex = new RegExp(`\\[${tag}\\][\\s\\S]*?\\[\\/${tag}\\]`, 'gi');
    remainingBuffer = remainingBuffer.replace(regex, '');
  });
  if (remainingBuffer.trim()) {
    context.character.scenario += `\n\n${remainingBuffer.trim()}`;
  }

  // --- Tag Cleanup ---
  // Removes classifier tags (e.g., [JOY], [COMMAND]) so they don't leak into the prompt.
  const allTags = [
    ...PULSE_TAGS_DEF, ...EROS_TAGS_DEF, ...INTENT_TAGS_DEF
  ];

  let cleanScen = context.character.scenario;
  for (let i = 0; i < allTags.length; i++) {
    const t = allTags[i];
    // Match [TAG] and [LT_TAG]
    const re = new RegExp(`\\s*\\[(LT_)?${t}\\]`, 'gi');
    cleanScen = cleanScen.replace(re, '');
  }
  context.character.scenario = cleanScen.replace(/\n{3,}/g, '\n\n').trim();

  // 3. Flush Example Dialogs
  if (exampleDialogsBuffer) {
    const sep = context.character.example_dialogs.length > 0 ? "\n\n" : "";
    context.character.example_dialogs += sep + exampleDialogsBuffer.trim();
  }
  //#endregion
})();