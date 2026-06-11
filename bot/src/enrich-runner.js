'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseJsonOutput, runAgyPrompt, sanitizeTerminalOutput } = require('./agy-runner');

const ENRICH_PROMPT_PATH = path.join(__dirname, 'prompts', 'enrich.md');

async function runEnrichWithRetry(options) {
  const first = await runEnrichAttempt({
    ...options,
    promptText: buildEnrichPrompt(options)
  });

  try {
    return finalizeEnrich(first, options.isNewPlant);
  } catch (error) {
    const retried = await runEnrichAttempt({
      ...options,
      promptText: buildEnrichPrompt({
        ...options,
        retryReason: error instanceof Error ? error.message : String(error || 'Unknown error')
      })
    });
    return finalizeEnrich(retried, options.isNewPlant);
  }
}

async function runEnrichAttempt(options) {
  const startedAt = Date.now();
  const ptyResult = await runAgyPrompt(options);
  const cleanedOutput = ptyResult.cleanedOutput || sanitizeTerminalOutput(ptyResult.output);
  if (options.debugDir) {
    fs.mkdirSync(options.debugDir, { recursive: true });
    fs.writeFileSync(path.join(options.debugDir, 'enrich-clean.txt'), cleanedOutput, 'utf8');
  }
  return {
    elapsedMs: Date.now() - startedAt,
    exitCode: ptyResult.exitCode,
    parsed: parseJsonOutput(cleanedOutput)
  };
}

function buildEnrichPrompt(options) {
  const basePrompt = fs.readFileSync(options.promptFile || ENRICH_PROMPT_PATH, 'utf8').trim();
  const payload = {
    observed_at: options.observedAt,
    user_memo: options.note || '',
    is_new_plant: Boolean(options.isNewPlant),
    identification: {
      common_name_ja: options.identifyResult.common_name_ja,
      scientific_name: options.identifyResult.scientific_name,
      confidence: options.identifyResult.confidence,
      candidates: options.identifyResult.candidates,
      visible_features: options.identifyResult.visible_features,
      uncertainty_notes: options.identifyResult.uncertainty_notes
    }
  };
  const attachmentLines = options.imagePaths.map((imagePath) => `@${path.resolve(imagePath)}`);
  const sections = [
    attachmentLines.join('\n'),
    basePrompt,
    '入力データ:',
    JSON.stringify(payload, null, 2)
  ];
  if (options.retryReason) {
    sections.push(`前回エラー:\n${options.retryReason}`);
  }
  return `${sections.join('\n\n')}\n`;
}

function finalizeEnrich(attempt, isNewPlant) {
  if (attempt.exitCode !== 0) {
    throw new Error(`agy exited with code ${attempt.exitCode}`);
  }
  const normalized = normalizeEnrichPayload(attempt.parsed, isNewPlant);
  const violations = validateEnrichPayload(normalized, isNewPlant);
  if (violations.length > 0) {
    throw new Error(`enrich validation failed: ${violations.join('; ')}`);
  }
  return {
    ...normalized,
    _meta: {
      elapsed_ms: attempt.elapsedMs,
      elapsed_seconds: Number((attempt.elapsedMs / 1000).toFixed(1))
    }
  };
}

function normalizeEnrichPayload(payload, isNewPlant) {
  const normalized = payload && typeof payload === 'object' && !Array.isArray(payload) ? { ...payload } : {};
  normalized.observation_text = truncateText(cleanText(normalized.observation_text), 150);
  normalized.basic_profile_text = isNewPlant ? truncateText(cleanText(normalized.basic_profile_text), 120) : '';
  normalized.visual_appeal_text = isNewPlant ? truncateText(cleanText(normalized.visual_appeal_text), 120) : '';
  normalized.care_notes = isNewPlant ? truncateText(cleanText(normalized.care_notes), 120) : '';
  return normalized;
}

function validateEnrichPayload(payload, isNewPlant) {
  const expected = ['observation_text', 'basic_profile_text', 'visual_appeal_text', 'care_notes'];
  const actual = Object.keys(payload);
  const violations = [];
  const missing = expected.filter((key) => !actual.includes(key));
  const extra = actual.filter((key) => !expected.includes(key) && key !== '_meta');
  if (missing.length > 0) {
    violations.push(`missing keys: ${missing.join(', ')}`);
  }
  if (extra.length > 0) {
    violations.push(`extra keys: ${extra.join(', ')}`);
  }
  if (!payload.observation_text) {
    violations.push('observation_text is required');
  }
  if (payload.observation_text.length > 150) {
    violations.push('observation_text must be 150 chars or less');
  }
  for (const key of ['basic_profile_text', 'visual_appeal_text', 'care_notes']) {
    if (typeof payload[key] !== 'string') {
      violations.push(`${key} must be a string`);
      continue;
    }
    if (payload[key].length > 120) {
      violations.push(`${key} must be 120 chars or less`);
    }
    if (isNewPlant && !payload[key]) {
      violations.push(`${key} is required for a new plant`);
    }
  }
  return violations;
}

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function truncateText(value, maxLength) {
  if (!value) {
    return '';
  }
  return value.length > maxLength ? `${value.slice(0, maxLength - 1).trimEnd()}…` : value;
}

module.exports = {
  buildEnrichPrompt,
  runEnrichWithRetry
};
