// Распознавание по фото через vision-LLM. Два провайдера:
//  - anthropic:  прямые вызовы api.anthropic.com (официальный CORS-режим,
//                заголовок anthropic-dangerous-direct-browser-access);
//                с российских IP нужен VPN.
//  - openrouter: openrouter.ai — OpenAI-совместимый API, работает из РФ
//                без VPN, даёт доступ к тем же и другим моделям.
// Ключи хранятся в localStorage, по одному на провайдера.

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

export const PROVIDERS = [
  { id: 'anthropic', label: 'Anthropic напрямую (нужен VPN)', keyPlaceholder: 'sk-ant-…' },
  { id: 'openrouter', label: 'OpenRouter (работает без VPN)', keyPlaceholder: 'sk-or-…' },
];

export const ANTHROPIC_MODELS = [
  { id: 'claude-opus-4-8', label: 'Opus 4.8 — точнее, дороже' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5 — баланс' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5 — быстрее и дешевле' },
];
export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-4-8';

// ID проверены по каталогу openrouter.ai/api/v1/models (июль 2026),
// поле свободное — можно вписать любую vision-модель из каталога.
export const OPENROUTER_SUGGESTIONS = [
  'anthropic/claude-opus-4.8',
  'anthropic/claude-sonnet-5',
  'anthropic/claude-haiku-4.5',
  'openai/gpt-5.5',
  'google/gemini-3.5-flash',
  'qwen/qwen3.6-flash',
  'google/gemma-4-31b-it:free',
];
export const DEFAULT_OPENROUTER_MODEL = 'anthropic/claude-opus-4.8';

export function getProvider() {
  return localStorage.getItem('aiProvider') || 'anthropic';
}

export function getApiKey(provider = getProvider()) {
  const storageKey = provider === 'openrouter' ? 'openrouterKey' : 'apiKey';
  return (localStorage.getItem(storageKey) || '').trim();
}

export function setApiKey(value, provider = getProvider()) {
  const storageKey = provider === 'openrouter' ? 'openrouterKey' : 'apiKey';
  localStorage.setItem(storageKey, value.trim());
}

export function getModel(provider = getProvider()) {
  if (provider === 'openrouter') {
    return localStorage.getItem('openrouterModel') || DEFAULT_OPENROUTER_MODEL;
  }
  return localStorage.getItem('aiModel') || DEFAULT_ANTHROPIC_MODEL;
}

// Фото с камеры бывают 4000+ px — ужимаем до 1568 по длинной стороне,
// этого достаточно для чтения этикетки и сильно дешевле по токенам.
export async function fileToBase64Jpeg(file, maxSide = 1568) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('не удалось прочитать изображение'));
      el.src = url;
    });
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(img, 0, 0, w, h);
    return canvas.toDataURL('image/jpeg', 0.85).split(',')[1];
  } finally {
    URL.revokeObjectURL(url);
  }
}

const PER100_SCHEMA = {
  type: 'object',
  properties: {
    kcal: { type: 'number', description: 'Килокалории на 100 г' },
    protein: { type: 'number', description: 'Белок, г на 100 г' },
    fiber: { type: 'number', description: 'Пищевые волокна (клетчатка), г на 100 г' },
  },
  required: ['kcal', 'protein', 'fiber'],
  additionalProperties: false,
};

const LABEL_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Краткое название продукта на русском, с брендом если виден' },
    per100: PER100_SCHEMA,
    plantPercent: { type: 'integer', description: 'Доля растительного сырья по массе, 0–100' },
    fiberSource: { type: 'string', enum: ['label', 'estimate'], description: 'label — клетчатка взята с этикетки, estimate — оценена по категории продукта' },
    ok: { type: 'boolean', description: 'false, если на фото нет читаемой этикетки с пищевой ценностью' },
    notes: { type: 'string', description: 'Краткое замечание для пользователя (или пустая строка)' },
  },
  required: ['name', 'per100', 'plantPercent', 'fiberSource', 'ok', 'notes'],
  additionalProperties: false,
};

const PLATE_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      description: 'Компоненты блюда',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Название компонента на русском' },
          grams: { type: 'number', description: 'Оценка массы порции, г' },
          per100: PER100_SCHEMA,
          plantPercent: { type: 'integer', description: 'Доля растительного сырья по массе, 0–100' },
        },
        required: ['name', 'grams', 'per100', 'plantPercent'],
        additionalProperties: false,
      },
    },
    ok: { type: 'boolean', description: 'false, если на фото не еда или её невозможно оценить' },
    notes: { type: 'string', description: 'Краткое замечание об уверенности оценки (или пустая строка)' },
  },
  required: ['items', 'ok', 'notes'],
  additionalProperties: false,
};

const LABEL_PROMPT = `На фото — этикетка продукта, купленного в российском магазине.
Извлеки название и пищевую ценность НА 100 Г продукта.
Правила:
- «Пищевые волокна» = клетчатка. На российских этикетках её часто не пишут: если её нет, оцени по типовому составу этой категории продукта (таблицы химсостава, USDA) и поставь fiberSource="estimate"; если она указана — возьми с этикетки и поставь fiberSource="label".
- plantPercent — доля растительного сырья по массе (овощи, крупы, фрукты, бобовые, орехи = 100; мясо/молочное/яйца/рыба = 0; смешанные продукты — оцени по составу). Рафинированные сахар и растительное масло считай за 0.
- Если на фото нет читаемой таблицы пищевой ценности, поставь ok=false и объясни в notes.`;

const PLATE_PROMPT = `На фото — еда (тарелка/блюдо), типичная для России.
Разбей её на компоненты, оцени массу каждой порции в граммах и пищевую ценность каждого компонента на 100 г (ккал, белок, клетчатка).
Правила:
- plantPercent компонента — доля растительного сырья по массе (гарниры из круп/овощей = 100, мясо/рыба/молочное = 0, смешанные блюда типа борща или запеканки — оцени по составу). Рафинированные сахар и масло считай за 0.
- Ориентируйся на видимые размеры посуды и порций; оценивай реалистично.
- Если на фото не еда или оценить невозможно, поставь ok=false и объясни в notes.`;

// Модель может обернуть JSON в ```-заборы или добавить текст — вырезаем объект.
function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('В ответе модели нет JSON, попробуй ещё раз.');
  return JSON.parse(text.slice(start, end + 1));
}

async function callAnthropic(prompt, schema, imageB64, apiKey) {
  const content = [];
  if (imageB64) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageB64 } });
  content.push({ type: 'text', text: prompt });

  let resp;
  try {
    resp = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: getModel('anthropic'),
        max_tokens: 2048,
        output_config: { format: { type: 'json_schema', schema } },
        messages: [{ role: 'user', content }],
      }),
    });
  } catch {
    throw new Error('Сеть недоступна. api.anthropic.com не открывается с российских IP — проверь VPN, или переключись на OpenRouter в настройках.');
  }

  if (!resp.ok) throw await apiError(resp);

  const data = await resp.json();
  if (data.stop_reason === 'refusal') {
    throw new Error('Модель отказалась обрабатывать это фото.');
  }
  const text = (data.content || []).find(b => b.type === 'text')?.text;
  if (!text) throw new Error('Пустой ответ модели, попробуй ещё раз.');
  return extractJson(text);
}

async function callOpenRouter(prompt, schema, imageB64, apiKey, withFormat = true) {
  const content = [];
  if (imageB64) content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageB64}` } });
  content.push({ type: 'text', text: `${prompt}\n\nОтветь строго одним JSON-объектом по заданной схеме, без пояснений и без markdown.` });

  const body = {
    model: getModel('openrouter'),
    max_tokens: 2048,
    messages: [{ role: 'user', content }],
  };
  if (withFormat) {
    body.response_format = {
      type: 'json_schema',
      json_schema: { name: 'result', strict: true, schema },
    };
  }

  let resp;
  try {
    resp = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
        'x-title': 'skai.food',
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error('Сеть недоступна — openrouter.ai не отвечает.');
  }

  // Не каждая модель каталога умеет строгий json_schema —
  // при 400 пробуем ещё раз без него (JSON затребован промптом).
  if (resp.status === 400 && withFormat) {
    return callOpenRouter(prompt, schema, imageB64, apiKey, false);
  }
  if (!resp.ok) throw await apiError(resp);

  const data = await resp.json();
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('Пустой ответ модели, попробуй ещё раз.');
  return extractJson(typeof text === 'string' ? text : JSON.stringify(text));
}

async function apiError(resp) {
  let msg = `ошибка API (${resp.status})`;
  try {
    const err = await resp.json();
    if (err?.error?.message) msg = err.error.message;
  } catch { /* тело не JSON */ }
  if (resp.status === 401) msg = 'Неверный API-ключ — проверь его в настройках.';
  if (resp.status === 402) msg = 'На счету OpenRouter недостаточно средств.';
  if (resp.status === 404) msg = 'Модель не найдена — проверь её название в настройках.';
  if (resp.status === 429) msg = 'Слишком много запросов, подожди минуту.';
  return new Error(msg);
}

async function callVision(prompt, schema, imageB64) {
  const provider = getProvider();
  const apiKey = getApiKey(provider);
  if (!apiKey) {
    throw new Error(`Не задан API-ключ ${provider === 'openrouter' ? 'OpenRouter' : 'Anthropic'}. Добавь его на вкладке «Настройки».`);
  }
  const parsed = provider === 'openrouter'
    ? await callOpenRouter(prompt, schema, imageB64, apiKey)
    : await callAnthropic(prompt, schema, imageB64, apiKey);
  if (parsed.ok === false) {
    throw new Error(parsed.notes || 'Не удалось распознать фото.');
  }
  return parsed;
}

export async function recognizeLabel(file) {
  const imageB64 = await fileToBase64Jpeg(file);
  return callVision(LABEL_PROMPT, LABEL_SCHEMA, imageB64);
}

export async function recognizePlate(file, comment) {
  const imageB64 = await fileToBase64Jpeg(file);
  const prompt = comment?.trim()
    ? `${PLATE_PROMPT}\n\nУточнение от пользователя (доверяй ему больше, чем своей оценке): ${comment.trim()}`
    : PLATE_PROMPT;
  return callVision(prompt, PLATE_SCHEMA, imageB64);
}

// Догрузка продукта по названию (без фото) — когда его нет в базе.
const FOOD_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Уточнённое название продукта на русском' },
    per100: PER100_SCHEMA,
    plantPercent: { type: 'integer', description: 'Доля растительного сырья по массе, 0–100' },
    ok: { type: 'boolean', description: 'false, если такого продукта не существует' },
    notes: { type: 'string', description: 'Краткое замечание (или пустая строка)' },
  },
  required: ['name', 'per100', 'plantPercent', 'ok', 'notes'],
  additionalProperties: false,
};

export async function lookupFood(query) {
  const prompt = `Дай пищевую ценность СЫРОГО, неприготовленного продукта «${query.trim()}» на 100 г съедобной части: ккал, белок, клетчатка (пищевые волокна).
Правила:
- Значения — для сырого/исходного вида (не варёного, не жареного, не тушёного). Если продукт обычно едят приготовленным, всё равно дай значения для сырья.
- plantPercent — доля растительного сырья по массе: мясо, рыба, яйца, молочное = 0; овощи, крупы, фрукты, бобовые, орехи = 100; смешанные — оцени по составу.
- Опирайся на таблицы химического состава (Скурихин) и USDA.
- Если такого продукта не существует, поставь ok=false и объясни в notes.`;
  return callVision(prompt, FOOD_SCHEMA, null);
}
