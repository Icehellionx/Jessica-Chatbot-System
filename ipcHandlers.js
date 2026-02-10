const { ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

module.exports = function(paths) {
    const {
        userDataPath,
        configPath,
        chatsPath,
        botFilesPath,
        botImagesPath,
        personaPath,
        summaryPath,
        currentChatPath,
        advancedPromptPath,
        characterStatePath,
        lorebookPath
    } = paths;

    // --- State ---
    const fileCache = {
        timestamp: 0,
        data: {}
    };
    const CACHE_TTL = 60000; // 1 minute cache

    // --- Helper Functions ---

    function loadConfig() {
        try {
            if (fs.existsSync(configPath)) {
                return JSON.parse(fs.readFileSync(configPath, 'utf8'));
            }
        } catch (e) {
            console.error("Error loading config:", e);
        }
        return { apiKeys: {}, models: {}, baseUrls: {} };
    }

    function saveConfig(config) {
        try {
            fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
            return true;
        } catch (e) {
            console.error("Error saving config:", e);
            return false;
        }
    }

    function loadCharacterState() {
        try {
            if (fs.existsSync(characterStatePath)) {
                return JSON.parse(fs.readFileSync(characterStatePath, 'utf8'));
            }
        } catch (e) { console.error("Error loading character state:", e); }
        return {};
    }

    function loadLorebook() {
        try {
            if (fs.existsSync(lorebookPath)) {
                return JSON.parse(fs.readFileSync(lorebookPath, 'utf8'));
            }
        } catch (e) { console.error("Error loading lorebook:", e); }
        return [];
    }

    const scanDirectoryRecursively = (dir, prefix = '') => {
        let results = [];
        if (!fs.existsSync(dir)) return results;
        
        try {
            const items = fs.readdirSync(dir, { withFileTypes: true });
            for (const item of items) {
                if (item.isDirectory()) {
                    results = results.concat(scanDirectoryRecursively(path.join(dir, item.name), `${prefix}${item.name}/`));
                } else if (/\.(png|jpg|jpeg|webp|gif|mp3|wav|ogg)$/i.test(item.name)) {
                    results.push(prefix + item.name);
                }
            }
        } catch (e) {
            console.error(`Error scanning directory ${dir}:`, e);
        }
        return results;
    };

    const getFiles = (subdir, forceRefresh = false) => {
        const now = Date.now();
        if (!forceRefresh && fileCache.data[subdir] && (now - fileCache.timestamp < CACHE_TTL)) {
            return fileCache.data[subdir];
        }

        try {
            const dir = path.join(botImagesPath, subdir);
            let results = [];

            if (subdir === 'sprites') {
                results = results.concat(scanDirectoryRecursively(path.join(botImagesPath, 'sprites'), 'sprites/'));
                results = results.concat(scanDirectoryRecursively(path.join(botFilesPath, 'characters'), 'characters/'));
            } else if (fs.existsSync(dir)) {
                results = fs.readdirSync(dir).filter(f => /\.(png|jpg|jpeg|webp|gif|mp3|wav|ogg)$/i.test(f))
                    .map(f => `${subdir}/${f}`);
            }

            fileCache.data[subdir] = results;
            fileCache.timestamp = now;
            return results;
        } catch (e) { return []; }
    };

    // --- IPC Handlers ---

    ipcMain.handle('get-config', () => {
        return loadConfig();
    });

    ipcMain.handle('save-api-key', (event, provider, key, model, baseUrl) => {
        const config = loadConfig();
        if (!config.apiKeys) config.apiKeys = {};
        if (!config.models) config.models = {};
        if (!config.baseUrls) config.baseUrls = {};
        
        config.apiKeys[provider] = key;
        if (model) config.models[provider] = model;
        if (baseUrl) config.baseUrls[provider] = baseUrl;
        
        if (!config.activeProvider) config.activeProvider = provider;

        saveConfig(config);
        return config;
    });

    ipcMain.handle('delete-api-key', (event, provider) => {
        const config = loadConfig();
        if (config.apiKeys && config.apiKeys[provider]) {
            delete config.apiKeys[provider];
            if (config.activeProvider === provider) {
                delete config.activeProvider;
            }
            saveConfig(config);
        }
        return config;
    });

    ipcMain.handle('set-active-provider', (event, provider) => {
        const config = loadConfig();
        if (config.apiKeys && config.apiKeys[provider]) {
            config.activeProvider = provider;
            saveConfig(config);
            return true;
        }
        return false;
    });

    ipcMain.handle('save-persona', (event, persona) => {
        try {
            fs.writeFileSync(personaPath, JSON.stringify(persona, null, 2));
            return true;
        } catch (e) {
            console.error("Error saving persona:", e);
            return false;
        }
    });

    ipcMain.handle('get-persona', () => {
        try {
            if (fs.existsSync(personaPath)) {
                return JSON.parse(fs.readFileSync(personaPath, 'utf8'));
            }
        } catch (e) {
            console.error("Error loading persona:", e);
        }
        return { name: 'Jim', details: '' };
    });

    ipcMain.handle('save-summary', (event, summary) => {
        try {
            fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
            return true;
        } catch (e) {
            console.error("Error saving summary:", e);
            return false;
        }
    });

    ipcMain.handle('get-summary', () => {
        try {
            if (fs.existsSync(summaryPath)) {
                return JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
            }
        } catch (e) {
            console.error("Error loading summary:", e);
        }
        return { content: '' };
    });

    ipcMain.handle('get-lorebook', () => {
        return loadLorebook();
    });

    ipcMain.handle('save-lorebook', (event, content) => {
        try {
            fs.writeFileSync(lorebookPath, JSON.stringify(content, null, 2));
            return true;
        } catch (e) {
            console.error("Error saving lorebook:", e);
            return false;
        }
    });

    ipcMain.handle('get-advanced-prompt', () => {
        try {
            if (fs.existsSync(advancedPromptPath)) {
                return fs.readFileSync(advancedPromptPath, 'utf8');
            }
        } catch (e) {
            console.error("Error loading advanced prompt:", e);
        }
        return '';
    });

    ipcMain.handle('save-temperature', (event, temperature) => {
        const config = loadConfig();
        config.temperature = parseFloat(temperature);
        saveConfig(config);
        return true;
    });

    ipcMain.handle('save-max-context', (event, limit) => {
        const config = loadConfig();
        config.maxContext = parseInt(limit);
        saveConfig(config);
        return true;
    });

    ipcMain.handle('save-advanced-prompt', (event, prompt) => {
        try {
            fs.writeFileSync(advancedPromptPath, prompt);
            return true;
        } catch (e) {
            console.error("Error saving advanced prompt:", e);
            return false;
        }
    });

    ipcMain.handle('evolve-character-state', async (event, messages, activeCharacters) => {
        const config = loadConfig();
        const provider = config.activeProvider || Object.keys(config.apiKeys)[0];
        const apiKey = config.apiKeys ? config.apiKeys[provider] : null;
        const savedModel = config.models ? config.models[provider] : null;
        const savedBaseUrl = (config.baseUrls && config.baseUrls[provider]) ? config.baseUrls[provider] : null;

        if ((!apiKey && provider !== 'local') || !activeCharacters || activeCharacters.length === 0) return null;

        let originalPersonalities = "";
        activeCharacters.forEach(name => {
            const charPath = path.join(botFilesPath, 'characters', name, 'personality.txt');
            if (fs.existsSync(charPath)) {
                 originalPersonalities += `\n[${name}'s ORIGINAL CORE PERSONALITY]\n${fs.readFileSync(charPath, 'utf8').slice(0, 1000)}...`;
            }
        });

        const currentState = loadCharacterState();
        const currentLore = loadLorebook();
        const recentHistory = messages.slice(-5).map(m => `${m.role}: ${m.content}`).join('\n');

        const systemPrompt = "You are a narrative engine. Update the internal psychological state of the characters based on the recent conversation. Output JSON only.";
        const userPrompt = `
[CONTEXT]
${originalPersonalities}

[CURRENT STATE]
${JSON.stringify(currentState, null, 2)}

[RECENT INTERACTION]
${recentHistory}

[INSTRUCTIONS]
Analyze the recent interaction.
Update the state for: ${activeCharacters.join(', ')}.
Fields to update:
- Mood: Current emotional baseline.
- Trust: Level of trust in the user.
- Thoughts: Internal monologue or current goal.
- NewLore: If a NEW significant fact about the world or characters is established that should be remembered long-term, output an object { "keywords": ["key1", "key2"], "scenario": "Fact description" }. Otherwise null.

Output a JSON object keyed by character name containing these fields.
`;

        try {
            let responseText = "";
            if (provider === 'gemini') {
                const modelName = savedModel || 'gemini-1.5-flash';
                const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
                const r = await axios.post(url, {
                    contents: [{ parts: [{ text: userPrompt }] }],
                    systemInstruction: { parts: [{ text: systemPrompt }] }
                });
                if (r.data.candidates && r.data.candidates.length > 0) {
                    responseText = r.data.candidates[0].content.parts[0].text;
                }
            } else {
                let baseURL = 'https://api.openai.com/v1';
                let model = savedModel || 'gpt-3.5-turbo';
                if (provider === 'openrouter') baseURL = 'https://openrouter.ai/api/v1';
                if (provider === 'local') {
                    baseURL = savedBaseUrl || 'http://localhost:1234/v1';
                    if (!savedModel) model = 'local-model';
                }
                // ... Add other providers as needed ...

                const r = await axios.post(`${baseURL}/chat/completions`, {
                    model: model,
                    messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
                    temperature: 0.5
                }, { headers: { 'Authorization': `Bearer ${apiKey}` } });
                responseText = r.data.choices[0].message.content;
            }

            const jsonMatch = responseText.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const newStateUpdates = JSON.parse(jsonMatch[0]);
                
                // Handle Dynamic Lorebook Updates
                Object.values(newStateUpdates).forEach(update => {
                    if (update.NewLore && update.NewLore.scenario && update.NewLore.keywords) {
                        currentLore.push(update.NewLore);
                        delete update.NewLore; // Remove from character state so it doesn't clutter
                    }
                });
                fs.writeFileSync(lorebookPath, JSON.stringify(currentLore, null, 2));

                // Save Character State
                const mergedState = { ...currentState, ...newStateUpdates };
                fs.writeFileSync(characterStatePath, JSON.stringify(mergedState, null, 2));
                return mergedState;
            }
        } catch (e) { console.error("Evolution failed:", e); }
        return null;
    });

    ipcMain.handle('get-images', () => {
        return {
            backgrounds: getFiles('backgrounds'),
            sprites: getFiles('sprites'),
            splash: getFiles('splash'),
            music: getFiles('music')
        };
    });

    ipcMain.handle('get-image-manifest', () => {
        let manifest = { backgrounds: {}, sprites: {}, splash: {}, music: {} };
        
        try {
            const manifestPath = path.join(botFilesPath, 'images.json');
            if (fs.existsSync(manifestPath)) {
                manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            }
        } catch (e) { console.error("Error reading manifest:", e); }
        
        if (!manifest.backgrounds) manifest.backgrounds = {};
        if (!manifest.sprites) manifest.sprites = {};
        if (!manifest.splash) manifest.splash = {};
        if (!manifest.music) manifest.music = {};

        const validate = (category) => {
            try {
                const dir = path.join(botImagesPath, category);
                if (!fs.existsSync(dir)) return;
                
                Object.keys(manifest[category]).forEach(file => {
                    const filePath = path.join(botFilesPath, file);
                    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
                        delete manifest[category][file];
                    }
                });
            } catch (e) { console.error(`Error validating ${category}:`, e); }
        };
        validate('backgrounds');
        validate('sprites');
        validate('splash');
        validate('music');

        const populate = (subdir, category) => {
            try {
                const dir = path.join(botImagesPath, subdir);
                if (fs.existsSync(dir) || category === 'sprites') {
                    const scanDir = (d, prefix = '') => {
                        if (!fs.existsSync(d)) return;
                        const items = fs.readdirSync(d, { withFileTypes: true });
                        items.forEach(item => {
                            if (item.isDirectory()) {
                                scanDir(path.join(d, item.name), `${prefix}${item.name}/`);
                            } else if (/\.(png|jpg|jpeg|webp|gif|mp3|wav|ogg)$/i.test(item.name)) {
                                const key = prefix + item.name;
                                if (!manifest[category][key]) {
                                    manifest[category][key] = key;
                                }
                            }
                        });
                    };
                    if (category === 'sprites') {
                        scanDir(path.join(botImagesPath, 'sprites'), 'sprites/');
                        if (fs.existsSync(path.join(botFilesPath, 'characters'))) {
                            scanDir(path.join(botFilesPath, 'characters'), 'characters/');
                        }
                    } else {
                        scanDir(dir, `${subdir}/`);
                    }
                }
            } catch (e) { console.error(`Error scanning ${subdir}:`, e); }
        };

        populate('backgrounds', 'backgrounds');
        populate('sprites', 'sprites');
        populate('splash', 'splash');
        populate('music', 'music');

        return manifest;
    });

    ipcMain.handle('get-bot-info', () => {
        const read = (filename) => {
            try {
                return fs.readFileSync(path.join(botFilesPath, filename), 'utf8').trim();
            } catch (e) {
                console.error(`Failed to read ${filename}:`, e.message);
                return '';
            }
        };

        let personality = read('personality.txt');
        let characters = {};

        const charDir = path.join(botFilesPath, 'characters');
        if (fs.existsSync(charDir)) {
            try {
                const chars = fs.readdirSync(charDir, { withFileTypes: true });
                for (const char of chars) {
                    if (char.isDirectory()) {
                        const charPPath = path.join(charDir, char.name, 'personality.txt');
                        if (fs.existsSync(charPPath)) {
                            const charP = fs.readFileSync(charPPath, 'utf8').trim();
                            if (charP) {
                                characters[char.name] = charP;
                            }
                        }
                    }
                }
            } catch (e) {
                console.error("Error reading characters directory:", e);
            }
        }

        let scenario = read('scenario.txt');

        return {
            personality: personality,
            scenario: scenario,
            initial: read('initial.txt'),
            characters: characters || {}
        };
    });

    ipcMain.handle('save-chat', (event, name, messages) => {
        try {
            // Bundle current state with the chat for branching
            const saveData = {
                messages: messages,
                characterState: loadCharacterState(),
                lorebook: loadLorebook(),
                timestamp: Date.now()
            };
            
            const safeName = name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
            fs.writeFileSync(path.join(chatsPath, `${safeName}.json`), JSON.stringify(saveData, null, 2));
            return true;
        } catch (e) {
            console.error("Error saving chat:", e);
            return false;
        }
    });

    ipcMain.handle('get-chats', () => {
        try {
            return fs.readdirSync(chatsPath).filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''));
        } catch (e) {
            return [];
        }
    });

    ipcMain.handle('load-chat', (event, name) => {
        try {
            const data = JSON.parse(fs.readFileSync(path.join(chatsPath, `${name}.json`), 'utf8'));
            
            // Handle new format (Object) vs old format (Array)
            if (!Array.isArray(data) && data.messages) {
                // Restore the state associated with this save slot (Branching)
                if (data.characterState) fs.writeFileSync(characterStatePath, JSON.stringify(data.characterState, null, 2));
                if (data.lorebook) fs.writeFileSync(lorebookPath, JSON.stringify(data.lorebook, null, 2));
                return data.messages;
            }
            
            return data; // Fallback for old saves
        } catch (e) {
            return [];
        }
    });

    ipcMain.handle('save-current-chat', (event, data) => {
        try {
            fs.writeFileSync(currentChatPath, JSON.stringify(data, null, 2));
            return true;
        } catch (e) {
            console.error("Error saving current chat:", e);
            return false;
        }
    });

    ipcMain.handle('load-current-chat', () => {
        try {
            if (fs.existsSync(currentChatPath)) {
                return JSON.parse(fs.readFileSync(currentChatPath, 'utf8'));
            }
        } catch (e) {
            console.error("Error loading current chat:", e);
        }
        return null;
    });

    ipcMain.handle('test-provider', async () => {
        const config = loadConfig();
        const provider = config.activeProvider;
        if (!provider) return { success: false, message: "No active provider selected." };
        
        const apiKey = (config.apiKeys && config.apiKeys[provider]) ? config.apiKeys[provider] : null;
        if (!apiKey && provider !== 'local') return { success: false, message: `No API key found for ${provider}.` };

        const savedModel = config.models ? config.models[provider] : null;
        const savedBaseUrl = (config.baseUrls && config.baseUrls[provider]) ? config.baseUrls[provider] : null;

        try {
            if (provider === 'gemini') {
                const modelName = savedModel || 'gemini-1.5-flash';
                const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
                await axios.post(url, {
                    contents: [{ parts: [{ text: "Hello" }] }]
                });
            } else {
                let baseURL = 'https://api.openai.com/v1';
                let model = savedModel || 'gpt-3.5-turbo';

                if (provider === 'openrouter') {
                    baseURL = 'https://openrouter.ai/api/v1';
                    if (!savedModel) model = 'mistralai/mistral-7b-instruct:free';
                } else if (provider === 'grok') {
                    baseURL = 'https://api.x.ai/v1';
                    if (!savedModel) model = 'grok-beta';
                } else if (provider === 'chutes') {
                    baseURL = 'https://chutes.ai/api/v1';
                    if (!savedModel) model = 'chutes-model';
                } else if (provider === 'featherless') {
                    baseURL = 'https://api.featherless.ai/v1';
                    if (!savedModel) model = 'meta-llama/Meta-Llama-3-8B-Instruct';
                } else if (provider === 'local') {
                    baseURL = savedBaseUrl || 'http://localhost:1234/v1';
                    if (!savedModel) model = 'local-model';
                }

                await axios.post(`${baseURL}/chat/completions`, {
                    model: model,
                    messages: [{ role: "user", content: "Hello" }],
                    max_tokens: 1
                }, { headers: { 'Authorization': `Bearer ${apiKey}` } });
            }
            return { success: true, message: `Successfully connected to ${provider}!` };
        } catch (error) {
            console.error("Test Provider Error:", error);
            const msg = error.response ? JSON.stringify(error.response.data) : error.message;
            return { success: false, message: `Connection failed: ${msg}` };
        }
    });

    ipcMain.handle('scan-images', async () => {
        const config = loadConfig();
        const provider = config.activeProvider || Object.keys(config.apiKeys)[0];
        const apiKey = config.apiKeys ? config.apiKeys[provider] : null;
        const savedModel = config.models ? config.models[provider] : null;
        const savedBaseUrl = (config.baseUrls && config.baseUrls[provider]) ? config.baseUrls[provider] : null;

        if (!apiKey && provider !== 'local') return { success: false, message: "No API key found." };

        const manifestPath = path.join(botFilesPath, 'images.json');
        let manifest = { backgrounds: {}, sprites: {} };
        
        if (fs.existsSync(manifestPath)) {
            try {
                manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            } catch (e) { console.error("Error parsing manifest", e); }
        }
        if (!manifest.backgrounds) manifest.backgrounds = {};
        if (!manifest.sprites) manifest.sprites = {};
        if (!manifest.splash) manifest.splash = {};
        if (!manifest.music) manifest.music = {};

        let updated = false;

        const getMimeType = (filePath) => {
            const ext = path.extname(filePath).toLowerCase();
            if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
            if (ext === '.webp') return 'image/webp';
            if (ext === '.gif') return 'image/gif';
            if (ext === '.mp3') return 'audio/mpeg';
            if (ext === '.wav') return 'audio/wav';
            if (ext === '.ogg') return 'audio/ogg';
            return 'image/png';
        };

        const processCategory = async (category) => {
            const dir = path.join(botImagesPath, category);
            
            let files = [];
            if (category === 'sprites') {
                files = files.concat(scanDirectoryRecursively(path.join(botImagesPath, 'sprites'), 'sprites/'));
                files = files.concat(scanDirectoryRecursively(path.join(botFilesPath, 'characters'), 'characters/'));
            } else {
                files = scanDirectoryRecursively(dir, `${category}/`);
            }
            
            for (const file of files) {
                if (manifest[category][file]) continue;

                console.log(`[Image Scan] Analyzing: ${category}/${file}`);
                const filePath = path.join(botFilesPath, file);
                const base64 = fs.readFileSync(filePath).toString('base64');
                const mimeType = getMimeType(filePath);
                
                if (mimeType.startsWith('audio/')) {
                    manifest[category][file] = "Audio file";
                    updated = true;
                    continue;
                }

                let description = file;

                try {
                    if (provider === 'gemini') {
                        const modelName = savedModel || 'gemini-1.5-flash';
                        const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
                        const response = await axios.post(url, {
                            contents: [{
                                parts: [
                                    { text: "Describe this image in 5 words or less for a visual novel script." },
                                    { inlineData: { mimeType: mimeType, data: base64 } }
                                ]
                            }]
                        });
                        if (response.data.candidates && response.data.candidates.length > 0) {
                            description = response.data.candidates[0].content.parts[0].text.trim();
                        }
                    } else {
                        let baseURL = 'https://api.openai.com/v1';
                        let model = savedModel || 'gpt-4-turbo';
                        if (provider === 'openrouter') baseURL = 'https://openrouter.ai/api/v1';
                        if (provider === 'featherless') baseURL = 'https://api.featherless.ai/v1';
                        if (provider === 'local') {
                            baseURL = savedBaseUrl || 'http://localhost:1234/v1';
                            if (!savedModel) model = 'local-model';
                        }

                        const response = await axios.post(`${baseURL}/chat/completions`, {
                            model: model,
                            messages: [{
                                role: "user",
                                content: [
                                    { type: "text", text: "Describe this image in 5 words or less for a visual novel script." },
                                    { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64}` } }
                                ]
                            }],
                            max_tokens: 50
                        }, { headers: { 'Authorization': `Bearer ${apiKey}` } });
                        
                        if (response.data.choices && response.data.choices.length > 0) {
                            description = response.data.choices[0].message.content.trim();
                        }
                    }
                } catch (e) {
                    console.error(`[Image Scan] Failed to analyze ${file}:`, e.message);
                }

                manifest[category][file] = description;
                updated = true;
            }
        };

        await processCategory('backgrounds');
        await processCategory('sprites');
        await processCategory('splash');
        await processCategory('music');

        if (updated) {
            fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
            // Invalidate cache since we just scanned and potentially found new things
            fileCache.timestamp = 0; 
            return { success: true, message: "Manifest updated with new images." };
        }
        return { success: true, message: "No new images found." };
    });

    ipcMain.handle('send-chat', async (event, messages, options = {}) => {
        // Clone messages to prevent mutation of the incoming array
        const messagesCopy = JSON.parse(JSON.stringify(messages));
        
        const config = loadConfig();
        const provider = config.activeProvider || Object.keys(config.apiKeys)[0];
        const apiKey = config.apiKeys ? config.apiKeys[provider] : null;
        const savedModel = config.models ? config.models[provider] : null;
        const savedBaseUrl = (config.baseUrls && config.baseUrls[provider]) ? config.baseUrls[provider] : null;
        const temperature = config.temperature !== undefined ? Number(config.temperature) : 0.7;

        if (!apiKey && provider !== 'local') return "Error: No API key found. Please check your options.";

        const backgrounds = getFiles('backgrounds');
        let sprites = getFiles('sprites');
        const splashes = getFiles('splash');
        const music = getFiles('music');

        if (options.activeCharacters && Array.isArray(options.activeCharacters)) {
            const activeSet = new Set(options.activeCharacters.map(c => c.toLowerCase()));
            sprites = sprites.filter(file => {
                const parts = file.split(/[/\\]/);
                if (parts.length > 2) {
                    const charName = parts[1].toLowerCase();
                    return activeSet.has(charName);
                }
                return true;
            });
        }

        const manifestPath = path.join(botFilesPath, 'images.json');
        let manifest = { backgrounds: {}, sprites: {}, splash: {}, music: {} };
        if (fs.existsSync(manifestPath)) {
            try {
                manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            } catch (e) {
                console.error("Error reading images.json:", e);
            }
        }

        const createTreeList = (files, category) => {
            if (!files || files.length === 0) return null;
            const tree = {};

            files.forEach(file => {
                const parts = file.split('/');
                const filename = parts.pop();
                const nameWithoutExt = path.parse(filename).name;
                
                let group = 'Common';
                if (parts.length > 0) {
                    if (parts[0] === 'characters' && parts.length > 1) {
                        group = parts[1];
                    } else if (parts[0] === 'sprites' && parts.length > 1) {
                        group = parts[1];
                    } else if (parts[0] === 'backgrounds' || parts[0] === 'splash' || parts[0] === 'music') {
                        group = 'Common';
                    } else {
                         group = parts[parts.length - 1];
                    }
                }

                let cleanName = nameWithoutExt;
                if (group !== 'Common' && cleanName.toLowerCase().startsWith(group.toLowerCase())) {
                    const potential = cleanName.substring(group.length).replace(/^[_-\s]+/, '');
                    if (potential.length > 0) cleanName = potential;
                }

                if (!tree[group]) tree[group] = [];

                let desc = manifest[category] ? manifest[category][file] : "";
                let entry = cleanName;

                if (desc) {
                    const cleanDesc = desc.toLowerCase();
                    const checkName = cleanName.toLowerCase();
                    if (!cleanDesc.includes(checkName) && cleanDesc !== checkName) {
                        entry += ` : ${desc}`;
                    }
                }
                tree[group].push(entry);
            });

            let lines = [];
            Object.keys(tree).sort().forEach(group => {
                const items = tree[group].sort().join(', ');
                if (group === 'Common') {
                    lines.push(items);
                } else {
                    lines.push(`${group}: ${items}`);
                }
            });
            return lines.join('\n');
        };

        bgList = createTreeList(backgrounds, 'backgrounds');
        spriteList = createTreeList(sprites, 'sprites');
        splashList = createTreeList(splashes, 'splash');
        musicList = createTreeList(music, 'music');

        let visualPrompt = "";
        if (bgList || spriteList || splashList || musicList) {
            visualPrompt = `\n[VISUAL NOVEL MODE]`;
            if (bgList) visualPrompt += `\nBackgrounds:\n${bgList}`;
            if (spriteList) visualPrompt += `\nSprites:\n${spriteList}`;
            if (splashList) visualPrompt += `\nSplash Art:\n${splashList}`;
            if (musicList) visualPrompt += `\nMusic:\n${musicList}`;

            visualPrompt += `\n\nINSTRUCTIONS:
1. Output visual tags ONLY at the start or end of the message. Never in the middle.
2. [BG: "name"] changes background.
3. [SPRITE: "Char/Name"] updates character.
4. [SPLASH: "name"] overrides all.
5. [MUSIC: "name"] plays background music.
6. Max 4 characters.
7. [HIDE: "Char"] removes character. [HIDE: "All"] removes everyone. HIDE when leaving.
8. Sprites are STICKY. Only tag on change.`;
        }

        let advancedPromptContent = "";
        try {
            if (fs.existsSync(advancedPromptPath)) {
                const content = fs.readFileSync(advancedPromptPath, 'utf8').trim();
                if (content) advancedPromptContent = `\n\n${content}`;
            }
        } catch (e) { console.error("Error reading advanced prompt:", e); }

        // Inject Dynamic Character State
        const charState = loadCharacterState();
        let stateInjection = "";
        if (options.activeCharacters && Object.keys(charState).length > 0) {
            stateInjection += "\n\n[CURRENT CHARACTER STATES (DYNAMIC)]";
            options.activeCharacters.forEach(char => {
                const key = Object.keys(charState).find(k => k.toLowerCase() === char.toLowerCase());
                if (key && charState[key]) stateInjection += `\n${key}: ${JSON.stringify(charState[key])}`;
            });
        }

        // Inject AURA Lorebook Entries
        const lorebook = loadLorebook();
        let loreInjection = "";
        const recentText = messagesCopy.slice(-3).map(m => m.content.toLowerCase()).join(' ');
        
        lorebook.forEach(entry => {
            if (entry.keywords.some(k => recentText.includes(k.toLowerCase()))) {
                // Support 'scenario' (AURA format) or 'entry' (Legacy)
                const text = entry.scenario || entry.entry;
                if (text) loreInjection += `\n- ${text}`;
            }
        });
        if (loreInjection) loreInjection = `\n\n[RELEVANT LORE]${loreInjection}`;

        const enforcementRules = `\n\n[SYSTEM ENFORCEMENT]
1. DO NOT speak for the user. The user's actions and dialogue are provided in the chat history. Your response must only contain the characters' reactions and dialogue.
2. Maintain distinct personalities for each character. Do not let traits or knowledge bleed between characters defined in separate character sheets.
3. Ensure each character's voice remains consistent with their specific definition.${stateInjection}${loreInjection}${advancedPromptContent}`;

        const systemMsgIndex = messagesCopy.findIndex(m => m.role === 'system');
        if (systemMsgIndex > -1) {
            messagesCopy[systemMsgIndex].content += visualPrompt + enforcementRules;
        } else {
            messagesCopy.unshift({ role: 'system', content: visualPrompt + enforcementRules });
        }
        
        const webContents = event.sender;

        try {
            if (provider === 'gemini') {
                const modelName = savedModel || 'gemini-1.5-flash';
                const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:streamGenerateContent?key=${apiKey}`;
                
                const systemMsg = messagesCopy.find(m => m.role === 'system');
                const chatMsgs = messagesCopy.filter(m => m.role !== 'system');

                const geminiContents = chatMsgs.map(m => ({
                    role: m.role === 'user' ? 'user' : 'model',
                    parts: [{ text: m.content }]
                }));
                
                const requestBody = { 
                    contents: geminiContents,
                    generationConfig: { temperature: temperature }
                };
                if (systemMsg) {
                    requestBody.systemInstruction = { parts: [{ text: systemMsg.content }] };
                }

                const response = await axios.post(url, requestBody, { responseType: 'stream' });
                
                let fullText = '';
                let buffer = '';
                const stream = response.data;

                await new Promise((resolve, reject) => {
                    stream.on('data', (chunk) => {
                        buffer += chunk.toString();
                        let braceCount = 0;
                        let startIndex = 0;
                        let inString = false;
                        let escape = false;

                        for (let i = 0; i < buffer.length; i++) {
                            const char = buffer[i];
                            if (escape) { escape = false; continue; }
                            if (char === '\\') { escape = true; continue; }
                            if (char === '"') { inString = !inString; continue; }
                            
                            if (!inString) {
                                if (char === '{') {
                                    if (braceCount === 0) startIndex = i;
                                    braceCount++;
                                } else if (char === '}') {
                                    braceCount--;
                                    if (braceCount === 0) {
                                        const jsonStr = buffer.substring(startIndex, i + 1);
                                        try {
                                            const data = JSON.parse(jsonStr);
                                            if (data.candidates && data.candidates[0].content && data.candidates[0].content.parts) {
                                                const text = data.candidates[0].content.parts[0].text;
                                                if (text) {
                                                    fullText += text;
                                                    webContents.send('chat-reply-chunk', text);
                                                }
                                            }
                                        } catch (e) { /* ignore partials */ }
                                        buffer = buffer.substring(i + 1);
                                        i = -1;
                                    }
                                }
                            }
                        }
                    });
                    stream.on('end', resolve);
                    stream.on('error', reject);
                });

                return fullText || "Error: No response from Gemini.";

            } else {
                let baseURL = 'https://api.openai.com/v1';
                let model = savedModel || 'gpt-3.5-turbo';

                if (provider === 'openrouter') {
                    baseURL = 'https://openrouter.ai/api/v1';
                    if (!savedModel) model = 'mistralai/mistral-7b-instruct:free';
                } else if (provider === 'grok') {
                    baseURL = 'https://api.x.ai/v1';
                    if (!savedModel) model = 'grok-beta';
                } else if (provider === 'chutes') {
                    baseURL = 'https://chutes.ai/api/v1';
                    if (!savedModel) model = 'chutes-model';
                } else if (provider === 'featherless') {
                    baseURL = 'https://api.featherless.ai/v1';
                    if (!savedModel) model = 'meta-llama/Meta-Llama-3-8B-Instruct';
                } else if (provider === 'local') {
                    baseURL = savedBaseUrl || 'http://localhost:1234/v1';
                    if (!savedModel) model = 'local-model';
                }

                const response = await axios.post(`${baseURL}/chat/completions`, {
                    model: model,
                    messages: messagesCopy,
                    stream: true,
                    temperature: temperature
                }, { 
                    headers: { 'Authorization': `Bearer ${apiKey}` },
                    responseType: 'stream'
                });

                let fullText = '';
                const stream = response.data;

                await new Promise((resolve, reject) => {
                    stream.on('data', (chunk) => {
                        const lines = chunk.toString().split('\n');
                        for (const line of lines) {
                            const trimmed = line.trim();
                            if (trimmed.startsWith('data: ')) {
                                const dataStr = trimmed.substring(6);
                                if (dataStr === '[DONE]') continue;
                                try {
                                    const data = JSON.parse(dataStr);
                                    const content = data.choices[0].delta.content;
                                    if (content) {
                                        fullText += content;
                                        webContents.send('chat-reply-chunk', content);
                                    }
                                } catch (e) {}
                            }
                        }
                    });
                    stream.on('end', resolve);
                    stream.on('error', reject);
                });

                return fullText;
            }
        } catch (error) {
            console.error("API Error:", error.response ? error.response.data : error.message);
            return `Error: ${error.message}`;
        }
    });
};
