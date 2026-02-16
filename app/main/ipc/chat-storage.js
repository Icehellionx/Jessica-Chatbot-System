'use strict';

function createChatStorage({ chatsPath, path, fs, sanitizeFilename, readJsonSafe, writeJsonSafe }) {
  function save(name, payload) {
    const safeName = sanitizeFilename(name);
    const chatPath = path.join(chatsPath, `${safeName}.json`);
    return writeJsonSafe(chatPath, payload);
  }

  function list() {
    try {
      return fs.readdirSync(chatsPath)
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.replace('.json', ''));
    } catch {
      return [];
    }
  }

  function load(name) {
    const safeName = sanitizeFilename(name);
    const chatPath = path.join(chatsPath, `${safeName}.json`);
    return readJsonSafe(chatPath, null);
  }

  return { save, list, load };
}

module.exports = { createChatStorage };
