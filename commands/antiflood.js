const path = require('node:path');
const { toggleGroup } = require('../settings/lib/antiflood-config');

const configPath = path.join(__dirname, '..', 'banco de dados', 'antiflood_config.json');

module.exports = {
  name: 'antiflood',
  aliases: ['anti-flood', 'anti flood'],
  async execute(context = {}) {
    const lux = context.lux || context.sock || context.socket;
    const from = context.from || context.remoteJid || context.msg?.key?.remoteJid;
    const msg = context.msg || context.message;
    const isGroup = context.isGroup ?? String(from || '').endsWith('@g.us');

    if (!lux || typeof lux.sendMessage !== 'function') {
      throw new Error('Socket WhatsApp indisponível ao executar &antiflood.');
    }

    if (!isGroup || !String(from || '').endsWith('@g.us')) {
      await lux.sendMessage(from, {
        text: 'Este comando só pode ser usado em grupos.'
      }, { quoted: msg });
      return;
    }

    const enabled = toggleGroup(configPath, from);
    const text = enabled
      ? '✅ ANTIFLOOD ATIVADO — 10 mensagens em 10 segundos acionam a remoção por 20 segundos.'
      : '❌ ANTIFLOOD DESATIVADO — a proteção contra flood deste grupo foi encerrada.';

    await lux.sendMessage(from, { text }, { quoted: msg });
  }
};
