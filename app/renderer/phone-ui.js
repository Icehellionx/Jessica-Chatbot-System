'use strict';

(function () {
  const $ = (id) => document.getElementById(id);
  const show = (el) => el && el.classList.remove('hidden');
  const hide = (el) => el && el.classList.add('hidden');

  let activeThreadId = null;
  let cachedThreads = [];
  let pollTimer = null;
  let backgroundPollTimer = null;

  function getActiveSceneCharacters() {
    if (!window.getActiveSpriteNames) return [];
    try {
      return window.getActiveSpriteNames() || [];
    } catch {
      return [];
    }
  }

  function setPhoneButtonUnreadBadge(unreadTotal) {
    const phoneBtn = $('phone-btn');
    if (!phoneBtn) return;
    const n = Number(unreadTotal || 0);
    phoneBtn.innerHTML = n > 0 ? `&#x1F4F1; Phone (${n})` : '&#x1F4F1; Phone';
  }

  function escapeHtml(str) {
    return String(str)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function toBotResource(path) {
    const clean = String(path || '').replace(/^\/+/, '');
    return `bot-resource://${encodeURI(clean)}`;
  }

  function formatReceipt(receipt) {
    const state = String(receipt?.state || 'sent');
    if (state === 'read') return '\u2713\u2713 Read';
    if (state === 'delivered') return '\u2713\u2713 Delivered';
    return '\u2713 Sent';
  }

  function renderThreadList() {
    const list = $('phone-thread-list');
    if (!list) return;
    list.innerHTML = '';

    if (!cachedThreads.length) {
      list.innerHTML = '<div style="color:#aaa; padding:8px;">No threads yet.</div>';
      return;
    }

    cachedThreads.forEach((thread) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'tool-btn';
      item.style.cssText = `width:100%; text-align:left; margin-bottom:6px; background:${thread.id === activeThreadId ? '#005a9e' : 'rgba(58,58,58,0.8)'};`;
      const unread = Number(thread.unreadCount || 0);
      item.innerHTML = `
        <div style="display:flex; justify-content:space-between; gap:8px;">
          <strong style="color:#fff;">${escapeHtml(thread.title || 'Thread')}</strong>
          ${unread > 0 ? `<span style="background:#d13438; color:#fff; border-radius:999px; padding:0 7px; font-size:11px;">${unread}</span>` : ''}
        </div>
        ${thread.presenceText ? `<div style="font-size:11px; color:#9fd0ff; margin-top:2px;">${escapeHtml(thread.presenceText)}</div>` : ''}
        <div style="font-size:12px; color:#ccc; margin-top:4px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
          ${escapeHtml(thread.preview || '')}
        </div>
      `;
      item.addEventListener('click', async () => {
        await loadThread(thread.id);
      });
      list.appendChild(item);
    });
  }

  function renderThreadMessages(thread) {
    const header = $('phone-thread-header');
    const box = $('phone-thread-messages');
    if (!header || !box) return;

    if (!thread) {
      header.textContent = 'Select a thread';
      box.innerHTML = '';
      return;
    }

    const presencePart = thread.presenceText ? ` • ${thread.presenceText}` : '';
    header.textContent = `${thread.title || 'Thread'} (${(thread.participants || []).join(', ')})${presencePart}`;
    box.innerHTML = '';

    const messages = Array.isArray(thread.messages) ? thread.messages : [];
    if (!messages.length) {
      box.innerHTML = '<div style="color:#aaa;">No messages yet.</div>';
      return;
    }

    messages.forEach((m) => {
      const row = document.createElement('div');
      const isYou = String(m.from || '').toLowerCase() === 'you';
      row.style.cssText = `margin-bottom:8px; display:flex; justify-content:${isYou ? 'flex-end' : 'flex-start'};`;
      row.innerHTML = `
        <div style="max-width:78%; background:${isYou ? '#005a9e' : '#353535'}; border:1px solid #4a4a4a; border-radius:8px; padding:8px 10px;">
          <div style="font-size:11px; color:#cfcfcf; margin-bottom:2px;">${escapeHtml(m.from || 'Unknown')}</div>
          <div style="white-space:pre-wrap; color:#fff;">${escapeHtml(m.text || '')}</div>
          ${m.image?.path ? `
            <div style="margin-top:6px;">
              <img src="${toBotResource(m.image.path)}" alt="${escapeHtml(m.image.caption || 'Photo')}"
                style="max-width:220px; max-height:220px; width:auto; height:auto; border-radius:8px; border:1px solid #4a4a4a; display:block; cursor:pointer;" />
            </div>
          ` : ''}
          ${isYou ? `<div style="font-size:10px; color:#c9d8ff; margin-top:4px; text-align:right;">${formatReceipt(m.receipt)}</div>` : ''}
        </div>
      `;
      const img = row.querySelector('img');
      if (img) {
        img.addEventListener('click', () => {
          const src = img.getAttribute('src');
          if (src) window.open(src, '_blank', 'noopener,noreferrer');
        });
      }
      box.appendChild(row);
    });

    box.scrollTop = box.scrollHeight;
  }

  async function refreshThreads() {
    try {
      await window.api.phonePollUpdates({ activeCharacters: getActiveSceneCharacters() });
    } catch {
      // keep UI responsive if polling fails
    }
    cachedThreads = await window.api.phoneListThreads();
    const unreadTotal = cachedThreads.reduce((sum, t) => sum + Number(t.unreadCount || 0), 0);
    setPhoneButtonUnreadBadge(unreadTotal);
    renderThreadList();
  }

  async function loadThread(threadId) {
    const thread = await window.api.phoneGetThread(threadId);
    activeThreadId = thread?.id || null;
    renderThreadList();
    renderThreadMessages(thread);
    if (activeThreadId) {
      await window.api.phoneMarkRead(activeThreadId);
      await refreshThreads();
    }
  }

  async function sendPhoneMessage() {
    const input = $('phone-input');
    const sendBtn = $('phone-send-btn');
    if (!input || !activeThreadId) return;
    const text = String(input.value || '').trim();
    if (!text) return;

    input.value = '';
    sendBtn.disabled = true;
    sendBtn.textContent = 'Sending...';

    try {
      const thread = await window.api.phoneSendMessage(activeThreadId, text, {
        activeCharacters: getActiveSceneCharacters(),
      });
      renderThreadMessages(thread);
      await refreshThreads();
    } catch (e) {
      if (window.showErrorModal) window.showErrorModal(e, 'Failed to send phone message.');
      else alert(window.formatApiError ? window.formatApiError(e, 'Failed to send phone message.') : 'Failed to send phone message.');
    } finally {
      sendBtn.disabled = false;
      sendBtn.textContent = 'Send';
      input.focus();
      await refreshThreads();
    }
  }

  async function openCreateThreadModal() {
    const modal = $('phone-new-thread-modal');
    const contactList = $('phone-contact-list');
    if (!modal || !contactList) return;

    const contacts = await window.api.phoneGetContacts();
    contactList.innerHTML = '';
    contacts
      .filter((c) => c.hasNumber)
      .forEach((contact) => {
        const row = document.createElement('label');
        row.style.cssText = 'display:flex; align-items:center; gap:8px; margin-bottom:6px;';
        row.innerHTML = `<input type="checkbox" data-contact-name="${escapeHtml(contact.name)}"><span>${escapeHtml(contact.name)}</span>`;
        contactList.appendChild(row);
      });

    show(modal);
  }

  async function createThreadFromModal() {
    const titleInput = $('phone-thread-title-input');
    const contactList = $('phone-contact-list');
    if (!contactList) return;

    const selected = Array.from(contactList.querySelectorAll('input[type="checkbox"]:checked'))
      .map((n) => n.getAttribute('data-contact-name'))
      .filter(Boolean);

    if (!selected.length) {
      alert('Select at least one participant.');
      return;
    }

    const payload = {
      title: String(titleInput?.value || '').trim(),
      participants: ['You', ...selected],
    };

    const thread = await window.api.phoneCreateThread(payload);
    hide($('phone-new-thread-modal'));
    if (titleInput) titleInput.value = '';
    await refreshThreads();
    if (thread?.id) await loadThread(thread.id);
  }

  window.setupPhoneUI = function setupPhoneUI() {
    $('phone-btn')?.addEventListener('click', async () => {
      show($('phone-modal'));
      await refreshThreads();
      if (!activeThreadId && cachedThreads[0]?.id) await loadThread(cachedThreads[0].id);
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = setInterval(async () => {
        const before = cachedThreads.reduce((sum, t) => sum + Number(t.unreadCount || 0), 0);
        await refreshThreads();
        const after = cachedThreads.reduce((sum, t) => sum + Number(t.unreadCount || 0), 0);
        if (activeThreadId) {
          const active = await window.api.phoneGetThread(activeThreadId);
          renderThreadMessages(active);
        }
        if (after > before) {
          const phoneBtn = $('phone-btn');
          if (phoneBtn) {
            phoneBtn.style.borderColor = '#d13438';
            setTimeout(() => { phoneBtn.style.borderColor = ''; }, 1200);
          }
        }
      }, 25000);
    });

    $('close-phone-btn')?.addEventListener('click', () => {
      hide($('phone-modal'));
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    });
    $('phone-refresh-btn')?.addEventListener('click', refreshThreads);
    $('phone-send-btn')?.addEventListener('click', sendPhoneMessage);
    $('phone-new-thread-btn')?.addEventListener('click', openCreateThreadModal);
    $('close-phone-new-thread-btn')?.addEventListener('click', () => hide($('phone-new-thread-modal')));
    $('phone-create-thread-confirm-btn')?.addEventListener('click', createThreadFromModal);

    $('phone-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendPhoneMessage();
      }
    });

    if (!backgroundPollTimer) {
      backgroundPollTimer = setInterval(async () => {
        try {
          await window.api.phonePollUpdates({
            minIntervalMs: 45000,
            activeCharacters: getActiveSceneCharacters(),
          });
          cachedThreads = await window.api.phoneListThreads();
          const unreadTotal = cachedThreads.reduce((sum, t) => sum + Number(t.unreadCount || 0), 0);
          setPhoneButtonUnreadBadge(unreadTotal);
        } catch {
          // best effort only
        }
      }, 45000);
    }
  };
})();
