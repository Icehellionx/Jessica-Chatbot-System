'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { registerPhoneHandlers } = require('../app/main/ipc/handlers-phone');
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

test('phone handlers can create and list threads', async () => {
  const { ipcMain, handlers } = createIpcMainMock();
  let threadsFile = { threads: [] };
  let contactsFile = { contacts: { jessica: { hasNumber: true } } };

  registerPhoneHandlers({
    ipcMain,
    aiService: { generateCompletion: async () => 'ok' },
    loadConfig: () => ({}),
    readJsonSafe: (filePath, fallback) => {
      if (filePath === 'threads.json') return threadsFile;
      if (filePath === 'contacts.json') return contactsFile;
      return fallback;
    },
    writeJsonSafe: (filePath, data) => {
      if (filePath === 'threads.json') threadsFile = data;
      if (filePath === 'contacts.json') contactsFile = data;
      return true;
    },
    readTextSafe: () => '',
    phoneThreadsPath: 'threads.json',
    phoneContactsPath: 'contacts.json',
    botFilesPath: 'bot/files',
    fs: {
      existsSync: () => true,
      readdirSync: () => [{ name: 'Jessica', isDirectory: () => true }],
    },
    path,
    trace,
  });

  const create = handlers.get('phone-create-thread');
  const list = handlers.get('phone-list-threads');

  const created = create({}, { title: 'Test', participants: ['You', 'Jessica'] });
  assert.equal(created.ok, true);
  assert.equal(created.data.title, 'Test');

  const listed = list();
  assert.equal(listed.ok, true);
  assert.equal(listed.data.length, 1);
  assert.equal(listed.data[0].title, 'Test');
});

test('phone-get-contacts defaults to only Jake known at start', () => {
  const { ipcMain, handlers } = createIpcMainMock();
  let contactsFile = { contacts: {} };

  registerPhoneHandlers({
    ipcMain,
    aiService: { generateCompletion: async () => 'ok' },
    loadConfig: () => ({}),
    readJsonSafe: (filePath, fallback) => {
      if (filePath === 'contacts.json') return contactsFile;
      if (filePath === 'threads.json') return { threads: [] };
      return fallback;
    },
    writeJsonSafe: (filePath, data) => {
      if (filePath === 'contacts.json') contactsFile = data;
      return true;
    },
    readTextSafe: () => '',
    phoneThreadsPath: 'threads.json',
    phoneContactsPath: 'contacts.json',
    botFilesPath: 'bot/files',
    fs: {
      existsSync: () => true,
      readdirSync: () => [
        { name: 'Jake', isDirectory: () => true },
        { name: 'Jessica', isDirectory: () => true },
      ],
    },
    path,
    trace,
  });

  const getContacts = handlers.get('phone-get-contacts');
  const result = getContacts();
  assert.equal(result.ok, true);
  const jake = result.data.find((c) => c.name === 'Jake');
  const jessica = result.data.find((c) => c.name === 'Jessica');
  assert.equal(Boolean(jake?.hasNumber), true);
  assert.equal(Boolean(jessica?.hasNumber), false);
});

test('phone-poll-updates can create inbound group thread', async () => {
  const { ipcMain, handlers } = createIpcMainMock();
  let threadsFile = { threads: [], meta: {} };
  let contactsFile = { contacts: { jake: { hasNumber: true }, jessica: { hasNumber: true } } };

  registerPhoneHandlers({
    ipcMain,
    aiService: { generateCompletion: async () => 'Anyone free tonight?' },
    loadConfig: () => ({}),
    readJsonSafe: (filePath, fallback) => {
      if (filePath === 'threads.json') return threadsFile;
      if (filePath === 'contacts.json') return contactsFile;
      return fallback;
    },
    writeJsonSafe: (filePath, data) => {
      if (filePath === 'threads.json') threadsFile = data;
      if (filePath === 'contacts.json') contactsFile = data;
      return true;
    },
    readTextSafe: () => '',
    phoneThreadsPath: 'threads.json',
    phoneContactsPath: 'contacts.json',
    botFilesPath: 'bot/files',
    fs: {
      existsSync: () => true,
      readdirSync: () => [
        { name: 'Jake', isDirectory: () => true },
        { name: 'Jessica', isDirectory: () => true },
      ],
    },
    path,
    trace,
  });

  const poll = handlers.get('phone-poll-updates');
  const result = await poll({}, { force: true, action: 'new-group' });
  assert.equal(result.ok, true);
  assert.ok(result.data.createdThreads >= 1);
  assert.ok(result.data.incomingMessages >= 1);
  assert.equal(threadsFile.threads.length >= 1, true);
});

test('phone-reset-state clears thread history and reapplies starter contact defaults', () => {
  const { ipcMain, handlers } = createIpcMainMock();
  let threadsFile = {
    threads: [
      {
        id: 'thread_1',
        title: 'Jessica',
        participants: ['You', 'Jessica'],
        messages: [{ id: 'msg_1', from: 'Jessica', text: 'hi', timestamp: new Date().toISOString() }],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        unreadCount: 1,
      },
    ],
    meta: { lastPollAt: Date.now() },
  };
  let contactsFile = {
    contacts: {
      jake: { hasNumber: true },
      jessica: { hasNumber: true },
    },
  };

  registerPhoneHandlers({
    ipcMain,
    aiService: { generateCompletion: async () => 'ok' },
    loadConfig: () => ({}),
    readJsonSafe: (filePath, fallback) => {
      if (filePath === 'threads.json') return threadsFile;
      if (filePath === 'contacts.json') return contactsFile;
      if (filePath === path.join('bot/files', 'phone.json')) {
        return { starterKnownNumbers: { jake: true, jessica: false } };
      }
      return fallback;
    },
    writeJsonSafe: (filePath, data) => {
      if (filePath === 'threads.json') threadsFile = data;
      if (filePath === 'contacts.json') contactsFile = data;
      return true;
    },
    readTextSafe: () => '',
    phoneThreadsPath: 'threads.json',
    phoneContactsPath: 'contacts.json',
    botFilesPath: 'bot/files',
    fs: {
      existsSync: () => true,
      readdirSync: () => [
        { name: 'Jake', isDirectory: () => true },
        { name: 'Jessica', isDirectory: () => true },
      ],
    },
    path,
    trace,
  });

  const reset = handlers.get('phone-reset-state');
  const result = reset();
  assert.equal(result.ok, true);
  assert.equal(threadsFile.threads.length, 0);
  assert.equal(Boolean(contactsFile.contacts.jake?.hasNumber), true);
  assert.equal(Boolean(contactsFile.contacts.jessica?.hasNumber), false);
});

test('phone-poll-updates pauses thread when latest inbound asks for user reply', async () => {
  const { ipcMain, handlers } = createIpcMainMock();
  let threadsFile = {
    threads: [
      {
        id: 'thread_waiting',
        title: 'Jessica',
        participants: ['You', 'Jessica'],
        messages: [
          { id: 'm1', from: 'Jessica', text: 'Are you still coming tonight?', timestamp: new Date().toISOString() },
        ],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        unreadCount: 1,
      },
    ],
    meta: {},
  };
  let contactsFile = { contacts: { jessica: { hasNumber: true } } };

  registerPhoneHandlers({
    ipcMain,
    aiService: { generateCompletion: async () => 'Ping again' },
    loadConfig: () => ({}),
    readJsonSafe: (filePath, fallback) => {
      if (filePath === 'threads.json') return threadsFile;
      if (filePath === 'contacts.json') return contactsFile;
      return fallback;
    },
    writeJsonSafe: (filePath, data) => {
      if (filePath === 'threads.json') threadsFile = data;
      if (filePath === 'contacts.json') contactsFile = data;
      return true;
    },
    readTextSafe: () => '',
    phoneThreadsPath: 'threads.json',
    phoneContactsPath: 'contacts.json',
    botFilesPath: 'bot/files',
    fs: {
      existsSync: () => true,
      readdirSync: () => [{ name: 'Jessica', isDirectory: () => true }],
    },
    path,
    trace,
  });

  const poll = handlers.get('phone-poll-updates');
  const result = await poll({}, { force: true, action: 'message' });
  assert.equal(result.ok, true);
  assert.equal(Number(result.data.incomingMessages || 0), 0);
  assert.equal(threadsFile.threads[0].messages.length, 1);
});

test('phone-poll-updates blocks texts from characters currently in scene', async () => {
  const { ipcMain, handlers } = createIpcMainMock();
  let threadsFile = { threads: [], meta: {} };
  let contactsFile = { contacts: { jessica: { hasNumber: true } } };

  registerPhoneHandlers({
    ipcMain,
    aiService: { generateCompletion: async () => 'Hey from phone' },
    loadConfig: () => ({}),
    readJsonSafe: (filePath, fallback) => {
      if (filePath === 'threads.json') return threadsFile;
      if (filePath === 'contacts.json') return contactsFile;
      return fallback;
    },
    writeJsonSafe: (filePath, data) => {
      if (filePath === 'threads.json') threadsFile = data;
      if (filePath === 'contacts.json') contactsFile = data;
      return true;
    },
    readTextSafe: () => '',
    phoneThreadsPath: 'threads.json',
    phoneContactsPath: 'contacts.json',
    botFilesPath: 'bot/files',
    fs: {
      existsSync: () => true,
      readdirSync: () => [{ name: 'Jessica', isDirectory: () => true }],
    },
    path,
    trace,
  });

  const poll = handlers.get('phone-poll-updates');
  const result = await poll({}, {
    force: true,
    action: 'new-dm',
    activeCharacters: ['Jessica'],
  });
  assert.equal(result.ok, true);
  assert.equal(Number(result.data.incomingMessages || 0), 0);
  assert.equal(threadsFile.threads.length, 0);
});
