import { uid, todayStr, addDays, fmtHeaderDate, fmtShortDate, fmt, esc, num } from './util.js';
import * as db from './db.js';
import { ensureSeed } from './seed.js';

const DEFAULT_TARGETS = { kcal: 2000, protein: 100, fiber: 30, plant: 400 };

const state = {
  tab: 'diary',
  date: todayStr(),
  products: [],
  entries: [],
  targets: { ...DEFAULT_TARGETS },
  productQuery: '',
};

const view = document.getElementById('view');
const dlg = document.getElementById('dlg');

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
        <span class="entry-name">${esc(e.name)}</span>
        <span class="entry-grams">${fmt(e.grams)} г</span>
      </div>
      <div class="entry-sub">${fmt(n.kcal)} ккал · Б ${fmt(n.protein, 1)} · Кл ${fmt(n.fiber, 1)} · Раст ${fmt(n.plant)}</div>
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

function renderProducts() {
  const q = state.productQuery.trim().toLowerCase();
  const list = q
    ? state.products.filter(p => p.name.toLowerCase().includes(q))
    : state.products;
  const rows = list.map(p => `
    <button class="entry" data-action="edit-product" data-id="${p.id}">
      <div class="entry-main">
        <span class="entry-name">${esc(p.name)}</span>
        ${p.plantPercent ? '<span class="leaf">🌿</span>' : ''}
      </div>
      <div class="entry-sub">на 100 г: ${fmt(p.per100.kcal)} ккал · Б ${fmt(p.per100.protein, 1)} · Кл ${fmt(p.per100.fiber, 1)}</div>
    </button>`).join('');

  view.innerHTML = `
    <div class="searchbar">
      <input type="search" id="productSearch" placeholder="Поиск по базе…" value="${esc(state.productQuery)}">
    </div>
    <div class="entries">${rows || '<p class="empty">Ничего не найдено.</p>'}</div>
    <button class="fab" data-action="add-product">+ Продукт</button>`;

  const input = document.getElementById('productSearch');
  input.addEventListener('input', () => {
    state.productQuery = input.value;
    // перерисовываем только список, чтобы не терять фокус
    const q2 = input.value.trim().toLowerCase();
    const list2 = q2 ? state.products.filter(p => p.name.toLowerCase().includes(q2)) : state.products;
    view.querySelector('.entries').innerHTML = list2.map(p => `
      <button class="entry" data-action="edit-product" data-id="${p.id}">
        <div class="entry-main">
          <span class="entry-name">${esc(p.name)}</span>
          ${p.plantPercent ? '<span class="leaf">🌿</span>' : ''}
        </div>
        <div class="entry-sub">на 100 г: ${fmt(p.per100.kcal)} ккал · Б ${fmt(p.per100.protein, 1)} · Кл ${fmt(p.per100.fiber, 1)}</div>
      </button>`).join('') || '<p class="empty">Ничего не найдено.</p>';
  });
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

    <h2 class="section-title">Claude API</h2>
    <div class="card form-grid">
      <label>API-ключ (для распознавания, шаг 2)
        <input id="apiKey" type="password" autocomplete="off" placeholder="sk-ant-…" value="${esc(localStorage.getItem('apiKey') || '')}">
      </label>
      <button class="btn" data-action="save-key">Сохранить ключ</button>
      <p class="note">Ключ хранится только на этом устройстве и не попадает в экспорт.</p>
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
}

// ---------- диалоги ----------

function showDialog(html) {
  dlg.innerHTML = html;
  dlg.showModal();
}

function productListHTML(query, selectedId) {
  const q = query.trim().toLowerCase();
  const list = (q ? state.products.filter(p => p.name.toLowerCase().includes(q)) : state.products).slice(0, 30);
  if (!list.length) return '<p class="empty">Не найдено — добавь вручную на вкладке «Вручную».</p>';
  return list.map(p => `
    <button type="button" class="pick${p.id === selectedId ? ' selected' : ''}" data-action="pick-product" data-id="${p.id}">
      ${esc(p.name)}<span class="pick-sub">${fmt(p.per100.kcal)} ккал/100 г</span>
    </button>`).join('');
}

function showEntryDialog() {
  showDialog(`
    <div class="dlg-head">
      <div class="seg">
        <button type="button" class="seg-btn active" data-action="entry-mode" data-mode="base">Из базы</button>
        <button type="button" class="seg-btn" data-action="entry-mode" data-mode="manual">Вручную</button>
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
    </form>`);

  const search = dlg.querySelector('#dlgSearch');
  search.addEventListener('input', () => {
    dlg.querySelector('#dlgProductList').innerHTML =
      productListHTML(search.value, dlg.querySelector('#pickedId').value || null);
  });

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

function showProductDialog(product) {
  const p = product || { name: '', per100: { kcal: '', protein: 0, fiber: 0 }, plantPercent: 0 };
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

// ---------- экспорт / импорт ----------

async function exportJSON() {
  const data = {
    app: 'skai.food',
    version: 1,
    exportedAt: new Date().toISOString(),
    products: await db.getAll('products'),
    entries: await db.getAll('entries'),
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
    for (const s of data.settings || []) await db.put('settings', s);
    await loadTargets();
    await refreshProducts();
    await refreshEntries();
    render();
    toast(`Импортировано: ${data.products.length} продуктов, ${data.entries.length} записей`);
  } catch (err) {
    toast('Ошибка импорта: ' + err.message);
  }
  ev.target.value = '';
}

async function wipeAll() {
  if (!confirm('Точно удалить ВСЕ данные? Это необратимо. Сначала сделай экспорт.')) return;
  await db.clearStore('entries');
  await db.clearStore('products');
  await db.clearStore('settings');
  state.targets = { ...DEFAULT_TARGETS };
  await ensureSeed();
  await refreshProducts();
  await refreshEntries();
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
    render();
  } else if (action === 'add-product') {
    showProductDialog(null);
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
  } else if (action === 'entry-mode') {
    const mode = el.dataset.mode;
    dlg.querySelectorAll('.seg-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
    dlg.querySelector('#entryBaseForm').hidden = mode !== 'base';
    dlg.querySelector('#entryManualForm').hidden = mode !== 'manual';
  } else if (action === 'dlg-close') {
    dlg.close();
  } else if (action === 'save-key') {
    localStorage.setItem('apiKey', document.getElementById('apiKey').value.trim());
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

// ---------- старт ----------

(async function init() {
  await ensureSeed();
  await loadTargets();
  await refreshProducts();
  await refreshEntries();
  render();
})();
