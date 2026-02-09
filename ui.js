const setupModal = document.getElementById('setup-modal');
const optionsModal = document.getElementById('options-modal');
const optionsBtn = document.getElementById('options-btn');
const closeOptionsBtn = document.getElementById('close-options-btn');
const keysList = document.getElementById('keys-list');
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
const advancedPromptBtn = document.getElementById('advanced-prompt-btn');
const advancedPromptModal = document.getElementById('advanced-prompt-modal');
const closeAdvancedPromptBtn = document.getElementById('close-advanced-prompt-btn');
const saveAdvancedPromptBtn = document.getElementById('save-advanced-prompt-btn');
const confirmModal = document.getElementById('confirm-modal');
const confirmTitle = document.getElementById('confirm-title');
const confirmText = document.getElementById('confirm-text');
const confirmYesBtn = document.getElementById('confirm-yes-btn');
const confirmCancelBtn = document.getElementById('confirm-cancel-btn');

let confirmCallback = null;

// Global function to show confirmation modal
window.showConfirmModal = (title, message) => {
    return new Promise((resolve) => {
        confirmTitle.textContent = title;
        confirmText.textContent = message;
        confirmModal.classList.remove('hidden');
        confirmCallback = resolve;
        confirmYesBtn.focus();
    });
};

confirmYesBtn.addEventListener('click', () => {
    confirmModal.classList.add('hidden');
    if (confirmCallback) confirmCallback(true);
});

confirmCancelBtn.addEventListener('click', () => {
    confirmModal.classList.add('hidden');
    if (confirmCallback) confirmCallback(false);
});

function setupUI(callbacks) {
    const { initializeChat, renderChat, saveCurrentChatState } = callbacks;

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
        if (currentPersona.name === 'Jim' && !currentPersona.details) {
            if (confirm("Setup complete! Would you like to configure your persona now?")) {
                document.getElementById('persona-name').value = currentPersona.name;
                document.getElementById('persona-details').value = currentPersona.details;
                personaModal.classList.remove('hidden');
                document.getElementById('persona-name').focus();
                return;
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
        window.userPersona = await window.api.getPersona();
        document.getElementById('persona-name').value = window.userPersona.name || '';
        document.getElementById('persona-details').value = window.userPersona.details || '';
        personaModal.classList.remove('hidden');
        document.getElementById('persona-name').focus();
    });

    closePersonaBtn.addEventListener('click', () => {
        personaModal.classList.add('hidden');
    });

    savePersonaBtn.addEventListener('click', async () => {
        const name = document.getElementById('persona-name').value.trim() || 'Jim';
        const details = document.getElementById('persona-details').value.trim();
        
        window.userPersona = { name, details };
        await window.api.savePersona(window.userPersona);
        
        personaModal.classList.add('hidden');
        alert("Persona saved!");

        if (window.messages.length <= 1) {
            await initializeChat();
        }
    });

    // --- Summary Logic ---
    summaryBtn.addEventListener('click', async () => {
        window.chatSummary = await window.api.getSummary();
        document.getElementById('summary-content').value = window.chatSummary.content || '';
        summaryModal.classList.remove('hidden');
    });

    closeSummaryBtn.addEventListener('click', () => {
        summaryModal.classList.add('hidden');
    });

    saveSummaryBtn.addEventListener('click', async () => {
        const content = document.getElementById('summary-content').value.trim();
        window.chatSummary = { content };
        await window.api.saveSummary(window.chatSummary);
        summaryModal.classList.add('hidden');
        alert("Summary saved!");
    });

    // --- Advanced Prompt Logic ---
    advancedPromptBtn.addEventListener('click', async () => {
        const prompt = await window.api.getAdvancedPrompt();
        document.getElementById('advanced-prompt-content').value = prompt || '';
        advancedPromptModal.classList.remove('hidden');
    });

    closeAdvancedPromptBtn.addEventListener('click', () => {
        advancedPromptModal.classList.add('hidden');
    });

    saveAdvancedPromptBtn.addEventListener('click', async () => {
        const prompt = document.getElementById('advanced-prompt-content').value.trim();
        await window.api.saveAdvancedPrompt(prompt);
        advancedPromptModal.classList.add('hidden');
        alert("Advanced prompt saved!");
    });

    // --- Chat Management Logic ---
    saveChatBtn.addEventListener('click', async () => {
        if (window.messages.length === 0) {
            alert("Nothing to save!");
            return;
        }
        const name = prompt("Enter a name for this chat:");
        if (name) {
            const success = await window.api.saveChat(name, window.messages);
            if (success) alert("Chat saved!");
        }
    });

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
                    window.messages = await window.api.loadChat(name);
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

    resetChatBtn.addEventListener('click', async () => {
        const yes = await window.showConfirmModal("Reset Chat", "Are you sure you want to clear the current chat?");
        if (yes) {
            window.chatSummary = { content: '' };
            await window.api.saveSummary(window.chatSummary);
            await initializeChat();
        }
    });

    undoBtn.addEventListener('click', () => {
        if (window.messages.length > 0) {
            window.messages.pop(); 
            if (window.messages.length > 0 && window.messages[window.messages.length - 1].role === 'user') {
                window.messages.pop();
            }
            renderChat();
            saveCurrentChatState();
            
            // Fix focus
            const input = document.getElementById('user-input');
            if (input) {
                input.blur();
                setTimeout(() => input.focus(), 100);
            }
        }
    });
}

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

    document.querySelectorAll('.activate-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const provider = e.target.getAttribute('data-provider');
            await window.api.setActiveProvider(provider);
            renderKeysList();
        });
    });

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
