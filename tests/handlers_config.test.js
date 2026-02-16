'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { registerConfigHandlers } = require('../app/main/ipc/handlers-config');
const trace = require('../app/main/ipc/trace');

function createIpcMainMock() {
  const handlers = new Map();
  return {
    handlers,
    ipcMain: {
      handle(name, fn) {
        handlers.set(name, fn);
      },
    },
  };
}

function baseDeps(overrides = {}) {
  return {
    loadConfig: () => ({}),
    saveConfig: () => true,
    toPublicConfig: (v) => v,
    readJsonSafe: (_p, fallback) => fallback,
    readTextSafe: (_p, fallback) => fallback,
    writeJsonSafe: () => true,
    personaPath: 'persona.json',
    summaryPath: 'summary.json',
    lorebookPath: 'lorebook.json',
    advancedPromptPath: 'advanced_prompt.txt',
    DEFAULT_PERSONA: { name: 'Jim', details: '' },
    DEFAULT_SUMMARY: { content: '' },
    trace,
    ...overrides,
  };
}

test('save-advanced-prompt returns explicit failure when writeTextSafe is missing', () => {
  const { ipcMain, handlers } = createIpcMainMock();
  registerConfigHandlers({ ipcMain, ...baseDeps() });

  const fn = handlers.get('save-advanced-prompt');
  const result = fn({}, 'prompt');

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'WRITE_TEXT_UNAVAILABLE');
});

test('save-advanced-prompt succeeds when writeTextSafe is provided', () => {
  const { ipcMain, handlers } = createIpcMainMock();
  let written = null;
  registerConfigHandlers({
    ipcMain,
    ...baseDeps({
      writeTextSafe: (filePath, text) => {
        written = { filePath, text };
        return true;
      },
    }),
  });

  const fn = handlers.get('save-advanced-prompt');
  const result = fn({}, 'new rules');

  assert.equal(result.ok, true);
  assert.deepEqual(written, { filePath: 'advanced_prompt.txt', text: 'new rules' });
});

test('open-external-url rejects non-http protocols', async () => {
  const { ipcMain, handlers } = createIpcMainMock();
  registerConfigHandlers({
    ipcMain,
    ...baseDeps({
      writeTextSafe: () => true,
    }),
  });

  const fn = handlers.get('open-external-url');
  const result = await fn({}, 'javascript:alert(1)');

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'INVALID_URL');
});

test('toggle-dev-tools toggles when no explicit open flag is provided', () => {
  const { ipcMain, handlers } = createIpcMainMock();
  let toggled = false;
  registerConfigHandlers({
    ipcMain,
    ...baseDeps({
      writeTextSafe: () => true,
    }),
  });

  const fn = handlers.get('toggle-dev-tools');
  const event = {
    sender: {
      toggleDevTools: () => { toggled = true; },
      openDevTools: () => {},
      closeDevTools: () => {},
    },
  };
  const result = fn(event);

  assert.equal(result.ok, true);
  assert.equal(toggled, true);
});
