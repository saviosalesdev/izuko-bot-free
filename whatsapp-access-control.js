const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const SETTINGS_PATH = path.join(__dirname, 'settings', 'settings.json');
const COMMANDS_DIRECTORY = `${path.join(__dirname, 'commands')}${path.sep}`;
const patchedCommands = new WeakSet();
const patchedSockets = new WeakSet();
let commandGuardInstalled = false;

function normalizeJid(jid) {
  return typeof jid === 'string' ? jid.replace(/:\d+(?=@)/, '').trim().toLowerCase() : '';
}

function isOwnerJid(jid, settings = readSettings()) {
  const ownerJid = normalizeJid(settings.ownerNumber);
  return Boolean(ownerJid && normalizeJid(jid) === ownerJid);
}

function readSettings() {
  return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
}

function isOwnerCommand(context = {}) {
  const settings = context.settings || readSettings();
  return isOwnerJid(context.sender, settings);
}

function guardCommand(command, logger = console) {
  if (!command || typeof command.execute !== 'function' || patchedCommands.has(command)) {
    return command;
  }

  const execute = command.execute;
  command.execute = async function (context = {}, ...args) {
    if (!isOwnerCommand(context)) {
      logger.warn(`[Access] Comando "${command.name || 'desconhecido'}" bloqueado: remetente nao autorizado.`);
      return undefined;
    }
    return execute.call(this, context, ...args);
  };
  patchedCommands.add(command);
  return command;
}

function installOwnerOnlyCommandGuard({ logger = console, moduleLoader = Module } = {}) {
  if (commandGuardInstalled) {
    return;
  }

  const originalLoad = moduleLoader._load;
  moduleLoader._load = function (request, parent, isMain) {
    const filename = moduleLoader._resolveFilename(request, parent, isMain);
    const exports = originalLoad.call(this, request, parent, isMain);

    if (typeof filename === 'string' && filename.startsWith(COMMANDS_DIRECTORY)) {
      guardCommand(exports, logger);
    }
    return exports;
  };
  commandGuardInstalled = true;
}

function isPrivateJid(jid) {
  return typeof jid === 'string' && (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid'));
}

function filterUnauthorizedPrivateMessages(upsert, settings = readSettings()) {
  if (!upsert || !Array.isArray(upsert.messages)) {
    return upsert;
  }

  const messages = upsert.messages.filter((message) => {
    const remoteJid = message?.key?.remoteJid;
    if (message?.key?.fromMe || !isPrivateJid(remoteJid)) {
      return true;
    }

    const senderJids = [
      message.key.participant,
      message.key.participantPn,
      message.key.senderPn,
      remoteJid
    ];
    return senderJids.some((jid) => isOwnerJid(jid, settings));
  });

  return messages.length === upsert.messages.length ? upsert : { ...upsert, messages };
}

function attachPrivateMessageFilter(socket, { logger = console } = {}) {
  const eventEmitter = socket?.ev;
  if (!eventEmitter || typeof eventEmitter.emit !== 'function' || patchedSockets.has(eventEmitter)) {
    return;
  }

  const originalEmit = eventEmitter.emit;
  eventEmitter.emit = function (event, data, ...args) {
    if (event !== 'messages.upsert') {
      return originalEmit.call(this, event, data, ...args);
    }

    const filtered = filterUnauthorizedPrivateMessages(data);
    if (filtered !== data && filtered.messages.length < data.messages.length) {
      logger.warn(`[Access] Mensagens privadas ignoradas: remetente diferente de ownerNumber.`);
    }
    if (!filtered.messages.length) {
      return true;
    }
    return originalEmit.call(this, event, filtered, ...args);
  };
  patchedSockets.add(eventEmitter);
}

module.exports = {
  attachPrivateMessageFilter,
  filterUnauthorizedPrivateMessages,
  guardCommand,
  installOwnerOnlyCommandGuard,
  isOwnerJid,
  normalizeJid
};
