// c:\Users\icehe\Desktop\Jessica\src\ui-manager.js
'use strict';

import { $, parseMarkdown } from './utils.js';

export const UIManager = {
  userInput: $('user-input'),
  sendBtn: $('send-btn'),
  stopBtn: $('stop-btn'),
  chatHistory: $('chat-history'),
  
  // Callbacks to be set by the orchestrator
  onDeleteMessage: null,
  onSwipeMessage: null,
  onRegenerate: null,

  setGeneratingState(isGenerating) {
    if (this.sendBtn) this.sendBtn.disabled = isGenerating;
    if (this.stopBtn) {
      this.stopBtn.style.display = isGenerating ? 'inline-block' : 'none';
      this.stopBtn.disabled = !isGenerating;
    }
  },

  refocusInput() {
    if (!this.userInput) return;
    this.userInput.blur();
    setTimeout(() => {
      this.userInput.disabled = false;
      window.focus();
      this.userInput.focus();
    }, 50);
  },

  createMessageElement(role, rawText, index) {
    const msgDiv = document.createElement('div');
    msgDiv.className = `message ${role}`;

    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';
    contentDiv.innerHTML = parseMarkdown(window.stripVisualTags ? window.stripVisualTags(rawText) : rawText);
    msgDiv.appendChild(contentDiv);

    // Delete button
    if (typeof index === 'number' && this.onDeleteMessage) {
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'msg-delete-btn';
      deleteBtn.innerHTML = '×';
      deleteBtn.title = 'Delete this message and all following';
      deleteBtn.onclick = () => this.onDeleteMessage(index);
      msgDiv.appendChild(deleteBtn);
    }

    // Branching / Swiping UI
    if (typeof index === 'number' && window.messages[index] && window.messages[index].swipes && window.messages[index].swipes.length > 1) {
      const msg = window.messages[index];
      const navDiv = document.createElement('div');
      navDiv.className = 'msg-nav';

      const currentIdx = msg.swipeId || 0;
      const total = msg.swipes.length;

      const prevBtn = document.createElement('button');
      prevBtn.className = 'msg-nav-btn';
      prevBtn.textContent = '<';
      prevBtn.disabled = currentIdx === 0;
      prevBtn.onclick = () => this.onSwipeMessage(index, currentIdx - 1);

      const nextBtn = document.createElement('button');
      nextBtn.className = 'msg-nav-btn';
      nextBtn.textContent = '>';
      nextBtn.disabled = currentIdx === total - 1;
      nextBtn.onclick = () => this.onSwipeMessage(index, currentIdx + 1);

      const label = document.createElement('span');
      label.textContent = `${currentIdx + 1} / ${total}`;

      const delBranchBtn = document.createElement('button');
      delBranchBtn.className = 'msg-nav-btn';
      delBranchBtn.innerHTML = '🗑️';
      delBranchBtn.title = 'Delete this branch';
      delBranchBtn.style.marginLeft = 'auto';
      delBranchBtn.onclick = () => this.onSwipeMessage(index, -1); // -1 signal for delete

      navDiv.appendChild(prevBtn);
      navDiv.appendChild(label);
      navDiv.appendChild(nextBtn);
      navDiv.appendChild(delBranchBtn);
      msgDiv.appendChild(navDiv);
    }

    return { msgDiv, contentDiv };
  },

  appendMessage(role, rawText, index) {
    const { msgDiv } = this.createMessageElement(role, rawText, index);
    this.chatHistory.appendChild(msgDiv);
    this.chatHistory.scrollTop = this.chatHistory.scrollHeight;
    return msgDiv;
  },

  appendSystemNotice(text) {
    this.appendMessage('system', text, undefined);
  },

  renderChat() {
    this.chatHistory.innerHTML = '';

    window.messages.forEach((msg, index) => {
      const msgDiv = this.appendMessage(msg.role, msg.content, index);

      // Add reroll button ONLY on the last assistant message
      if (index === window.messages.length - 1 && msg.role === 'assistant' && this.onRegenerate) {
        const actionsDiv = document.createElement('div');
        actionsDiv.style.cssText = 'float:right; display:flex; align-items:center;';

        const redoBtn = document.createElement('button');
        redoBtn.className = 'msg-action-btn';
        redoBtn.innerHTML = '↻';
        redoBtn.title = 'Redo (Replace current)';
        redoBtn.onclick = () => this.onRegenerate({ replace: true });

        const branchBtn = document.createElement('button');
        branchBtn.className = 'msg-action-btn';
        branchBtn.innerHTML = '⑂'; // Branch icon
        branchBtn.title = 'Branch (Create new)';
        branchBtn.onclick = () => this.onRegenerate({ replace: false });

        actionsDiv.appendChild(redoBtn);
        actionsDiv.appendChild(branchBtn);
        msgDiv.appendChild(actionsDiv);
      }
    });

    // Update the visual dialogue box with the latest message
    const lastMsg = window.messages[window.messages.length - 1];
    if (window.setDialogue) {
      if (lastMsg) {
        window.setDialogue(parseMarkdown(window.stripVisualTags(lastMsg.content)), false);
      } else {
        window.setDialogue("", false);
      }
    }

    this.chatHistory.scrollTop = this.chatHistory.scrollHeight;
  },

  createAssistantStreamBubble() {
    const { msgDiv, contentDiv } = this.createMessageElement('assistant', '', undefined);
    contentDiv.innerHTML = '<div class="typing-dots"><span></span><span></span><span></span></div>';
    this.chatHistory.appendChild(msgDiv);
    this.chatHistory.scrollTop = this.chatHistory.scrollHeight;
    return { msgDiv, contentDiv };
  },

  updateThoughtsDropdown() {
    const thoughtsCharSelect = document.getElementById('thoughts-char-select');
    if (!thoughtsCharSelect) return;

    const currentSelection = thoughtsCharSelect.value;
    thoughtsCharSelect.innerHTML = '';
    
    const visibleCharacters = window.getActiveSpriteNames ? window.getActiveSpriteNames() : [];

    if (visibleCharacters.length === 0) {
      const opt = new Option('No one is here', '');
      opt.disabled = true;
      thoughtsCharSelect.add(opt);
    } else {
      visibleCharacters.forEach(charName => {
        const opt = new Option(charName.charAt(0).toUpperCase() + charName.slice(1), charName);
        thoughtsCharSelect.add(opt);
      });
      if (visibleCharacters.includes(currentSelection)) {
        thoughtsCharSelect.value = currentSelection;
      }
    }
  },

  async showTitleScreenIfExists() {
    const exists = await window.api.checkFileExists('title/title_screen.png');
    if (!exists) return;

    return new Promise((resolve) => {
      const img = new Image();
      img.src = 'bot-resource://title/title_screen.png';

      img.onload = () => {
        const overlay = document.createElement('div');
        overlay.id = 'title-screen';
        overlay.style.cssText = `
          position: fixed; inset: 0;
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

        const style = document.createElement('style');
        style.textContent = `@keyframes titlePulse {0%{opacity:.6}50%{opacity:1}100%{opacity:.6}}`;
        document.head.appendChild(style);

        overlay.appendChild(text);
        document.body.appendChild(overlay);

        window.playMusic('music/main_theme.mp3');

        overlay.addEventListener('click', () => {
          overlay.style.opacity = '0';
          overlay.style.pointerEvents = 'none';
          setTimeout(() => overlay.remove(), 500);
          resolve();
        });
      };

      img.onerror = () => resolve();
    });
  }
};
