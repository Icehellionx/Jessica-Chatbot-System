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
    const hideUiBtn = $("hide-ui-btn");
    const undoBtn = $("undo-btn");
    const redoBtn = $("redo-btn");
    const treeBtn = $("tree-btn");
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
  };
})();
