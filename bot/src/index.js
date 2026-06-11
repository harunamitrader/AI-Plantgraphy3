'use strict';

const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { Client, Events, GatewayIntentBits } = require('discord.js');
const { loadConfig, PROJECT_ROOT } = require('./config');
const { runIdentifyWithRetry } = require('./agy-runner');
const { saveDiscordImageAttachments } = require('./attachment-store');
const { buildObservationId, buildPlantId, recordObservation, ensureLocalStore } = require('./data-store');
const { runEnrichWithRetry } = require('./enrich-runner');
const { persistObservationImages } = require('./image-pipeline');
const { publishEncryptedSite } = require('./publisher');
const { buildIdentifyReply, splitDiscordMessageText } = require('./reply-utils');

dotenv.config({ path: path.join(PROJECT_ROOT, '.env') });

class PlantIdentificationBot {
  constructor(config) {
    this.config = config;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.MessageContent
      ]
    });
    this.queue = [];
    this.processing = false;
    this.latestFailure = null;
    this.identifyReplyMap = new Map();
  }

  async start() {
    fs.mkdirSync(this.config.storage.incomingDir, { recursive: true });
    fs.mkdirSync(this.config.runner.debugDir, { recursive: true });
    ensureLocalStore(this.config.storage);

    this.client.once(Events.ClientReady, (client) => {
      console.log(`AI-Plantgraphy3 bot connected as ${client.user.tag}`);
    });

    this.client.on(Events.MessageCreate, (message) => {
      void this.handleMessage(message).catch((error) => {
        console.error('message handling failed', error);
      });
    });

    await this.client.login(this.config.discordBotToken);
  }

  async handleMessage(message) {
    if (message.author.bot) {
      return;
    }
    if (message.guildId !== this.config.allowGuildId) {
      return;
    }
    if (!this.config.allowUserIds.includes(message.author.id)) {
      return;
    }
    if (message.channelId !== this.config.plantChannelId) {
      return;
    }

    const commandHandled = await this.tryHandleCommand(message);
    if (commandHandled) {
      return;
    }

    const attachments = [...message.attachments.values()];
    if (attachments.length === 0) {
      await this.rejectMessage(message, '植物画像を1〜3枚添付してください。本文はメモとして扱います。');
      return;
    }

    await this.tryReact(message, '🔍');
    let savedBatch;
    try {
      savedBatch = await saveDiscordImageAttachments({
        attachments,
        messageId: message.id,
        incomingRootDir: this.config.storage.incomingDir,
        rules: this.config.attachments
      });
    } catch (error) {
      await this.rejectMessage(message, toErrorMessage(error));
      return;
    }

    this.queue.push({
      message,
      savedBatch,
      note: message.content.trim(),
      forcedIdentifyResult: null
    });
    if (!this.processing) {
      void this.processQueue();
    }
  }

  async processQueue() {
    if (this.processing) {
      return;
    }
    this.processing = true;

    while (this.queue.length > 0) {
      const job = this.queue.shift();
      if (!job) {
        continue;
      }

      let result;
      try {
        result = job.forcedIdentifyResult || await runIdentifyWithRetry({
          imagePaths: job.savedBatch.files.map((file) => file.absolutePath),
          note: job.note,
          timeoutMs: this.config.runner.timeoutMs,
          cols: this.config.runner.cols,
          rows: this.config.runner.rows,
          cwd: this.config.runner.cwd,
          debugDir: path.join(this.config.runner.debugDir, job.message.id)
        });
      } catch (error) {
        this.latestFailure = {
          job,
          reason: toErrorMessage(error),
          phase: 'identify'
        };
        await this.tryReact(job.message, '❌');
        await this.sendReply(job.message, `❌ 種類の特定に失敗しました。\n${toErrorMessage(error)}`);
        continue;
      }

      const replies = await this.sendReply(job.message, buildIdentifyReply(result));
      if (replies[0]) {
        this.identifyReplyMap.set(replies[0].id, {
          job,
          identifyResult: result
        });
      }
      await this.tryReact(job.message, '📝');

      try {
        await this.completeStageTwo(job, result);
        await this.tryReact(job.message, '✅');
        this.latestFailure = null;
      } catch (error) {
        // completeStageTwo already sent the user-facing failure reply.
      }
    }

    this.processing = false;
  }

  async completeStageTwo(job, identifyResult) {
    const observedAt = job.message.createdAt.toISOString();
    const observationId = buildObservationId(observedAt);
    const predictedPlantId = buildPlantId(identifyResult, observationId);
    const plantsPath = path.join(this.config.storage.dataDir, 'plants.json');
    const knownPlants = fs.existsSync(plantsPath) ? JSON.parse(fs.readFileSync(plantsPath, 'utf8')) : {};
    const isNewPlant = !knownPlants[predictedPlantId];

    try {
      const enrichResult = await runEnrichWithRetry({
        imagePaths: job.savedBatch.files.map((file) => file.absolutePath),
        identifyResult,
        note: job.note,
        observedAt,
        isNewPlant,
        timeoutMs: this.config.runner.timeoutMs,
        cols: this.config.runner.cols,
        rows: this.config.runner.rows,
        cwd: this.config.runner.cwd,
        debugDir: path.join(this.config.runner.debugDir, job.message.id, 'enrich')
      });

      const observationImages = await persistObservationImages({
        inputFiles: job.savedBatch.files,
        imagesDir: path.join(this.config.storage.dataDir, 'images'),
        observationId
      });

      const stored = recordObservation({
        storage: this.config.storage,
        identifyResult,
        enrichResult,
        observationImages,
        note: job.note,
        observedAt,
        observationId,
        plantId: predictedPlantId
      });

      publishEncryptedSite({
        projectRoot: this.config.projectRoot,
        storage: this.config.storage,
        site: this.config.site,
        sitePassword: process.env.SITE_PASSWORD
      });

      const detailUrl = `${this.config.site.publicUrl.replace(/\/?$/, '/')}#/plants/${stored.plantId}`;
      await this.sendReply(job.message, `✅ 図鑑を更新しました。\n${detailUrl}`);
    } catch (error) {
      this.latestFailure = {
        job,
        identifyResult,
        reason: toErrorMessage(error),
        phase: 'stage2'
      };
      await this.tryReact(job.message, '❌');
      await this.sendReply(job.message, `❌ 観察記録の生成または保存に失敗しました。\n${toErrorMessage(error)}`);
      throw error;
    }
  }

  async rejectMessage(message, text) {
    await this.tryReact(message, '❌');
    await this.sendReply(message, text);
  }

  async sendReply(message, text) {
    const chunks = splitDiscordMessageText(text, this.config.reply.maxMessageLength);
    const replies = [];
    for (const chunk of chunks) {
      const reply = await message.reply({
        content: chunk,
        allowedMentions: {
          repliedUser: false
        }
      });
      replies.push(reply);
    }
    return replies;
  }

  async tryReact(message, emoji) {
    try {
      await message.react(emoji);
    } catch (error) {
      console.warn(`failed to react with ${emoji}`, error);
    }
  }

  async tryHandleCommand(message) {
    const content = message.content.trim();
    if (!content.startsWith('!')) {
      return false;
    }

    if (content === '!status') {
      const metaPath = path.join(this.config.site.siteDir, 'meta.json');
      const meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, 'utf8')) : null;
      const lines = [
        `queue: ${this.queue.length}`,
        `processing: ${this.processing ? 'running' : 'idle'}`,
        `latest publish: ${meta?.publishedAt || 'none'}`
      ];
      await this.sendReply(message, lines.join('\n'));
      return true;
    }

    if (content === '!retry') {
      if (!this.latestFailure) {
        await this.sendReply(message, '再試行できる失敗ジョブはありません。');
        return true;
      }
      this.queue.push({
        ...this.latestFailure.job,
        message
      });
      await this.sendReply(message, `🔁 ${this.latestFailure.phase} を再試行キューに入れました。`);
      if (!this.processing) {
        void this.processQueue();
      }
      return true;
    }

    if (content.startsWith('!fix ')) {
      const correctedName = content.slice('!fix '.length).trim();
      if (!correctedName) {
        await this.sendReply(message, '使い方: `!fix アジサイ`');
        return true;
      }

      const referenceId = message.reference?.messageId;
      const target = referenceId ? this.identifyReplyMap.get(referenceId) : null;
      if (!target) {
        await this.sendReply(message, '対象の同定結果メッセージに返信して `!fix 植物名` を送ってください。');
        return true;
      }

      const forcedIdentifyResult = {
        ...target.identifyResult,
        common_name_ja: correctedName,
        scientific_name: null,
        confidence: 1,
        uncertainty_notes: 'Discord の !fix による手動訂正です。',
        candidates: [
          {
            common_name_ja: correctedName,
            scientific_name: null,
            confidence: 1,
            reason: 'Discord の !fix による手動訂正'
          }
        ]
      };
      this.queue.push({
        ...target.job,
        message,
        forcedIdentifyResult
      });
      await this.sendReply(message, `✏️ ${correctedName} として再生成します。`);
      if (!this.processing) {
        void this.processQueue();
      }
      return true;
    }

    return false;
  }
}

function toErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function main() {
  const config = loadConfig();
  const bot = new PlantIdentificationBot(config);
  await bot.start();
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  PlantIdentificationBot
};
