const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const {
  initialize,
  inspectAuthDirectory,
  installBaileysReliability,
  prepareAuthDirectory
} = require('../whatsapp-auth-recovery');

function createTemporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'izuko-auth-test-'));
}

function createLogger() {
  return { error() {}, warn() {} };
}

test('archives registered credentials when all Signal key files are missing', (t) => {
  const parent = createTemporaryDirectory();
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const authDirectory = path.join(parent, 'ninja-qr');
  fs.mkdirSync(authDirectory);
  fs.writeFileSync(path.join(authDirectory, 'creds.json'), JSON.stringify({
    registered: true,
    me: { id: 'redacted' }
  }));

  const archivedDirectory = prepareAuthDirectory(authDirectory, createLogger());

  assert.ok(archivedDirectory);
  assert.equal(fs.existsSync(authDirectory), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(archivedDirectory, 'creds.json'), 'utf8')).registered, true);
});

test('keeps a fresh, unregistered auth directory in place', (t) => {
  const parent = createTemporaryDirectory();
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const authDirectory = path.join(parent, 'ninja-qr');
  fs.mkdirSync(authDirectory);
  fs.writeFileSync(path.join(authDirectory, 'creds.json'), JSON.stringify({ registered: false }));

  assert.equal(prepareAuthDirectory(authDirectory, createLogger()), null);
  assert.equal(fs.existsSync(authDirectory), true);
});

test('reports whether the local auth state is missing, incomplete, or registered', (t) => {
  const parent = createTemporaryDirectory();
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const authDirectory = path.join(parent, 'ninja-qr');
  assert.equal(inspectAuthDirectory(authDirectory).status, 'missing');

  fs.mkdirSync(authDirectory);
  fs.writeFileSync(path.join(authDirectory, 'creds.json'), JSON.stringify({ registered: false }));
  assert.equal(inspectAuthDirectory(authDirectory).status, 'unregistered');

  fs.writeFileSync(path.join(authDirectory, 'creds.json'), JSON.stringify({
    registered: true,
    me: { id: 'redacted' }
  }));
  assert.equal(inspectAuthDirectory(authDirectory).status, 'incomplete');

  fs.writeFileSync(path.join(authDirectory, 'pre-key-1.json'), '{}');
  assert.equal(inspectAuthDirectory(authDirectory).status, 'registered');
});

test('uses the configured phone number for pairing prompts in non-interactive terminals', () => {
  const readline = {
    createInterface() {
      return { question() {} };
    }
  };

  const { configureHeadlessPairing } = require('../whatsapp-auth-recovery');
  configureHeadlessPairing({
    phoneNumber: '+55 (71) 99140-6023',
    readline,
    stdin: { isTTY: false },
    logger: createLogger()
  });
  readline.createInterface().question('Digite o número do bot:', (answer) => {
    assert.equal(answer, '5571991406023');
  });
});

test('fails clearly when headless pairing has no configured phone number', () => {
  let exitCode;
  const readline = {
    createInterface() {
      return { question() {} };
    }
  };

  const { configureHeadlessPairing } = require('../whatsapp-auth-recovery');
  configureHeadlessPairing({
    phoneNumber: '',
    readline,
    stdin: { isTTY: false },
    logger: createLogger(),
    exitProcess(code) {
      exitCode = code;
    }
  });
  readline.createInterface().question('Digite o número do bot:', () => {});
  assert.equal(exitCode, 1);
});

test('archives an incomplete pairing even when old Signal key files exist', (t) => {
  const parent = createTemporaryDirectory();
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const authDirectory = path.join(parent, 'ninja-qr');
  fs.mkdirSync(authDirectory);
  fs.writeFileSync(path.join(authDirectory, 'creds.json'), JSON.stringify({
    registered: false,
    me: { id: 'redacted' },
    pairingCode: 'redacted'
  }));
  fs.writeFileSync(path.join(authDirectory, 'pre-key-1.json'), '{}');
  fs.writeFileSync(path.join(authDirectory, 'session-redacted.json'), '{}');

  const archivedDirectory = prepareAuthDirectory(authDirectory, createLogger());

  assert.ok(archivedDirectory);
  assert.equal(fs.existsSync(authDirectory), false);
  assert.equal(fs.existsSync(path.join(archivedDirectory, 'pre-key-1.json')), true);
});

test('initialization repairs the active auth directory before installing Baileys', (t) => {
  const parent = createTemporaryDirectory();
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const authDirectory = path.join(parent, 'ninja-qr');
  fs.mkdirSync(authDirectory);
  fs.writeFileSync(path.join(authDirectory, 'creds.json'), JSON.stringify({
    registered: true,
    pairingCode: 'redacted'
  }));
  const baileys = {
    default() { return { ev: new EventEmitter() }; },
    DEFAULT_CONNECTION_CONFIG: { version: [2, 3000, 123] }
  };

  initialize({ authDirectory, baileys, logger: createLogger(), stdin: { isTTY: true } });

  assert.equal(fs.existsSync(authDirectory), false);
  assert.equal(fs.readdirSync(parent).some((name) => name.startsWith('ninja-qr.reauth-')), true);
});

test('explicit session reset archives an otherwise valid registered session', (t) => {
  const parent = createTemporaryDirectory();
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const authDirectory = path.join(parent, 'ninja-qr');
  fs.mkdirSync(authDirectory);
  fs.writeFileSync(path.join(authDirectory, 'creds.json'), JSON.stringify({
    registered: true,
    me: { id: 'redacted' }
  }));
  fs.writeFileSync(path.join(authDirectory, 'pre-key-1.json'), '{}');
  const previousArgv = process.argv;
  process.argv = [...previousArgv, '--reset-whatsapp-session'];
  const baileys = {
    default() { return { ev: new EventEmitter() }; },
    DEFAULT_CONNECTION_CONFIG: { version: [2, 3000, 123] }
  };

  try {
    initialize({ authDirectory, baileys, logger: createLogger(), stdin: { isTTY: true } });
  } finally {
    process.argv = previousArgv;
  }

  assert.equal(fs.existsSync(authDirectory), false);
  assert.equal(fs.readdirSync(parent).some((name) => name.startsWith('ninja-qr.reauth-')), true);
});

test('uses the installed protocol version and extends the socket and QR timeouts', () => {
  const bundledVersion = [2, 3000, 123];
  let receivedOptions;
  const socket = { ev: new EventEmitter() };
  let exitCode;
  const baileys = {
    default(options) {
      receivedOptions = options;
      return socket;
    },
    DEFAULT_CONNECTION_CONFIG: { version: bundledVersion },
    DisconnectReason: { badSession: 500, loggedOut: 401 },
    async fetchLatestBaileysVersion() {
      throw new Error('network lookup should not be used');
    }
  };

  installBaileysReliability({ baileys, authDirectory: path.join(os.tmpdir(), 'unused'), logger: createLogger() });
  const expectedVersion = baileys.DEFAULT_CONNECTION_CONFIG.version;
  const versionResult = baileys.fetchLatestBaileysVersion();
  return versionResult.then(({ version }) => {
    assert.deepEqual(version, expectedVersion);
    baileys.default({ connectTimeoutMs: 20_000, qrTimeout: 60_000 });
    assert.deepEqual(receivedOptions.version, expectedVersion);
    assert.equal(receivedOptions.connectTimeoutMs, 60_000);
    assert.equal(receivedOptions.defaultQueryTimeoutMs, 120_000);
    assert.equal(receivedOptions.qrTimeout, 120_000);
  });

});

test('routes Baileys auth storage to the configured persistent directory', () => {
  const previousAuthDirectory = process.env.WHATSAPP_AUTH_DIR;
  const authDirectory = path.join(os.tmpdir(), 'railway-auth-volume', 'auth');
  let authArguments;
  process.env.WHATSAPP_AUTH_DIR = authDirectory;
  const baileys = {
    default() { return { ev: new EventEmitter() }; },
    DEFAULT_CONNECTION_CONFIG: { version: [2, 3000, 123] },
    useMultiFileAuthState(...args) {
      authArguments = args;
    }
  };

  try {
    installBaileysReliability({ baileys, authDirectory, logger: createLogger() });
    baileys.useMultiFileAuthState('default-folder', { silent: true });
    assert.deepEqual(authArguments, [authDirectory, { silent: true }]);
  } finally {
    if (previousAuthDirectory === undefined) {
      delete process.env.WHATSAPP_AUTH_DIR;
    } else {
      process.env.WHATSAPP_AUTH_DIR = previousAuthDirectory;
    }
  }
});

test('archives an incomplete pairing on socket close but preserves a registered session', (t) => {
  const parent = createTemporaryDirectory();
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const authDirectory = path.join(parent, 'ninja-qr');
  fs.mkdirSync(authDirectory);
  fs.writeFileSync(path.join(authDirectory, 'creds.json'), JSON.stringify({ registered: false }));
  const socket = { ev: new EventEmitter() };
  const credentials = {
    registered: false,
    me: { id: 'redacted' },
    pairingCode: 'redacted'
  };
  const baileys = {
    default() { return socket; },
    DEFAULT_CONNECTION_CONFIG: { version: [2, 3000, 123] },
    DisconnectReason: { badSession: 500, loggedOut: 401, restartRequired: 515 }
  };

  installBaileysReliability({
    baileys,
    authDirectory,
    logger: createLogger()
  });
  baileys.default({ auth: { creds: credentials } });
  socket.ev.emit('connection.update', {
    connection: 'close',
    lastDisconnect: { error: { output: { statusCode: 428 }, message: 'connection closed' } }
  });
  assert.equal(fs.existsSync(authDirectory), false);
  assert.equal(fs.readdirSync(parent).some((name) => name.startsWith('ninja-qr.reauth-')), true);

  const registeredDirectory = path.join(parent, 'registered-session');
  fs.mkdirSync(registeredDirectory);
  fs.writeFileSync(path.join(registeredDirectory, 'creds.json'), JSON.stringify({ registered: true }));
  const registeredSocket = { ev: new EventEmitter() };
  const registeredBaileys = {
    default() { return registeredSocket; },
    DEFAULT_CONNECTION_CONFIG: { version: [2, 3000, 123] },
    DisconnectReason: { badSession: 500, loggedOut: 401, restartRequired: 515 }
  };

  installBaileysReliability({
    baileys: registeredBaileys,
    authDirectory: registeredDirectory,
    logger: createLogger()
  });
  registeredBaileys.default({
    auth: { creds: { registered: true, me: { id: 'redacted' }, pairingCode: 'redacted' } }
  });
  registeredSocket.ev.emit('connection.update', {
    connection: 'close',
    lastDisconnect: { error: { output: { statusCode: 515 }, message: 'restart required' } }
  });
  assert.equal(fs.existsSync(registeredDirectory), true);
});

test('archives auth state when WhatsApp reports logout, but not for temporary disconnects', (t) => {
  const parent = createTemporaryDirectory();
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const authDirectory = path.join(parent, 'ninja-qr');
  fs.mkdirSync(authDirectory);
  fs.writeFileSync(path.join(authDirectory, 'creds.json'), JSON.stringify({ registered: true }));
  const socket = { ev: new EventEmitter() };
  let exitCode;
  const baileys = {
    default() { return socket; },
    DEFAULT_CONNECTION_CONFIG: { version: [2, 3000, 123] },
    DisconnectReason: { badSession: 500, loggedOut: 401 }
  };

  installBaileysReliability({
    baileys,
    authDirectory,
    logger: createLogger(),
    exitProcess(code) {
      exitCode = code;
    }
  });
  baileys.default({});
  socket.ev.emit('connection.update', {
    connection: 'close',
    lastDisconnect: { error: { output: { statusCode: 428 }, message: 'temporary' } }
  });
  assert.equal(fs.existsSync(authDirectory), true);

  socket.ev.emit('connection.update', {
    connection: 'close',
    lastDisconnect: { error: { output: { statusCode: 401 }, message: 'logged out' } }
  });
  assert.equal(fs.existsSync(authDirectory), false);
  assert.equal(fs.readdirSync(parent).some((name) => name.startsWith('ninja-qr.reauth-')), true);
  assert.equal(exitCode, 1);
});
