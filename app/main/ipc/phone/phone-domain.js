'use strict';

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function nowIso() {
  return new Date().toISOString();
}

function createId(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function pickRandom(list) {
  if (!Array.isArray(list) || !list.length) return null;
  return list[Math.floor(Math.random() * list.length)];
}

function randomInt(min, max) {
  const lo = Math.ceil(Number(min) || 0);
  const hi = Math.floor(Number(max) || lo);
  if (hi <= lo) return lo;
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

function normalizeParticipant(name) {
  return String(name || '').trim();
}

function normalizeParticipants(participants) {
  const out = [];
  const seen = new Set();
  for (const raw of toArray(participants)) {
    const n = normalizeParticipant(raw);
    if (!n) continue;
    const key = n.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }
  return out;
}

function buildThreadTitle(participants) {
  const chars = participants.filter((p) => p.toLowerCase() !== 'you');
  if (!chars.length) return 'Solo Thread';
  if (chars.length === 1) return chars[0];
  return chars.join(', ');
}

function normalizeReceipt(receipt) {
  const r = receipt && typeof receipt === 'object' ? receipt : {};
  const state = ['sent', 'delivered', 'read'].includes(r.state) ? r.state : 'sent';
  return {
    state,
    deliveredAt: typeof r.deliveredAt === 'string' ? r.deliveredAt : null,
    readAt: typeof r.readAt === 'string' ? r.readAt : null,
  };
}

function normalizeImageAttachment(image) {
  const x = image && typeof image === 'object' ? image : null;
  if (!x) return null;
  const path = String(x.path || '').trim();
  if (!path) return null;
  return {
    path,
    caption: String(x.caption || '').trim(),
    source: String(x.source || 'sprite').trim() || 'sprite',
  };
}

function updateReceiptState(message, nextState, atIso = nowIso()) {
  if (!message || String(message.from || '').toLowerCase() !== 'you') return;
  message.receipt = normalizeReceipt(message.receipt);
  if (nextState === 'delivered') {
    if (!message.receipt.deliveredAt) message.receipt.deliveredAt = atIso;
    if (message.receipt.state === 'sent') message.receipt.state = 'delivered';
    return;
  }
  if (nextState === 'read') {
    if (!message.receipt.deliveredAt) message.receipt.deliveredAt = atIso;
    if (!message.receipt.readAt) message.receipt.readAt = atIso;
    message.receipt.state = 'read';
  }
}

function advanceThreadReceipts(thread, mode, atIso = nowIso()) {
  if (!thread || !Array.isArray(thread.messages)) return;
  for (const msg of thread.messages) {
    if (String(msg.from || '').toLowerCase() !== 'you') continue;
    if (mode === 'delivered' && String(msg.receipt?.state || 'sent') === 'sent') {
      updateReceiptState(msg, 'delivered', atIso);
    } else if (mode === 'read' && String(msg.receipt?.state || 'sent') !== 'read') {
      updateReceiptState(msg, 'read', atIso);
    }
  }
}

function ensurePresenceMap(meta) {
  if (!meta || typeof meta !== 'object') return {};
  meta.presence = meta.presence && typeof meta.presence === 'object' ? meta.presence : {};
  return meta.presence;
}

function markPresence(meta, speaker, atIso = nowIso()) {
  const key = String(speaker || '').trim().toLowerCase();
  if (!key || key === 'you') return;
  const map = ensurePresenceMap(meta);
  map[key] = {
    status: 'online',
    lastActiveAt: atIso,
  };
}

function parseIsoDate(value) {
  const n = Date.parse(String(value || ''));
  return Number.isFinite(n) ? n : 0;
}

function buildPresenceTextForThread(thread, meta) {
  const others = (thread?.participants || []).filter((p) => String(p).toLowerCase() !== 'you');
  if (!others.length) return '';
  const map = ensurePresenceMap(meta);
  const nowMs = Date.now();
  const onlineCutoffMs = 2 * 60 * 1000;
  const recentCutoffMs = 30 * 60 * 1000;

  const online = [];
  let mostRecent = 0;
  let mostRecentName = '';
  for (const name of others) {
    const key = String(name).toLowerCase();
    const lastActiveAt = parseIsoDate(map[key]?.lastActiveAt);
    if (!lastActiveAt) continue;
    const delta = nowMs - lastActiveAt;
    if (delta <= onlineCutoffMs) online.push(name);
    if (lastActiveAt > mostRecent) {
      mostRecent = lastActiveAt;
      mostRecentName = name;
    }
  }

  if (others.length === 1) {
    if (online.length) return `${others[0]} is online`;
    if (mostRecent && nowMs - mostRecent <= recentCutoffMs) return `${others[0]} active recently`;
    return '';
  }

  if (online.length) return `${online.length} online`;
  if (mostRecentName && mostRecent) return `${mostRecentName} active recently`;
  return '';
}

function characterMentionedInText(text, characterName) {
  const source = String(text || '');
  const n = String(characterName || '').trim();
  if (!source || !n) return false;
  const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\b${escaped}\\b`, 'i');
  return re.test(source);
}

function findStoryContactUnlocks({ storyText, activeCharacters, contactsState, characterNames }) {
  const text = String(storyText || '');
  if (!text.trim()) return [];
  const hasPhoneCue = /(text|number|call|phone|dm|reach|contact|message)/i.test(text);
  if (!hasPhoneCue) return [];

  const activeSet = new Set(toArray(activeCharacters).map((c) => String(c || '').toLowerCase()));
  const unlocked = [];
  for (const name of characterNames) {
    const key = String(name).toLowerCase();
    if (contactsState.contacts?.[key]?.hasNumber) continue;
    const mentioned = characterMentionedInText(text, name);
    const active = activeSet.has(key);
    if (mentioned || active) {
      contactsState.contacts[key] = { hasNumber: true };
      unlocked.push(name);
    }
  }
  return unlocked;
}

function detectStoryPhoneHook(storyText) {
  const text = String(storyText || '').toLowerCase();
  if (!text.trim()) return null;
  if (/\b(danger|emergency|hospital|police|fight|injured|help)\b/.test(text)) {
    return { type: 'urgent', topicHint: 'Something urgent just happened in the story. React quickly by text.' };
  }
  if (/\b(party|hangout|hang out|meet up|come over|tonight|plans)\b/.test(text)) {
    return { type: 'invite', topicHint: 'The story just implied social plans. Start or continue a texting plan.' };
  }
  if (/\b(cafe|school|work|mall|park|street|home|apartment)\b/.test(text)) {
    return { type: 'location', topicHint: 'Reference the current location and check in naturally by text.' };
  }
  if (/\b(where are you|late|waiting|on my way)\b/.test(text)) {
    return { type: 'checkin', topicHint: 'Do a quick check-in text about timing or whereabouts.' };
  }
  return null;
}

function choosePhotoSpritePath(files, hintText = '') {
  const list = Array.isArray(files) ? files : [];
  if (!list.length) return null;
  const lowerHint = String(hintText || '').toLowerCase();
  const prefer = [];
  if (/\b(cute|selfie|photo|pic|flirt|romantic)\b/.test(lowerHint)) {
    prefer.push('flirty', 'happy', 'default');
  } else if (/\b(scared|danger|emergency)\b/.test(lowerHint)) {
    prefer.push('anxious', 'scared', 'sad');
  } else if (/\b(angry|fight|mad)\b/.test(lowerHint)) {
    prefer.push('mad');
  } else {
    prefer.push('happy', 'default', 'flirty');
  }

  const lowerFiles = list.map((f) => ({ raw: f, lower: String(f).toLowerCase() }));
  for (const token of prefer) {
    const match = lowerFiles.find((f) => f.lower.includes(`/${token}.`) || f.lower.includes(`_${token}.`) || f.lower.includes(`-${token}.`));
    if (match) return match.raw;
  }
  return pickRandom(list);
}

function chooseHookTargets({ hook, storyText, activeCharacters, knownContacts, displayNameMap }) {
  if (!hook) return [];
  const activeSet = new Set(toArray(activeCharacters).map((c) => String(c || '').toLowerCase()));
  const mentioned = knownContacts.filter((lower) => {
    const name = displayNameMap[lower] || lower;
    return characterMentionedInText(storyText, name);
  });
  const activeKnown = knownContacts.filter((lower) => activeSet.has(lower));
  const ranked = [...new Set([...mentioned, ...activeKnown, ...knownContacts])];
  if (!ranked.length) return [];
  if (hook.type === 'urgent' || hook.type === 'invite' || hook.type === 'location') {
    return ranked.slice(0, 2);
  }
  return ranked.slice(0, 1);
}

function pickAutoResponders(thread, maxReplies = 2) {
  const candidates = thread.participants.filter((p) => p.toLowerCase() !== 'you');
  if (candidates.length <= maxReplies) return candidates;

  const lastSeenIndex = new Map();
  thread.messages.forEach((m, i) => lastSeenIndex.set(String(m.from || '').toLowerCase(), i));

  return [...candidates]
    .sort((a, b) => {
      const ai = lastSeenIndex.has(a.toLowerCase()) ? lastSeenIndex.get(a.toLowerCase()) : -1;
      const bi = lastSeenIndex.has(b.toLowerCase()) ? lastSeenIndex.get(b.toLowerCase()) : -1;
      return ai - bi;
    })
    .slice(0, maxReplies);
}

function parsePlainReply(text) {
  return String(text || '')
    .replace(/\[(SCENE|\/SCENE|BG|SPRITE|SPLASH|MUSIC|HIDE|FX|SFX|CAMERA|TAKE|DROP|ADD_OBJECT):[^\]]*\]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeContactsState(raw, characterNames, starterKnownNumbers = {}) {
  const state = raw && typeof raw === 'object' ? raw : { contacts: {} };
  state.contacts ??= {};

  for (const name of characterNames) {
    const key = String(name).toLowerCase();
    const starterKnown = Object.prototype.hasOwnProperty.call(starterKnownNumbers, key)
      ? Boolean(starterKnownNumbers[key])
      : key === 'jake';
    if (!state.contacts[key]) {
      state.contacts[key] = { hasNumber: starterKnown };
    } else if (typeof state.contacts[key].hasNumber !== 'boolean') {
      state.contacts[key].hasNumber = starterKnown;
    }
  }

  return state;
}

function chooseNextSpeaker(candidates, previousSpeaker) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  const filtered = candidates.filter((name) => String(name).toLowerCase() !== String(previousSpeaker || '').toLowerCase());
  return pickRandom(filtered.length ? filtered : candidates);
}

function buildInSceneSet(activeCharacters) {
  const set = new Set();
  for (const raw of toArray(activeCharacters)) {
    const key = String(raw || '').trim().toLowerCase();
    if (!key || key === 'you') continue;
    set.add(key);
  }
  return set;
}

function isReplyPromptText(text) {
  const source = String(text || '').trim();
  if (!source) return false;
  if (source.includes('?')) return true;
  if (/\b(let me know|text me back|reply when|tell me|what do you think)\b/i.test(source)) return true;
  if (/\b(can|could|would|will|are|do|did)\s+you\b/i.test(source)) return true;
  if (/\byou\s+free\b/i.test(source)) return true;
  return false;
}

function isThreadAwaitingUserReply(thread) {
  const messages = Array.isArray(thread?.messages) ? thread.messages : [];
  if (!messages.length) return false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const from = String(messages[i]?.from || '').trim().toLowerCase();
    if (!from || from === 'system') continue;
    if (from === 'you') return false;
    return isReplyPromptText(messages[i]?.text);
  }
  return false;
}

module.exports = {
  toArray,
  nowIso,
  createId,
  pickRandom,
  randomInt,
  normalizeParticipants,
  buildThreadTitle,
  normalizeReceipt,
  normalizeImageAttachment,
  advanceThreadReceipts,
  buildPresenceTextForThread,
  markPresence,
  findStoryContactUnlocks,
  detectStoryPhoneHook,
  choosePhotoSpritePath,
  chooseHookTargets,
  pickAutoResponders,
  parsePlainReply,
  normalizeContactsState,
  chooseNextSpeaker,
  buildInSceneSet,
  isReplyPromptText,
  isThreadAwaitingUserReply,
};
