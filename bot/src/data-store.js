'use strict';

const fs = require('node:fs');
const path = require('node:path');

function ensureLocalStore(storage) {
  fs.mkdirSync(storage.dataDir, { recursive: true });
  fs.mkdirSync(path.join(storage.dataDir, 'images'), { recursive: true });
  ensureJsonFile(path.join(storage.dataDir, 'plants.json'));
  ensureJsonFile(path.join(storage.dataDir, 'observations.json'));
}

function recordObservation({ storage, identifyResult, enrichResult, observationImages, note, observedAt, observationId, plantId }) {
  ensureLocalStore(storage);
  const plantsPath = path.join(storage.dataDir, 'plants.json');
  const observationsPath = path.join(storage.dataDir, 'observations.json');
  const plants = readJsonObject(plantsPath);
  const observations = readJsonObject(observationsPath);
  const resolvedObservationId = observationId || buildObservationId(observedAt);
  return recordObservationWithIds({
    storage,
    identifyResult,
    enrichResult,
    observationImages,
    note,
    observedAt,
    observationId: resolvedObservationId,
    plantId: plantId || buildPlantId(identifyResult, resolvedObservationId),
    plants,
    observations,
    plantsPath,
    observationsPath
  });
}

function recordObservationWithIds({
  storage,
  identifyResult,
  enrichResult,
  observationImages,
  note,
  observedAt,
  observationId,
  plantId,
  plants,
  observations,
  plantsPath,
  observationsPath
}) {
  const isNewPlant = !plants[plantId];

  observations[observationId] = {
    plant_id: plantId,
    observed_at: observedAt,
    images: observationImages.map((item) => item.relativePath),
    confidence: identifyResult.confidence,
    candidates: identifyResult.candidates,
    visible_features: identifyResult.visible_features,
    uncertainty_notes: identifyResult.uncertainty_notes,
    user_memo: note || '',
    observation_text: enrichResult.observation_text
  };

  const currentPlant = plants[plantId] || {
    common_name_ja: identifyResult.common_name_ja,
    scientific_name: identifyResult.scientific_name,
    basic_profile_text: '',
    visual_appeal_text: '',
    care_notes: '',
    cover_image: observationImages[0]?.relativePath || '',
    observation_ids: []
  };

  if (isNewPlant) {
    currentPlant.basic_profile_text = enrichResult.basic_profile_text;
    currentPlant.visual_appeal_text = enrichResult.visual_appeal_text;
    currentPlant.care_notes = enrichResult.care_notes;
    currentPlant.cover_image = observationImages[0]?.relativePath || currentPlant.cover_image;
  }

  currentPlant.common_name_ja = currentPlant.common_name_ja || identifyResult.common_name_ja;
  currentPlant.scientific_name = currentPlant.scientific_name || identifyResult.scientific_name;
  currentPlant.observation_ids = Array.isArray(currentPlant.observation_ids) ? currentPlant.observation_ids : [];
  currentPlant.observation_ids.push(observationId);
  plants[plantId] = currentPlant;

  writeJsonObject(observationsPath, sortObject(observations));
  writeJsonObject(plantsPath, sortObject(plants));

  return {
    observationId,
    plantId,
    isNewPlant
  };
}

function ensureJsonFile(filePath) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, '{}\n', 'utf8');
  }
}

function readJsonObject(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJsonObject(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function buildObservationId(observedAt) {
  const compact = observedAt.replace(/[-:TZ+.]/g, '').slice(0, 14);
  return `obs-${compact}-${Math.random().toString(16).slice(2, 8)}`;
}

function buildPlantId(identifyResult, observationId) {
  const primary = identifyResult.scientific_name || identifyResult.common_name_ja || observationId;
  const slug = String(primary)
    .normalize('NFKD')
    .replace(/[×]/g, 'x')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || observationId;
}

function sortObject(value) {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}

module.exports = {
  buildObservationId,
  buildPlantId,
  ensureLocalStore,
  recordObservation
};
