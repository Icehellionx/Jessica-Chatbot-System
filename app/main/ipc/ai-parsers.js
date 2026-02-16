'use strict';

function parseOpenAISSEChunk(chunkStr, onToken) {
  const lines = chunkStr.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data: ')) continue;

    const payload = trimmed.slice(6);
    if (payload === '[DONE]') continue;

    const data = JSON.parse(payload);
    const token = data?.choices?.[0]?.delta?.content;
    if (typeof token === 'string' && token.length) {
      onToken(token);
    }
  }
}

function createOpenAISSEParser(onToken) {
  let carry = '';

  return function feed(chunkStr) {
    carry += chunkStr;
    const lines = carry.split('\n');
    carry = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data: ')) continue;

      const payload = trimmed.slice(6).trim();
      if (!payload || payload === '[DONE]') continue;

      try {
        parseOpenAISSEChunk(`data: ${payload}\n`, onToken);
      } catch {
        // Keep streaming resilient; malformed lines are ignored.
      }
    }
  };
}

function createGeminiJsonObjectExtractor(onJsonObject) {
  let buffer = '';

  return function feed(chunkStr) {
    buffer += chunkStr;

    let braceCount = 0;
    let startIndex = 0;
    let inString = false;
    let escape = false;

    for (let i = 0; i < buffer.length; i++) {
      const ch = buffer[i];

      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;

      if (ch === '{') {
        if (braceCount === 0) startIndex = i;
        braceCount++;
      } else if (ch === '}') {
        braceCount--;
        if (braceCount === 0) {
          const jsonStr = buffer.slice(startIndex, i + 1);

          try {
            onJsonObject(JSON.parse(jsonStr));
          } catch {
            // Ignore malformed chunks.
          }

          buffer = buffer.slice(i + 1);
          i = -1;
        }
      }
    }
  };
}

function parseFirstJsonObject(text) {
  const raw = String(text || '');
  const objectStart = raw.indexOf('{');
  const arrayStart = raw.indexOf('[');
  const hasObject = objectStart !== -1;
  const hasArray = arrayStart !== -1;
  if (!hasObject && !hasArray) return null;

  const start = hasObject && hasArray ? Math.min(objectStart, arrayStart) : (hasObject ? objectStart : arrayStart);
  const open = raw[start];
  const close = open === '{' ? '}' : ']';

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === open) depth++;
    if (ch === close) {
      depth--;
      if (depth === 0) {
        const candidate = raw.slice(start, i + 1);
        try {
          return JSON.parse(candidate);
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function parseTagLines(text) {
  if (!text) return null;
  const matches = String(text).match(/\[(BG|SPRITE|SPLASH|MUSIC|HIDE|FX|SFX|CAMERA|TAKE|DROP|ADD_OBJECT):[^\]]+\]/gi);
  return matches && matches.length ? matches.join('\n') : null;
}

function normalizeActionType(rawType) {
  const type = String(rawType || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  const map = {
    background: 'bg',
    bg: 'bg',
    music: 'music',
    sprite: 'sprite',
    hide: 'hide',
    sfx: 'sfx',
    fx: 'fx',
    camera: 'camera',
    take: 'take',
    drop: 'drop',
    add_object: 'add_object',
  };
  return map[type] || '';
}

function toTagPlanFromJson(plan) {
  if (!plan || !Array.isArray(plan.actions)) return null;
  const lines = [];
  for (const action of plan.actions) {
    const type = normalizeActionType(action?.type);
    if (!type) continue;

    if (type === 'bg' && action.name) lines.push(`[BG: ${String(action.name).trim()}]`);
    if (type === 'music' && action.name) lines.push(`[MUSIC: ${String(action.name).trim()}]`);
    if (type === 'sprite') {
      const name = String(action.character || action.name || '').trim();
      const emotion = String(action.emotion || 'default').trim();
      if (name) lines.push(`[SPRITE: ${name}/${emotion}]`);
    }
    if (type === 'hide' && action.character) lines.push(`[HIDE: ${String(action.character).trim()}]`);
    if (type === 'sfx' && action.name) lines.push(`[SFX: ${String(action.name).trim()}]`);
    if (type === 'fx' && action.name) lines.push(`[FX: ${String(action.name).trim()}]`);
    if (type === 'camera') {
      const mode = String(action.mode || action.action || 'zoom_in').trim();
      const target = String(action.target || action.character || '').trim();
      if (target) lines.push(`[CAMERA: ${mode}, ${target}]`);
    }
    if (type === 'take' && action.item) lines.push(`[TAKE: ${String(action.item).trim()}]`);
    if (type === 'drop' && action.item) lines.push(`[DROP: ${String(action.item).trim()}]`);
    if (type === 'add_object' && action.item) lines.push(`[ADD_OBJECT: ${String(action.item).trim()}]`);
  }
  return lines.length ? lines.join('\n') : null;
}

module.exports = {
  parseOpenAISSEChunk,
  createOpenAISSEParser,
  createGeminiJsonObjectExtractor,
  parseFirstJsonObject,
  parseTagLines,
  normalizeActionType,
  toTagPlanFromJson,
};
