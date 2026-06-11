'use strict';

const path = require('node:path');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

function loadConfig() {
  const allowUserIds = parseList(process.env.ALLOW_USER_IDS);
  const allowGuildId = readRequired('ALLOW_GUILD_ID');
  const plantChannelId = readRequired('PLANT_CHANNEL_ID');
  const discordBotToken = readRequired('DISCORD_BOT_TOKEN');

  return {
    projectRoot: PROJECT_ROOT,
    discordBotToken,
    allowUserIds,
    allowGuildId,
    plantChannelId,
    reply: {
      maxMessageLength: 1900
    },
    attachments: {
      maxFilesPerMessage: 3,
      maxTotalBytes: 10 * 1024 * 1024,
      downloadTimeoutMs: 30000,
      allowedContentTypes: new Set([
        'image/jpeg',
        'image/png',
        'image/webp',
        'image/heic',
        'image/heif'
      ]),
      allowedExtensions: new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif'])
    },
    runner: {
      timeoutMs: 45000,
      cols: 400,
      rows: 120,
      cwd: PROJECT_ROOT,
      debugDir: path.join(PROJECT_ROOT, 'bot', 'debug', 'stage1')
    },
    storage: {
      dataDir: path.join(PROJECT_ROOT, 'data'),
      incomingDir: path.join(PROJECT_ROOT, 'data', 'incoming')
    },
    site: {
      siteDir: path.join(PROJECT_ROOT, 'site'),
      publicUrl: process.env.SITE_PUBLIC_URL?.trim() || 'https://harunamitrader.github.io/AI-Plantgraphy3/',
      gitPush: /^true$/i.test(process.env.SITE_GIT_PUSH || 'false')
    }
  };
}

function parseList(value) {
  if (!value || !value.trim()) {
    throw new Error('ALLOW_USER_IDS is required.');
  }
  return [...new Set(value.split(/[,\s]+/).map((part) => part.trim()).filter(Boolean))];
}

function readRequired(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

module.exports = {
  PROJECT_ROOT,
  loadConfig
};
