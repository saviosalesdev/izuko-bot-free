const path = require('node:path');
const { toggleGroup } = require('../settings/lib/antiflood-config');

const configPath = path.join(__dirname, '..', 'banco de dados', 'antiflood_config.json');

module.exports = {
  name: 'antiflood',
  aliases: ['anti-flood'],
  async execute({ lux, from, msg, isGroup }) {
    if (!isGroup) {
      await lux.sendMessage(from, {
        text: 'Este comando só pode ser usado em grupos.'
      }, { quoted: msg });
      return;
    }

    const enabled = toggleGroup(configPath, from);
    const status = enabled ? 'ativado' : 'desativado';
    await lux.sendMessage(from, {
      text: `Antiflood ${status} neste grupo.`
    }, { quoted: msg });
  }
};
