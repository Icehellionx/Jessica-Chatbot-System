'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { sanitizeFilename } = require('../ipc/sanitize');
const { createChatStorage } = require('../ipc/chat-storage');

test('sanitizeFilename strips traversal and unsafe characters', () => {
  assert.equal(sanitizeFilename('../My Chat:../../evil?.json'), '___my_chat_______evil__json');
  assert.equal(sanitizeFilename(''), 'chat');
});

test('chat storage load/save stays inside chatsPath after sanitization', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jessica-chat-test-'));

  try {
    const chatsPath = path.join(tempRoot, 'chats');
    fs.mkdirSync(chatsPath, { recursive: true });

    const chatStorage = createChatStorage({
      chatsPath,
      path,
      fs,
      sanitizeFilename,
      readJsonSafe: (filePath, fallback) => {
        try {
          if (!fs.existsSync(filePath)) return fallback;
          return JSON.parse(fs.readFileSync(filePath, 'utf8'));
        } catch {
          return fallback;
        }
      },
      writeJsonSafe: (filePath, data) => {
        fs.writeFileSync(filePath, JSON.stringify(data), 'utf8');
        return true;
      },
    });

    const payload = { messages: [{ role: 'user', content: 'hi' }] };
    chatStorage.save('../escape-attempt', payload);

    const expectedPath = path.join(chatsPath, `${sanitizeFilename('../escape-attempt')}.json`);
    assert.equal(fs.existsSync(expectedPath), true);
    assert.deepEqual(chatStorage.load('../escape-attempt'), payload);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
