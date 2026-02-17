/* ============================================================================
   ui.js â€” Modal + Settings + Chat Management UI
   Goals:
   - Centralize DOM lookups
   - Reduce repeated listeners with event delegation
   - Use the custom confirm modal consistently
   - Keep behavior identical to current version
   ========================================================================== */

(function () {
  window.formatApiError = (error, fallback = "Operation failed.") => {
    const message = (error && error.message) ? String(error.message) : fallback;
    const ref = error && error.correlationId ? `\n\nRef: ${error.correlationId}` : "";
    return `${message}${ref}`;
  };

  window.showErrorModal = (error, fallback = "Operation failed.") => {
    const text = window.formatApiError(error, fallback);
    const ref = error?.correlationId || null;

    let modal = $("api-error-modal");
    if (!modal) {
      modal = document.createElement("div");
      modal.id = "api-error-modal";
      modal.className = "modal hidden";
      modal.innerHTML = `
        <div class="modal-content" style="width:460px; max-width:90%;">
          <button id="close-api-error-btn" class="close-btn" type="button" aria-label="Close">&times;</button>
          <h2 style="margin-top:0;">Error</h2>
          <p id="api-error-text" style="white-space:pre-wrap; color:#ddd;"></p>
          <div class="modal-footer">
            <button id="copy-api-ref-btn" class="tool-btn" type="button" style="display:none;">Copy Ref</button>
            <button id="ok-api-error-btn" class="tool-btn primary" type="button">OK</button>
          </div>
        </div>
      `;
      document.body.appendChild(modal);

      const close = () => hide(modal);
      $("close-api-error-btn")?.addEventListener("click", close);
      $("ok-api-error-btn")?.addEventListener("click", close);
      modal.addEventListener("click", (e) => {
        if (e.target === modal) close();
      });
    }

    const textEl = $("api-error-text");
    const copyBtn = $("copy-api-ref-btn");
    if (textEl) textEl.textContent = text;

    if (copyBtn) {
      if (ref) {
        copyBtn.style.display = "";
        copyBtn.onclick = async () => {
          try {
            await navigator.clipboard.writeText(ref);
            copyBtn.textContent = "Copied";
            setTimeout(() => { copyBtn.textContent = "Copy Ref"; }, 1200);
          } catch {
            copyBtn.textContent = "Copy failed";
            setTimeout(() => { copyBtn.textContent = "Copy Ref"; }, 1200);
          }
        };
      } else {
        copyBtn.style.display = "none";
        copyBtn.onclick = null;
      }
    }

    show(modal);
  };

  window.showStatusPopup = (message, options = {}) => {
    const text = String(message || '').trim();
    if (!text) return;

    let host = document.getElementById("status-popup-host");
    if (!host) {
      host = document.createElement("div");
      host.id = "status-popup-host";
      host.style.cssText = [
        "position:fixed",
        "top:74px",
        "right:14px",
        "z-index:12000",
        "display:flex",
        "flex-direction:column",
        "gap:8px",
        "pointer-events:none",
        "max-width:380px",
      ].join(";");
      document.body.appendChild(host);
    }

    const card = document.createElement("div");
    card.style.cssText = [
      "pointer-events:auto",
      "background:rgba(32,32,32,0.95)",
      "border:1px solid rgba(255,255,255,0.2)",
      "border-left:4px solid #2f89d9",
      "color:#f2f2f2",
      "padding:10px 12px",
      "border-radius:8px",
      "box-shadow:0 8px 18px rgba(0,0,0,0.45)",
      "font-size:13px",
      "line-height:1.35",
      "cursor:pointer",
      "opacity:0",
      "transform:translateY(-6px)",
      "transition:opacity 180ms ease, transform 180ms ease",
    ].join(";");
    const title = String(options.title || "Status").trim();
    card.innerHTML = `<strong style="display:block; margin-bottom:4px; color:#9fd0ff;">${title}</strong><span>${text}</span>`;
    host.appendChild(card);
    requestAnimationFrame(() => {
      card.style.opacity = "1";
      card.style.transform = "translateY(0)";
    });

    const remove = () => {
      card.style.opacity = "0";
      card.style.transform = "translateY(-6px)";
      setTimeout(() => card.remove(), 180);
    };
    card.addEventListener("click", remove);
    const durationMs = Number(options.durationMs || 6500);
    if (!options.sticky) setTimeout(remove, durationMs);
  };

  window.showToast = (message) => window.showStatusPopup(message, { title: "Update" });

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

    // ---------------------------
    // HUD Setup (Quest & Affinity)
    // ---------------------------
    function setupHUD() {
        const panel = document.getElementById("vn-panel");
        if (!panel || document.getElementById("vn-hud")) return;

        const hud = document.createElement("div");
        hud.id = "vn-hud";
        hud.style.cssText = "position:absolute; top:60px; left:10px; display:flex; flex-direction:column; gap:5px; pointer-events:none; z-index:100; opacity:0.9; transition: opacity 0.3s ease;";
        
        // Objective (Left)
        const objBox = document.createElement("div");
        objBox.id = "hud-objective";
        objBox.style.cssText = "display:none; background:rgba(0,0,0,0.6); color:#fff; padding:6px 12px; border-radius:4px; font-family:sans-serif; font-size:13px; border-left: 3px solid #ffd700; text-shadow: 1px 1px 2px black;";
        objBox.textContent = "Objective: Explore";
        
        // Affinity (Left, under Objective)
        const affBox = document.createElement("div");
        affBox.id = "hud-affinity";
        affBox.style.cssText = "display:none; background:rgba(0,0,0,0.6); color:#fff; padding:6px 12px; border-radius:4px; font-family:sans-serif; font-size:13px; border-left: 3px solid #ff69b4; text-shadow: 1px 1px 2px black;";
        affBox.textContent = "Affinity: Neutral";

        // Background generation status (under affinity)
        const bgBox = document.createElement("div");
        bgBox.id = "hud-bg-status";
        bgBox.style.cssText = "display:none; background:rgba(0,0,0,0.6); color:#ddd; padding:6px 12px; border-radius:4px; font-family:sans-serif; font-size:12px; border-left: 3px solid #3fa9f5; text-shadow: 1px 1px 2px black;";
        bgBox.textContent = "Background: Idle";

        hud.appendChild(objBox);
        hud.appendChild(affBox);
        hud.appendChild(bgBox);
        panel.appendChild(hud);
    }

    function setBackgroundGenerationStatus(status, detail = "") {
      const el = document.getElementById("hud-bg-status");
      if (!el) return;

      const s = String(status || "idle").toLowerCase();
      const d = String(detail || "").trim();
      const show = () => { el.style.display = "block"; };
      const hide = () => { el.style.display = "none"; };

      if (window.__bgStatusHideTimer) {
        clearTimeout(window.__bgStatusHideTimer);
        window.__bgStatusHideTimer = null;
      }

      if (s === "generating") {
        show();
        el.style.borderLeft = "3px solid #3fa9f5";
        el.style.color = "#cfe9ff";
        el.textContent = d ? `Background: Generating (${d})` : "Background: Generating";
      } else if (s === "fallback") {
        show();
        el.style.borderLeft = "3px solid #f5c542";
        el.style.color = "#ffe9a8";
        el.textContent = d ? `Background: Using fallback (${d})` : "Background: Using fallback";
      } else if (s === "retrying") {
        show();
        el.style.borderLeft = "3px solid #f59f3f";
        el.style.color = "#ffd7b0";
        el.textContent = d ? `Background: Retrying (${d})` : "Background: Retrying";
      } else if (s === "ready") {
        show();
        el.style.borderLeft = "3px solid #3fbf6f";
        el.style.color = "#ccf5db";
        el.textContent = d ? `Background: Ready (${d})` : "Background: Ready";
        window.__bgStatusHideTimer = setTimeout(() => {
          const node = document.getElementById("hud-bg-status");
          if (!node) return;
          node.textContent = "Background: Idle";
          node.style.display = "none";
          window.__bgStatusHideTimer = null;
        }, 1800);
      } else if (s === "error") {
        show();
        el.style.borderLeft = "3px solid #d9534f";
        el.style.color = "#ffd1cf";
        el.textContent = d ? `Background: Warning - ${d}` : "Background: Unavailable";
      } else {
        el.style.borderLeft = "3px solid #3fa9f5";
        el.style.color = "#ddd";
        el.textContent = "Background: Idle";
        hide();
      }
    }

    // Initialize HUD if panel exists
    setupHUD();
    window.setupHUD = setupHUD; // Expose for re-init if needed
    window.setBackgroundGenerationStatus = setBackgroundGenerationStatus;

    // -------- DOM refs --------
    const loadModal = $("load-modal");

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

    const saveChatBtn = $("save-chat-btn");
    const loadChatBtn = $("load-chat-btn");
    const resetChatBtn = $("reset-chat-btn");
    const undoBtn = $("undo-btn");
    const redoBtn = $("redo-btn");
    const toggleHistoryBtn = $("toggle-history-btn");

    const treeModal = $("tree-modal");
    const closeTreeBtn = $("close-tree-btn");
    const treeViewer = $("tree-viewer");

    const thoughtsCharSelect = $("thoughts-char-select");
    const getThoughtsBtn = $("get-thoughts-btn");

    const infoModal = $("info-modal");
    const infoTitle = $("info-title");
    const infoText = $("info-text");
    const closeInfoBtn = $("close-info-btn");

    const savedChatsList = $("saved-chats-list");

    // ---------------------------
    // Inner Monologue (New)
    // ---------------------------

    function populateCharactersDropdown() {
      // This is now handled by a state subscriber in renderer.js
    }

    getThoughtsBtn?.addEventListener("click", async () => {
      const charName = thoughtsCharSelect.value;
      if (!charName) {
        alert("Please select a character.");
        return;
      }

      // Visual Integration: Show "Thinking..." bubble on stage
      if (window.showThoughtBubble) {
        window.showThoughtBubble(charName, "Thinking...");
      } else {
        infoTitle.textContent = `${charName}'s Thoughts`;
        infoText.textContent = "Generating...";
        show(infoModal);
      }

      try {
        // Pass window.messages to give context to the AI
        const monologue = await window.api.getInnerMonologue(
          charName,
          window.messages
        );
        
        if (window.showThoughtBubble) {
            window.showThoughtBubble(charName, monologue);
        } else {
            infoText.textContent = monologue || "(No thoughts generated.)";
        }
      } catch (e) {
        if (window.showThoughtBubble) {
            window.showThoughtBubble(charName, "...");
        } else {
            infoText.textContent = `Error: ${e.message}`;
        }
      }
    });

    closeInfoBtn?.addEventListener("click", () => hide(infoModal));

    // Expose the populator to be called from renderer after botInfo is loaded
    window.populateCharactersDropdown = populateCharactersDropdown;

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

      try {
        // Ask the Sidecar for a smart title
        defaultName = await window.api.getChapterTitle(window.messages);
      } catch {
        defaultName = `Save ${new Date().toLocaleTimeString()}`;
      }

      const name = prompt("Enter a name for this chat:", defaultName);
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
        const autosaves = chats
          .filter((n) => String(n).startsWith("autosave_"))
          .sort()
          .reverse();
        const manual = chats
          .filter((n) => !String(n).startsWith("autosave_"))
          .sort((a, b) => a.localeCompare(b));

        const renderSection = (title, names, isAuto = false) => {
          if (!names.length) return;
          const h = document.createElement("h3");
          h.style.cssText = "margin:10px 0 6px; font-size:0.95em; color:#ddd;";
          h.textContent = title;
          savedChatsList.appendChild(h);

          names.forEach((name) => {
            const div = document.createElement("div");
            div.className = "key-item";
            const label = isAuto ? formatAutosaveLabel(name) : name;
            div.innerHTML = `
              <span>${escapeHtml(label)}</span>
              <button class="load-select-btn" data-name="${escapeAttr(name)}">Load</button>
            `;
            savedChatsList.appendChild(div);
          });
        };

        renderSection("Saved Chats", manual, false);
        renderSection("Recover Autosaves", autosaves, true);
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
      if (window.api.phoneResetState) {
        await window.api.phoneResetState();
      }
      await initializeChat();
    });

    // History Toggle
    const historyOverlay = document.getElementById("history-overlay");
    const closeHistoryBtn = document.getElementById("close-history-btn");

    if (historyOverlay) {
        // Ensure hidden on startup
        historyOverlay.classList.add('hidden');
        historyOverlay.style.display = 'none';

        if (toggleHistoryBtn) {
            toggleHistoryBtn.onclick = (e) => {
                e.preventDefault();
                const isHidden = historyOverlay.classList.contains('hidden') || historyOverlay.style.display === 'none';
                if (isHidden) {
                    historyOverlay.classList.remove('hidden');
                    historyOverlay.style.display = 'flex'; // Restore flex layout
                } else {
                    historyOverlay.classList.add('hidden');
                    historyOverlay.style.display = 'none';
                }
            };
        }
        
        if (closeHistoryBtn) {
            closeHistoryBtn.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                historyOverlay.classList.add('hidden');
                historyOverlay.style.display = 'none';
            };
        }
    }

    // Global shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.key === 'F12') {
        window.api.toggleDevTools();
      }

      if (e.key === 'Escape') {
            if (historyOverlay && historyOverlay.style.display !== 'none') {
                historyOverlay.classList.add('hidden');
                historyOverlay.style.display = 'none';
                e.stopPropagation();
            }
        }
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
    // Tree View (Restored & Relocated)
    // ---------------------------

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
    // Layout Customization
    // ---------------------------
    const toolbar = $("toolbar");
    const hud = $("vn-hud");

    if (toolbar) {
      toolbar.style.transition = "opacity 0.3s ease";
      document.addEventListener("mousemove", (e) => {
        const inTopZone = e.clientY <= window.innerHeight * 0.25;
        const opacity = inTopZone ? "1" : "0.3";
        toolbar.style.opacity = opacity;
        if (hud) hud.style.opacity = opacity;
      });
    }

    // ---------------------------
    // Button Relocation & History Setup
    // ---------------------------

    // 2. Add Tree View button inside History Overlay
    if (historyOverlay) {
        let historyTreeBtn = $("history-tree-btn");
        if (!historyTreeBtn) {
            historyTreeBtn = document.createElement("button");
            historyTreeBtn.id = "history-tree-btn";
            historyTreeBtn.textContent = "Show Tree View";
            historyTreeBtn.className = "tool-btn";
            historyTreeBtn.style.cssText = "margin: 10px auto; display: block; width: 80%;";
            historyTreeBtn.onclick = () => {
                renderTreeView();
                show(treeModal);
            };
            // Insert at the top of the history overlay
            historyOverlay.insertBefore(historyTreeBtn, historyOverlay.firstChild);
        }
    }

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

    function formatAutosaveLabel(name) {
      const m = String(name).match(/^autosave_(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})$/);
      if (!m) return name;
      const [, y, mo, d, h, mi, s] = m;
      return `Autosave ${y}-${mo}-${d} ${h}:${mi}:${s}`;
    }
  };
})();


