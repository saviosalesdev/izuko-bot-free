const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const {
  filterUnauthorizedPrivateMessages,
  filterUnauthorizedMessages,
  guardCommand,
  installOwnerOnlyCommandGuard,
  isOwnerJid
} = require('../whatsapp-access-control');
const { toggleGroup } = require('../settings/lib/antiflood-config');
const {
  botJids,
  participantIsAdmin,
  recordLinkStrike,
  recordFloodMessage
} = require('../whatsapp-group-moderation');

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

test('only owner and own messages reach the bot handlers', () => {
  const upsert = {
    type: 'notify',
    messages: [
      { key: { remoteJid: '99999999999999@lid', fromMe: false } },
      { key: { remoteJid: ownerJid, fromMe: false }, message: { conversation: '&ping' } },
      { key: { remoteJid: ownerJid, fromMe: false }, message: { conversation: 'Oi, quero conversar' } },
      { key: { remoteJid: '123456789-123456@g.us', participant: '99999999999999@lid', fromMe: false } },
      { key: { remoteJid: '123456789-123456@g.us', participant: ownerJid, fromMe: false } },
      { key: { remoteJid: '123456789-123456@g.us', participant: '99999999999999@lid', fromMe: true } }
    ]
  };

  const filtered = filterUnauthorizedMessages(upsert, { ownerNumber: ownerJid, prefix: '&' });
  assert.equal(filtered.messages.length, 2);
  assert.equal(filtered.messages[0].key.remoteJid, ownerJid);
  assert.equal(filtered.messages[1].key.participant, ownerJid);
});

test('private messages from owner are accepted only when they are commands', () => {
  const upsert = {
    messages: [
      { key: { remoteJid: ownerJid, fromMe: false }, message: { conversation: 'mensagem normal' } },
      { key: { remoteJid: ownerJid, fromMe: false }, message: { conversation: '&ping' } },
      { key: { remoteJid: ownerJid, fromMe: false }, message: { extendedTextMessage: { text: '&menu' } } }
    ]
  };

  const filtered = filterUnauthorizedMessages(upsert, { ownerNumber: ownerJid, prefix: '&' });
  assert.equal(filtered.messages.length, 2);
  assert.equal(filtered.messages[0].message.conversation, '&ping');
});

test('untrusted group messages go to moderation only, not bot handlers', async () => {
  const events = new EventEmitter();
  const { attachPrivateMessageFilter } = require('../whatsapp-access-control');
  const moderated = [];
  attachPrivateMessageFilter({ ev: events }, {
    logger: { warn() {}, error() {} },
    onUnauthorizedGroupMessage(message) {
      moderated.push(message);
    }
  });
  const received = [];
  events.on('messages.upsert', ({ messages }) => {
    received.push(...messages);
  });
  events.emit('messages.upsert', {
    messages: [
      { key: { remoteJid: '99999999999999@lid', fromMe: false } },
      { key: { remoteJid: '123456789-123456@g.us', participant: '99999999999999@lid', fromMe: false } },
      { key: { remoteJid: '123456789-123456@g.us', participant: ownerJid, fromMe: false } }
    ]
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(received.length, 1);
  assert.equal(received[0].key.participant, ownerJid);
  assert.equal(moderated.length, 1);
  assert.equal(moderated[0].key.remoteJid, '123456789-123456@g.us');
});

test('legacy private-message filter alias also filters group messages', () => {
  const filtered = filterUnauthorizedPrivateMessages({
    messages: [{ key: { remoteJid: '123456789-123456@g.us', participant: '99999999999999@lid' } }]
  }, { ownerNumber: ownerJid });
  assert.equal(filtered.messages.length, 0);
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

test('antiflood times out on the tenth message within ten seconds', () => {
  const user = { timestamps: [], mutedUntil: 0 };
  for (let index = 0; index < 9; index += 1) {
    assert.equal(recordFloodMessage(user, index * 1_000).action, 'allow');
  }

  assert.deepEqual(recordFloodMessage(user, 9_000), {
    action: 'timeout',
    count: 10,
    timeoutSeconds: 20
  });
  assert.equal(user.mutedUntil, 29_000);
});

test('antiflood does not count messages spanning ten seconds and blocks during timeout', () => {
  const user = { timestamps: [], mutedUntil: 0 };
  for (let index = 0; index < 9; index += 1) {
    recordFloodMessage(user, index * 1_000);
  }

  assert.deepEqual(recordFloodMessage(user, 10_000), {
    action: 'allow',
    count: 9,
    timeoutSeconds: 0
  });

  const timeoutUser = { timestamps: [], mutedUntil: 30_000 };
  assert.deepEqual(recordFloodMessage(timeoutUser, 29_999), {
    action: 'timeout',
    count: 0,
    timeoutSeconds: 1
  });
  assert.deepEqual(recordFloodMessage(timeoutUser, 30_000), {
    action: 'allow',
    count: 1,
    timeoutSeconds: 0
  });
});

test('bot administrator detection accepts the configured LID and socket aliases', () => {
  const socket = {
    user: { id: '5511999999999@s.whatsapp.net', lid: '94158769410094@lid' },
    authState: { creds: { me: { id: '5511999999999:12@s.whatsapp.net' } } }
  };
  const settings = { botLid: '94158769410094@lid' };
  const participants = [{
    id: '5511999999999@s.whatsapp.net',
    lid: '94158769410094@lid',
    phoneNumber: '5511999999999@s.whatsapp.net',
    admin: 'admin'
  }];

  const identities = botJids(socket, settings);
  assert.equal(identities.includes(settings.botLid), true);
  assert.equal(identities.includes(socket.user.id), true);
  assert.equal(participantIsAdmin(participants, ...identities), true);
});

test('antiflood command reports activation and deactivation in the group', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'izuko-antiflood-command-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const commandPath = path.join(directory, 'antiflood.js');
  const configPath = path.join(__dirname, '..', 'banco de dados', 'antiflood_config.json');
  const originalConfig = fs.existsSync(configPath)
    ? fs.readFileSync(configPath, 'utf8')
    : null;
  t.after(() => {
    if (originalConfig === null) {
      fs.rmSync(configPath, { force: true });
    } else {
      fs.writeFileSync(configPath, originalConfig);
    }
  });
  fs.writeFileSync(commandPath, '');

  const antiflood = require('../commands/antiflood');
  const sent = [];
  const lux = { async sendMessage(jid, content) { sent.push({ jid, content }); } };
  const context = {
    lux,
    from: '123456789-123456@g.us',
    isGroup: true,
    sender: ownerJid
  };

  await antiflood.execute(context);
  await antiflood.execute(context);
  assert.match(sent[0].content.text, /ANTIFLOOD ATIVADO/);
  assert.match(sent[1].content.text, /ANTIFLOOD DESATIVADO/);
});

test('owner JID comparison strips Baileys device suffixes', () => {
  assert.equal(isOwnerJid(ownerJid.replace('@lid', ':9@lid')), true);
  assert.equal(isOwnerJid('99999999999999@lid', { ownerNumber: ownerJid }), false);
});
