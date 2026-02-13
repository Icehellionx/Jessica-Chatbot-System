/* ============================================================================
   settings-ui.js — Settings, API Keys, and Configuration UI
   ========================================================================== */

(function () {
  // ---------------------------
  // DOM Helpers (Local)
  // ---------------------------
  const $ = (id) => document.getElementById(id);
  const show = (el) => el && el.classList.remove("hidden");
  const hide = (el) => el && el.classList.add("hidden");

  // ---------------------------
  // Helpers
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
    return escapeHtml(str).replaceAll("`", "&#96;");
  }

  function maskKey(key) {
    const s = String(key || "");
    if (s.length <= 8) return "••••••••";
    return `${s.slice(0, 4)}...${s.slice(-4)}`;
  }

  // ---------------------------
  // Main Setup Function
  // ---------------------------
  window.setupSettingsUI = function setupSettingsUI(callbacks) {
    const { initializeChat } = callbacks;

    const setupModal = $("setup-modal");
    const optionsModal = $("options-modal");
    const optionsBtn = $("options-btn");
    const closeOptionsBtn = $("close-options-btn");
    const keysList = $("keys-list");
    
    const voiceModal = $("voice-modal");
    const closeVoiceBtn = $("close-voice-btn");
    const voiceList = $("voice-list");

    // ---------------------------
    // Provider Base URL Visibility
    // ---------------------------
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

    // Initial state
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
          const personaModal = $("persona-modal");
          $("persona-name").value = currentPersona.name || "Jim";
          $("persona-details").value = currentPersona.details || "";
          show(personaModal);
          $("persona-name")?.focus();
          return;
        }
      } else {
        alert("Setup complete!");
      }

      if (initializeChat) await initializeChat();
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
      const currentTokens = window.estimateTokenCount ? window.estimateTokenCount(prompt || "") : 0;
      if (window.updateTokenUsageDisplay) window.updateTokenUsageDisplay(currentTokens, maxCtx);

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

    // Live token update
    const updateMeter = () => {
        const max = parseInt($("max-context").value, 10) || 128000;
        const current = window.estimateTokenCount ? window.estimateTokenCount($("advanced-prompt-content").value || "") : 0;
        if (window.updateTokenUsageDisplay) window.updateTokenUsageDisplay(current, max);
    };
    $("advanced-prompt-content")?.addEventListener("input", updateMeter);
    $("max-context")?.addEventListener("input", updateMeter);

    // Debug toggle
    $("debug-toggle")?.addEventListener("change", (e) => {
      if (window.setVisualDebugMode) {
        window.setVisualDebugMode(e.target.checked);
      }
    });

    // DevTools toggle
    $("devtools-toggle")?.addEventListener("change", (e) => {
      window.api.toggleDevTools(e.target.checked);
    });

    // Save advanced settings
    $("save-advanced-prompt-btn")?.addEventListener("click", async () => {
      const prompt = ($("advanced-prompt-content").value || "").trim();
      const temp = $("advanced-temperature").value;
      const maxCtx = $("max-context").value;

      await window.api.saveTemperature(temp);
      await window.api.saveMaxContext(maxCtx);
      await window.api.saveAdvancedPrompt(prompt);

      alert("Advanced settings saved!");
    });

    // ---------------------------
    // Voice Settings
    // ---------------------------
    $("reset-voices-btn")?.addEventListener("click", async () => {
      const yes = await window.showConfirmModal("Reset Voices", "This will clear all assigned character voices. They will be re-assigned (with gender checks) the next time they speak. Continue?");
      if (yes) {
        await window.api.clearVoiceMap();
        alert("Voice map cleared. Restart the app or reload the chat to apply.");
      }
    });

    $("edit-voices-btn")?.addEventListener("click", async () => {
      const map = await window.api.getVoiceMap();
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

    $("save-voice-btn")?.addEventListener("click", async () => {
      const inputs = voiceList.querySelectorAll(".voice-id-input");
      const newMap = {};
      inputs.forEach(inp => {
        newMap[inp.getAttribute("data-char")] = parseInt(inp.value, 10);
      });
      await window.api.saveVoiceMap(newMap);
      hide(voiceModal);
      alert("Voice map saved.");
    });

    // ---------------------------
    // Keys List Logic
    // ---------------------------
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
        const modelName = config?.models && config.models[provider] ? ` (${config.models[provider]})` : "";
        const isActive = provider === activeProvider;

        item.innerHTML = `
          <span>
            <strong>${escapeHtml(provider)}${escapeHtml(modelName)}:</strong>
            ${escapeHtml(maskKey(key))}
            ${isActive ? ' <span style="color:lime; font-weight:bold;">[ACTIVE]</span>' : ""}
          </span>
          <div>
            ${!isActive ? `<button class="activate-btn" data-provider="${escapeAttr(provider)}" style="background:#0078d4; color:white; border:none; border-radius:3px; cursor:pointer; margin-right:5px;">Use</button>` : ""}
            <button class="delete-btn" data-provider="${escapeAttr(provider)}" style="background:#d13438; color:white; border:none; border-radius:3px; cursor:pointer;">Delete</button>
          </div>
        `;
        keysList.appendChild(item);
      }
    }

    keysList?.addEventListener("click", async (e) => {
      const activateBtn = e.target.closest(".activate-btn");
      const deleteBtn = e.target.closest(".delete-btn");

      if (activateBtn) {
        const provider = activateBtn.getAttribute("data-provider");
        if (provider) {
            await window.api.setActiveProvider(provider);
            await renderKeysList();
        }
      } else if (deleteBtn) {
        const provider = deleteBtn.getAttribute("data-provider");
        if (provider) {
            const yes = await window.showConfirmModal("Remove Key", `Remove key for ${provider}?`);
            if (yes) {
                await window.api.deleteApiKey(provider);
                await renderKeysList();
            }
        }
      }
    });
  };

  // ---------------------------
  // Token Helpers (Global)
  // ---------------------------
  window.estimateTokenCount = function estimateTokenCount(additionalText = "") {
    let text = String(additionalText || "");
    if (window.botInfo) {
      text += (window.botInfo.personality || "") + (window.botInfo.scenario || "");
      if (window.botInfo.characters) {
        let charsToCount = Object.keys(window.botInfo.characters);
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
    return Math.ceil(text.length / 4) + 500;
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
      if (percentage > 90) bar.style.background = "#d13438";
      else if (percentage > 75) bar.style.background = "#ffaa00";
      else bar.style.background = "#0078d4";
    }
  };
})();