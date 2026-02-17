const { contextBridge, ipcRenderer } = require('electron');

function isIpcEnvelope(value) {
    return Boolean(value) && typeof value === 'object' && typeof value.ok === 'boolean' && value.meta && value.meta.correlationId;
}

async function invokeSafe(channel, ...args) {
    const result = await ipcRenderer.invoke(channel, ...args);
    if (!isIpcEnvelope(result)) return result;

    if (result.ok) return result.data;

    const message = result?.error?.message || 'Operation failed.';
    const err = new Error(message);
    err.code = result?.error?.code || 'IPC_ERROR';
    err.correlationId = result?.meta?.correlationId || null;
    err.details = result?.error?.details ?? null;
    throw err;
}

contextBridge.exposeInMainWorld('api', {
    getConfig: () => invokeSafe('get-config'),
    saveApiKey: (provider, key, model, baseUrl) => invokeSafe('save-api-key', provider, key, model, baseUrl),
    getBotInfo: () => invokeSafe('get-bot-info'),
    deleteApiKey: (provider) => invokeSafe('delete-api-key', provider),
    sendChat: (messages, options) => invokeSafe('send-chat', messages, options),
    saveChat: (name, messages) => invokeSafe('save-chat', name, messages),
    getChats: () => invokeSafe('get-chats'),
    loadChat: (name) => invokeSafe('load-chat', name),
    scanImages: () => invokeSafe('scan-images'),
    savePersona: (persona) => invokeSafe('save-persona', persona),
    getPersona: () => invokeSafe('get-persona'),
    getAdvancedPrompt: () => invokeSafe('get-advanced-prompt'),
    saveAdvancedPrompt: (prompt) => invokeSafe('save-advanced-prompt', prompt),
    saveTemperature: (temp) => invokeSafe('save-temperature', temp),
    saveMaxContext: (limit) => invokeSafe('save-max-context', limit),
    savePollinationsKey: (key) => invokeSafe('save-pollinations-key', key),
    openExternalUrl: (url) => invokeSafe('open-external-url', url),
    saveDirectorMode: (mode) => invokeSafe('save-director-mode', mode),
    setActiveProvider: (provider) => invokeSafe('set-active-provider', provider),
    saveSummary: (summary) => invokeSafe('save-summary', summary),
    getSummary: () => invokeSafe('get-summary'),
    getLorebook: () => invokeSafe('get-lorebook'),
    saveLorebook: (content) => invokeSafe('save-lorebook', content),
    getImages: () => invokeSafe('get-images'),
    getImageManifest: () => invokeSafe('get-image-manifest'),
    getInnerMonologue: (charName, messages) => invokeSafe('get-inner-monologue-FIXED', charName, messages),
    getStageDirections: (text, activeChars, context) => invokeSafe('get-stage-directions', text, activeChars, context),
    getReplySuggestions: (messages) => invokeSafe('get-reply-suggestions', messages),
    getChapterTitle: (messages) => invokeSafe('get-chapter-title', messages),
    summarizeChat: (text, prev) => invokeSafe('summarize-chat', text, prev),
    getQuestObjective: (messages) => invokeSafe('get-quest-objective', messages),
    getAffinity: (messages, charName) => invokeSafe('get-affinity', messages, charName),
    cleanupResponse: (text) => invokeSafe('cleanup-response', text),
    extractUserFacts: (messages) => invokeSafe('extract-user-facts', messages),
    expandImagePrompt: (text) => invokeSafe('expand-image-prompt', text),
    findClosestSprite: (request, availableFiles) => invokeSafe('find-closest-sprite', request, availableFiles),
    determineActiveContext: (messages, candidates) => invokeSafe('determine-active-context', messages, candidates),
    checkFileExists: (path) => invokeSafe('check-file-exists', path),
    saveCurrentChat: (data) => invokeSafe('save-current-chat', data),
    clearVoiceMap: () => invokeSafe('clear-voice-map'),
    getVoiceMap: () => invokeSafe('get-voice-map'),
    saveVoiceMap: (map) => invokeSafe('save-voice-map', map),
    scanVoiceBuckets: () => invokeSafe('scan-voice-buckets'),
    loadCurrentChat: () => invokeSafe('load-current-chat'),
    testProvider: () => invokeSafe('test-provider'),
    generateSpeech: (text, voiceId, forcedSpeakerId) => invokeSafe('generate-speech', text, voiceId, forcedSpeakerId),
    generateImage: (prompt, type) => invokeSafe('generate-image', prompt, type),
    phoneListThreads: () => invokeSafe('phone-list-threads'),
    phoneGetThread: (threadId) => invokeSafe('phone-get-thread', threadId),
    phoneCreateThread: (payload) => invokeSafe('phone-create-thread', payload),
    phoneMarkRead: (threadId) => invokeSafe('phone-mark-read', threadId),
    phoneSendMessage: (threadId, text, options) => invokeSafe('phone-send-message', threadId, text, options),
    phonePollUpdates: (options) => invokeSafe('phone-poll-updates', options),
    phoneGetContacts: () => invokeSafe('phone-get-contacts'),
    phoneSetContactKnown: (name, hasNumber) => invokeSafe('phone-set-contact-known', name, hasNumber),
    phoneResetState: () => invokeSafe('phone-reset-state'),
    cancelChat: () => invokeSafe('cancel-chat'),
    onChatReplyChunk: (callback) => {
        const subscription = (event, chunk) => callback(chunk);
        ipcRenderer.on('chat-reply-chunk', subscription);
        return () => ipcRenderer.removeListener('chat-reply-chunk', subscription);
    },
    evolveCharacterState: (messages, activeChars) => invokeSafe('evolve-character-state', messages, activeChars),
    toggleDevTools: (open) => invokeSafe('toggle-dev-tools', open)
});

