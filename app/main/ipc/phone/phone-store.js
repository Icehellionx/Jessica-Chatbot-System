'use strict';

function createPhoneStore({ readJsonSafe, writeJsonSafe, phoneThreadsPath, phoneContactsPath, fs, path, botFilesPath }) {
  function loadThreads() {
    return readJsonSafe(phoneThreadsPath, { threads: [], meta: {} });
  }

  function saveThreads(data) {
    return writeJsonSafe(phoneThreadsPath, data);
  }

  function loadContacts() {
    const raw = readJsonSafe(phoneContactsPath, { contacts: {} });
    return raw && typeof raw === 'object' ? raw : { contacts: {} };
  }

  function saveContacts(data) {
    return writeJsonSafe(phoneContactsPath, data);
  }

  function listCharacterFolders() {
    try {
      const dir = path.join(botFilesPath, 'characters');
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      return [];
    }
  }

  function loadPhoneConfig() {
    const filePath = path.join(botFilesPath, 'phone.json');
    const raw = readJsonSafe(filePath, {});
    return raw && typeof raw === 'object' ? raw : {};
  }

  function loadStarterKnownNumbers() {
    const raw = loadPhoneConfig();
    const source = raw.starterKnownNumbers;
    if (!source || typeof source !== 'object') return {};
    const out = {};
    for (const [key, value] of Object.entries(source)) {
      const cleanKey = String(key || '').trim().toLowerCase();
      if (!cleanKey) continue;
      out[cleanKey] = Boolean(value);
    }
    return out;
  }

  function listCharacterSpriteFiles(characterName) {
    const clean = String(characterName || '').trim();
    if (!clean) return [];
    try {
      const dir = path.join(botFilesPath, 'characters', clean);
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isFile())
        .map((d) => d.name)
        .filter((name) => /\.(png|jpg|jpeg|webp|gif)$/i.test(name))
        .map((name) => `characters/${clean}/${name}`);
    } catch {
      return [];
    }
  }

  return {
    loadThreads,
    saveThreads,
    loadContacts,
    saveContacts,
    listCharacterFolders,
    loadPhoneConfig,
    loadStarterKnownNumbers,
    listCharacterSpriteFiles,
  };
}

module.exports = {
  createPhoneStore,
};
