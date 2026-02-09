/* ============================================================================
   PULSE INFERENCE ENGINE v17
   Author: Icehellionx
   ==========================================================================
   This script acts as a pure CLASSIFIER.
   1. It normalizes input text.
   2. It runs dot-product inference using PULSE models.
   3. It writes:
      - [TAG]... : Short Term (Instant) triggers. Multiple allowed.
      - [LT_TAG]: Long Term (Mood) trigger. ONLY ONE (Highest Score) allowed.
   ========================================================================== */

/* ============================================================================
   [SECTION] GLOBAL KNOBS
   SAFE TO EDIT: Yes
   ========================================================================== */
//#region GLOBAL_KNOBS
let DEBUG = 0;

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
} else {
  const _lastMsgA = (context && context.chat && typeof context.chat.lastMessage === "string") ? context.chat.lastMessage : "";
  const _lastMsgB = (context && context.chat && typeof context.chat.last_message === "string") ? context.chat.last_message : "";
  _rawLastSingle = _toString(_lastMsgA || _lastMsgB);
  _joinedWindow = _rawLastSingle;
}

// --- Public struct + haystacks ---
const CHAT_WINDOW = {
  depth: WINDOW_DEPTH,
  text_joined: _joinedWindow,
  text_last_only: _rawLastSingle,
  text_joined_norm: _normalizeText(_joinedWindow),
  text_last_only_norm: _normalizeText(_rawLastSingle)
};

/* ============================================================================
   [SECTION] PULSE PROCESSING
   DO NOT EDIT: Behavior-sensitive
   ========================================================================== */
//#region PULSE_PROCESSING
(function () {
  "use strict";

  const STOP_STR = "i,me,my,myself,we,our,ours,ourselves,you,your,yours,yourself,yourselves,he,him,his,himself,she,her,hers,herself,it,its,itself,they,them,their,theirs,themselves,what,which,who,whom,this,that,these,those,am,is,are,was,were,be,been,being,have,has,had,having,do,does,did,doing,a,an,the,and,but,if,or,because,as,until,while,of,at,by,for,with,about,against,between,into,through,during,before,after,above,below,to,from,up,down,in,out,on,off,over,under,again,further,then,once,here,there,when,where,why,how,all,any,both,each,few,more,most,other,some,such,no,nor,not,only,own,same,so,than,too,very,s,t,can,will,just,don,should,now";
  const STOP_WORDS = {};
  STOP_STR.split(",").forEach(function (w) { STOP_WORDS[w] = true; });


  /* ============================================================================
     [SECTION] PULSE MODELS
     SAFE TO EDIT: Paste your trained model strings here
     ========================================================================== */
  //#region PULSE_MODELS
  // (rework here so that it pulls the weights from weights.js in the same folder.)


  // ----------------------------------------------------------------------------
  // INFERENCE & STATE MANAGEMENT
  // ----------------------------------------------------------------------------

  function stem(w) {
    if (w.length < 4) return w;
    if (w.endsWith("ies")) return w.slice(0, -3) + "y";
    if (w.endsWith("es")) return w.slice(0, -2);
    if (w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
    if (w.endsWith("ing")) {
      const base = w.slice(0, -3);
      if (base.length > 2) return base;
    }
    if (w.endsWith("ed")) {
      const base = w.slice(0, -2);
      if (base.length > 2) return base;
    }
    if (w.endsWith("ly")) return w.slice(0, -2);
    if (w.endsWith("ment")) return w.slice(0, -4);
    if (w.endsWith("ness")) return w.slice(0, -4);
    if (w.endsWith("ful")) return w.slice(0, -3);
    if (w.endsWith("able")) return w.slice(0, -4);
    if (w.endsWith("ibility")) return w.slice(0, -7);
    return w;
  }

  function fnv1a32(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function solveIntent(textTokens, modelStr) {
    if (!modelStr) return -999;
    const semi1 = modelStr.indexOf(";");
    const semi2 = modelStr.indexOf(";", semi1 + 1);
    const bias = parseFloat(modelStr.slice(2, semi1));
    const scale = parseFloat(modelStr.slice(semi1 + 3, semi2));
    const wRaw = modelStr.slice(semi2 + 3);
    const weights = wRaw.split(",");
    let score = bias;
    for (let i = 0; i < textTokens.length; i++) {
      const h = fnv1a32(textTokens[i]) % HASH_SIZE;
      if (h < weights.length) {
        const w = parseInt(weights[h], 10);
        if (!isNaN(w)) {
          score += w * scale;
        }
      }
    }
    return score;
  }

  // Helper: Tokenize text into array of unigrams and bigrams
  function getTokens(text) {
    const norm = _normalizeText(text);
    const rawTokens = norm.split(' ');
    const tokens = [];
    for (let i = 0; i < rawTokens.length; i++) {
      const t = rawTokens[i];
      if (t.length > 2 && !STOP_WORDS[t]) {
        tokens.push(stem(t));
      }
    }
    const allTokens = tokens.slice();
    for (let i = 0; i < tokens.length - 1; i++) {
      allTokens.push(tokens[i] + " " + tokens[i + 1]);
    }
    return allTokens;
  }

  try {
    let scenarioBuffer = "";

    // Map models for iteration
    const models = [
      { name: "ANGER", data: MODEL_ANGER },
      { name: "JOY", data: MODEL_JOY },
      { name: "SADNESS", data: MODEL_SADNESS },
      { name: "FEAR", data: MODEL_FEAR },
      { name: "ROMANCE", data: MODEL_ROMANCE },
      { name: "NEUTRAL", data: MODEL_NEUTRAL },
      { name: "CONFUSION", data: MODEL_CONFUSION },
      { name: "POSITIVE", data: MODEL_POSITIVE },
      { name: "NEGATIVE", data: MODEL_NEGATIVE }
    ];

    // 1. SHORT TERM (Last Message Only) - Multiple allowed
    if (CHAT_WINDOW.text_last_only) {
      const lastTokens = getTokens(CHAT_WINDOW.text_last_only);
      models.forEach(m => {
        if (!m.data) return;
        const rawScore = solveIntent(lastTokens, m.data);
        if (rawScore > 0.0) {
          scenarioBuffer += ` [${m.name}]`;
        }
      });
    }

    // 2. LONG TERM (Window Average) - WINNER TAKES ALL
    if (_lmArr && _lmArr.length > 0) {
      const depth = Math.min(_lmArr.length, WINDOW_DEPTH);
      const history = _lmArr.slice(_lmArr.length - depth);

      let bestLTTag = null;
      let highestLTScore = -999.0; // Start low

      models.forEach(m => {
        if (!m.data) return;

        let totalScore = 0;
        let count = 0;

        for (const item of history) {
          const msg = (item && typeof item.message === "string") ? item.message : _toString(item);
          if (!msg.trim()) continue;
          const tokens = getTokens(msg);
          const s = solveIntent(tokens, m.data);
          if (s > -900) {
            totalScore += s;
            count++;
          }
        }

        if (count > 0) {
          const avg = totalScore / count;
          // Check if this is the new winner
          // We also require avg > 0.0 to even qualify
          if (avg > 0.0 && avg > highestLTScore) {
            highestLTScore = avg;
            bestLTTag = m.name;
          }
        }
      });

      // If we found a winner, append only that one
      if (bestLTTag) {
        scenarioBuffer += ` [LT_${bestLTTag}]`;
      }
    }

    // Write to Context
    if (scenarioBuffer) {
      context.character.scenario += scenarioBuffer;
    }

  } catch (e) {
    console.error('[PULSE-INFERENCE] PULSE processing failed:', e);
  }
})();