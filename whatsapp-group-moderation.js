const fs = require('node:fs');
const path = require('node:path');
const { isOwnerJid } = require('./whatsapp-access-control');

const DATABASE_DIRECTORY = path.join(__dirname, 'banco de dados');
const SETTINGS_PATH = path.join(__dirname, 'settings', 'settings.json');
const STRIKES_PATH = path.join(DATABASE_DIRECTORY, 'antilink_escalation.json');
const LINK_PATTERN = /\b(?:https?:\/\/|www\.)\S+|\b[a-z\d-]+(?:\.[a-z\d-]+)+(?:\/\S*)?/i;
const queues = new Map();
const attachedSockets = new WeakSet();
let enabledGroupsCache = { expiresAt: 0, groups: new Set() };

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

function participantIsAdmin(participants, jid) {
  const normalized = normalizeParticipant(jid);
  return participants.some((participant) => {
    const aliases = [participant.id, participant.lid, participant.phoneNumber]
      .map(normalizeParticipant);
    return aliases.includes(normalized) && Boolean(participant.admin);
  });
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

function senderJid(message) {
  return message.key?.participant || message.key?.participantPn || '';
}

function queueBySender(key, work) {
  const previous = queues.get(key) || Promise.resolve();
  const current = previous.then(work);
  queues.set(key, current.catch(() => {}));
  return current;
}

async function deleteMessage(socket, groupJid, message, logger) {
  await socket.sendMessage(groupJid, { delete: message.key });
  logger.log(`[Anti-Link] Mensagem removida em ${groupJid}.`);
}

async function processGroupMessage(socket, message, logger = console, now = Date.now()) {
  const groupJid = message.key?.remoteJid;
  const authorJid = senderJid(message);
  if (
    message.key?.fromMe
    || !groupJid?.endsWith('@g.us')
    || !authorJid
    || !enabledAntiLinkGroups(now).has(groupJid)
  ) {
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

  const state = readStrikeState();
  const groupState = state[groupJid] || {};
  const userState = groupState[normalizeParticipant(authorJid)] || { strikes: [], mutedUntil: 0 };
  const text = extractMessageText(message);
  const hasLink = LINK_PATTERN.test(text);

  if (!hasLink && userState.mutedUntil > now) {
    await deleteMessage(socket, groupJid, message, logger);
    return;
  }
  if (!hasLink) {
    return;
  }

  const botJid = socket.user?.id;
  if (!participantIsAdmin(participants, botJid)) {
    logger.error(`[Anti-Link] Nao foi possivel aplicar punicoes: o bot nao e administrador de ${groupJid}.`);
    return;
  }

  await deleteMessage(socket, groupJid, message, logger);
  const strike = recordLinkStrike(userState, now);

  if (strike.action === 'remove') {
    await socket.groupParticipantsUpdate(groupJid, [authorJid], 'remove');
    delete groupState[normalizeParticipant(authorJid)];
    state[groupJid] = groupState;
    saveStrikeState(state);
    await socket.sendMessage(groupJid, {
      text: '🚫 Membro removido: terceiro link em até 2 minutos.'
    });
    logger.warn(`[Anti-Link] Remocao aplicada apos 3 links em ${groupJid}.`);
    return;
  }

  groupState[normalizeParticipant(authorJid)] = userState;
  state[groupJid] = groupState;
  saveStrikeState(state);
  if (strike.strikes === 2) {
    await socket.sendMessage(groupJid, {
      text: `⚠️ Segundo link em até 2 minutos: mensagens removidas por 20s. No próximo link, o participante será removido do grupo.`
    });
  }
  logger.warn(`[Anti-Link] Strike ${strike.strikes}/3; bloqueio de mensagens por ${strike.timeoutSeconds}s.`);
}

function attachGroupModeration(socket, { logger = console } = {}) {
  const events = socket?.ev;
  if (!events || typeof events.on !== 'function' || attachedSockets.has(events)) {
    return;
  }

  events.on('messages.upsert', async ({ messages = [] } = {}) => {
    for (const message of messages) {
      const key = `${message.key?.remoteJid || ''}:${normalizeParticipant(senderJid(message))}`;
      try {
        await queueBySender(key, () => processGroupMessage(socket, message, logger));
      } catch (error) {
        logger.error(`[Anti-Link] Falha ao moderar mensagem: ${error.message}`);
      }
    }
  });
  attachedSockets.add(events);
}

module.exports = {
  attachGroupModeration,
  enabledAntiLinkGroups,
  extractMessageText,
  participantIsAdmin,
  processGroupMessage,
  recordLinkStrike
};
