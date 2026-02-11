const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    getConfig: () => ipcRenderer.invoke('get-config'),
    saveApiKey: (provider, key, model, baseUrl) => ipcRenderer.invoke('save-api-key', provider, key, model, baseUrl),
    getBotInfo: () => ipcRenderer.invoke('get-bot-info'),
    deleteApiKey: (provider) => ipcRenderer.invoke('delete-api-key', provider),
    sendChat: (messages, options) => ipcRenderer.invoke('send-chat', messages, options),
    saveChat: (name, messages) => ipcRenderer.invoke('save-chat', name, messages),
    getChats: () => ipcRenderer.invoke('get-chats'),
    loadChat: (name) => ipcRenderer.invoke('load-chat', name),
    scanImages: () => ipcRenderer.invoke('scan-images'),
    savePersona: (persona) => ipcRenderer.invoke('save-persona', persona),
    getPersona: () => ipcRenderer.invoke('get-persona'),
    getAdvancedPrompt: () => ipcRenderer.invoke('get-advanced-prompt'),
    saveAdvancedPrompt: (prompt) => ipcRenderer.invoke('save-advanced-prompt', prompt),
    saveTemperature: (temp) => ipcRenderer.invoke('save-temperature', temp),
    saveMaxContext: (limit) => ipcRenderer.invoke('save-max-context', limit),
    setActiveProvider: (provider) => ipcRenderer.invoke('set-active-provider', provider),
    saveSummary: (summary) => ipcRenderer.invoke('save-summary', summary),
    getSummary: () => ipcRenderer.invoke('get-summary'),
    getLorebook: () => ipcRenderer.invoke('get-lorebook'),
    saveLorebook: (content) => ipcRenderer.invoke('save-lorebook', content),
    getImages: () => ipcRenderer.invoke('get-images'),
    getImageManifest: () => ipcRenderer.invoke('get-image-manifest'),
    saveCurrentChat: (data) => ipcRenderer.invoke('save-current-chat', data),
    clearVoiceMap: () => ipcRenderer.invoke('clear-voice-map'),
    getVoiceMap: () => ipcRenderer.invoke('get-voice-map'),
    saveVoiceMap: (map) => ipcRenderer.invoke('save-voice-map', map),
    scanVoiceBuckets: () => ipcRenderer.invoke('scan-voice-buckets'),
    loadCurrentChat: () => ipcRenderer.invoke('load-current-chat'),
    testProvider: () => ipcRenderer.invoke('test-provider'),
    generateSpeech: (text, voiceId, forcedSpeakerId) => ipcRenderer.invoke('generate-speech', text, voiceId, forcedSpeakerId),
    generateImage: (prompt, type) => ipcRenderer.invoke('generate-image', prompt, type),
    onChatReplyChunk: (callback) => {
        const subscription = (event, chunk) => callback(chunk);
        ipcRenderer.on('chat-reply-chunk', subscription);
        return () => ipcRenderer.removeListener('chat-reply-chunk', subscription);
    },
    evolveCharacterState: (messages, activeChars) => ipcRenderer.invoke('evolve-character-state', messages, activeChars)
});