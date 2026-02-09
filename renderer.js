const setupModal = document.getElementById('setup-modal');
const optionsModal = document.getElementById('options-modal');
const optionsBtn = document.getElementById('options-btn');
const closeOptionsBtn = document.getElementById('close-options-btn');
const keysList = document.getElementById('keys-list');
const userInput = document.getElementById('user-input');
const sendBtn = document.getElementById('send-btn');
const chatHistory = document.getElementById('chat-history');
const saveChatBtn = document.getElementById('save-chat-btn');
const loadChatBtn = document.getElementById('load-chat-btn');
const resetChatBtn = document.getElementById('reset-chat-btn');
const undoBtn = document.getElementById('undo-btn');
const loadModal = document.getElementById('load-modal');
const personaBtn = document.getElementById('persona-btn');
const personaModal = document.getElementById('persona-modal');
const closePersonaBtn = document.getElementById('close-persona-btn');
const savePersonaBtn = document.getElementById('save-persona-btn');
const summaryBtn = document.getElementById('summary-btn');
const summaryModal = document.getElementById('summary-modal');
const closeSummaryBtn = document.getElementById('close-summary-btn');
const saveSummaryBtn = document.getElementById('save-summary-btn');

// --- Initialization ---

let botInfo = { personality: '', scenario: '', initial: '', characters: {} };
let userPersona = { name: 'User', details: '' };
let chatSummary = { content: '' };
let imageManifest = { backgrounds: {}, sprites: {}, splash: {}, music: {} };
const activeSprites = new Map();
let currentMusic = null;
let musicVolume = 0.5;
let isMuted = false;

async function preloadImages() {
    const images = await window.api.getImages();
    const load = (list) => {
        list.forEach(file => {
            const img = new Image();
            img.src = `bot-resource://${file}`;
        });
    };
    load(images.backgrounds);
    // Sprites are now loaded on demand to save memory
    // load(images.sprites);
}

async function init() {
    // Inject CSS for multi-sprite support
    const spriteStyle = document.createElement('style');
    spriteStyle.textContent = `
        #vn-bg {
            width: 100%;
            height: 100%;
            object-fit: cover;
            position: absolute;
            top: 0;
            left: 0;
            z-index: 0;
        }
        .bg-overlay {
            width: 100%;
            height: 100%;
            object-fit: cover;
            position: absolute;
            top: 0;
            left: 0;
            z-index: 1;
            transition: opacity 1s ease-in-out;
        }
        #sprite-container {
            position: absolute;
            bottom: 0;
            left: 0;
            width: 100%;
            height: 100%;
            display: flex;
            justify-content: center;
            align-items: flex-end;
            pointer-events: none;
            overflow: hidden;
            z-index: 10;
        }
        .character-sprite {
            height: 90%;
            max-width: 60%;
            object-fit: contain;
            object-position: bottom;
            width: auto;
            transition: all 0.5s ease-in-out;
            will-change: transform, opacity;
            margin: 0 -2%;
            transform: translateY(20px);
            opacity: 0;
            filter: drop-shadow(0 0 5px rgba(0,0,0,0.3));
        }
        .character-sprite.active {
            transform: translateY(0);
            opacity: 1;
        }
        .msg-reroll-btn {
            background: none;
            border: none;
            color: #888;
            cursor: pointer;
            font-size: 18px;
            margin-left: 10px;
            padding: 0 5px;
            float: right;
        }
        .msg-reroll-btn:hover {
            color: #0078d4;
        }
        #splash-container {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            z-index: 20;
            pointer-events: none;
            opacity: 0;
            transition: opacity 1s ease-in-out;
        }
        #splash-container.active {
            opacity: 1;
            pointer-events: auto;
        }
        .splash-image {
            width: 100%;
            height: 100%;
            object-fit: cover;
        }
        #loading-overlay {
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.8);
            z-index: 9999;
            display: flex;
            justify-content: center;
            align-items: center;
            color: white;
            font-size: 24px;
            font-family: sans-serif;
            opacity: 0;
            pointer-events: none;
            transition: opacity 0.3s ease;
        }
        #loading-overlay.active {
            opacity: 1;
            pointer-events: auto;
        }
    `;
    document.head.appendChild(spriteStyle);

    // --- Title Screen Logic ---
    const titleScreenPromise = new Promise((resolve) => {
        const img = new Image();
        img.src = 'bot-resource://title/title_screen.png';
        img.onload = () => {
            const titleOverlay = document.createElement('div');
            titleOverlay.id = 'title-screen';
            titleOverlay.style.cssText = `
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background-image: url('bot-resource://title/title_screen.png');
                background-size: cover;
                background-position: center;
                z-index: 20000;
                cursor: pointer;
                display: flex;
                justify-content: flex-end;
                align-items: flex-end;
                transition: opacity 0.5s ease;
            `;
            
            const text = document.createElement('div');
            text.textContent = 'Click to Start';
            text.style.cssText = `
                color: white;
                font-family: sans-serif;
                font-size: 24px;
                margin: 40px;
                text-shadow: 2px 2px 4px rgba(0,0,0,0.8);
                font-weight: bold;
                animation: titlePulse 2s infinite;
            `;
            
            const animStyle = document.createElement('style');
            animStyle.textContent = `@keyframes titlePulse { 0% { opacity: 0.6; } 50% { opacity: 1; } 100% { opacity: 0.6; } }`;
            document.head.appendChild(animStyle);

            titleOverlay.appendChild(text);
            document.body.appendChild(titleOverlay);

            titleOverlay.addEventListener('click', () => {
                titleOverlay.style.opacity = '0';
                setTimeout(() => titleOverlay.remove(), 500);
                resolve();
            });
        };
        img.onerror = () => {
            resolve(); // No title screen found, proceed immediately
        };
    });
    // ---------------------------

    // --- Volume Controls Injection ---
    const volumeContainer = document.createElement('div');
    volumeContainer.id = 'volume-controls';
    volumeContainer.style.cssText = `
        position: absolute;
        top: 10px;
        right: 10px;
        z-index: 100;
        display: flex;
        align-items: center;
        background: rgba(0, 0, 0, 0.5);
        padding: 5px 10px;
        border-radius: 20px;
        color: white;
        backdrop-filter: blur(5px);
    `;
    
    const muteBtn = document.createElement('button');
    muteBtn.id = 'mute-btn';
    muteBtn.textContent = '🔊';
    muteBtn.style.cssText = `
        background: none;
        border: none;
        color: white;
        font-size: 16px;
        cursor: pointer;
        margin-right: 8px;
        padding: 0;
        line-height: 1;
    `;
    
    const volumeSlider = document.createElement('input');
    volumeSlider.type = 'range';
    volumeSlider.id = 'volume-slider';
    volumeSlider.min = 0;
    volumeSlider.max = 1;
    volumeSlider.step = 0.05;
    volumeSlider.value = musicVolume;
    volumeSlider.style.cssText = `
        width: 80px;
        cursor: pointer;
        accent-color: #0078d4;
    `;
    
    volumeContainer.appendChild(muteBtn);
    volumeContainer.appendChild(volumeSlider);
    
    const vnPanel = document.getElementById('vn-panel');
    if (vnPanel) {
        vnPanel.appendChild(volumeContainer);
    }

    const loadingOverlay = document.createElement('div');
    loadingOverlay.id = 'loading-overlay';
    loadingOverlay.innerHTML = '<div>Resetting Story...</div>';
    document.body.appendChild(loadingOverlay);

    muteBtn.addEventListener('click', () => {
        isMuted = !isMuted;
        muteBtn.textContent = isMuted ? '🔇' : '🔊';
        if (currentMusic) {
            currentMusic.muted = isMuted;
        }
    });

    volumeSlider.addEventListener('input', (e) => {
        musicVolume = parseFloat(e.target.value);
        if (currentMusic) {
            currentMusic.volume = musicVolume;
        }
        if (musicVolume > 0 && isMuted) {
            isMuted = false;
            muteBtn.textContent = '🔊';
            if (currentMusic) currentMusic.muted = false;
        }
    });
    // -------------------------------

    const config = await window.api.getConfig();
    const hasKeys = config.apiKeys && Object.keys(config.apiKeys).length > 0;

    preloadImages();

    // Wait for title screen interaction before showing UI
    await titleScreenPromise;

    if (!hasKeys) {
        // First run: Show setup modal
        setupModal.classList.remove('hidden');
    } else {
        // Normal run: Ready to chat
        console.log("Keys found, ready to chat.");
        botInfo = await window.api.getBotInfo();
        userPersona = await window.api.getPersona();
        chatSummary = await window.api.getSummary();
        imageManifest = await window.api.getImageManifest();

        // Try to load previous session
        const savedState = await window.api.loadCurrentChat();
        if (savedState && savedState.messages && savedState.messages.length > 0) {
            await restoreChatState(savedState);
        } else {
            await initializeChat();
        }
    }
}

init();

// --- Setup Modal Logic ---

document.getElementById('save-setup-btn').addEventListener('click', async () => {
    const provider = document.getElementById('setup-provider').value;
    const key = document.getElementById('setup-key').value.trim();
    const model = document.getElementById('setup-model').value.trim();

    if (!key) {
        alert("Please enter an API key.");
        return;
    }

    await window.api.saveApiKey(provider, key, model);
    setupModal.classList.add('hidden');
    
    const currentPersona = await window.api.getPersona();
    if (currentPersona.name === 'User' && !currentPersona.details) {
        if (confirm("Setup complete! Would you like to configure your persona now?")) {
            document.getElementById('persona-name').value = currentPersona.name;
            document.getElementById('persona-details').value = currentPersona.details;
            personaModal.classList.remove('hidden');
        }
    } else {
        alert("Setup complete!");
    }

    await initializeChat();
});

// --- Options Modal Logic ---

optionsBtn.addEventListener('click', () => {
    renderKeysList();
    optionsModal.classList.remove('hidden');
});

closeOptionsBtn.addEventListener('click', () => {
    optionsModal.classList.add('hidden');
});

document.getElementById('update-key-btn').addEventListener('click', async () => {
    const provider = document.getElementById('options-provider').value;
    const key = document.getElementById('options-key').value.trim();
    const model = document.getElementById('options-model').value.trim();

    if (!key) {
        alert("Please enter an API key.");
        return;
    }

    await window.api.saveApiKey(provider, key, model);
    document.getElementById('options-key').value = ''; // Clear input
    document.getElementById('options-model').value = ''; // Clear input
    renderKeysList(); // Refresh list
});

async function renderKeysList() {
    const config = await window.api.getConfig();
    keysList.innerHTML = '';

    if (!config.apiKeys || Object.keys(config.apiKeys).length === 0) {
        keysList.innerHTML = '<p style="color:#888;">No keys saved.</p>';
        return;
    }

    const activeProvider = config.activeProvider;

    for (const [provider, key] of Object.entries(config.apiKeys)) {
        const item = document.createElement('div');
        item.className = 'key-item';
        
        // Mask the key for display
        const maskedKey = key.substring(0, 4) + '...' + key.substring(key.length - 4);
        const modelName = (config.models && config.models[provider]) ? ` (${config.models[provider]})` : '';
        const isActive = provider === activeProvider;
        
        item.innerHTML = `
            <span><strong>${provider}${modelName}:</strong> ${maskedKey} ${isActive ? ' <span style="color:lime; font-weight:bold;">[ACTIVE]</span>' : ''}</span>
            <div>
                ${!isActive ? `<button class="activate-btn" data-provider="${provider}" style="background:#0078d4; color:white; border:none; border-radius:3px; cursor:pointer; margin-right:5px;">Use</button>` : ''}
                <button class="delete-btn" data-provider="${provider}" style="background:#d13438; color:white; border:none; border-radius:3px; cursor:pointer;">Delete</button>
            </div>
        `;
        keysList.appendChild(item);
    }

    // Add activate handlers
    document.querySelectorAll('.activate-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const provider = e.target.getAttribute('data-provider');
            await window.api.setActiveProvider(provider);
            renderKeysList();
        });
    });

    // Add delete handlers
    document.querySelectorAll('.delete-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const provider = e.target.getAttribute('data-provider');
            if (confirm(`Remove key for ${provider}?`)) {
                await window.api.deleteApiKey(provider);
                renderKeysList();
            }
        });
    });
}

document.getElementById('test-provider-btn').addEventListener('click', async () => {
    const btn = document.getElementById('test-provider-btn');
    const originalText = btn.textContent;
    btn.textContent = "Testing...";
    btn.disabled = true;
    const result = await window.api.testProvider();
    alert(result.message);
    btn.textContent = originalText;
    btn.disabled = false;
});

document.getElementById('scan-images-btn').addEventListener('click', async () => {
    const btn = document.getElementById('scan-images-btn');
    const originalText = btn.textContent;
    btn.textContent = "Scanning... (this may take a while)";
    btn.disabled = true;
    const result = await window.api.scanImages();
    alert(result.message);
    btn.textContent = originalText;
    btn.disabled = false;
});

// --- Persona Logic ---

personaBtn.addEventListener('click', async () => {
    userPersona = await window.api.getPersona();
    document.getElementById('persona-name').value = userPersona.name || '';
    document.getElementById('persona-details').value = userPersona.details || '';
    personaModal.classList.remove('hidden');
});

closePersonaBtn.addEventListener('click', () => {
    personaModal.classList.add('hidden');
});

savePersonaBtn.addEventListener('click', async () => {
    const name = document.getElementById('persona-name').value.trim() || 'User';
    const details = document.getElementById('persona-details').value.trim();
    
    userPersona = { name, details };
    await window.api.savePersona(userPersona);
    
    personaModal.classList.add('hidden');
    alert("Persona saved!");

    if (messages.length <= 1) {
        await initializeChat();
    }
});

// --- Summary Logic ---

summaryBtn.addEventListener('click', async () => {
    chatSummary = await window.api.getSummary();
    document.getElementById('summary-content').value = chatSummary.content || '';
    summaryModal.classList.remove('hidden');
});

closeSummaryBtn.addEventListener('click', () => {
    summaryModal.classList.add('hidden');
});

saveSummaryBtn.addEventListener('click', async () => {
    const content = document.getElementById('summary-content').value.trim();
    chatSummary = { content };
    await window.api.saveSummary(chatSummary);
    summaryModal.classList.add('hidden');
    alert("Summary saved!");
});

// --- Chat Logic ---

let messages = []; // Store conversation history

function parseMarkdown(text) {
    if (!text) return '';
    // Basic HTML escaping to prevent XSS
    let html = text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");

    // Bold + Italic (***text***)
    html = html.replace(/\*\*\*(.*?)\*\*\*/g, '<strong><em>$1</em></strong>');
    // Bold (**text**)
    html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    // Italic (*text*)
    html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');

    // Convert newlines to <br>
    return html.replace(/\n/g, '<br>');
}

function appendMessage(role, text, index) {
    const msgDiv = document.createElement('div');
    msgDiv.className = `message ${role}`;
    
    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';
    contentDiv.innerHTML = parseMarkdown(text);
    msgDiv.appendChild(contentDiv);

    if (typeof index === 'number') {
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'msg-delete-btn';
        deleteBtn.innerHTML = '×';
        deleteBtn.title = 'Delete this message and all following';
        deleteBtn.onclick = () => {
            if (confirm('Delete this message and all subsequent messages?')) {
                messages.splice(index);
                renderChat();
                saveCurrentChatState();
            }
        };
        msgDiv.appendChild(deleteBtn);

        // Reroll button (only for last message and if assistant)
        if (index === messages.length - 1 && role === 'assistant') {
            const rerollBtn = document.createElement('button');
            rerollBtn.className = 'msg-reroll-btn';
            rerollBtn.innerHTML = '↻';
            rerollBtn.title = 'Reroll this message';
            rerollBtn.onclick = () => regenerateResponse();
            msgDiv.appendChild(rerollBtn);
        }
    }

    chatHistory.appendChild(msgDiv);
    // Auto-scroll to bottom
    chatHistory.scrollTop = chatHistory.scrollHeight;
}

// Keywords for basic sentiment analysis
const moodKeywords = {
    'Happy': ['happy', 'smile', 'laugh', 'joy', 'excited', 'glad', 'grin', 'chuckle', 'giggle', 'warmly'],
    'Sad': ['sad', 'cry', 'tear', 'sorrow', 'depressed', 'grief', 'sob', 'upset', 'distant', 'gloomy'],
    'Angry': ['angry', 'mad', 'rage', 'fury', 'hate', 'resent', 'annoyed', 'glare', 'tense', 'frown'],
    'Scared': ['scared', 'fear', 'afraid', 'terrified', 'horror', 'panic', 'shiver', 'shock', 'gasp'],
    'Flirty': ['flirty', 'coy', 'blush', 'love', 'cute', 'hot', 'kiss', 'wink', 'seductive'],
    'Anxious': ['anxious', 'nervous', 'worry', 'guarded', 'hesitant', 'shy', 'uneasy'],
    'Surprised': ['surprised', 'shocked', 'stunned', 'disbelief', 'wide-eyed']
};

function getMood(text) {
    const lowerText = text.toLowerCase();
    let bestMood = 'Default';
    let maxHits = 0;

    for (const [mood, keywords] of Object.entries(moodKeywords)) {
        let hits = 0;
        keywords.forEach(word => {
            if (lowerText.includes(word)) hits++;
        });
        if (hits > maxHits) {
            maxHits = hits;
            bestMood = mood;
        }
    }
    return bestMood;
}

function validateImage(filename, type) {
    if (!imageManifest[type]) return null;
    
    // Decode in case it's URL encoded
    let cleanName = decodeURIComponent(filename);

    // Clean filename of potential trailing/leading quotes or slashes
    cleanName = cleanName.replace(/^['"\\/]+|['"\\/]+$/g, '').trim();
    
    // Normalize slashes to forward slash for comparison
    cleanName = cleanName.replace(/\\/g, '/');

    // 1. Check if it exists as a key directly
    if (imageManifest[type][cleanName]) return cleanName;

    const keys = Object.keys(imageManifest[type]);
    const lowerClean = cleanName.toLowerCase();

    // 2. Try adding extensions (if missing)
    const extensions = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.mp3', '.wav', '.ogg'];
    for (const ext of extensions) {
        if (imageManifest[type][cleanName + ext]) return cleanName + ext;
    }

    // 3. Fuzzy match (Fallback for hallucinations like "coffee_shop" -> "coffee_shop.png")
    for (const key of keys) {
        const lowerKey = key.toLowerCase();
        
        // Strict case-insensitive match
        if (lowerKey === lowerClean) return key;
        
        // Match without extension
        const keyNoExt = lowerKey.substring(0, lowerKey.lastIndexOf('.'));
        if (keyNoExt === lowerClean) return key;

        // Check for short path match (suffix)
        if (keyNoExt.endsWith(lowerClean)) {
            const prefixIndex = keyNoExt.length - lowerClean.length;
            if (prefixIndex === 0 || keyNoExt[prefixIndex - 1] === '/') {
                return key;
            }
        }
        
        // Handle "Character/Sprite" format where file might be "Character_Sprite.png"
        if (lowerClean.includes('/')) {
            const parts = lowerClean.split('/');
            if (parts.length === 2) {
                const [group, item] = parts;
                // Check if key is in the correct group folder
                if (lowerKey.includes(`/${group}/`) || lowerKey.startsWith(`${group}/`)) {
                    const keyFilename = lowerKey.split('/').pop();
                    const keyFilenameNoExt = keyFilename.substring(0, keyFilename.lastIndexOf('.'));
                    
                    if (keyFilenameNoExt.includes(item)) {
                        return key;
                    }
                }
            }
        }
    }
    
    return null;
}

function findBestSprite(characterName, mood) {
    // Filter manifest for this character
    const charFiles = Object.keys(imageManifest.sprites).filter(file => getCharacterName(file) === characterName);
    if (charFiles.length === 0) return null;

    // 1. Try to find exact mood match in parentheses e.g. "(Happy)"
    for (const file of charFiles) {
        const desc = imageManifest.sprites[file];
        if (desc && desc.toLowerCase().includes(`(${mood.toLowerCase()})`)) {
            return file;
        }
    }

    // 2. If no exact match, search description for mood name
    if (mood !== 'Default') {
        for (const file of charFiles) {
            const desc = imageManifest.sprites[file];
            if (desc && desc.toLowerCase().includes(mood.toLowerCase())) {
                return file;
            }
        }
    }

    // 3. Fallback to Default
    for (const file of charFiles) {
        const desc = imageManifest.sprites[file];
        if (desc && desc.toLowerCase().includes('default')) {
            return file;
        }
    }
    
    // 4. Absolute fallback to first sprite
    return charFiles[0];
}

function setupSpriteContainer() {
    let container = document.getElementById('sprite-container');
    if (!container) {
        const oldSprite = document.getElementById('vn-sprite');
        if (oldSprite && oldSprite.parentNode) {
            container = document.createElement('div');
            container.id = 'sprite-container';
            oldSprite.parentNode.insertBefore(container, oldSprite);
            oldSprite.style.display = 'none'; // Hide legacy sprite
        }
    }
    return container;
}

function getCharacterName(filename) {
    // Handle paths like "characters/Jessica/happy.png" or "sprites/Jessica/happy.png"
    const parts = filename.split(/[/\\]/);
    
    if (parts[0] === 'characters' && parts.length >= 3) {
        return parts[1].toLowerCase();
    }
    if (parts[0] === 'sprites' && parts.length >= 3) {
        return parts[1].toLowerCase();
    }
    // Handle short paths like "Jessica/happy.png" (parts = ['Jessica', 'happy.png'])
    if (parts.length === 2) {
        return parts[0].toLowerCase();
    }
    
    // Heuristic: "jessica_happy.png" -> "jessica"
    const base = filename.split('/').pop();
    return base.split(/[_\-\.]/)[0].toLowerCase();
}

function changeBackground(filename) {
    hideSplash();
    const bgElement = document.getElementById('vn-bg');
    if (!bgElement) return;

    const newSrc = `bot-resource://${filename}`;
    // Don't transition if it's the same image
    if (bgElement.src === newSrc) return;

    // Create an overlay with the OLD image
    const overlay = document.createElement('img');
    overlay.src = bgElement.src;
    overlay.className = 'bg-overlay';
    bgElement.parentNode.insertBefore(overlay, bgElement.nextSibling);

    // Set the main element to the NEW image immediately (behind overlay)
    bgElement.src = newSrc;

    // Fade out the overlay
    requestAnimationFrame(() => {
        overlay.style.opacity = '0';
    });

    // Remove overlay after transition
    setTimeout(() => {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }, 1000);
}

function getSpriteRects() {
    const rects = new Map();
    activeSprites.forEach((img, name) => {
        rects.set(name, img.getBoundingClientRect());
    });
    return rects;
}

function updateSprite(filename) {
    hideSplash();
    const container = setupSpriteContainer();
    if (!container) return;

    // Capture positions of existing sprites before adding new one
    const oldRects = getSpriteRects();

    const name = getCharacterName(filename);
    let img = activeSprites.get(name);

    if (!img) {
        img = document.createElement('img');
        img.className = 'character-sprite';
        img.decoding = 'async';
        img.src = `bot-resource://${filename}`;
        container.appendChild(img);
        activeSprites.set(name, img);
        
        // Force reflow to ensure transition plays
        void img.offsetWidth; 
        img.classList.add('active');
    } else {
        if (!img.src.includes(filename)) {
            img.src = `bot-resource://${filename}`;
        }
        if (!img.classList.contains('active')) {
            img.classList.add('active');
        }
    }

    // Animate existing sprites sliding to new positions (FLIP)
    animateLayoutChanges(oldRects);
}

function hideSprite(nameOrFilename) {
    hideSplash();
    // Capture positions before removing
    const oldRects = getSpriteRects();

    let name = getCharacterName(nameOrFilename);
    let img = activeSprites.get(name);

    // Fuzzy match if not found (e.g. "Jessica Smith" vs "jessica")
    if (!img) {
        const lowerInput = nameOrFilename.toLowerCase();
        for (const [key, val] of activeSprites.entries()) {
            if (lowerInput.includes(key)) {
                name = key;
                img = val;
                break;
            }
        }
    }

    if (img) {
        img.classList.remove('active');
        setTimeout(() => {
            if (img.parentNode) {
                img.parentNode.removeChild(img);
                // Animate remaining sprites sliding to fill gap
                // Note: We capture rects *before* removal, but we can only animate 
                // the remaining ones. The removed one fades out via CSS.
                // However, the layout shift happens when the element is removed from flow.
                // Since we wait 500ms to remove, the slide happens AFTER fade out.
                // To make them slide *while* fading requires absolute positioning or 
                // more complex layout logic. 
                // With current logic, they will slide after the sprite is gone from DOM.
            }
            img.src = ''; // Clear source to assist with memory release
        }, 500); // Match CSS transition
        activeSprites.delete(name);
    }
}

function showSplash(filename) {
    let container = document.getElementById('splash-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'splash-container';
        const img = document.createElement('img');
        img.className = 'splash-image';
        container.appendChild(img);
        
        // Insert into panel
        const panel = document.getElementById('vn-panel');
        panel.appendChild(container);
    }
    
    const img = container.querySelector('img');
    img.src = `bot-resource://${filename}`;
    
    // Force reflow
    void container.offsetWidth;
    container.classList.add('active');
}

function hideSplash() {
    const container = document.getElementById('splash-container');
    if (container) {
        container.classList.remove('active');
    }
}

function playMusic(filename) {
    const isStop = !filename || filename.toLowerCase() === 'none' || filename.toLowerCase() === 'stop';

    if (currentMusic) {
        // Check if same music is requested
        if (!isStop) {
            const currentSrc = decodeURIComponent(currentMusic.src);
            if (currentSrc.includes(filename)) {
                return;
            }
        }
        
        // Stop current music
        if (currentMusic.loopTimer) clearTimeout(currentMusic.loopTimer);
        
        const oldMusic = currentMusic;
        if (oldMusic.fadeInterval) clearInterval(oldMusic.fadeInterval);
        fadeOut(oldMusic);
        currentMusic = null;
    }
    
    if (isStop) return;

    currentMusic = createAudioObject(filename);
    
    currentMusic.play().then(() => {
        fadeIn(currentMusic);
    }).catch(e => console.error("Failed to play music:", e));
}

function createAudioObject(filename) {
    const audio = new Audio(`bot-resource://${filename}`);
    audio.loop = false; // We handle looping manually for crossfade
    audio.muted = isMuted;
    audio.volume = 0;

    audio.addEventListener('loadedmetadata', () => {
        const duration = audio.duration * 1000; // ms
        if (duration > LOOP_CROSSFADE_DURATION * 2) {
            const timeUntilLoop = duration - LOOP_CROSSFADE_DURATION;
            audio.loopTimer = setTimeout(() => {
                triggerLoop(filename);
            }, timeUntilLoop);
        } else {
            audio.loop = true; // Fallback for short clips
        }
    });
    return audio;
}

function triggerLoop(filename) {
    if (!currentMusic) return; // Music stopped
    
    const oldMusic = currentMusic;
    const newMusic = createAudioObject(filename);
    
    currentMusic = newMusic; // Update reference so stop commands affect the new one
    
    newMusic.play().then(() => {
        fadeIn(newMusic, LOOP_CROSSFADE_DURATION);
        fadeOut(oldMusic, LOOP_CROSSFADE_DURATION);
    }).catch(e => console.error("Loop failed:", e));
}

function fadeOut(audio, duration = 1000) {
    if (!audio) return;
    const interval = 50;
    const step = audio.volume / (duration / interval);
    
    const fadeId = setInterval(() => {
        if (audio.volume > step) {
            audio.volume -= step;
        } else {
            audio.volume = 0;
            audio.pause();
            clearInterval(fadeId);
        }
    }, interval);
    audio.fadeInterval = fadeId;
}

function fadeIn(audio, duration = 1000) {
    if (!audio) return;
    const interval = 50;
    
    const fadeId = setInterval(() => {
        const target = musicVolume;
        const step = target / (duration / interval);
        
        if (audio.volume < target - step) {
            audio.volume += step;
        } else {
            audio.volume = target;
            clearInterval(fadeId);
            audio.fadeInterval = null;
        }
    }, interval);
    audio.fadeInterval = fadeId;
}

function animateLayoutChanges(oldRects) {
    activeSprites.forEach((img, name) => {
        const oldRect = oldRects.get(name);
        if (oldRect) {
            const newRect = img.getBoundingClientRect();
            const dx = oldRect.left - newRect.left;
            if (dx !== 0) {
                // Invert: Move back to old position
                img.style.transition = 'none';
                img.style.transform = `translateX(${dx}px) translateY(0)`;
                
                // Force reflow
                void img.offsetWidth;

                // Play: Animate to new position
                img.style.transition = 'all 0.5s ease-in-out';
                img.style.transform = ''; // Revert to CSS class (translateY(0))
            }
        }
    });
}

function processVisualTags(text) {
    // Regex to find tags (global, case-insensitive, handles optional quotes)
    const bgRegex = /\[BG:\s*["']?([^"\]]*)["']?\]/gi;
    const spriteRegex = /\[SPRITE:\s*["']?([^"\]]*)["']?\]/gi;
    const splashRegex = /\[SPLASH:\s*["']?([^"\]]*)["']?\]/gi;
    const musicRegex = /\[MUSIC:\s*["']?([^"\]]*)["']?\]/gi;
    const hideRegex = /\[HIDE:\s*["']?([^"\]]*)["']?\]/gi;

    // Collect all matches
    const matches = [];
    const addMatches = (regex, type) => {
        for (const match of text.matchAll(regex)) {
            matches.push({
                type,
                value: match[1].trim(),
                index: match.index
            });
        }
    };
    addMatches(bgRegex, 'bg');
    addMatches(spriteRegex, 'sprite');
    addMatches(splashRegex, 'splash');
    addMatches(musicRegex, 'music');
    addMatches(hideRegex, 'hide');

    // Sort by index to process in order
    matches.sort((a, b) => a.index - b.index);

    // Auto-hide splash if no splash tag is present in the new text
    if (!matches.some(m => m.type === 'splash')) {
        hideSplash();
    }

    // Process all tags in order
    matches.forEach(match => {
        if (match.type === 'bg') {
            if (match.value) {
                const validBg = validateImage(match.value, 'backgrounds');
                if (validBg) {
                    changeBackground(validBg);
                } else {
                    console.warn(`[Visual Novel] Invalid BG tag ignored: ${match.value}`);
                }
            }
        } else if (match.type === 'sprite') {
            const validSprite = validateImage(match.value, 'sprites');
            if (validSprite) {
                updateSprite(validSprite);
            } else {
                console.warn(`[Visual Novel] Invalid SPRITE tag ignored: ${match.value}`);
            }
        } else if (match.type === 'splash') {
            const validSplash = validateImage(match.value, 'splash');
            if (validSplash) {
                showSplash(validSplash);
            } else {
                console.warn(`[Visual Novel] Invalid SPLASH tag ignored: ${match.value}`);
            }
        } else if (match.type === 'music') {
            const validMusic = validateImage(match.value, 'music');
            if (validMusic) {
                playMusic(validMusic);
            } else if (match.value.toLowerCase() === 'stop') {
                playMusic(null);
            } else {
                console.warn(`[Visual Novel] Invalid MUSIC tag ignored: ${match.value}`);
            }
        } else if (match.type === 'hide') {
            hideSprite(match.value);
        }
    });

    // Remove ALL tags from the text so they don't clutter history/tokens
    return text.replace(bgRegex, '').replace(spriteRegex, '').replace(hideRegex, '').replace(splashRegex, '').replace(musicRegex, '');
}

async function initializeChat() {
    const overlay = document.getElementById('loading-overlay');
    if (overlay) overlay.classList.add('active');
    // Clear input immediately to prevent stale text issues
    userInput.value = '';

    try {
        messages = [];
        renderChat();
        
        // Reset sprites
        activeSprites.forEach(img => img.remove());
        activeSprites.clear();
        hideSplash();
        playMusic(null);

        let initialText = botInfo.initial || "⚠️ Error: Could not load 'bot/files/initial.txt'. Please check that the file exists in the correct folder.";
        initialText = initialText.replace(/{{user}}/g, userPersona.name);

        // If no tags are present, ask the AI to pick images based on the text
        if (!initialText.includes('[BG:')) {
            const tagPrompt = [
                { role: 'system', content: "Analyze the following text and generate the most appropriate [BG: \"filename\"] and [SPRITE: \"Character/Expression\"] tags from the available options. Output ONLY the tags." },
                { role: 'user', content: initialText }
            ];
            try {
                const tagResponse = await window.api.sendChat(tagPrompt);
                processVisualTags(tagResponse);
            } catch (e) {
                console.error("Failed to auto-scan images:", e);
            }
        }

        const cleanText = processVisualTags(initialText);
        messages.push({ role: 'assistant', content: cleanText.trim() });
        turnCount = 0; // Reset turn count on new chat
        renderChat();
        saveCurrentChatState();
    } catch (e) {
        console.error("Error initializing chat:", e);
        alert("An error occurred while resetting the chat.");
    } finally {
        if (overlay) overlay.classList.remove('active');
        userInput.disabled = false;
        userInput.focus();
    }
}

async function restoreChatState(state) {
    messages = state.messages;
    
    // Restore Background
    if (state.background) {
        const validBg = validateImage(state.background, 'backgrounds');
        if (validBg) {
            document.getElementById('vn-bg').src = `bot-resource://${validBg}`;
        }
    }

    // Restore Sprites
    activeSprites.forEach(img => img.remove());
    activeSprites.clear();
    if (state.sprites && Array.isArray(state.sprites)) {
        state.sprites.forEach(filename => updateSprite(filename));
    }

    if (state.splash) {
        showSplash(state.splash);
    } else {
        hideSplash();
    }

    if (state.music) {
        playMusic(state.music);
    } else {
        playMusic(null);
    }

    renderChat();
    console.log("Chat state restored.");
}

async function saveCurrentChatState() {
    const bgSrc = document.getElementById('vn-bg').src;
    // Extract relative path from bot-resource URL if present
    let bgFilename = bgSrc.includes('bot-resource://') ? bgSrc.split('bot-resource://')[1] : '';
    bgFilename = decodeURIComponent(bgFilename);
    
    const spriteFilenames = [];
    activeSprites.forEach(img => {
        if (img.src.includes('bot-resource://')) {
            let src = img.src.split('bot-resource://')[1];
            spriteFilenames.push(decodeURIComponent(src));
        }
    });

    const splashContainer = document.getElementById('splash-container');
    let splashFilename = '';
    if (splashContainer && splashContainer.classList.contains('active')) {
         const img = splashContainer.querySelector('img');
         if (img && img.src.includes('bot-resource://')) {
             splashFilename = decodeURIComponent(img.src.split('bot-resource://')[1]);
         }
    }

    let musicFilename = '';
    if (currentMusic && !currentMusic.paused) {
         if (currentMusic.src.includes('bot-resource://')) {
             musicFilename = decodeURIComponent(currentMusic.src.split('bot-resource://')[1]);
         }
    }

    const state = {
        messages,
        background: bgFilename,
        sprites: spriteFilenames,
        splash: splashFilename,
        music: musicFilename
    };
    await window.api.saveCurrentChat(state);
}

function renderChat() {
    chatHistory.innerHTML = '';
    messages.forEach((msg, index) => {
        appendMessage(msg.role, msg.content, index);
    });
    chatHistory.scrollTop = chatHistory.scrollHeight;
}

async function updateHistorySummary(isFullRewrite) {
    // Optimize token usage by converting messages to a simple string format instead of JSON
    const recentMessages = messages.slice(-20).map(m => `${m.role === 'user' ? 'User' : 'AI'}: ${m.content}`).join('\n');
    let promptMessages = [];

    if (isFullRewrite) {
        // Full Summary (Every 50 turns)
        promptMessages = [
            { role: 'system', content: "You are an expert storyteller. Summarize the entire story so far into a concise narrative, incorporating the previous summary and recent events." },
            { role: 'user', content: `Previous Summary:\n${chatSummary.content}\n\nRecent Events:\n${recentMessages}` }
        ];
    } else {
        // Incremental Summary (Every 10 turns)
        promptMessages = [
            { role: 'system', content: "Summarize the following conversation events in 2-3 sentences to append to a history log." },
            { role: 'user', content: recentMessages }
        ];
    }

    try {
        // Show a small indicator
        const updateDiv = document.createElement('div');
        updateDiv.className = 'message system';
        updateDiv.textContent = 'Updating history...';
        chatHistory.appendChild(updateDiv);
        chatHistory.scrollTop = chatHistory.scrollHeight;

        const summaryUpdate = await window.api.sendChat(promptMessages);
        
        if (isFullRewrite) {
            chatSummary.content = summaryUpdate;
        } else {
            chatSummary.content += (chatSummary.content ? "\n\n" : "") + summaryUpdate;
        }
        
        await window.api.saveSummary(chatSummary);
        updateDiv.textContent = 'History updated.';
    } catch (e) {
        console.error("Failed to update summary:", e);
    }
}

function getSceneContext(userText) {
    // 1. Start with currently visible characters
    const activeNames = new Set(activeSprites.keys());

    // 2. Add characters mentioned in the user's text (so they can enter the scene)
    if (userText && botInfo.characters) {
        const lowerText = userText.toLowerCase();
        Object.keys(botInfo.characters).forEach(name => {
            if (lowerText.includes(name.toLowerCase())) {
                activeNames.add(name.toLowerCase());
            }
        });
    }

    // 3. If scene is empty (start of chat), include everyone to be safe
    if (activeNames.size === 0 && botInfo.characters) {
        Object.keys(botInfo.characters).forEach(name => activeNames.add(name.toLowerCase()));
    }

    return Array.from(activeNames);
}

async function streamChat(payload, sceneCharacters) {
    // Create a message div for the assistant immediately
    const msgIndex = messages.length;
    appendMessage('assistant', '', msgIndex); 
    const msgDivs = chatHistory.getElementsByClassName('message assistant');
    const lastMsgDiv = msgDivs[msgDivs.length - 1];
    const contentDiv = lastMsgDiv.querySelector('.message-content');
    
    // Add typing indicator initially
    contentDiv.innerHTML = '<div class="typing-dots"><span></span><span></span><span></span></div>';

    let accumulatedText = '';
    let hasReceivedChunk = false;

    const removeListener = window.api.onChatReplyChunk((chunk) => {
        if (!hasReceivedChunk) {
            contentDiv.innerHTML = ''; // Clear typing dots on first chunk
            hasReceivedChunk = true;
        }
        accumulatedText += chunk;
        contentDiv.innerHTML = parseMarkdown(accumulatedText);
        chatHistory.scrollTop = chatHistory.scrollHeight;
    });

    try {
        const fullResponse = await window.api.sendChat(payload, { activeCharacters: sceneCharacters });
        
        // Process visual tags now that we have the full text
        const cleanResponse = processVisualTags(fullResponse);
        
        // Update the message content one last time with the processed text (tags removed)
        contentDiv.innerHTML = parseMarkdown(cleanResponse);
        
        return cleanResponse.trim();
    } catch (e) {
        contentDiv.innerHTML += `<br><span style="color:red">Error: ${e.message}</span>`;
        throw e;
    } finally {
        removeListener();
    }
}

async function handleSend() {
    const text = userInput.value.trim();
    if (!text) return;

    // 1. Show user message immediately
    appendMessage('user', text, messages.length);
    userInput.value = '';
    messages.push({ role: 'user', content: text });

    // 2. Prepare Payload
    let systemContent = [botInfo.personality, botInfo.scenario].filter(Boolean).join('\n\n');
    
    // Determine active characters for this turn
    const sceneCharacters = getSceneContext(text);
    
    // Inject only relevant character personalities
    sceneCharacters.forEach(name => {
        // Find the key in botInfo.characters that matches the lowercase name
        const realName = Object.keys(botInfo.characters).find(k => k.toLowerCase() === name);
        if (realName) {
            systemContent += `\n\n[Character: ${realName}]\n${botInfo.characters[realName]}`;
        }
    });

    // Inject Persona
    systemContent += `\n\n[USER INFO]\nName: ${userPersona.name}\nDetails: ${userPersona.details}`;
    
    // Replace {{user}} placeholder in system prompt
    systemContent = systemContent.replace(/{{user}}/g, userPersona.name);

    // Inject Summary
    if (chatSummary && chatSummary.content) {
        systemContent += `\n\n[STORY SUMMARY]\n${chatSummary.content}`;
    }

    const payload = systemContent ? [{ role: 'system', content: systemContent }, ...messages] : messages;
    
    // 3. Stream Response
    const cleanResponse = await streamChat(payload, sceneCharacters);
    
    messages.push({ role: 'assistant', content: cleanResponse });
    saveCurrentChatState();

    // Auto-Summary Logic
    turnCount++;
    if (turnCount > 0 && turnCount % 10 === 0) {
        const isFullRewrite = (turnCount % 50 === 0);
        updateHistorySummary(isFullRewrite);
    }
}

async function regenerateResponse() {
    if (messages.length === 0) return;
    
    // Remove the last assistant message
    const lastMsg = messages[messages.length - 1];
    if (lastMsg.role === 'assistant') {
        messages.pop();
    }
    
    renderChat(); // Update UI to remove the old message

    // Construct payload (same as handleSend but without adding new user msg)
    let systemContent = [botInfo.personality, botInfo.scenario].filter(Boolean).join('\n\n');
    
    // For reroll, use current active sprites as context
    const sceneCharacters = getSceneContext(''); 
    sceneCharacters.forEach(name => {
        const realName = Object.keys(botInfo.characters).find(k => k.toLowerCase() === name);
        if (realName) {
            systemContent += `\n\n[Character: ${realName}]\n${botInfo.characters[realName]}`;
        }
    });

    systemContent += `\n\n[USER INFO]\nName: ${userPersona.name}\nDetails: ${userPersona.details}`;
    systemContent = systemContent.replace(/{{user}}/g, userPersona.name);
    if (chatSummary && chatSummary.content) {
        systemContent += `\n\n[STORY SUMMARY]\n${chatSummary.content}`;
    }

    const payload = systemContent ? [{ role: 'system', content: systemContent }, ...messages] : messages;
    const cleanResponse = await streamChat(payload, sceneCharacters);

    messages.push({ role: 'assistant', content: cleanResponse });
    saveCurrentChatState();
}

sendBtn.addEventListener('click', handleSend);
userInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault(); // Prevent new line
        handleSend();
    }
});

// --- Chat Management Logic ---

// Save Chat
saveChatBtn.addEventListener('click', async () => {
    if (messages.length === 0) {
        alert("Nothing to save!");
        return;
    }
    const name = prompt("Enter a name for this chat:");
    if (name) {
        const success = await window.api.saveChat(name, messages);
        if (success) alert("Chat saved!");
    }
});

// Load Chat
loadChatBtn.addEventListener('click', async () => {
    const chats = await window.api.getChats();
    const list = document.getElementById('saved-chats-list');
    list.innerHTML = '';
    
    if (chats.length === 0) {
        list.innerHTML = '<p>No saved chats found.</p>';
    } else {
        chats.forEach(name => {
            const div = document.createElement('div');
            div.className = 'key-item'; // Reuse style
            div.innerHTML = `<span>${name}</span> <button class="load-select-btn" data-name="${name}">Load</button>`;
            list.appendChild(div);
        });
        
        document.querySelectorAll('.load-select-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const name = e.target.getAttribute('data-name');
                messages = await window.api.loadChat(name);
                renderChat();
                saveCurrentChatState();
                loadModal.classList.add('hidden');
            });
        });
    }
    loadModal.classList.remove('hidden');
});

document.getElementById('close-load-btn').addEventListener('click', () => {
    loadModal.classList.add('hidden');
});

// Reset Chat
resetChatBtn.addEventListener('click', async () => {
    if (confirm("Are you sure you want to clear the current chat?")) {
        // Use setTimeout to detach from the confirm dialog's event loop to prevent stuck keys
        setTimeout(async () => {
            chatSummary = { content: '' };
            await window.api.saveSummary(chatSummary);
            await initializeChat();
        }, 100);
    }
});

// Undo Last Message
undoBtn.addEventListener('click', () => {
    if (messages.length > 0) {
        // Remove last message (Assistant) and the one before it (User)
        messages.pop(); 
        if (messages.length > 0 && messages[messages.length - 1].role === 'user') {
            messages.pop();
        }
        renderChat();
        saveCurrentChatState();
    }
});

// --- Resizer Logic ---

const resizer = document.getElementById('resizer');
const vnPanel = document.getElementById('vn-panel');
const mainBody = document.getElementById('main-body');

let isResizing = false;
let animationFrameId = null;

resizer.addEventListener('mousedown', (e) => {
    isResizing = true;
    document.body.style.cursor = 'col-resize';
    e.preventDefault(); // Prevent text selection
});

document.addEventListener('mousemove', (e) => {
    if (!isResizing) return;
    
    if (animationFrameId) return; // Skip if a frame is already pending
    animationFrameId = requestAnimationFrame(() => {
        const containerWidth = mainBody.offsetWidth;
        const newWidth = (e.clientX / containerWidth) * 100;
        if (newWidth > 10 && newWidth < 90) { // Limit between 10% and 90%
            vnPanel.style.width = `${newWidth}%`;
        }
        animationFrameId = null;
    });
});

document.addEventListener('mouseup', () => {
    isResizing = false;
    document.body.style.cursor = 'default';
});