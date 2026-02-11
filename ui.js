/* ============================================================================
   ui.js — Modal + Settings + Chat Management UI
   Goals:
   - Centralize DOM lookups
   - Reduce repeated listeners with event delegation
   - Use the custom confirm modal consistently
   - Keep behavior identical to current version
   ========================================================================== */

(function () {
  // ---------------------------
  // DOM Helpers
  // ---------------------------

  /** Cached getElementById */
  const elCache = new Map();
  const $ = (id) => {
    if (elCache.has(id)) return elCache.get(id);
    const el = document.getElementById(id);
    elCache.set(id, el);
    return el;
  };

  const show = (el) => el && el.classList.remove("hidden");
  const hide = (el) => el && el.classList.add("hidden");

  // ---------------------------
  // Confirmation Modal
  // ---------------------------

  const confirmModal = $("confirm-modal");
  const confirmTitle = $("confirm-title");
  const confirmText = $("confirm-text");
  const confirmYesBtn = $("confirm-yes-btn");
  const confirmCancelBtn = $("confirm-cancel-btn");

  let confirmResolve = null;

  /**
   * Global confirm modal:
   * returns Promise<boolean>
   */
  window.showConfirmModal = (title, message) => {
    return new Promise((resolve) => {
      confirmTitle.textContent = title || "Confirm";
      confirmText.textContent = message || "";
      show(confirmModal);
      confirmResolve = resolve;
      confirmYesBtn?.focus();
    });
  };

  const closeConfirm = (value) => {
    hide(confirmModal);
    if (confirmResolve) {
      confirmResolve(Boolean(value));
      confirmResolve = null;
    }
  };

  confirmYesBtn?.addEventListener("click", () => closeConfirm(true));
  confirmCancelBtn?.addEventListener("click", () => closeConfirm(false));

  // Click outside modal-content to cancel (optional, nice UX)
  confirmModal?.addEventListener("click", (e) => {
    if (e.target === confirmModal) closeConfirm(false);
  });

  // Esc to cancel confirm (optional)
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && confirmModal && !confirmModal.classList.contains("hidden")) {
      closeConfirm(false);
    }
  });

  // ---------------------------
  // UI Setup Entry Point
  // ---------------------------

  window.setupUI = function setupUI(callbacks) {
    const {
      initializeChat,
      renderChat,
      saveCurrentChatState,
      regenerateResponse,
      swapMessageVersion,
    } = callbacks;

    // -------- DOM refs used often --------
    const setupModal = $("setup-modal");
    const optionsModal = $("options-modal");
    const loadModal = $("load-modal");

    const optionsBtn = $("options-btn");
    const closeOptionsBtn = $("close-options-btn");

    const personaBtn = $("persona-btn");
    const personaModal = $("persona-modal");
    const closePersonaBtn = $("close-persona-btn");
    const savePersonaBtn = $("save-persona-btn");

    const summaryBtn = $("summary-btn");
    const summaryModal = $("summary-modal");
    const closeSummaryBtn = $("close-summary-btn");
    const saveSummaryBtn = $("save-summary-btn");

    const lorebookBtn = $("lorebook-btn");
    const lorebookModal = $("lorebook-modal");
    const closeLorebookBtn = $("close-lorebook-btn");
    const saveLorebookBtn = $("save-lorebook-btn");

    const saveAdvancedPromptBtn = $("save-advanced-prompt-btn");
    const resetVoicesBtn = $("reset-voices-btn");
    const editVoicesBtn = $("edit-voices-btn");
    const voiceModal = $("voice-modal");
    const closeVoiceBtn = $("close-voice-btn");
    const saveVoiceBtn = $("save-voice-btn");
    const voiceList = $("voice-list");

    const saveChatBtn = $("save-chat-btn");
    const loadChatBtn = $("load-chat-btn");
    const resetChatBtn = $("reset-chat-btn");
    const hideUiBtn = $("hide-ui-btn");
    const undoBtn = $("undo-btn");
    const redoBtn = $("redo-btn");
    const treeBtn = $("tree-btn");
    const treeModal = $("tree-modal");
    const closeTreeBtn = $("close-tree-btn");
    const treeViewer = $("tree-viewer");

    const keysList = $("keys-list");
    const savedChatsList = $("saved-chats-list");

    // ---------------------------
    // Provider Base URL Visibility
    // ---------------------------

    // Today you only show Base URL for "local".
    // If you later add "custom", this stays clean.
    const shouldShowBaseUrl = (provider) => provider === "local";

    const toggleBaseUrl = (providerSelectId, baseUrlGroupId) => {
      const provider = $(providerSelectId)?.value;
      const group = $(baseUrlGroupId);
      if (!group) return;
      group.style.display = shouldShowBaseUrl(provider) ? "block" : "none";
    };

    $("setup-provider")?.addEventListener("change", () =>
      toggleBaseUrl("setup-provider", "setup-base-url-group")
    );
    $("options-provider")?.addEventListener("change", () =>
      toggleBaseUrl("options-provider", "options-base-url-group")
    );

    // Ensure initial state is correct if a default provider is preselected
    toggleBaseUrl("setup-provider", "setup-base-url-group");
    toggleBaseUrl("options-provider", "options-base-url-group");

    // ---------------------------
    // Setup Modal (First Run)
    // ---------------------------

    $("save-setup-btn")?.addEventListener("click", async () => {
      const provider = $("setup-provider")?.value;
      const key = ($("setup-key")?.value || "").trim();
      const model = ($("setup-model")?.value || "").trim();
      const baseUrl = ($("setup-base-url")?.value || "").trim();

      if (!provider) return alert("Missing provider selection.");
      if (!key && provider !== "local") return alert("Please enter an API key.");

      await window.api.saveApiKey(provider, key, model, baseUrl);
      hide(setupModal);

      // Offer persona setup on first run
      const currentPersona = await window.api.getPersona();
      const isDefaultPersona = currentPersona?.name === "Jim" && !currentPersona?.details;

      if (isDefaultPersona) {
        const yes = await window.showConfirmModal(
          "Setup complete",
          "Would you like to configure your persona now?"
        );
        if (yes) {
          $("persona-name").value = currentPersona.name || "Jim";
          $("persona-details").value = currentPersona.details || "";
          show(personaModal);
          $("persona-name")?.focus();
          return;
        }
      } else {
        alert("Setup complete!");
      }

      await initializeChat();
    });

    // ---------------------------
    // Options Modal (Settings)
    // ---------------------------

    optionsBtn?.addEventListener("click", async () => {
      await renderKeysList();

      // Load Advanced Settings
      const prompt = await window.api.getAdvancedPrompt();
      const config = await window.api.getConfig();

      const temp = config?.temperature !== undefined ? config.temperature : 0.7;
      const maxCtx = config?.maxContext || 128000;

      $("advanced-prompt-content").value = prompt || "";
      $("advanced-temperature").value = temp;
      $("temp-display").textContent = String(temp);
      $("max-context").value = maxCtx;

      // Token meter (estimate)
      const currentTokens = estimateTokenCount(prompt || "");
      updateTokenUsageDisplay(currentTokens, maxCtx);

      show(optionsModal);
    });

    closeOptionsBtn?.addEventListener("click", () => hide(optionsModal));

    // Save/Update key
    $("update-key-btn")?.addEventListener("click", async () => {
      const provider = $("options-provider")?.value;
      const key = ($("options-key")?.value || "").trim();
      const model = ($("options-model")?.value || "").trim();
      const baseUrl = ($("options-base-url")?.value || "").trim();

      if (!provider) return alert("Missing provider selection.");
      if (!key && provider !== "local") return alert("Please enter an API key.");

      await window.api.saveApiKey(provider, key, model, baseUrl);

      // Clear inputs
      $("options-key").value = "";
      $("options-model").value = "";
      $("options-base-url").value = "";

      await renderKeysList();
    });

    // Test provider
    $("test-provider-btn")?.addEventListener("click", async () => {
      const btn = $("test-provider-btn");
      const original = btn.textContent;
      btn.textContent = "Testing...";
      btn.disabled = true;

      try {
        const result = await window.api.testProvider();
        alert(result?.message || "No response.");
      } finally {
        btn.textContent = original;
        btn.disabled = false;
      }
    });

    // Scan images
    $("scan-images-btn")?.addEventListener("click", async () => {
      const btn = $("scan-images-btn");
      const original = btn.textContent;
      btn.textContent = "Scanning... (this may take a while)";
      btn.disabled = true;

      try {
        const result = await window.api.scanImages();
        alert(result?.message || "Scan complete.");
      } finally {
        btn.textContent = original;
        btn.disabled = false;
      }
    });

    // Temperature display live
    $("advanced-temperature")?.addEventListener("input", (e) => {
      $("temp-display").textContent = e.target.value;
    });

    // Optional: live token update while typing prompt
    $("advanced-prompt-content")?.addEventListener("input", () => {
      const max = parseInt($("max-context").value, 10) || 128000;
      const current = estimateTokenCount($("advanced-prompt-content").value || "");
      updateTokenUsageDisplay(current, max);
    });

    // Live update when max context changes
    $("max-context")?.addEventListener("input", (e) => {
      const max = parseInt(e.target.value, 10) || 128000;
      const current = estimateTokenCount($("advanced-prompt-content").value || "");
      updateTokenUsageDisplay(current, max);
    });

    // Debug toggle
    $("debug-toggle")?.addEventListener("change", (e) => {
      if (window.setVisualDebugMode) {
        window.setVisualDebugMode(e.target.checked);
      }
    });

    // Reset Voices
    resetVoicesBtn?.addEventListener("click", async () => {
      const yes = await window.showConfirmModal("Reset Voices", "This will clear all assigned character voices. They will be re-assigned (with gender checks) the next time they speak. Continue?");
      if (yes) {
        await window.api.clearVoiceMap();
        alert("Voice map cleared. Restart the app or reload the chat to apply.");
      }
    });

    // Edit Voice Map
    editVoicesBtn?.addEventListener("click", async () => {
      const map = await window.api.getVoiceMap();
      console.log("[UI] Loaded Voice Map:", map);
      voiceList.innerHTML = "";
      
      const systemKeys = ['narrator', 'character_generic_male', 'character_generic_female'];
      const deprecatedKeys = ['character_generic'];
      const charKeys = Object.keys(map).filter(k => !systemKeys.includes(k) && !deprecatedKeys.includes(k)).sort();

      const renderRow = (char) => {
        const row = document.createElement("div");
        row.className = "form-group";
        row.style.cssText = "display:flex; align-items:center; gap:10px; margin-bottom:10px;";
        
        row.innerHTML = `
          <label style="flex:1; margin:0; font-family:monospace;">${escapeHtml(char)}</label>
          <input type="number" class="voice-id-input" data-char="${escapeAttr(char)}" value="${map[char]}" style="width:80px;">
          <button type="button" class="tool-btn test-voice-btn" data-char="${escapeAttr(char)}">Test</button>
        `;
        voiceList.appendChild(row);
      };

      if (systemKeys.length > 0) {
        const h = document.createElement('h3');
        h.style.cssText = "margin: 0 0 10px; border-bottom: 1px solid #444; font-size: 0.9em; color: var(--accent);";
        h.textContent = "System Voices";
        voiceList.appendChild(h);
        systemKeys.forEach(k => { if(map[k] !== undefined) renderRow(k); });
      }

      if (charKeys.length > 0) {
        const h = document.createElement('h3');
        h.style.cssText = "margin: 20px 0 10px; border-bottom: 1px solid #444; font-size: 0.9em; color: var(--accent);";
        h.textContent = "Characters";
        voiceList.appendChild(h);
        charKeys.forEach(k => renderRow(k));
      }
      
      show(voiceModal);
    });

    closeVoiceBtn?.addEventListener("click", () => hide(voiceModal));

    voiceList?.addEventListener("click", async (e) => {
      if (e.target.classList.contains("test-voice-btn")) {
        const btn = e.target;
        const char = btn.getAttribute("data-char");
        
        // Direct lookup for the specific input next to the button
        const siblingInput = btn.previousElementSibling;
        const siblingValue = siblingInput ? parseInt(siblingInput.value, 10) : null;
        
        const originalText = btn.textContent;
        btn.textContent = "⏳";
        btn.disabled = true;

        try {
          // 1. Gather ALL current values from the UI to build the map
          // This ensures we save exactly what the user sees
          const inputs = voiceList.querySelectorAll(".voice-id-input");
          const newMap = {};
          inputs.forEach(inp => {
            const c = inp.getAttribute("data-char");
            const val = parseInt(inp.value, 10);
            newMap[c] = isNaN(val) ? 0 : val;
          });

          // Force update the map with the sibling value if valid, just in case
          if (siblingValue !== null && !isNaN(siblingValue)) {
             newMap[char] = siblingValue;
             console.log(`[UI] Using direct input value for ${char}: ${siblingValue}`);
          }

          console.log("[UI] Saving Voice Map:", newMap);
          // 2. Save the map so the backend reads the new values
          await window.api.saveVoiceMap(newMap);
          
          // Pass siblingValue (the number in the box) directly as forcedSpeakerId
          const audioData = await window.api.generateSpeech(`Hi, I am ${char}. This is my voice.`, char, siblingValue);
          
          if (audioData) {
            const src = audioData.startsWith('data:') ? audioData : `data:audio/mp3;base64,${audioData}`;
            const audio = new Audio(src);
            const volSlider = document.getElementById('voice-slider');
            if (volSlider) audio.volume = parseFloat(volSlider.value) || 1.0;
            
            await new Promise((resolve, reject) => {
              audio.onended = resolve;
              audio.onerror = (e) => reject(new Error("Playback error"));
              audio.play().catch(reject);
            });
          } else {
            throw new Error("No audio data returned.");
          }
        } catch (err) {
          console.error("Voice test failed", err);
          alert("Test failed: " + err.message);
        } finally {
          btn.textContent = originalText;
          btn.disabled = false;
        }
      }
    });

    saveVoiceBtn?.addEventListener("click", async () => {
      const inputs = voiceList.querySelectorAll(".voice-id-input");
      const newMap = {};
      inputs.forEach(inp => {
        newMap[inp.getAttribute("data-char")] = parseInt(inp.value, 10);
      });
      await window.api.saveVoiceMap(newMap);
      hide(voiceModal);
      alert("Voice map saved.");
    });

    // Save advanced settings
    saveAdvancedPromptBtn?.addEventListener("click", async () => {
      const prompt = ($("advanced-prompt-content").value || "").trim();
      const temp = $("advanced-temperature").value;
      const maxCtx = $("max-context").value;

      await window.api.saveTemperature(temp);
      await window.api.saveMaxContext(maxCtx);
      await window.api.saveAdvancedPrompt(prompt);

      alert("Advanced settings saved!");
    });

    // ---------------------------
    // Persona
    // ---------------------------

    personaBtn?.addEventListener("click", async () => {
      window.userPersona = await window.api.getPersona();
      $("persona-name").value = window.userPersona?.name || "";
      $("persona-details").value = window.userPersona?.details || "";
      show(personaModal);
      $("persona-name")?.focus();
    });

    closePersonaBtn?.addEventListener("click", () => hide(personaModal));

    savePersonaBtn?.addEventListener("click", async () => {
      const name = ($("persona-name").value || "").trim() || "Jim";
      const details = ($("persona-details").value || "").trim();

      window.userPersona = { name, details };
      await window.api.savePersona(window.userPersona);

      hide(personaModal);
      alert("Persona saved!");

      // If still basically at the start, restart chat so {{user}} etc updates
      if (window.messages?.length <= 1) await initializeChat();
    });

    // ---------------------------
    // Summary
    // ---------------------------

    summaryBtn?.addEventListener("click", async () => {
      window.chatSummary = await window.api.getSummary();
      $("summary-content").value = window.chatSummary?.content || "";
      show(summaryModal);
    });

    closeSummaryBtn?.addEventListener("click", () => hide(summaryModal));

    saveSummaryBtn?.addEventListener("click", async () => {
      const content = ($("summary-content").value || "").trim();
      window.chatSummary = { content };
      await window.api.saveSummary(window.chatSummary);
      hide(summaryModal);
      alert("Summary saved!");
    });

    // ---------------------------
    // Lorebook
    // ---------------------------

    lorebookBtn?.addEventListener("click", async () => {
      const lore = await window.api.getLorebook();
      $("lorebook-content").value = JSON.stringify(lore || [], null, 2);
      show(lorebookModal);
    });

    closeLorebookBtn?.addEventListener("click", () => hide(lorebookModal));

    saveLorebookBtn?.addEventListener("click", async () => {
      try {
        const parsed = JSON.parse($("lorebook-content").value || "[]");
        await window.api.saveLorebook(parsed);
        hide(lorebookModal);
        alert("Lorebook saved!");
      } catch (e) {
        alert("Invalid JSON: " + e.message);
      }
    });

    // ---------------------------
    // Chat Management
    // ---------------------------

    saveChatBtn?.addEventListener("click", async () => {
      if (!window.messages || window.messages.length === 0) return alert("Nothing to save!");

      const name = prompt("Enter a name for this chat:");
      if (!name) return;

      const success = await window.api.saveChat(name, window.messages);
      if (success) alert("Chat saved!");
    });

    loadChatBtn?.addEventListener("click", async () => {
      const chats = await window.api.getChats();
      savedChatsList.innerHTML = "";

      if (!chats || chats.length === 0) {
        savedChatsList.innerHTML = "<p>No saved chats found.</p>";
      } else {
        // Render once; handle clicks via delegation below
        chats.forEach((name) => {
          const div = document.createElement("div");
          div.className = "key-item";
          div.innerHTML = `
            <span>${escapeHtml(name)}</span>
            <button class="load-select-btn" data-name="${escapeAttr(name)}">Load</button>
          `;
          savedChatsList.appendChild(div);
        });
      }

      show(loadModal);
    });

    $("close-load-btn")?.addEventListener("click", () => hide(loadModal));

    // Event delegation for load list
    loadModal?.addEventListener("click", async (e) => {
      const btn = e.target.closest(".load-select-btn");
      if (!btn) return;
      const name = btn.getAttribute("data-name");
      if (!name) return;

      window.messages = await window.api.loadChat(name);
      renderChat();
      saveCurrentChatState();
      hide(loadModal);
    });

    resetChatBtn?.addEventListener("click", async () => {
      const yes = await window.showConfirmModal(
        "Reset Chat",
        "Are you sure you want to clear the current chat?"
      );
      if (!yes) return;

      window.chatSummary = { content: "" };
      await window.api.saveSummary(window.chatSummary);
      await initializeChat();
    });

    // Hide UI / Theater Mode
    hideUiBtn?.addEventListener("click", () => {
      document.body.classList.toggle("ui-hidden");
    });
    // Click panel to restore if hidden
    $("vn-panel")?.addEventListener("click", () => {
      if (document.body.classList.contains("ui-hidden")) document.body.classList.remove("ui-hidden");
    });

    undoBtn?.addEventListener("click", () => {
      if (!window.messages || window.messages.length === 0) return;

      // Remove last message
      window.messages.pop();

      // If we now end on a user message, pop it too (undo "turn")
      if (window.messages.length > 0 && window.messages[window.messages.length - 1].role === "user") {
        window.messages.pop();
      }

      renderChat();
      saveCurrentChatState();
      window.refocusInput?.();
    });

    redoBtn?.addEventListener("click", () => regenerateResponse());

    // ---------------------------
    // Tree View
    // ---------------------------

    treeBtn?.addEventListener("click", () => {
      renderTreeView();
      show(treeModal);
    });

    closeTreeBtn?.addEventListener("click", () => hide(treeModal));

    function renderTreeView() {
      if (!treeViewer) return;
      treeViewer.innerHTML = "";

      if (!window.messages || window.messages.length === 0) {
        treeViewer.innerHTML = "<p>No messages yet.</p>";
        return;
      }

      window.messages.forEach((msg, index) => {
        const levelDiv = document.createElement("div");
        levelDiv.className = "tree-level";

        // If message has swipes, show them all
        const swipes = msg.swipes && msg.swipes.length > 0 ? msg.swipes : [msg.content];
        const activeIdx = msg.swipeId || 0;

        swipes.forEach((content, swipeIdx) => {
          const node = document.createElement("div");
          node.className = `tree-node ${msg.role}`;
          if (swipeIdx === activeIdx) node.classList.add("active");

          // Truncate content
          const preview = content.length > 80 ? content.slice(0, 80) + "..." : content;
          node.textContent = `[${msg.role}] ${preview}`;
          
          node.title = content; // Full text on hover

          node.onclick = async () => {
            if (swipeIdx === activeIdx) return; // Already active
            if (swapMessageVersion) {
              await swapMessageVersion(index, swipeIdx);
              renderTreeView(); // Re-render to update active state
            }
          };

          levelDiv.appendChild(node);
        });

        treeViewer.appendChild(levelDiv);
      });
    }

    // ---------------------------
    // Keys list interactions (delegated)
    // ---------------------------

    keysList?.addEventListener("click", async (e) => {
      const activateBtn = e.target.closest(".activate-btn");
      const deleteBtn = e.target.closest(".delete-btn");

      if (activateBtn) {
        const provider = activateBtn.getAttribute("data-provider");
        if (!provider) return;
        await window.api.setActiveProvider(provider);
        await renderKeysList();
        return;
      }

      if (deleteBtn) {
        const provider = deleteBtn.getAttribute("data-provider");
        if (!provider) return;

        const yes = await window.showConfirmModal("Remove Key", `Remove key for ${provider}?`);
        if (!yes) return;

        await window.api.deleteApiKey(provider);
        await renderKeysList();
      }
    });

    // ---------------------------
    // Helpers inside setupUI scope
    // ---------------------------

    function escapeHtml(str) {
      return String(str)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
    }

    function escapeAttr(str) {
      // for data-* attribute; keep it simple + safe
      return escapeHtml(str).replaceAll("`", "&#96;");
    }

    function maskKey(key) {
      const s = String(key || "");
      if (s.length <= 8) return "••••••••";
      return `${s.slice(0, 4)}...${s.slice(-4)}`;
    }

    async function renderKeysList() {
      const config = await window.api.getConfig();
      keysList.innerHTML = "";

      const apiKeys = config?.apiKeys || {};
      const providers = Object.keys(apiKeys);
      if (providers.length === 0) {
        keysList.innerHTML = '<p style="color:#888;">No keys saved.</p>';
        return;
      }

      const activeProvider = config?.activeProvider;

      for (const provider of providers) {
        const key = apiKeys[provider];
        const item = document.createElement("div");
        item.className = "key-item";

        const modelName =
          config?.models && config.models[provider] ? ` (${config.models[provider]})` : "";

        const baseUrlInfo =
          config?.baseUrls && config.baseUrls[provider] ? ` [${config.baseUrls[provider]}]` : "";

        const isActive = provider === activeProvider;

        item.innerHTML = `
          <span>
            <strong>${escapeHtml(provider)}${escapeHtml(modelName)}${escapeHtml(baseUrlInfo)}:</strong>
            ${escapeHtml(maskKey(key))}
            ${isActive ? ' <span style="color:lime; font-weight:bold;">[ACTIVE]</span>' : ""}
          </span>
          <div>
            ${
              !isActive
                ? `<button class="activate-btn" data-provider="${escapeAttr(provider)}"
                    style="background:${"#0078d4"}; color:white; border:none; border-radius:3px; cursor:pointer; margin-right:5px;">
                    Use
                   </button>`
                : ""
            }
            <button class="delete-btn" data-provider="${escapeAttr(provider)}"
              style="background:${"#d13438"}; color:white; border:none; border-radius:3px; cursor:pointer;">
              Delete
            </button>
          </div>
        `;
        keysList.appendChild(item);
      }
    }

    // Expose for options button handler
    window.renderKeysList = renderKeysList;
  };

  // ---------------------------
  // Token meter helpers (global like before)
  // ---------------------------

  window.estimateTokenCount = function estimateTokenCount(additionalText = "") {
    let text = String(additionalText || "");

    if (window.botInfo) {
      text += (window.botInfo.personality || "") + (window.botInfo.scenario || "");

      if (window.botInfo.characters) {
        let charsToCount = Object.keys(window.botInfo.characters);

        // Only count visible characters (if helper exists)
        if (window.getActiveSpriteNames) {
          const active = window.getActiveSpriteNames().map((s) => s.toLowerCase());
          charsToCount = charsToCount.filter((name) => active.includes(name.toLowerCase()));
        }

        charsToCount.forEach((key) => (text += window.botInfo.characters[key]));
      }
    }

    if (window.userPersona) text += (window.userPersona.name || "") + (window.userPersona.details || "");
    if (window.chatSummary) text += (window.chatSummary.content || "");
    if (window.messages) window.messages.forEach((m) => (text += m.content || ""));

    // Add buffer for IPC system prompt suffix (visual instructions + enforcement)
    const SYSTEM_SUFFIX_BUFFER = 500;
    // Rough: ~1 token per 4 chars
    return Math.ceil(text.length / 4) + SYSTEM_SUFFIX_BUFFER;
  };

  window.updateTokenUsageDisplay = function updateTokenUsageDisplay(current, max) {
    const percentage = Math.min(100, Math.max(0, (current / max) * 100));

    const usageEl = document.getElementById("token-usage-text");
    const pctEl = document.getElementById("token-percentage");
    const bar = document.getElementById("token-bar");

    if (usageEl) usageEl.textContent = `${Number(current).toLocaleString()} / ${Number(max).toLocaleString()}`;
    if (pctEl) pctEl.textContent = `${percentage.toFixed(1)}%`;

    if (bar) {
      bar.style.width = `${percentage}%`;
      // Keep your colors (inline style is fine)
      if (percentage > 90) bar.style.background = "#d13438";
      else if (percentage > 75) bar.style.background = "#ffaa00";
      else bar.style.background = "#0078d4";
    }
  };
})();
