'use strict';

function buildIdentifyReply(result) {
  const commonName = result.common_name_ja || '種類不明';
  const scientificName = result.scientific_name ? ` (*${result.scientific_name}*)` : '';
  const confidenceText = `${Math.round((Number(result.confidence) || 0) * 100)}%`;

  const lines = [`🌿 **${commonName}**${scientificName} 確度 ${confidenceText}`];

  if (Array.isArray(result.candidates) && result.candidates.length > 1) {
    const alternatives = result.candidates
      .slice(1)
      .map((item) => `${item.common_name_ja || '不明'} ${Math.round((Number(item.confidence) || 0) * 100)}%`);
    if (alternatives.length > 0) {
      lines.push(`候補: ${alternatives.join(' / ')}`);
    }
  }

  if (Array.isArray(result.visible_features) && result.visible_features.length > 0) {
    lines.push('特徴:');
    lines.push(...result.visible_features.map((item) => `- ${item}`));
  }

  if (result.uncertainty_notes) {
    lines.push(`不確実な点: ${result.uncertainty_notes}`);
  }

  return lines.join('\n');
}

function splitDiscordMessageText(text, maxChunkLength) {
  const lines = String(text || '').split('\n');
  const result = [];
  let current = '';

  for (const line of lines) {
    const next = current.length === 0 ? line : `${current}\n${line}`;
    if (next.length <= maxChunkLength) {
      current = next;
      continue;
    }

    if (current.length > 0) {
      result.push(current);
      current = '';
    }

    if (line.length <= maxChunkLength) {
      current = line;
      continue;
    }

    for (let index = 0; index < line.length; index += maxChunkLength) {
      result.push(line.slice(index, index + maxChunkLength));
    }
  }

  if (current.length > 0) {
    result.push(current);
  }

  return result.length > 0 ? result : [''];
}

module.exports = {
  buildIdentifyReply,
  splitDiscordMessageText
};
