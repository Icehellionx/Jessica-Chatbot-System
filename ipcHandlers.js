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
        advancedPromptPath
    } = paths;

    // --- Helper Functions ---

    function loadConfig() {
        try {
            if (fs.existsSync(configPath)) {
                return JSON.parse(fs.readFileSync(configPath, 'utf8'));
            }
        } catch (e) {
            console.error("Error loading config:", e);
        }
        return { apiKeys: {} };
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

    const getFiles = (subdir) => {
        try {
            const dir = path.join(botImagesPath, subdir);
            if (fs.existsSync(dir)) {
                const isFile = (name) => /\.(png|jpg|jpeg|webp|gif|mp3|wav|ogg)$/i.test(name);
                if (subdir === 'sprites') {
                    let results = [];
                    const getAllFiles = (d, prefix = '') => {
                        let files = [];
                        const items = fs.readdirSync(d, { withFileTypes: true });
                        for (const item of items) {
                            if (item.isDirectory()) {
                                files = files.concat(getAllFiles(path.join(d, item.name), `${prefix}${item.name}/`));
                            } else if (isFile(item.name)) {
                                files.push(prefix + item.name);
                            }
                        }
                        return files;
                    };
                    results = results.concat(getAllFiles(dir, 'sprites/'));
                    const charDir = path.join(botFilesPath, 'characters');
                    if (fs.existsSync(charDir)) {
                        results = results.concat(getAllFiles(charDir, 'characters/'));
                    }
                    return results;
                } else {
                    return fs.readdirSync(dir).filter(f => isFile(f))
                        .map(f => `${subdir}/${f}`);
                }
            }
        } catch (e) { 
            console.error(`Error reading ${subdir}:`, e);
            return []; 
        }
        return [];
    };

    // --- IPC Handlers ---

    ipcMain.handle('get-config', () => {
        return loadConfig();
    });

    ipcMain.handle('save-api-key', (event, provider, key, model) => {
        const config = loadConfig();
        if (!config.apiKeys) config.apiKeys = {};
        if (!config.models) config.models = {};
        
        config.apiKeys[provider] = key;
        if (model) config.models[provider] = model;
        
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

    ipcMain.handle('save-advanced-prompt', (event, prompt) => {
        try {
            fs.writeFileSync(advancedPromptPath, prompt);
            return true;
        } catch (e) {
            console.error("Error saving advanced prompt:", e);
            return false;
        }
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
            const safeName = name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
            fs.writeFileSync(path.join(chatsPath, `${safeName}.json`), JSON.stringify(messages, null, 2));
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
            return JSON.parse(fs.readFileSync(path.join(chatsPath, `${name}.json`), 'utf8'));
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
        
        const apiKey = config.apiKeys ? config.apiKeys[provider] : null;
        if (!apiKey) return { success: false, message: `No API key found for ${provider}.` };

        const savedModel = config.models ? config.models[provider] : null;

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

        if (!apiKey) return { success: false, message: "No API key found." };

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
            
            const getAllFiles = (d, prefix = '') => {
                if (!fs.existsSync(d)) return [];
                let results = [];
                const items = fs.readdirSync(d, { withFileTypes: true });
                for (const item of items) {
                    if (item.isDirectory()) {
                        results = results.concat(getAllFiles(path.join(d, item.name), `${prefix}${item.name}/`));
                    } else if (/\.(png|jpg|jpeg|webp|gif|mp3|wav|ogg)$/i.test(item.name)) {
                        results.push({ name: `${prefix}${item.name}`, path: path.join(d, item.name) });
                    }
                }
                return results;
            };

            let files = [];
            if (category === 'sprites') {
                files = files.concat(getAllFiles(path.join(botImagesPath, 'sprites'), 'sprites/'));
                files = files.concat(getAllFiles(path.join(botFilesPath, 'characters'), 'characters/'));
            } else {
                files = getAllFiles(dir, `${category}/`);
            }
            
            for (const fileObj of files) {
                const file = fileObj.name;
                if (manifest[category][file]) continue;

                console.log(`[Image Scan] Analyzing: ${category}/${file}`);
                const filePath = fileObj.path;
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
            return { success: true, message: "Manifest updated with new images." };
        }
        return { success: true, message: "No new images found." };
    });

    ipcMain.handle('send-chat', async (event, messages, options = {}) => {
        const config = loadConfig();
        const provider = config.activeProvider || Object.keys(config.apiKeys)[0];
        const apiKey = config.apiKeys ? config.apiKeys[provider] : null;
        const savedModel = config.models ? config.models[provider] : null;

        if (!apiKey) return "Error: No API key found. Please check your options.";

        const backgrounds = getFiles('backgrounds');
        let sprites = getFiles('sprites');
        const splashes = getFiles('splash');
        const music = getFiles('music');

        if (options.activeCharacters && Array.isArray(options.activeCharacters) && options.activeCharacters.length > 0) {
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
7. [HIDE: "Char"] removes character. HIDE when leaving.
8. Sprites are STICKY. Only tag on change.`;
        }

        let advancedPromptContent = "";
        try {
            if (fs.existsSync(advancedPromptPath)) {
                const content = fs.readFileSync(advancedPromptPath, 'utf8').trim();
                if (content) advancedPromptContent = `\n\n${content}`;
            }
        } catch (e) { console.error("Error reading advanced prompt:", e); }

        const enforcementRules = `\n\n[SYSTEM ENFORCEMENT]
1. DO NOT speak for the user. The user's actions and dialogue are provided in the chat history. Your response must only contain the characters' reactions and dialogue.
2. Maintain distinct personalities for each character. Do not let traits or knowledge bleed between characters defined in separate character sheets.
3. Ensure each character's voice remains consistent with their specific definition.${advancedPromptContent}`;

        const systemMsgIndex = messages.findIndex(m => m.role === 'system');
        if (systemMsgIndex > -1) {
            messages[systemMsgIndex].content += visualPrompt + enforcementRules;
        } else {
            messages.unshift({ role: 'system', content: visualPrompt + enforcementRules });
        }
        
        const webContents = event.sender;

        try {
            if (provider === 'gemini') {
                const modelName = savedModel || 'gemini-1.5-flash';
                const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:streamGenerateContent?key=${apiKey}`;
                
                const systemMsg = messages.find(m => m.role === 'system');
                const chatMsgs = messages.filter(m => m.role !== 'system');

                const geminiContents = chatMsgs.map(m => ({
                    role: m.role === 'user' ? 'user' : 'model',
                    parts: [{ text: m.content }]
                }));
                
                const requestBody = { contents: geminiContents };
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
                }

                const response = await axios.post(`${baseURL}/chat/completions`, {
                    model: model,
                    messages: messages,
                    stream: true
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
