'use strict';

export function hasVisualDirectives(text) {
  return /\[(BG|SPRITE|SPLASH|MUSIC|HIDE|FX|SFX|CAMERA|TAKE|DROP|ADD_OBJECT):/i.test(String(text || ''));
}

export function getRecentMessagesForDirector(messages, limit = 6) {
  return (messages || [])
    .slice(-limit)
    .map((m) => ({ role: m.role, content: String(m.content || '').slice(0, 500) }));
}

export function mergeDirectives(primaryContent, sidecarTags) {
  if (!sidecarTags) return primaryContent;

  const primaryHas = {
    bg: /\[BG:/i.test(primaryContent),
    music: /\[MUSIC:/i.test(primaryContent),
    splash: /\[SPLASH:/i.test(primaryContent),
    sprites: /\[SPRITE:/i.test(primaryContent)
  };

  const sidecarLines = sidecarTags.split('\n').map((l) => l.trim()).filter((l) => l);
  const toAppend = [];

  for (const line of sidecarLines) {
    if (/\[BG:/i.test(line) && !primaryHas.bg) toAppend.push(line);
    else if (/\[MUSIC:/i.test(line) && !primaryHas.music) toAppend.push(line);
    else if (/\[SPLASH:/i.test(line) && !primaryHas.splash) toAppend.push(line);
    else if (/\[SPRITE:/i.test(line) && !primaryHas.sprites) toAppend.push(line);
    else if (/\[(FX|SFX|CAMERA):/i.test(line)) toAppend.push(line);
  }

  if (toAppend.length === 0) return primaryContent;

  return primaryContent + `\n[SCENE]${toAppend.join(' ')}[/SCENE]`;
}
