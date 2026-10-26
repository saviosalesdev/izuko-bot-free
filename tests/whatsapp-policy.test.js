const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const {
  filterUnauthorizedPrivateMessages,
  guardCommand,
  installOwnerOnlyCommandGuard,
  isOwnerJid
} = require('../whatsapp-access-control');
const { toggleGroup } = require('../settings/lib/antiflood-config');
const { recordLinkStrike } = require('../whatsapp-group-moderation');

const ownerJid = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'settings', 'settings.json'),
  'utf8'
)).ownerNumber;

test('only the configured owner can invoke a command', async () => {
  let executions = 0;
  const command = guardCommand({
    name: 'test-command',
    async execute() {
      executions += 1;
    }
  }, { warn() {} });

  await command.execute({ sender: '99999999999999@lid', settings: { ownerNumber: ownerJid } });
  await command.execute({ isOwner: true, settings: { ownerNumber: ownerJid } });
  await command.execute({ sender: ownerJid.replace('@lid', ':12@lid'), settings: { ownerNumber: ownerJid } });
  assert.equal(executions, 1);
});

test('owner-only guard is applied when command modules are loaded', async () => {
  installOwnerOnlyCommandGuard({ logger: { warn() {} } });
  const command = require('../commands/ping.js');
  const result = await command.execute({
    sender: '99999999999999@lid',
    settings: { ownerNumber: ownerJid }
  });
  assert.equal(result, undefined);
});

test('private messages from non-owners are filtered while groups remain available for moderation', () => {
  const upsert = {
    type: 'notify',
    messages: [
      { key: { remoteJid: '99999999999999@lid', fromMe: false } },
      { key: { remoteJid: ownerJid, fromMe: false } },
      { key: { remoteJid: '123456789-123456@g.us', participant: '99999999999999@lid', fromMe: false } }
    ]
  };

  const filtered = filterUnauthorizedPrivateMessages(upsert, { ownerNumber: ownerJid });
  assert.equal(filtered.messages.length, 2);
  assert.equal(filtered.messages[0].key.remoteJid, ownerJid);
  assert.equal(filtered.messages[1].key.remoteJid, '123456789-123456@g.us');
});

test('the private-message filter is installed before downstream event listeners', () => {
  const events = new EventEmitter();
  const { attachPrivateMessageFilter } = require('../whatsapp-access-control');
  attachPrivateMessageFilter({ ev: events }, { logger: { warn() {} } });
  let received = 0;
  events.on('messages.upsert', ({ messages }) => {
    received += messages.length;
  });
  events.emit('messages.upsert', {
    messages: [{ key: { remoteJid: '99999999999999@lid', fromMe: false } }]
  });
  assert.equal(received, 0);
});

test('antiflood toggling initializes and repairs a missing gruposAtivos array', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'izuko-antiflood-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, 'antiflood_config.json');
  fs.writeFileSync(configPath, '{}');

  assert.equal(toggleGroup(configPath, '123@g.us'), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), {
    gruposAtivos: ['123@g.us']
  });
  assert.equal(toggleGroup(configPath, '123@g.us'), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), {
    gruposAtivos: []
  });
});

test('anti-link escalation applies 10s, 20s, then removal within two minutes', () => {
  const user = { strikes: [], mutedUntil: 0 };
  assert.deepEqual(recordLinkStrike(user, 1_000), {
    action: 'timeout',
    strikes: 1,
    timeoutSeconds: 10
  });
  assert.deepEqual(recordLinkStrike(user, 20_000), {
    action: 'timeout',
    strikes: 2,
    timeoutSeconds: 20
  });
  assert.deepEqual(recordLinkStrike(user, 120_000), {
    action: 'remove',
    strikes: 3,
    timeoutSeconds: 0
  });
});

test('anti-link strikes older than two minutes no longer count toward removal', () => {
  const user = { strikes: [], mutedUntil: 0 };
  recordLinkStrike(user, 1_000);
  recordLinkStrike(user, 20_000);

  assert.deepEqual(recordLinkStrike(user, 141_000), {
    action: 'timeout',
    strikes: 1,
    timeoutSeconds: 10
  });
  assert.deepEqual(user.strikes, [141_000]);
});

test('owner JID comparison strips Baileys device suffixes', () => {
  assert.equal(isOwnerJid(ownerJid.replace('@lid', ':9@lid')), true);
  assert.equal(isOwnerJid('99999999999999@lid', { ownerNumber: ownerJid }), false);
});
