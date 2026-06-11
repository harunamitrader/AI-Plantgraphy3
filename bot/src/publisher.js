'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const KEY_CHECK_PLAINTEXT = 'AI-Plantgraphy3 key check';
const PBKDF2_ITERATIONS = 600000;
const KEY_LENGTH = 32;

function publishEncryptedSite({ projectRoot, storage, site, sitePassword }) {
  if (!sitePassword) {
    throw new Error('SITE_PASSWORD is required for encrypted publish.');
  }

  const plants = readJsonObject(path.join(storage.dataDir, 'plants.json'));
  const observations = readJsonObject(path.join(storage.dataDir, 'observations.json'));
  const imagesDir = path.join(storage.dataDir, 'images');

  const meta = loadOrCreateMeta(site.siteDir, site.publicUrl);
  const key = crypto.pbkdf2Sync(sitePassword, Buffer.from(meta.salt, 'base64'), PBKDF2_ITERATIONS, KEY_LENGTH, 'sha256');
  const siteDataDir = path.join(site.siteDir, 'data');
  const siteImagesDir = path.join(site.siteDir, 'images');
  fs.mkdirSync(siteDataDir, { recursive: true });
  fs.mkdirSync(siteImagesDir, { recursive: true });
  clearDirectory(siteDataDir);
  clearDirectory(siteImagesDir);

  writeEncryptedJson(path.join(siteDataDir, 'plants.json.enc'), plants, key);
  writeEncryptedJson(path.join(siteDataDir, 'observations.json.enc'), observations, key);
  writeEncryptedBuffer(path.join(site.siteDir, 'check.enc'), Buffer.from(KEY_CHECK_PLAINTEXT, 'utf8'), key);

  for (const imageName of listFiles(imagesDir)) {
    writeEncryptedBuffer(
      path.join(siteImagesDir, `${imageName}.enc`),
      fs.readFileSync(path.join(imagesDir, imageName)),
      key
    );
  }

  const nextMeta = {
    ...meta,
    publicUrl: site.publicUrl,
    iterations: PBKDF2_ITERATIONS,
    keyLength: KEY_LENGTH,
    publishedAt: new Date().toISOString(),
    plantCount: Object.keys(plants).length,
    observationCount: Object.keys(observations).length
  };
  fs.writeFileSync(path.join(site.siteDir, 'meta.json'), `${JSON.stringify(nextMeta, null, 2)}\n`, 'utf8');

  let git = { committed: false, pushed: false };
  if (site.gitPush) {
    git = publishSiteGit(projectRoot);
  }

  return {
    meta: nextMeta,
    git
  };
}

function loadOrCreateMeta(siteDir, publicUrl) {
  const metaPath = path.join(siteDir, 'meta.json');
  if (fs.existsSync(metaPath)) {
    const current = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    if (current && current.salt) {
      return current;
    }
  }
  return {
    salt: crypto.randomBytes(16).toString('base64'),
    publicUrl,
    iterations: PBKDF2_ITERATIONS,
    keyLength: KEY_LENGTH,
    publishedAt: null,
    plantCount: 0,
    observationCount: 0
  };
}

function writeEncryptedJson(filePath, value, key) {
  writeEncryptedBuffer(filePath, Buffer.from(JSON.stringify(value), 'utf8'), key);
}

function writeEncryptedBuffer(filePath, buffer, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
  const envelope = {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: encrypted.toString('base64')
  };
  fs.writeFileSync(filePath, `${JSON.stringify(envelope)}\n`, 'utf8');
}

function publishSiteGit(projectRoot) {
  runGit(projectRoot, ['add', 'site']);
  const status = runGit(projectRoot, ['status', '--porcelain', '--', 'site']);
  if (!status.stdout.trim()) {
    return { committed: false, pushed: false };
  }
  runGit(projectRoot, ['commit', '-m', 'Update encrypted plant site']);
  runGit(projectRoot, ['push']);
  return { committed: true, pushed: true };
}

function runGit(cwd, args) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `git ${args.join(' ')} failed`).trim());
  }
  return result;
}

function clearDirectory(directory) {
  if (!fs.existsSync(directory)) {
    return;
  }
  for (const name of fs.readdirSync(directory)) {
    fs.rmSync(path.join(directory, name), { recursive: true, force: true });
  }
}

function listFiles(directory) {
  if (!fs.existsSync(directory)) {
    return [];
  }
  return fs.readdirSync(directory).filter((name) => fs.statSync(path.join(directory, name)).isFile());
}

function readJsonObject(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

module.exports = {
  publishEncryptedSite
};
