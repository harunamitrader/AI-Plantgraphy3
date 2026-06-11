const KEY_CACHE_STORAGE_KEY = 'ai-plantgraphy3-site-key-v1';
const CHECK_TEXT = 'AI-Plantgraphy3 key check';

const state = {
  meta: null,
  rawKey: null,
  plants: null,
  observations: null
};

const unlockView = document.getElementById('unlock-view');
const appView = document.getElementById('app-view');
const unlockForm = document.getElementById('unlock-form');
const passwordInput = document.getElementById('password-input');
const unlockError = document.getElementById('unlock-error');
const plantList = document.getElementById('plant-list');
const detailView = document.getElementById('detail-view');
const lockButton = document.getElementById('lock-button');
const publishedAt = document.getElementById('published-at');

boot().catch(showUnlockError);

unlockForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await unlockWithPassword(passwordInput.value);
    passwordInput.value = '';
    unlockError.hidden = true;
    await loadAppData();
  } catch (error) {
    showUnlockError(error);
  }
});

lockButton.addEventListener('click', () => {
  localStorage.removeItem(KEY_CACHE_STORAGE_KEY);
  state.rawKey = null;
  state.plants = null;
  state.observations = null;
  appView.hidden = true;
  unlockView.hidden = false;
});

window.addEventListener('hashchange', () => {
  void renderRoute();
});

async function boot() {
  state.meta = await fetchJson('./meta.json');
  publishedAt.textContent = state.meta?.publishedAt ? `公開更新: ${new Date(state.meta.publishedAt).toLocaleString()}` : 'まだ publish されていません。';
  const cached = loadCachedKey(state.meta);
  if (!cached) {
    return;
  }
  state.rawKey = cached;
  try {
    await verifyKey();
    await loadAppData();
  } catch (error) {
    localStorage.removeItem(KEY_CACHE_STORAGE_KEY);
    state.rawKey = null;
  }
}

async function unlockWithPassword(password) {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const rawBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: decodeBase64(state.meta.salt),
      iterations: state.meta.iterations,
      hash: 'SHA-256'
    },
    keyMaterial,
    state.meta.keyLength * 8
  );
  state.rawKey = new Uint8Array(rawBits);
  await verifyKey();
  saveCachedKey(state.meta, state.rawKey);
}

async function verifyKey() {
  const text = await decryptText('./check.enc');
  if (text !== CHECK_TEXT) {
    throw new Error('パスワードが正しくありません。');
  }
}

async function loadAppData() {
  state.plants = await decryptJson('./data/plants.json.enc');
  state.observations = await decryptJson('./data/observations.json.enc');
  unlockView.hidden = true;
  appView.hidden = false;
  renderPlantList();
  await renderRoute();
}

function renderPlantList() {
  plantList.replaceChildren();
  const entries = Object.entries(state.plants || {}).sort((left, right) => {
    const leftName = left[1].common_name_ja || left[1].scientific_name || left[0];
    const rightName = right[1].common_name_ja || right[1].scientific_name || right[0];
    return leftName.localeCompare(rightName, 'ja');
  });

  if (entries.length === 0) {
    plantList.textContent = 'まだ図鑑データがありません。';
    return;
  }

  for (const [plantId, plant] of entries) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = `${plant.common_name_ja || '名称不明'}${plant.scientific_name ? ` / ${plant.scientific_name}` : ''}`;
    if (location.hash === `#/plants/${plantId}`) {
      button.classList.add('active');
    }
    button.addEventListener('click', () => {
      location.hash = `#/plants/${plantId}`;
    });
    plantList.append(button);
  }
}

async function renderRoute() {
  renderPlantList();
  const match = location.hash.match(/^#\/plants\/(.+)$/);
  if (!match) {
    detailView.innerHTML = '<p>左の一覧から植物を選んでください。</p>';
    return;
  }

  const plantId = resolvePlantId(match[1]);
  const plant = plantId ? state.plants?.[plantId] : null;
  if (!plant) {
    detailView.innerHTML = '<p>指定の植物が見つかりません。</p>';
    return;
  }

  const canonicalHash = `#/plants/${encodeURIComponent(plantId)}`;
  if (location.hash !== canonicalHash) {
    history.replaceState(null, '', canonicalHash);
    renderPlantList();
  }

  const wrapper = document.createElement('div');
  wrapper.append(createHeading('h2', plant.common_name_ja || plantId));
  if (plant.scientific_name) {
    wrapper.append(createParagraph(plant.scientific_name));
  }

  if (plant.cover_image) {
    const cover = document.createElement('img');
    cover.alt = plant.common_name_ja || plantId;
    cover.src = await decryptImage(`./images/${plant.cover_image.split('/').pop()}.enc`);
    wrapper.append(cover);
  }

  wrapper.append(labeledParagraph('基本情報', plant.basic_profile_text));
  wrapper.append(labeledParagraph('見た目の魅力', plant.visual_appeal_text));
  wrapper.append(labeledParagraph('手入れメモ', plant.care_notes));

  for (const observationId of Array.isArray(plant.observation_ids) ? plant.observation_ids : []) {
    const observation = state.observations?.[observationId];
    if (!observation) {
      continue;
    }
    const section = document.createElement('section');
    section.className = 'observation';
    section.append(createHeading('h3', new Date(observation.observed_at).toLocaleString()));
    section.append(labeledParagraph('観察記録', observation.observation_text));
    if (observation.user_memo) {
      section.append(labeledParagraph('メモ', observation.user_memo));
    }
    for (const imagePath of Array.isArray(observation.images) ? observation.images : []) {
      const image = document.createElement('img');
      image.alt = observationId;
      image.src = await decryptImage(`./images/${imagePath.split('/').pop()}.enc`);
      section.append(image);
    }
    wrapper.append(section);
  }

  detailView.replaceChildren(wrapper);
}

function resolvePlantId(rawValue) {
  const decoded = decodeHashValue(rawValue).replace(/^\/+|\/+$/g, '');
  if (!decoded) {
    return null;
  }

  if (state.plants?.[decoded]) {
    return decoded;
  }

  const normalized = slugifyPlantId(decoded);
  if (normalized && state.plants?.[normalized]) {
    return normalized;
  }

  const observationPlantId = state.observations?.[decoded]?.plant_id;
  if (observationPlantId && state.plants?.[observationPlantId]) {
    return observationPlantId;
  }

  for (const [plantId, plant] of Object.entries(state.plants || {})) {
    const scientific = slugifyPlantId(plant.scientific_name || '');
    const common = slugifyPlantId(plant.common_name_ja || '');
    if (normalized === scientific || normalized === common) {
      return plantId;
    }
  }

  return null;
}

function createHeading(tagName, text) {
  const element = document.createElement(tagName);
  element.textContent = text;
  return element;
}

function createParagraph(text) {
  const element = document.createElement('p');
  element.textContent = text;
  return element;
}

function labeledParagraph(label, value) {
  const element = document.createElement('p');
  const strong = document.createElement('strong');
  strong.textContent = `${label}: `;
  element.append(strong, document.createTextNode(value || '未登録'));
  return element;
}

function decodeHashValue(value) {
  let current = String(value || '');
  for (let index = 0; index < 3; index += 1) {
    try {
      const next = decodeURIComponent(current);
      if (next === current) {
        break;
      }
      current = next;
    } catch (error) {
      break;
    }
  }
  return current.trim();
}

function slugifyPlantId(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[×]/g, 'x')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

async function decryptJson(url) {
  return JSON.parse(await decryptText(url));
}

async function decryptText(url) {
  return new TextDecoder().decode(await decryptBuffer(url));
}

async function decryptImage(url) {
  return URL.createObjectURL(new Blob([await decryptBuffer(url)]));
}

async function decryptBuffer(url) {
  const envelope = await fetchJson(url);
  const cryptoKey = await importAesKey(state.rawKey);
  const decrypted = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: decodeBase64(envelope.iv),
      additionalData: new Uint8Array(),
      tagLength: 128
    },
    cryptoKey,
    concatBytes(decodeBase64(envelope.data), decodeBase64(envelope.tag))
  );
  return new Uint8Array(decrypted);
}

async function importAesKey(rawKey) {
  return crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['decrypt']);
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`${url} を取得できませんでした (${response.status})。`);
  }
  return response.json();
}

function saveCachedKey(meta, rawKey) {
  localStorage.setItem(KEY_CACHE_STORAGE_KEY, JSON.stringify({
    salt: meta.salt,
    iterations: meta.iterations,
    key: encodeBase64(rawKey)
  }));
}

function loadCachedKey(meta) {
  const raw = localStorage.getItem(KEY_CACHE_STORAGE_KEY);
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed.salt !== meta.salt || parsed.iterations !== meta.iterations) {
      return null;
    }
    return decodeBase64(parsed.key);
  } catch (error) {
    return null;
  }
}

function encodeBase64(bytes) {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function decodeBase64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function concatBytes(left, right) {
  const result = new Uint8Array(left.length + right.length);
  result.set(left, 0);
  result.set(right, left.length);
  return result;
}

function showUnlockError(error) {
  unlockError.hidden = false;
  const message = error instanceof Error ? error.message : String(error);
  unlockError.textContent = message && message.trim() ? message : 'パスワードが正しくありません。';
}
