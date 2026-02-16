'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function loadBrowserModule(filePath, exportedNames) {
  let src = fs.readFileSync(filePath, 'utf8');
  src = src.replace(/export function\s+/g, 'function ');
  src += `\nmodule.exports = { ${exportedNames.join(', ')} };`;

  const module = { exports: {} };
  const fn = new Function('module', 'exports', src);
  fn(module, module.exports);
  return module.exports;
}

const directiveToolsPath = path.join(__dirname, '..', 'app', 'renderer', 'modules', 'directive-tools.js');
const sidecarControllerPath = path.join(__dirname, '..', 'app', 'renderer', 'modules', 'sidecar-controller.js');

const { mergeDirectives, hasVisualDirectives, getRecentMessagesForDirector } = loadBrowserModule(directiveToolsPath, [
  'mergeDirectives',
  'hasVisualDirectives',
  'getRecentMessagesForDirector',
]);
const { createSidecarController } = loadBrowserModule(sidecarControllerPath, ['createSidecarController']);

test('mergeDirectives appends missing directives but avoids duplicate sprite directives', () => {
  const primary = '[SCENE][SPRITE: "characters/jessica/happy.png"][/SCENE]\nJessica: "Hi."';
  const sidecar = '[BG: "backgrounds/cafe.png"]\n[SPRITE: "characters/jessica/sad.png"]\n[FX: "shake"]';

  const merged = mergeDirectives(primary, sidecar);

  assert.match(merged, /\[BG:\s*"backgrounds\/cafe\.png"\]/);
  assert.match(merged, /\[FX:\s*"shake"\]/);
  assert.equal((merged.match(/\[SPRITE:/g) || []).length, 1);
});

test('handleStalledConversation generates system event and persists state', async () => {
  const setGeneratingCalls = [];
  const appendSystemCalls = [];
  const appendCalls = [];
  let saveCalls = 0;
  let refocusCalls = 0;

  const windowObj = {
    messages: [{ role: 'user', content: '...' }, { role: 'user', content: '...' }],
    api: {
      generateDynamicEvent: async () => 'Thunder rumbles in the distance.',
    },
    processVisualTags: () => ({ missing: [] }),
    refocusInput: () => { refocusCalls++; },
    getActiveSpriteNames: () => ['jessica'],
  };
  const useStore = {
    getState: () => ({ currentBackground: 'backgrounds/cafe.png' }),
  };

  const controller = createSidecarController({
    windowObj,
    documentObj: { getElementById: () => null },
    useStore,
    hasVisualDirectives,
    getRecentMessagesForDirector,
    mergeDirectives,
    appendSystemNotice: (text) => appendSystemCalls.push(text),
    appendMessage: (...args) => appendCalls.push(args),
    handleMissingVisuals: async () => {},
    saveCurrentChatState: async () => { saveCalls++; },
    setGeneratingState: (value) => setGeneratingCalls.push(value),
    getTurnCount: () => 1,
    updateHistorySummary: async () => {},
    visualHandlers: {},
  });

  const result = await controller.handleStalledConversation();

  assert.equal(result, true);
  assert.deepEqual(setGeneratingCalls, [true, false]);
  assert.equal(appendSystemCalls[0], 'The air hangs heavy with silence. What happens next?');
  assert.equal(appendCalls.length, 1);
  assert.equal(appendCalls[0][0], 'system');
  assert.match(appendCalls[0][1], /^\*\sThunder rumbles/);
  assert.equal(windowObj.messages[windowObj.messages.length - 1].role, 'system');
  assert.match(windowObj.messages[windowObj.messages.length - 1].content, /^\[SCENE EVENT\]/);
  assert.equal(saveCalls, 1);
  assert.equal(refocusCalls, 1);
});

test('runSidecarEnhancements applies directives and triggers post-response hooks', async () => {
  const objectiveEl = { textContent: '' };
  const affinityEl = { textContent: '' };
  let evolveCalls = 0;
  let summaryCalls = 0;

  const windowObj = {
    messages: [{ role: 'assistant', content: 'Narration only' }],
    getActiveSpriteNames: () => ['jessica'],
    processVisualTags: () => ({ missing: [] }),
    api: {
      getConfig: async () => ({ directorMode: 'fallback' }),
      getStageDirections: async () => '[BG: "backgrounds/cafe.png"]',
      getQuestObjective: async () => 'Find the key',
      getAffinity: async () => ({ status: 'Warm', score: 80 }),
      extractUserFacts: async () => [],
      getLorebook: async () => [],
      saveLorebook: async () => {},
      reviewVisuals: async () => '',
      evolveCharacterState: async () => { evolveCalls++; return { updated: true }; },
    },
  };
  const useStore = {
    getState: () => ({
      currentBackground: 'backgrounds/street.png',
      currentMusic: 'music/theme.mp3',
      inventory: [],
      sceneObjects: [],
    }),
  };

  const controller = createSidecarController({
    windowObj,
    documentObj: {
      getElementById: (id) => {
        if (id === 'hud-objective') return objectiveEl;
        if (id === 'hud-affinity') return affinityEl;
        return null;
      },
    },
    useStore,
    hasVisualDirectives,
    getRecentMessagesForDirector,
    mergeDirectives,
    appendSystemNotice: () => {},
    appendMessage: () => {},
    handleMissingVisuals: async () => {},
    saveCurrentChatState: async () => {},
    setGeneratingState: () => {},
    getTurnCount: () => 10,
    updateHistorySummary: () => { summaryCalls++; },
    visualHandlers: {},
  });

  await controller.runSidecarEnhancements({ content: 'Narration only', report: '', cancelled: false }, ['jessica']);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.match(windowObj.messages[windowObj.messages.length - 1].content, /\[SCENE\]/);
  assert.equal(evolveCalls, 1);
  assert.equal(summaryCalls, 1);
  assert.equal(objectiveEl.textContent, 'Objective: Find the key');
  assert.equal(affinityEl.textContent, 'Affinity: Warm (80%)');
});
