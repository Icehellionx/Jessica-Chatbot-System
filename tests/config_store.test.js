'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createConfigStore } = require('../app/main/ipc/config-store');

function makeMemoryStore(initial = {}) {
  let mem = initial;
  return {
    readJsonSafe: () => mem,
    writeJsonSafe: (_path, value) => {
      mem = value;
      return true;
    },
    get: () => mem,
  };
}

test('config store saves encrypted keys and masks public config', () => {
  const memory = makeMemoryStore({});
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(`enc:${s}`, 'utf8'),
    decryptString: (buf) => {
      const raw = buf.toString('utf8');
      return raw.startsWith('enc:') ? raw.slice(4) : raw;
    },
  };

  const store = createConfigStore({
    configPath: 'fake.json',
    readJsonSafe: memory.readJsonSafe,
    writeJsonSafe: memory.writeJsonSafe,
    clone: (x) => structuredClone(x),
    safeStorage,
  });

  store.save({
    apiKeys: { openai: 'sk-test' },
    activeProvider: 'openai',
  });

  const written = memory.get();
  assert.equal(typeof written.apiKeysEncrypted.openai, 'string');
  assert.equal(written.apiKeys, undefined);

  const loaded = store.load();
  assert.equal(loaded.apiKeys.openai, 'sk-test');

  const publicCfg = store.toPublic(loaded);
  assert.equal(publicCfg.apiKeys.openai, '********');
  assert.equal(publicCfg.apiKeysEncrypted, undefined);
});

test('config store can load legacy plaintext apiKeys', () => {
  const memory = makeMemoryStore({
    apiKeys: { local: 'plaintext-key' },
    activeProvider: 'local',
  });

  const store = createConfigStore({
    configPath: 'fake.json',
    readJsonSafe: memory.readJsonSafe,
    writeJsonSafe: memory.writeJsonSafe,
    clone: (x) => structuredClone(x),
    safeStorage: { isEncryptionAvailable: () => false },
  });

  const loaded = store.load();
  assert.equal(loaded.apiKeys.local, 'plaintext-key');
  assert.equal(loaded.activeProvider, 'local');
});
