'use strict';

const fs = require('node:fs');
const path = require('node:path');
const pty = require('@lydell/node-pty');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_AGY_COMMAND = process.env.AGY_COMMAND || 'C:\\Users\\sgmxk\\AppData\\Local\\agy\\bin\\agy.exe';
const DEFAULT_TIMEOUT_MS = 45000;
const DEFAULT_COLS = 400;
const DEFAULT_ROWS = 120;
const IDENTIFY_PROMPT_PATH = path.join(__dirname, 'prompts', 'identify.md');
const CONTRACT_PATH = path.join(__dirname, 'contracts', 'identify-output-contract.json');

async function runIdentifyWithRetry(options) {
  const firstAttempt = await runIdentifyAttempt({
    ...options,
    promptText: buildIdentifyPrompt({
      imagePaths: options.imagePaths,
      note: options.note,
      promptBody: options.promptBody || readTextFile(options.promptFile || IDENTIFY_PROMPT_PATH)
    }),
    attempt: 1
  });

  try {
    return finalizeAttempt(firstAttempt);
  } catch (error) {
    const retryAttempt = await runIdentifyAttempt({
      ...options,
      promptText: buildIdentifyPrompt({
        imagePaths: options.imagePaths,
        note: options.note,
        promptBody: buildRetryPrompt({
          basePromptBody: options.promptBody || readTextFile(options.promptFile || IDENTIFY_PROMPT_PATH),
          failureMessage: error instanceof Error ? error.message : String(error || 'Unknown error')
        })
      }),
      attempt: 2
    });
    return finalizeAttempt(retryAttempt);
  }
}

async function runIdentifyAttempt(options) {
  const startedAt = Date.now();
  const ptyResult = await runAgyPrompt({
    ...options,
    acceptFromOutput: tryParseAcceptedPayloadFromOutput
  });
  const cleanedOutput = ptyResult.cleanedOutput || sanitizeTerminalOutput(ptyResult.output);
  if (options.debugDir) {
    persistAttemptDebug({
      debugDir: options.debugDir,
      attempt: options.attempt,
      rawOutput: ptyResult.output,
      cleanedOutput
    });
  }

  return {
    attempt: options.attempt,
    elapsedMs: Date.now() - startedAt,
    exitCode: ptyResult.exitCode,
    cleanedOutput,
    parsed: ptyResult.parsed || parseJsonOutput(cleanedOutput)
  };
}

function finalizeAttempt(attempt) {
  const normalized = normalizeIdentifyPayload(attempt.parsed);
  const violations = validateIdentifyPayload(normalized);
  if (attempt.exitCode !== 0) {
    throw new Error(`agy exited with code ${attempt.exitCode}`);
  }
  if (violations.length > 0) {
    throw new Error(`contract validation failed: ${violations.join('; ')}`);
  }
  return {
    ...normalized,
    _meta: {
      attempt: attempt.attempt,
      elapsed_ms: attempt.elapsedMs,
      elapsed_seconds: Number((attempt.elapsedMs / 1000).toFixed(1))
    }
  };
}

function buildIdentifyPrompt({ imagePaths, note, promptBody }) {
  const attachmentLines = imagePaths.map((imagePath) => `@${path.resolve(imagePath)}`);
  const sections = [attachmentLines.join('\n'), promptBody.trim()];
  const cleanedNote = cleanText(note);
  if (cleanedNote) {
    sections.push(`User note:\n${cleanedNote}`);
  }
  return `${sections.join('\n\n')}\n`;
}

function buildRetryPrompt({ basePromptBody, failureMessage }) {
  return `${basePromptBody.trim()}

Your previous response could not be accepted.
Fix it and return the contract exactly.
Failure reason:
${failureMessage}

Repeat: output exactly one JSON object only.`;
}

function runAgyPrompt(options) {
  const agyCommand = options.command || DEFAULT_AGY_COMMAND;
  const args = ['-p', options.promptText];
  if (options.model) {
    args.push('--model', options.model);
  }
  return new Promise((resolve, reject) => {
    let output = '';
    let settled = false;
    const term = pty.spawn(agyCommand, args, {
      name: 'xterm-256color',
      cols: options.cols || DEFAULT_COLS,
      rows: options.rows || DEFAULT_ROWS,
      cwd: options.cwd || PROJECT_ROOT,
      useConpty: true,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        TERM_PROGRAM: 'ai-plantgraphy3'
      }
    });

    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        term.kill();
      } catch (error) {
        // Best effort only; the timeout itself is the actionable error.
      }
      reject(new Error(`agy timed out after ${options.timeoutMs || DEFAULT_TIMEOUT_MS} ms`));
    }, options.timeoutMs || DEFAULT_TIMEOUT_MS);

    term.onData((chunk) => {
      output += chunk;
      if (settled) {
        return;
      }

      const accepted = typeof options.acceptFromOutput === 'function'
        ? options.acceptFromOutput(output)
        : null;
      if (!accepted) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      try {
        term.kill();
      } catch (error) {
        // The process may already be closing; the accepted payload is what matters now.
      }
      resolve({
        exitCode: 0,
        output,
        cleanedOutput: accepted.cleanedOutput,
        parsed: accepted.parsed
      });
    });

    term.onExit(({ exitCode }) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({ exitCode, output });
    });
  });
}

function tryParseAcceptedPayloadFromOutput(rawOutput) {
  const cleanedOutput = sanitizeTerminalOutput(rawOutput);
  if (!cleanedOutput.includes('}')) {
    return null;
  }

  try {
    const parsed = parseJsonOutput(cleanedOutput);
    const normalized = normalizeIdentifyPayload(parsed);
    const violations = validateIdentifyPayload(normalized);
    if (violations.length > 0) {
      return null;
    }
    return {
      cleanedOutput,
      parsed
    };
  } catch (error) {
    return null;
  }
}

function sanitizeTerminalOutput(output) {
  return String(output || '')
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, '')
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '')
    .replace(/[^\S\r\n]+\n/g, '\n')
    .replace(/\r/g, '')
    .replace(/[^\P{C}\n\t]/gu, '')
    .replace(/\u0008/g, '')
    .trim();
}

function parseJsonOutput(output) {
  const text = String(output || '').trim();
  if (!text) {
    throw new Error('agy returned empty output');
  }

  const fenced = extractFencedJson(text);
  if (fenced) {
    return JSON.parse(fenced);
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    const candidate = extractFirstJsonObject(text);
    if (!candidate) {
      throw new Error('no JSON object found in agy output');
    }
    return JSON.parse(candidate);
  }
}

function extractFencedJson(text) {
  const marker = '```json';
  const start = text.indexOf(marker);
  if (start === -1) {
    return null;
  }
  const contentStart = start + marker.length;
  const end = text.indexOf('```', contentStart);
  if (end === -1) {
    return null;
  }
  return text.slice(contentStart, end).trim();
}

function extractFirstJsonObject(text) {
  const start = text.indexOf('{');
  if (start === -1) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }
  return null;
}

function normalizeIdentifyPayload(payload) {
  const normalized = payload && typeof payload === 'object' && !Array.isArray(payload) ? { ...payload } : {};
  normalized.common_name_ja = normalizeNullableText(normalized.common_name_ja);
  normalized.scientific_name = normalizeNullableText(normalized.scientific_name);
  normalized.confidence = normalizeConfidence(normalized.confidence);
  normalized.candidates = normalizeCandidates(normalized.candidates);
  normalized.visible_features = normalizeVisibleFeatures(normalized.visible_features);
  normalized.uncertainty_notes = truncateText(cleanText(normalized.uncertainty_notes), readContract().limits.uncertaintyNotesMax);
  return normalized;
}

function validateIdentifyPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return ['top-level object required'];
  }

  const contract = readContract();
  const actualKeys = Object.keys(payload);
  const missingKeys = contract.keys.filter((key) => !actualKeys.includes(key));
  const extraKeys = actualKeys.filter((key) => !contract.keys.includes(key) && key !== '_meta');
  const violations = [];

  if (missingKeys.length > 0) {
    violations.push(`missing keys: ${missingKeys.join(', ')}`);
  }
  if (extraKeys.length > 0) {
    violations.push(`extra keys: ${extraKeys.join(', ')}`);
  }
  if (payload.common_name_ja !== null && typeof payload.common_name_ja !== 'string') {
    violations.push('common_name_ja must be string or null');
  }
  if (payload.scientific_name !== null && typeof payload.scientific_name !== 'string') {
    violations.push('scientific_name must be string or null');
  }
  if (typeof payload.confidence !== 'number' || Number.isNaN(payload.confidence) || payload.confidence < 0 || payload.confidence > 1) {
    violations.push('confidence must be a number from 0.0 to 1.0');
  }
  if (!Array.isArray(payload.candidates)) {
    violations.push('candidates must be an array');
  } else {
    if (payload.candidates.length > contract.limits.candidatesMax) {
      violations.push(`candidates must contain at most ${contract.limits.candidatesMax} items`);
    }
    payload.candidates.forEach((candidate, index) => {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
        violations.push(`candidates[${index}] must be an object`);
        return;
      }
      const candidateKeys = Object.keys(candidate);
      const missingCandidateKeys = contract.candidateKeys.filter((key) => !candidateKeys.includes(key));
      const extraCandidateKeys = candidateKeys.filter((key) => !contract.candidateKeys.includes(key));
      if (missingCandidateKeys.length > 0) {
        violations.push(`candidates[${index}] missing keys: ${missingCandidateKeys.join(', ')}`);
      }
      if (extraCandidateKeys.length > 0) {
        violations.push(`candidates[${index}] extra keys: ${extraCandidateKeys.join(', ')}`);
      }
      if (candidate.common_name_ja !== null && typeof candidate.common_name_ja !== 'string') {
        violations.push(`candidates[${index}].common_name_ja must be string or null`);
      }
      if (candidate.scientific_name !== null && typeof candidate.scientific_name !== 'string') {
        violations.push(`candidates[${index}].scientific_name must be string or null`);
      }
      if (typeof candidate.confidence !== 'number' || Number.isNaN(candidate.confidence) || candidate.confidence < 0 || candidate.confidence > 1) {
        violations.push(`candidates[${index}].confidence must be a number from 0.0 to 1.0`);
      }
      if (typeof candidate.reason !== 'string' || candidate.reason.length > contract.limits.candidateReasonMax) {
        violations.push(`candidates[${index}].reason must be a string up to ${contract.limits.candidateReasonMax} chars`);
      }
    });
  }

  if (!Array.isArray(payload.visible_features)) {
    violations.push('visible_features must be an array');
  } else {
    if (payload.visible_features.length > contract.limits.visibleFeaturesMax) {
      violations.push(`visible_features must contain at most ${contract.limits.visibleFeaturesMax} items`);
    }
    payload.visible_features.forEach((item, index) => {
      if (typeof item !== 'string' || item.length > contract.limits.visibleFeatureMax) {
        violations.push(`visible_features[${index}] must be a string up to ${contract.limits.visibleFeatureMax} chars`);
      }
    });
  }

  if (typeof payload.uncertainty_notes !== 'string' || payload.uncertainty_notes.length > contract.limits.uncertaintyNotesMax) {
    violations.push(`uncertainty_notes must be a string up to ${contract.limits.uncertaintyNotesMax} chars`);
  }

  return violations;
}

function normalizeCandidates(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  const contract = readContract();
  const normalized = value
    .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
    .slice(0, contract.limits.candidatesMax)
    .map((item) => ({
      common_name_ja: normalizeNullableText(item.common_name_ja),
      scientific_name: normalizeNullableText(item.scientific_name),
      confidence: normalizeConfidence(item.confidence),
      reason: truncateText(cleanText(item.reason), contract.limits.candidateReasonMax)
    }));

  normalizeCandidateConfidenceSum(normalized);
  return normalized;
}

function normalizeVisibleFeatures(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  const contract = readContract();
  const seen = new Set();
  const normalized = [];
  for (const item of value) {
    const cleaned = truncateText(cleanText(item), contract.limits.visibleFeatureMax);
    if (!cleaned) {
      continue;
    }
    if (seen.has(cleaned)) {
      continue;
    }
    seen.add(cleaned);
    normalized.push(cleaned);
    if (normalized.length >= contract.limits.visibleFeaturesMax) {
      break;
    }
  }
  return normalized;
}

function normalizeCandidateConfidenceSum(candidates) {
  const total = candidates.reduce((sum, item) => sum + item.confidence, 0);
  if (total <= 1 || total === 0) {
    return;
  }
  for (const candidate of candidates) {
    candidate.confidence = Number((candidate.confidence / total).toFixed(6));
  }
}

function normalizeConfidence(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return clampConfidence(value);
  }
  if (typeof value === 'string') {
    const text = value.trim().replace(/%$/, '');
    if (!text) {
      return 0;
    }
    const numeric = Number(text);
    if (Number.isFinite(numeric)) {
      return clampConfidence(numeric);
    }
  }
  return 0;
}

function clampConfidence(value) {
  const ratio = value > 1 ? value / 100 : value;
  return Math.max(0, Math.min(1, Number(ratio)));
}

function normalizeNullableText(value) {
  const cleaned = cleanText(value);
  return cleaned ? cleaned : null;
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

function persistAttemptDebug({ debugDir, attempt, rawOutput, cleanedOutput }) {
  fs.mkdirSync(debugDir, { recursive: true });
  fs.writeFileSync(path.join(debugDir, `attempt-${attempt}-raw.txt`), rawOutput, 'utf8');
  fs.writeFileSync(path.join(debugDir, `attempt-${attempt}-clean.txt`), cleanedOutput, 'utf8');
}

function readTextFile(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

let cachedContract = null;
function readContract() {
  if (!cachedContract) {
    cachedContract = JSON.parse(readTextFile(CONTRACT_PATH));
  }
  return cachedContract;
}

function parseArgs(argv) {
  const options = {
    imagePaths: [],
    promptFile: IDENTIFY_PROMPT_PATH,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
    cwd: PROJECT_ROOT,
    debugDir: null,
    jsonOnly: false,
    note: '',
    model: ''
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    switch (token) {
      case '--image':
        options.imagePaths.push(requireValue(argv, ++index, '--image'));
        break;
      case '--prompt-file':
        options.promptFile = requireValue(argv, ++index, '--prompt-file');
        break;
      case '--timeout-ms':
        options.timeoutMs = Number(requireValue(argv, ++index, '--timeout-ms'));
        break;
      case '--cols':
        options.cols = Number(requireValue(argv, ++index, '--cols'));
        break;
      case '--rows':
        options.rows = Number(requireValue(argv, ++index, '--rows'));
        break;
      case '--cwd':
        options.cwd = requireValue(argv, ++index, '--cwd');
        break;
      case '--debug-dir':
        options.debugDir = requireValue(argv, ++index, '--debug-dir');
        break;
      case '--note':
        options.note = requireValue(argv, ++index, '--note');
        break;
      case '--model':
        options.model = requireValue(argv, ++index, '--model');
        break;
      case '--json-only':
        options.jsonOnly = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${token}`);
    }
  }

  return options;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function validateCliOptions(options) {
  if (options.help) {
    return;
  }
  if (options.imagePaths.length < 1 || options.imagePaths.length > 3) {
    throw new Error('Pass 1 to 3 --image arguments.');
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error('--timeout-ms must be a positive number.');
  }
  if (!Number.isFinite(options.cols) || options.cols < 40) {
    throw new Error('--cols must be 40 or greater.');
  }
  if (!Number.isFinite(options.rows) || options.rows < 20) {
    throw new Error('--rows must be 20 or greater.');
  }
  for (const imagePath of options.imagePaths) {
    const resolved = path.resolve(imagePath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Image not found: ${resolved}`);
    }
  }
}

function printHelp() {
  process.stdout.write(`Usage:
  node .\\src\\agy-runner.js --image <path> [--image <path2> --image <path3>] [options]

Options:
  --image <path>       Absolute or relative path to a plant image (repeat 1-3 times)
  --note <text>        Optional user memo appended to the prompt
  --model <name>       Optional agy model override
  --timeout-ms <ms>    Kill agy if it exceeds this duration (default: ${DEFAULT_TIMEOUT_MS})
  --cols <n>           PTY width (default: ${DEFAULT_COLS})
  --rows <n>           PTY height (default: ${DEFAULT_ROWS})
  --cwd <path>         Working directory for the agy process
  --prompt-file <path> Alternate identify prompt markdown file
  --debug-dir <path>   Save raw and cleaned PTY output for each attempt
  --json-only          Print only the final JSON payload
  --help               Show this help
`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  validateCliOptions(options);
  const result = await runIdentifyWithRetry(options);
  if (options.jsonOnly) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exit(0);
  }

  process.stdout.write(`identify succeeded in ${result._meta.elapsed_seconds}s (attempt ${result._meta.attempt})\n`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(0);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}

module.exports = {
  buildIdentifyPrompt,
  normalizeIdentifyPayload,
  parseJsonOutput,
  runAgyPrompt,
  runIdentifyAttempt,
  runIdentifyWithRetry,
  sanitizeTerminalOutput,
  tryParseAcceptedPayloadFromOutput,
  validateIdentifyPayload
};
