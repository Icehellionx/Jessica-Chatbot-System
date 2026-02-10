const userInput = document.getElementById('user-input');
const sendBtn = document.getElementById('send-btn');
const chatHistory = document.getElementById('chat-history');

// --- Initialization ---

async function init() {
    setupVisuals();
    setupUI({ initializeChat, renderChat, saveCurrentChatState, regenerateResponse });

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

            playMusic('music/main_theme.mp3');

            titleOverlay.addEventListener('click', () => {
                titleOverlay.style.opacity = '0';
                titleOverlay.style.pointerEvents = 'none';
                setTimeout(() => titleOverlay.remove(), 500);
                resolve();
            });
        };
        img.onerror = () => {
            resolve(); // No title screen found, proceed immediately
        };
    });
    // ---------------------------

    setupVolumeControls();

    const loadingOverlay = document.createElement('div');
    loadingOverlay.id = 'loading-overlay';
    loadingOverlay.innerHTML = '<div>Resetting Story...</div>';
    document.body.appendChild(loadingOverlay);

    const config = await window.api.getConfig();
    const hasKeys = config.apiKeys && Object.keys(config.apiKeys).length > 0;

    preloadImages();
    
    // Load data unconditionally so it is available for setup/first run
    window.botInfo = await window.api.getBotInfo();
    window.userPersona = await window.api.getPersona();
    window.chatSummary = await window.api.getSummary();
    window.imageManifest = await window.api.getImageManifest();

    // Wait for title screen interaction before showing UI
    await titleScreenPromise;

    if (!hasKeys) {
        // First run: Show setup modal
        const setupModal = document.getElementById('setup-modal');
        setupModal.classList.remove('hidden');
    } else {
        // Normal run: Ready to chat
        console.log("Keys found, ready to chat.");
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

// --- Chat Logic ---

window.messages = []; // Store conversation history
window.botInfo = { personality: '', scenario: '', initial: '', characters: {} };
window.userPersona = { name: 'Jim', details: '' };
window.chatSummary = { content: '' };
let turnCount = 0; // Track turns for throttling and summary

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
    // Italic (*text* or _text_)
    html = html.replace(/(\*|_)(.*?)\1/g, '<em>$2</em>');

    // Convert newlines to <br>
    return html.replace(/\n/g, '<br>');
}

function appendMessage(role, text, index) {
    const msgDiv = document.createElement('div');
    msgDiv.className = `message ${role}`;
    
    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';
    // Strip tags before displaying so they don't show up in the chat bubble
    contentDiv.innerHTML = parseMarkdown(stripVisualTags(text));
    msgDiv.appendChild(contentDiv);

    if (typeof index === 'number') {
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'msg-delete-btn';
        deleteBtn.innerHTML = '×';
        deleteBtn.title = 'Delete this message and all following';
        deleteBtn.onclick = async () => {
            const yes = await window.showConfirmModal('Delete Message', 'Delete this message and all subsequent messages?');
            if (yes) {
                window.messages.splice(index);
                renderChat();
                saveCurrentChatState();
            }
        };
        msgDiv.appendChild(deleteBtn);

        // Reroll button (only for last message and if assistant)
        if (index === window.messages.length - 1 && role === 'assistant') {
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

async function initializeChat() {
    const overlay = document.getElementById('loading-overlay');
    if (overlay) overlay.classList.add('active');
    // Clear input immediately to prevent stale text issues
    userInput.value = '';
    userInput.disabled = false;
    userInput.focus();

    try {
        window.messages = [];
        renderChat();
        
        // Reset sprites
        activeSprites.forEach(img => img.remove());
        activeSprites.clear();
        hideSplash();

        let initialText = window.botInfo.initial || "⚠️ Error: Could not load 'bot/files/initial.txt'. Please check that the file exists in the correct folder.";
        initialText = initialText.replace(/{{user}}/g, window.userPersona.name);

        // If no tags are present, ask the AI to pick images based on the text
        if (!initialText.match(/\[(BG|SPRITE|SPLASH|MUSIC|HIDE):/i)) {
            // Fallback: Use local sentiment analysis instead of a second API call
            const mood = getMood(initialText);
            const activeChars = getSceneContext(initialText);
            activeChars.forEach(charName => {
                const sprite = findBestSprite(charName, mood);
                if (sprite) updateSprite(sprite);
            });

            const normText = initialText.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

            // Check for Background
            if (window.imageManifest.backgrounds) {
                const bgs = Object.keys(window.imageManifest.backgrounds);
                const bestBg = bgs.find(bg => {
                    const name = bg.split(/[/\\]/).pop().split('.')[0].toLowerCase();
                    return name.length > 2 && normText.includes(name);
                });
                if (bestBg) changeBackground(bestBg);
            }
        }

        // Check for Music (Fallback if no explicit music tag is present)
        if (!initialText.match(/\[MUSIC:/i)) {
            let musicFound = false;
            if (window.imageManifest.music) {
                const tracks = Object.keys(window.imageManifest.music);
                
                const findTrack = (text) => {
                    if (!text) return null;
                    const norm = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
                    return tracks.find(track => {
                        const name = track.split(/[/\\]/).pop().split('.')[0].toLowerCase();
                        return name.length > 2 && norm.includes(name);
                    });
                };

                let bestTrack = findTrack(initialText);
                if (!bestTrack) bestTrack = findTrack(window.botInfo.scenario);

                if (!bestTrack) {
                    bestTrack = tracks.find(t => t.toLowerCase().includes('default'));
                }

                if (bestTrack) {
                    playMusic(bestTrack);
                    musicFound = true;
                }
            }
            if (!musicFound) playMusic(null);
        }

        processVisualTags(initialText); // Execute tags
        window.messages.push({ role: 'assistant', content: initialText.trim() }); // Store raw text with tags
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
    window.messages = state.messages;
    
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

    let musicFilename = getCurrentMusicFilename();

    const state = {
        messages: window.messages,
        background: bgFilename,
        sprites: spriteFilenames,
        splash: splashFilename,
        music: musicFilename
    };
    await window.api.saveCurrentChat(state);
}

function renderChat() {
    chatHistory.innerHTML = '';
    window.messages.forEach((msg, index) => {
        appendMessage(msg.role, msg.content, index);
    });
    chatHistory.scrollTop = chatHistory.scrollHeight;
}

async function updateHistorySummary(isFullRewrite) {
    // Optimize token usage by converting messages to a simple string format instead of JSON
    const recentMessages = window.messages.slice(-20).map(m => `${m.role === 'user' ? 'User' : 'AI'}: ${m.content}`).join('\n');
    let promptMessages = [];

    if (isFullRewrite) {
        // Full Summary (Every 50 turns)
        promptMessages = [
            { role: 'system', content: "You are an expert storyteller. Summarize the entire story so far into a concise narrative, incorporating the previous summary and recent events." },
            { role: 'user', content: `Previous Summary:\n${window.chatSummary.content}\n\nRecent Events:\n${recentMessages}` }
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
            window.chatSummary.content = summaryUpdate;
        } else {
            window.chatSummary.content += (window.chatSummary.content ? "\n\n" : "") + summaryUpdate;
        }
        
        await window.api.saveSummary(window.chatSummary);
        updateDiv.textContent = 'History updated.';
    } catch (e) {
        console.error("Failed to update summary:", e);
    }
}

function getSceneContext(userText) {
    // 1. Start with currently visible characters
    const activeNames = new Set(activeSprites.keys());

    // 2. Add characters mentioned in the user's text (so they can enter the scene)
    if (userText && window.botInfo.characters) {
        const lowerText = userText.toLowerCase();
        Object.keys(window.botInfo.characters).forEach(name => {
            if (lowerText.includes(name.toLowerCase())) {
                activeNames.add(name.toLowerCase());
            }
        });
    }

    // 3. If scene is empty, try to infer from scenario instead of dumping everyone
    if (activeNames.size === 0 && window.botInfo.characters) {
        const scenarioLower = (window.botInfo.scenario || "").toLowerCase();
        Object.keys(window.botInfo.characters).forEach(name => {
            if (scenarioLower.includes(name.toLowerCase())) {
                activeNames.add(name.toLowerCase());
            }
        });
    }

    return Array.from(activeNames);
}

async function streamChat(payload, sceneCharacters) {
    // Create a message div for the assistant immediately
    const msgIndex = window.messages.length;
    appendMessage('assistant', '', msgIndex); 
    const msgDivs = chatHistory.getElementsByClassName('message assistant');
    const lastMsgDiv = msgDivs[msgDivs.length - 1];
    const contentDiv = lastMsgDiv.querySelector('.message-content');
    
    // Add typing indicator initially
    contentDiv.innerHTML = '<div class="typing-dots"><span></span><span></span><span></span></div>';

    let accumulatedText = '';
    let hasReceivedChunk = false;
    let removeListener;

    try {
        removeListener = window.api.onChatReplyChunk((chunk) => {
            if (!hasReceivedChunk) {
                contentDiv.innerHTML = ''; // Clear typing dots on first chunk
                hasReceivedChunk = true;
            }
            accumulatedText += chunk;
            // Clean tags in real-time so they don't "float" in the chat
            contentDiv.innerHTML = parseMarkdown(stripVisualTags(accumulatedText));
            chatHistory.scrollTop = chatHistory.scrollHeight;
        });

        const fullResponse = await window.api.sendChat(payload, { activeCharacters: sceneCharacters });
        
        // Stop listening to chunks so the tag generation doesn't append to the chat
        if (removeListener) {
            removeListener();
            removeListener = null;
        }

        // Check for visual tags. If missing, ask AI to generate them.
        if (!fullResponse.match(/\[(BG|SPRITE|SPLASH|MUSIC|HIDE):/i)) {
            // Fallback: Use local sentiment analysis instead of a second API call
            const mood = getMood(fullResponse);
            const activeChars = getSceneContext(fullResponse); // Use context from response
            activeChars.forEach(charName => {
                const sprite = findBestSprite(charName, mood);
                if (sprite) updateSprite(sprite);
            });
        }

        // Execute visual tags now that we have the full text
        processVisualTags(fullResponse);
        
        // Update the message content one last time with the processed text (tags removed)
        contentDiv.innerHTML = parseMarkdown(stripVisualTags(fullResponse));
        
        return fullResponse.trim(); // Return raw response to be saved in history
    } catch (e) {
        // Error is handled in handleSend now
        throw e;
    } finally {
        if (removeListener) removeListener();
    }
}

async function handleSend() {
    const text = userInput.value.trim();
    if (!text) return;

    // 1. Show user message immediately
    appendMessage('user', text, window.messages.length);
    userInput.value = '';
    window.messages.push({ role: 'user', content: text });

    // 2. Prepare Payload
    let systemContent = [window.botInfo.personality, window.botInfo.scenario].filter(Boolean).join('\n\n');
    
    // Determine active characters for this turn
    const sceneCharacters = getSceneContext(text);
    
    // --- PASS 1: CHARACTER EVOLUTION (ASYNC) ---
    // Run in background (no await) to update state for NEXT turn
    // Throttle: Run every 3 turns to prevent token ballooning
    if (turnCount % 3 === 0) {
        window.api.evolveCharacterState(window.messages, sceneCharacters).catch(e => console.warn("Evolution skipped:", e));
    }

    // Inject only relevant character personalities
    sceneCharacters.forEach(name => {
        // Find the key in window.botInfo.characters that matches the lowercase name
        const realName = Object.keys(window.botInfo.characters).find(k => k.toLowerCase() === name);
        if (realName) {
            systemContent += `\n\n[Character: ${realName}]\n${window.botInfo.characters[realName]}`;
        }
    });

    // Inject Persona
    systemContent += `\n\n[USER INFO]\nName: ${window.userPersona.name}\nDetails: ${window.userPersona.details}`;
    
    // Replace {{user}} placeholder in system prompt
    systemContent = systemContent.replace(/{{user}}/g, window.userPersona.name);

    // Inject Summary
    if (window.chatSummary && window.chatSummary.content) {
        systemContent += `\n\n[STORY SUMMARY]\n${window.chatSummary.content}`;
    }

    const payload = systemContent ? [{ role: 'system', content: systemContent }, ...window.messages] : window.messages;
    
    // 3. Stream Response
    try {
        const cleanResponse = await streamChat(payload, sceneCharacters);
        
        window.messages.push({ role: 'assistant', content: cleanResponse });
        saveCurrentChatState();

        // Auto-Summary Logic
        turnCount++;
        if (turnCount > 0 && turnCount % 10 === 0) {
            const isFullRewrite = (turnCount % 50 === 0);
            updateHistorySummary(isFullRewrite);
        }
    } catch (error) {
        console.error("Chat Error:", error);
        // Remove the user message we just added to prevent "orphaned" messages
        window.messages.pop();
        
        // Remove the last two message divs (User's message + Assistant's failed typing indicator)
        if (chatHistory.lastChild) chatHistory.removeChild(chatHistory.lastChild); // Assistant
        if (chatHistory.lastChild) chatHistory.removeChild(chatHistory.lastChild); // User
        
        // Restore input
        userInput.value = text;
        alert(`Failed to send message: ${error.message || "Unknown error"}`);
    }
    
    sendBtn.focus();
    setTimeout(() => userInput.focus(), 50);
}

async function regenerateResponse() {
    if (window.messages.length === 0) return;
    
    // Remove the last assistant message
    const lastMsg = window.messages[window.messages.length - 1];
    if (lastMsg.role === 'assistant') {
        window.messages.pop();
    }
    
    renderChat(); // Update UI to remove the old message

    // Construct payload (same as handleSend but without adding new user msg)
    let systemContent = [window.botInfo.personality, window.botInfo.scenario].filter(Boolean).join('\n\n');
    
    // For reroll, use current active sprites as context
    const sceneCharacters = getSceneContext(''); 
    sceneCharacters.forEach(name => {
        const realName = Object.keys(window.botInfo.characters).find(k => k.toLowerCase() === name);
        if (realName) {
            systemContent += `\n\n[Character: ${realName}]\n${window.botInfo.characters[realName]}`;
        }
    });

    systemContent += `\n\n[USER INFO]\nName: ${window.userPersona.name}\nDetails: ${window.userPersona.details}`;
    systemContent = systemContent.replace(/{{user}}/g, window.userPersona.name);
    if (window.chatSummary && window.chatSummary.content) {
        systemContent += `\n\n[STORY SUMMARY]\n${window.chatSummary.content}`;
    }

    const payload = systemContent ? [{ role: 'system', content: systemContent }, ...window.messages] : window.messages;
    const cleanResponse = await streamChat(payload, sceneCharacters);

    window.messages.push({ role: 'assistant', content: cleanResponse });
    saveCurrentChatState();
    sendBtn.focus();
    setTimeout(() => userInput.focus(), 50);
}

sendBtn.addEventListener('click', handleSend);
userInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault(); // Prevent new line
        handleSend();
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
        const containerWidth = document.body.offsetWidth;
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