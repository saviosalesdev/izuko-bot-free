const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const { installBaileysReliability } = require('./whatsapp-auth-recovery');

function createLogger() {
  return { error() {}, warn() {}, log() {} };
}

test('preserves an active pairing when WhatsApp returns 401', (t) => {
  const authDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'izuko-pairing-'));
  t.after(() => fs.rmSync(authDirectory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(authDirectory, 'creds.json'), JSON.stringify({
    registered: false,
    pairingCode: '1MEXYBHB',
    me: { id: '5545981514596@s.whatsapp.net' }
  }));

  const socket = { ev: new EventEmitter() };
  const baileys = {
    default() { return socket; },
    DEFAULT_CONNECTION_CONFIG: { version: [2, 3000, 123] },
    DisconnectReason: { badSession: 500, loggedOut: 401 }
  };

  installBaileysReliability({
    baileys,
    authDirectory,
    logger: createLogger()
  });
  baileys.default({
    auth: {
      creds: {
        registered: false,
        pairingCode: '1MEXYBHB',
        me: { id: '5545981514596@s.whatsapp.net' }
      }
    }
  });
  socket.ev.emit('connection.update', {
    connection: 'close',
    lastDisconnect: {
      error: { output: { statusCode: 401 }, message: 'Connection Failure' }
    }
  });

  assert.equal(fs.existsSync(authDirectory), true);
  assert.equal(fs.readdirSync(authDirectory).some((name) => name.endsWith('.reauth')), false);
});

test('archives 401 for a registered session', (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'izuko-session-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const authDirectory = path.join(parent, 'whatsapp-auth');
  fs.mkdirSync(authDirectory);
  fs.writeFileSync(path.join(authDirectory, 'creds.json'), JSON.stringify({
    registered: true,
    me: { id: '5545981514596@s.whatsapp.net' }
  }));

  const socket = { ev: new EventEmitter() };
  const baileys = {
    default() { return socket; },
    DEFAULT_CONNECTION_CONFIG: { version: [2, 3000, 123] },
    DisconnectReason: { badSession: 500, loggedOut: 401 }
  };

  installBaileysReliability({
    baileys,
    authDirectory,
    logger: createLogger()
  });
  baileys.default({
    auth: {
      creds: {
        registered: true,
        me: { id: '5545981514596@s.whatsapp.net' }
      }
    }
  });
  socket.ev.emit('connection.update', {
    connection: 'close',
    lastDisconnect: {
      error: { output: { statusCode: 401 }, message: 'Connection Failure' }
    }
  });

  assert.equal(fs.existsSync(authDirectory), false);
  assert.equal(fs.readdirSync(parent).some((name) => name.startsWith('whatsapp-auth.reauth-')), true);
});
