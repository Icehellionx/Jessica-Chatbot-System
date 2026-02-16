'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

function makeEl() {
  return {
    classList: { add() {}, remove() {}, contains() { return false; } },
    style: {},
    appendChild() {},
    querySelector() { return null; },
    remove() {},
    getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0 }; },
    set innerHTML(_) {},
    get innerHTML() { return ''; },
  };
}

function bootstrapVisuals() {
  global.window = {
    imageManifest: {
      backgrounds: { 'backgrounds/cafe.png': 'Cafe' },
      sprites: {
        'characters/jessica/happy.png': 'Jessica happy',
        'characters/jessica/sad.png': 'Jessica sad',
        'characters/jessica/default.png': 'Jessica default',
      },
      splash: { 'splash/opening.png': 'Opening splash' },
      music: { 'music/theme.mp3': 'Theme' },
    },
  };

  global.document = {
    getElementById() { return null; },
    createElement() { return makeEl(); },
    querySelectorAll() { return []; },
    addEventListener() {},
    body: { appendChild() {} },
    head: { appendChild() {} },
  };

  global.requestAnimationFrame = (fn) => fn();
  global.setTimeout = setTimeout;
  global.clearTimeout = clearTimeout;

  delete require.cache[require.resolve('../app/renderer/visuals.js')];
  require('../app/renderer/visuals.js');
}

test('processVisualTags only executes tags inside [SCENE] block', () => {
  bootstrapVisuals();

  const calls = { bg: [] };
  const text = [
    '[SCENE]',
    '[BG: "backgrounds/cafe.png"]',
    '[/SCENE]',
    'Narration with fake tag [BG: "backgrounds/ignored.png"]',
  ].join('\n');

  const result = window.processVisualTags(text, {
    handlers: {
      onBg: (v) => calls.bg.push(v),
      onMusic: () => {},
      onSplash: () => {},
      onSprite: () => {},
      onHide: () => {},
    },
    store: {},
  });

  assert.deepEqual(calls.bg, ['backgrounds/cafe.png']);
  assert.equal(result.missing.length, 0);
});

test('processVisualTags enforces directive caps (max 2 sprite tags)', () => {
  bootstrapVisuals();

  const calls = { sprite: [] };
  const text = [
    '[SCENE]',
    '[SPRITE: "characters/jessica/happy.png"]',
    '[SPRITE: "characters/jessica/sad.png"]',
    '[SPRITE: "characters/jessica/default.png"]',
    '[/SCENE]',
  ].join('\n');

  window.processVisualTags(text, {
    handlers: {
      onBg: () => {},
      onMusic: () => {},
      onSplash: () => {},
      onSprite: (v) => calls.sprite.push(v),
      onHide: () => {},
    },
    store: {},
  });

  assert.equal(calls.sprite.length, 2);
  assert.deepEqual(calls.sprite, [
    'characters/jessica/happy.png',
    'characters/jessica/sad.png',
  ]);
});

test('processVisualTags reports missing assets for unresolved tags', () => {
  bootstrapVisuals();

  const text = [
    '[SCENE]',
    '[BG: "backgrounds/missing.png"]',
    '[/SCENE]',
  ].join('\n');

  const result = window.processVisualTags(text, {
    handlers: {
      onBg: () => {},
      onMusic: () => {},
      onSplash: () => {},
      onSprite: () => {},
      onHide: () => {},
    },
    store: {},
  });

  assert.equal(result.missing.length, 1);
  assert.equal(result.missing[0].type, 'bg');
});

test('stripVisualTags removes SCENE blocks and inline directives', () => {
  bootstrapVisuals();

  const raw = '[SCENE]\n[BG: "backgrounds/cafe.png"]\n[/SCENE]\nJessica: "Hello."\n[MUSIC: "music/theme.mp3"]';
  const stripped = window.stripVisualTags(raw);

  assert.equal(stripped, 'Jessica: "Hello."');
});
