'use strict';

const { createPhoneStore } = require('./phone/phone-store');
const { generatePhoneReply, generateInboundText } = require('./phone/phone-replies');
const {
  toArray,
  nowIso,
  createId,
  pickRandom,
  randomInt,
  normalizeParticipants,
  buildThreadTitle,
  normalizeReceipt,
  normalizeImageAttachment,
  advanceThreadReceipts,
  buildPresenceTextForThread,
  markPresence,
  findStoryContactUnlocks,
  detectStoryPhoneHook,
  choosePhotoSpritePath,
  chooseHookTargets,
  pickAutoResponders,
  normalizeContactsState,
  chooseNextSpeaker,
  buildInSceneSet,
  isThreadAwaitingUserReply,
} = require('./phone/phone-domain');

function normalizeThreadState(raw) {
  const data = raw && typeof raw === 'object' ? raw : { threads: [], meta: {} };
  const threads = toArray(data.threads).map((t) => ({
    id: String(t?.id || createId('thread')),
    title: String(t?.title || ''),
    participants: normalizeParticipants(t?.participants),
    messages: toArray(t?.messages).map((m) => ({
      id: String(m?.id || createId('msg')),
      from: String(m?.from || 'system'),
      text: String(m?.text || ''),
      timestamp: String(m?.timestamp || nowIso()),
      receipt: String(m?.from || '').toLowerCase() === 'you' ? normalizeReceipt(m?.receipt) : undefined,
      image: normalizeImageAttachment(m?.image),
    })),
    createdAt: String(t?.createdAt || nowIso()),
    updatedAt: String(t?.updatedAt || nowIso()),
    unreadCount: Number.isFinite(Number(t?.unreadCount)) ? Number(t.unreadCount) : 0,
  }));
  const meta = data.meta && typeof data.meta === 'object' ? data.meta : {};
  return { threads, meta };
}

function registerPhoneHandlers({
  ipcMain,
  aiService,
  loadConfig,
  readJsonSafe,
  writeJsonSafe,
  readTextSafe,
  phoneThreadsPath,
  phoneContactsPath,
  botFilesPath,
  fs,
  path,
  trace,
}) {
  const store = createPhoneStore({
    readJsonSafe,
    writeJsonSafe,
    phoneThreadsPath,
    phoneContactsPath,
    fs,
    path,
    botFilesPath,
  });

  ipcMain.handle('phone-list-threads', () => {
    const t = trace.createTrace('phone-list-threads');
    const state = normalizeThreadState(store.loadThreads());
    state.meta ??= {};
    const items = state.threads
      .slice()
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .map((thread) => ({
        id: thread.id,
        title: thread.title || buildThreadTitle(thread.participants),
        participants: thread.participants,
        updatedAt: thread.updatedAt,
        unreadCount: thread.unreadCount || 0,
        preview: thread.messages.length ? thread.messages[thread.messages.length - 1].text : '',
        presenceText: buildPresenceTextForThread(thread, state.meta),
      }));
    return trace.ok(t, items);
  });

  ipcMain.handle('phone-get-thread', (_event, threadId) => {
    const t = trace.createTrace('phone-get-thread');
    const id = String(threadId || '').trim();
    const state = normalizeThreadState(store.loadThreads());
    const thread = state.threads.find((x) => x.id === id) || null;
    if (thread) {
      thread.presenceText = buildPresenceTextForThread(thread, state.meta || {});
    }
    return trace.ok(t, thread);
  });

  ipcMain.handle('phone-create-thread', (_event, payload = {}) => {
    const t = trace.createTrace('phone-create-thread');
    const participants = normalizeParticipants(payload.participants);
    if (!participants.length) {
      return trace.fail(t, 'INVALID_PARTICIPANTS', 'At least one participant is required.');
    }
    if (!participants.some((p) => p.toLowerCase() === 'you')) participants.unshift('You');

    const state = normalizeThreadState(store.loadThreads());
    const contactsState = normalizeContactsState(
      store.loadContacts(),
      store.listCharacterFolders(),
      store.loadStarterKnownNumbers()
    );
    const denied = participants
      .filter((p) => p.toLowerCase() !== 'you')
      .filter((p) => !contactsState.contacts[String(p).toLowerCase()]?.hasNumber);
    if (denied.length) {
      return trace.fail(t, 'CONTACT_NOT_AVAILABLE', `You do not have numbers for: ${denied.join(', ')}`);
    }
    const thread = {
      id: createId('thread'),
      title: String(payload.title || '').trim() || buildThreadTitle(participants),
      participants,
      messages: [],
      createdAt: nowIso(),
      updatedAt: nowIso(),
      unreadCount: 0,
    };
    state.threads.push(thread);
    store.saveThreads(state);
    return trace.ok(t, thread);
  });

  ipcMain.handle('phone-mark-read', (_event, threadId) => {
    const t = trace.createTrace('phone-mark-read');
    const id = String(threadId || '').trim();
    const state = normalizeThreadState(store.loadThreads());
    const thread = state.threads.find((x) => x.id === id);
    if (!thread) return trace.ok(t, false);
    thread.unreadCount = 0;
    advanceThreadReceipts(thread, 'read');
    thread.updatedAt = nowIso();
    store.saveThreads(state);
    return trace.ok(t, true);
  });

  ipcMain.handle('phone-reset-state', () => {
    const t = trace.createTrace('phone-reset-state');
    const characters = store.listCharacterFolders();
    const starters = store.loadStarterKnownNumbers();
    const contacts = normalizeContactsState({ contacts: {} }, characters, starters);
    store.saveThreads({ threads: [], meta: {} });
    store.saveContacts(contacts);
    return trace.ok(t, {
      clearedThreads: true,
      contactsCount: characters.length,
    });
  });

  ipcMain.handle('phone-poll-updates', async (_event, options = {}) => {
    const t = trace.createTrace('phone-poll-updates');
    const state = normalizeThreadState(store.loadThreads());
    state.meta ??= {};

    const trigger = String(options?.trigger || '').trim().toLowerCase();
    const now = Date.now();
    const minIntervalMs = Number(options?.minIntervalMs) || (trigger === 'main-chat' ? 0 : 20_000);
    const force = Boolean(options?.force);
    const lastAt = Number(state.meta.lastPollAt || 0);
    if (!force && lastAt && now - lastAt < minIntervalMs) {
      return trace.ok(t, { createdThreads: 0, incomingMessages: 0, skipped: true });
    }
    state.meta.lastPollAt = now;

    const contactsState = normalizeContactsState(
      store.loadContacts(),
      store.listCharacterFolders(),
      store.loadStarterKnownNumbers()
    );
    const phoneConfig = store.loadPhoneConfig();
    const photoCfg = phoneConfig.photoMessaging && typeof phoneConfig.photoMessaging === 'object'
      ? phoneConfig.photoMessaging
      : {};
    const photoEnabled = Boolean(photoCfg.enabled);
    const photoChance = Math.max(0, Math.min(1, Number(photoCfg.chance ?? 0.22)));
    const maxPhotosPerTick = Math.max(0, Math.floor(Number(photoCfg.maxPerTick ?? 1)));
    let photosGenerated = 0;
    const knownCharacterNames = store.listCharacterFolders();
    const storyText = String(options?.storyText || '');
    const activeCharacters = normalizeParticipants(options?.activeCharacters);
    const inSceneSet = buildInSceneSet(activeCharacters);
    const newlyUnlockedContacts = findStoryContactUnlocks({
      storyText,
      activeCharacters,
      contactsState,
      characterNames: knownCharacterNames,
    });
    const knownContacts = Object.entries(contactsState.contacts)
      .filter(([, v]) => Boolean(v?.hasNumber))
      .map(([k]) => k);
    const availableContacts = knownContacts.filter((name) => !inSceneSet.has(String(name).toLowerCase()));
    if (!availableContacts.length) {
      store.saveThreads(state);
      return trace.ok(t, { createdThreads: 0, incomingMessages: 0, newlyUnlockedContacts, skipped: true });
    }

    const knownThreads = state.threads.filter((thread) =>
      thread.participants.some((p) => p.toLowerCase() !== 'you' && availableContacts.includes(p.toLowerCase()))
    );

    const action = String(options?.action || '').trim();
    let chosenAction = action;
    if (!chosenAction) {
      const r = Math.random();
      if (trigger === 'main-chat') {
        if (r < 0.45) chosenAction = 'message';
        else if (r < 0.75) chosenAction = 'chatter';
        else if (r < 0.9) chosenAction = 'new-dm';
        else chosenAction = 'new-group';
      } else {
        if (r < 0.55) chosenAction = 'message';
        else if (r < 0.8) chosenAction = 'new-dm';
        else chosenAction = 'new-group';
      }
    }

    const config = loadConfig();
    let createdThreads = 0;
    let incomingMessages = 0;

    const contactsTitleCase = knownCharacterNames.reduce((map, name) => {
      map[name.toLowerCase()] = name;
      return map;
    }, {});

    const pickKnownName = (lower) => contactsTitleCase[lower] || lower.charAt(0).toUpperCase() + lower.slice(1);

    const pickOrCreateDmThread = (contactLower) => {
      if (!contactLower || inSceneSet.has(String(contactLower).toLowerCase())) return null;
      const name = pickKnownName(contactLower);
      let thread = state.threads.find((x) => {
        const others = x.participants.filter((p) => p.toLowerCase() !== 'you').map((p) => p.toLowerCase());
        return others.length === 1 && others[0] === contactLower;
      });
      if (!thread) {
        thread = {
          id: createId('thread'),
          title: name,
          participants: ['You', name],
          messages: [],
          createdAt: nowIso(),
          updatedAt: nowIso(),
          unreadCount: 0,
        };
        state.threads.push(thread);
        createdThreads++;
      }
      return thread;
    };

    const forcedCount = Number.isFinite(Number(options?.messageCount)) ? Number(options.messageCount) : null;

    const appendInboundBurst = async ({ thread, speakers, minCount, maxCount, topicHint }) => {
      if (!thread) return 0;
      if (isThreadAwaitingUserReply(thread)) return 0;
      const pool = (Array.isArray(speakers) ? speakers : []).filter(Boolean);
      const availablePool = pool.filter((name) => !inSceneSet.has(String(name).toLowerCase()));
      if (!availablePool.length) return 0;

      const burstCount = forcedCount != null ? Math.max(1, Math.floor(forcedCount)) : randomInt(minCount, maxCount);
      let added = 0;
      let previousSpeaker = null;
      for (let i = 0; i < burstCount; i++) {
        const from = chooseNextSpeaker(availablePool, previousSpeaker);
        if (!from) continue;
        previousSpeaker = from;
        try {
          const text = await generateInboundText({ aiService, config, from, thread, readTextSafe, botFilesPath, path, topicHint });
          if (!text) continue;
          let image = null;
          const shouldAttachPhoto = photoEnabled && photosGenerated < maxPhotosPerTick && Math.random() < photoChance;
          if (shouldAttachPhoto) {
            const spriteFiles = store.listCharacterSpriteFiles(from);
            const picked = choosePhotoSpritePath(spriteFiles, `${text} ${topicHint || ''}`);
            if (picked) {
              image = {
                path: picked,
                caption: 'Photo',
                source: 'sprite',
              };
              photosGenerated += 1;
            }
          }
          thread.messages.push({ id: createId('msg'), from, text, timestamp: nowIso(), image });
          markPresence(state.meta, from);
          advanceThreadReceipts(thread, 'read');
          thread.unreadCount = Number(thread.unreadCount || 0) + 1;
          thread.updatedAt = nowIso();
          added++;
        } catch {
          // noop
        }
      }
      return added;
    };

    for (const thread of state.threads) {
      if (Math.random() < 0.45) advanceThreadReceipts(thread, 'delivered');
    }

    const storyHook = detectStoryPhoneHook(storyText);
    const storyTargets = chooseHookTargets({
      hook: storyHook,
      storyText,
      activeCharacters,
      knownContacts: availableContacts,
      displayNameMap: contactsTitleCase,
    });
    if (storyHook && storyTargets.length) {
      if ((storyHook.type === 'invite' || storyHook.type === 'location') && storyTargets.length >= 2) {
        const p1 = pickKnownName(storyTargets[0]);
        const p2 = pickKnownName(storyTargets[1]);
        let thread = state.threads.find((x) => {
          const others = x.participants.filter((p) => p.toLowerCase() !== 'you').map((p) => p.toLowerCase());
          return others.length === 2 && others.includes(storyTargets[0]) && others.includes(storyTargets[1]);
        });
        if (!thread) {
          thread = {
            id: createId('thread'),
            title: `${p1}, ${p2}`,
            participants: normalizeParticipants(['You', p1, p2]),
            messages: [],
            createdAt: nowIso(),
            updatedAt: nowIso(),
            unreadCount: 0,
          };
          state.threads.push(thread);
          createdThreads++;
        }
        incomingMessages += await appendInboundBurst({
          thread,
          speakers: [p1, p2],
          minCount: trigger === 'main-chat' ? 2 : 1,
          maxCount: trigger === 'main-chat' ? 3 : 2,
          topicHint: storyHook.topicHint,
        });
      } else {
        const lower = storyTargets[0];
        const thread = pickOrCreateDmThread(lower);
        incomingMessages += await appendInboundBurst({
          thread,
          speakers: [pickKnownName(lower)],
          minCount: 1,
          maxCount: trigger === 'main-chat' ? 2 : 1,
          topicHint: storyHook.topicHint,
        });
      }
      chosenAction = 'story-hook';
    }

    if (chosenAction === 'story-hook') {
      // story hook already applied
    } else if (chosenAction === 'new-group' && availableContacts.length >= 2) {
      const shuffled = [...availableContacts].sort(() => Math.random() - 0.5);
      const p1 = pickKnownName(shuffled[0]);
      const p2 = pickKnownName(shuffled[1]);
      const thread = {
        id: createId('thread'),
        title: `${p1}, ${p2}`,
        participants: normalizeParticipants(['You', p1, p2]),
        messages: [],
        createdAt: nowIso(),
        updatedAt: nowIso(),
        unreadCount: 0,
      };
      state.threads.push(thread);
      createdThreads++;
      const minCount = trigger === 'main-chat' ? 2 : 1;
      const maxCount = trigger === 'main-chat' ? 3 : 2;
      incomingMessages += await appendInboundBurst({ thread, speakers: [p1, p2], minCount, maxCount });
    } else if (chosenAction === 'new-dm') {
      const contact = pickRandom(availableContacts);
      if (contact) {
        const thread = pickOrCreateDmThread(contact);
        const from = pickKnownName(contact);
        incomingMessages += await appendInboundBurst({
          thread,
          speakers: [from],
          minCount: 1,
          maxCount: trigger === 'main-chat' ? 2 : 1,
        });
      }
    } else if (chosenAction === 'chatter') {
      const chatterThreads = state.threads.filter((thread) =>
        thread.participants.filter((p) => p.toLowerCase() !== 'you').length >= 2
      );
      const sourceThread = chatterThreads.length ? pickRandom(chatterThreads) : null;
      if (sourceThread) {
        const speakers = sourceThread.participants.filter((p) => p.toLowerCase() !== 'you');
        incomingMessages += await appendInboundBurst({
          thread: sourceThread,
          speakers,
          minCount: 2,
          maxCount: 3,
        });
      }
    } else {
      const sourceThread = knownThreads.length ? pickRandom(knownThreads) : pickOrCreateDmThread(pickRandom(availableContacts));
      if (sourceThread) {
        const speakers = sourceThread.participants.filter((p) => {
          const lower = p.toLowerCase();
          return lower !== 'you' && !inSceneSet.has(lower);
        });
        const hasGroupChatter = speakers.length >= 2 && trigger === 'main-chat' && Math.random() < 0.45;
        incomingMessages += await appendInboundBurst({
          thread: sourceThread,
          speakers: hasGroupChatter ? speakers : [pickRandom(speakers) || speakers[0]],
          minCount: hasGroupChatter ? 2 : 1,
          maxCount: hasGroupChatter ? 3 : (trigger === 'main-chat' ? 2 : 1),
        });
      }
    }

    store.saveThreads(state);
    store.saveContacts(contactsState);
    return trace.ok(t, {
      createdThreads,
      incomingMessages,
      photosGenerated,
      newlyUnlockedContacts,
      trigger,
      action: chosenAction,
      skipped: false,
    });
  });

  ipcMain.handle('phone-send-message', async (_event, threadId, text, options = {}) => {
    const t = trace.createTrace('phone-send-message');
    const id = String(threadId || '').trim();
    const cleanText = String(text || '').trim();
    if (!id || !cleanText) {
      return trace.fail(t, 'INVALID_MESSAGE', 'Thread id and text are required.');
    }

    const state = normalizeThreadState(store.loadThreads());
    const thread = state.threads.find((x) => x.id === id);
    if (!thread) {
      return trace.fail(t, 'THREAD_NOT_FOUND', 'Thread not found.');
    }

    thread.messages.push({
      id: createId('msg'),
      from: 'You',
      text: cleanText,
      timestamp: nowIso(),
      receipt: {
        state: 'sent',
        deliveredAt: null,
        readAt: null,
      },
    });
    thread.updatedAt = nowIso();

    const config = loadConfig();
    const phoneConfig = store.loadPhoneConfig();
    const photoCfg = phoneConfig.photoMessaging && typeof phoneConfig.photoMessaging === 'object'
      ? phoneConfig.photoMessaging
      : {};
    const photoEnabled = Boolean(photoCfg.enabled);
    const photoChance = Math.max(0, Math.min(1, Number(photoCfg.replyChance ?? photoCfg.chance ?? 0.16)));
    const maxReplyPhotos = Math.max(0, Math.floor(Number(photoCfg.maxReplyPhotos ?? 1)));
    let photosGenerated = 0;
    const inSceneSet = buildInSceneSet(options?.activeCharacters);
    const responders = pickAutoResponders(thread, 2).filter((name) => !inSceneSet.has(String(name).toLowerCase()));
    for (const responder of responders) {
      try {
        const reply = await generatePhoneReply({
          aiService,
          config,
          characterName: responder,
          thread,
          readTextSafe,
          botFilesPath,
          path,
        });
        if (reply) {
          let image = null;
          const shouldAttachPhoto = photoEnabled && photosGenerated < maxReplyPhotos && Math.random() < photoChance;
          if (shouldAttachPhoto) {
            const spriteFiles = store.listCharacterSpriteFiles(responder);
            const picked = choosePhotoSpritePath(spriteFiles, reply);
            if (picked) {
              image = { path: picked, caption: 'Photo', source: 'sprite' };
              photosGenerated += 1;
            }
          }
          thread.messages.push({
            id: createId('msg'),
            from: responder,
            text: reply,
            timestamp: nowIso(),
            image,
          });
          markPresence(state.meta ??= {}, responder);
          advanceThreadReceipts(thread, 'read');
          thread.unreadCount = Number(thread.unreadCount || 0) + 1;
          thread.updatedAt = nowIso();
        }
      } catch {
        thread.messages.push({
          id: createId('msg'),
          from: 'System',
          text: `${responder} could not reply right now.`,
          timestamp: nowIso(),
        });
      }
    }

    store.saveThreads(state);
    return trace.ok(t, thread);
  });

  ipcMain.handle('phone-get-contacts', () => {
    const t = trace.createTrace('phone-get-contacts');
    const known = normalizeContactsState(
      store.loadContacts(),
      store.listCharacterFolders(),
      store.loadStarterKnownNumbers()
    );
    store.saveContacts(known);
    const names = store.listCharacterFolders();
    const contacts = names.map((name) => {
      const key = name.toLowerCase();
      const item = known.contacts?.[key] || {};
      return {
        name,
        hasNumber: Boolean(item.hasNumber),
      };
    });
    return trace.ok(t, contacts);
  });

  ipcMain.handle('phone-set-contact-known', (_event, name, hasNumber) => {
    const t = trace.createTrace('phone-set-contact-known');
    const n = String(name || '').trim();
    if (!n) return trace.fail(t, 'INVALID_CONTACT', 'Contact name is required.');
    const key = n.toLowerCase();
    const state = store.loadContacts();
    state.contacts ??= {};
    state.contacts[key] = { hasNumber: Boolean(hasNumber) };
    store.saveContacts(state);
    return trace.ok(t, true);
  });
}

module.exports = {
  registerPhoneHandlers,
};
