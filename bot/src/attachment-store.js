'use strict';

const fs = require('node:fs');
const path = require('node:path');

async function saveDiscordImageAttachments({ attachments, messageId, incomingRootDir, rules }) {
  validateAttachmentBatch(attachments, rules);
  const directory = path.join(incomingRootDir, `msg-${messageId}`);
  const files = [];
  let totalBytes = 0;

  fs.mkdirSync(directory, { recursive: true });

  try {
    const downloaded = await Promise.all(
      attachments.map(async (attachment, index) => {
        validateAttachmentType(attachment, rules);
        const buffer = await downloadAttachment(attachment.url, rules.downloadTimeoutMs);
        return { attachment, index, buffer };
      })
    );

    totalBytes = downloaded.reduce((sum, item) => sum + item.buffer.byteLength, 0);
    if (totalBytes > rules.maxTotalBytes) {
      throw new Error(`画像合計サイズは ${formatMegabytes(rules.maxTotalBytes)}MB までです。`);
    }

    for (const item of downloaded.sort((left, right) => left.index - right.index)) {
      const originalName = normalizeOriginalName(item.attachment.name, item.index);
      const savedName = buildSavedFilename(item.index, originalName);
      const absolutePath = path.join(directory, savedName);
      fs.writeFileSync(absolutePath, item.buffer);

      files.push({
        index: item.index + 1,
        originalName,
        savedName,
        absolutePath,
        sizeBytes: item.buffer.byteLength,
        contentType: item.attachment.contentType || null,
        url: item.attachment.url
      });
    }

    const manifestPath = path.join(directory, 'attachments.json');
    const manifest = {
      messageId,
      savedAt: new Date().toISOString(),
      directory,
      count: files.length,
      totalBytes,
      files
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    return {
      directory,
      manifestPath,
      count: files.length,
      totalBytes,
      files
    };
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function validateAttachmentBatch(attachments, rules) {
  if (!attachments.length) {
    throw new Error('画像を1〜3枚添付してください。');
  }
  if (attachments.length > rules.maxFilesPerMessage) {
    throw new Error(`画像は1メッセージにつき最大${rules.maxFilesPerMessage}枚です。`);
  }
  const totalBytes = attachments.reduce((sum, attachment) => sum + Math.max(0, attachment.size || 0), 0);
  if (totalBytes > rules.maxTotalBytes) {
    throw new Error(`画像合計サイズは ${formatMegabytes(rules.maxTotalBytes)}MB までです。`);
  }
}

function validateAttachmentType(attachment, rules) {
  const extension = path.extname(attachment.name || '').toLowerCase();
  const contentType = String(attachment.contentType || '').toLowerCase();
  const extensionAllowed = rules.allowedExtensions.has(extension);
  const contentTypeAllowed = contentType.length > 0 && rules.allowedContentTypes.has(contentType);
  if (!extensionAllowed && !contentTypeAllowed) {
    throw new Error(`非対応の画像形式です: ${attachment.name || 'unknown file'}`);
  }
}

async function downloadAttachment(url, timeoutMs) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) {
    throw new Error(`画像ダウンロードに失敗しました: ${response.status} ${response.statusText}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength === 0) {
    throw new Error('ダウンロードした画像が空でした。');
  }
  return buffer;
}

function buildSavedFilename(index, originalName) {
  return `${String(index + 1).padStart(3, '0')}-${sanitizeFilename(originalName)}`;
}

function normalizeOriginalName(name, index) {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  return trimmed || `image-${index + 1}`;
}

function sanitizeFilename(value) {
  const basename = path.basename(value);
  const replaced = basename
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
    .slice(0, 120);
  return replaced || 'image';
}

function formatMegabytes(bytes) {
  return Math.round((bytes / (1024 * 1024)) * 10) / 10;
}

module.exports = {
  saveDiscordImageAttachments
};
