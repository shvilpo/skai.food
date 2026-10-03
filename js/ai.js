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
    kcal: { type: 'number', description: 'Килокалории на единицу' },
    protein: { type: 'number', description: 'Белок, г на единицу' },
    fiber: { type: 'number', description: 'Пищевые волокна (клетчатка), г на единицу' },
    calcium: { type: 'number', description: 'Кальций, мг на единицу' },
  },
  required: ['kcal', 'protein', 'fiber', 'calcium'],
  additionalProperties: false,
};

const LABEL_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Краткое название продукта на русском, с брендом если виден' },
    unit: { type: 'string', enum: ['g', 'pcs'], description: 'g — пищевая ценность указана на 100 г; pcs — на 1 штуку/порцию/изделие' },
    per: PER100_SCHEMA,
    pieceGrams: { type: 'number', description: 'Если unit=pcs и известен вес одной штуки/порции в граммах — укажи его; иначе 0' },
    plantPercent: { type: 'integer', description: 'Доля растительного сырья по массе, 0–100' },
    fiberSource: { type: 'string', enum: ['label', 'estimate'], description: 'label — клетчатка взята с этикетки, estimate — оценена по категории продукта' },
    ok: { type: 'boolean', description: 'false, если на фото нет читаемой этикетки/карточки с пищевой ценностью' },
    notes: { type: 'string', description: 'Краткое замечание для пользователя (или пустая строка)' },
  },
  required: ['name', 'unit', 'per', 'pieceGrams', 'plantPercent', 'fiberSource', 'ok', 'notes'],
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

const LABEL_PROMPT = `На фото — этикетка или карточка товара (например, изделие фастфуда вроде Ростикс/KFC).
Извлеки название и пищевую ценность.
Правила:
- ВАЖНО определи единицу измерения. Если КБЖУ дано на 100 г — unit="g" и per — значения на 100 г. Если КБЖУ дано на 1 штуку / 1 порцию / 1 изделие (типично для фастфуда: бургер, крыло, наггетс, стрипс) — unit="pcs" и per — значения на 1 штуку. Ориентируйся на подписи «на 100 г», «на порцию», «1 шт», «в одном изделии», размер порции.
- Если unit="pcs" и на карточке есть вес одной штуки/порции в граммах — верни его в pieceGrams; если веса нет — pieceGrams=0.
- «Пищевые волокна» = клетчатка. Если её нет на этикетке, оцени по типовому составу (таблицы химсостава, USDA) и поставь fiberSource="estimate"; если указана — fiberSource="label".
- calcium — содержание кальция в мг на ту же единицу (на 100 г или на 1 шт). Если на этикетке нет — оцени по типовому составу продукта (USDA/Скурихин). Если кальция в продукте практически нет — 0.
- plantPercent — доля ЦЕЛЬНОЙ, минимально обработанной растительной пищи по массе. Считать растительностью: овощи, фрукты, ягоды, бобовые (фасоль, чечевица, нут, горох), орехи, семечки, зелень, грибы. НЕ считать растительностью (=0): мясо, рыба, яйца, молочное; а также крупы, картофель, муку и изделия из неё (хлеб, макароны, выпечка) и сильно переработанную растительность (рафинированные сахар/масло, соки, соусы, какао). Для смешанных продуктов оцени долю именно цельной растительной части.
- Если на фото нет читаемой пищевой ценности, поставь ok=false и объясни в notes.`;

const PLATE_PROMPT = `На фото — еда (тарелка/блюдо), типичная для России.
Разбей её на компоненты, оцени массу каждой порции в граммах и пищевую ценность каждого компонента на 100 г (ккал, белок, клетчатка, кальций).
Правила:
- calcium компонента — содержание кальция в мг на 100 г (оцени по типовому составу, USDA/Скурихин; если практически нет — 0).
- plantPercent компонента — доля ЦЕЛЬНОЙ, минимально обработанной растительной пищи по массе. Считать растительностью: овощи, фрукты, ягоды, бобовые, орехи, семечки, зелень, грибы. НЕ считать (=0): мясо/рыба/яйца/молочное; а также крупы, рис, картофель, муку и изделия из неё (хлеб, макароны, выпечка) и сильно переработанную растительность (рафинированные сахар/масло, соки, соусы). Например, у плова растительной считается только морковь/лук, но не рис; у гарнира из гречки — 0.
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
        // temperature: 0 — детерминированный ответ: один и тот же запрос
        // даёт одни и те же КБЖУ/кальций, без разброса между вызовами.
        temperature: 0,
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
    // temperature: 0 — детерминированный ответ без разброса между вызовами.
    temperature: 0,
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
    name: { type: 'string', description: 'Уточнённое название продукта на русском (с брендом, если это фастфуд)' },
    unit: { type: 'string', enum: ['g', 'pcs'], description: 'pcs — если продукт считается штуками/порциями (фастфуд и готовые порционные изделия); g — если это сырьё/навесной продукт' },
    per: PER100_SCHEMA,
    pieceGrams: { type: 'number', description: 'Если unit=pcs — оценка веса одной штуки/порции в граммах; иначе 0' },
    plantPercent: { type: 'integer', description: 'Доля растительного сырья по массе, 0–100' },
    ok: { type: 'boolean', description: 'false, если такого продукта не существует' },
    notes: { type: 'string', description: 'Краткое замечание (или пустая строка)' },
  },
  required: ['name', 'unit', 'per', 'pieceGrams', 'plantPercent', 'ok', 'notes'],
  additionalProperties: false,
};

export async function lookupFood(query) {
  const prompt = `Дай пищевую ценность продукта «${query.trim()}»: ккал, белок, клетчатка (пищевые волокна), кальций.
Сначала определи единицу измерения:
- ШТУЧНЫЙ продукт фастфуда или готовое порционное изделие (бургер, крыло, ножка, наггетс, стрипс, твистер, шаурма, пирожок, булочка, порция картофеля фри и т.п. — особенно брендовое: Ростикс/KFC/Вкусно и точка/Макдоналдс/Бургер Кинг) → unit="pcs", per — на 1 штуку/порцию как продаётся (приготовленное), и ОБЯЗАТЕЛЬНО оцени вес одной штуки/порции в граммах в pieceGrams.
- Иначе (сырьё, навесной продукт: мясо, рыба, крупа, овощи, фрукты) → unit="g", per — на 100 г СЫРОГО/исходного вида (не варёного, не жареного), pieceGrams=0.
Правила:
- ВАЖНО для брендового фастфуда: бери ОФИЦИАЛЬНЫЕ данные бренда о готовом изделии. Это ПАНИРОВАННЫЙ, ОБЖАРЕННЫЙ ВО ФРИТЮРЕ продукт — его калорийность заметно ВЫШЕ сырого мяса. Ориентир для жареной курицы в панировке (острые крылья/ножки/стрипсы): ≈ 250–320 ккал на 100 г готового продукта; не занижай до значений сырого мяса (сырое крыло ≈ 190 ккал/100 г — это НЕ то). Вес одной порции бери реалистичный для бренда (например, острое крыло Ростикс ≈ 45–60 г). Проверь согласованность: per(на 1 шт) ÷ pieceGrams × 100 должно попадать в разумный диапазон ккал/100 г для такого блюда.
- «Пищевые волокна» = клетчатка; если данных нет, оцени по типовому составу (таблицы химсостава Скурихина, USDA).
- calcium — кальций в мг на ту же единицу (на 100 г или на 1 шт); оцени по типовому составу, если нет данных; если практически нет — 0.
- plantPercent — доля ЦЕЛЬНОЙ, минимально обработанной растительной пищи по массе. Считать растительностью: овощи, фрукты, ягоды, бобовые (фасоль, чечевица, нут, горох), орехи, семечки, зелень, грибы. НЕ считать (=0): мясо, рыба, яйца, молочное; а также крупы, картофель, муку и изделия из неё (хлеб, макароны, выпечка) и сильно переработанную растительность (рафинированные сахар/масло, соки, соусы, какао).
- Если такого продукта не существует, поставь ok=false и объясни в notes.`;
  return callVision(prompt, FOOD_SCHEMA, null);
}

// Точечный запрос только кальция для продукта, у которого он неизвестен.
const CALCIUM_SCHEMA = {
  type: 'object',
  properties: {
    calcium: { type: 'number', description: 'Кальций в мг на заданную единицу' },
    ok: { type: 'boolean', description: 'false, если продукт неизвестен' },
    notes: { type: 'string' },
  },
  required: ['calcium', 'ok', 'notes'],
  additionalProperties: false,
};

export async function lookupCalcium(name, unit) {
  const per = unit === 'pcs' ? 'на 1 штуку/порцию' : 'на 100 г';
  const prompt = `Оцени содержание кальция в продукте «${String(name).trim()}» в мг ${per}.
Опирайся на таблицы химического состава (Скурихин) и USDA. Для сырья бери значения сырого/исходного вида.
Верни число calcium (мг). Если кальция в продукте практически нет — 0. Если продукт неизвестен — ok=false.`;
  return callVision(prompt, CALCIUM_SCHEMA, null);
}
