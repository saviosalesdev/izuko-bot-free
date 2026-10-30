const fs = require('fs');
const path = require('path');

const AUTH_DIRECTORY = path.resolve(
  process.env.WHATSAPP_AUTH_DIR || path.join(__dirname, 'banco de dados', 'ninja-qr')
);
const SESSION_KEY_FILE = /^(pre-key-|session-|app-state-sync-key-|sender-key-)/;
const patchedBaileysModules = new WeakSet();
const patchedReadlineModules = new WeakSet();

function inspectAuthDirectory(authDirectory = AUTH_DIRECTORY) {
  if (!fs.existsSync(authDirectory)) {
    return { status: 'missing', hasSignalKeys: false };
  }

  const credentialsPath = path.join(authDirectory, 'creds.json');
  if (!fs.existsSync(credentialsPath)) {
    return { status: 'incomplete', hasSignalKeys: false };
  }

  let credentials;
  try {
    credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
    return { status: 'invalid', hasSignalKeys: false };
  }

  const hasSignalKeys = fs.readdirSync(authDirectory).some((name) => SESSION_KEY_FILE.test(name));
  if (credentials.registered === true && credentials.me?.id && hasSignalKeys) {
    return { status: 'registered', hasSignalKeys };
  }
  if (credentials.registered === true || credentials.me?.id || credentials.pairingCode) {
    return { status: 'incomplete', hasSignalKeys };
  }
  return { status: 'unregistered', hasSignalKeys };
}

function archiveAuthDirectory(authDirectory, reason, logger = console) {
  if (!fs.existsSync(authDirectory)) {
    return null;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  let archivedDirectory = `${authDirectory}.reauth-${timestamp}`;
  let suffix = 1;
  while (fs.existsSync(archivedDirectory)) {
    archivedDirectory = `${authDirectory}.reauth-${timestamp}-${suffix}`;
    suffix += 1;
  }

  fs.renameSync(authDirectory, archivedDirectory);
  logger.warn(`[WhatsApp] ${reason}. Sessao preservada em "${archivedDirectory}".`);
  return archivedDirectory;
}

function prepareAuthDirectory(authDirectory = AUTH_DIRECTORY, logger = console) {
  const validation = inspectAuthDirectory(authDirectory);
  if (validation.status === 'missing' || validation.status === 'unregistered') {
    return null;
  }

  if (validation.status === 'invalid' || validation.status === 'incomplete') {
    return archiveAuthDirectory(
      authDirectory,
      validation.status === 'invalid'
        ? 'creds.json esta invalido; iniciando uma autenticacao limpa'
        : 'a sessao esta incompleta ou o pareamento anterior nao foi concluido',
      logger
    );
  }

  return null;
}

function configureHeadlessPairing({
  phoneNumber = process.env.WHATSAPP_PHONE_NUMBER,
  readline = require('node:readline'),
  stdin = process.stdin,
  logger = console,
  exitProcess = (code) => process.exit(code)
} = {}) {
  if (stdin.isTTY || patchedReadlineModules.has(readline)) {
    return;
  }

  const normalizedPhoneNumber = phoneNumber?.replace(/\D/g, '');
  if (normalizedPhoneNumber && !/^\d{8,15}$/.test(normalizedPhoneNumber)) {
    throw new Error('WHATSAPP_PHONE_NUMBER deve conter o telefone com codigo do pais, apenas com 8 a 15 digitos.');
  }

  const createInterface = readline.createInterface;
  readline.createInterface = (...args) => {
    const interfaceInstance = createInterface(...args);
    const question = interfaceInstance.question;
    interfaceInstance.question = function (prompt, ...questionArgs) {
      const normalizedPrompt = String(prompt).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      if (!/numero|phone/.test(normalizedPrompt)) {
        return question.call(this, prompt, ...questionArgs);
      }

      if (!normalizedPhoneNumber) {
        logger.error(
          '[WhatsApp] Pareamento sem terminal: configure WHATSAPP_PHONE_NUMBER com o telefone internacional, somente digitos.'
        );
        exitProcess(1);
        return this;
      }

      const callback = questionArgs.at(-1);
      if (typeof callback !== 'function') {
        throw new Error('A pergunta de pareamento do WhatsApp nao forneceu um callback.');
      }
      callback(normalizedPhoneNumber);
      return this;
    };
    return interfaceInstance;
  };
  patchedReadlineModules.add(readline);
}

function installBaileysReliability({
  authDirectory = AUTH_DIRECTORY,
  logger = console,
  exitProcess = (code) => process.exit(code),
  baileys = require('@whiskeysockets/baileys')
} = {}) {
  if (patchedBaileysModules.has(baileys)) {
    return;
  }

  const bundledVersion = baileys.DEFAULT_CONNECTION_CONFIG?.version;
  if (!Array.isArray(bundledVersion) || typeof baileys.default !== 'function') {
    throw new Error('A versao instalada do Baileys nao expoe a configuracao de conexao esperada.');
  }

  let runtimeBaileys = baileys;
  const baileysModulePath = require.resolve('@whiskeysockets/baileys');
  const cachedBaileysModule = require.cache[baileysModulePath];
  if (cachedBaileysModule?.exports === baileys && !Object.isExtensible(baileys)) {
    runtimeBaileys = { ...baileys };
    cachedBaileysModule.exports = runtimeBaileys;
  }

  runtimeBaileys.fetchLatestBaileysVersion = async () => ({
    version: [...bundledVersion],
    isLatest: false
  });

  if (process.env.WHATSAPP_AUTH_DIR) {
    const useMultiFileAuthState = runtimeBaileys.useMultiFileAuthState;
    if (typeof useMultiFileAuthState !== 'function') {
      throw new Error('A versao instalada do Baileys nao expoe useMultiFileAuthState.');
    }
    runtimeBaileys.useMultiFileAuthState = (...args) => useMultiFileAuthState(authDirectory, ...args.slice(1));
  }

  const originalSocketFactory = runtimeBaileys.default;
  runtimeBaileys.default = new Proxy(originalSocketFactory, {
    apply(factory, thisArg, args) {
      const [options, ...otherArgs] = args;
      const socket = Reflect.apply(factory, thisArg, [{
        ...options,
        version: [...bundledVersion],
        connectTimeoutMs: Math.max(options?.connectTimeoutMs || 0, 60_000),
        defaultQueryTimeoutMs: Math.max(options?.defaultQueryTimeoutMs || 0, 120_000),
        qrTimeout: Math.max(options?.qrTimeout || 0, 120_000)
      }, ...otherArgs]);

      const moderation = require('./whatsapp-group-moderation');
      require('./whatsapp-access-control').attachPrivateMessageFilter(socket, {
        logger,
        onUnauthorizedGroupMessage: (message) => moderation.moderateGroupMessage(socket, message, logger)
      });
      moderation.attachGroupModeration(socket, { logger });

      let authDirectoryArchived = false;
      socket.ev.on('connection.update', ({ connection, lastDisconnect } = {}) => {
        if (connection !== 'close') {
          return;
        }

        const error = lastDisconnect?.error;
        const statusCode = error?.output?.statusCode;
        const errorName = error?.name || 'Error';
        const message = String(error?.message || 'motivo nao informado').slice(0, 240);
        logger.error(
          `[WhatsApp] Conexao encerrada. status=${statusCode ?? 'desconhecido'}; erro=${errorName}; motivo=${message}`
        );

        const invalidSessionCodes = [
          runtimeBaileys.DisconnectReason?.loggedOut ?? 401,
          runtimeBaileys.DisconnectReason?.badSession ?? 500
        ];
        const credentials = options?.auth?.creds;
        const incompletePairing = credentials?.registered !== true
          && Boolean(credentials?.me?.id)
          && Boolean(credentials?.pairingCode);
        const pairingWasInterrupted = incompletePairing && [
          runtimeBaileys.DisconnectReason?.connectionClosed ?? 428,
          runtimeBaileys.DisconnectReason?.timedOut ?? 408,
          runtimeBaileys.DisconnectReason?.restartRequired ?? 515
        ].includes(statusCode);
        if (!authDirectoryArchived && (invalidSessionCodes.includes(statusCode) || pairingWasInterrupted)) {
          authDirectoryArchived = true;
          try {
            archiveAuthDirectory(
              authDirectory,
              pairingWasInterrupted
                ? 'o WhatsApp solicitou reinicio antes de concluir o pareamento; a tentativa incompleta foi preservada'
                : `o WhatsApp invalidou a sessao (status ${statusCode}); sera necessario parear novamente`,
              logger
            );
          } catch (archiveError) {
            logger.error(
              `[WhatsApp] Nao foi possivel preservar a sessao invalidada: ${archiveError.message}`
            );
          }
        }

        if (invalidSessionCodes.includes(statusCode)) {
          logger.error('[WhatsApp] Sessao rejeitada pelo servidor; encerrando para reiniciar com autenticacao limpa.');
        }
      });

      return socket;
    }
  });

  patchedBaileysModules.add(baileys);
  patchedBaileysModules.add(runtimeBaileys);
}

function initialize(options = {}) {
  const { authDirectory = AUTH_DIRECTORY, logger = console } = options;
  configureHeadlessPairing({ ...options, logger });
  const validation = inspectAuthDirectory(authDirectory);
  logger.log?.(`[WhatsApp] Validacao local da sessao: ${validation.status}.`);
  if (validation.status === 'registered') {
    logger.log?.('[WhatsApp] A sessao parece completa localmente; somente o WhatsApp pode confirmar se continua autorizada.');
  }
  if (process.argv.includes('--reset-whatsapp-session')) {
    archiveAuthDirectory(authDirectory, 'reset solicitado; iniciando uma autenticacao limpa', logger);
  } else {
    prepareAuthDirectory(authDirectory, logger);
  }
  installBaileysReliability(options);
  require('./whatsapp-access-control').installOwnerOnlyCommandGuard({ logger });
}

module.exports = {
  archiveAuthDirectory,
  configureHeadlessPairing,
  inspectAuthDirectory,
  initialize,
  installBaileysReliability,
  prepareAuthDirectory
};
