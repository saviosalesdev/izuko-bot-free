const fs = require('node:fs');

function readConfig(configPath) {
  if (!fs.existsSync(configPath)) {
    return { gruposAtivos: [] };
  }

  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  return {
    ...config,
    gruposAtivos: Array.isArray(config.gruposAtivos) ? config.gruposAtivos : []
  };
}

function toggleGroup(configPath, groupJid) {
  const config = readConfig(configPath);
  const isActive = config.gruposAtivos.includes(groupJid);
  config.gruposAtivos = isActive
    ? config.gruposAtivos.filter((jid) => jid !== groupJid)
    : [...config.gruposAtivos, groupJid];
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  return !isActive;
}

module.exports = { readConfig, toggleGroup };
