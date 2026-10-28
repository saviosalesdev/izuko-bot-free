const fs = require('node:fs');
const path = require('node:path');
const { isOwnerJid } = require('./whatsapp-access-control');
const { readConfig } = require('./settings/lib/antiflood-config');

const DATABASE_DIRECTORY = path.join(__dirname, 'banco de dados');
const SETTINGS_PATH = path.join(__dirname, 'settings', 'settings.json');
const ANTIFLOOD_CONFIG_PATH = path.join(DATABASE_DIRECTORY, 'antiflood_config.json');
const STRIKES_PATH = path.join(DATABASE_DIRECTORY, 'antilink_escalation.json');
const LINK_PATTERN = /\b(?:https?:\/\/|www\.)\S+|\b[a-z\d-]+(?:\.[a-z\d-]+)+(?:\/\S*)?/i;
const queues = new Map();
const floodStates = new Map();
const attachedSockets = new WeakSet();
let enabledGroupsCache = { expiresAt: 0, groups: new Set() };
const FLOOD_WINDOW_MS = 10_000;
const FLOOD_MESSAGE_LIMIT = 10;
const FLOOD_TIMEOUT_MS = 20_000;

function extractMessageText(message = {}) {
  const content = message.message || {};
  const wrapped = content.ephemeralMessage?.message
    || content.viewOnceMessage?.message
    || content.viewOnceMessageV2?.message
    || content.documentWithCaptionMessage?.message
    || content;

  return wrapped.conversation
    || wrapped.extendedTextMessage?.text
    || wrapped.imageMessage?.caption
    || wrapped.videoMessage?.caption
    || wrapped.documentMessage?.caption
    || '';
}

function enabledAntiLinkGroups(now = Date.now()) {
  if (enabledGroupsCache.expiresAt > now) {
    return enabledGroupsCache.groups;
  }

  const groups = new Set();
  for (let index = 1; index <= 5; index += 1) {
    const togglePath = path.join(DATABASE_DIRECTORY, `antilink${index === 1 ? '' : index}.json`);
    if (fs.existsSync(togglePath)) {
      const toggles = JSON.parse(fs.readFileSync(togglePath, 'utf8'));
      for (const [groupJid, enabled] of Object.entries(toggles)) {
        if (enabled === true) {
          groups.add(groupJid);
        }
      }
    }

    const configPath = path.join(DATABASE_DIRECTORY, `antilink_config_${index}.json`);
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (Array.isArray(config.gruposAtivos)) {
        for (const groupJid of config.gruposAtivos) {
          groups.add(groupJid);
        }
      }
    }
  }

  enabledGroupsCache = { expiresAt: now + 1_000, groups };
  return groups;
}

function readStrikeState() {
  if (!fs.existsSync(STRIKES_PATH)) {
    return {};
  }
  return JSON.parse(fs.readFileSync(STRIKES_PATH, 'utf8'));
}

function saveStrikeState(state) {
  fs.writeFileSync(STRIKES_PATH, JSON.stringify(state, null, 2));
}

function normalizeParticipant(jid) {
  return typeof jid === 'string' ? jid.replace(/:\d+(?=@)/, '').toLowerCase() : '';
}

function participantIsAdmin(participants, ...jids) {
  const normalizedJids = new Set(jids.filter(Boolean).map(normalizeParticipant));
  return participants.some((participant) => {
    const aliases = [participant.id, participant.lid, participant.phoneNumber]
      .map(normalizeParticipant);
    return Boolean(participant.admin) && aliases.some((alias) => normalizedJids.has(alias));
  });
}

function botJids(socket, settings = {}) {
  const credentials = socket?.authState?.creds?.me;
  return [
    settings.botLid,
    socket?.user?.id,
    socket?.user?.lid,
    credentials?.id,
    credentials?.lid
  ];
}

function recordLinkStrike(userState, now) {
  userState.strikes = userState.strikes.filter((timestamp) => now - timestamp <= 120_000);
  userState.strikes.push(now);
  if (userState.strikes.length >= 3) {
    return { action: 'remove', strikes: userState.strikes.length, timeoutSeconds: 0 };
  }

  const timeoutSeconds = userState.strikes.length === 1 ? 10 : 20;
  userState.mutedUntil = now + timeoutSeconds * 1000;
  return { action: 'timeout', strikes: userState.strikes.length, timeoutSeconds };
}

function recordFloodMessage(userState, now) {
  if (userState.mutedUntil > now) {
    return {
      action: 'timeout',
      count: userState.timestamps.length,
      timeoutSeconds: Math.ceil((userState.mutedUntil - now) / 1000)
    };
  }

  userState.timestamps = userState.timestamps.filter((timestamp) => now - timestamp < FLOOD_WINDOW_MS);
  userState.timestamps.push(now);
  if (userState.timestamps.length < FLOOD_MESSAGE_LIMIT) {
    return { action: 'allow', count: userState.timestamps.length, timeoutSeconds: 0 };
  }

  userState.mutedUntil = now + FLOOD_TIMEOUT_MS;
  userState.timestamps = [];
  return { action: 'timeout', count: FLOOD_MESSAGE_LIMIT, timeoutSeconds: FLOOD_TIMEOUT_MS / 1000 };
}

function senderJid(message) {
  return message.key?.participant || message.key?.participantPn || '';
}

function queueBySender(key, work) {
  const previous = queues.get(key) || Promise.resolve();
  const current = previous.then(work);
  queues.set(key, current.catch(() => {}));
  return current;
}

function moderateGroupMessage(socket, message, logger = console) {
  const key = `${message.key?.remoteJid || ''}:${normalizeParticipant(senderJid(message))}`;
  return queueBySender(key, () => processGroupMessage(socket, message, logger));
}

async function deleteMessage(socket, groupJid, message, logger, moderator = 'Anti-Link') {
  await socket.sendMessage(groupJid, { delete: message.key });
  logger.log(`[${moderator}] Mensagem removida em ${groupJid}.`);
}

async function processGroupMessage(socket, message, logger = console, now = Date.now()) {
  const groupJid = message.key?.remoteJid;
  const authorJid = senderJid(message);
  if (
    message.key?.fromMe
    || !groupJid?.endsWith('@g.us')
    || !authorJid
  ) {
    return;
  }

  const antiLinkEnabled = enabledAntiLinkGroups(now).has(groupJid);
  const antiFloodEnabled = readConfig(ANTIFLOOD_CONFIG_PATH).gruposAtivos.includes(groupJid);
  if (!antiLinkEnabled && !antiFloodEnabled) {
    return;
  }

  const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
  if (isOwnerJid(authorJid, settings)) {
    return;
  }

  const metadata = await socket.groupMetadata(groupJid);
  const participants = metadata.participants || [];
  if (participantIsAdmin(participants, authorJid)) {
    return;
  }

  let messageDeleted = false;
  if (antiFloodEnabled) {
    const stateKey = `${groupJid}:${normalizeParticipant(authorJid)}`;
    const userState = floodStates.get(stateKey) || { timestamps: [], mutedUntil: 0 };
    const flood = recordFloodMessage(userState, now);
    floodStates.set(stateKey, userState);

    if (flood.action === 'timeout') {
      if (participantIsAdmin(participants, ...botJids(socket, settings))) {
        await deleteMessage(socket, groupJid, message, logger, 'Anti-Flood');
        messageDeleted = true;
        logger.warn(`[Anti-Flood] Mensagens removidas por ${flood.timeoutSeconds}s em ${groupJid}.`);
      } else {
        logger.error(`[Anti-Flood] Nao foi possivel apagar mensagens: o bot nao e administrador de ${groupJid}.`);
      }
    }
  }

  if (!antiLinkEnabled) {
    return;
  }

  const state = readStrikeState();
  const groupState = state[groupJid] || {};
  const userState = groupState[normalizeParticipant(authorJid)] || { strikes: [], mutedUntil: 0 };
  const text = extractMessageText(message);
  const hasLink = LINK_PATTERN.test(text);

  if (!hasLink && userState.mutedUntil > now) {
    if (!messageDeleted) {
      await deleteMessage(socket, groupJid, message, logger);
    }
    return;
  }
  if (!hasLink) {
    return;
  }

  if (!participantIsAdmin(participants, ...botJids(socket, settings))) {
    logger.error(`[Anti-Link] Nao foi possivel aplicar punicoes: o bot nao e administrador de ${groupJid}.`);
    return;
  }

  if (!messageDeleted) {
    await deleteMessage(socket, groupJid, message, logger);
  }
  const strike = recordLinkStrike(userState, now);

  if (strike.action === 'remove') {
    await socket.groupParticipantsUpdate(groupJid, [authorJid], 'remove');
    delete groupState[normalizeParticipant(authorJid)];
    state[groupJid] = groupState;
    saveStrikeState(state);
    logger.warn(`[Anti-Link] Remocao aplicada apos 3 links em ${groupJid}.`);
    return;
  }

  groupState[normalizeParticipant(authorJid)] = userState;
  state[groupJid] = groupState;
  saveStrikeState(state);
  logger.warn(`[Anti-Link] Strike ${strike.strikes}/3; bloqueio de mensagens por ${strike.timeoutSeconds}s.`);
}

function attachGroupModeration(socket, { logger = console } = {}) {
  const events = socket?.ev;
  if (!events || typeof events.on !== 'function' || attachedSockets.has(events)) {
    return;
  }

  events.on('messages.upsert', async ({ messages = [] } = {}) => {
    for (const message of messages) {
      try {
        await moderateGroupMessage(socket, message, logger);
      } catch (error) {
        logger.error(`[Anti-Link] Falha ao moderar mensagem: ${error.message}`);
      }
    }
  });
  attachedSockets.add(events);
}

module.exports = {
  attachGroupModeration,
  botJids,
  enabledAntiLinkGroups,
  extractMessageText,
  moderateGroupMessage,
  participantIsAdmin,
  processGroupMessage,
  recordLinkStrike,
  recordFloodMessage
};
