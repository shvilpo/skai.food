// Распознавание через Claude API напрямую из браузера.
// Ключ хранится в localStorage, вызовы идут с заголовком
// anthropic-dangerous-direct-browser-access (официальный CORS-режим API).
// С российских IP api.anthropic.com недоступен — нужен VPN.

const API_URL = 'https://api.anthropic.com/v1/messages';
export const DEFAULT_MODEL = 'claude-opus-4-8';

export const MODELS = [
  { id: 'claude-opus-4-8', label: 'Opus 4.8 — точнее, дороже' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5 — баланс' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5 — быстрее и дешевле' },
];

export function getApiKey() {
  return (localStorage.getItem('apiKey') || '').trim();
}

export function getModel() {
  return localStorage.getItem('aiModel') || DEFAULT_MODEL;
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

async function callClaude(prompt, schema, imageB64) {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error('Не задан API-ключ. Добавь его на вкладке «Настройки».');

  let resp;
  try {
    resp = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: getModel(),
        max_tokens: 2048,
        output_config: { format: { type: 'json_schema', schema } },
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageB64 } },
            { type: 'text', text: prompt },
          ],
        }],
      }),
    });
  } catch {
    throw new Error('Сеть недоступна. api.anthropic.com не открывается с российских IP — проверь VPN.');
  }

  if (!resp.ok) {
    let msg = `ошибка API (${resp.status})`;
    try {
      const err = await resp.json();
      if (err?.error?.message) msg = err.error.message;
    } catch { /* тело не JSON */ }
    if (resp.status === 401) msg = 'Неверный API-ключ — проверь его в настройках.';
    if (resp.status === 429) msg = 'Слишком много запросов, подожди минуту.';
    throw new Error(msg);
  }

  const data = await resp.json();
  if (data.stop_reason === 'refusal') {
    throw new Error('Модель отказалась обрабатывать это фото.');
  }
  const text = (data.content || []).find(b => b.type === 'text')?.text;
  if (!text) throw new Error('Пустой ответ модели, попробуй ещё раз.');
  const parsed = JSON.parse(text);
  if (parsed.ok === false) {
    throw new Error(parsed.notes || 'Не удалось распознать фото.');
  }
  return parsed;
}

export async function recognizeLabel(file) {
  const imageB64 = await fileToBase64Jpeg(file);
  return callClaude(LABEL_PROMPT, LABEL_SCHEMA, imageB64);
}

export async function recognizePlate(file, comment) {
  const imageB64 = await fileToBase64Jpeg(file);
  const prompt = comment?.trim()
    ? `${PLATE_PROMPT}\n\nУточнение от пользователя (доверяй ему больше, чем своей оценке): ${comment.trim()}`
    : PLATE_PROMPT;
  return callClaude(prompt, PLATE_SCHEMA, imageB64);
}
