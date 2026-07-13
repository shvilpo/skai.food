import { uid, todayStr, addDays, fmtHeaderDate, fmtShortDate, fmt, esc, num } from './util.js';
import * as db from './db.js';
import { ensureSeed } from './seed.js';
import * as ai from './ai.js';

const DEFAULT_TARGETS = { kcal: 2000, protein: 100, fiber: 30, plant: 400 };

const state = {
  tab: 'diary',
  date: todayStr(),
  products: [],
  entries: [],
  dishes: [],
  targets: { ...DEFAULT_TARGETS },
  productQuery: '',
};

const view = document.getElementById('view');
const dlg = document.getElementById('dlg');

// состояние режима «Фото» в диалоге добавления
let photoState = { file: null, plateItems: null };
let photoType = 'label';

// черновик редактируемого блюда (пока открыт диалог блюда)
let dishDraft = null;
// выбранное блюдо в режиме «Блюдо» диалога добавления записи
let entryDishId = null;

// ---------- данные ----------

async function refreshProducts() {
  state.products = await db.getAll('products');
  state.products.sort((a, b) =>
    (b.usedCount || 0) - (a.usedCount || 0) || a.name.localeCompare(b.name, 'ru'));
}

async function refreshEntries() {
  state.entries = await db.entriesByDate(state.date);
  state.entries.sort((a, b) => (a.ts || 0) - (b.ts || 0));
}

async function refreshDishes() {
  state.dishes = await db.getAll('dishes');
  // по алфавиту в обратном порядке; т.к. имя начинается с даты — самые
  // недавние оказываются вверху
  state.dishes.sort((a, b) => dishFullName(b).localeCompare(dishFullName(a), 'ru'));

  // сколько граммов каждого блюда уже внесено в дневник (по всем дням).
  // % съеденного = внесённые граммы / масса блюда × 100. Работает при любом
  // числе добавлений: каждое добавление P% кладёт P% массы блюда.
  const entries = await db.getAll('entries');
  const byId = {};
  const byName = {};
  for (const e of entries) {
    if (e.source !== 'dish') continue;
    const g = num(e.grams);
    if (e.dishId) byId[e.dishId] = (byId[e.dishId] || 0) + g;
    else if (e.fromDish) byName[e.fromDish] = (byName[e.fromDish] || 0) + g;
  }
  state.dishEaten = { byId, byName };
}

// Процент блюда, уже внесённый в дневник.
function dishEatenPercent(d) {
  const eaten = state.dishEaten || { byId: {}, byName: {} };
  const grams = (eaten.byId[d.id] || 0) + (eaten.byName[dishFullName(d)] || 0);
  const total = d.totalGrams || dishTotals(d.components || []).grams;
  return total > 0 ? grams / total * 100 : 0;
}

// Составное имя блюда: YYYY-MM-DD-Название
function dishFullName(d) {
  return `${d.date}-${d.name}`;
}

// Масса и КБЖУ блюда целиком (по сырым ингредиентам).
function dishTotals(components) {
  const t = { grams: 0, kcal: 0, protein: 0, fiber: 0, plant: 0 };
  for (const c of components) {
    const g = num(c.grams);
    const k = g / 100;
    t.grams += g;
    t.kcal += (c.per100?.kcal || 0) * k;
    t.protein += (c.per100?.protein || 0) * k;
    t.fiber += (c.per100?.fiber || 0) * k;
    t.plant += g * (c.plantPercent || 0) / 100;
  }
  return t;
}

async function loadTargets() {
  const rec = await db.get('settings', 'targets');
  if (rec) state.targets = { ...DEFAULT_TARGETS, ...rec.value };
}

function entryNutrients(e) {
  const k = e.grams / 100;
  return {
    kcal: e.per100.kcal * k,
    protein: e.per100.protein * k,
    fiber: e.per100.fiber * k,
    plant: e.grams * (e.plantPercent || 0) / 100,
  };
}

function totals(entries) {
  const t = { kcal: 0, protein: 0, fiber: 0, plant: 0 };
  for (const e of entries) {
    const n = entryNutrients(e);
    t.kcal += n.kcal; t.protein += n.protein; t.fiber += n.fiber; t.plant += n.plant;
  }
  return t;
}

// ---------- отрисовка ----------

function render() {
  document.querySelectorAll('.tabbar button').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === state.tab));
  if (state.tab === 'diary') renderDiary();
  else if (state.tab === 'products') renderProducts();
  else if (state.tab === 'dishes') renderDishes();
  else if (state.tab === 'stats') renderStats();
  else renderSettings();
}

function metricTile(label, value, target, unit, digits = 0) {
  const pct = target > 0 ? Math.min(100, value / target * 100) : 0;
  const over = label === 'Калории' && target > 0 && value > target;
  return `<div class="tile">
    <div class="tile-label">${label}</div>
    <div class="tile-value">${fmt(value, digits)}<span class="tile-unit"> / ${fmt(target)} ${unit}</span></div>
    <div class="bar"><div class="bar-fill${over ? ' over' : ''}" style="width:${pct}%"></div></div>
  </div>`;
}

function renderDiary() {
  const t = totals(state.entries);
  const isToday = state.date === todayStr();
  const rows = state.entries.map(e => {
    const n = entryNutrients(e);
    return `<button class="entry" data-action="edit-entry" data-id="${e.id}">
      <div class="entry-main">
        <span class="entry-name">${e.fromDish ? '🍲 ' : ''}${esc(e.name)}</span>
        <span class="entry-grams">${fmt(e.grams, 1)} г</span>
      </div>
      <div class="entry-sub">${fmt(n.kcal)} ккал · Б ${fmt(n.protein, 1)} · Кл ${fmt(n.fiber, 1)} · Раст ${fmt(n.plant)}${e.fromDish ? ` · из: ${esc(e.fromDish)}` : ''}</div>
    </button>`;
  }).join('');

  view.innerHTML = `
    <div class="datebar">
      <button class="nav-btn" data-action="date-prev">‹</button>
      <button class="date-title" data-action="date-today">${fmtHeaderDate(state.date)}${isToday ? '' : ' <span class="date-hint">· к сегодня</span>'}</button>
      <button class="nav-btn" data-action="date-next" ${isToday ? 'disabled' : ''}>›</button>
    </div>
    <div class="tiles">
      ${metricTile('Калории', t.kcal, state.targets.kcal, 'ккал')}
      ${metricTile('Белок', t.protein, state.targets.protein, 'г', 1)}
      ${metricTile('Растительное', t.plant, state.targets.plant, 'г')}
      ${metricTile('Клетчатка', t.fiber, state.targets.fiber, 'г', 1)}
    </div>
    <div class="entries">${rows || '<p class="empty">Пока ничего не записано.</p>'}</div>
    <button class="fab" data-action="add-entry">+ Добавить</button>`;
}

function productListInner(query) {
  const q = query.trim().toLowerCase();
  const list = q ? state.products.filter(p => p.name.toLowerCase().includes(q)) : state.products;
  if (list.length) {
    return list.map(p => `
      <button class="entry" data-action="edit-product" data-id="${p.id}">
        <div class="entry-main">
          <span class="entry-name">${esc(p.name)}</span>
          ${p.plantPercent ? '<span class="leaf">🌿</span>' : ''}
        </div>
        <div class="entry-sub">на 100 г: ${fmt(p.per100.kcal)} ккал · Б ${fmt(p.per100.protein, 1)} · Кл ${fmt(p.per100.fiber, 1)}</div>
      </button>`).join('');
  }
  const trimmed = query.trim();
  if (!trimmed) return '<p class="empty">База пуста.</p>';
  // ничего не нашлось — предлагаем догрузить через ИИ
  return `<p class="empty">В базе нет «${esc(trimmed)}».</p>
    <button class="btn" data-action="lookup-product" data-query="${esc(trimmed)}">🔎 Найти через ИИ и добавить</button>`;
}

function renderProducts() {
  view.innerHTML = `
    <div class="searchbar">
      <input type="search" id="productSearch" placeholder="Поиск по базе…" value="${esc(state.productQuery)}">
    </div>
    <div class="entries">${productListInner(state.productQuery)}</div>
    <button class="fab" data-action="add-product">+ Продукт</button>`;

  const input = document.getElementById('productSearch');
  input.addEventListener('input', () => {
    state.productQuery = input.value;
    // перерисовываем только список, чтобы не терять фокус
    view.querySelector('.entries').innerHTML = productListInner(input.value);
  });
}

// ---------- вкладка «Блюда» ----------

function renderDishes() {
  const rows = state.dishes.map(d => {
    const t = dishTotals(d.components || []);
    const eaten = dishEatenPercent(d);
    return `<button class="entry" data-action="open-dish" data-id="${d.id}">
      <div class="entry-main">
        <span class="entry-name">${esc(dishFullName(d))}</span>
        <span class="entry-grams">${fmt(t.grams)} г</span>
      </div>
      <div class="entry-sub">${(d.components || []).length} прод. · всего ${fmt(t.kcal)} ккал · Б ${fmt(t.protein, 1)} · Кл ${fmt(t.fiber, 1)}${eaten > 0 ? ` · <span class="dish-eaten">съедено ${fmt(eaten)}%</span>` : ''}</div>
    </button>`;
  }).join('');

  view.innerHTML = `
    <h2 class="section-title">Свои блюда</h2>
    <p class="note">Блюдо — состав из сырых продуктов с граммовками. В дневник добавляется по проценту от приготовленного блюда: каждый ингредиент попадёт построчно в этой доле.</p>
    <div class="entries">${rows || '<p class="empty">Пока нет блюд. Создай первое кнопкой ниже.</p>'}</div>
    <button class="fab" data-action="add-dish">+ Блюдо</button>`;
}

// ---- конструктор блюда (создание / правка) ----

function showDishDialog(dish) {
  dishDraft = dish
    ? { id: dish.id, name: dish.name, date: dish.date, createdAt: dish.createdAt,
        components: (dish.components || []).map(c => ({ ...c, per100: { ...c.per100 } })) }
    : { id: null, name: '', date: todayStr(), createdAt: null, components: [] };

  showDialog(`
    <div class="dlg-head"><h3>${dish ? 'Блюдо' : 'Новое блюдо'}</h3>
      <button type="button" class="dlg-close" data-action="dlg-close">✕</button></div>
    <div class="dlg-body">
      <label>Название <input id="dishName" value="${esc(dishDraft.name)}" placeholder="например: плов"></label>
      <label>Дата приготовления <input id="dishDate" type="date" value="${esc(dishDraft.date)}"></label>

      <fieldset><legend>Состав</legend>
        <div id="dishComponents"></div>
        <input type="search" id="dishProductSearch" placeholder="Добавить продукт…" autocomplete="off">
        <div id="dishPickList" class="pick-list"></div>
      </fieldset>

      <div id="dishTotals" class="dish-totals"></div>
      <button type="button" class="btn primary" data-action="save-dish">Сохранить блюдо</button>
      ${dish ? `<button type="button" class="btn danger" data-action="delete-dish" data-id="${dish.id}">Удалить блюдо</button>` : ''}
    </div>`);

  renderDishComponents();
  renderDishPickList('');

  const search = dlg.querySelector('#dishProductSearch');
  search.addEventListener('input', () => renderDishPickList(search.value));
  dlg.querySelector('#dishName').addEventListener('input', e => { dishDraft.name = e.target.value; });
  dlg.querySelector('#dishDate').addEventListener('input', e => { dishDraft.date = e.target.value; });
}

function renderDishPickList(query) {
  const el = dlg.querySelector('#dishPickList');
  const q = query.trim().toLowerCase();
  // без запроса список не показываем — иначе он занимает пол-экрана и мешает
  // добраться до кнопок; появляется только по мере ввода
  if (!q) { el.innerHTML = ''; return; }
  const list = state.products.filter(p => p.name.toLowerCase().includes(q)).slice(0, 8);
  el.innerHTML = list.length
    ? list.map(p => `<button type="button" class="pick" data-action="dish-add-product" data-id="${p.id}">
        ${esc(p.name)}<span class="pick-sub">${fmt(p.per100.kcal)} ккал/100 г</span></button>`).join('')
    : '<p class="empty">Не найдено.</p>';
}

function renderDishComponents() {
  const el = dlg.querySelector('#dishComponents');
  if (!dishDraft.components.length) {
    el.innerHTML = '<p class="empty">Пусто — добавь продукты ниже.</p>';
  } else {
    el.innerHTML = dishDraft.components.map((c, i) => `
      <div class="dish-comp">
        <span class="dish-comp-name">${esc(c.name)}</span>
        <input class="dish-comp-grams" type="number" inputmode="decimal" data-dish-grams="${i}" value="${c.grams}"> г
        <button type="button" class="dish-comp-del" data-action="dish-del-component" data-index="${i}">✕</button>
      </div>`).join('');
  }
  updateDishTotals();
}

function updateDishTotals() {
  const t = dishTotals(dishDraft.components);
  dlg.querySelector('#dishTotals').innerHTML =
    `Масса блюда: <b>${fmt(t.grams)} г</b> · ${fmt(t.kcal)} ккал · Б ${fmt(t.protein, 1)} · Кл ${fmt(t.fiber, 1)} · Раст ${fmt(t.plant)}`;
}

async function saveDish() {
  dishDraft.name = dlg.querySelector('#dishName').value.trim();
  dishDraft.date = dlg.querySelector('#dishDate').value || todayStr();
  if (!dishDraft.name) { toast('Укажи название блюда'); return; }
  if (!dishDraft.components.length) { toast('Добавь хотя бы один продукт'); return; }
  const components = dishDraft.components
    .map(c => ({ ...c, grams: num(c.grams) }))
    .filter(c => c.grams > 0);
  if (!components.length) { toast('Граммовки должны быть больше нуля'); return; }

  const rec = {
    id: dishDraft.id || uid(),
    name: dishDraft.name,
    date: dishDraft.date,
    components,
    totalGrams: dishTotals(components).grams,
    createdAt: dishDraft.createdAt || Date.now(),
  };
  await db.put('dishes', rec);
  dlg.close();
  await refreshDishes();
  render();
  toast('Блюдо сохранено');
}

// ---- добавление блюда в дневник по проценту ----

function showDishDetail(dish) {
  const t = dishTotals(dish.components || []);
  const comps = (dish.components || []).map(c => {
    const n = dishTotals([c]);
    return `<div class="entry-sub dish-detail-row">${esc(c.name)} — ${fmt(c.grams)} г · ${fmt(n.kcal)} ккал</div>`;
  }).join('');

  showDialog(`
    <div class="dlg-head"><h3>${esc(dishFullName(dish))}</h3>
      <button type="button" class="dlg-close" data-action="dlg-close">✕</button></div>
    <div class="dlg-body">
      <div class="dish-totals">Масса блюда: <b>${fmt(t.grams)} г</b> · ${fmt(t.kcal)} ккал · Б ${fmt(t.protein, 1)} · Кл ${fmt(t.fiber, 1)}</div>
      <div class="dish-detail-list">${comps}</div>

      <label>Съедено, % от блюда
        <input id="dishPercent" type="number" inputmode="decimal" min="0" max="100" value="100">
      </label>
      <p class="note" id="dishPortionPreview"></p>
      <button type="button" class="btn primary" data-action="add-dish-to-diary" data-id="${dish.id}">Записать в дневник за ${esc(state.date === todayStr() ? 'сегодня' : state.date)}</button>

      <button type="button" class="btn" data-action="edit-dish" data-id="${dish.id}">Редактировать состав</button>
      <button type="button" class="btn danger" data-action="delete-dish" data-id="${dish.id}">Удалить блюдо</button>
    </div>`);

  const percentInput = dlg.querySelector('#dishPercent');
  const preview = dlg.querySelector('#dishPortionPreview');
  const update = () => {
    const p = Math.max(0, num(percentInput.value)) / 100;
    preview.textContent = `≈ ${fmt(t.grams * p, 1)} г · ${fmt(t.kcal * p)} ккал · Б ${fmt(t.protein * p, 1)} · Кл ${fmt(t.fiber * p, 1)} · Раст ${fmt(t.plant * p)}`;
  };
  percentInput.addEventListener('input', update);
  update();
}

async function addDishToDiary(dish, percent) {
  const frac = Math.max(0, num(percent)) / 100;
  if (frac <= 0) { toast('Укажи процент больше нуля'); return; }
  const fullName = dishFullName(dish);
  let count = 0;
  for (const c of dish.components || []) {
    const grams = num(c.grams) * frac;
    if (grams <= 0) continue;
    await db.put('entries', {
      id: uid(), date: state.date, ts: Date.now() + count,
      productId: c.productId || null, name: c.name, grams,
      per100: { ...c.per100 }, plantPercent: c.plantPercent || 0,
      source: 'dish', fromDish: fullName, dishId: dish.id,
    });
    count++;
  }
  dlg.close();
  await refreshEntries();
  await refreshDishes(); // пересчитать «съедено %»
  render();
  toast(`Добавлено из блюда: ${count} ${count === 1 ? 'позиция' : 'позиц.'}`);
}

// Живое превью порции в режиме «Блюдо» диалога добавления записи.
function updateDishEntryPreview() {
  const preview = dlg.querySelector('#dishEntryPreview');
  const dish = state.dishes.find(d => d.id === entryDishId);
  if (!preview || !dish) return;
  const t = dishTotals(dish.components || []);
  const p = Math.max(0, num(dlg.querySelector('#dishEntryPercent').value)) / 100;
  preview.textContent = `≈ ${fmt(t.grams * p, 1)} г · ${fmt(t.kcal * p)} ккал · Б ${fmt(t.protein * p, 1)} · Кл ${fmt(t.fiber * p, 1)} · Раст ${fmt(t.plant * p)}`;
}

async function renderStats() {
  const today = todayStr();
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const date = addDays(today, -i);
    const entries = await db.entriesByDate(date);
    days.push({ date, t: totals(entries), n: entries.length });
  }
  const tracked = days.filter(d => d.n > 0);
  const avg = { kcal: 0, protein: 0, fiber: 0, plant: 0 };
  for (const d of tracked) {
    avg.kcal += d.t.kcal; avg.protein += d.t.protein; avg.fiber += d.t.fiber; avg.plant += d.t.plant;
  }
  const cnt = tracked.length || 1;

  const rows = days.map(d => `<tr class="${d.n ? '' : 'dim'}">
    <td>${fmtShortDate(d.date)}</td>
    <td>${fmt(d.t.kcal)}</td>
    <td>${fmt(d.t.protein, 1)}</td>
    <td>${fmt(d.t.plant)}</td>
    <td>${fmt(d.t.fiber, 1)}</td>
  </tr>`).join('');

  view.innerHTML = `
    <h2 class="section-title">Последние 7 дней</h2>
    <div class="table-wrap"><table>
      <thead><tr><th>День</th><th>Ккал</th><th>Белок</th><th>Раст.</th><th>Клетч.</th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr>
        <td>Среднее*</td>
        <td>${fmt(avg.kcal / cnt)}</td>
        <td>${fmt(avg.protein / cnt, 1)}</td>
        <td>${fmt(avg.plant / cnt)}</td>
        <td>${fmt(avg.fiber / cnt, 1)}</td>
      </tr></tfoot>
    </table></div>
    <p class="note">* по дням, в которые велись записи (${tracked.length} из 7)</p>`;
}

function renderSettings() {
  const t = state.targets;
  view.innerHTML = `
    <h2 class="section-title">Дневные цели</h2>
    <form id="targetsForm" class="card form-grid">
      <label>Калории, ккал <input name="kcal" type="number" inputmode="numeric" value="${t.kcal}"></label>
      <label>Белок, г <input name="protein" type="number" inputmode="numeric" value="${t.protein}"></label>
      <label>Растительная пища, г <input name="plant" type="number" inputmode="numeric" value="${t.plant}"></label>
      <label>Клетчатка, г <input name="fiber" type="number" inputmode="numeric" value="${t.fiber}"></label>
      <button type="submit" class="btn primary">Сохранить цели</button>
    </form>

    <h2 class="section-title">Распознавание по фото</h2>
    <div class="card form-grid">
      <label>Провайдер
        <select id="aiProvider">
          ${ai.PROVIDERS.map(p => `<option value="${p.id}" ${ai.getProvider() === p.id ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}
        </select>
      </label>
      <label>API-ключ ${ai.getProvider() === 'openrouter' ? 'OpenRouter' : 'Anthropic'}
        <input id="apiKey" type="password" autocomplete="off"
          placeholder="${esc(ai.PROVIDERS.find(p => p.id === ai.getProvider()).keyPlaceholder)}"
          value="${esc(ai.getApiKey())}">
      </label>
      <button class="btn" data-action="save-key">Сохранить ключ</button>
      ${ai.getProvider() === 'openrouter' ? `
      <label>Модель (любая vision-модель из каталога openrouter.ai/models)
        <input id="openrouterModel" list="orModels" autocapitalize="off" autocomplete="off" spellcheck="false"
          value="${esc(ai.getModel('openrouter'))}">
        <datalist id="orModels">
          ${ai.OPENROUTER_SUGGESTIONS.map(id => `<option value="${esc(id)}">`).join('')}
        </datalist>
      </label>` : `
      <label>Модель распознавания
        <select id="aiModel">
          ${ai.ANTHROPIC_MODELS.map(m => `<option value="${m.id}" ${ai.getModel('anthropic') === m.id ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}
        </select>
      </label>`}
      <p class="note">${ai.getProvider() === 'openrouter'
        ? 'OpenRouter работает из России без VPN. Ключ — на openrouter.ai → Keys. Модели с суффиксом :free бесплатны (лимит ~50 запросов в день; после разового пополнения от $10 — 1000/день).'
        : 'Для распознавания через Anthropic нужен VPN: api.anthropic.com недоступен с российских IP. Всё остальное приложение работает без VPN.'}
      Ключи хранятся только на этом устройстве и не попадают в экспорт.</p>
    </div>

    <h2 class="section-title">Данные</h2>
    <div class="card form-grid">
      <button class="btn" data-action="export">Экспорт в JSON</button>
      <label class="btn file-btn">Импорт из JSON<input id="importFile" type="file" accept=".json,application/json" hidden></label>
      <button class="btn danger" data-action="wipe">Удалить все данные</button>
    </div>`;

  document.getElementById('targetsForm').addEventListener('submit', async ev => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    state.targets = {
      kcal: num(f.get('kcal'), DEFAULT_TARGETS.kcal),
      protein: num(f.get('protein'), DEFAULT_TARGETS.protein),
      plant: num(f.get('plant'), DEFAULT_TARGETS.plant),
      fiber: num(f.get('fiber'), DEFAULT_TARGETS.fiber),
    };
    await db.put('settings', { key: 'targets', value: state.targets });
    toast('Цели сохранены');
  });

  document.getElementById('importFile').addEventListener('change', importJSON);

  document.getElementById('aiProvider').addEventListener('change', ev => {
    localStorage.setItem('aiProvider', ev.target.value);
    renderSettings(); // перерисовываем: поля ключа и модели у провайдеров разные
    toast('Провайдер сохранён');
  });
  document.getElementById('aiModel')?.addEventListener('change', ev => {
    localStorage.setItem('aiModel', ev.target.value);
    toast('Модель сохранена');
  });
  document.getElementById('openrouterModel')?.addEventListener('change', ev => {
    const value = ev.target.value.trim();
    if (value) localStorage.setItem('openrouterModel', value);
    toast('Модель сохранена');
  });
}

// ---------- диалоги ----------

function showDialog(html) {
  dlg.innerHTML = html;
  dlg.showModal();
}

function productListHTML(query, selectedId) {
  const q = query.trim().toLowerCase();
  const list = (q ? state.products.filter(p => p.name.toLowerCase().includes(q)) : state.products).slice(0, 30);
  if (!list.length) {
    const trimmed = query.trim();
    if (!trimmed) return '<p class="empty">База пуста.</p>';
    return `<p class="empty">Не найдено.</p>
      <button type="button" class="btn" data-action="lookup-into-manual" data-query="${esc(trimmed)}">🔎 Найти «${esc(trimmed)}» через ИИ</button>`;
  }
  return list.map(p => `
    <button type="button" class="pick${p.id === selectedId ? ' selected' : ''}" data-action="pick-product" data-id="${p.id}">
      ${esc(p.name)}<span class="pick-sub">${fmt(p.per100.kcal)} ккал/100 г</span>
    </button>`).join('');
}

function dishListHTML(query, selectedId) {
  const q = query.trim().toLowerCase();
  const list = q
    ? state.dishes.filter(d => dishFullName(d).toLowerCase().includes(q))
    : state.dishes;
  if (!list.length) {
    return state.dishes.length
      ? '<p class="empty">Не найдено.</p>'
      : '<p class="empty">Пока нет блюд. Создай их на вкладке «Блюда».</p>';
  }
  return list.map(d => {
    const t = dishTotals(d.components || []);
    return `<button type="button" class="pick${d.id === selectedId ? ' selected' : ''}" data-action="pick-dish-entry" data-id="${d.id}">
      ${esc(dishFullName(d))}<span class="pick-sub">${fmt(t.grams)} г · ${fmt(t.kcal)} ккал</span>
    </button>`;
  }).join('');
}

function showEntryDialog() {
  photoState = { file: null, plateItems: null };
  photoType = 'label';
  entryDishId = null;
  showDialog(`
    <div class="dlg-head">
      <div class="seg seg-wrap">
        <button type="button" class="seg-btn active" data-action="entry-mode" data-mode="base">Продукт</button>
        <button type="button" class="seg-btn" data-action="entry-mode" data-mode="dish">🍲 Блюдо</button>
        <button type="button" class="seg-btn" data-action="entry-mode" data-mode="manual">Вручную</button>
        <button type="button" class="seg-btn" data-action="entry-mode" data-mode="photo">📷 Фото</button>
      </div>
      <button type="button" class="dlg-close" data-action="dlg-close">✕</button>
    </div>

    <form id="entryBaseForm" class="dlg-body">
      <input type="search" id="dlgSearch" placeholder="Найти продукт…" autocomplete="off">
      <div id="dlgProductList" class="pick-list">${productListHTML('', null)}</div>
      <input type="hidden" id="pickedId">
      <label>Съедено, г <input id="baseGrams" type="number" inputmode="decimal" value="100" min="1" required></label>
      <button type="submit" class="btn primary">Записать</button>
    </form>

    <form id="entryManualForm" class="dlg-body" hidden>
      <label>Название <input name="name" required placeholder="Например: борщ"></label>
      <label>Съедено, г <input name="grams" type="number" inputmode="decimal" value="100" min="1" required></label>
      <fieldset><legend>На 100 г</legend>
        <label>Ккал <input name="kcal" type="number" inputmode="decimal" step="any" required></label>
        <label>Белок, г <input name="protein" type="number" inputmode="decimal" step="any" value="0"></label>
        <label>Клетчатка, г <input name="fiber" type="number" inputmode="decimal" step="any" value="0"></label>
        <label>Растительная доля, % <input name="plantPercent" type="number" inputmode="numeric" min="0" max="100" value="0"></label>
      </fieldset>
      <label class="check"><input type="checkbox" name="saveToBase" checked> сохранить в базу продуктов</label>
      <button type="submit" class="btn primary">Записать</button>
    </form>

    <div id="entryDishForm" class="dlg-body" hidden>
      <input type="search" id="dishEntrySearch" placeholder="Найти блюдо…" autocomplete="off">
      <div id="dishEntryList" class="pick-list">${dishListHTML('')}</div>
      <div id="dishEntryPortion" hidden>
        <label>Съедено, % от блюда
          <input id="dishEntryPercent" type="number" inputmode="decimal" min="0" max="100" value="100">
        </label>
        <p class="note" id="dishEntryPreview"></p>
        <button type="button" class="btn primary" data-action="add-dish-entry">Записать в дневник</button>
      </div>
    </div>

    <div id="entryPhotoForm" class="dlg-body" hidden>
      <div class="seg">
        <button type="button" class="seg-btn active" data-action="photo-type" data-ptype="label">Этикетка</button>
        <button type="button" class="seg-btn" data-action="photo-type" data-ptype="plate">Тарелка</button>
      </div>
      <p class="note" id="photoHint">Сфотографируй таблицу пищевой ценности — заполню карточку продукта.</p>
      <label class="btn file-btn">📷 Снять или выбрать фото<input id="photoInput" type="file" accept="image/*" hidden></label>
      <div id="photoPreview" class="photo-preview"></div>
      <label id="photoCommentWrap" hidden>Уточнение (необязательно)
        <input id="photoComment" placeholder="например: гречки примерно 200 г">
      </label>
      <button type="button" class="btn primary" data-action="recognize" id="recognizeBtn" disabled>Распознать</button>
      <div id="photoResult"></div>
    </div>`);

  const photoInput = dlg.querySelector('#photoInput');
  photoInput.addEventListener('change', () => {
    photoState.file = photoInput.files[0] || null;
    photoState.plateItems = null;
    dlg.querySelector('#photoResult').innerHTML = '';
    dlg.querySelector('#recognizeBtn').disabled = !photoState.file;
    const preview = dlg.querySelector('#photoPreview');
    preview.innerHTML = '';
    if (photoState.file) {
      const img = document.createElement('img');
      img.src = URL.createObjectURL(photoState.file);
      img.onload = () => URL.revokeObjectURL(img.src);
      preview.appendChild(img);
    }
  });

  const search = dlg.querySelector('#dlgSearch');
  search.addEventListener('input', () => {
    dlg.querySelector('#dlgProductList').innerHTML =
      productListHTML(search.value, dlg.querySelector('#pickedId').value || null);
  });

  const dishSearch = dlg.querySelector('#dishEntrySearch');
  dishSearch.addEventListener('input', () => {
    dlg.querySelector('#dishEntryList').innerHTML = dishListHTML(dishSearch.value, entryDishId);
  });
  dlg.querySelector('#dishEntryPercent').addEventListener('input', updateDishEntryPreview);

  dlg.querySelector('#entryBaseForm').addEventListener('submit', async ev => {
    ev.preventDefault();
    const pid = dlg.querySelector('#pickedId').value;
    const p = state.products.find(x => x.id === pid);
    if (!p) { toast('Сначала выбери продукт из списка'); return; }
    const grams = num(dlg.querySelector('#baseGrams').value, 0);
    if (grams <= 0) return;
    await db.put('entries', {
      id: uid(), date: state.date, ts: Date.now(),
      productId: p.id, name: p.name, grams,
      per100: { ...p.per100 }, plantPercent: p.plantPercent || 0,
    });
    p.usedCount = (p.usedCount || 0) + 1;
    await db.put('products', p);
    dlg.close();
    await refreshProducts();
    await refreshEntries();
    render();
  });

  dlg.querySelector('#entryManualForm').addEventListener('submit', async ev => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    const name = String(f.get('name')).trim();
    const grams = num(f.get('grams'), 0);
    if (!name || grams <= 0) return;
    const per100 = {
      kcal: num(f.get('kcal')),
      protein: num(f.get('protein')),
      fiber: num(f.get('fiber')),
    };
    const plantPercent = Math.max(0, Math.min(100, num(f.get('plantPercent'))));
    let productId = null;
    if (f.get('saveToBase')) {
      productId = uid();
      await db.put('products', {
        id: productId, name, per100: { ...per100 }, plantPercent,
        source: 'manual', usedCount: 1, createdAt: Date.now(),
      });
      await refreshProducts();
    }
    await db.put('entries', {
      id: uid(), date: state.date, ts: Date.now(),
      productId, name, grams, per100, plantPercent,
    });
    dlg.close();
    await refreshEntries();
    render();
  });
}

function showEditEntryDialog(entry) {
  showDialog(`
    <div class="dlg-head"><h3>${esc(entry.name)}</h3>
      <button type="button" class="dlg-close" data-action="dlg-close">✕</button></div>
    <form id="editEntryForm" class="dlg-body">
      <label>Съедено, г <input name="grams" type="number" inputmode="decimal" value="${entry.grams}" min="1" required></label>
      <button type="submit" class="btn primary">Сохранить</button>
      <button type="button" class="btn danger" data-action="delete-entry" data-id="${entry.id}">Удалить запись</button>
    </form>`);

  dlg.querySelector('#editEntryForm').addEventListener('submit', async ev => {
    ev.preventDefault();
    entry.grams = num(new FormData(ev.target).get('grams'), entry.grams);
    await db.put('entries', entry);
    dlg.close();
    await refreshEntries();
    render();
  });
}

// product — существующий продукт для правки; prefill — заготовка для нового
// (например, из ИИ-догрузки): показываем значения, но сохраняем как новый.
function showProductDialog(product, prefill) {
  const p = product || prefill || { name: '', per100: { kcal: '', protein: 0, fiber: 0 }, plantPercent: 0 };
  showDialog(`
    <div class="dlg-head"><h3>${product ? 'Продукт' : 'Новый продукт'}</h3>
      <button type="button" class="dlg-close" data-action="dlg-close">✕</button></div>
    <form id="productForm" class="dlg-body">
      <label>Название <input name="name" required value="${esc(p.name)}"></label>
      <fieldset><legend>На 100 г</legend>
        <label>Ккал <input name="kcal" type="number" inputmode="decimal" step="any" required value="${p.per100.kcal}"></label>
        <label>Белок, г <input name="protein" type="number" inputmode="decimal" step="any" value="${p.per100.protein}"></label>
        <label>Клетчатка, г <input name="fiber" type="number" inputmode="decimal" step="any" value="${p.per100.fiber}"></label>
        <label>Растительная доля, % <input name="plantPercent" type="number" inputmode="numeric" min="0" max="100" value="${p.plantPercent || 0}"></label>
      </fieldset>
      <button type="submit" class="btn primary">Сохранить</button>
      ${product ? `<button type="button" class="btn danger" data-action="delete-product" data-id="${product.id}">Удалить продукт</button>` : ''}
    </form>`);

  dlg.querySelector('#productForm').addEventListener('submit', async ev => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    const rec = {
      id: product ? product.id : uid(),
      name: String(f.get('name')).trim(),
      per100: { kcal: num(f.get('kcal')), protein: num(f.get('protein')), fiber: num(f.get('fiber')) },
      plantPercent: Math.max(0, Math.min(100, num(f.get('plantPercent')))),
      source: product ? product.source : 'manual',
      // помечаем как отредактированный, чтобы правки пережили обновление
      // справочника (см. ensureSeed) и не были затёрты/удалены
      edited: true,
      usedCount: product ? (product.usedCount || 0) : 0,
      createdAt: product ? product.createdAt : Date.now(),
    };
    if (!rec.name) return;
    await db.put('products', rec);
    dlg.close();
    await refreshProducts();
    render();
  });
}

// ---------- распознавание по фото ----------

async function runRecognition() {
  if (!photoState.file) return;
  const btn = dlg.querySelector('#recognizeBtn');
  const result = dlg.querySelector('#photoResult');
  btn.disabled = true;
  btn.textContent = 'Распознаю…';
  result.innerHTML = '';
  try {
    if (photoType === 'label') {
      const p = await ai.recognizeLabel(photoState.file);
      fillManualFromLabel(p);
    } else {
      const comment = dlg.querySelector('#photoComment').value;
      const data = await ai.recognizePlate(photoState.file, comment);
      photoState.plateItems = data.items || [];
      renderPlateResult(data);
    }
  } catch (err) {
    result.innerHTML = `<p class="error">${esc(err.message)}</p>`;
  } finally {
    btn.disabled = !photoState.file;
    btn.textContent = 'Распознать';
  }
}

// ---------- догрузка продукта через ИИ (без фото) ----------

// Из вкладки «Продукты»: находим и открываем карточку нового продукта
// с заполненными значениями — пользователь правит и сохраняет локально.
async function lookupProduct(query, btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Ищу…'; }
  try {
    const data = await ai.lookupFood(query);
    showProductDialog(null, {
      name: data.name || query,
      per100: {
        kcal: data.per100?.kcal ?? '',
        protein: data.per100?.protein ?? 0,
        fiber: data.per100?.fiber ?? 0,
      },
      plantPercent: Math.max(0, Math.min(100, Math.round(data.plantPercent || 0))),
    });
    if (data.notes) toast(data.notes);
  } catch (err) {
    if (btn) { btn.disabled = false; btn.textContent = '🔎 Найти через ИИ и добавить'; }
    toast('Не нашлось: ' + err.message);
  }
}

// Из пикера диалога добавления: заполняем форму «Вручную» (с галочкой
// «сохранить в базу» — так исправленная версия остаётся в базе).
async function lookupIntoManual(query, btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Ищу…'; }
  try {
    const data = await ai.lookupFood(query);
    fillManualFromData({ name: data.name || query, per100: data.per100, plantPercent: data.plantPercent });
    toast('Проверь данные и запиши' + (data.notes ? '. ' + data.notes : ''));
  } catch (err) {
    if (btn) { btn.disabled = false; btn.textContent = `🔎 Найти «${query}» через ИИ`; }
    toast('Не нашлось: ' + err.message);
  }
}

// Заполняет форму «Вручную» и переключает на неё сегмент диалога.
function fillManualFromData(p) {
  const form = dlg.querySelector('#entryManualForm');
  form.elements.name.value = p.name || '';
  form.elements.kcal.value = p.per100?.kcal ?? '';
  form.elements.protein.value = p.per100?.protein ?? 0;
  form.elements.fiber.value = p.per100?.fiber ?? 0;
  form.elements.plantPercent.value = Math.max(0, Math.min(100, Math.round(p.plantPercent || 0)));
  dlg.querySelector('[data-action="entry-mode"][data-mode="manual"]').click();
}

// Этикетка: переключаем диалог на «Вручную» с заполненными полями —
// пользователь проверяет цифры и жмёт «Записать».
function fillManualFromLabel(p) {
  fillManualFromData(p);
  const hints = [];
  if (p.fiberSource === 'estimate') hints.push('клетчатка оценена по категории (на этикетке не указана)');
  if (p.notes) hints.push(p.notes);
  toast('Проверь данные и запиши' + (hints.length ? '. ' + hints.join('; ') : ''));
}

function renderPlateResult(data) {
  const rows = photoState.plateItems.map((it, i) => `
    <div class="plate-item">
      <label class="check plate-check">
        <input type="checkbox" data-plate-check="${i}" checked>
        <span class="plate-name">${esc(it.name)}</span>
      </label>
      <div class="plate-row">
        <input type="number" inputmode="decimal" data-plate-grams="${i}" value="${Math.round(it.grams)}"> г
        <span class="plate-sub">${fmt(it.per100.kcal)} ккал/100 г · Б ${fmt(it.per100.protein, 1)} · Кл ${fmt(it.per100.fiber, 1)} · раст ${fmt(it.plantPercent)}%</span>
      </div>
    </div>`).join('');
  dlg.querySelector('#photoResult').innerHTML = `
    ${data.notes ? `<p class="note">${esc(data.notes)}</p>` : ''}
    <div class="plate-list">${rows || '<p class="empty">Компоненты не распознаны.</p>'}</div>
    ${photoState.plateItems.length ? '<button type="button" class="btn primary" data-action="save-plate">Записать выбранное</button>' : ''}`;
}

async function savePlateItems() {
  if (!photoState.plateItems) return;
  let saved = 0;
  for (let i = 0; i < photoState.plateItems.length; i++) {
    const it = photoState.plateItems[i];
    if (!dlg.querySelector(`[data-plate-check="${i}"]`)?.checked) continue;
    const grams = num(dlg.querySelector(`[data-plate-grams="${i}"]`)?.value, it.grams);
    if (grams <= 0) continue;
    await db.put('entries', {
      id: uid(), date: state.date, ts: Date.now(),
      productId: null, name: it.name, grams,
      per100: {
        kcal: num(it.per100.kcal),
        protein: num(it.per100.protein),
        fiber: num(it.per100.fiber),
      },
      plantPercent: Math.max(0, Math.min(100, num(it.plantPercent))),
      source: 'photo',
    });
    saved++;
  }
  dlg.close();
  await refreshEntries();
  render();
  toast(saved ? `Записано компонентов: ${saved}` : 'Ничего не выбрано');
}

// ---------- экспорт / импорт ----------

async function exportJSON() {
  const data = {
    app: 'skai.food',
    version: 1,
    exportedAt: new Date().toISOString(),
    products: await db.getAll('products'),
    entries: await db.getAll('entries'),
    dishes: await db.getAll('dishes'),
    settings: (await db.getAll('settings')).filter(s => s.key !== 'seeded'),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `skai-food-backup-${todayStr()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function importJSON(ev) {
  const file = ev.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'skai.food' || !Array.isArray(data.products) || !Array.isArray(data.entries)) {
      throw new Error('не похоже на бэкап skai.food');
    }
    for (const p of data.products) await db.put('products', p);
    for (const e of data.entries) await db.put('entries', e);
    for (const d of data.dishes || []) await db.put('dishes', d);
    for (const s of data.settings || []) await db.put('settings', s);
    await loadTargets();
    await refreshProducts();
    await refreshEntries();
    await refreshDishes();
    render();
    toast(`Импортировано: ${data.products.length} продуктов, ${data.entries.length} записей, ${(data.dishes || []).length} блюд`);
  } catch (err) {
    toast('Ошибка импорта: ' + err.message);
  }
  ev.target.value = '';
}

async function wipeAll() {
  if (!confirm('Точно удалить ВСЕ данные? Это необратимо. Сначала сделай экспорт.')) return;
  await db.clearStore('entries');
  await db.clearStore('products');
  await db.clearStore('dishes');
  await db.clearStore('settings');
  state.targets = { ...DEFAULT_TARGETS };
  await ensureSeed();
  await refreshProducts();
  await refreshEntries();
  await refreshDishes();
  render();
  toast('Данные удалены, база продуктов сброшена к начальной');
}

// ---------- мелочи ----------

let toastTimer;
function toast(msg) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2500);
}

// ---------- обработка кликов ----------

document.querySelector('.tabbar').addEventListener('click', ev => {
  const btn = ev.target.closest('button[data-tab]');
  if (!btn) return;
  state.tab = btn.dataset.tab;
  render();
});

document.body.addEventListener('click', async ev => {
  const el = ev.target.closest('[data-action]');
  if (!el) return;
  const { action, id } = el.dataset;

  if (action === 'date-prev' || action === 'date-next') {
    state.date = addDays(state.date, action === 'date-prev' ? -1 : 1);
    await refreshEntries();
    render();
  } else if (action === 'date-today') {
    state.date = todayStr();
    await refreshEntries();
    render();
  } else if (action === 'add-entry') {
    showEntryDialog();
  } else if (action === 'edit-entry') {
    const entry = state.entries.find(e => e.id === id);
    if (entry) showEditEntryDialog(entry);
  } else if (action === 'delete-entry') {
    await db.del('entries', id);
    dlg.close();
    await refreshEntries();
    await refreshDishes(); // запись могла быть из блюда — обновить «съедено %»
    render();
  } else if (action === 'add-product') {
    showProductDialog(null);
  } else if (action === 'lookup-product') {
    await lookupProduct(el.dataset.query, el);
  } else if (action === 'lookup-into-manual') {
    await lookupIntoManual(el.dataset.query, el);
  } else if (action === 'edit-product') {
    const p = state.products.find(x => x.id === id);
    if (p) showProductDialog(p);
  } else if (action === 'delete-product') {
    if (!confirm('Удалить продукт из базы? Прошлые записи в дневнике сохранятся.')) return;
    await db.del('products', id);
    dlg.close();
    await refreshProducts();
    render();
  } else if (action === 'pick-product') {
    dlg.querySelector('#pickedId').value = id;
    dlg.querySelector('#dlgProductList').innerHTML =
      productListHTML(dlg.querySelector('#dlgSearch').value, id);
  } else if (action === 'add-dish') {
    showDishDialog(null);
  } else if (action === 'open-dish') {
    const d = state.dishes.find(x => x.id === id);
    if (d) showDishDetail(d);
  } else if (action === 'edit-dish') {
    const d = state.dishes.find(x => x.id === id);
    if (d) showDishDialog(d);
  } else if (action === 'dish-add-product') {
    const p = state.products.find(x => x.id === id);
    if (p) {
      dishDraft.components.push({
        productId: p.id, name: p.name, grams: 100,
        per100: { ...p.per100 }, plantPercent: p.plantPercent || 0,
      });
      renderDishComponents();
      const s = dlg.querySelector('#dishProductSearch');
      s.value = '';
      renderDishPickList('');
    }
  } else if (action === 'dish-del-component') {
    dishDraft.components.splice(Number(el.dataset.index), 1);
    renderDishComponents();
  } else if (action === 'save-dish') {
    await saveDish();
  } else if (action === 'delete-dish') {
    if (!confirm('Удалить блюдо? Записи в дневнике, уже сделанные из него, сохранятся.')) return;
    await db.del('dishes', id);
    dlg.close();
    await refreshDishes();
    render();
  } else if (action === 'add-dish-to-diary') {
    const d = state.dishes.find(x => x.id === id);
    if (d) await addDishToDiary(d, dlg.querySelector('#dishPercent').value);
  } else if (action === 'entry-mode') {
    const mode = el.dataset.mode;
    dlg.querySelectorAll('[data-action="entry-mode"]').forEach(b =>
      b.classList.toggle('active', b.dataset.mode === mode));
    dlg.querySelector('#entryBaseForm').hidden = mode !== 'base';
    dlg.querySelector('#entryDishForm').hidden = mode !== 'dish';
    dlg.querySelector('#entryManualForm').hidden = mode !== 'manual';
    dlg.querySelector('#entryPhotoForm').hidden = mode !== 'photo';
  } else if (action === 'pick-dish-entry') {
    entryDishId = id;
    dlg.querySelector('#dishEntryList').innerHTML =
      dishListHTML(dlg.querySelector('#dishEntrySearch').value, id);
    dlg.querySelector('#dishEntryPortion').hidden = false;
    updateDishEntryPreview();
  } else if (action === 'add-dish-entry') {
    const d = state.dishes.find(x => x.id === entryDishId);
    if (!d) { toast('Сначала выбери блюдо'); return; }
    await addDishToDiary(d, dlg.querySelector('#dishEntryPercent').value);
  } else if (action === 'photo-type') {
    photoType = el.dataset.ptype;
    dlg.querySelectorAll('[data-action="photo-type"]').forEach(b =>
      b.classList.toggle('active', b.dataset.ptype === photoType));
    dlg.querySelector('#photoHint').textContent = photoType === 'label'
      ? 'Сфотографируй таблицу пищевой ценности — заполню карточку продукта.'
      : 'Сфотографируй тарелку — оценю состав и граммовки.';
    dlg.querySelector('#photoCommentWrap').hidden = photoType !== 'plate';
    dlg.querySelector('#photoResult').innerHTML = '';
    photoState.plateItems = null;
  } else if (action === 'recognize') {
    await runRecognition();
  } else if (action === 'save-plate') {
    await savePlateItems();
  } else if (action === 'dlg-close') {
    dlg.close();
  } else if (action === 'save-key') {
    ai.setApiKey(document.getElementById('apiKey').value);
    toast('Ключ сохранён на устройстве');
  } else if (action === 'export') {
    exportJSON();
  } else if (action === 'wipe') {
    wipeAll();
  }
});

// клик по подложке закрывает диалог
dlg.addEventListener('click', ev => {
  if (ev.target === dlg) dlg.close();
});

// правка граммовок в составе блюда — без перерисовки строки, чтобы не терять
// фокус; обновляем только черновик и итоги
dlg.addEventListener('input', ev => {
  const gi = ev.target.closest('[data-dish-grams]');
  if (!gi || !dishDraft) return;
  const i = Number(gi.dataset.dishGrams);
  if (dishDraft.components[i]) {
    dishDraft.components[i].grams = gi.value;
    updateDishTotals();
  }
});

// ---------- старт ----------

(async function init() {
  await ensureSeed();
  await loadTargets();
  await refreshProducts();
  await refreshEntries();
  await refreshDishes();
  render();
})();
