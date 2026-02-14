'use strict';

function registerChatHandlers({
  ipcMain,
  chatStorage,
  readJsonSafe,
  writeJsonSafe,
  characterStatePath,
  lorebookPath,
  currentChatPath,
  trace,
}) {
  ipcMain.handle('save-chat', (_event, name, messages) => {
    const t = trace.createTrace('save-chat');
    const payload = {
      messages,
      characterState: readJsonSafe(characterStatePath, {}),
      lorebook: readJsonSafe(lorebookPath, []),
      timestamp: Date.now(),
    };
    return trace.ok(t, chatStorage.save(name, payload));
  });

  ipcMain.handle('get-chats', () => {
    const t = trace.createTrace('get-chats');
    return trace.ok(t, chatStorage.list());
  });

  ipcMain.handle('load-chat', (_event, name) => {
    const t = trace.createTrace('load-chat');
    const data = chatStorage.load(name);

    // New format
    if (data && data.messages) {
      if (data.characterState) writeJsonSafe(characterStatePath, data.characterState);
      if (data.lorebook) writeJsonSafe(lorebookPath, data.lorebook);
      return trace.ok(t, data.messages);
    }

    // Legacy format: raw array of messages
    return trace.ok(t, Array.isArray(data) ? data : []);
  });

  ipcMain.handle('save-current-chat', (_e, d) => {
    const t = trace.createTrace('save-current-chat');
    return trace.ok(t, writeJsonSafe(currentChatPath, d));
  });
  ipcMain.handle('load-current-chat', () => {
    const t = trace.createTrace('load-current-chat');
    return trace.ok(t, readJsonSafe(currentChatPath, {}));
  });
}

module.exports = { registerChatHandlers };
