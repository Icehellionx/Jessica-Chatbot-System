'use strict';

function estimateTokensFromMessageContent(content) {
  if (content == null) return 0;

  if (typeof content === 'string') return Math.ceil(content.length / 4);

  if (Array.isArray(content)) {
    let chars = 0;
    for (const c of content) {
      if (c?.type === 'text' && typeof c.text === 'string') chars += c.text.length;
      if (c?.type === 'image_url') chars += 200;
    }
    return Math.ceil(chars / 4);
  }

  return Math.ceil(String(content).length / 4);
}

function estimateTokensForMessages(messages) {
  return messages.reduce((sum, m) => sum + estimateTokensFromMessageContent(m?.content), 0);
}

function applyContextWindow(messages, { maxContext, systemSuffix }) {
  const copy = structuredClone(messages);

  const sysIndex = copy.findIndex((m) => m.role === 'system');
  const sysMsg = sysIndex > -1 ? copy[sysIndex] : null;

  const baseSysTokens = sysMsg ? estimateTokensFromMessageContent(sysMsg.content) : 0;
  const suffixTokens = Math.ceil(systemSuffix.length / 4);
  const reserve = 1000;
  const available = Math.max(0, (maxContext ?? 128000) - baseSysTokens - suffixTokens - reserve);

  const history = copy.filter((_, i) => i !== sysIndex);
  const kept = [];

  let used = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const msgTokens = estimateTokensFromMessageContent(history[i]?.content);
    if (used + msgTokens <= available) {
      kept.unshift(history[i]);
      used += msgTokens;
    } else {
      break;
    }
  }

  const out = [];
  if (sysMsg) out.push(sysMsg);
  out.push(...kept);

  const outSysIndex = out.findIndex((m) => m.role === 'system');
  if (outSysIndex > -1) {
    out[outSysIndex].content = String(out[outSysIndex].content ?? '') + systemSuffix;
  } else {
    out.unshift({ role: 'system', content: systemSuffix });
  }

  return out;
}

module.exports = {
  estimateTokensFromMessageContent,
  estimateTokensForMessages,
  applyContextWindow,
};
